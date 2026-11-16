/**
 * Shared untrusted-value guards for the host and browser halves.
 *
 * @module dsh-triggers/record
 */

/**
 * Whether a value is a string-keyed record. JSON objects and arrays both
 * qualify (arrays own their indices as string keys); `null` does not. Field
 * reads stay `unknown`, so every use keeps its own `typeof` checks.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
