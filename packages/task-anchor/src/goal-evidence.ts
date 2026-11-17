/**
 * Goal evidence folded from DURABLE `goal/change` events - never requests.
 * @module dsh-execution-guard/goal-evidence
 */

/** Durable goal lifecycle phases (host `GoalPhase`; activation is separate). */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Latest goal snapshot decoded from durable events. */
export interface GoalSnapshot {
  readonly goalId: string
  readonly revision: number
  readonly phase: GoalPhase
}

/** Authoritative goal fold. `none` = no goal events; `cleared` = the last event was the clear tombstone; `unreadable` = goal events exist but do not match the known version-1 shapes - explicitly NOT a guess. */
export type GoalFold =
  | { kind: 'none' }
  | { kind: 'cleared' }
  | { kind: 'snapshot'; snapshot: GoalSnapshot }
  | { kind: 'unreadable' }

const PHASES: ReadonlySet<string> = new Set(['active', 'paused', 'blocked', 'complete'])

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isGoalPhase(value: string): value is GoalPhase {
  return PHASES.has(value)
}

/** Decode one value as a version-1 goal change. `undefined` = not a goal change at all; `'unreadable'` = claims to be one but deviates from the known shape (unknown version, malformed snapshot, unknown phase). */
export function decodeGoalChangeV1(
  value: unknown,
): { op: 'snapshot'; snapshot: GoalSnapshot } | { op: 'clear' } | undefined | 'unreadable' {
  if (!isRecord(value) || value.kind !== 'goal/change') return undefined
  if (value.version !== 1) return 'unreadable'
  if (value.operation === 'clear') {
    return isRecord(value.cleared) &&
      typeof value.cleared.id === 'string' &&
      typeof value.cleared.revision === 'number'
      ? { op: 'clear' }
      : 'unreadable'
  }
  const goal = value.goal
  if (!isRecord(goal)) return 'unreadable'
  const goalId = goal.id
  const revision = goal.revision
  const phase = goal.phase
  if (typeof goalId !== 'string' || goalId === '') return 'unreadable'
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1)
    return 'unreadable'
  if (typeof phase !== 'string' || !isGoalPhase(phase)) return 'unreadable'
  return { op: 'snapshot', snapshot: { goalId, revision, phase } }
}

/**
 * Fold every durable goal event forward; the last decodable one wins and a clear resets to no goal. An unreadable goal event poisons the fold to `unreadable` (later valid events may recover it - the fold keeps going, matching how a strict decoder replays the newest state).
 * @param events - full session snapshot.
 */
export function foldGoalEvents(
  events: readonly { readonly type: unknown; readonly data: unknown }[],
): GoalFold {
  let fold: GoalFold = { kind: 'none' }
  let sawGoalEvent = false
  for (const event of events) {
    if (event.type !== 'goal/change') continue
    sawGoalEvent = true
    const decoded = decodeGoalChangeV1(event.data)
    if (decoded === undefined) continue
    if (decoded === 'unreadable') {
      fold = { kind: 'unreadable' }
      continue
    }
    fold =
      decoded.op === 'clear'
        ? { kind: 'cleared' }
        : { kind: 'snapshot', snapshot: decoded.snapshot }
  }
  return sawGoalEvent && fold.kind === 'none' ? { kind: 'unreadable' } : fold
}

/** What the checkpoint can honestly claim about the recorded goal. */
export type GoalClaim =
  | {
      goal: { goalId: string; revision: number; phase?: GoalPhase }
      proof: 'fold-agrees' | 'args-only-unverified'
    }
  | { conflict: string }
  | Record<string, never>

/**
 * Merge the model's asserted goal identity with the durable fold.
 * @param args - goalId/goalRevision asserted by `checkpoint_task` arguments.
 * @param fold - the durable goal fold from {@link foldGoalEvents}.
 */
export function mergeGoal(
  args: { goalId?: string; goalRevision?: number },
  fold: GoalFold,
): GoalClaim {
  const id = args.goalId
  const rev = args.goalRevision
  if (id === undefined || rev === undefined) return {}
  if (fold.kind === 'snapshot') {
    const { goalId, revision } = fold.snapshot
    if (goalId !== id) {
      return {
        conflict: `goal id mismatch: checkpoint_task says ${id}, durable fold says ${goalId}`,
      }
    }
    if (revision !== rev) {
      return {
        conflict: `goal revision mismatch: checkpoint_task says ${rev}, durable fold says ${revision} — re-read the goal and retry`,
      }
    }
    return { goal: { goalId: id, revision: rev, phase: fold.snapshot.phase }, proof: 'fold-agrees' }
  }
  if (fold.kind === 'cleared') {
    return {
      conflict:
        'the session goal was cleared (durable tombstone); no active goal to checkpoint — re-read the goal state',
    }
  }
  return { goal: { goalId: id, revision: rev }, proof: 'args-only-unverified' }
}
