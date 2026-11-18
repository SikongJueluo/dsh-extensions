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

  it('resolves per-model context windows and lets account values override provider values', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://gateway.invalid/v1',
          apiKeyEnv: TEST_ENV_KEY,
          models: [{ id: 'model-a' }, { id: 'model-b' }],
          contextWindows: { 'model-a': 200000, 'model-b': 300000 },
          accounts: {
            one: { contextWindows: { 'model-a': 250000 } },
          },
        },
      },
    })
    expect(resolved.providers[0]?.contextWindows).toEqual(
      new Map([
        ['model-a', 250000],
        ['model-b', 300000],
      ]),
    )
  })

  it('supplements dynamically catalogued model context windows', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://gateway.invalid/v1',
          modelsURL: 'https://gateway.invalid/v1/models',
          apiKeyEnv: TEST_ENV_KEY,
          contextWindows: { 'model-a': 200000 },
        },
      },
    })
    expect(resolved.providers[0]?.contextWindows).toEqual(new Map([['model-a', 200000]]))
  })

  it('rejects invalid context window entries', () => {
    expect(() =>
      resolveConfig({
        providers: {
          gateway: {
            kind: 'custom',
            api: 'openai-responses',
            baseURL: 'https://gateway.invalid/v1',
            modelsURL: 'https://gateway.invalid/v1/models',
            apiKeyEnv: TEST_ENV_KEY,
            contextWindows: { 'model-a': 0 },
          },
        },
      }),
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

describe('resolveConfig: regex model defaults', () => {
  const catalogProvider = {
    kind: 'custom',
    api: 'openai-responses',
    baseURL: 'https://gateway.invalid/v1',
    modelsURL: 'https://gateway.invalid/v1/models',
    apiKeyEnv: TEST_ENV_KEY,
  }

  function documentWith(modelDefaults: unknown): unknown {
    return { providers: { gateway: { ...catalogProvider, modelDefaults } } }
  }

  it('keeps ordered rules with compiled patterns, flags, and fields', () => {
    const resolved = resolveConfig(
      documentWith([
        { match: '^gpt-6', contextWindow: 272000, reasoning: ['low', 'high'] },
        { match: 'astra$', flags: 'i', maxTokens: 64000 },
      ]),
    )
    const rules = resolved.providers[0]?.modelDefaults ?? []
    expect(rules.map((rule) => rule.pattern.source)).toEqual(['^gpt-6', 'astra$'])
    expect(rules.map((rule) => rule.pattern.flags)).toEqual(['', 'i'])
    expect(rules[0]).toMatchObject({ contextWindow: 272000, reasoning: ['low', 'high'] })
    expect(rules[1]?.reasoning).toBeUndefined()
  })

  it('rejects an invalid pattern or flag with the rule path', () => {
    expect(() => resolveConfig(documentWith([{ match: '(', contextWindow: 1 }]))).toThrow(
      /providers\.gateway\.modelDefaults\[0\]\.match/u,
    )
    expect(() =>
      resolveConfig(documentWith([{ match: '^gpt', flags: 'ii', contextWindow: 1 }])),
    ).toThrow(/providers\.gateway\.modelDefaults\[0\]\.match/u)
  })

  it('rejects rules that set no model field, unknown keys, and bad values', () => {
    expect(() => resolveConfig(documentWith([{ match: '^gpt' }]))).toThrow(ConfigError)
    expect(() => resolveConfig(documentWith([{ match: '^gpt', context_window: 1 }]))).toThrow(
      ConfigError,
    )
    expect(() => resolveConfig(documentWith([{ match: '^gpt', contextWindow: 0 }]))).toThrow(
      ConfigError,
    )
    expect(() => resolveConfig(documentWith([{ match: '^gpt', reasoning: ['extreme'] }]))).toThrow(
      ConfigError,
    )
    expect(() => resolveConfig(documentWith([]))).toThrow(ConfigError)
  })

  it('rejects model defaults on a builtin provider', () => {
    expect(() =>
      resolveConfig({
        providers: {
          zai: {
            kind: 'builtin',
            apiKeyEnv: TEST_ENV_KEY,
            modelDefaults: [{ match: '^glm', contextWindow: 200000 }],
          },
        },
      }),
    ).toThrow(ConfigError)
  })

  it('inherits provider rules into accounts but refuses account-level rules', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          ...catalogProvider,
          modelDefaults: [{ match: '^gpt-6', contextWindow: 272000 }],
          accounts: { one: {} },
        },
      },
    })
    expect(resolved.providers[0]?.route).toBe('gateway-one')
    expect(resolved.providers[0]?.modelDefaults).toHaveLength(1)
    expect(() =>
      resolveConfig({
        providers: {
          gateway: {
            ...catalogProvider,
            accounts: { one: { modelDefaults: [{ match: '^gpt', contextWindow: 1 }] } },
          },
        },
      }),
    ).toThrow(ConfigError)
  })
})

describe('resolveConfig: model default patterns', () => {
  const catalogProvider = {
    kind: 'custom',
    api: 'openai-responses',
    baseURL: 'https://gateway.invalid/v1',
    modelsURL: 'https://gateway.invalid/v1/models',
    apiKeyEnv: TEST_ENV_KEY,
  }

  it('compiles match and flags without trimming it', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          ...catalogProvider,
          modelDefaults: [{ match: ' gpt ', contextWindow: 272000 }],
        },
      },
    })
    expect(resolved.providers[0]?.modelDefaults?.[0]?.pattern.source).toBe(' gpt ')
    expect(resolved.providers[0]?.modelDefaults?.[0]?.pattern.test('gpt')).toBe(false)
  })

  it('rejects padded flags instead of trimming them', () => {
    expect(() =>
      resolveConfig({
        providers: {
          gateway: {
            ...catalogProvider,
            modelDefaults: [{ match: '^gpt', flags: ' i ', contextWindow: 272000 }],
          },
        },
      }),
    ).toThrow(/providers\.gateway\.modelDefaults\[0\]\.match/u)
  })

  it('keeps rejecting baseURL and modelsURL on a builtin provider', () => {
    for (const key of ['baseURL', 'modelsURL']) {
      expect(() =>
        resolveConfig({
          providers: {
            zai: { kind: 'builtin', apiKeyEnv: TEST_ENV_KEY, [key]: 'https://zai.invalid/v1' },
          },
        }),
      ).toThrow(ConfigError)
    }
  })
})
