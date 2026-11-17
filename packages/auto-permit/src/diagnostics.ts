/** @module dsh-auto-permit/diagnostics */
import type { Logger } from '@deepseek-ai/cordis'

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u

/**
 * Stable error identity for logs; free text may carry the audited command.
 * Only structured names and codes are kept.
 */
export function errorTag(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error'
  const name = NAME_PATTERN.test(error.name) ? error.name : 'Error'
  const code: unknown = 'code' in error ? error.code : undefined
  if (typeof code === 'string') return CODE_PATTERN.test(code) ? `${name}(${code})` : name
  if (typeof code === 'number' && Number.isSafeInteger(code)) return `${name}(${code})`
  return name
}

/** Emit a warning; false when the exporter itself failed. */
export function warnQuietly(
  logger: Pick<Logger, 'warn'> | undefined,
  format: string,
  ...args: unknown[]
): boolean {
  try {
    logger?.warn(format, ...args)
    return true
  } catch {
    return false
  }
}

/** Emit a debug line; false when the exporter itself failed. */
export function debugQuietly(
  logger: Pick<Logger, 'debug'> | undefined,
  format: string,
  ...args: unknown[]
): boolean {
  try {
    logger?.debug(format, ...args)
    return true
  } catch {
    return false
  }
}
