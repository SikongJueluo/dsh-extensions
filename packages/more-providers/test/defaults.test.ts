/**
 * The root `defaults` section: which parts a provider inherits, how each field merges with the
 * provider's own value, and which provider kinds accept metadata at all.
 * @module dsh-more-providers/test/defaults
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, resolveConfig } from '../src/config.js'
import { buildRoutes } from '../src/providers/registry.js'
import { toProviderSpecs } from '../src/providers/spec.js'
import { combineFilters, compileModelFilter } from '../src/catalog/filter.js'
import type { CustomProviderSpec } from '../src/providers/spec.js'

const ENV = 'MORE_PROVIDERS_DEFAULTS_KEY'

/** The first provider as its custom-kind spec, failing loudly when the fixture changed kind. */
function customSpec(resolved: ReturnType<typeof resolveConfig>, index = 0): CustomProviderSpec {
  const spec = resolved.providers[index]
  if (spec?.kind !== 'custom') throw new Error(`provider ${String(index)} is not a custom spec`)
  return spec
}

function customProvider(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'custom',
    api: 'openai-responses',
    baseURL: 'https://defaults.invalid/v1',
    apiKeyEnv: ENV,
    ...extra,
  }
}

describe('combineFilters: both sides must keep a model', () => {
  const global = compileModelFilter({ exclude: [{ match: '-free$' }] })
  const provider = compileModelFilter({ exclude: [{ match: '-thinking$' }] })

  it('returns the only filter that exists', () => {
    expect(combineFilters(undefined, undefined)).toBeUndefined()
    expect(combineFilters(global, undefined)).toBe(global)
    expect(combineFilters(undefined, provider)).toBe(provider)
  })

  it('keeps a model only when neither side denies it', () => {
    const combined = combineFilters(global, provider)
    expect(combined?.keeps('gpt-6')).toBe(true)
    expect(combined?.keeps('gpt-6-free')).toBe(false)
    expect(combined?.keeps('gpt-6-thinking')).toBe(false)
    expect(combined?.reason('gpt-6-free')).toBe('exclude-hit')
  })

  it('intersects allow lists and reports a miss on either side', () => {
    const combined = combineFilters(
      compileModelFilter({ include: [{ match: '^gpt-' }] }),
      compileModelFilter({ include: [{ match: '-sol$' }] }),
    )
    expect(combined?.keeps('gpt-6-sol')).toBe(true)
    expect(combined?.keeps('gpt-6-astra')).toBe(false)
    expect(combined?.keeps('claude-sol')).toBe(false)
    expect(combined?.reason('claude-sol')).toBe('include-miss')
  })

  it('lets a deny hit win over an allow miss on the other side', () => {
    const combined = combineFilters(
      compileModelFilter({ exclude: [{ match: '-free$' }] }),
      compileModelFilter({ include: [{ match: '^gpt-' }] }),
    )
    expect(combined?.reason('claude-free')).toBe('exclude-hit')
    expect(combined?.reason('claude-sol')).toBe('include-miss')
    expect(combined?.keeps('gpt-6')).toBe(true)
  })

  it('still honours an exclude-only provider against a global allow list', () => {
    const combined = combineFilters(
      compileModelFilter({ include: [{ match: '^gpt-' }] }),
      compileModelFilter({ exclude: [{ match: '-mini$' }] }),
    )
    expect(combined?.keeps('gpt-6')).toBe(true)
    expect(combined?.keeps('gpt-6-mini')).toBe(false)
    expect(combined?.keeps('claude-5')).toBe(false)
  })
})

describe('defaults: modelDefaults merge', () => {
  it('puts provider rules first so they win the same field, and fills the rest', () => {
    const resolved = resolveConfig({
      defaults: {
        modelDefaults: [
          { match: '-sol$', contextWindow: 500000, reasoning: ['low', 'high'] },
          { match: '-astra$', maxTokens: 32000 },
        ],
      },
      providers: {
        mdkj: customProvider({
          models: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.2-astra' }],
          modelDefaults: [{ match: '-sol$', contextWindow: 1000000 }],
        }),
      },
    })
    const rules = customSpec(resolved).modelDefaults ?? []

    expect(rules.map((rule) => rule.pattern.source)).toEqual(['-sol$', '-sol$', '-astra$'])
    expect(rules[0]).toMatchObject({ contextWindow: 1000000 })
    expect(rules[1]).toMatchObject({ contextWindow: 500000, reasoning: ['low', 'high'] })
    expect(rules[2]).toMatchObject({ maxTokens: 32000 })
  })

  it('inherits the global rules alone when the provider declares none', () => {
    const resolved = resolveConfig({
      defaults: { modelDefaults: [{ match: '-sol$', contextWindow: 500000 }] },
      providers: { mdkj: customProvider({ models: [{ id: 'm' }] }) },
    })
    expect(customSpec(resolved).modelDefaults).toHaveLength(1)
  })
})

describe('defaults: contextWindows merge', () => {
  it('lets the provider win for the same model id and inherit the rest', () => {
    const resolved = resolveConfig({
      defaults: { contextWindows: { 'gpt-6.2-sol': 272000, shared: 128000 } },
      providers: {
        mdkj: customProvider({
          models: [{ id: 'm' }],
          contextWindows: { 'gpt-6.2-sol': 500000 },
        }),
      },
    })

    expect(customSpec(resolved).contextWindows).toEqual(
      new Map([
        ['gpt-6.2-sol', 500000],
        ['shared', 128000],
      ]),
    )
  })
})

describe('defaults: filter applies to every provider kind', () => {
  const defaults = { filter: { exclude: [{ match: '-(free|preview)$' }] } }

  it('narrows a custom provider that also declares a filter', () => {
    const resolved = resolveConfig({
      defaults,
      providers: {
        mdkj: customProvider({
          models: [{ id: 'm' }],
          filter: { exclude: [{ match: '-thinking$' }] },
        }),
      },
    })
    const filter = customSpec(resolved).filter

    expect(filter?.keeps('gpt-6')).toBe(true)
    expect(filter?.keeps('gpt-6-free')).toBe(false)
    expect(filter?.keeps('gpt-6-thinking')).toBe(false)
  })

  it('reaches a custom provider that declares no filter of its own', () => {
    const resolved = resolveConfig({
      defaults,
      providers: { mdkj: customProvider({ models: [{ id: 'm' }] }) },
    })
    expect(customSpec(resolved).filter?.keeps('gpt-6-preview')).toBe(false)
    expect(customSpec(resolved).filter?.keeps('gpt-6')).toBe(true)
  })

  it('reaches a builtin provider and leaves its metadata alone', () => {
    const resolved = resolveConfig({
      defaults: {
        ...defaults,
        modelDefaults: [{ match: '.', contextWindow: 1000 }],
        contextWindows: { 'glm-5.3': 1000 },
      },
      providers: {
        zai: { kind: 'builtin', catalog: 'zai-coding-cn', apiKeyEnv: ENV },
      },
    })
    const spec = resolved.providers[0]

    expect(spec?.filter?.keeps('glm-5.3-free')).toBe(false)
    expect(spec?.filter?.keeps('glm-5.3')).toBe(true)
    expect(spec).not.toHaveProperty('modelDefaults')
    expect(spec).not.toHaveProperty('contextWindows')
  })

  it('reaches the ChatGPT provider and leaves its metadata alone', () => {
    const resolved = resolveConfig({
      defaults: {
        ...defaults,
        modelDefaults: [{ match: '.', contextWindow: 1000 }],
        contextWindows: { 'gpt-5': 1000 },
      },
      providers: { chatgpt: { kind: 'chatgpt' } },
    })
    const config = resolved.chatgpt?.config

    expect(config?.filter?.keeps('gpt-5-preview')).toBe(false)
    expect(config?.filter?.keeps('gpt-5')).toBe(true)
    expect(config).not.toHaveProperty('modelDefaults')
    expect(config).not.toHaveProperty('contextWindows')
  })

  it('keeps the provider filter out when there is no global one', () => {
    const resolved = resolveConfig({
      providers: { mdkj: customProvider({ models: [{ id: 'm' }] }) },
    })
    expect(customSpec(resolved).filter).toBeUndefined()
  })
})

describe('defaults: fail-closed validation', () => {
  const providers = { mdkj: customProvider({ models: [{ id: 'm' }] }) }

  it('rejects an invalid global pattern with the defaults path', () => {
    expect(() =>
      resolveConfig({
        defaults: { modelDefaults: [{ match: '(', contextWindow: 1 }] },
        providers,
      }),
    ).toThrow(/defaults\.modelDefaults\[0\]\.match/u)
    expect(() =>
      resolveConfig({ defaults: { filter: { include: [{ match: '(' }] } }, providers }),
    ).toThrow(/defaults\.filter: invalid include entry 0/u)
  })

  it('rejects an unknown key, an empty array and an empty section', () => {
    expect(() =>
      resolveConfig({ defaults: { filter: { keep: [{ match: '.' }] } }, providers }),
    ).toThrow(/defaults\.filter: unknown key "keep"/u)
    expect(() => resolveConfig({ defaults: { modelDefaults: [] }, providers })).toThrow(
      /defaults\.modelDefaults: expected a non-empty array/u,
    )
    expect(() => resolveConfig({ defaults: {}, providers })).toThrow(
      /defaults: set at least one of modelDefaults, contextWindows, filter/u,
    )
  })

  it('rejects a bad context window and an unknown defaults key', () => {
    expect(() => resolveConfig({ defaults: { contextWindows: { m: 0 } }, providers })).toThrow(
      /defaults\.contextWindows\.m: expected a positive integer/u,
    )
    expect(() => resolveConfig({ defaults: { windows: {} }, providers })).toThrow(
      /defaults: unknown key "windows"/u,
    )
  })

  it('stays optional and leaves every provider untouched without it', () => {
    const resolved = resolveConfig({ providers })
    expect(customSpec(resolved)).not.toHaveProperty('modelDefaults')
    expect(customSpec(resolved)).not.toHaveProperty('contextWindows')
    expect(customSpec(resolved)).not.toHaveProperty('filter')
    expect('defaults' in resolved).toBe(false)
  })

  it('rejects the whole document when a defaults value is bad', () => {
    expect(() =>
      resolveConfig({ defaults: { filter: { exclude: [{ match: '' }] } }, providers }),
    ).toThrow(ConfigError)
  })
})

describe('defaults: specs stay the only carrier', () => {
  it('gives every custom provider its own merged view', () => {
    const resolved = resolveConfig({
      defaults: {
        contextWindows: { 'gpt-6': 1000 },
        filter: { exclude: [{ match: '-free$' }] },
      },
      providers: {
        first: customProvider({ models: [{ id: 'gpt-6' }] }),
        second: customProvider({ models: [{ id: 'gpt-6' }], contextWindows: { 'gpt-6': 2000 } }),
      },
    })
    const specs = resolved.providers

    expect(specs.map((spec) => spec.route)).toEqual(['first', 'second'])
    expect(customSpec(resolved, 0).contextWindows?.get('gpt-6')).toBe(1000)
    expect(customSpec(resolved, 1).contextWindows?.get('gpt-6')).toBe(2000)
    for (const spec of specs) expect(spec.filter?.keeps('gpt-6-free')).toBe(false)
  })
})

describe('defaults: the merged view reaches the registered catalog', () => {
  const LOG = { info: () => undefined, warn: () => undefined, error: () => undefined }

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('applies global metadata and the global filter through finalization', async () => {
    vi.stubEnv(ENV, 'defaults-key')
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.2-free' }, { id: 'claude-5' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    const resolved = resolveConfig({
      defaults: {
        contextWindows: { 'claude-5': 200000 },
        modelDefaults: [{ match: '^claude', reasoning: ['low'] }],
        filter: { exclude: [{ match: '-free$' }] },
      },
      providers: {
        mdkj: customProvider({
          modelsURL: 'https://defaults.invalid/v1/models',
          modelDefaults: [{ match: '-sol$', contextWindow: 1000000, maxTokens: 64000 }],
        }),
      },
    })
    const built = await buildRoutes(toProviderSpecs(resolved), LOG)
    const models = built.profiles.get('mdkj')?.piProvider?.getModels() ?? []
    const byId = (id: string) => models.find((model) => model.id === id)

    expect(models.map((model) => model.id)).toEqual(['gpt-6.2-sol', 'claude-5'])
    expect(byId('gpt-6.2-sol')).toMatchObject({ contextWindow: 1000000, maxTokens: 64000 })
    expect(byId('claude-5')).toMatchObject({ contextWindow: 200000, reasoning: true })
    expect(built.reports.get('mdkj')?.models).toEqual({
      discovered: 3,
      effective: 2,
      excluded: ['gpt-6.2-free'],
      notIncluded: [],
    })
  })
})
