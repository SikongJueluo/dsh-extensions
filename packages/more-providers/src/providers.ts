/** @module dsh-more-providers/providers */
import type { Api, Model, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { createProvider, envApiKeyAuth } from '@earendil-works/pi-ai'
import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from '@earendil-works/pi-ai/compat'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import type { ModelConfig } from './config.js'
import { ConfigError } from './config.js'
import type { ModelFilter } from './catalog/filter.js'
import { finalizeCatalog } from './catalog/finalize.js'
import type { FinalizeResult } from './catalog/finalize.js'
import {
  DEFAULT_BASE_URL as COMMAND_CODE_BASE_URL,
  DEFAULT_CAPABILITIES_URL as COMMAND_CODE_CAPABILITIES_URL,
  DEFAULT_MODELS_URL as COMMAND_CODE_MODELS_URL,
  ZDR_HEADER,
  buildCommandCodeProvider,
  fetchCapabilities,
  fetchCatalog,
  mergeCapabilities,
} from './commandcode.js'
import type { CommandCodeCapability, CommandCodeCatalogItem } from './commandcode.js'
import { DEFAULT_THINKING_LEVELS, THINKING_LEVEL_SET, thinkingLevelMapOf } from './reasoning.js'
import { isRecord } from './record.js'
import type {
  BuiltinProviderSpec,
  CommandCodeProviderSpec,
  CustomProviderSpec,
} from './providers/spec.js'

const FALLBACK_CONTEXT_WINDOW = 131_072
const FALLBACK_MAX_TOKENS = 32_768
const MODELS_TIMEOUT_MS = 10_000

/** Minimal logger surface used during startup. */
export interface ProviderLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Marks a model-directory fetch failure so the build report records it as `catalogError`. */
export class CatalogError extends Error {}

/** Model counts one route's finalization produced. */
export interface RouteModelCounts {
  discovered: number
  effective: number
  excluded: string[]
  notIncluded: string[]
}

/** What happened to one configured route during startup. */
export interface RouteBuildReport {
  route: string
  registered: boolean
  models?: RouteModelCounts
  catalogError?: string
  error?: string
}

/** One route's built catalog: the provider to register and how the filter accounted for the rest. */
interface FinalCatalog<M> {
  models: M[]
  discovered: number
  excluded: string[]
  notIncluded: string[]
}

/** What one provider spec built before it becomes an adapter profile. */
export interface BuiltCatalog extends FinalCatalog<Model<Api>> {
  provider: Provider
  headers?: Record<string, string>
  catalogError?: string
}

function reasoningOf(model: ModelConfig): {
  reasoning: boolean
  thinkingLevelMap?: ThinkingLevelMap
} {
  if (model.reasoning === false) return { reasoning: false }
  return {
    reasoning: true,
    thinkingLevelMap: thinkingLevelMapOf(model.reasoning ?? DEFAULT_THINKING_LEVELS),
  }
}

function customModel(model: ModelConfig, spec: CustomProviderSpec): Model<Api> {
  const reasoning = reasoningOf(model)
  const built: Model<Api> = {
    id: model.id,
    name: model.name ?? model.id,
    api: spec.api,
    provider: spec.route,
    baseUrl: spec.baseURL,
    input: model.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? FALLBACK_MAX_TOKENS,
    reasoning: reasoning.reasoning,
    ...(reasoning.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: reasoning.thinkingLevelMap }),
  }
  if (spec.compat !== undefined) built.compat = spec.compat as Model<Api>['compat']
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

function catalogReasoning(value: unknown): false | string[] | undefined {
  if (value === false) return false
  if (!Array.isArray(value) || value.length === 0) return undefined
  if (!value.every((level): level is string => typeof level === 'string')) return undefined
  return value.every((level) => THINKING_LEVEL_SET.has(level)) ? value : undefined
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
    const reasoning = catalogReasoning(item.reasoning)
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input === undefined ? {} : { input }),
      ...(reasoning === undefined ? {} : { reasoning }),
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

function catalogOf<M>(models: M[], finalized: FinalizeResult): FinalCatalog<M> {
  return {
    models,
    discovered: models.length + finalized.excluded.length + finalized.notIncluded.length,
    excluded: finalized.excluded,
    notIncluded: finalized.notIncluded,
  }
}

/** The same provider with its chat catalog narrowed to the surviving models. */
function withModels(provider: Provider, models: readonly Model<Api>[]): Provider {
  return { ...provider, getModels: () => models }
}

/** Finalize a pi-ai catalog by id: its models keep their own metadata, so only `id` takes part. */
function finalizePiModels(
  models: readonly Model<Api>[],
  filter: ModelFilter | undefined,
): FinalCatalog<Model<Api>> {
  const finalized = finalizeCatalog({
    catalog: models.map((model) => ({ id: model.id })),
    filter,
  })
  const kept = new Set(finalized.models.map((model) => model.id))
  return catalogOf(
    models.filter((model) => kept.has(model.id)),
    finalized,
  )
}

let builtinCache: Provider[] | undefined

function allBuiltinProviders(): Provider[] {
  builtinCache ??= builtinProviders()
  return builtinCache
}

/** Rebuild a bundled catalog under the route's own id: the harness indexes models by pi-ai provider id, so the catalog id must not leak through. */
export function buildBuiltinCatalog(spec: BuiltinProviderSpec): BuiltCatalog {
  const provider = allBuiltinProviders().find((candidate) => candidate.id === spec.catalog)
  if (provider === undefined) {
    throw new ConfigError(
      `providers.${spec.providerId}: unknown builtin catalog provider "${spec.catalog}"`,
    )
  }
  const available = [...provider.getModels()]
  if (available.length === 0) {
    throw new ConfigError(
      `providers.${spec.providerId}: builtin catalog provider "${spec.catalog}" has no chat models`,
    )
  }
  const finalized = finalizePiModels(available, spec.filter)
  const models = finalized.models.map((model) => ({ ...model, provider: spec.route }))
  return {
    provider: { ...provider, id: spec.route, name: spec.displayName, getModels: () => models },
    ...finalized,
    models,
  }
}

export async function fetchCustomCatalog(
  spec: CustomProviderSpec,
  key: string,
): Promise<ModelConfig[]> {
  if (spec.modelsURL === undefined) return []
  return fetchModels(spec.modelsURL, key)
}

export function buildCustomCatalog(
  spec: CustomProviderSpec,
  catalog: readonly ModelConfig[],
  catalogError?: string,
): BuiltCatalog {
  const finalized = finalizeCatalog({
    catalog,
    staticModels: spec.models,
    defaults: spec.modelDefaults,
    contextWindows: spec.contextWindows,
    filter: spec.filter,
  })
  const models = finalized.models.map((model) => customModel(model, spec))
  const provider = createProvider({
    id: spec.route,
    name: spec.displayName,
    auth: { apiKey: envApiKeyAuth('more-providers API key', ['MORE_PROVIDERS_API_KEY']) },
    models,
    api: { [spec.api]: apiStreams(spec.api) },
  })
  return {
    provider,
    ...catalogOf(models, finalized),
    ...(spec.headers === undefined ? {} : { headers: spec.headers }),
    ...(catalogError === undefined ? {} : { catalogError }),
  }
}

/** Merge per-account catalogs into one model list: first account to supply a field wins. */
export function unionCatalogs(catalogs: readonly (readonly ModelConfig[])[]): ModelConfig[] {
  const merged = new Map<string, ModelConfig>()
  for (const catalog of catalogs) {
    for (const model of catalog) {
      const seen = merged.get(model.id)
      if (seen === undefined) {
        merged.set(model.id, { ...model })
        continue
      }
      if (seen.name === undefined && model.name !== undefined) seen.name = model.name
      if (seen.contextWindow === undefined && model.contextWindow !== undefined) {
        seen.contextWindow = model.contextWindow
      }
      if (seen.maxTokens === undefined && model.maxTokens !== undefined) {
        seen.maxTokens = model.maxTokens
      }
      if (seen.input === undefined && model.input !== undefined) seen.input = model.input
      if (seen.reasoning === undefined && model.reasoning !== undefined) {
        seen.reasoning = model.reasoning
      }
    }
  }
  return [...merged.values()]
}

/** Fetch the Command Code directory, turning any failure into the marker the report understands. */
async function fetchCatalogOrFail(modelsURL: string): Promise<CommandCodeCatalogItem[]> {
  try {
    return await fetchCatalog(modelsURL, MODELS_TIMEOUT_MS)
  } catch (error) {
    throw new CatalogError(error instanceof Error ? error.message : String(error), { cause: error })
  }
}

export async function buildCommandCodeCatalog(
  spec: CommandCodeProviderSpec,
  log: ProviderLogger,
): Promise<BuiltCatalog> {
  const baseURL = spec.baseURL ?? COMMAND_CODE_BASE_URL
  const modelsURL = spec.modelsURL ?? COMMAND_CODE_MODELS_URL
  const zdr = spec.zdr ?? process.env.CMD_ZDR === '1'
  const items = await fetchCatalogOrFail(modelsURL)
  let capabilities: ReadonlyMap<string, CommandCodeCapability> = new Map()
  try {
    capabilities = await fetchCapabilities(COMMAND_CODE_CAPABILITIES_URL, MODELS_TIMEOUT_MS)
  } catch (error) {
    log.warn(
      'more-providers: %s model capability catalog failed; using /models metadata only: %o',
      spec.route,
      error,
    )
  }
  const built = buildCommandCodeProvider(mergeCapabilities(items, capabilities), {
    route: spec.route,
    displayName: spec.displayName,
    baseURL,
    zdr,
  })
  const finalized = finalizePiModels(built.models, spec.filter)
  return {
    provider: withModels(built.provider, finalized.models),
    ...finalized,
    ...(zdr ? { headers: { [ZDR_HEADER]: '1' } } : {}),
  }
}
