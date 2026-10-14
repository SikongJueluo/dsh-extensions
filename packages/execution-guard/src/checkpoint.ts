/**
 * The persistent task-recovery anchor: shape, atomic store, and comparison.
 *
 * This is a RECOVERY ANCHOR, not a repository write lock: reading it never
 * rebases, checks out, resumes a goal, or forks a session — it only reports
 * agreement or drift between "where the task said it was" and "where the
 * repository/goal actually is". Storage uses the host's atomic-write
 * (`writeFileAtomic` + `withFileLock`) so a crashed save leaves the previous
 * anchor intact; tests point `dir` at a temp directory and never touch the
 * real home.
 *
 * @module dsh-execution-guard/checkpoint
 */
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Bump on any incompatible anchor change; readers refuse other versions. */
export const ANCHOR_SCHEMA_VERSION = 2

/** Pure anchor record — no methods, JSON round-trippable. */
export interface TaskAnchor {
  readonly schemaVersion: typeof ANCHOR_SCHEMA_VERSION
  readonly sessionId: string
  readonly createdAt: number
  readonly repoRoot: string
  readonly phase: string
  readonly ownedFiles: readonly string[]
  readonly verification: string
  readonly vcs: {
    readonly tool: 'jj'
    readonly changeId: string
    /** Full parent change ids in template order; empty for a parentless root. */
    readonly parentChangeIds: readonly string[]
  }
  readonly goal?: {
    readonly goalId: string
    readonly revision: number
    /** Durable phase at checkpoint time; present only when fold-proven. */
    readonly phase?: 'active' | 'paused' | 'blocked' | 'complete'
    /** How the identity was established: durable-fold agreement or unverified model assertion. */
    readonly proof: 'fold-agrees' | 'args-only-unverified'
  }
}

/** Live facts to compare an anchor against; every field optional. */
export interface AnchorCurrent {
  readonly repoRoot?: string
  readonly changeId?: string
  readonly parentChangeIds?: readonly string[]
  readonly goalId?: string
  readonly goalRevision?: number
  readonly goalPhase?: 'active' | 'paused' | 'blocked' | 'complete'
}

/** Field-by-field comparison result. */
export interface AnchorComparison {
  readonly rootMatches: boolean | undefined
  readonly changeMatches: boolean | undefined
  /** Both the count and order of parents must agree. */
  readonly parentsMatch: boolean | undefined
  readonly goalIdMatches: boolean | undefined
  readonly goalRevisionMatches: boolean | undefined
  /** Durable-phase agreement; a completed goal never matches an active anchor. */
  readonly goalPhaseMatches: boolean | undefined
}

const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete'] as const

/**
 * Compare an anchor with current facts; absent facts read as `undefined`
 * (unknown), never as a match. Goal identity is id AND revision (a new goal
 * at the same revision is a mismatch) and phase (complete ≠ active);
 * parents compare as an ordered list, so a rebase that rewires them reads
 * as drift even when the working change id survived it.
 */
export function compareAnchor(anchor: TaskAnchor, current: AnchorCurrent): AnchorComparison {
  const parentsMatch = current.parentChangeIds === undefined
    ? undefined
    : anchor.vcs.parentChangeIds.length === current.parentChangeIds.length
      && anchor.vcs.parentChangeIds.every((id, i) => id === current.parentChangeIds?.[i])
  return {
    rootMatches: current.repoRoot === undefined ? undefined : current.repoRoot === anchor.repoRoot,
    changeMatches: current.changeId === undefined ? undefined : current.changeId === anchor.vcs.changeId,
    parentsMatch,
    goalIdMatches: anchor.goal === undefined || current.goalId === undefined
      ? undefined
      : current.goalId === anchor.goal.goalId,
    goalRevisionMatches: anchor.goal === undefined || current.goalRevision === undefined
      ? undefined
      : current.goalRevision === anchor.goal.revision,
    goalPhaseMatches: anchor.goal?.phase === undefined || current.goalPhase === undefined
      ? undefined
      : current.goalPhase === anchor.goal.phase,
  }
}

/** Validate one parsed anchor record; returns undefined when malformed. */
export function parseAnchor(raw: string): TaskAnchor | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const a = value as Record<string, unknown>
  if (a.schemaVersion !== ANCHOR_SCHEMA_VERSION) return undefined
  if (typeof a.sessionId !== 'string' || typeof a.repoRoot !== 'string' || typeof a.phase !== 'string') return undefined
  if (typeof a.createdAt !== 'number' || !Array.isArray(a.ownedFiles) || typeof a.verification !== 'string') return undefined
  const vcs = a.vcs as Record<string, unknown> | undefined
  if (vcs === undefined || vcs.tool !== 'jj' || typeof vcs.changeId !== 'string'
    || !Array.isArray(vcs.parentChangeIds) || !vcs.parentChangeIds.every((id) => typeof id === 'string')) {
    return undefined
  }
  const goal = a.goal as Record<string, unknown> | undefined
  if (goal !== undefined && (typeof goal.goalId !== 'string' || typeof goal.revision !== 'number'
    || (goal.proof !== 'fold-agrees' && goal.proof !== 'args-only-unverified'))) return undefined
  if (goal?.phase !== undefined
    && (typeof goal.phase !== 'string' || !GOAL_PHASES.includes(goal.phase as typeof GOAL_PHASES[number]))) return undefined
  return value as TaskAnchor
}

/** Options for {@link AnchorStore}: where corrupt/unsupported loads report. */
export interface AnchorStoreOptions {
  /**
   * Called when an anchor file EXISTS but cannot be used (corrupt JSON,
   * unsupported schemaVersion, malformed record) — never for plain absence.
   */
  onProblem?: (message: string) => void
}

/** Filesystem-backed anchor store; one JSON file per session id. */
export class AnchorStore {
  private readonly onProblem: (message: string) => void

  constructor(private readonly dir: string, options: AnchorStoreOptions = {}) {
    this.onProblem = options.onProblem ?? (() => {})
  }

  /** Anchor path for one session (no I/O). */
  pathFor(sessionId: string): string {
    return join(this.dir, 'anchors', `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  }

  /**
   * Atomically replace the session's anchor. The write goes through the
   * host's `withFileLock` + `writeFileAtomic` pair: concurrent writers
   * serialize, readers see the old or the new complete file, and a failed
   * save leaves the previous anchor in place.
   */
  async save(anchor: TaskAnchor): Promise<void> {
    const target = this.pathFor(anchor.sessionId)
    await mkdir(join(this.dir, 'anchors'), { recursive: true })
    await withFileLock(target, () =>
      writeFileAtomic(target, `${JSON.stringify(anchor, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 }),
    )
  }

  /** Load the session's anchor; undefined when absent, malformed, or unsupported (the latter two also report via `onProblem`). */
  async load(sessionId: string): Promise<TaskAnchor | undefined> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(sessionId), 'utf8')
    } catch {
      return undefined
    }
    const parsed = parseAnchor(raw)
    if (parsed === undefined) {
      this.onProblem(
        `anchor for session ${sessionId} exists but is corrupt or unsupported (schemaVersion ${ANCHOR_SCHEMA_VERSION} expected); ignoring it`,
      )
    }
    return parsed
  }
}

/** Resolve the session root through realpath so symlinks cannot fake a match. */
export async function resolveRoot(cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined || cwd === '') return undefined
  try {
    return await realpath(cwd)
  } catch {
    return undefined
  }
}
