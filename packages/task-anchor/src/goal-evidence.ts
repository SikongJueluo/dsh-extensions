/**
 * Goal evidence folded from DURABLE `goal/change` events — never requests.
 *
 * The payloads are decoded against the `dsh-goal` domain's version-1 shapes
 * EXACTLY (`GoalSnapshotChangeMeta` / `GoalClearChangeMeta` in
 * `@deepseek-ai/dsh-goal/lib/types/domain.d.ts`): `{kind:'goal/change',
 * version:1, operation, goal:{id, revision, phase, …}}` or the
 * `{operation:'clear', cleared:{id, revision}}` tombstone. Anything else —
 * unknown `version`, missing `goal.id`/`goal.revision`, an unrecognized
 * `phase` — folds to `unreadable`, never a compatibility guess. `phase` is
 * the durable lifecycle (`active` | `paused` | `blocked` | `complete`);
 * nothing defaults to active. Tool `tool/call` requests prove nothing about
 * outcomes (`update_goal.revision` is the PRE-update CAS value, requests
 * can fail, get/create carry no id) and are ignored entirely.
 *
 * `@deepseek-ai/dsh-goal` also exports a public strict `foldGoal`; once it
 * is installed as a dev dependency this decoder can delegate to it
 * one-for-one. Until then the shapes below are the same contract.
 *
 * @module dsh-execution-guard/goal-evidence
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Durable goal lifecycle phases (host `GoalPhase`; activation is separate). */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

/** Latest goal snapshot decoded from durable events. */
export interface GoalSnapshot {
  readonly goalId: string
  readonly revision: number
  readonly phase: GoalPhase
}

/**
 * Authoritative goal fold. `none` = no goal events; `cleared` = the last
 * event was the clear tombstone; `unreadable` = goal events exist but do
 * not match the known version-1 shapes — explicitly NOT a guess.
 */
export type GoalFold =
  | { kind: 'none' }
  | { kind: 'cleared' }
  | { kind: 'snapshot'; snapshot: GoalSnapshot }
  | { kind: 'unreadable' }

const PHASES: readonly GoalPhase[] = ['active', 'paused', 'blocked', 'complete']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Decode one value as a version-1 goal change. `undefined` = not a goal
 * change at all; `'unreadable'` = claims to be one but deviates from the
 * known shape (unknown version, malformed snapshot, unknown phase).
 */
export function decodeGoalChangeV1(value: unknown):
  | { op: 'snapshot'; snapshot: GoalSnapshot }
  | { op: 'clear' }
  | undefined
  | 'unreadable' {
  if (!isRecord(value) || value.kind !== 'goal/change') return undefined
  if (value.version !== 1) return 'unreadable'
  if (value.operation === 'clear') {
    return isRecord(value.cleared) && typeof value.cleared.id === 'string'
      && typeof value.cleared.revision === 'number'
      ? { op: 'clear' }
      : 'unreadable'
  }
  const goal = value.goal
  if (!isRecord(goal)) return 'unreadable'
  const goalId = goal.id
  const revision = goal.revision
  const phase = goal.phase
  if (typeof goalId !== 'string' || goalId === '') return 'unreadable'
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return 'unreadable'
  if (typeof phase !== 'string' || !PHASES.includes(phase as GoalPhase)) return 'unreadable'
  return { op: 'snapshot', snapshot: { goalId, revision, phase: phase as GoalPhase } }
}

/**
 * Fold every durable goal event forward; the last decodable one wins and a
 * clear resets to no goal. An unreadable goal event poisons the fold to
 * `unreadable` (later valid events may recover it — the fold keeps going,
 * matching how a strict decoder replays the newest state).
 *
 * @param events - full session snapshot.
 */
export function foldGoalEvents(events: readonly SessionEvent[]): GoalFold {
  let fold: GoalFold = { kind: 'none' }
  let sawGoalEvent = false
  for (const event of events) {
    if ((event.type as string) !== 'goal/change') continue
    sawGoalEvent = true
    const decoded = decodeGoalChangeV1(event.data)
    if (decoded === undefined) continue
    if (decoded === 'unreadable') {
      fold = { kind: 'unreadable' }
      continue
    }
    fold = decoded.op === 'clear' ? { kind: 'cleared' } : { kind: 'snapshot', snapshot: decoded.snapshot }
  }
  return sawGoalEvent && fold.kind === 'none' ? { kind: 'unreadable' } : fold
}

/** What the checkpoint can honestly claim about the recorded goal. */
export type GoalClaim =
  | { goal: { goalId: string; revision: number; phase?: GoalPhase }; proof: 'fold-agrees' | 'args-only-unverified' }
  | { conflict: string }
  | Record<string, never>

/**
 * Merge the model's asserted goal identity with the durable fold.
 *
 * CAS semantics: when the fold carries a snapshot, both id AND revision must
 * agree (a new goal at the same revision is still a mismatch); the result is
 * then `fold-agrees` — proven, and carries the durable phase. Without a
 * readable snapshot the assertion is recorded `args-only-unverified` —
 * explicitly NOT CAS proof, never a silent pick.
 *
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
      return { conflict: `goal id mismatch: checkpoint_task says ${id}, durable fold says ${goalId}` }
    }
    if (revision !== rev) {
      return { conflict: `goal revision mismatch: checkpoint_task says ${rev}, durable fold says ${revision} — re-read the goal and retry` }
    }
    return { goal: { goalId: id, revision: rev, phase: fold.snapshot.phase }, proof: 'fold-agrees' }
  }
  if (fold.kind === 'cleared') {
    // A clear tombstone is counter-evidence: the session HAD a goal and it
    // is gone. Asserting one now is a stale claim, not an unknown.
    return { conflict: 'the session goal was cleared (durable tombstone); no active goal to checkpoint — re-read the goal state' }
  }
  // 'none' (no goal events ever) or 'unreadable': no durable proof either
  // way — record the assertion, clearly unverified.
  return { goal: { goalId: id, revision: rev }, proof: 'args-only-unverified' }
}
