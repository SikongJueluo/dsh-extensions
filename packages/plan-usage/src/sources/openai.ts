/**
 * OpenAI Codex quota source: the ChatGPT subscription's usage endpoint.
 *
 * `GET https://chatgpt.com/backend-api/wham/usage` with the Codex OAuth
 * bearer token and account id (the dedicated endpoint current Codex uses;
 * the older `x-codex-*` response headers are gone). The payload carries
 * `rate_limit.primary_window` (the rolling short window — 5h on Plus/Pro)
 * and an optional `secondary_window` (the weekly cap), each with consumed
 * `used_percent` (0-100), `limit_window_seconds`, and `reset_at` in **unix
 * seconds** (normalized to ms here). Verified against headroom's live
 * capture of the endpoint (MIT).
 *
 * The token comes from the `oauthProviders` service (dsh-oauth-providers),
 * so it is always the fresh, refresh-rotated one; without that plugin (or
 * without a sign-in) this source resolves `undefined`.
 *
 * @module dsh-plan-usage/sources/openai
 */
import type { QuotaSnapshot } from '../types.js'

/** The ChatGPT backend usage endpoint Codex clients poll. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/** Minimal logger surface this source uses. */
export interface SourceLogger {
  warn(message: string, ...args: unknown[]): void
}

/** Fetch implementation shape (global fetch compatible). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Token provider — typically `() => ctx.get('oauthProviders')?.token('chatgpt')`. */
export type TokenProvider = () => Promise<{ access: string; accountId?: string } | undefined>

export interface OpenAiUsageSourceOptions {
  getToken: TokenProvider
  fetchImpl?: FetchLike
  logger?: SourceLogger
  timeoutMs?: number
  usageUrl?: string
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** One `rate_limit.{primary,secondary}_window` object → window facts. */
function windowOf(raw: unknown): { percent: number; resetAt?: number; windowMinutes?: number } | undefined {
  const row = asRecord(raw)
  if (row === null) return undefined
  const percent = finiteNumber(row.used_percent)
  if (percent === undefined) return undefined
  const window: { percent: number; resetAt?: number; windowMinutes?: number } = {
    percent: Math.min(100, Math.max(0, Math.round(percent * 10) / 10)),
  }
  const seconds = finiteNumber(row.reset_at)
  // The payload reports unix SECONDS; the harness vocabulary is epoch ms.
  if (seconds !== undefined && seconds > 1_577_836_800 && seconds < 4_102_444_800) window.resetAt = Math.round(seconds * 1000)
  const span = finiteNumber(row.limit_window_seconds)
  if (span !== undefined && span > 0) window.windowMinutes = Math.ceil(span / 60)
  return window
}

/**
 * Parse a `GET /wham/usage` JSON body into window facts. Pure; returns
 * `undefined` when the body carries no usable rate-limit data.
 */
export function parseCodexUsage(body: unknown): Pick<QuotaSnapshot, 'fiveHour' | 'weekly' | 'level'> | undefined {
  const payload = asRecord(body)
  if (payload === null) return undefined
  const rateLimit = asRecord(payload.rate_limit)
  if (rateLimit === null) return undefined
  const fiveHour = windowOf(rateLimit.primary_window)
  const weekly = windowOf(rateLimit.secondary_window)
  if (fiveHour === undefined && weekly === undefined) return undefined
  const parsed: Pick<QuotaSnapshot, 'fiveHour' | 'weekly' | 'level'> = {}
  if (fiveHour !== undefined) parsed.fiveHour = fiveHour
  if (weekly !== undefined) parsed.weekly = weekly
  if (typeof payload.plan_type === 'string' && payload.plan_type !== '') parsed.level = payload.plan_type
  return parsed
}

/**
 * The OpenAI usage source for the `chatgpt` route: one authenticated GET per
 * fetch, `undefined` on any failure (never throws).
 */
export class OpenAiUsageSource {
  readonly id = 'openai-codex'
  readonly routes = ['chatgpt'] as const

  private readonly getToken: TokenProvider
  private readonly fetchImpl: FetchLike
  private readonly logger: SourceLogger | undefined
  private readonly timeoutMs: number
  private readonly usageUrl: string

  constructor(options: OpenAiUsageSourceOptions) {
    this.getToken = options.getToken
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.usageUrl = options.usageUrl ?? CODEX_USAGE_URL
  }

  /** Whether the token provider can be reached at all (service mounted). */
  ready(_route: string): boolean {
    return true // availability is discovered at fetch time; absence yields undefined
  }

  async get(route: string): Promise<QuotaSnapshot | undefined> {
    const token = await this.getToken().catch(() => undefined)
    if (token === undefined) {
      this.logger?.warn('plan-usage: no ChatGPT token available (not signed in, or dsh-oauth-providers absent)')
      return undefined
    }
    let response: Response
    try {
      response = await this.fetchImpl(this.usageUrl, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token.access}`,
          originator: 'codex',
          'oai-product-sku': 'codex',
          ...(token.accountId !== undefined && token.accountId !== '' ? { 'chatgpt-account-id': token.accountId } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      this.logger?.warn('plan-usage: codex usage fetch failed: %o', error)
      return undefined
    }
    if (!response.ok) {
      this.logger?.warn('plan-usage: codex usage fetch returned HTTP %s', response.status)
      return undefined
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      this.logger?.warn('plan-usage: codex usage fetch returned invalid JSON: %o', error)
      return undefined
    }
    const parsed = parseCodexUsage(body)
    if (parsed === undefined) {
      this.logger?.warn('plan-usage: codex usage payload carried no usable windows')
      return undefined
    }
    return { provider: route, fetchedAt: Date.now(), source: 'openai:usage', ...parsed }
  }
}
