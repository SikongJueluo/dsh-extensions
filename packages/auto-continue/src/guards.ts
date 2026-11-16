/**
 * Shared untrusted-JSON guards for the persistence readers (spool, restart
 * mirror): narrow an unknown value to a plain record without a type assertion.
 *
 * @module dsh-auto-continue/guards
 */

/** A plain object (not null, not an array) whose fields stay untrusted. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
