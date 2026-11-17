/**
 * Provider-neutral quota vocabulary shared by every source and consumer.
 * @module dsh-plan-usage/types
 */

/** One quota window as a source reports it. */
export interface QuotaWindow {
  percent?: number
  used?: number
  total?: number
  remaining?: number
  unit?: 'usd'
  resetAt?: number
  windowMinutes?: number
}

/** One provider's quota snapshot. */
export interface QuotaSnapshot {
  provider: string
  fiveHour?: QuotaWindow
  weekly?: QuotaWindow
  monthly?: QuotaWindow
  monthlyMcp?: QuotaWindow
  level?: string
  fetchedAt: number
  source: string
}
