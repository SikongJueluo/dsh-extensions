/**
 * Failure classification: which failures move a request to the next account, which
 * only cool that account down, and which must be reported as they are.
 * @module dsh-more-providers/providers/failure-class
 */
import type { LlmFailure } from '@deepseek-ai/dsh-llm'

/** What a failure says about the account and the request. */
export type FailureTier = 'account' | 'transient' | 'terminal'

const ACCOUNT_CODES = new Set([
  'AUTH',
  'QUOTA',
  'INVALID_CREDENTIAL',
  'ACCOUNT_QUOTA',
  'ACCOUNT_TOKEN_INVALID',
  'ACCOUNT_SIGN_IN_REQUIRED',
])

const TRANSIENT_CODES = new Set([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'STREAM_CLOSED',
  'EMPTY_RESPONSE',
  'MALFORMED_RESPONSE',
  'PI_AI_ERROR',
])

/**
 * Which tier a failure belongs to. An unknown code is terminal: switching accounts
 * could duplicate a request whose outcome nobody understands yet.
 */
export function classifyFailure(failure: LlmFailure): FailureTier {
  if (ACCOUNT_CODES.has(failure.code)) return 'account'
  if (TRANSIENT_CODES.has(failure.code)) return 'transient'
  return 'terminal'
}
