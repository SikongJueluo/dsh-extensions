/**
 * OAuth authorization-input parsing contract: structured inputs yield code/state, raw codes stay raw, malformed URLs do not throw.
 * @module dsh-more-providers/test/oauth
 */
import { describe, expect, it } from 'vitest'
import { parseAuthorizationInput } from '../src/providers/chatgpt/oauth.js'

describe('parseAuthorizationInput', () => {
  it('reads code and state from a redirect URL', () => {
    expect(
      parseAuthorizationInput('http://localhost:1455/auth/callback?code=abc&state=xyz'),
    ).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('reads a code#state pair', () => {
    expect(parseAuthorizationInput('abc#xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('reads URL-encoded code parameters', () => {
    expect(parseAuthorizationInput('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('treats a bare code as the code', () => {
    expect(parseAuthorizationInput('  abc  ')).toEqual({ code: 'abc' })
  })

  it('treats a malformed URL as a raw code instead of throwing', () => {
    expect(parseAuthorizationInput('http://[invalid')).toEqual({ code: 'http://[invalid' })
  })

  it('returns an empty result for blank input', () => {
    expect(parseAuthorizationInput('   ')).toEqual({})
  })
})
