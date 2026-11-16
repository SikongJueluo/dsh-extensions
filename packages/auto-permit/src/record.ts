/**
 * Narrow an unknown value to a plain record without an unsafe assertion.
 *
 * The predicate keeps the same reachability the previous `typeof value ===
 * 'object' && value !== null` guards had: arrays pass the object check in the
 * old code but can never satisfy the field reads that follow, so excluding
 * them here changes no observable outcome.
 *
 * @module dsh-auto-permit/record
 */

/** True when `value` is a non-null, non-array object usable as a record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when `value` is an array, narrowed to unknown elements (never `any[]`). */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}
