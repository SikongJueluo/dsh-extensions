/**
 * Secret-safe error labels for diagnostic logs.
 * @module dsh-more-providers/diagnostics
 */
import type { Logger } from '@deepseek-ai/cordis'

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u

function codeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
  return typeof value.code === 'string' && CODE_PATTERN.test(value.code) ? value.code : undefined
}

/**
 * The error class and an optional stable code; never the error message. Only bounded identifier
 * names and machine-code-shaped codes are reported, so arbitrary values cannot smuggle secrets.
 */
function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return typeof error
  const name = NAME_PATTERN.test(error.name) ? error.name : 'object'
  const code = codeOf(error) ?? codeOf(error.cause)
  return code === undefined ? name : `${name}/${code}`
}

/**
 * Emit a debug diagnostic for a thrown value: only its class and code are logged, never a message or
 * any string/object payload. `details` carries static metadata separately. Returns whether the
 * diagnostic reached the logger; a throwing exporter is `false` and cannot replace the outcome.
 */
export function debugQuietly(
  logger: Logger | undefined,
  format: string,
  error: unknown,
  ...details: unknown[]
): boolean {
  if (logger === undefined) return false
  try {
    logger.debug(format, errorClass(error), ...details)
    return true
  } catch {
    return false
  }
}
