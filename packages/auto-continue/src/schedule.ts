import type { PlanUsageSnapshot } from './shims.js'

export interface ScheduleOptions {
  maxWaitMs: number

  resetMarginMs: number
}

export const DEFAULT_MAX_WAIT_MS = 6 * 60 * 60 * 1000
export const DEFAULT_RESET_MARGIN_MS = 60 * 1000

export const PROBE_SCHEDULE_MS = [
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  30 * 60_000,
  30 * 60_000,
  30 * 60_000,
] as const

export const PROBE_TIGHTEN_AFTER_MS = 4 * 60 * 60 * 1000
export const PROBE_TIGHT_DELAY_MS = 5 * 60_000

export type WaitPlan =
  | {
      kind: 'wait'

      delayMs: number

      window: 'fiveHour' | 'weekly' | 'monthlyMcp' | 'probe'

      retryAt?: number
    }
  | {
      kind: 'give-up'

      reason: string
    }

export function planResetWait(
  snapshot: PlanUsageSnapshot | undefined,
  now: number,
  elapsedMs: number,
  options: ScheduleOptions,
): WaitPlan {
  const budget = options.maxWaitMs - elapsedMs
  if (budget <= 0)
    return {
      kind: 'give-up',
      reason: `auto-continue wait budget of ${Math.round(options.maxWaitMs / 60000)} min is exhausted`,
    }
  const candidates: {
    window: 'fiveHour' | 'weekly' | 'monthlyMcp'
    percent: number | undefined
    resetAt: number | undefined
  }[] = [
    {
      window: 'fiveHour',
      percent: snapshot?.fiveHour?.percent,
      resetAt: snapshot?.fiveHour?.resetAt,
    },
    { window: 'weekly', percent: snapshot?.weekly?.percent, resetAt: snapshot?.weekly?.resetAt },
    {
      window: 'monthlyMcp',
      percent: snapshot?.monthlyMcp?.percent,
      resetAt: snapshot?.monthlyMcp?.resetAt,
    },
  ]
  const withReset = candidates.filter(
    (c): c is typeof c & { resetAt: number } => c.resetAt !== undefined,
  )
  if (withReset.length === 0)
    return { kind: 'wait', delayMs: Math.min(PROBE_SCHEDULE_MS[0], budget), window: 'probe' }

  const exhausted = withReset.filter((c) => (c.percent ?? 0) >= 95)
  if (exhausted.length === 0)
    return { kind: 'wait', delayMs: Math.min(PROBE_SCHEDULE_MS[0], budget), window: 'probe' }

  const binding = exhausted.reduce((a, b) => (a.resetAt >= b.resetAt ? a : b))

  const delayMs = binding.resetAt <= now ? 0 : binding.resetAt + options.resetMarginMs - now
  if (delayMs <= 0) return { kind: 'wait', delayMs: 0, window: binding.window, retryAt: now }
  if (delayMs > budget) {
    const hours = ((binding.resetAt - now) / 3_600_000).toFixed(1)
    return {
      kind: 'give-up',
      reason: `quota window "${binding.window}" resets in ~${hours}h, beyond the configured max wait`,
    }
  }
  return {
    kind: 'wait',
    delayMs,
    window: binding.window,
    retryAt: binding.resetAt + options.resetMarginMs,
  }
}

export function planProbeWait(
  now: number,
  elapsedMs: number,
  probeIndex: number,
  options: ScheduleOptions,
): WaitPlan {
  const budget = options.maxWaitMs - elapsedMs
  if (budget <= 0)
    return {
      kind: 'give-up',
      reason: `auto-continue wait budget of ${Math.round(options.maxWaitMs / 60000)} min is exhausted`,
    }
  let delayMs: number
  if (elapsedMs >= PROBE_TIGHTEN_AFTER_MS) {
    delayMs = PROBE_TIGHT_DELAY_MS
  } else {
    delayMs = PROBE_SCHEDULE_MS[Math.min(probeIndex, PROBE_SCHEDULE_MS.length - 1)] ?? Number.NaN
  }
  const clipped = Math.min(delayMs, budget)
  return { kind: 'wait', delayMs: clipped, window: 'probe', retryAt: now + clipped }
}
