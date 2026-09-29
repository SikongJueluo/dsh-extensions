/**
 * Type-only shims for services this package consumes optionally.
 *
 * - `planUsage` is provided by the separate dsh-plan-usage plugin; when that
 *   plugin is absent the service reads as `undefined` and auto-continue
 *   falls back to staged probing. The structural types below mirror
 *   dsh-plan-usage's exported service surface.
 * - The `llm/retry` / `llm/retry-started` session events are declared by the
 *   built-in `@deepseek-ai/dsh-llm-retry` package's own module augmentation,
 *   which this out-of-tree package does not depend on. The shapes below are
 *   structurally identical (modulo the branded RetryId, which is a plain
 *   string at runtime and on the wire), so the stock conversation view —
 *   which renders these events as retry countdown nodes — reads ours
 *   unchanged.
 *
 * The `agent/request-error` waterfall types come from the real
 * `@deepseek-ai/dsh-agent` augmentation (a devDependency here).
 *
 * @module dsh-auto-continue/shims
 */
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** Quota window facts as dsh-plan-usage reports them. */
export interface PlanUsageWindow {
  percent?: number
  used?: number
  total?: number
  resetAt?: number
}

/** One provider's quota snapshot as dsh-plan-usage reports it. */
export interface PlanUsageSnapshot {
  provider: string
  fiveHour?: PlanUsageWindow
  weekly?: PlanUsageWindow
  monthlyMcp?: PlanUsageWindow
  level?: string
  fetchedAt: number
}

/** Minimal `ctx.planUsage` surface consumed by recovery planning. */
export interface PlanUsageServiceShim {
  get(provider: string, options?: { maxAgeMs?: number; force?: boolean }): Promise<PlanUsageSnapshot | undefined>
}

/** Durable record of one auto-continue-scheduled retry wait. */
export interface LlmRetryEventData {
  retryId: string
  turn: number
  step: number
  provider: string
  mode: 'always'
  policyKey: string
  retry: number
  delayMs: number
  failure: LlmFailure
}

/** Durable transition recorded once the retry wait completed. */
export interface LlmRetryStartedEventData {
  retryId: string
  turn: number
  step: number
  retry: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present when the dsh-plan-usage plugin is mounted. */
    planUsage?: PlanUsageServiceShim
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'llm/retry': LlmRetryEventData
    'llm/retry-started': LlmRetryStartedEventData
  }
}
