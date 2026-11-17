/**
 * MiniMax Token Plan quota source: `GET /v1/token_plan/remains`.
 * @module dsh-plan-usage/sources/minimax
 */
import type { QuotaSnapshot } from '../types.js'
import { isRecord } from './contracts.js'
import type { FetchLike, QuotaSource, SourceLogger } from './contracts.js'

const HOSTS: Record<string, string> = {
  minimax: 'https://api.minimax.io',
  'minimax-cn': 'https://api.minimaxi.com',
}

const ENV_KEYS: Record<string, string> = {
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
}

export interface MiniMaxSourceOptions {
  fetchImpl?: FetchLike
  logger?: SourceLogger
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  getKey?: (provider: string) => string | undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
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
  statusCode?: number
  authRejected?: boolean
}

/** Envelope codes that mean the credential was rejected rather than the service failing. */
function isAuthStatusCode(code: number | undefined): boolean {
  return code === 1004 || code === 2049
}

/** Parse a `token_plan/remains` body into the general bucket's windows. Pure; `undefined` when the envelope reports failure or carries no usable text bucket. Throws nothing; in-band failures return `{ error }` with the stable numeric status code (never the upstream free-text message). */
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
  const general =
    rows
      .map((row): Record<string, unknown> | null => asRecord(row))
      .find((row) => row !== null && row.model_name === 'general') ??
    rows
      .map((row): Record<string, unknown> | null => asRecord(row))
      .find((row) => row !== null && row.model_name !== 'video')
  if (general === undefined || general === null)
    return { error: 'minimax: response carried no usable model bucket' }

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
    return { error: 'minimax: general bucket carried no percentages' }
  }
  return parsed
}

/** The MiniMax usage source for the `minimax` / `minimax-cn` routes, keyed by each route's region host and env API key. */
export class MiniMaxSource implements QuotaSource {
  readonly id = 'minimax'
  readonly routes = Object.keys(HOSTS)
  private readonly hostOverrides = new Map<string, string>()

  private readonly fetchImpl: FetchLike
  private readonly logger: SourceLogger | undefined
  private readonly timeoutMs: number
  private readonly env: NodeJS.ProcessEnv
  private readonly getKey: ((provider: string) => string | undefined) | undefined

  constructor(options: MiniMaxSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.env = options.env ?? process.env
    this.getKey = options.getKey
  }

  /** The route's host + resolved API key, when both are known. */
  private endpointOf(
    route: string,
    hostOverride?: string,
  ): { url: string; host: string; apiKey: string } | undefined {
    const envName = ENV_KEYS[route]
    if (HOSTS[route] === undefined || envName === undefined) return undefined
    const external = this.getKey?.(route)?.trim()
    const apiKey = external !== undefined && external !== '' ? external : this.env[envName]?.trim()
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
    return (await this.attempt(route)).snapshot
  }

  /** One attempt against the route's current host. */
  private async attempt(
    route: string,
  ): Promise<{ snapshot?: QuotaSnapshot; retryOtherRegion: boolean }> {
    const endpoint = this.endpointOf(route)
    if (endpoint === undefined) {
      this.logger?.warn(
        'plan-usage: no MiniMax API key for "%s" (tried env: %s)',
        route,
        ENV_KEYS[route] ?? '?',
      )
      return { retryOtherRegion: false }
    }
    const parsed = await this.fetchAndParse(route, endpoint)
    if (!('error' in parsed)) {
      if (endpoint.host !== HOSTS[route]) this.hostOverrides.set(route, endpoint.host)
      return {
        snapshot: { provider: route, fetchedAt: Date.now(), source: 'minimax:remains', ...parsed },
        retryOtherRegion: false,
      }
    }
    if (parsed.authRejected === true && parsed.statusCode === 2049) {
      const other = this.fallbackHost(route, endpoint.host)
      if (other !== undefined) {
        this.hostOverrides.set(route, other)
        this.logger?.warn(
          'plan-usage: minimax key for "%s" belongs to %s — switching regions',
          route,
          other,
        )
        return { retryOtherRegion: true }
      }
    }
    this.logger?.warn('plan-usage: minimax payload for "%s" unusable — %s', route, parsed.error)
    return { retryOtherRegion: false }
  }

  private async fetchAndParse(
    route: string,
    endpoint: { url: string; apiKey: string },
  ): Promise<MiniMaxWindows | MiniMaxError> {
    let response: Response
    try {
      response = await this.fetchImpl(endpoint.url, {
        headers: { accept: 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      return {
        error: `minimax: fetch failed (${error instanceof Error ? error.message : String(error)})`,
      }
    }
    if (!response.ok) {
      return { error: `minimax: HTTP ${response.status}` }
    }
    try {
      return parseMiniMaxRemains(await response.json())
    } catch (error) {
      return {
        error: `minimax: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      }
    }
  }
}
