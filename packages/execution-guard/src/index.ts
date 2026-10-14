/**
 * dsh-execution-guard — argument preflight and repeated-failure hints.
 *
 * Two seams, both read-only toward the host's own decisions:
 *
 * - `tools/pre-execute` (prepended): re-validate the pending call's
 *   arguments against the PUBLIC schema surface (`ctx.tools.schemas`) with
 *   the shared subset validators, BEFORE approval and side effects. The
 *   host appends `tool/call` events one call at a time, so the whole native
 *   batch is read from the current step's settled `assistant/message`
 *   tool-call blocks and validated together: any invalid member denies
 *   every member, with per-tool/callId violations — the step's entire
 *   output is rejected (this is a whole-step denial, not a scheduler
 *   concurrency group). Without an assistant tool-call message only the
 *   live execution is checked and whole-batch atomicity is explicitly not
 *   claimed. A `run_code` sub-dispatch is checked alone (the dynamic
 *   current sub-call only). Unknown tools and unsupported schemas stay the
 *   host's call: we defer with a diagnostic instead of inventing a verdict.
 *   Arguments are never rewritten or auto-filled; no
 *   `multi_tool_use.parallel` tool exists here (that name belongs to outer
 *   transports).
 * - `tools/result` (final-outcome observer): on the second same-shape
 *   INVALID_ARGS failure of the same tool, attach a concrete correction hint
 *   (error code + expected schema shape). The host's own repeat-reminder only
 *   catches IDENTICAL arguments, so it never fires on a model that keeps
 *   changing values while missing the same field; legitimate repeats are
 *   never suppressed; a success or a new human turn resets.
 *
 * The recovery anchor (`checkpoint_task` + the resume comparison) lives in
 * the sibling bundle `dsh-task-anchor` — it is session continuity, not
 * execution guarding, and it shares no runtime state with this half.
 *
 * @module dsh-execution-guard
 */
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
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

/**
 * Plugin-row configuration. Both halves of the pre-split bundle are switches
 * here; the anchor's own keys now live in `dsh-task-anchor`.
 */
export interface Config {
  readonly preflight: boolean
  readonly repeatHints: boolean
}

// No `Schema<Config>` annotation: schemastery ≥ 3.18.4 bakes volatile modes
// into the schema generics and the loader checks the inferred shape.
export const Config = Schema.object({
  preflight: Schema.boolean().default(true).description('Validate tool arguments before approval/side effects.'),
  repeatHints: Schema.boolean().default(true).description('Attach correction hints on repeated INVALID_ARGS.'),
})

export const inject = ['tools']

/** Injectable seams so adapter tests run without real processes or homes. */
export type ApplyDeps = Record<string, never>

interface AgentLike {
  readonly id: string
  readonly session?: {
    readonly id: string
    readonly header: { readonly cwd?: string }
    snapshotEvents(): readonly import('@deepseek-ai/dsh-session').SessionEvent[]
    append(type: 'user/message', data: import('@deepseek-ai/dsh-llm').UserMessage, opts: { surfaceOp: 'append' }): unknown
  }
  /** Host's deferred next-step inbox channel; absent on older builds. */
  inject?(message: import('@deepseek-ai/dsh-llm').UserMessage): void
}

/** Cache one scope's public schema map; invalidated by tools/change. */
class SchemaCache {
  private generation = 0
  private readonly cache = new WeakMap<object, { gen: number; map: Map<string, unknown> }>()

  constructor(private readonly readSchemas: (agent: object | undefined) => { name: string; parameters: unknown }[]) {
    void this.readSchemas
  }

  bump(): void {
    this.generation += 1
  }

  schemaOf(agent: object | undefined): (tool: string) => unknown | undefined {
    let hit = agent !== undefined ? this.cache.get(agent) : undefined
    if (hit === undefined || hit.gen !== this.generation) {
      const map = new Map<string, unknown>()
      for (const schema of this.readSchemas(agent)) map.set(schema.name, schema.parameters)
      hit = { gen: this.generation, map }
      if (agent !== undefined) this.cache.set(agent, { gen: hit.gen, map: hit.map })
    }
    return (tool: string): unknown | undefined => hit?.map.get(tool)
  }
}

/** Per-agent weak state: final-outcome accounting for repeat hints. */
interface AgentState {
  readonly tracker: RepeatTracker
  /** callId → our structured violations for OUR OWN invalid deny. */
  readonly deniedViolations: Map<string, readonly string[]>
  /** callIds whose arguments were valid but the batch denied them. */
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

function sessionOf(ctx: Context, agent: AgentLike | undefined) {
  if (agent?.session !== undefined) return agent.session
  return (ctx.get('sessions') as unknown as { get(id: string): AgentLike['session'] | undefined } | undefined)
    ?.get((agent as { id?: string } | undefined)?.id ?? '')
}

/**
 * Run the preflight for one pending execution; pure decision, no host calls.
 */
function preflightDecision(
  ctx: Context,
  cache: SchemaCache,
  exec: ToolExecution,
): { decision: ReturnType<typeof checkBatch>; note?: string } {
  const agent = exec.agent as unknown as AgentLike | undefined
  // PTC sub-dispatch: only the dynamic current sub-call is checkable —
  // nothing here claims the enclosing program is atomic.
  if (exec.parent !== undefined) {
    const parameters = (exec.schema as { parameters?: unknown } | undefined)?.parameters
    if (parameters === undefined) {
      return { decision: { kind: 'allow' }, note: 'ptc sub-call without binding schema; deferred to host' }
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
      decision: checkBatch([{ tool: exec.name, callId: exec.callId, args: exec.arguments }], schemaOf),
    }
  }
  const events = session.snapshotEvents()
  // Whole-batch source: the settled assistant message (the tool/call tail
  // grows one call at a time and cannot show the full batch yet).
  const siblings = currentStepCalls(events)
  const present = siblings.some((call) => call.callId === exec.callId)
  const state = agent !== undefined ? stateOf(agent) : undefined
  if (state !== undefined) state.tracker.noteHumanSeq(lastHumanSeq(events))
  if (!present) {
    return {
      decision: checkBatch([{ tool: exec.name, callId: exec.callId, args: exec.arguments }], schemaOf),
      note: siblings.length === 0
        ? 'no assistant tool-call message found; checking current call only (batch atomicity not claimed)'
        : `call ${String(exec.callId)} absent from the assistant batch; checking it alone`,
    }
  }
  const calls: PreflightCall[] = siblings.map((call) => ({ tool: call.tool, callId: call.callId, argsRaw: call.argsRaw }))
  return { decision: checkBatch(calls, schemaOf) }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger
  const cache = new SchemaCache(
    (agent) => ctx.tools.schemas(agent as never) as unknown as { name: string; parameters: unknown }[],
  )
  ctx.on('tools/change', () => cache.bump())

  ctx.on(
    'tools/pre-execute',
    async (exec: ToolExecution, next: () => Promise<import('@deepseek-ai/dsh-tools').PreToolDecision>) => {
      if (!config.preflight) return next()
      try {
        const { decision, note } = preflightDecision(ctx, cache, exec)
        if (note !== undefined) logger.warn('%s: %s', GUARD_NAME, note)
        if (decision.kind === 'deny') {
          const agent = exec.agent as unknown as object | undefined
          if (agent !== undefined) {
            const state = stateOf(agent)
            // Record ONLY this execution's own facts for the final-outcome
            // observer: its own violations when its arguments are the
            // invalid ones, or a valid-denied marker when the batch-mate
            // caused the denial (a valid sibling's own parameters are not
            // its error). Counting happens at `tools/result`, never here.
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
        return next()
      } catch (error) {
        // Our own bug must not become a phantom verdict; degrade to host.
        logger.warn('%s: preflight failed open to host pipeline: %o', GUARD_NAME, error)
        return next()
      }
    },
    true,
  )

  // Final-outcome observer: counting, reset, and hint delivery all live
  // HERE, not in post-execute — the host may cancel after post-execute and
  // pipeline-failure results bypass it entirely, while `tools/result` fires
  // once for every frozen final outcome. Hints are appended to the session
  // with the standard 'execution-guard' source (not a fake user message),
  // so the notice itself never resets the tracker.
  ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<import('@deepseek-ai/dsh-tools').ToolExecutionResult>) => {
    try {
      const agent = exec.agent as unknown as AgentLike | undefined
      if (agent === undefined) return
      const state = stateOf(agent)
      const callId = String(exec.callId)
      const wasValidDenied = state.validDenied.has(callId)
      const ownViolations = state.deniedViolations.get(callId)
      state.forget(callId)
      if (!result.isError) {
        // A genuine final success of the tool resets its failure shapes. A
        // cancelled call settles as an error (ABORTED) and lands below.
        state.tracker.noteSuccess(exec.name)
        return
      }
      if (result.error?.info?.code !== INVALID_ARGS_CODE) return
      if (wasValidDenied) return
      // Host-final INVALID_ARGS outcomes count too: our own structured
      // violations when preflight denied, else the error message lines.
      const violations = ownViolations
        ?? result.error.message.split(/\n|; /).filter((line) => line !== '')
      const count = state.tracker.noteFailure(exec.name, violations)
      if (config.repeatHints && count >= 2) {
        const session = sessionOf(ctx, agent)
        const parameters = cache.schemaOf(agent)(exec.name)
        if (session !== undefined && parameters !== undefined) {
          // Through deliverNotice, never a bare surface append: this observer
          // runs per call inside the batch, so an append here would split a
          // parallel batch's call/result pairing (see notice.ts).
          deliverNotice(agent, buildHintMessage(exec.name, describeShape(parameters)))
        }
      }
    } catch (error) {
      logger.warn('%s: final-outcome accounting failed: %o', GUARD_NAME, error)
    }
  })

}