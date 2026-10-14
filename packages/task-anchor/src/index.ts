/**
 * dsh-task-anchor — a persistent recovery anchor for long tasks.
 *
 * One seam plus one tool, both report-only toward the host:
 *
 * - `checkpoint_task`: persists where the task believes it is — the jj
 *   WORKSPACE root (realpath-resolved, so a session cwd in a repo
 *   subdirectory still compares correctly; git fallback intentionally absent
 *   and a non-jj root fails loudly), the jj working change id and its parents
 *   through fixed-argv read-only invocations, goal identity (DURABLE
 *   `goal/change` events only — a request proves nothing, and an assertion
 *   without evidence is recorded as unverified and never claimed as CAS),
 *   phase, owned files, and a verification summary.
 * - `agent/created`: on startup/resume the anchor is compared against the
 *   live repository and goal, and a notice reports agreement or drift.
 *
 * This is a RECOVERY ANCHOR, not a repository write lock: it never rebases,
 * checks out, resumes a goal (`goals.resume`), or forks a session, and a
 * session-name match is not treated as a lock. Goal re-arm/activation is
 * deliberately NOT equated with recovery.
 *
 * @module dsh-task-anchor
 */
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import {
  AnchorStore,
  compareAnchor,
  resolveRoot,
  type TaskAnchor,
} from './checkpoint.js'
import { foldGoalEvents, mergeGoal } from './goal-evidence.js'
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
export { foldGoalEvents, mergeGoal, type GoalFold, type GoalSnapshot, type GoalClaim } from './goal-evidence.js'
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

/** The tool the model calls to persist an anchor. */
export const CHECKPOINT_TOOL = 'checkpoint_task'

/** The source kind and log prefix the anchor has always used. */
const GUARD_NAME = 'execution-guard'

/**
 * Plugin-row configuration. `storagePath` defaults to
 * `$DSH_HOME/storages/execution-guard` when left empty — the pre-split
 * location, deliberately kept so anchors written before the split stay
 * readable.
 */
export interface Config {
  readonly storagePath: string
  readonly jjTimeoutMs: number
  readonly resumeNotice: boolean
}

// No `Schema<Config>` annotation: schemastery ≥ 3.18.4 bakes volatile modes
// into the schema generics and the loader checks the inferred shape.
export const Config = Schema.object({
  storagePath: Schema.string().default('').description(
    'Directory for recovery anchors (default: $DSH_HOME/storages/execution-guard).',
  ),
  jjTimeoutMs: Schema.natural().default(5000).description('Per-invocation budget for the read-only jj fact reads.'),
  resumeNotice: Schema.boolean().default(true).description('Compare the recovery anchor on agent resume/startup.'),
})

export const inject = ['tools']

/** Injectable seams so adapter tests run without real processes or homes. */
export interface ApplyDeps {
  readonly exec?: ExecFile
  readonly jjPath?: string
}

interface AgentLike {
  readonly id: string
  readonly session?: {
    readonly id: string
    readonly header: { readonly cwd?: string }
    snapshotEvents(): readonly import('@deepseek-ai/dsh-session').SessionEvent[]
    append(type: 'user/message', data: import('@deepseek-ai/dsh-llm').UserMessage, opts: { surfaceOp: 'append' }): unknown
  }
}

function sessionOf(ctx: Context, agent: AgentLike | undefined) {
  if (agent?.session !== undefined) return agent.session
  return (ctx.get('sessions') as unknown as { get(id: string): AgentLike['session'] | undefined } | undefined)
    ?.get((agent as { id?: string } | undefined)?.id ?? '')
}

/**
 * Plugin entry.
 *
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
        phase: { type: 'string', required: true, description: 'Short task phase label, e.g. "implement-preflight".' },
        ownedFiles: { type: 'array', items: { type: 'string' }, description: 'Files this task owns (bounded to 64).' },
        verification: { type: 'string', description: 'What was verified (commands run, tests green) and what was not.' },
        goalId: { type: 'string', description: 'Goal id you believe is active; proven only when durable goal events agree.' },
        goalRevision: { type: 'integer', description: 'Goal revision you believe is current; a durable-fold mismatch fails the checkpoint (CAS).' },
        expectRepoRoot: { type: 'string', description: 'Optional expected absolute jj workspace root; a mismatch fails the checkpoint.' },
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
        render: (_args, value) => [{ type: 'text', text: formatCheckpointResult(value as Record<string, unknown>) }],
      },
      async execute(args, exec) {
        const agent = exec.agent as unknown as AgentLike | undefined
        const session = sessionOf(ctx, agent)
        if (session === undefined) throw new Error('checkpoint_task: no session for this execution')
        const cwd = await resolveRoot(session.header.cwd)
        if (cwd === undefined) throw new Error('checkpoint_task: session has no usable working directory')
        const read = await readJjFacts(cwd, execRunner, jjPath, jjTimeoutMs, exec.signal)
        if (!read.ok) {
          const hint = read.reason === 'not-jj'
            ? 'not a jj repository (git fallback is intentionally unsupported; jj is required)'
            : read.reason === 'timeout'
              ? `jj fact read timed out after ${jjTimeoutMs}ms`
              : read.reason === 'drift'
                ? 'the working layer moved while the facts were being read (jj new/rebase mid-read); retry the checkpoint'
                : 'jj fact read failed'
          throw new Error(`checkpoint_task: ${hint} — ${read.detail.slice(0, 400)}`)
        }
        const root = await resolveRoot(read.facts.workspaceRoot)
        if (root === undefined) throw new Error(`checkpoint_task: jj workspace root unreadable (${read.facts.workspaceRoot})`)
        if (args.expectRepoRoot !== undefined && args.expectRepoRoot !== root) {
          throw new Error(`checkpoint_task: repo root mismatch — expected ${args.expectRepoRoot}, workspace resolves to ${root}`)
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
          vcs: { tool: 'jj', changeId: read.facts.changeId, parentChangeIds: read.facts.parentChangeIds },
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
        logger.info('%s: anchor saved for session %s (phase %s)', GUARD_NAME, session.id, anchor.phase)
        return {
          saved: true,
          repoRoot: anchor.repoRoot,
          changeId: anchor.vcs.changeId,
          parentChangeIds: [...anchor.vcs.parentChangeIds],
          ...(anchor.goal !== undefined ? { goalId: anchor.goal.goalId, goalRevision: anchor.goal.revision, goalProof: anchor.goal.proof } : {}),
          ...(merged.proof === 'args-only-unverified'
            ? { note: 'goal recorded from your assertion only — no durable goal-change evidence, CAS unproven' }
            : {}),
        }
      },
    }),
  )

  const noticed = new Set<string>()
  ctx.on('agent/created', async (payload: { agent: unknown; source: string; signal?: AbortSignal }) => {
    if (!config.resumeNotice) return
    const agent = payload.agent as AgentLike & object
    const session = agent.session
    if (session === undefined || noticed.has(session.id)) return
    noticed.add(session.id)
    try {
      const anchor = await store.load(session.id)
      if (anchor === undefined) return
      const cwd = await resolveRoot(session.header.cwd)
      const read = cwd === undefined || payload.signal?.aborted === true
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
      // Safe as a plain surface append: `agent/created` fires while the agent
      // is still idle (the driver has not opened a turn), so there is no
      // tool-call/result batch to split. Contrast the repeat hint in
      // dsh-execution-guard, which fires mid-batch and must go through
      // `agent.inject()`.
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
  })
}

function formatCheckpointResult(value: Record<string, unknown>): string {
  const lines = [
    `[execution-guard] anchor saved: root ${String(value.repoRoot)}`,
    `change ${String(value.changeId)} (parents ${(Array.isArray(value.parentChangeIds) ? value.parentChangeIds : []).map(String).join(' ')})`,
  ]
  if (typeof value.goalId === 'string') lines.push(`goal ${value.goalId} r${String(value.goalRevision)} (${String(value.goalProof)})`)
  if (typeof value.note === 'string' && value.note !== '') lines.push(value.note)
  return lines.join('\n')
}
