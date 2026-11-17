/**
 * dsh-task-anchor - a persistent recovery anchor for long tasks.
 * @module dsh-task-anchor
 */
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { AnchorStore, compareAnchor, resolveRoot, type TaskAnchor } from './checkpoint.js'
import { foldGoalEvents, isRecord, mergeGoal } from './goal-evidence.js'
import { defaultExecFile, readJjFacts, type ExecFile } from './jj.js'
import { buildResumeNotice } from './notice.js'

export {
  ANCHOR_SCHEMA_VERSION,
  AnchorStore,
  compareAnchor,
  parseAnchor,
  resolveRoot,
  type AnchorComparison,
  type AnchorCurrent,
  type TaskAnchor,
} from './checkpoint.js'
export {
  foldGoalEvents,
  mergeGoal,
  type GoalFold,
  type GoalSnapshot,
  type GoalClaim,
} from './goal-evidence.js'
export {
  workingLayerArgv,
  workspaceRootArgv,
  readJjFacts,
  defaultExecFile,
  type ExecFile,
  type JjFacts,
  type JjRead,
} from './jj.js'
export { buildResumeNotice, type ResumeReport } from './notice.js'

export const CHECKPOINT_TOOL = 'checkpoint_task'

const GUARD_NAME = 'execution-guard'

/** Plugin-row configuration. `storagePath` defaults to `$DSH_HOME/storages/execution-guard` when left empty - the pre-split location, deliberately kept so anchors written before the split stay readable. */
export interface Config {
  readonly storagePath: string
  readonly jjTimeoutMs: number
  readonly resumeNotice: boolean
}

export const Config = Schema.object({
  storagePath: Schema.string()
    .default('')
    .description('Directory for recovery anchors (default: $DSH_HOME/storages/execution-guard).'),
  jjTimeoutMs: Schema.natural()
    .default(5000)
    .description('Per-invocation budget for the read-only jj fact reads.'),
  resumeNotice: Schema.boolean()
    .default(true)
    .description('Compare the recovery anchor on agent resume/startup.'),
})

export const inject = ['tools']

/** Injectable seams so adapter tests run without real processes or homes. */
export interface ApplyDeps {
  readonly exec?: ExecFile
  readonly jjPath?: string
}

/** The session surface the anchor reads and appends to - the same shape the host's `Session` exposes (declared locally so this module never has to call the SDK's deprecated synchronous event reads by name). */
interface SessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string }
  snapshotEvents(): readonly SessionEvent[]
  append(type: 'user/message', data: UserMessage, opts: { surfaceOp: 'append' }): unknown
}

interface AgentLike {
  readonly id: string
  readonly session?: SessionLike
}

/** Duck-typed sessions registry fallback: only the `get` accessor is needed. */
interface SessionRegistryLike {
  get(id: string): SessionLike | undefined
}

function isSessionRegistry(value: unknown): value is SessionRegistryLike {
  return isRecord(value) && typeof value.get === 'function'
}

function sessionOf(ctx: Context, agent: AgentLike | undefined): SessionLike | undefined {
  if (agent?.session !== undefined) return agent.session
  const sessions: unknown = ctx.get('sessions')
  if (isSessionRegistry(sessions)) return sessions.get(agent?.id ?? '')
  return undefined
}

/**
 * Plugin entry.
 * @param ctx - plugin context.
 * @param config - composition row config (validated by {@link Config}).
 * @param deps - injectable process seams for tests.
 */
export function apply(ctx: Context, config: Config, deps: ApplyDeps = {}): void {
  const logger = ctx.logger
  const execRunner = deps.exec ?? defaultExecFile
  const jjPath = deps.jjPath ?? 'jj'
  const store = new AnchorStore(
    config.storagePath !== '' ? config.storagePath : dshHomePath('storages', 'execution-guard'),
    { onProblem: (message) => logger.warn('%s: %s', GUARD_NAME, message) },
  )
  const jjTimeoutMs = Math.min(Math.max(config.jjTimeoutMs, 1_000), 30_000)

  ctx.tools.register(
    defineTool({
      name: CHECKPOINT_TOOL,
      description:
        'Persist a recovery anchor for the current task: the jj WORKSPACE root (realpath-resolved, correct even when the session cwd is a subdirectory; git fallback intentionally absent — a non-jj root reports unsupported), the jj working change id and its parent (read-only `jj --ignore-working-copy --no-pager`), goal identity (only durable goal-change events count as proof; without them your asserted goal id/revision is recorded UNVERIFIED), phase, owned files, and a verification summary. ' +
        'Call it when a phase completes AND right after switching working layers (`jj new`) so the anchor tracks the layer you are actually editing. ' +
        'On resume the anchor is compared against the live repo/goal and a notice reports consistency or drift. ' +
        'This is a recovery anchor only — it is NOT a repository write lock and it never resumes goals, rebases, or checks out anything.',
      parameters: {
        phase: {
          type: 'string',
          required: true,
          description: 'Short task phase label, e.g. "implement-preflight".',
        },
        ownedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files this task owns (bounded to 64).',
        },
        verification: {
          type: 'string',
          description: 'What was verified (commands run, tests green) and what was not.',
        },
        goalId: {
          type: 'string',
          description: 'Goal id you believe is active; proven only when durable goal events agree.',
        },
        goalRevision: {
          type: 'integer',
          description:
            'Goal revision you believe is current; a durable-fold mismatch fails the checkpoint (CAS).',
        },
        expectRepoRoot: {
          type: 'string',
          description:
            'Optional expected absolute jj workspace root; a mismatch fails the checkpoint.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            saved: { type: 'boolean', required: true },
            repoRoot: { type: 'string', required: true },
            changeId: { type: 'string', required: true },
            parentChangeIds: { type: 'array', items: { type: 'string' }, required: true },
            goalId: { type: 'string' },
            goalRevision: { type: 'integer' },
            goalProof: { type: 'string', enum: ['fold-agrees', 'args-only-unverified'] },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => {
          const record =
            typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
          return [{ type: 'text', text: formatCheckpointResult(record) }]
        },
      },
      async execute(args, exec) {
        const agent = exec.agent
        const session = sessionOf(ctx, agent)
        if (session === undefined) throw new Error('checkpoint_task: no session for this execution')
        const cwd = await resolveRoot(session.header.cwd)
        if (cwd === undefined)
          throw new Error('checkpoint_task: session has no usable working directory')
        const read = await readJjFacts(cwd, execRunner, jjPath, jjTimeoutMs, exec.signal)
        if (!read.ok) {
          const hint =
            read.reason === 'not-jj'
              ? 'not a jj repository (git fallback is intentionally unsupported; jj is required)'
              : read.reason === 'timeout'
                ? `jj fact read timed out after ${jjTimeoutMs}ms`
                : read.reason === 'drift'
                  ? 'the working layer moved while the facts were being read (jj new/rebase mid-read); retry the checkpoint'
                  : 'jj fact read failed'
          throw new Error(`checkpoint_task: ${hint} — ${read.detail.slice(0, 400)}`)
        }
        const root = await resolveRoot(read.facts.workspaceRoot)
        if (root === undefined)
          throw new Error(
            `checkpoint_task: jj workspace root unreadable (${read.facts.workspaceRoot})`,
          )
        if (args.expectRepoRoot !== undefined && args.expectRepoRoot !== root) {
          throw new Error(
            `checkpoint_task: repo root mismatch — expected ${args.expectRepoRoot}, workspace resolves to ${root}`,
          )
        }
        const fold = foldGoalEvents(session.snapshotEvents())
        const merged = mergeGoal({ goalId: args.goalId, goalRevision: args.goalRevision }, fold)
        if ('conflict' in merged) throw new Error(`checkpoint_task: ${merged.conflict}`)
        const ownedFiles = (args.ownedFiles ?? []).slice(0, 64).map((file) => file.slice(0, 512))
        const anchor: TaskAnchor = {
          schemaVersion: 2,
          sessionId: session.id,
          createdAt: Date.now(),
          repoRoot: root,
          phase: args.phase.slice(0, 200),
          ownedFiles,
          verification: (args.verification ?? '').slice(0, 2000),
          vcs: {
            tool: 'jj',
            changeId: read.facts.changeId,
            parentChangeIds: read.facts.parentChangeIds,
          },
          ...(merged.goal !== undefined
            ? {
                goal: {
                  goalId: merged.goal.goalId,
                  revision: merged.goal.revision,
                  proof: merged.proof,
                  ...(merged.goal.phase !== undefined ? { phase: merged.goal.phase } : {}),
                },
              }
            : {}),
        }
        await store.save(anchor)
        logger.info(
          '%s: anchor saved for session %s (phase %s)',
          GUARD_NAME,
          session.id,
          anchor.phase,
        )
        return {
          saved: true,
          repoRoot: anchor.repoRoot,
          changeId: anchor.vcs.changeId,
          parentChangeIds: [...anchor.vcs.parentChangeIds],
          ...(anchor.goal !== undefined
            ? {
                goalId: anchor.goal.goalId,
                goalRevision: anchor.goal.revision,
                goalProof: anchor.goal.proof,
              }
            : {}),
          ...(merged.proof === 'args-only-unverified'
            ? {
                note: 'goal recorded from your assertion only — no durable goal-change evidence, CAS unproven',
              }
            : {}),
        }
      },
    }),
  )

  const noticed = new Set<string>()
  ctx.on(
    'agent/created',
    async (payload: { agent: AgentLike; source: string; signal?: AbortSignal }) => {
      if (!config.resumeNotice) return
      const agent = payload.agent
      const session = agent.session
      if (session === undefined || noticed.has(session.id)) return
      noticed.add(session.id)
      try {
        const anchor = await store.load(session.id)
        if (anchor === undefined) return
        const cwd = await resolveRoot(session.header.cwd)
        const read =
          cwd === undefined || payload.signal?.aborted === true
            ? undefined
            : await readJjFacts(cwd, execRunner, jjPath, jjTimeoutMs, payload.signal)
        const root = read?.ok === true ? await resolveRoot(read.facts.workspaceRoot) : undefined
        const fold = foldGoalEvents(session.snapshotEvents())
        const comparison = compareAnchor(anchor, {
          repoRoot: root,
          changeId: read?.ok === true ? read.facts.changeId : undefined,
          parentChangeIds: read?.ok === true ? read.facts.parentChangeIds : undefined,
          goalId: fold.kind === 'snapshot' ? fold.snapshot.goalId : undefined,
          goalRevision: fold.kind === 'snapshot' ? fold.snapshot.revision : undefined,
          goalPhase: fold.kind === 'snapshot' ? fold.snapshot.phase : undefined,
        })
        session.append(
          'user/message',
          buildResumeNotice({
            anchorPhase: anchor.phase,
            rootMatches: comparison.rootMatches,
            changeMatches: comparison.changeMatches,
            parentsMatch: comparison.parentsMatch,
            goalIdMatches: comparison.goalIdMatches,
            goalRevisionMatches: comparison.goalRevisionMatches,
            goalPhaseMatches: comparison.goalPhaseMatches,
            anchorGoal: anchor.goal,
            ownedFiles: anchor.ownedFiles,
            verification: anchor.verification,
          }),
          { surfaceOp: 'append' },
        )
      } catch (error) {
        logger.warn('%s: resume notice failed: %o', GUARD_NAME, error)
      }
    },
  )
}

function formatCheckpointResult(value: Record<string, unknown>): string {
  const lines = [
    `[execution-guard] anchor saved: root ${String(value.repoRoot)}`,
    `change ${String(value.changeId)} (parents ${(Array.isArray(value.parentChangeIds) ? value.parentChangeIds : []).map(String).join(' ')})`,
  ]
  if (typeof value.goalId === 'string')
    lines.push(`goal ${value.goalId} r${String(value.goalRevision)} (${String(value.goalProof)})`)
  if (typeof value.note === 'string' && value.note !== '') lines.push(value.note)
  return lines.join('\n')
}
