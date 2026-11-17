/**
 * dsh-execution-guard - argument preflight and repeated-failure hints.
 * @module dsh-execution-guard
 */
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { currentStepCalls, lastHumanSeq } from './batch.js'
import { buildHintMessage, deliverNotice } from './notice.js'
import {
  GUARD_NAME,
  INVALID_ARGS_CODE,
  checkBatch,
  describeShape,
  type PreflightCall,
} from './preflight.js'
import { RepeatTracker } from './repeat.js'

export { currentStepCalls, lastHumanSeq } from './batch.js'
export { buildHintMessage, deliverNotice, type NoticeTarget } from './notice.js'
export {
  GUARD_NAME,
  INVALID_ARGS_CODE,
  checkBatch,
  checkCall,
  describeShape,
  type CallVerdict,
  type PreflightCall,
  type PreflightDecision,
} from './preflight.js'
export { RepeatTracker, fingerprint, hintableCalls, MAX_FINGERPRINTS } from './repeat.js'

/** Plugin-row configuration. Both halves of the pre-split bundle are switches here; the anchor's own keys now live in `dsh-task-anchor`. */
export interface Config {
  readonly preflight: boolean
  readonly repeatHints: boolean
}

export const Config = Schema.object({
  preflight: Schema.boolean()
    .default(true)
    .description('Validate tool arguments before approval/side effects.'),
  repeatHints: Schema.boolean()
    .default(true)
    .description('Attach correction hints on repeated INVALID_ARGS.'),
})

export const inject = ['tools']

/** Injectable seams so adapter tests run without real processes or homes. */
export type ApplyDeps = Record<string, never>

interface AgentLike {
  readonly id: SessionId
  readonly session?: {
    readonly id: string
    readonly header: { readonly cwd?: string }
    snapshotEvents(): readonly SessionEvent[]
    append(type: 'user/message', data: UserMessage, opts: { surfaceOp: 'append' }): unknown
  }
  /** Host's deferred next-step inbox channel; absent on older builds. */
  inject?(message: UserMessage): void
}

/** Cache one scope's public schema map; invalidated by tools/change. */
class SchemaCache {
  private generation = 0
  private readonly cache = new WeakMap<object, { gen: number; map: Map<string, unknown> }>()

  constructor(
    private readonly readSchemas: (
      agent: object | undefined,
    ) => { name: string; parameters: unknown }[],
  ) {
    void this.readSchemas
  }

  bump(): void {
    this.generation += 1
  }

  schemaOf(agent: object | undefined): (tool: string) => unknown {
    let hit = agent !== undefined ? this.cache.get(agent) : undefined
    if (hit === undefined || hit.gen !== this.generation) {
      const map = new Map<string, unknown>()
      for (const schema of this.readSchemas(agent)) map.set(schema.name, schema.parameters)
      hit = { gen: this.generation, map }
      if (agent !== undefined) this.cache.set(agent, { gen: hit.gen, map: hit.map })
    }
    return (tool: string): unknown => hit?.map.get(tool)
  }
}

/** Per-agent weak state: final-outcome accounting for repeat hints. */
interface AgentState {
  readonly tracker: RepeatTracker
  readonly deniedViolations: Map<string, readonly string[]>
  readonly validDenied: Set<string>
  /** forget one settled callId, keeping the maps bounded. */
  forget(callId: string): void
}

const agentStates = new WeakMap<object, AgentState>()

function stateOf(agent: object): AgentState {
  let state = agentStates.get(agent)
  if (state === undefined) {
    const deniedViolations = new Map<string, readonly string[]>()
    const validDenied = new Set<string>()
    state = {
      tracker: new RepeatTracker(),
      deniedViolations,
      validDenied,
      forget(callId: string): void {
        deniedViolations.delete(callId)
        validDenied.delete(callId)
        if (deniedViolations.size > 256) {
          const oldest = deniedViolations.keys().next().value
          if (oldest !== undefined) deniedViolations.delete(oldest)
        }
        if (validDenied.size > 256) {
          const oldest = validDenied.values().next().value
          if (oldest !== undefined) validDenied.delete(oldest)
        }
      },
    }
    agentStates.set(agent, state)
  }
  return state
}

function sessionOf(ctx: Context, agent: AgentLike | undefined): AgentLike['session'] | undefined {
  if (agent === undefined) return undefined
  if (agent.session !== undefined) return agent.session
  return ctx.get('sessions')?.get(agent.id)
}

/** Run the preflight for one pending execution; pure decision, no host calls. */
function preflightDecision(
  ctx: Context,
  cache: SchemaCache,
  exec: ToolExecution,
): { decision: ReturnType<typeof checkBatch>; note?: string } {
  const agent: AgentLike | undefined = exec.agent
  if (exec.parent !== undefined) {
    const parameters = (exec.schema as { parameters?: unknown } | undefined)?.parameters
    if (parameters === undefined) {
      return {
        decision: { kind: 'allow' },
        note: 'ptc sub-call without binding schema; deferred to host',
      }
    }
    return {
      decision: checkBatch(
        [{ tool: exec.name, callId: exec.callId, args: exec.arguments }],
        () => parameters,
      ),
    }
  }
  const session = sessionOf(ctx, agent)
  const schemaOf = cache.schemaOf(agent)
  if (session === undefined) {
    return {
      decision: checkBatch(
        [{ tool: exec.name, callId: exec.callId, args: exec.arguments }],
        schemaOf,
      ),
    }
  }
  const events = session.snapshotEvents()
  const siblings = currentStepCalls(events)
  const present = siblings.some((call) => call.callId === exec.callId)
  const state = agent !== undefined ? stateOf(agent) : undefined
  if (state !== undefined) state.tracker.noteHumanSeq(lastHumanSeq(events))
  if (!present) {
    return {
      decision: checkBatch(
        [{ tool: exec.name, callId: exec.callId, args: exec.arguments }],
        schemaOf,
      ),
      note:
        siblings.length === 0
          ? 'no assistant tool-call message found; checking current call only (batch atomicity not claimed)'
          : `call ${String(exec.callId)} absent from the assistant batch; checking it alone`,
    }
  }
  const calls: PreflightCall[] = siblings.map((call) => ({
    tool: call.tool,
    callId: call.callId,
    argsRaw: call.argsRaw,
  }))
  return { decision: checkBatch(calls, schemaOf) }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  const cache = new SchemaCache((agent) => ctx.tools.schemas(agent))
  ctx.on('tools/change', () => cache.bump())

  ctx.on(
    'tools/pre-execute',
    async (exec: ToolExecution, next: () => Promise<PreToolDecision>) => {
      if (!config.preflight) return next()
      try {
        const { decision, note } = preflightDecision(ctx, cache, exec)
        if (note !== undefined) logger.warn('%s: %s', GUARD_NAME, note)
        if (decision.kind === 'deny') {
          const agent: AgentLike | undefined = exec.agent
          if (agent !== undefined) {
            const state = stateOf(agent)
            const own = decision.invalid.find((entry) => entry.callId === exec.callId)
            if (own !== undefined) {
              state.deniedViolations.set(String(exec.callId), own.violations)
            } else {
              state.validDenied.add(String(exec.callId))
            }
          }
          return {
            kind: 'deny',
            reason: decision.reason,
            info: { name: GUARD_NAME, code: INVALID_ARGS_CODE },
          }
        }
      } catch (error) {
        logger.warn('%s: preflight failed open to host pipeline: %o', GUARD_NAME, error)
      }
      return next()
    },
    true,
  )

  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
    try {
      const agent: AgentLike | undefined = exec.agent
      if (agent === undefined) return
      const state = stateOf(agent)
      const callId = String(exec.callId)
      const wasValidDenied = state.validDenied.has(callId)
      const ownViolations = state.deniedViolations.get(callId)
      state.forget(callId)
      if (!result.isError) {
        state.tracker.noteSuccess(exec.name)
        return
      }
      if (result.error?.info?.code !== INVALID_ARGS_CODE) return
      if (wasValidDenied) return
      const violations =
        ownViolations ?? result.error.message.split(/\n|; /u).filter((line) => line !== '')
      const count = state.tracker.noteFailure(exec.name, violations)
      if (config.repeatHints && count >= 2) {
        const session = sessionOf(ctx, agent)
        const parameters = cache.schemaOf(agent)(exec.name)
        if (session !== undefined && parameters !== undefined) {
          deliverNotice(agent, buildHintMessage(exec.name, describeShape(parameters)), logger)
        }
      }
    } catch (error) {
      logger.warn('%s: final-outcome accounting failed: %o', GUARD_NAME, error)
    }
  })
}
