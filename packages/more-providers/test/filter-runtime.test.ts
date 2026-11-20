/**
 * Runtime hard-delete regression: the host `LlmRuntime` never sees filtered models, so the
 * model list, `resolveModelInfo` and request paths stay in agreement across refactors.
 * @module dsh-more-providers/test/filter-runtime
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, apply } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import { buildRoutes } from '../src/providers/registry.js'
import { toProviderSpecs, type ProviderSpec } from '../src/providers/spec.js'

const ENV_KEY = 'MORE_PROVIDERS_FILTER_RUNTIME_KEY'
const API_KEY = 'runtime-key'
const LOG = { info: () => undefined, warn: () => undefined, error: () => undefined }

const CUSTOM_MODELS = [
  { id: 'gpt-6' },
  { id: 'gpt-6-mini' },
  { id: 'claude-5' },
  { id: 'claude-5-free' },
]

const COMMAND_MODELS = [
  { id: 'cc-alpha', supported_endpoints: ['/responses'] },
  { id: 'cc-beta', supported_endpoints: ['/responses'] },
  { id: 'cc-gamma', supported_endpoints: ['/responses'] },
  { id: 'cc-preview', supported_endpoints: ['/responses'] },
]

const CUSTOM_PROVIDER = {
  kind: 'custom',
  api: 'openai-responses',
  baseURL: 'https://runtime.invalid/v1',
  apiKeyEnv: ENV_KEY,
  models: CUSTOM_MODELS,
}

const providers = {
  gateway: {
    ...CUSTOM_PROVIDER,
    filter: { include: [{ match: '^gpt-' }], exclude: [{ match: '-mini$' }] },
  },
  full: CUSTOM_PROVIDER,
  empty: { ...CUSTOM_PROVIDER, filter: { exclude: [{ match: '.*' }] } },
  'zai-alias': {
    kind: 'builtin',
    catalog: 'zai-coding-cn',
    apiKeyEnv: ENV_KEY,
  },
  'zai-coding-cn': {
    kind: 'builtin',
    catalog: 'zai-coding-cn',
    apiKeyEnv: ENV_KEY,
    filter: {
      include: [{ match: '^glm-5\\.3($|-)' }],
      exclude: [{ match: '-flash$' }],
    },
  },
  command: {
    kind: 'command-code',
    apiKeyEnv: ENV_KEY,
    filter: {
      include: [{ match: '^cc-(alpha|beta)$' }],
      exclude: [{ match: '-preview$' }],
    },
  },
  chatgpt: { kind: 'chatgpt', enabled: false },
}

const contexts: Context[] = []
const directories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) {
    expect(directory.startsWith(join(tmpdir(), 'more-providers-filter-runtime-'))).toBe(true)
    await rm(directory, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

interface Mounted {
  ctx: Context
  llm: LlmRuntime
  specs: ProviderSpec[]
}

/** Mount the real plugin over the host LLM service with only the Command Code catalog stubbed. */
async function mount(): Promise<Mounted> {
  vi.stubEnv(ENV_KEY, API_KEY)
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes('view=client') ? { schemaVersion: 1, data: [] } : { data: COMMAND_MODELS },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  )
  const directory = await mkdtemp(join(tmpdir(), 'more-providers-filter-runtime-'))
  directories.push(directory)
  const configFile = join(directory, 'more-providers.json')
  await writeFile(configFile, JSON.stringify({ providers }))
  const ctx = new Context()
  contexts.push(ctx)
  const llm = new LlmRuntime(ctx)
  await apply(ctx, Config({ configFile }))
  return { ctx, llm, specs: toProviderSpecs(resolveConfig({ providers })) }
}

function providerKeysOf(ctx: Context): { key(route: string): string | undefined } {
  return ctx.get('providerKeys') as { key(route: string): string | undefined }
}

/** The failure code `resolveModelInfo` raises, or `resolved` when it succeeds. */
async function lookup(llm: LlmRuntime, route: string, model: string): Promise<string | undefined> {
  try {
    await llm.resolveModelInfo(route, model)
    return undefined
  } catch (error) {
    return error instanceof LlmError ? error.code : `not-an-llm-error:${String(error)}`
  }
}

describe('filtered models are unknown to the host LLM runtime', () => {
  it('drops custom catalog models from both the list and the lookup', async () => {
    const { ctx, llm } = await mount()

    expect((await llm.listModels('gateway')).map((model) => model.id)).toEqual(['gpt-6'])
    expect((await llm.resolveModelInfo('gateway', 'gpt-6')).id).toBe('gpt-6')
    expect(await lookup(llm, 'gateway', 'gpt-6-mini')).toBe('UNKNOWN_MODEL')
    expect(await lookup(llm, 'gateway', 'claude-5')).toBe('UNKNOWN_MODEL')
    expect(providerKeysOf(ctx).key('gateway')).toBe(API_KEY)
  })

  it('drops builtin catalog models from both the list and the lookup', async () => {
    const { ctx, llm } = await mount()

    expect((await llm.listModels('zai-coding-cn')).map((model) => model.id)).toEqual([
      'glm-5.3',
      'glm-5.3-highspeed',
    ])
    expect((await llm.resolveModelInfo('zai-coding-cn', 'glm-5.3')).id).toBe('glm-5.3')
    expect(await lookup(llm, 'zai-coding-cn', 'glm-5.3-flash')).toBe('UNKNOWN_MODEL')
    expect(await lookup(llm, 'zai-coding-cn', 'glm-4.6v')).toBe('UNKNOWN_MODEL')
    expect(providerKeysOf(ctx).key('zai-coding-cn')).toBe(API_KEY)
  })

  it('serves a builtin catalog under a route id that differs from the catalog id', async () => {
    const { ctx, llm } = await mount()

    const models = await llm.listModels('zai-alias')
    expect(models.length).toBeGreaterThan(0)
    expect(models.map((model) => model.provider)).toEqual(models.map(() => 'zai-alias'))
    expect((await llm.resolveModelInfo('zai-alias', 'glm-5.3')).id).toBe('glm-5.3')
    expect(providerKeysOf(ctx).key('zai-alias')).toBe(API_KEY)
  })

  it('drops command-code catalog models from both the list and the lookup', async () => {
    const { ctx, llm } = await mount()

    expect((await llm.listModels('command')).map((model) => model.id)).toEqual([
      'cc-alpha',
      'cc-beta',
    ])
    expect((await llm.resolveModelInfo('command', 'cc-alpha')).id).toBe('cc-alpha')
    expect(await lookup(llm, 'command', 'cc-preview')).toBe('UNKNOWN_MODEL')
    expect(await lookup(llm, 'command', 'cc-gamma')).toBe('UNKNOWN_MODEL')
    expect(providerKeysOf(ctx).key('command')).toBe(API_KEY)
  })

  it('omits a filtered-empty route and its key source', async () => {
    const { ctx, llm } = await mount()

    expect(llm.listProviders().map((provider) => provider.id)).toEqual([
      'gateway',
      'full',
      'zai-alias',
      'zai-coding-cn',
      'command',
    ])
    expect(providerKeysOf(ctx).key('empty')).toBeUndefined()
  })

  it('keeps an unfiltered route at the effective count the build report states', async () => {
    const { llm, specs } = await mount()
    const built = await buildRoutes(specs, LOG)

    const models = await llm.listModels('full')
    expect(models.map((model) => model.id)).toEqual([
      'gpt-6',
      'gpt-6-mini',
      'claude-5',
      'claude-5-free',
    ])
    expect(models.length).toBe(built.reports.get('full')?.models?.effective)
  })
})
