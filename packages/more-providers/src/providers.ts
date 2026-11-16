/**
 * Materialize the resolved YAML providers into pi-ai providers and
 * `PiAiAdapter` profiles. Catalog (`builtin`) routes inherit pi-ai's models;
 * `custom` routes discover `/models` or use the configured fallback;
 * `command-code` keeps its mixed-protocol catalog.
 *
 * @module dsh-more-providers/providers
 */
import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from '@earendil-works/pi-ai/compat'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ModelConfig, ResolvedProvider } from './config.js'
import { ConfigError } from './config.js'
import {
  DEFAULT_BASE_URL as COMMAND_CODE_BASE_URL,
  DEFAULT_MODELS_URL as COMMAND_CODE_MODELS_URL,
  ZDR_HEADER,
  buildCommandCodeProvider,
  fetchCatalog,
} from './commandcode.js'
import type { KeySource } from './keys.js'
import { readKey } from './keys.js'
import { isRecord } from './record.js'

const FALLBACK_CONTEXT_WINDOW = 131_072
const FALLBACK_MAX_TOKENS = 32_768
const MODELS_TIMEOUT_MS = 10_000
const ALL_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const DEFAULT_THINKING_LEVELS = ['low', 'medium', 'high']

/** dsh-llm's default normal-mode retry policy for one provider route. */
const DEFAULT_RETRY_POLICY = {
  mode: 'normal' as const,
  maxRetries: 5,
  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
}

/** Credential plumbing PiAiAdapter requires even when every request carries an apiKey. */
const AUTH: PiAiAdapterOptions['auth'] = {
  credentials: {
    read: async () => undefined,
    list: async () => [],
    modify: async () => undefined,
    delete: async () => {},
  },
  authContext: {
    env: async (name) => process.env[name],
    fileExists: async () => false,
  },
}

/** Minimal logger surface used during startup. */
export interface ProviderLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Result of one provider build before it becomes an adapter profile. */
interface BuiltProvider {
  provider: Provider
  models: Model<Api>[]
  headers?: Record<string, string>
  displayName?: string
}

/** Routes and key sources that survived a successful build. */
export interface BuildResult {
  profiles: Map<string, ResolvedPiAiProviderProfile>
  keys: Map<string, KeySource>
}

function reasoningOf(model: ModelConfig): {
  reasoning: boolean
  thinkingLevelMap?: Record<string, string | null>
} {
  if (model.reasoning === false) return { reasoning: false }
  const levels = model.reasoning ?? DEFAULT_THINKING_LEVELS
  const thinkingLevelMap: Record<string, string | null> = {}
  for (const level of ALL_THINKING_LEVELS) {
    if (levels.includes(level)) {
      if (level !== 'off') thinkingLevelMap[level] = level
    } else {
      thinkingLevelMap[level] = null
    }
  }
  return { reasoning: true, thinkingLevelMap }
}

function customModel(model: ModelConfig, resolved: ResolvedProvider): Model<Api> {
  if (resolved.api === undefined || resolved.baseURL === undefined) {
    throw new ConfigError(
      `providers.${resolved.providerId}: custom provider is missing api/baseURL`,
    )
  }
  const reasoning = reasoningOf(model)
  const built: Model<Api> = {
    id: model.id,
    name: model.name ?? model.id,
    api: resolved.api,
    provider: resolved.route,
    baseUrl: resolved.baseURL,
    input: model.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? FALLBACK_MAX_TOKENS,
    reasoning: reasoning.reasoning,
    ...(reasoning.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: reasoning.thinkingLevelMap }),
  }
  if (resolved.compat !== undefined) built.compat = resolved.compat as Model<Api>['compat']
  return built
}

function apiStreams(api: Api) {
  switch (api) {
    case 'anthropic-messages':
      return anthropicMessagesApi()
    case 'openai-responses':
      return openAIResponsesApi()
    case 'openai-completions':
      return openAICompletionsApi()
    // The remaining pi-ai catalogs are not supported on custom endpoints.
    case 'azure-openai-responses':
    case 'bedrock-converse-stream':
    case 'google-generative-ai':
    case 'google-vertex':
    case 'mistral-conversations':
    case 'openai-codex-responses':
    case 'pi-messages':
      throw new ConfigError(`unsupported custom api "${api}"`)
  }
  throw new ConfigError(`unsupported custom api "${String(api)}"`)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function inputModalities(value: unknown): ('text' | 'image')[] | undefined {
  if (!Array.isArray(value)) return undefined
  const input = value.filter(
    (entry): entry is 'text' | 'image' => entry === 'text' || entry === 'image',
  )
  return input.length === 0 ? undefined : input
}

function catalogModels(body: unknown): ModelConfig[] {
  const record = asRecord(body)
  const data = Array.isArray(body) ? body : (record?.data ?? record?.models)
  if (!Array.isArray(data)) return []
  const models: ModelConfig[] = []
  for (const entry of data) {
    const item = asRecord(entry)
    if (item === undefined) continue
    const id = item.id
    if (typeof id !== 'string' || id.trim() === '') continue
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : undefined
    const contextWindow =
      positiveInteger(item.context_length) ??
      positiveInteger(item.context_window) ??
      positiveInteger(item.contextWindow)
    const maxTokens =
      positiveInteger(item.max_output_tokens) ??
      positiveInteger(item.max_tokens) ??
      positiveInteger(item.maxTokens)
    const modalities = asRecord(item.modalities)?.input ?? item.input_modalities
    const input = inputModalities(modalities)
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input === undefined ? {} : { input }),
    })
  }
  return models
}

async function fetchModels(url: string, key: string): Promise<ModelConfig[]> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    redirect: 'error',
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`model catalog returned ${response.status}`)
  return catalogModels(await response.json())
}

function profileFor(
  route: string,
  displayName: string,
  piProvider: Provider,
  headers?: Record<string, string>,
): ResolvedPiAiProviderProfile {
  return {
    provider: route,
    displayName,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20_971_520,
    maxRequestImages: 50,
    imageOffloadCountQuantum: 10,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
    retryPolicy: DEFAULT_RETRY_POLICY,
    piProvider,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    ...(headers === undefined ? {} : { headers }),
  }
}

let builtinCache: Provider[] | undefined

function allBuiltinProviders(): Provider[] {
  builtinCache ??= builtinProviders()
  return builtinCache
}

function builtinProvider(resolved: ResolvedProvider): BuiltProvider {
  const catalog = resolved.catalog ?? resolved.providerId
  const provider = allBuiltinProviders().find((candidate) => candidate.id === catalog)
  if (provider === undefined) {
    throw new ConfigError(
      `providers.${resolved.providerId}: unknown builtin catalog provider "${catalog}"`,
    )
  }
  const models = [...provider.getModels()]
  if (models.length === 0) {
    throw new ConfigError(
      `providers.${resolved.providerId}: builtin catalog provider "${catalog}" has no chat models`,
    )
  }
  return { provider, models }
}

function withStaticMetadata(
  discovered: readonly ModelConfig[],
  staticModels: readonly ModelConfig[] | undefined,
): ModelConfig[] {
  if (staticModels === undefined) return [...discovered]
  const byId = new Map(staticModels.map((model) => [model.id, model]))
  return discovered.map((model) => {
    const fallback = byId.get(model.id)
    if (fallback === undefined) return model
    const name = model.name ?? fallback.name
    const contextWindow = model.contextWindow ?? fallback.contextWindow
    const maxTokens = model.maxTokens ?? fallback.maxTokens
    const input = model.input ?? fallback.input
    const reasoning = model.reasoning ?? fallback.reasoning
    return {
      id: model.id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input === undefined ? {} : { input }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  })
}

async function customProvider(
  resolved: ResolvedProvider,
  key: string,
  log: ProviderLogger,
): Promise<BuiltProvider> {
  let models = resolved.models
  if (resolved.modelsURL !== undefined) {
    try {
      const fetched = await fetchModels(resolved.modelsURL, key)
      if (fetched.length > 0) models = withStaticMetadata(fetched, resolved.models)
      else
        log.warn(
          'more-providers: %s model catalog was empty; using the static fallback',
          resolved.route,
        )
    } catch (error) {
      log.warn('more-providers: %s model catalog failed: %o', resolved.route, error)
    }
  }
  if (models === undefined || models.length === 0) {
    throw new Error('no models: model catalog failed and no static models were configured')
  }
  const api = resolved.api
  if (api === undefined)
    throw new ConfigError(`providers.${resolved.providerId}: custom provider is missing api`)
  const provider = createProvider({
    id: resolved.route,
    name: resolved.displayName,
    auth: { apiKey: envApiKeyAuth('more-providers API key', ['MORE_PROVIDERS_API_KEY']) },
    models: models.map((model) => customModel(model, resolved)),
    api: { [api]: apiStreams(api) },
  })
  return {
    provider,
    models: [...provider.getModels()],
    ...(resolved.headers === undefined ? {} : { headers: resolved.headers }),
  }
}

async function commandCodeProvider(resolved: ResolvedProvider): Promise<BuiltProvider> {
  const baseURL = resolved.baseURL ?? COMMAND_CODE_BASE_URL
  const modelsURL = resolved.modelsURL ?? COMMAND_CODE_MODELS_URL
  const zdr = resolved.zdr ?? process.env.CMD_ZDR === '1'
  const items = await fetchCatalog(modelsURL, MODELS_TIMEOUT_MS)
  const { provider, models } = buildCommandCodeProvider(items, {
    route: resolved.route,
    displayName: resolved.displayName,
    baseURL,
    zdr,
  })
  return {
    provider,
    models,
    ...(zdr ? { headers: { [ZDR_HEADER]: '1' } } : {}),
  }
}

async function buildOne(
  resolved: ResolvedProvider,
  key: string,
  log: ProviderLogger,
): Promise<BuiltProvider> {
  switch (resolved.kind) {
    case 'builtin':
      return builtinProvider(resolved)
    case 'custom':
      return customProvider(resolved, key, log)
    case 'command-code':
      return commandCodeProvider(resolved)
    default:
      throw new ConfigError(`more-providers: unsupported provider kind "${String(resolved.kind)}"`)
  }
}

/**
 * Build every configured route that has a readable key. A config error throws
 * (the caller registers no providers); a runtime catalog failure logs and
 * skips only that route.
 */
export async function buildProviders(
  resolved: readonly ResolvedProvider[],
  log: ProviderLogger,
): Promise<BuildResult> {
  const profiles = new Map<string, ResolvedPiAiProviderProfile>()
  const keys = new Map<string, KeySource>()
  for (const provider of resolved) {
    const key = readKey(provider.keySource)
    if (key === undefined) {
      log.warn('more-providers: %s has no readable key; route stays dormant', provider.route)
      continue
    }
    try {
      const built = await buildOne(provider, key, log)
      profiles.set(
        provider.route,
        profileFor(
          provider.route,
          built.displayName ?? provider.displayName,
          built.provider,
          built.headers,
        ),
      )
      keys.set(provider.route, provider.keySource)
    } catch (error) {
      if (error instanceof ConfigError) throw error
      log.error('more-providers: %s could not be built: %o', provider.route, error)
    }
  }
  return { profiles, keys }
}

/** Build the adapter over the profiles that survived startup. */
export function buildAdapter(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
  keyOf: (provider: string) => string | undefined,
): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async (provider) => {
      const key = keyOf(provider)
      return key
    },
    auth: AUTH,
  })
}

/** Exported for the smoke test. */
