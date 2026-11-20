/**
 * Migration contract of the unified provider face: every pre-pool shape is rejected with the
 * replacement spelled out, and the documented shape resolves to one route per provider.
 * @module dsh-more-providers/test/config-migration
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, resolveConfig } from '../src/config.js'
import { toProviderSpecs } from '../src/providers/spec.js'

const ENV = 'MORE_PROVIDERS_MIGRATION_KEY'
const CHATGPT_BASE_URL = 'https://chatgpt.invalid/backend-api/codex'

const POOL_PROVIDER = {
  kind: 'custom',
  api: 'openai-responses',
  baseURL: 'https://mdkj.invalid/v1',
  modelsURL: 'https://mdkj.invalid/v1/models',
  models: [{ id: 'gpt-6.1-sol' }],
  apiKeyEnv: ENV,
}

describe('migration: the removed per-account overrides name their provider-level home', () => {
  const overrides: Record<string, string> = {
    routeId: 'one provider registers one route; set routeId on the provider instead',
    api: 'move it to the provider level; the accounts of a pool share the connection',
    baseURL: 'move it to the provider level; the accounts of a pool share the connection',
    modelsURL: 'move it to the provider level; the accounts of a pool share the model catalog',
    models: 'move it to the provider level; the accounts of a pool share the model catalog',
    contextWindows: 'move it to the provider level; the accounts of a pool share the metadata',
    compat: 'move it to the provider level; the accounts of a pool share the wire compatibility',
    headers: 'move it to the provider level; the accounts of a pool share the request headers',
    zdr: 'move it to the provider level; the accounts of a pool share the ZDR setting',
  }

  for (const [field, hint] of Object.entries(overrides)) {
    it(`rejects an account-level ${field}`, () => {
      expect(() =>
        resolveConfig({
          providers: {
            mdkj: {
              ...POOL_PROVIDER,
              accounts: { stable: { [field]: placeholder(field) } },
            },
          },
        }),
      ).toThrow(new RegExp(`providers\\.mdkj\\.accounts\\.stable\\.${field}: ${hint}`, 'u'))
    })
  }
})

/** One plausible old value per removed field, so the rejection fires on presence alone. */
function placeholder(field: string): unknown {
  switch (field) {
    case 'routeId':
      return 'mdkj-stable'
    case 'api':
      return 'openai-completions'
    case 'baseURL':
    case 'modelsURL':
      return 'https://mdkj.invalid/v1'
    case 'models':
      return [{ id: 'gpt-6.1-sol' }]
    case 'contextWindows':
      return { 'gpt-6.1-sol': 1000 }
    case 'compat':
    case 'headers':
      return {}
    default:
      return true
  }
}

describe('migration: account-level attachment points point at the provider', () => {
  it('rejects a filter on an account', () => {
    expect(() =>
      resolveConfig({
        providers: {
          mdkj: {
            ...POOL_PROVIDER,
            accounts: { stable: { filter: { exclude: [{ match: '-mini$' }] } } },
          },
        },
      }),
    ).toThrow(/providers\.mdkj\.accounts\.stable\.filter: is not supported on an account/u)
  })

  it('rejects a filter written inside a model entry', () => {
    expect(() =>
      resolveConfig({
        providers: {
          mdkj: { ...POOL_PROVIDER, models: [{ id: 'gpt-6.1-sol', filter: { exclude: [] } }] },
        },
      }),
    ).toThrow(
      /providers\.mdkj\.models\[0\]\.filter: is not supported here; set filter on the provider/u,
    )
  })
})

describe('migration: the ChatGPT section is a provider instance', () => {
  it('rejects the old special section that has no kind', () => {
    expect(() => resolveConfig({ providers: { chatgpt: { baseURL: CHATGPT_BASE_URL } } })).toThrow(
      /providers\.chatgpt\.kind: is required: the ChatGPT section is now a provider instance/u,
    )
  })

  it('rejects an API key, an account pool and a fixed route id on ChatGPT', () => {
    expect(() =>
      resolveConfig({ providers: { chatgpt: { kind: 'chatgpt', apiKeyEnv: ENV } } }),
    ).toThrow(/providers\.chatgpt\.apiKeyEnv: the chatgpt provider signs in through OAuth/u)
    expect(() =>
      resolveConfig({ providers: { chatgpt: { kind: 'chatgpt', accounts: { one: {} } } } }),
    ).toThrow(/providers\.chatgpt\.accounts: the chatgpt provider holds a single OAuth account/u)
    expect(() =>
      resolveConfig({ providers: { chatgpt: { kind: 'chatgpt', routeId: 'chatgpt-work' } } }),
    ).toThrow(/providers\.chatgpt\.routeId: the chatgpt route id is fixed/u)
  })

  it('keeps kind chatgpt on the reserved provider id alone', () => {
    expect(() =>
      resolveConfig({
        providers: { 'chatgpt-work': { kind: 'chatgpt', baseURL: CHATGPT_BASE_URL } },
      }),
    ).toThrow(/providers\.chatgpt-work\.kind: only the reserved provider id "chatgpt"/u)
  })
})

describe('migration: the documented shape resolves', () => {
  it('resolves one pooled route plus the ChatGPT instance', () => {
    const resolved = resolveConfig({
      providers: {
        mdkj: {
          ...POOL_PROVIDER,
          displayName: 'MDKJ',
          filter: { exclude: [{ match: '-mini$' }] },
          accounts: {
            stable: { displayName: 'MDKJ Stable', secretName: 'mdkj-stable-key' },
            cheap: { displayName: 'MDKJ Cheap', secretName: 'mdkj-cheap-key' },
          },
        },
        chatgpt: {
          kind: 'chatgpt',
          baseURL: CHATGPT_BASE_URL,
          refreshMarginMs: 86400000,
          defaultContextWindow: 272000,
          promptCacheKey: true,
          filter: { exclude: [{ match: '-mini$' }] },
        },
      },
    })

    expect(resolved.providers.map((provider) => provider.route)).toEqual(['mdkj'])
    expect(resolved.providers[0]?.accounts.map((account) => account.id)).toEqual([
      'stable',
      'cheap',
    ])
    const { filter, ...connection } = resolved.chatgpt?.config ?? {}
    expect(connection).toEqual({
      baseURL: CHATGPT_BASE_URL,
      refreshMarginMs: 86400000,
      defaultContextWindow: 272000,
      promptCacheKey: true,
    })
    expect(filter?.keeps('gpt-5')).toBe(true)
    expect(filter?.keeps('gpt-5-mini')).toBe(false)
    expect(toProviderSpecs(resolved).map((spec) => [spec.route, spec.kind])).toEqual([
      ['mdkj', 'custom'],
      ['chatgpt', 'chatgpt'],
    ])
  })

  it('keeps every provider kind addressable through one shape', () => {
    const resolved = resolveConfig({
      providers: {
        zai: { kind: 'builtin', secretName: 'zai-key', filter: { exclude: [{ match: '-free$' }] } },
        'command-code': { kind: 'command-code', secretName: 'cc-key' },
        chatgpt: { kind: 'chatgpt' },
      },
    })

    expect(toProviderSpecs(resolved).map((spec) => [spec.route, spec.kind])).toEqual([
      ['zai', 'builtin'],
      ['command-code', 'command-code'],
      ['chatgpt', 'chatgpt'],
    ])
  })

  it('rejects a document that would register two providers as one route', () => {
    expect(() =>
      resolveConfig({
        providers: {
          first: { ...POOL_PROVIDER, routeId: 'shared' },
          second: { ...POOL_PROVIDER, routeId: 'shared' },
        },
      }),
    ).toThrow(new ConfigError('providers.second: duplicate route id "shared"'))
  })
})
