/**
 * Cache affinity of the ChatGPT request body: the session id becomes
 * `prompt_cache_key` and is clamped to the provider's 64-code-point limit.
 *
 * @module dsh-more-providers/test/serialize-affinity
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { clampSessionAffinityKey, serializeRequest } from '../src/providers/chatgpt/serialize.js'

const sessionId = 'session-21537589-5751-4490-af91-ef25bced6b1f'
const OUTSIDE_BMP = '\u{1D11E}'

function options(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { provider: 'chatgpt', model: 'gpt-6.1-sol', messages: [], ...extra }
}

describe('chatgpt request affinity', () => {
  it('stamps prompt_cache_key from the session id', () => {
    const body = serializeRequest(options({ sessionId }), undefined, { promptCacheKey: true })
    expect(body.prompt_cache_key).toBe(sessionId)
  })

  it('omits prompt_cache_key when affinity is off', () => {
    const body = serializeRequest(options({ sessionId }), undefined, { promptCacheKey: false })
    expect(body.prompt_cache_key).toBeUndefined()
  })

  it('defaults affinity to on when no knob is supplied', () => {
    expect(serializeRequest(options({ sessionId })).prompt_cache_key).toBe(sessionId)
    expect(serializeRequest(options()).prompt_cache_key).toBeUndefined()
  })

  it('clamps an over-long key to 64 code points without splitting surrogate pairs', () => {
    expect(clampSessionAffinityKey('x'.repeat(100))).toBe('x'.repeat(64))
    expect(clampSessionAffinityKey(OUTSIDE_BMP.repeat(100))).toBe(OUTSIDE_BMP.repeat(64))
    expect(clampSessionAffinityKey(sessionId)).toBe(sessionId)
  })
})
