/**
 * Wait planning for auto-continue recovery: turn a quota snapshot (or its
 * absence) into "sleep how long before the next retry", within a total
 * wait budget. Pure and unit-tested; the recovery module owns the sleeping.
 *
 * @module dsh-auto-continue/schedule
 */
import type { PlanUsageSnapshot } from './shims.js'

/** Tuning knobs shared by both planners. */
export interface ScheduleOptions {
  /** Total wait budget from the first failure we own (default 6h). */
  maxWaitMs: number
  /** Extra slack after a reported reset before retrying (default 60s). */
  resetMarginMs: number
}

export const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60 * 1000
export const DEFAULT_RESET_MARGIN_MS = 60 * 1000

/** Fallback probe delays while no quota snapshot is available. */
export const PROBE_SCHEDULE_MS = [
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  30 * 60_000,
  30 * 60_000,
  30 * 60_000,
]
/** Once this much time has elapsed since the first failure, tighten probing. */
export const PROBE_TIGHTEN_AFTER_MS = 4 * 60 * 60 * 1000
export const PROBE_TIGHT_DELAY_MS = 5 * 60_000

export type WaitPlan =
  | {
      kind: 'wait'
      /** Ms to sleep before retrying (>= 0). */
      delayMs: number
      /** Which quota window's reset drove this wait, when known. */
      window: 'fiveHour' | 'weekly' | 'monthlyMcp' | 'probe'
      /** Epoch ms the retry will fire around, when known. */
      retryAt?: number
    }
  | {
      kind: 'give-up'
      /** Human-facing reason for the terminal failure path. */
      reason: string
    }

/**
 * Plan the wait from a quota snapshot: sleep until the binding window's
 * reported reset (+ margin). The binding window is the exhausted one; when
 * both 5h and weekly look exhausted, the later reset binds — but a reset
 * beyond the remaining budget gives up rather than sleeping past it.
 */
export function planResetWait(
  snapshot: PlanUsageSnapshot | undefined,
  now: number,
  elapsedMs: number,
  options: ScheduleOptions,
): WaitPlan {
  const budget = options.maxWaitMs - elapsedMs
  if (budget <= 0) return { kind: 'give-up', reason: `auto-continue wait budget of ${Math.round(options.maxWaitMs / 60000)} min is exhausted` }
  const candidates: Array<{ window: 'fiveHour' | 'weekly' | 'monthlyMcp'; percent: number | undefined; resetAt: number | undefined }> = [
    { window: 'fiveHour', percent: snapshot?.fiveHour?.percent, resetAt: snapshot?.fiveHour?.resetAt },
    { window: 'weekly', percent: snapshot?.weekly?.percent, resetAt: snapshot?.weekly?.resetAt },
    { window: 'monthlyMcp', percent: snapshot?.monthlyMcp?.percent, resetAt: snapshot?.monthlyMcp?.resetAt },
  ]
  const withReset = candidates.filter((c): c is typeof c & { resetAt: number } => c.resetAt !== undefined)
  if (withReset.length === 0) return { kind: 'wait', delayMs: Math.min(PROBE_SCHEDULE_MS[0]!, budget), window: 'probe' }
  // Only a window that actually looks exhausted may drive the wait: a fresh
  // snapshot disagreeing with the failure (all windows below threshold) means
  // stale or misattributed data, and the caller should probe instead.
  const exhausted = withReset.filter((c) => (c.percent ?? 0) >= 95)
  if (exhausted.length === 0) return { kind: 'wait', delayMs: Math.min(PROBE_SCHEDULE_MS[0]!, budget), window: 'probe' }
  // When several windows are exhausted, the latest reset binds: an earlier
  // reset (e.g. 5h rolling over) does not help while the weekly one blocks.
  const binding = exhausted.reduce((a, b) => (a.resetAt >= b.resetAt ? a : b))
  // A reset timestamp already in the past means the window rolled over after
  // the failure was normalized — retry immediately instead of adding margin.
  const delayMs = binding.resetAt <= now ? 0 : binding.resetAt + options.resetMarginMs - now
  if (delayMs <= 0) return { kind: 'wait', delayMs: 0, window: binding.window, retryAt: now }
  if (delayMs > budget) {
    const hours = ((binding.resetAt - now) / 3_600_000).toFixed(1)
    return {
      kind: 'give-up',
      reason: `quota window "${binding.window}" resets in ~${hours}h, beyond the configured max wait`,
    }
  }
  return { kind: 'wait', delayMs, window: binding.window, retryAt: binding.resetAt + options.resetMarginMs }
}

/**
 * Plan the next fallback probe when no quota snapshot is available: the
 * staged schedule, tightening after `PROBE_TIGHTEN_AFTER_MS` so a 5h window
 * boundary is not missed by half an hour. The final probe may be clipped to
 * whatever budget remains.
 */
export function planProbeWait(now: number, elapsedMs: number, probeIndex: number, options: ScheduleOptions): WaitPlan {
  const budget = options.maxWaitMs - elapsedMs
  if (budget <= 0) return { kind: 'give-up', reason: `auto-continue wait budget of ${Math.round(options.maxWaitMs / 60000)} min is exhausted` }
  let delayMs: number
  if (elapsedMs >= PROBE_TIGHTEN_AFTER_MS) {
    delayMs = PROBE_TIGHT_DELAY_MS
  } else {
    delayMs = PROBE_SCHEDULE_MS[Math.min(probeIndex, PROBE_SCHEDULE_MS.length - 1)]!
  }
  const clipped = Math.min(delayMs, budget)
  return { kind: 'wait', delayMs: clipped, window: 'probe', retryAt: now + clipped }
}
