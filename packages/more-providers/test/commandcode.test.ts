/**
 * Command Code catalogs: the ordinary `/models` list owns the model set and its
 * fields, while the fixed client view only fills context length and exact
 * thinking levels. Capability failures degrade field by field.
 * @module dsh-more-providers/test/command-code
 */
import type { Api, Model } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCodeCapability, CommandCodeCatalogItem } from '../src/commandcode.js'
import {
  DEFAULT_CAPABILITIES_URL,
  DEFAULT_MODELS_URL,
  mergeCapabilities,
  parseCapabilities,
  toPiModels,
} from '../src/commandcode.js'
import { resolveConfig } from '../src/config.js'
import { buildRoutes } from '../src/providers/registry.js'
import { toProviderSpecs } from '../src/providers/spec.js'

const ENV_KEY = 'MORE_PROVIDERS_COMMAND_CODE_TEST_KEY'
const LOG = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubRoutes(routes: Readonly<Record<string, () => Response>>): string[] {
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url)
    const route = routes[url]
    return route === undefined ? response({ error: 'unexpected url' }, 404) : route()
  })
  return urls
}

function catalogItem(
  id: string,
  extra: Partial<CommandCodeCatalogItem> = {},
): CommandCodeCatalogItem {
  return { id, supported_endpoints: ['/messages'], ...extra }
}

function byId(models: readonly Model<Api>[], id: string): Model<Api> | undefined {
  return models.find((model) => model.id === id)
}

async function commandCodeModels(
  extra: Record<string, unknown> = {},
): Promise<readonly Model<Api>[]> {
  vi.stubEnv(ENV_KEY, 'test-key')
  const resolved = resolveConfig({
    providers: {
      command: { kind: 'command-code', apiKeyEnv: ENV_KEY, ...extra },
    },
  })
  const { profiles } = await buildRoutes(toProviderSpecs(resolved), LOG)
  return profiles.get('command')?.piProvider?.getModels() ?? []
}

describe('parseCapabilities', () => {
  it('requires schema version 1 with a data array', () => {
    expect(() => parseCapabilities({ data: [] })).toThrow(TypeError)
    expect(() => parseCapabilities({ schemaVersion: 2, data: [] })).toThrow(TypeError)
    expect(() => parseCapabilities({ schemaVersion: 1 })).toThrow(TypeError)
  })

  it('drops malformed rows and fields but keeps valid ones', () => {
    const capabilities = parseCapabilities({
      schemaVersion: 1,
      data: [
        { id: 'valid', context_length: 1000, reasoningEfforts: ['low', 'max'] },
        { id: 'nulls', context_length: null, reasoningEfforts: null },
        { id: 'bad-context', context_length: 'nope' },
        { id: 'bad-efforts', reasoningEfforts: ['low', 'turbo'] },
        { id: 'empty', context_length: 0, reasoningEfforts: [] },
        { id: '', context_length: 1 },
        null,
      ],
    })

    expect([...capabilities]).toEqual([
      ['valid', { contextWindow: 1000, reasoningLevels: ['low', 'max'] }],
    ])
  })

  it('merges duplicate rows field by field with later rows winning', () => {
    const capabilities = parseCapabilities({
      schemaVersion: 1,
      data: [
        { id: 'model', context_length: 1000, reasoningEfforts: ['low'] },
        { id: 'model', context_length: 2000 },
      ],
    })

    expect(capabilities.get('model')).toEqual({
      contextWindow: 2000,
      reasoningLevels: ['low'],
    })
  })
})

describe('mergeCapabilities', () => {
  it('fills only missing fields and never adds models', () => {
    const items = [
      catalogItem('keeps-normal', { context_length: 400000 }),
      catalogItem('fills-context'),
      catalogItem('no-reasoning', { reasoning: false }),
      catalogItem('levels', { reasoning: true }),
      catalogItem('plain'),
    ]
    const capabilities = new Map<string, CommandCodeCapability>([
      ['keeps-normal', { contextWindow: 1000000, reasoningLevels: ['low'] }],
      ['fills-context', { contextWindow: 200000 }],
      ['no-reasoning', { reasoningLevels: ['low'] }],
      ['levels', { reasoningLevels: ['low', 'max'] }],
      ['hidden', { contextWindow: 999999, reasoningLevels: ['high'] }],
    ])

    const merged = mergeCapabilities(items, capabilities)

    expect(merged.map((item) => item.id)).toEqual(items.map((item) => item.id))
    expect(merged[0]).toMatchObject({ context_length: 400000, reasoningLevels: ['low'] })
    expect(merged[1]).toMatchObject({ context_length: 200000 })
    expect(merged[2]?.reasoningLevels).toBeUndefined()
    expect(merged[3]?.reasoningLevels).toEqual(['low', 'max'])
    expect(merged[4]).toEqual(items[4])
  })

  it('keeps ordinary reasoning levels ahead of the client view', () => {
    const items = [catalogItem('normal-levels', { reasoningLevels: ['low'] })]
    const capabilities = new Map<string, CommandCodeCapability>([
      ['normal-levels', { reasoningLevels: ['max'] }],
    ])

    const merged = mergeCapabilities(items, capabilities)

    expect(merged[0]?.reasoningLevels).toEqual(['low'])
    const models = toPiModels(merged, {
      baseURL: 'https://api.commandcode.ai/provider',
      provider: 'command-code',
    })
    expect(byId(models, 'normal-levels')?.thinkingLevelMap).toMatchObject({
      low: 'low',
      max: null,
    })
  })

  it('drops invalid ordinary context windows so the fallback applies', () => {
    const items = [
      catalogItem('null-context', { context_length: null as unknown as number }),
      catalogItem('null-both', { context_length: null as unknown as number }),
    ]
    const capabilities = new Map<string, CommandCodeCapability>([
      ['null-context', { contextWindow: 500000 }],
      ['null-both', {}],
    ])

    const merged = mergeCapabilities(items, capabilities)

    expect(merged[0]?.context_length).toBe(500000)
    expect(merged[1]?.context_length).toBeUndefined()
    const models = toPiModels(merged, {
      baseURL: 'https://api.commandcode.ai/provider',
      provider: 'command-code',
    })
    expect(byId(models, 'null-context')?.contextWindow).toBe(500000)
    expect(byId(models, 'null-both')?.contextWindow).toBe(131072)
  })
})

describe('toPiModels reasoning', () => {
  const options = { baseURL: 'https://api.commandcode.ai/provider', provider: 'command-code' }

  it('maps exact levels and keeps off as the absence of an effort', () => {
    const models = toPiModels(
      mergeCapabilities(
        [catalogItem('levels'), catalogItem('off-levels'), catalogItem('none')],
        new Map<string, CommandCodeCapability>([
          ['levels', { reasoningLevels: ['low', 'max'] }],
          ['off-levels', { reasoningLevels: ['off', 'high'] }],
        ]),
      ),
      options,
    )

    expect(byId(models, 'levels')?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: null,
      xhigh: null,
      max: 'max',
    })
    expect(byId(models, 'off-levels')?.thinkingLevelMap).toEqual({
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    })
    expect(byId(models, 'off-levels')?.thinkingLevelMap?.off).toBeUndefined()
    expect(byId(models, 'none')?.reasoning).toBe(true)
    expect(byId(models, 'none')?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    })
  })

  it('turns reasoning off when the ordinary catalog says false', () => {
    const models = toPiModels(
      mergeCapabilities(
        [catalogItem('plain', { reasoning: false })],
        new Map<string, CommandCodeCapability>([['plain', { reasoningLevels: ['low'] }]]),
      ),
      options,
    )

    expect(models[0]?.reasoning).toBe(false)
    expect(models[0]?.thinkingLevelMap).toBeUndefined()
  })
})

describe('Command Code provider catalogs', () => {
  it('requests the fixed client view after the ordinary catalog and merges by id', async () => {
    const urls = stubRoutes({
      [DEFAULT_MODELS_URL]: () =>
        response({
          data: [
            { id: 'claude-sonnet-5', context_length: 1000000, supported_endpoints: ['/messages'] },
            { id: 'gpt-6', supported_endpoints: ['/responses'] },
            { id: 'plain', reasoning: false, supported_endpoints: ['/messages'] },
          ],
        }),
      [DEFAULT_CAPABILITIES_URL]: () =>
        response({
          schemaVersion: 1,
          data: [
            { id: 'claude-sonnet-5', context_length: 1, reasoningEfforts: ['low'] },
            { id: 'gpt-6', context_length: 400000, reasoningEfforts: ['off', 'low', 'max'] },
            { id: 'plain', reasoningEfforts: ['high'] },
            { id: 'hidden-free', context_length: 999999, reasoningEfforts: ['high'] },
          ],
        }),
    })

    const models = await commandCodeModels()

    expect(urls).toEqual([DEFAULT_MODELS_URL, DEFAULT_CAPABILITIES_URL])
    expect(models.map((model) => model.id)).toEqual(['claude-sonnet-5', 'gpt-6', 'plain'])
    expect(byId(models, 'claude-sonnet-5')?.contextWindow).toBe(1000000)
    expect(byId(models, 'claude-sonnet-5')?.thinkingLevelMap).toMatchObject({ low: 'low' })
    expect(byId(models, 'gpt-6')?.contextWindow).toBe(400000)
    expect(byId(models, 'gpt-6')?.thinkingLevelMap).toMatchObject({
      low: 'low',
      max: 'max',
      medium: null,
    })
    expect(byId(models, 'plain')?.reasoning).toBe(false)
  })

  it('uses the fixed client view even when modelsURL points elsewhere', async () => {
    const mirror = 'https://mirror.invalid/v1/models'
    const urls = stubRoutes({
      [mirror]: () => response({ data: [{ id: 'm', supported_endpoints: ['/messages'] }] }),
      [DEFAULT_CAPABILITIES_URL]: () => response({ schemaVersion: 1, data: [] }),
    })

    const models = await commandCodeModels({ modelsURL: mirror })

    expect(urls).toEqual([mirror, DEFAULT_CAPABILITIES_URL])
    expect(models.map((model) => model.id)).toEqual(['m'])
  })

  it('keeps the ordinary catalog when the client view fails', async () => {
    stubRoutes({
      [DEFAULT_MODELS_URL]: () =>
        response({
          data: [
            { id: 'with-context', context_length: 200000, supported_endpoints: ['/messages'] },
            { id: 'no-context', supported_endpoints: ['/messages'] },
          ],
        }),
      [DEFAULT_CAPABILITIES_URL]: () => response({ error: 'down' }, 503),
    })

    const models = await commandCodeModels()

    expect(byId(models, 'with-context')?.contextWindow).toBe(200000)
    expect(byId(models, 'no-context')).toMatchObject({ contextWindow: 131072, reasoning: true })
    expect(byId(models, 'no-context')?.thinkingLevelMap).toMatchObject({
      low: 'low',
      medium: 'medium',
      high: 'high',
    })
  })

  it('keeps the ordinary catalog when the client view schema is unsupported', async () => {
    stubRoutes({
      [DEFAULT_MODELS_URL]: () =>
        response({ data: [{ id: 'm', supported_endpoints: ['/messages'] }] }),
      [DEFAULT_CAPABILITIES_URL]: () =>
        response({ schemaVersion: 2, data: [{ id: 'm', reasoningEfforts: ['low'] }] }),
    })

    const models = await commandCodeModels()

    expect(models).toHaveLength(1)
    expect(models[0]?.thinkingLevelMap).toMatchObject({
      low: 'low',
      medium: 'medium',
      high: 'high',
    })
  })

  it('falls back to 131072 when both catalogs report a null context', async () => {
    stubRoutes({
      [DEFAULT_MODELS_URL]: () =>
        response({
          data: [{ id: 'm', context_length: null, supported_endpoints: ['/messages'] }],
        }),
      [DEFAULT_CAPABILITIES_URL]: () =>
        response({ schemaVersion: 1, data: [{ id: 'm', context_length: null }] }),
    })

    const models = await commandCodeModels()

    expect(models[0]?.contextWindow).toBe(131072)
  })

  it('records a directory fetch failure as both error and catalogError', async () => {
    stubRoutes({ [DEFAULT_MODELS_URL]: () => response({ error: 'down' }, 503) })
    vi.stubEnv(ENV_KEY, 'test-key')
    const resolved = resolveConfig({
      providers: { command: { kind: 'command-code', apiKeyEnv: ENV_KEY } },
    })

    const { profiles, reports } = await buildRoutes(toProviderSpecs(resolved), LOG)

    expect(profiles.has('command')).toBe(false)
    const report = reports.get('command')
    expect(report).not.toHaveProperty('models')
    expect(report).toMatchObject({
      registered: false,
      error: 'Command Code /models returned 503',
      catalogError: 'Command Code /models returned 503',
    })
  })

  it('reports a route with no usable models as unregistered', async () => {
    stubRoutes({
      [DEFAULT_MODELS_URL]: () =>
        response({ data: [{ id: 'embed', supported_endpoints: ['/embeddings'] }] }),
      [DEFAULT_CAPABILITIES_URL]: () => response({ schemaVersion: 1, data: [] }),
    })
    vi.stubEnv(ENV_KEY, 'test-key')
    const resolved = resolveConfig({
      providers: { command: { kind: 'command-code', apiKeyEnv: ENV_KEY } },
    })

    const { profiles, reports } = await buildRoutes(toProviderSpecs(resolved), LOG)

    expect(profiles.has('command')).toBe(false)
    expect(reports.get('command')).toMatchObject({
      registered: false,
      models: { discovered: 0, effective: 0 },
      error: 'the model catalog listed no usable models',
    })
  })

  it('keeps ordinary reasoning levels ahead of the client view', async () => {
    stubRoutes({
      [DEFAULT_MODELS_URL]: () =>
        response({
          data: [{ id: 'm', reasoningLevels: ['low'], supported_endpoints: ['/messages'] }],
        }),
      [DEFAULT_CAPABILITIES_URL]: () =>
        response({ schemaVersion: 1, data: [{ id: 'm', reasoningEfforts: ['max'] }] }),
    })

    const models = await commandCodeModels()

    expect(models[0]?.thinkingLevelMap).toMatchObject({ low: 'low', max: null })
  })
})
