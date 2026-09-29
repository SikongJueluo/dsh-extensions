/**
 * Provider-neutral quota vocabulary shared by every source and consumer.
 *
 * @module dsh-plan-usage/types
 */

/** One quota window as a source reports it. */
export interface QuotaWindow {
  /** Consumed share, 0-100 (one decimal at most). */
  percent?: number
  /** Consumed value, when the source reports it. */
  used?: number
  /** Window total, when the source reports it. */
  total?: number
  /** Epoch ms of the next window reset, when reported. */
  resetAt?: number
  /** Window length in minutes, when the source reports it (300 = the 5h rolling window). */
  windowMinutes?: number
}

/** One provider's quota snapshot. */
export interface QuotaSnapshot {
  /** Provider route id this snapshot belongs to. */
  provider: string
  /** The rolling short window (GLM/OpenAI/MiniMax: 5h; some plans differ). */
  fiveHour?: QuotaWindow
  /** The weekly window. */
  weekly?: QuotaWindow
  /** Monthly MCP / tool budget, when the plan reports one. */
  monthlyMcp?: QuotaWindow
  /** Plan level / type, when reported ("max", "plus", …). */
  level?: string
  /** Epoch ms of the fetch. */
  fetchedAt: number
  /** Which source and response shape the numbers came from. */
  source: string
}
