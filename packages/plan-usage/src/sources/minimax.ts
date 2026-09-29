/**
 * MiniMax Token Plan quota source: `GET /v1/token_plan/remains`.
 *
 * One row per model bucket (`general` = the text/coding pool this source
 * reports; `video` is ignored), each with a rolling interval window (5h for
 * general) and a weekly window. Four wire quirks, all verified against
 * ai-usagebar's live capture (MIT):
 *
 * 1. HTTP 200 always — auth failures arrive 200 with the real status in
 *    `base_resp.status_code` (1004 no key, 2049 wrong-region key).
 * 2. The percentages are what REMAINS, not what was consumed — inverted here.
 * 3. The interval length is per-bucket (general 5h, video 24h) — derived from
 *    each row's own start/end, never a constant.
 * 4. All timestamps are epoch milliseconds.
 *
 * @module dsh-plan-usage/sources/minimax
 */
import type { QuotaSnapshot } from '../types.js'

/** Region endpoints keyed by provider route id. */
const HOSTS: Record<string, string> = {
  minimax: 'https://api.minimax.io',
  'minimax-cn': 'https://api.minimaxi.com',
}

/** Env var holding each route's API key (matching the pi-ai providers). */
const ENV_KEYS: Record<string, string> = {
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
}

/** Minimal logger surface this source uses. */
export interface SourceLogger {
  warn(message: string, ...args: unknown[]): void
}

/** Fetch implementation shape (global fetch compatible). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface MiniMaxSourceOptions {
  fetchImpl?: FetchLike
  logger?: SourceLogger
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Consumed percent from MiniMax's remaining percent, clamped into 0-100. */
export function consumedFromRemaining(remaining: unknown): number {
  const value = finite(remaining)
  if (value === undefined) return 100
  return 100 - Math.min(100, Math.max(0, value))
}

/** Epoch-ms reset; non-positive values mean "unreported". */
function resetAtMs(value: unknown): number | undefined {
  const ms = finite(value)
  if (ms === undefined || ms <= 1_577_836_800_000 || ms > 4_102_444_800_000) return undefined
  return Math.round(ms)
}

/** Window length in minutes from the row's own bounds, when usable. */
function windowMinutes(startMs: unknown, endMs: unknown): number | undefined {
  const start = finite(startMs)
  const end = finite(endMs)
  if (start === undefined || end === undefined || end <= start) return undefined
  return Math.round((end - start) / 60_000)
}

/** Parsed general-bucket windows. */
export interface MiniMaxWindows {
  fiveHour?: { percent: number; resetAt?: number; windowMinutes?: number }
  weekly?: { percent: number; resetAt?: number; windowMinutes?: number }
}

/** In-band failure: stable status code plus the auth/wrong-region flag. */
export interface MiniMaxError {
  error: string
  /** `base_resp.status_code` when the envelope reported a failure. */
  statusCode?: number
  /** true when the code means the key was rejected (1004 absent, 2049 wrong region). */
  authRejected?: boolean
}

/** Envelope codes that mean the credential was rejected rather than the service failing. */
export function isAuthStatusCode(code: number | undefined): boolean {
  return code === 1004 || code === 2049
}

/**
 * Parse a `token_plan/remains` body into the general bucket's windows.
 * Pure; `undefined` when the envelope reports failure or carries no usable
 * text bucket. Throws nothing; in-band failures return `{ error }` with the
 * stable numeric status code (never the upstream free-text message).
 */
export function parseMiniMaxRemains(body: unknown): MiniMaxWindows | MiniMaxError {
  const envelope = asRecord(body)
  if (envelope === null) return { error: 'minimax: response was not an object' }
  const base = asRecord(envelope.base_resp)
  const status = finite(base?.status_code)
  if (status === undefined || status !== 0) {
    return {
      error: `minimax: API reported failure (status_code ${status ?? 'absent'})`,
      statusCode: status,
      authRejected: isAuthStatusCode(status),
    }
  }
  const rows = Array.isArray(envelope.model_remains) ? envelope.model_remains : []
  const general = rows
    .map((row): Record<string, unknown> | null => asRecord(row))
    .find((row) => row !== null && row.model_name === 'general')
    ?? rows
      .map((row): Record<string, unknown> | null => asRecord(row))
      .find((row) => row !== null && row.model_name !== 'video')
  if (general === undefined || general === null) return { error: 'minimax: response carried no usable model bucket' } as MiniMaxError

  const parsed: MiniMaxWindows = {}
  const intervalRemaining = general.current_interval_remaining_percent
  if (finite(intervalRemaining) !== undefined) {
    const interval: { percent: number; resetAt?: number; windowMinutes?: number } = {
      percent: consumedFromRemaining(intervalRemaining),
    }
    const resetAt = resetAtMs(general.end_time)
    if (resetAt !== undefined) interval.resetAt = resetAt
    const minutes = windowMinutes(general.start_time, general.end_time)
    if (minutes !== undefined) interval.windowMinutes = minutes
    parsed.fiveHour = interval
  }
  const weeklyRemaining = general.current_weekly_remaining_percent
  if (finite(weeklyRemaining) !== undefined) {
    const weekly: { percent: number; resetAt?: number; windowMinutes?: number } = {
      percent: consumedFromRemaining(weeklyRemaining),
    }
    const resetAt = resetAtMs(general.weekly_end_time)
    if (resetAt !== undefined) weekly.resetAt = resetAt
    const minutes = windowMinutes(general.weekly_start_time, general.weekly_end_time)
    if (minutes !== undefined) weekly.windowMinutes = minutes
    parsed.weekly = weekly
  }
  if (parsed.fiveHour === undefined && parsed.weekly === undefined) {
    return { error: 'minimax: general bucket carried no percentages' } as MiniMaxError
  }
  return parsed
}

/**
 * The MiniMax usage source for the `minimax` / `minimax-cn` routes, keyed by
 * each route's region host and env API key.
 */
export class MiniMaxSource {
  readonly id = 'minimax'
  readonly routes = Object.keys(HOSTS)
  /** Live host per route — flips once when the key turns out to belong to the other region (2049). */
  private readonly hostOverrides = new Map<string, string>()

  private readonly fetchImpl: FetchLike
  private readonly logger: SourceLogger | undefined
  private readonly timeoutMs: number
  private readonly env: NodeJS.ProcessEnv

  constructor(options: MiniMaxSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.env = options.env ?? process.env
  }

  /** The route's host + resolved API key, when both are known. */
  private endpointOf(route: string, hostOverride?: string): { url: string; host: string; apiKey: string } | undefined {
    const envName = ENV_KEYS[route]
    if (HOSTS[route] === undefined || envName === undefined) return undefined
    const apiKey = this.env[envName]?.trim()
    if (apiKey === undefined || apiKey === '') return undefined
    const host = hostOverride ?? this.hostOverrides.get(route) ?? HOSTS[route]
    if (host === undefined) return undefined
    return { url: `${host}/v1/token_plan/remains`, host, apiKey }
  }

  /** The other region's host for a route, when the key belongs there instead. */
  private fallbackHost(route: string, tried: string): string | undefined {
    return Object.values(HOSTS).find((host) => host !== tried)
  }

  /** Whether the route is known and its API key is set. */
  ready(route: string): boolean {
    return this.endpointOf(route) !== undefined
  }

  async get(route: string): Promise<QuotaSnapshot | undefined> {
    const first = await this.attempt(route)
    if (first.snapshot !== undefined || !first.retryOtherRegion) return first.snapshot
    // The key belongs to the other region (2049); the flip is already recorded.
    return (await this.attempt(route)).snapshot
  }

  /** One attempt against the route's current host. */
  private async attempt(route: string): Promise<{ snapshot?: QuotaSnapshot; retryOtherRegion: boolean }> {
    const endpoint = this.endpointOf(route)
    if (endpoint === undefined) {
      this.logger?.warn('plan-usage: no MiniMax API key for "%s" (tried env: %s)', route, ENV_KEYS[route] ?? '?')
      return { retryOtherRegion: false }
    }
    const parsed = await this.fetchAndParse(route, endpoint)
    if (!('error' in parsed)) {
      if (endpoint.host !== HOSTS[route]) this.hostOverrides.set(route, endpoint.host)
      return { snapshot: { provider: route, fetchedAt: Date.now(), source: 'minimax:remains', ...parsed }, retryOtherRegion: false }
    }
    // A wrong-region key (2049) means the OTHER region's host serves this
    // account: remember it and retry there once.
    if (parsed.authRejected === true && parsed.statusCode === 2049) {
      const other = this.fallbackHost(route, endpoint.host)
      if (other !== undefined) {
        this.hostOverrides.set(route, other)
        this.logger?.warn('plan-usage: minimax key for "%s" belongs to %s — switching regions', route, other)
        return { retryOtherRegion: true }
      }
    }
    this.logger?.warn('plan-usage: minimax payload for "%s" unusable — %s', route, parsed.error)
    return { retryOtherRegion: false }
  }

  private async fetchAndParse(route: string, endpoint: { url: string; apiKey: string }): Promise<MiniMaxWindows | MiniMaxError> {
    let response: Response
    try {
      response = await this.fetchImpl(endpoint.url, {
        headers: { accept: 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      return { error: `minimax: fetch failed (${(error as Error).message})` }
    }
    if (!response.ok) {
      return { error: `minimax: HTTP ${response.status}` }
    }
    try {
      return parseMiniMaxRemains(await response.json())
    } catch (error) {
      return { error: `minimax: invalid JSON (${(error as Error).message})` }
    }
  }
}
