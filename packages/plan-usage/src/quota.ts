/**
 * Coding-plan quota monitor for z.ai / bigmodel.cn GLM coding plans.
 *
 * Data source: the subscription console's own (undocumented but stable)
 * monitor endpoint `GET {host}/api/monitor/usage/quota/limit`, authenticated
 * with the same API key the provider route uses. The response's `limits`
 * array carries one row per window: `TOKENS_LIMIT`/`CREDIT_LIMIT` rows with
 * `unit` 3 / `number` 5 are the rolling five-hour window, `unit` 6 /
 * `number` 1 the weekly window, and `TIME_LIMIT` rows are the monthly MCP
 * tool budget. Every row reports the consumed `percentage` (0-100) and, when
 * relevant, `nextResetTime` (epoch ms).
 *
 * Verified against live responses captured by OpenTokenUsage and opencodex
 * (both MIT); the legacy flat-field payload shape is kept as a fallback.
 *
 * @module dsh-plan-usage/quota
 */

/** One quota window as the monitor sees it. */
export interface QuotaWindow {
  /** Consumed share, 0-100 (one decimal at most). */
  percent?: number
  /** Consumed value, when the API reports it. */
  used?: number
  /** Window total, when the API reports it. */
  total?: number
  /** Epoch ms of the next window reset, when reported. */
  resetAt?: number
}

/** One provider's quota snapshot. */
export interface QuotaSnapshot {
  /** Provider route id this snapshot belongs to. */
  provider: string
  fiveHour?: QuotaWindow
  weekly?: QuotaWindow
  monthlyMcp?: QuotaWindow
  /** Plan level, when the API reports it ("lite" / "pro" / "max" …). */
  level?: string
  /** Epoch ms of the fetch. */
  fetchedAt: number
  /** Which response shape the numbers were read from. */
  source: 'limits' | 'legacy'
}

/** How to reach one provider's quota endpoint. */
export interface MonitorConfig {
  /** Monitor origin, e.g. `https://open.bigmodel.cn`. */
  monitorBaseUrl: string
  /** Env var names to try, in order; the first non-empty value wins. */
  apiKeyEnv: string[]
}

/** Built-in monitors for the known GLM coding-plan provider routes. */
const BUILTIN_MONITORS: Record<string, MonitorConfig> = {
  'zai-coding-cn': {
    monitorBaseUrl: 'https://open.bigmodel.cn',
    apiKeyEnv: ['ZAI_CODING_CN_API_KEY', 'GLM_API_KEY', 'ZAI_API_KEY'],
  },
  'zai-coding': {
    monitorBaseUrl: 'https://api.z.ai',
    apiKeyEnv: ['ZAI_API_KEY', 'GLM_API_KEY'],
  },
  zai: {
    monitorBaseUrl: 'https://api.z.ai',
    apiKeyEnv: ['ZAI_API_KEY', 'GLM_API_KEY'],
  },
  glm: {
    monitorBaseUrl: 'https://open.bigmodel.cn',
    apiKeyEnv: ['GLM_API_KEY', 'ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'],
  },
  'glm-cn': {
    monitorBaseUrl: 'https://open.bigmodel.cn',
    apiKeyEnv: ['GLM_API_KEY', 'ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'],
  },
  'zhipu-bigmodel-coding': {
    monitorBaseUrl: 'https://open.bigmodel.cn',
    apiKeyEnv: ['GLM_API_KEY', 'ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'],
  },
}

/** User config for one provider monitor (all fields optional). */
export interface ProviderMonitorSettings {
  /** Override the monitor origin (default: the route's built-in). */
  monitorBaseUrl?: string
  /** Env var name holding the API key (default: the route's built-ins). */
  apiKeyEnv?: string
}

/**
 * Resolve the monitor config for one provider route: user settings over the
 * built-in table. Unknown providers with no user config have no monitor.
 */
export function resolveMonitor(
  provider: string,
  settings: Record<string, ProviderMonitorSettings> = {},
): MonitorConfig | undefined {
  const override = settings[provider]
  const builtin = BUILTIN_MONITORS[provider]
  if (override === undefined) return builtin
  if (builtin === undefined) {
    if (override.monitorBaseUrl === undefined) return undefined
    return {
      monitorBaseUrl: override.monitorBaseUrl,
      apiKeyEnv: override.apiKeyEnv !== undefined ? [override.apiKeyEnv] : [],
    }
  }
  return {
    monitorBaseUrl: override.monitorBaseUrl ?? builtin.monitorBaseUrl,
    apiKeyEnv: override.apiKeyEnv !== undefined ? [override.apiKeyEnv] : builtin.apiKeyEnv,
  }
}

/** Every provider route this package knows a monitor for (built-ins + user config). */
export function monitoredProviders(settings: Record<string, ProviderMonitorSettings> = {}): string[] {
  return [...new Set([...Object.keys(BUILTIN_MONITORS), ...Object.keys(settings)])].sort()
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Normalize a consumed share to 0-100 with one decimal; `undefined` when absent. */
export function normalizePercent(value: unknown): number | undefined {
  const raw = finiteNumber(value)
  if (raw === undefined) return undefined
  const clamped = Math.min(100, Math.max(0, raw))
  return Math.round(clamped * 10) / 10
}

/** Normalize an epoch-ms reset timestamp; `undefined` when absent or absurd. */
export function normalizeResetAt(value: unknown): number | undefined {
  const raw = finiteNumber(value)
  // Accept ms epochs from ~2020 to ~2100; anything else is not a timestamp.
  if (raw === undefined || raw < 1_577_836_800_000 || raw > 4_102_444_800_000) return undefined
  return Math.round(raw)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Read one `limits`-array row into a QuotaWindow. */
function windowOf(row: Record<string, unknown>): QuotaWindow {
  const used = finiteNumber(row.currentValue)
  const total = finiteNumber(row.usage)
  let percent = normalizePercent(row.percentage)
  if (percent === undefined && used !== undefined && total !== undefined && total > 0) {
    percent = normalizePercent((used / total) * 100)
  }
  const window: QuotaWindow = {}
  if (percent !== undefined) window.percent = percent
  if (used !== undefined) window.used = used
  if (total !== undefined) window.total = total
  const resetAt = normalizeResetAt(row.nextResetTime)
  if (resetAt !== undefined) window.resetAt = resetAt
  return window
}

/** True when the window carries at least one usable fact. */
function usable(window: QuotaWindow | undefined): boolean {
  return window !== undefined && (window.percent !== undefined || window.resetAt !== undefined)
}

/**
 * Parse a quota-limit response body (`limits`-array shape preferred, legacy
 * flat fields as fallback). Pure; returns the window facts without provider
 * identity or fetch time.
 */
export function parseQuotaBody(body: unknown): Pick<QuotaSnapshot, 'fiveHour' | 'weekly' | 'monthlyMcp' | 'level' | 'source'> | null {
  const outer = asRecord(body)
  if (outer === null || outer.success === false) return null
  const data = asRecord(outer.data) ?? outer
  const level = typeof data.level === 'string' ? data.level : undefined
  if (Array.isArray(data.limits)) {
    let fiveHour: QuotaWindow | undefined
    let weekly: QuotaWindow | undefined
    let monthlyMcp: QuotaWindow | undefined
    for (const raw of data.limits) {
      const row = asRecord(raw)
      if (row === undefined || row === null) continue
      if (row.type === 'TOKENS_LIMIT' || row.type === 'CREDIT_LIMIT') {
        const unit = finiteNumber(row.unit)
        const number = finiteNumber(row.number)
        if (unit === 3 && number === 5) fiveHour = windowOf(row)
        else if (unit === 6 && number === 1) weekly = windowOf(row)
      } else if (row.type === 'TIME_LIMIT') {
        monthlyMcp = windowOf(row)
      }
    }
    // Per opencodex: when the `limits` key is present, legacy fields are ignored —
    // even an empty array means "no windows", not "fall back".
    const parsed: Pick<QuotaSnapshot, 'fiveHour' | 'weekly' | 'monthlyMcp' | 'level' | 'source'> = { source: 'limits' }
    if (usable(fiveHour)) parsed.fiveHour = fiveHour
    if (usable(weekly)) parsed.weekly = weekly
    if (usable(monthlyMcp)) parsed.monthlyMcp = monthlyMcp
    if (parsed.fiveHour === undefined && parsed.weekly === undefined && parsed.monthlyMcp === undefined) return null
    if (level !== undefined) parsed.level = level
    return parsed
  }
  // Legacy flat fields, optionally nested under `quota`.
  const nested = asRecord(data.quota)
  const percentAt = (key: string): number | undefined =>
    normalizePercent(data[key]) ?? (nested === null ? undefined : normalizePercent(nested[key]))
  const fiveHourPercent = percentAt('fiveHourPercent') ?? percentAt('fiveHourUsage') ?? percentAt('fiveHourUsed')
  const weeklyPercent = percentAt('weeklyPercent') ?? percentAt('weeklyUsage') ?? percentAt('weeklyUsed')
  const monthlyPercent = percentAt('monthlyMCPUsage') ?? percentAt('monthlyMcpUsage')
  const parsed: Pick<QuotaSnapshot, 'fiveHour' | 'weekly' | 'monthlyMcp' | 'level' | 'source'> = { source: 'legacy' }
  if (fiveHourPercent !== undefined) parsed.fiveHour = { percent: fiveHourPercent }
  if (weeklyPercent !== undefined) parsed.weekly = { percent: weeklyPercent }
  if (monthlyPercent !== undefined) parsed.monthlyMcp = { percent: monthlyPercent }
  if (parsed.fiveHour === undefined && parsed.weekly === undefined && parsed.monthlyMcp === undefined) return null
  if (level !== undefined) parsed.level = level
  return parsed
}

/** Minimal logger surface this module uses. */
export interface QuotaLogger {
  warn(message: string, ...args: unknown[]): void
}

/** Fetch implementation shape (global fetch compatible). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface QuotaMonitorOptions {
  fetchImpl?: FetchLike
  now?: () => number
  logger?: QuotaLogger
  /** Request timeout per quota call. */
  timeoutMs?: number
}

interface CacheEntry {
  windows: Pick<QuotaSnapshot, 'fiveHour' | 'weekly' | 'monthlyMcp' | 'level' | 'source'>
  fetchedAt: number
}

/** Cache identity: providers sharing one endpoint+key share one upstream call. */
function monitorCacheKey(monitor: MonitorConfig, apiKey: string): string {
  return JSON.stringify([monitor.monitorBaseUrl, apiKey])
}

/**
 * Shared quota reader with a TTL cache keyed by monitor identity (endpoint +
 * resolved key), not provider route: every waiting agent and the Settings
 * page read through one instance, and provider routes that share a monitor
 * (the GLM coding-plan aliases) produce one upstream request, not N.
 */
export class QuotaMonitor {
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private readonly logger: QuotaLogger | undefined
  private readonly timeoutMs: number
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<CacheEntry | undefined>>()

  constructor(options: QuotaMonitorOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /** Resolve the API key for a monitor from its env candidates. */
  apiKeyOf(monitor: MonitorConfig): string | undefined {
    for (const name of monitor.apiKeyEnv) {
      const value = process.env[name]
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return undefined
  }

  /**
   * Read one provider's quota. Serves from cache while younger than
   * `maxAgeMs`; `force` bypasses the cache. Network/parse failures resolve to
   * `undefined` (never throw) after a warn log.
   */
  async get(
    provider: string,
    monitor: MonitorConfig,
    options: { maxAgeMs?: number; force?: boolean } = {},
  ): Promise<QuotaSnapshot | undefined> {
    const maxAgeMs = options.maxAgeMs ?? 60_000
    const apiKey = this.apiKeyOf(monitor)
    if (apiKey === undefined) {
      this.logger?.warn(
        'auto-continue: no API key for provider "%s" quota monitor (tried env: %s)',
        provider,
        monitor.apiKeyEnv.join(', '),
      )
      return undefined
    }
    const key = monitorCacheKey(monitor, apiKey)
    const cached = this.cache.get(key)
    if (!options.force && cached !== undefined && this.now() - cached.fetchedAt < maxAgeMs) {
      return { provider, fetchedAt: cached.fetchedAt, ...cached.windows }
    }
    const pending = this.inflight.get(key)
    const entry = pending !== undefined
      ? await pending
      : await this.fetchEntry(key, provider, monitor, apiKey)
    return entry === undefined ? undefined : { provider, fetchedAt: entry.fetchedAt, ...entry.windows }
  }

  /** One upstream quota call, cached under the monitor identity. */
  private async fetchEntry(
    key: string,
    provider: string,
    monitor: MonitorConfig,
    apiKey: string,
  ): Promise<CacheEntry | undefined> {
    const attempt = this.fetchWindows(provider, monitor, apiKey)
      .then((windows) => {
        const entry: CacheEntry | undefined = windows === undefined ? undefined : { windows, fetchedAt: this.now() }
        if (entry !== undefined) this.cache.set(key, entry)
        return entry
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, attempt)
    return attempt
  }

  /** One upstream quota call. `undefined` on any failure. */
  private async fetchWindows(
    provider: string,
    monitor: MonitorConfig,
    apiKey: string,
  ): Promise<Pick<QuotaSnapshot, 'fiveHour' | 'weekly' | 'monthlyMcp' | 'level' | 'source'> | undefined> {
    const url = `${monitor.monitorBaseUrl.replace(/\/$/, '')}/api/monitor/usage/quota/limit`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      this.logger?.warn('auto-continue: quota fetch for "%s" failed: %o', provider, error)
      return undefined
    }
    if (!response.ok) {
      this.logger?.warn('auto-continue: quota fetch for "%s" returned HTTP %s', provider, response.status)
      return undefined
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      this.logger?.warn('auto-continue: quota fetch for "%s" returned invalid JSON: %o', provider, error)
      return undefined
    }
    const parsed = parseQuotaBody(body)
    if (parsed === null) {
      this.logger?.warn('auto-continue: quota payload for "%s" carried no usable windows', provider)
      return undefined
    }
    return parsed
  }
}
