/**
 * `modelDefaults` precedence per field: catalog value, then the first matching rule
 * that sets it, then the static model and the `contextWindows` map. Rules apply only
 * when the catalog supplied the model list.
 * @module dsh-more-providers/test/model-defaults
 */
import type { Api, Model } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { buildRoutes } from '../src/providers/registry.js'
import { toProviderSpecs } from '../src/providers/spec.js'

const ENV_KEY = 'MORE_PROVIDERS_MODEL_DEFAULTS_TEST_KEY'
const MODELS_URL = 'https://gateway.invalid/v1/models'
const LOG = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function stubCatalog(data: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

async function modelsOf(config: Record<string, unknown>): Promise<readonly Model<Api>[]> {
  vi.stubEnv(ENV_KEY, 'test-key')
  const resolved = resolveConfig({ providers: { gateway: config } })
  const { profiles } = await buildRoutes(toProviderSpecs(resolved), LOG)
  return profiles.get('gateway')?.piProvider?.getModels() ?? []
}

function gateway(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'custom',
    api: 'openai-responses',
    baseURL: 'https://gateway.invalid/v1',
    modelsURL: MODELS_URL,
    apiKeyEnv: ENV_KEY,
    ...extra,
  }
}

function byId(models: readonly Model<Api>[], id: string): Model<Api> | undefined {
  return models.find((model) => model.id === id)
}

describe('model defaults', () => {
  it('applies the first matching rule per field to catalog models', async () => {
    stubCatalog([{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.2-astra' }, { id: 'other' }])
    const models = await modelsOf(
      gateway({
        modelDefaults: [
          { match: '^gpt-6', contextWindow: 272000 },
          { match: 'astra$', contextWindow: 111111, maxTokens: 64000, reasoning: ['low', 'high'] },
        ],
      }),
    )

    expect(byId(models, 'gpt-6.2-sol')?.contextWindow).toBe(272000)
    expect(byId(models, 'gpt-6.2-sol')?.maxTokens).toBe(32768)
    expect(byId(models, 'gpt-6.2-astra')).toMatchObject({ contextWindow: 272000, maxTokens: 64000 })
    expect(byId(models, 'gpt-6.2-astra')?.thinkingLevelMap).toMatchObject({
      low: 'low',
      medium: null,
    })
    expect(byId(models, 'other')?.contextWindow).toBe(131072)
  })

  it('keeps catalog metadata ahead of rules and fills what the catalog omits', async () => {
    stubCatalog([{ id: 'gpt-6.2-sol', context_length: 400000 }, { id: 'gpt-6.2-astra' }])
    const models = await modelsOf(
      gateway({
        modelDefaults: [{ match: '^gpt-6', contextWindow: 272000, maxTokens: 64000 }],
      }),
    )

    expect(byId(models, 'gpt-6.2-sol')).toMatchObject({ contextWindow: 400000, maxTokens: 64000 })
    expect(byId(models, 'gpt-6.2-astra')).toMatchObject({ contextWindow: 272000, maxTokens: 64000 })
  })

  it('adopts reasoning reported by the catalog ahead of rules', async () => {
    stubCatalog([
      { id: 'gpt-off', reasoning: false },
      { id: 'gpt-levels', reasoning: ['low', 'high'] },
      { id: 'gpt-unknown-shape', reasoning: true },
    ])
    const models = await modelsOf(
      gateway({ modelDefaults: [{ match: '^gpt', reasoning: ['medium'] }] }),
    )

    expect(byId(models, 'gpt-off')?.reasoning).toBe(false)
    expect(byId(models, 'gpt-levels')?.thinkingLevelMap).toMatchObject({ low: 'low', high: 'high' })
    expect(byId(models, 'gpt-levels')?.thinkingLevelMap?.medium).toBeNull()
    expect(byId(models, 'gpt-unknown-shape')?.thinkingLevelMap).toMatchObject({ medium: 'medium' })
  })

  it('puts rules ahead of static metadata and the context window map', async () => {
    stubCatalog([{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.2-astra' }])
    const models = await modelsOf(
      gateway({
        models: [
          { id: 'gpt-6.2-sol', contextWindow: 100000, reasoning: false },
          { id: 'gpt-6.2-astra' },
        ],
        contextWindows: { 'gpt-6.2-sol': 200000, 'gpt-6.2-astra': 200000 },
        modelDefaults: [{ match: 'sol$', contextWindow: 272000, reasoning: ['high'] }],
      }),
    )

    expect(byId(models, 'gpt-6.2-sol')).toMatchObject({ contextWindow: 272000, reasoning: true })
    expect(byId(models, 'gpt-6.2-astra')).toMatchObject({ contextWindow: 200000, reasoning: true })
  })

  it('ignores rules when no catalog model exists', async () => {
    const models = await modelsOf({
      kind: 'custom',
      api: 'openai-responses',
      baseURL: 'https://gateway.invalid/v1',
      apiKeyEnv: ENV_KEY,
      models: [{ id: 'gpt-6.2-sol' }],
      modelDefaults: [{ match: '^gpt-6', contextWindow: 272000 }],
    })

    expect(byId(models, 'gpt-6.2-sol')).toMatchObject({ contextWindow: 131072, maxTokens: 32768 })
  })

  it('honors flags and stays case-sensitive without them', async () => {
    stubCatalog([{ id: 'GPT-6.2-SOL' }, { id: 'gpt-6.2-astra' }])
    const models = await modelsOf(
      gateway({
        modelDefaults: [
          { match: '^gpt-6', contextWindow: 111111 },
          { match: '^gpt-6', flags: 'i', maxTokens: 64000 },
        ],
      }),
    )

    expect(byId(models, 'GPT-6.2-SOL')).toMatchObject({ contextWindow: 131072, maxTokens: 64000 })
    expect(byId(models, 'gpt-6.2-astra')).toMatchObject({ contextWindow: 111111, maxTokens: 64000 })
  })

  it('does not leak global-flag state between models', async () => {
    stubCatalog([{ id: 'gpt-6.2-sol' }, { id: 'gpt-6.2-astra' }])
    const models = await modelsOf(
      gateway({ modelDefaults: [{ match: 'gpt', flags: 'g', contextWindow: 272000 }] }),
    )

    expect(byId(models, 'gpt-6.2-sol')?.contextWindow).toBe(272000)
    expect(byId(models, 'gpt-6.2-astra')?.contextWindow).toBe(272000)
  })
})
