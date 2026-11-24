/**
 * Catalog finalization: merge the discovered catalog with static metadata, fill
 * `modelDefaults` and `contextWindows`, then hard-delete filtered model ids.
 * @module dsh-more-providers/catalog/finalize
 */
import type { ModelConfig, ModelDefault, ModelMetadata } from '../config.js'
import type { ModelFilter } from './filter.js'

/** One finalization request: the discovered catalog plus every metadata layer. */
export interface FinalizeInput {
  catalog: readonly ModelConfig[]
  staticModels?: readonly ModelConfig[]
  defaults?: readonly ModelDefault[]
  contextWindows?: ReadonlyMap<string, number>
  filter?: ModelFilter
}

/** Effective models plus the dropped ids, all in catalog order. */
export interface FinalizeResult {
  models: ModelConfig[]
  excluded: string[]
  notIncluded: string[]
}

function matches(pattern: RegExp, id: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(id)
}

function modelMetadata(defaults: readonly ModelDefault[] | undefined, id: string): ModelMetadata {
  const metadata: ModelMetadata = {}
  for (const rule of defaults ?? []) {
    if (!matches(rule.pattern, id)) continue
    metadata.contextWindow ??= rule.contextWindow
    metadata.maxTokens ??= rule.maxTokens
    metadata.input ??= rule.input
    metadata.reasoning ??= rule.reasoning
  }
  return metadata
}

function mergeModels(
  catalog: readonly ModelConfig[],
  staticModels: readonly ModelConfig[] | undefined,
  defaults: readonly ModelDefault[] | undefined,
  contextWindows: ReadonlyMap<string, number> | undefined,
): ModelConfig[] {
  const fromCatalog = new Map(catalog.map((model) => [model.id, model]))
  const fromStatic = new Map((staticModels ?? []).map((model) => [model.id, model]))
  const entries = catalog.length === 0 ? (staticModels ?? []) : catalog
  return entries.map((entry) => {
    const discovered = fromCatalog.get(entry.id)
    const fallback = fromStatic.get(entry.id)
    const metadata = catalog.length === 0 ? {} : modelMetadata(defaults, entry.id)
    const name = discovered?.name ?? fallback?.name
    const contextWindow =
      discovered?.contextWindow ??
      metadata.contextWindow ??
      fallback?.contextWindow ??
      contextWindows?.get(entry.id)
    const maxTokens = discovered?.maxTokens ?? metadata.maxTokens ?? fallback?.maxTokens
    const input = discovered?.input ?? metadata.input ?? fallback?.input
    const reasoning = discovered?.reasoning ?? metadata.reasoning ?? fallback?.reasoning
    const model: ModelConfig = { id: entry.id }
    if (name !== undefined) model.name = name
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    if (maxTokens !== undefined) model.maxTokens = maxTokens
    if (input !== undefined) model.input = input
    if (reasoning !== undefined) model.reasoning = reasoning
    return model
  })
}

/** Finalize one route's catalog; the filter runs last, so `models` is what gets registered. */
export function finalizeCatalog(input: FinalizeInput): FinalizeResult {
  const merged = mergeModels(
    input.catalog,
    input.staticModels,
    input.defaults,
    input.contextWindows,
  )
  const filter = input.filter
  if (filter === undefined) return { models: merged, excluded: [], notIncluded: [] }
  const models: ModelConfig[] = []
  const excluded: string[] = []
  const notIncluded: string[] = []
  for (const model of merged) {
    const reason = filter.reason(model.id)
    if (reason === 'exclude-hit') excluded.push(model.id)
    else if (reason === 'include-miss') notIncluded.push(model.id)
    else models.push(model)
  }
  return { models, excluded, notIncluded }
}
