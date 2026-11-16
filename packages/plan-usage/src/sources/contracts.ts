/**
 * The shapes every quota source shares.
 *
 * Five sources used to declare their own copy of `FetchLike` and the logger
 * surface, and the `QuotaSource` contract lived in `service.ts` where the
 * sources could not see it. One definition each: a source implements
 * `QuotaSource`, and the service dispatches through it.
 */
import type { QuotaSnapshot } from '../types.js'

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
