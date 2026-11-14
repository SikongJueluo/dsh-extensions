/**
 * Command Code quota source: the alpha billing routes the Command Code CLI
 * uses for its usage view.
 *
 * `GET /alpha/whoami?limits=1` scopes the team org, then
 * `GET /alpha/billing/credits` reports the 5h/weekly rolling windows and the
 * included monthly credit balance, and `GET /alpha/billing/subscriptions`
 * supplies the plan id and billing-period end. All three take the same
 * `Authorization: Bearer <CMD_API_KEY>` and are undocumented alpha routes, so
 * every field is optional and a malformed window is dropped instead of
 * failing the whole snapshot.
 *
 * @module dsh-plan-usage/sources/commandcode
 */
import type { QuotaSnapshot, QuotaWindow } from '../types.js'

/** Canonical Command Code API origin (billing routes live here, not under /provider). */
export const COMMAND_CODE_API_BASE = 'https://api.commandcode.ai'

/** Env vars accepted by the provider and the official pi extension. */
const ENV_KEYS = ['CMD_API_KEY', 'COMMAND_CODE_API_KEY'] as const

/** Plan id -> [display name, included monthly credits in USD]. */
const PLANS: Record<string, readonly [string, number]> = {
  'individual-go': ['Go', 10],
  'individual-go-v1': ['Go', 10],
  'individual-goat': ['GOAT', 70],
  'individual-pro': ['Pro', 30],
  'individual-pro-v1': ['Pro', 80],
  'individual-provider': ['Provider', 15],
  'individual-max': ['Max', 150],
  'individual-ultra': ['Ultra', 300],
  'teams-pro': ['Teams Pro', 40],
}

/** Minimal logger surface this source uses. */
export interface SourceLogger {
  warn(message: string, ...args: unknown[]): void
}

/** Fetch implementation shape (global fetch compatible). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface CommandCodeSourceOptions {
  fetchImpl?: FetchLike
  logger?: SourceLogger
  timeoutMs?: number
  whoamiTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  baseURL?: string
  /** Extra env var to try first, matching the provider row's apiKeyEnv override. */
  apiKeyEnv?: string
  /** Optional external key resolver (dsh-more-providers' `providerKeys`). */
  getKey?: (provider: string) => string | undefined
}

/** Plugin-row override for the Command Code monitor. */
export interface CommandCodeMonitorSettings {
  /** Env var holding the API key; the default names are still tried after it. */
  apiKeyEnv?: string
  /** API origin override (staging). */
  baseURL?: string
}

/** Parsed quota windows (route name `command-code` maps to `provider`). */
export interface CommandCodeWindows {
  fiveHour?: QuotaWindow
  weekly?: QuotaWindow
  monthly?: QuotaWindow
  level?: string
}

/** In-band failure: stable short message, never upstream free text. */
export interface CommandCodeError {
  error: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Prefer the `data` shell when the body is only an envelope. */
function rootOf(body: unknown): Record<string, unknown> | undefined {
  const record = asRecord(body)
  if (record === undefined) return undefined
  return asRecord(record.data) ?? record
}

/** Epoch ms from milliseconds, seconds, or an ISO-8601 string; absurd instants are dropped. */
function epochMs(value: unknown): number | undefined {
  let ms: number | undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value > 1e11 ? value : value * 1_000
  } else if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) ms = parsed
  }
  if (ms === undefined || ms <= 1_577_836_800_000 || ms > 4_102_444_800_000) return undefined
  return ms
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function percentOf(used: number, cap: number): number {
  if (cap <= 0) return 0
  return round1(Math.min(100, Math.max(0, (used / cap) * 100)))
}

/** One `{ cap, used, resetAt, exceeded }` window; malformed rows are skipped. */
function windowOf(raw: unknown): QuotaWindow | undefined {
  const row = asRecord(raw)
  if (row === undefined) return undefined
  const used = finite(row.used)
  const cap = finite(row.cap)
  if (used === undefined || used < 0 || cap === undefined || cap <= 0) return undefined
  const resetAt = epochMs(row.resetAt)
  return {
    percent: row.exceeded === true ? 100 : percentOf(used, cap),
    used,
    total: cap,
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

/** Merge the top-level and nested (inside `credits`) window-limit locations. */
function windowLimitsOf(body: unknown, root: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const credits = asRecord(root?.credits) ?? asRecord(asRecord(body)?.credits)
  const top = asRecord(root?.windowLimits) ?? asRecord(asRecord(body)?.windowLimits)
  const nested = asRecord(credits?.windowLimits)
  if (top !== undefined && nested !== undefined) return { ...top, ...nested }
  return nested ?? top
}

function planIdOf(credits: Record<string, unknown> | undefined, root: Record<string, unknown> | undefined): string | undefined {
  return stringValue(credits?.planId) ?? stringValue(root?.planId)
}

/**
 * Monthly included-credit window, sized by the reported grant or the plan
 * table. The remaining balance alone is not enough to draw a meaningful bar,
 * so an unknown grant omits the window rather than inventing a denominator.
 */
function monthlyOf(
  credits: Record<string, unknown> | undefined,
  root: Record<string, unknown> | undefined,
  planId: string | undefined,
): QuotaWindow | undefined {
  const remaining = finite(credits?.monthlyCredits)
  if (remaining === undefined) return undefined
  const granted = finite(credits?.monthlyCreditsGranted)
    ?? finite(root?.monthlyCreditsGranted)
    ?? (planId !== undefined ? PLANS[planId]?.[1] : undefined)
  if (granted === undefined || granted <= 0) return { remaining: round2(remaining), unit: 'usd' }
  const used = round2(Math.max(0, granted - remaining))
  return {
    percent: percentOf(used, granted),
    used,
    total: granted,
    remaining: round2(remaining),
    unit: 'usd',
  }
}

/**
 * Parse a `/alpha/billing/credits` body (optionally enriched with the
 * subscription's plan and period end). Pure; returns an in-band `{ error }`
 * when no window is usable.
 */
export function parseCommandCodeCredits(
  creditsBody: unknown,
  subscriptionBody?: unknown,
): CommandCodeWindows | CommandCodeError {
  const root = rootOf(creditsBody)
  if (root === undefined) return { error: 'command-code: credits response was not an object' }
  const credits = asRecord(root.credits) ?? asRecord(asRecord(creditsBody)?.credits) ?? root
  const limits = windowLimitsOf(creditsBody, root)
  const subscription = rootOf(subscriptionBody)
  const planId = planIdOf(credits, root) ?? stringValue(subscription?.planId)

  const parsed: CommandCodeWindows = {}
  if (limits?.limited !== false) {
    const fiveHour = windowOf(limits?.fiveHour)
    if (fiveHour !== undefined) parsed.fiveHour = fiveHour
    const weekly = windowOf(limits?.weekly)
    if (weekly !== undefined) parsed.weekly = weekly
  }
  const monthly = monthlyOf(credits, root, planId)
  if (monthly !== undefined) {
    const resetAt = epochMs(subscription?.currentPeriodEnd) ?? epochMs(root.currentPeriodEnd)
    parsed.monthly = resetAt !== undefined ? { ...monthly, resetAt } : monthly
  }
  if (planId !== undefined) parsed.level = PLANS[planId]?.[0] ?? planId

  if (parsed.fiveHour === undefined && parsed.weekly === undefined && parsed.monthly === undefined) {
    return { error: 'command-code: credits response carried no usable windows' }
  }
  return parsed
}

/** `org.id` from a whoami body, accepting the `{ data: ... }` envelope. */
function orgIdOf(body: unknown): string | undefined {
  const root = rootOf(body)
  const org = asRecord(root?.org) ?? asRecord(asRecord(body)?.org)
  return stringValue(org?.id)
}

/** One GET returning parsed JSON or a status-only failure; never throws. */
interface JsonResult {
  status: number
  body?: unknown
}

/**
 * The Command Code quota source for the `command-code` route, keyed by
 * `CMD_API_KEY` / `COMMAND_CODE_API_KEY`: up to three authenticated GETs per
 * fetch, `undefined` on any failure (never throws).
 */
export class CommandCodeSource {
  readonly id = 'command-code'
  readonly routes = ['command-code'] as const

  private readonly fetchImpl: FetchLike
  private readonly logger: SourceLogger | undefined
  private readonly timeoutMs: number
  private readonly whoamiTimeoutMs: number
  private readonly env: NodeJS.ProcessEnv
  private readonly baseURL: string
  private readonly apiKeyEnv: string | undefined
  private readonly getKey: ((provider: string) => string | undefined) | undefined

  constructor(options: CommandCodeSourceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.whoamiTimeoutMs = options.whoamiTimeoutMs ?? 5_000
    this.env = options.env ?? process.env
    this.baseURL = (options.baseURL ?? COMMAND_CODE_API_BASE).replace(/\/+$/, '')
    this.apiKeyEnv = options.apiKeyEnv?.trim() || undefined
    this.getKey = options.getKey
  }

  private apiKeyOf(route: string): string | undefined {
    if (route !== 'command-code') return undefined
    const external = this.getKey?.(route)?.trim()
    if (external !== undefined && external !== '') return external
    const names = this.apiKeyEnv === undefined ? ENV_KEYS : [this.apiKeyEnv, ...ENV_KEYS]
    for (const name of names) {
      const value = this.env[name]?.trim()
      if (value !== undefined && value !== '') return value
    }
    return undefined
  }

  /** Whether the route is known and its API key is set. */
  ready(route: string): boolean {
    return this.apiKeyOf(route) !== undefined
  }

  private async getJson(path: string, apiKey: string, timeoutMs: number): Promise<JsonResult | undefined> {
    try {
      const response = await this.fetchImpl(`${this.baseURL}${path}`, {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        this.logger?.warn('plan-usage: command-code %s returned HTTP %s', path, response.status)
        return { status: response.status }
      }
      return { status: response.status, body: await response.json() }
    } catch (error) {
      this.logger?.warn('plan-usage: command-code %s fetch failed: %o', path, error)
      return undefined
    }
  }

  async get(route: string): Promise<QuotaSnapshot | undefined> {
    const apiKey = this.apiKeyOf(route)
    if (apiKey === undefined) {
      this.logger?.warn('plan-usage: no Command Code API key for "%s" (tried env: %s)', route, ENV_KEYS.join(', '))
      return undefined
    }

    const whoami = await this.getJson('/alpha/whoami?limits=1', apiKey, this.whoamiTimeoutMs)
    if (whoami?.status === 401 || whoami?.status === 403) return undefined
    const orgId = orgIdOf(whoami?.body)
    const query = orgId !== undefined ? `?orgId=${encodeURIComponent(orgId)}` : ''
    const [credits, subscriptions] = await Promise.all([
      this.getJson(`/alpha/billing/credits${query}`, apiKey, this.timeoutMs),
      this.getJson(`/alpha/billing/subscriptions${query}`, apiKey, this.timeoutMs),
    ])
    if (credits === undefined || credits.status !== 200) return undefined

    const parsed = parseCommandCodeCredits(credits.body, subscriptions?.body)
    if ('error' in parsed) {
      this.logger?.warn('plan-usage: command-code payload for "%s" unusable — %s', route, parsed.error)
      return undefined
    }
    return { provider: route, fetchedAt: Date.now(), source: 'command-code:credits', ...parsed }
  }
}
