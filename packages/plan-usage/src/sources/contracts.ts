/**
 * The shapes every quota source shares.
 *
 * Five sources used to declare their own copy of `FetchLike` and the logger
 * surface, and the `QuotaSource` contract lived in `service.ts` where the
 * sources could not see it. One definition each: a source implements
 * `QuotaSource`, and the service dispatches through it.
 */
import type { QuotaSnapshot } from '../types.js'

/**
 * True when `value` is a plain object record (non-null, non-array). The
 * per-source parsers share this guard instead of repeating a
 * `value as Record<string, unknown>` assertion five times.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Minimal logger surface a source uses. */
export interface SourceLogger {
  warn(message: string, ...args: unknown[]): void
}

/** Fetch implementation shape (global fetch compatible). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** One provider group the plan-usage service can query. */
export interface QuotaSource {
  readonly id: string
  /** Provider route ids this source serves. */
  readonly routes: readonly string[]
  /** Whether the route's credential is resolvable right now (sync). */
  ready(route: string): boolean
  /** One route's snapshot; `undefined` on any failure. Never throws. */
  get(route: string, options: { force?: boolean }): Promise<QuotaSnapshot | undefined>
}
