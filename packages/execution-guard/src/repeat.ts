/**
 * Isomorphic-INVALID_ARGS repeat tracking, per agent, weakly held and bounded.
 *
 * The host already has a repeat-reminder for identical calls; this module
 * does NOT suppress anything (a legitimately repeated tool is none of our
 * business) and never widens a decision. It only counts SAME-SHAPE argument
 * failures so the second occurrence can carry a concrete correction hint
 * (error code + expected schema shape) as extra context. Any success of the
 * tool and any new human turn reset the state.
 *
 * @module dsh-execution-guard/repeat
 */
import type { PreflightDecision } from './preflight.js'

/** Fingerprints retained per agent before the oldest is evicted. */
export const MAX_FINGERPRINTS = 64

/**
 * Normalize one violation list into a shape key: array indices and string
 * contents collapse, paths and keywords stay. Two failures with the same key
 * are the "same shape" (e.g. the same missing field), independent of values.
 */
export function fingerprint(tool: string, violations: readonly string[]): string {
  const normalized = violations
    .map((line) => line.replace(/[0-9]+/g, '#').replace(/"[^"]*"/g, '"…"'))
    .sort()
  return `${tool}\u0000${normalized.join('\u0001')}`
}

/** Bounded per-agent failure memory; the caller owns lifecycle via WeakMap. */
export class RepeatTracker {
  private readonly counts = new Map<string, number>()
  private humanSeq = -1

  /**
   * Record one denied failure and return its 1-based occurrence count.
   * A count ≥ 2 marks the call for a correction hint.
   */
  noteFailure(tool: string, violations: readonly string[]): number {
    const key = fingerprint(tool, violations)
    const next = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, next)
    if (this.counts.size > MAX_FINGERPRINTS) {
      const oldest = this.counts.keys().next().value
      if (oldest !== undefined) this.counts.delete(oldest)
    }
    return next
  }

  /** A successful call of the tool clears that tool's failure shapes. */
  noteSuccess(tool: string): void {
    for (const key of this.counts.keys()) {
      if (key.startsWith(`${tool}\u0000`)) this.counts.delete(key)
    }
  }

  /** A new human turn resets everything: the conversation moved on. */
  noteHumanSeq(seq: number): void {
    if (seq > this.humanSeq) {
      this.humanSeq = seq
      this.counts.clear()
    }
  }
}

/** Which callIds of one agent deserve a correction hint in post-execute. */
export interface PendingHints {
  /** callId → occurrence count of the failing shape at deny time. */
  readonly calls: Map<string, number>
}

/**
 * Extract the per-call hint duty from a deny decision.
 *
 * @param decision - the preflight deny for the current batch.
 * @param counts - occurrence counts keyed by callId (from {@link RepeatTracker}).
 */
export function hintableCalls(decision: Extract<PreflightDecision, { kind: 'deny' }>, counts: ReadonlyMap<string, number>): string[] {
  return decision.invalid.filter((entry) => (counts.get(entry.callId) ?? 0) >= 2).map((entry) => entry.callId)
}
