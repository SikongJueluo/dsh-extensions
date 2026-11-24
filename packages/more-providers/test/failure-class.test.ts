/**
 * Session-policy refusals: an upstream 403 that flags the conversation must not be read
 * as a credential failure, because retrying or switching accounts cannot resolve it.
 * @module dsh-more-providers/test/failure-class
 */
import { describe, expect, it } from 'vitest'
import { classifyFailure, isSessionBlocked } from '../src/providers/failure-class.js'

const BLOCKED =
  'mdkj-gpt API error (403): {"code":"session_blocked_by_cyber_policy","message":"该会话已被网络安全策略屏蔽，请开启新会话 / This session is blocked by cyber-security policy, please start a new session","type":"permission_error"}'

describe('failure classification: session-policy refusals', () => {
  it('treats a policy refusal as the session tier even though it arrives as AUTH', () => {
    expect(isSessionBlocked({ code: 'AUTH', message: BLOCKED })).toBe(true)
    expect(classifyFailure({ code: 'AUTH', message: BLOCKED })).toBe('policy')
  })

  it('recognizes the English policy sentence without the code', () => {
    expect(
      classifyFailure({
        code: 'AUTH',
        message: 'This session is blocked by cyber-security policy, please start a new session',
      }),
    ).toBe('policy')
  })

  it('keeps an ordinary credential refusal on the account tier', () => {
    expect(
      isSessionBlocked({ code: 'AUTH', message: 'mdkj-gpt API error (401): invalid key' }),
    ).toBe(false)
    expect(classifyFailure({ code: 'AUTH', message: 'invalid key' })).toBe('account')
  })
})
