/**
 * OpenCode Go quota source: `GET https://opencode.ai/zen/go/v1/usage`.
 *
 * First-party but UNDOCUMENTED, and the shape changed once already — the
 * decoder below treats every field as optional and skips anything it does
 * not recognize. Verified against a live capture of 2026-10-13:
 *
 * 1. One `usage` object with three windows — `rolling` (the ~5h window),
 *    `weekly`, `monthly` — each carrying only `status` ("ok" or
 *    "rate-limited"), `percent` (the CONSUMED share, integer 0-100,
 *    floored upstream — not a fraction), and `resetsAt` (ISO-8601 instant
 *    of the next reset). No amounts are reported.
 * 2. `status: "rate-limited"` means the plan is unusable even if the
 *    number lags — reported as 100.
 * 3. HTTP 403 means the workspace has no Go subscription.
 *
 * @module dsh-plan-usage/sources/opencode
 */
import type { QuotaSnapshot } from '../types.js'

/** The OpenCode Go usage endpoint. */
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** Env var holding the API key (matching the pi-ai provider config). */
const ENV_KEY = 'OPENCODE_API_KEY'

/** Minimal logger surface this source uses. */
export interface SourceLogger {
  warn(message: string, ...args: unknown[]): void
}

/** Fetch implementation shape (global fetch compatible). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface OpenCodeGoSourceOptions {
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

/** Epoch-ms reset from an ISO-8601 string; unparseable or absurd instants are dropped. */
function resetAtMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms <= 1_577_836_800_000 || ms > 4_102_444_800_000) return undefined
  return ms
}

/** Parsed Go-plan windows (route names mapped: rolling→fiveHour). */
export interface OpenCodeGoWindows {
  fiveHour?: { percent?: number; resetAt?: number }
  weekly?: { percent?: number; resetAt?: number }
  monthly?: { percent?: number; resetAt?: number }
}

/** In-band failure: stable short message, never upstream free text. */
export interface OpenCodeGoError {
  error: string
}

/** One `usage.{rolling,weekly,monthly}` row → window facts; malformed rows are skipped. */
function windowOf(raw: unknown): { percent?: number; resetAt?: number } | undefined {
  const row = asRecord(raw)
  if (row === null) return undefined
  const window: { percent?: number; resetAt?: number } = {}
  if (row.status === 'rate-limited') window.percent = 100
  else {
    // percent is the consumed share, integer 0-100; non-numbers are ignored.
    const percent = finite(row.percent)
    if (percent !== undefined) window.percent = Math.min(100, Math.max(0, Math.round(percent * 10) / 10))
  }
  const resetAt = resetAtMs(row.resetsAt)
  if (resetAt !== undefined) window.resetAt = resetAt
  if (window.percent === undefined && window.resetAt === undefined) return undefined
  return window
}

/**
 * Parse a `GET zen/go/v1/usage` body into window facts. Pure; malformed
 * windows are skipped, and when none is usable an in-band `{ error }` with
 * a stable message comes back (never a throw — the endpoint is
 * undocumented and its shape changed once already).
 */
export function parseOpenCodeGoUsage(body: unknown): OpenCodeGoWindows | OpenCodeGoError {
  const envelope = asRecord(body)
  if (envelope === null) return { error: 'opencode: response was not an object' }
  const usage = asRecord(envelope.usage)
  if (usage === null) return { error: 'opencode: usage was not an object' }
  const parsed: OpenCodeGoWindows = {}
  const fiveHour = windowOf(usage.rolling)
  if (fiveHour !== undefined) parsed.fiveHour = fiveHour
  const weekly = windowOf(usage.weekly)
  if (weekly !== undefined) parsed.weekly = weekly
  const monthly = windowOf(usage.monthly)
  if (monthly !== undefined) parsed.monthly = monthly
  if (parsed.fiveHour === undefined && parsed.weekly === undefined && parsed.monthly === undefined) {
    return { error: 'opencode: usage carried no usable windows' } as OpenCodeGoError
  }
  return parsed
}

/**
 * The OpenCode usage source for the `opencode-go` route, keyed by the
 * `OPENCODE_API_KEY` env var: one authenticated GET per fetch, `undefined`
 * on any failure (never throws).
 */
export class OpenCodeGoSource {
  readonly id = 'opencode-go'
  readonly routes = ['opencode-go'] as const

  private readonly fetchImpl: FetchLike
  private readonly logger: SourceLogger | undefined
  private readonly timeoutMs: number
  private readonly env: NodeJS.ProcessEnv

  constructor(options: OpenCodeGoSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.env = options.env ?? process.env
  }

  /** The route's API key, when the route is known and the key is non-empty. */
  private apiKeyOf(route: string): string | undefined {
    if (route !== 'opencode-go') return undefined
    const apiKey = this.env[ENV_KEY]?.trim()
    return apiKey === undefined || apiKey === '' ? undefined : apiKey
  }

  /** Whether the route is known and its API key is set. */
  ready(route: string): boolean {
    return this.apiKeyOf(route) !== undefined
  }

  async get(route: string): Promise<QuotaSnapshot | undefined> {
    const apiKey = this.apiKeyOf(route)
    if (apiKey === undefined) {
      this.logger?.warn('plan-usage: no OpenCode API key for "%s" (tried env: %s)', route, ENV_KEY)
      return undefined
    }
    let response: Response
    try {
      response = await this.fetchImpl(OPENCODE_GO_USAGE_URL, {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      this.logger?.warn('plan-usage: opencode usage fetch failed: %o', error)
      return undefined
    }
    if (!response.ok) {
      // 403 = the workspace has no Go subscription; other codes are upstream trouble.
      this.logger?.warn('plan-usage: opencode usage fetch returned HTTP %s', response.status)
      return undefined
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (error) {
      this.logger?.warn('plan-usage: opencode usage fetch returned invalid JSON: %o', error)
      return undefined
    }
    const parsed = parseOpenCodeGoUsage(body)
    if ('error' in parsed) {
      this.logger?.warn('plan-usage: opencode usage payload for "%s" unusable — %s', route, parsed.error)
      return undefined
    }
    return { provider: route, fetchedAt: Date.now(), source: 'opencode-go:usage', ...parsed }
  }
}
