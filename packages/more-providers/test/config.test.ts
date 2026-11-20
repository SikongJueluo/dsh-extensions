/**
 * The strict YAML contract of `resolveConfig`: default-on ChatGPT, whole-file
 * rejection on any bad field, and route-id reservation.
 *
 * @module dsh-more-providers/test/config
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, resolveConfig, type ResolvedConfig } from '../src/config.js'
import { toProviderSpecs, type CustomProviderSpec } from '../src/providers/spec.js'

/** The first provider as its custom-kind spec, failing loudly when the fixture changed kind. */
function customSpec(resolved: ResolvedConfig, index = 0): CustomProviderSpec {
  const spec = resolved.providers[index]
  if (spec?.kind !== 'custom') throw new Error(`provider ${String(index)} is not a custom spec`)
  return spec
}
const CHATGPT_BASE_URL = 'https://chatgpt.invalid/backend-api/codex'
const TEST_ENV_KEY = 'MORE_PROVIDERS_TEST_KEY'

describe('resolveConfig: ChatGPT section', () => {
  it('registers no ChatGPT provider when the section is absent', () => {
    const resolved = resolveConfig({ providers: {} })
    expect(resolved.providers).toEqual([])
    expect('chatgpt' in resolved).toBe(false)
    expect(toProviderSpecs(resolved)).toEqual([])
  })

  it('keeps an explicitly disabled ChatGPT provider out of registration', () => {
    const resolved = resolveConfig({
      providers: { chatgpt: { kind: 'chatgpt', enabled: false } },
    })
    expect(resolved.providers).toEqual([])
    expect(resolved.chatgpt).toMatchObject({
      route: 'chatgpt',
      providerId: 'chatgpt',
      kind: 'chatgpt',
      displayName: 'ChatGPT (OpenAI)',
      enabled: false,
    })
    expect(toProviderSpecs(resolved)).toEqual([])
  })

  it('passes the five connection overrides through', () => {
    const resolved = resolveConfig({
      providers: {
        chatgpt: {
          kind: 'chatgpt',
          baseURL: CHATGPT_BASE_URL,
          clientVersion: '9.9.9-test',
          refreshMarginMs: 3600,
          defaultContextWindow: 128000,
          promptCacheKey: false,
        },
      },
    })
    expect(resolved.chatgpt?.config).toEqual({
      baseURL: CHATGPT_BASE_URL,
      clientVersion: '9.9.9-test',
      refreshMarginMs: 3600,
      defaultContextWindow: 128000,
      promptCacheKey: false,
    })
  })

  it('rejects a foreign kind and unknown fields on the ChatGPT provider', () => {
    expect(() => resolveConfig({ providers: { chatgpt: { kind: 'custom' } } })).toThrow(
      /providers\.chatgpt\.kind: the reserved provider id/u,
    )
    expect(() =>
      resolveConfig({ providers: { chatgpt: { kind: 'chatgpt', bogusField: 1 } } }),
    ).toThrow(/providers\.chatgpt: unknown key "bogusField"/u)
  })

  it('rejects bad chatgpt values even while disabled', () => {
    expect(() =>
      resolveConfig({
        providers: { chatgpt: { kind: 'chatgpt', enabled: false, refreshMarginMs: 0 } },
      }),
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

  it('resolves per-model context windows from the provider', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://gateway.invalid/v1',
          apiKeyEnv: TEST_ENV_KEY,
          models: [{ id: 'model-a' }, { id: 'model-b' }],
          contextWindows: { 'model-a': 200000, 'model-b': 300000 },
          accounts: { one: {} },
        },
      },
    })
    expect(customSpec(resolved).contextWindows).toEqual(
      new Map([
        ['model-a', 200000],
        ['model-b', 300000],
      ]),
    )
  })

  it('refuses account-level context windows with a migration hint', () => {
    expect(() =>
      resolveConfig({
        providers: {
          gateway: {
            kind: 'custom',
            api: 'openai-responses',
            baseURL: 'https://gateway.invalid/v1',
            apiKeyEnv: TEST_ENV_KEY,
            models: [{ id: 'model-a' }],
            accounts: { one: { contextWindows: { 'model-a': 250000 } } },
          },
        },
      }),
    ).toThrow(/providers\.gateway\.accounts\.one\.contextWindows: move it to the provider level/u)
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
    expect(customSpec(resolved).contextWindows).toEqual(new Map([['model-a', 200000]]))
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

  it('resolves one route per provider with an ordered account pool', () => {
    const resolved = resolveConfig({ providers: { gateway } })
    expect(resolved.providers).toHaveLength(1)
    expect(resolved.providers[0]).toMatchObject({
      providerId: 'gateway',
      route: 'gateway',
      kind: 'custom',
      api: 'openai-responses',
      enabled: true,
    })
    expect(resolved.providers[0]?.accounts).toEqual([
      { id: 'gateway', displayName: 'gateway', keySource: { kind: 'env', name: TEST_ENV_KEY } },
    ])
    expect('chatgpt' in resolved).toBe(false)
  })

  it('keeps the YAML account order as the pool priority and honours routeId', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          ...gateway,
          routeId: 'gateway-pool',
          accounts: { stable: {}, cheap: { displayName: 'Cheap' } },
        },
      },
    })
    expect(resolved.providers[0]?.route).toBe('gateway-pool')
    expect(resolved.providers[0]?.accounts.map((account) => account.id)).toEqual([
      'stable',
      'cheap',
    ])
    expect(resolved.providers[0]?.accounts[1]?.displayName).toBe('Cheap')
  })

  it('fails closed when a provider or account claims the reserved chatgpt route', () => {
    expect(() =>
      resolveConfig({ providers: { gateway: { ...gateway, routeId: 'chatgpt' } } }),
    ).toThrow(/providers\.gateway\.routeId: the route id "chatgpt" is reserved/u)
    expect(() =>
      resolveConfig({
        providers: { gateway: { ...gateway, accounts: { a: { routeId: 'chatgpt' } } } },
      }),
    ).toThrow(/providers\.gateway\.accounts\.a\.routeId: one provider registers one route/u)
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
    const rules = customSpec(resolved).modelDefaults ?? []
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

  it('inherits provider rules into the pool but refuses account-level rules', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          ...catalogProvider,
          modelDefaults: [{ match: '^gpt-6', contextWindow: 272000 }],
          accounts: { one: {} },
        },
      },
    })
    expect(resolved.providers[0]?.route).toBe('gateway')
    expect(resolved.providers[0]?.accounts).toHaveLength(1)
    expect(customSpec(resolved).modelDefaults).toHaveLength(1)
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
    const rule = customSpec(resolved).modelDefaults?.[0]
    expect(rule?.pattern.source).toBe(' gpt ')
    expect(rule?.pattern.test('gpt')).toBe(false)
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

describe('resolveConfig: model filter', () => {
  const catalogProvider = {
    kind: 'custom',
    api: 'openai-responses',
    baseURL: 'https://gateway.invalid/v1',
    modelsURL: 'https://gateway.invalid/v1/models',
    apiKeyEnv: TEST_ENV_KEY,
  }

  function documentWith(filter: unknown): unknown {
    return { providers: { gateway: { ...catalogProvider, filter } } }
  }

  it('compiles provider filter groups into an id filter', () => {
    const resolved = resolveConfig(
      documentWith({
        include: [{ match: '^gpt-' }],
        exclude: [{ match: '-mini$' }],
      }),
    )
    const filter = resolved.providers[0]?.filter
    expect(filter?.keeps('gpt-6')).toBe(true)
    expect(filter?.keeps('gpt-6-mini')).toBe(false)
    expect(filter?.reason('gpt-6-mini')).toBe('exclude-hit')
    expect(filter?.reason('claude-5')).toBe('include-miss')
  })

  it('keeps a single group', () => {
    const resolved = resolveConfig(documentWith({ exclude: [{ match: '-free$' }] }))
    expect(resolved.providers[0]?.filter?.keeps('gpt-6')).toBe(true)
    expect(resolved.providers[0]?.filter?.keeps('gpt-6-free')).toBe(false)
  })

  it('rejects an invalid pattern or flag with the filter path', () => {
    expect(() => resolveConfig(documentWith({ include: [{ match: '(' }] }))).toThrow(
      /providers\.gateway\.filter: invalid include entry 0/u,
    )
    expect(() =>
      resolveConfig(documentWith({ exclude: [{ match: '^gpt', flags: 'ii' }] })),
    ).toThrow(/providers\.gateway\.filter: invalid exclude entry 0/u)
  })

  it('rejects empty groups, unknown keys, bad entries, and an empty filter', () => {
    expect(() => resolveConfig(documentWith({ include: [] }))).toThrow(ConfigError)
    expect(() => resolveConfig(documentWith({}))).toThrow(ConfigError)
    expect(() => resolveConfig(documentWith({ keep: [{ match: '^gpt' }] }))).toThrow(ConfigError)
    expect(() => resolveConfig(documentWith({ include: [{ match: '^gpt', name: 'x' }] }))).toThrow(
      ConfigError,
    )
    expect(() => resolveConfig(documentWith({ include: [{ match: '' }] }))).toThrow(ConfigError)
    expect(() => resolveConfig(documentWith({ include: [{ flags: 'i' }] }))).toThrow(ConfigError)
    expect(() => resolveConfig(documentWith({ include: [{ match: 1 }] }))).toThrow(ConfigError)
    expect(() => resolveConfig(documentWith([{ match: '^gpt' }]))).toThrow(ConfigError)
  })

  it('refuses a filter on an account and points at the provider', () => {
    expect(() =>
      resolveConfig({
        providers: {
          gateway: {
            ...catalogProvider,
            accounts: { one: { filter: { exclude: [{ match: '-mini$' }] } } },
          },
        },
      }),
    ).toThrow(/providers\.gateway\.accounts\.one\.filter: .*provider/u)
  })

  it('applies the provider filter to the whole pool', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          ...catalogProvider,
          accounts: { one: { apiKeyEnv: TEST_ENV_KEY }, two: { apiKeyEnv: TEST_ENV_KEY } },
          filter: { include: [{ match: '^gpt-' }] },
        },
      },
    })
    expect(resolved.providers.map((provider) => provider.route)).toEqual(['gateway'])
    expect(resolved.providers[0]?.accounts.map((account) => account.id)).toEqual(['one', 'two'])
    expect(resolved.providers[0]?.filter?.keeps('claude-5')).toBe(false)
  })

  it('accepts a filter on every provider kind', () => {
    const resolved = resolveConfig({
      providers: {
        zai: {
          kind: 'builtin',
          apiKeyEnv: TEST_ENV_KEY,
          filter: { exclude: [{ match: '-thinking$' }] },
        },
        command: {
          kind: 'command-code',
          apiKeyEnv: TEST_ENV_KEY,
          filter: { exclude: [{ match: '-preview$' }] },
        },
      },
    })
    expect(resolved.providers[0]?.filter?.keeps('glm-5-thinking')).toBe(false)
    expect(resolved.providers[1]?.filter?.keeps('glm-5')).toBe(true)
  })

  it('compiles the ChatGPT provider filter', () => {
    const resolved = resolveConfig({
      providers: { chatgpt: { kind: 'chatgpt', filter: { exclude: [{ match: '-mini$' }] } } },
    })
    expect(resolved.chatgpt?.config.filter?.keeps('gpt-5')).toBe(true)
    expect(resolved.chatgpt?.config.filter?.keeps('gpt-5-mini')).toBe(false)
    expect(() =>
      resolveConfig({
        providers: { chatgpt: { kind: 'chatgpt', filter: { include: [{ match: '(' }] } } },
      }),
    ).toThrow(/providers\.chatgpt\.filter: invalid include entry 0/u)
  })

  it('keeps the ChatGPT filter out of the resolved document when absent', () => {
    const resolved = resolveConfig({ providers: { chatgpt: { kind: 'chatgpt' } } })
    expect(resolved.chatgpt?.config).toEqual({})
  })
})

describe('resolveConfig: a disabled provider still validates its filter', () => {
  const catalogProvider = {
    kind: 'custom',
    api: 'openai-responses',
    baseURL: 'https://gateway.invalid/v1',
    modelsURL: 'https://gateway.invalid/v1/models',
    apiKeyEnv: TEST_ENV_KEY,
  }

  it('rejects an invalid filter pattern on a disabled provider', () => {
    expect(() =>
      resolveConfig({
        providers: {
          gateway: { ...catalogProvider, enabled: false, filter: { include: [{ match: '(' }] } },
        },
      }),
    ).toThrow(/providers\.gateway\.filter: invalid include entry 0/u)
  })

  it('rejects an unknown filter key on a disabled provider', () => {
    expect(() =>
      resolveConfig({
        providers: {
          gateway: { ...catalogProvider, enabled: false, filter: { keep: [{ match: '^gpt' }] } },
        },
      }),
    ).toThrow(/providers\.gateway\.filter: unknown key "keep"/u)
  })

  it('resolves a disabled provider to an unregistered pool', () => {
    const resolved = resolveConfig({
      providers: {
        gateway: {
          ...catalogProvider,
          enabled: false,
          filter: { exclude: [{ match: '-mini$' }] },
          accounts: { one: {}, two: {} },
        },
      },
    })
    expect(resolved.providers).toHaveLength(1)
    expect(resolved.providers[0]?.enabled).toBe(false)
    expect(resolved.providers[0]?.accounts.map((account) => account.id)).toEqual(['one', 'two'])
    expect(toProviderSpecs(resolved)).toEqual([])
  })

  it('keeps rejecting an invalid filter on a disabled ChatGPT provider', () => {
    expect(() =>
      resolveConfig({
        providers: {
          chatgpt: { kind: 'chatgpt', enabled: false, filter: { exclude: [{ match: '(' }] } },
        },
      }),
    ).toThrow(/providers\.chatgpt\.filter: invalid exclude entry 0/u)
  })
})
