/**
 * Small runtime-narrowing helpers shared by the more-providers modules.
 *
 * @module dsh-more-providers/record
 */

/** Narrow an unknown value to a plain object (never an array, never null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
