/**
 * dsh-auto-continue — automatic continuation for quota-limited coding plans.
 *
 * When a coding-plan model request fails with `QUOTA` (the GLM coding plan's
 * "The usage limit has been reached") — or `RATE_LIMIT` after the built-in
 * `llm-retry` budget is exhausted — this plugin owns recovery on the
 * `agent/request-error` waterfall: it reads the plan's quota windows through
 * the `planUsage` service (provided by the sibling dsh-plan-usage plugin),
 * sleeps until the reported window reset, and returns `{ kind: 'retry' }` so
 * the agent loop re-runs the failed step inside the same open turn. No
 * "continue" message, no extra prompt tokens, prompt-cache friendly. Each
 * scheduled wait is recorded as an `llm/retry` session event, which the
 * stock Web conversation view renders as a countdown.
 *
 * Without dsh-plan-usage mounted (or when it has no monitor for the failed
 * route), recovery degrades to staged probing — the plugin still works, it
 * just cannot align to the reported reset time.
 *
 * Consumed host services: `planUsage` optionally via `ctx.get()`.
 *
 * @module dsh-auto-continue
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
import { registerRecovery } from './recovery.js'
import { DEFAULT_MAX_WAIT_MS, DEFAULT_RESET_MARGIN_MS } from './schedule.js'

export { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
export { planResetWait, planProbeWait } from './schedule.js'
export { cancellableSleep } from './recovery.js'
export { PROBE_SCHEDULE_MS, PROBE_TIGHTEN_AFTER_MS, PROBE_TIGHT_DELAY_MS, DEFAULT_MAX_WAIT_MS, DEFAULT_RESET_MARGIN_MS } from './schedule.js'
export type { ScheduleOptions, WaitPlan } from './schedule.js'

/** Plugin-row configuration. */
export interface Config {
  /** Total wait budget from the first owned failure (ms). */
  maxWaitMs: number
  /** Extra slack after a reported reset before retrying (ms). */
  resetMarginMs: number
}

export const Config: Schema<Config> = Schema.object({
  maxWaitMs: Schema.number().step(1).min(60_000)
    .default(DEFAULT_MAX_WAIT_MS)
    .description('Total budget to keep waiting for a quota reset before giving up and failing the turn (ms).'),
  resetMarginMs: Schema.number().step(1).min(0)
    .default(DEFAULT_RESET_MARGIN_MS)
    .description('Extra slack after the reported window reset before retrying (ms).'),
})

export const name = PLUGIN_NAME
export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  registerRecovery(ctx, {
    maxWaitMs: config.maxWaitMs,
    resetMarginMs: config.resetMarginMs,
  })
}
