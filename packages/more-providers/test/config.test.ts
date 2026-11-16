/**
 * The strict YAML contract of `resolveConfig`: default-on ChatGPT, whole-file
 * rejection on any bad field, and route-id reservation.
 *
 * @module dsh-more-providers/test/config
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, resolveConfig } from '../src/config.js'
const CHATGPT_BASE_URL = 'https://chatgpt.invalid/backend-api/codex'
const TEST_ENV_KEY = 'MORE_PROVIDERS_TEST_KEY'

describe('resolveConfig: ChatGPT section', () => {
  it('enables ChatGPT with built-in defaults when the section is absent', () => {
    const resolved = resolveConfig({ providers: {} })
    expect(resolved.providers).toEqual([])
    expect(resolved.chatgpt).toEqual({})
  })

  it('drops the chatgpt section entirely when explicitly disabled', () => {
    const resolved = resolveConfig({ providers: { chatgpt: { enabled: false } } })
    expect(resolved.providers).toEqual([])
    expect('chatgpt' in resolved).toBe(false)
  })

  it('passes the five connection overrides through', () => {
    const resolved = resolveConfig({
      providers: {
        chatgpt: {
          baseURL: CHATGPT_BASE_URL,
          clientVersion: '9.9.9-test',
          refreshMarginMs: 3600,
          defaultContextWindow: 128000,
          promptCacheKey: false,
        },
      },
    })
    expect(resolved.chatgpt).toEqual({
      baseURL: CHATGPT_BASE_URL,
      clientVersion: '9.9.9-test',
      refreshMarginMs: 3600,
      defaultContextWindow: 128000,
      promptCacheKey: false,
    })
  })

  it('rejects unknown chatgpt fields for the whole document', () => {
    expect(() => resolveConfig({ providers: { chatgpt: { kind: 'custom' } } })).toThrow(ConfigError)
  })

  it('rejects bad chatgpt values even while disabled', () => {
    expect(() =>
      resolveConfig({ providers: { chatgpt: { enabled: false, refreshMarginMs: 0 } } }),
    ).toThrow(ConfigError)
  })
})

describe('resolveConfig: strictness and route reservation', () => {
  const gateway = {
    kind: 'custom',
    api: 'openai-responses',
    baseURL: 'https://gateway.invalid/v1',
    apiKeyEnv: TEST_ENV_KEY,
    models: [{ id: 'gateway-large', input: ['text', 'image'] }],
  }

  it('rejects the whole document when any provider field is unknown', () => {
    expect(() =>
      resolveConfig({ providers: { gateway: { ...gateway, typo: true }, other: gateway } }),
    ).toThrow(ConfigError)
  })

  it('resolves routes with account ids and env keys', () => {
    const resolved = resolveConfig({ providers: { gateway } })
    expect(resolved.providers).toHaveLength(1)
    expect(resolved.providers[0]).toMatchObject({
      route: 'gateway',
      providerId: 'gateway',
      kind: 'custom',
      api: 'openai-responses',
    })
    expect(resolved.providers[0]?.keySource).toEqual({ kind: 'env', name: TEST_ENV_KEY })
    expect(resolved.chatgpt).toEqual({})
  })

  it('fails closed when a provider claims the reserved chatgpt route', () => {
    expect(() =>
      resolveConfig({
        providers: {
          gateway: {
            ...gateway,
            accounts: { a: { routeId: 'chatgpt' } },
          },
        },
      }),
    ).toThrow(ConfigError)
  })

  it('fails closed without a key source', () => {
    const { apiKeyEnv: _env, ...keyless } = gateway
    void _env
    expect(() => resolveConfig({ providers: { gateway: keyless } })).toThrow(ConfigError)
  })

  it('requires the providers key', () => {
    expect(() => resolveConfig({})).toThrow(ConfigError)
  })
})
