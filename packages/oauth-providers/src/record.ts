/**
 * Small runtime-narrowing helpers shared by the provider modules.
 *
 * @module dsh-oauth-providers/record
 */

/** Narrow an unknown value to a plain object (never an array, never null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
