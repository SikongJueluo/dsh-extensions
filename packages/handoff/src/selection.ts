/**
 * Resolving the origin session's *effective* model route.
 *
 * `agent.options` only records what the agent was created with; a `/model`
 * switch — provider, model, and the reasoning effort — lands in the session's
 * durable `modelSelection` projection instead. Inheriting from `agent.options`
 * therefore handed the fresh session a stale or missing effort. The Agent owns
 * that fold: `agent.model.current()` reads the pending selection first, the
 * last used one second, and falls back to the creation options — the same
 * order the /model popup shows, without this plugin reading another service's
 * projection or casting its untyped state.
 *
 * @module dsh-handoff/selection
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
// Type-only: pull the `Context.sessionController` augmentation in.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { PACKAGE_NAME } from './identity.js'
import type { ModelChoice } from './choice.js'

/** A provider/model pair plus the reasoning effort in force, as the UI describes it. */
export interface RouteSummary {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Narrow a selection into our owned route summary. */
function toRoute(selection: {
  provider: string
  model: string
  reasoningEffort?: string
}): RouteSummary {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
  }
}

/**
 * The route the origin session is actually on: the Agent's durable selection
 * (pending first, then last used), falling back to its creation options.
 * Returns `undefined` only when neither source names a route.
 */
export function sessionRoute(agent: Agent): RouteSummary | undefined {
  const selection = agent.model.current()
  return selection === undefined ? undefined : toRoute(selection)
}

/** The deployment's global default route, effort included. */
export function defaultRoute(ctx: Context): RouteSummary | undefined {
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  return selection === undefined ? undefined : toRoute(selection)
}

/**
 * Turn a route into agent-creation options. `maxTokens` is deliberately not
 * part of a route: callers that inherit from the origin session add it
 * separately, and a switched model keeps its own default.
 */
export function toAgentOptions(route: RouteSummary | undefined): AgentOptions | undefined {
  if (route === undefined) return undefined
  return {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: route.reasoningEffort as AgentOptions['reasoningEffort'] }),
  }
}

// ── remembered-model validation ────────────────────────────────────────────

/** Budget for one catalog snapshot; past it the default is used unvalidated. */
const CATALOG_TIMEOUT_MS = 8_000

/** One selectable reasoning effort, as the catalog advertises it. */
export interface CatalogEffort {
  readonly id: string
  readonly name: string
}

/** One provider/model route in the deployment catalog. */
export interface CatalogModel {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly name: string
  readonly description?: string
  /** Advertised efforts; absent/empty means the model exposes no choice. */
  readonly efforts?: readonly CatalogEffort[]
  readonly defaultEffort?: string
}

/** One provider whose catalog lookup failed (its models are unknown, not gone). */
export interface CatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** A bounded snapshot of the deployment model catalog, for validation and menus. */
export interface CatalogSnapshot {
  readonly models: readonly CatalogModel[]
  readonly failures: readonly CatalogFailure[]
  /** Every provider route the catalog could enumerate. */
  readonly providers: readonly string[]
  /**
   * Whether {@link CatalogModel.efforts} reflects adapter metadata. The plain
   * LLM registry lists models without reasoning metadata, so an absent effort
   * there means "unknown", never "unsupported".
   */
  readonly effortsKnown: boolean
}

/** Resolve `promise` within `timeoutMs`; `undefined` on timeout or rejection. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Snapshot the catalog the /model popup reads (provider groups, display
 * names, reasoning efforts). The session controller's catalog is preferred
 * because it carries effort metadata; a composition without it falls back to
 * the plain LLM registry, which still proves model presence but not efforts.
 *
 * A slow or failing catalog yields `undefined`: validation must never turn a
 * possibly valid remembered route into a hard failure.
 */
export async function loadModelCatalog(ctx: Context): Promise<CatalogSnapshot | undefined> {
  const controller = ctx.get('sessionController')
  if (controller !== undefined) {
    const catalog = await settleWithin(controller.modelCatalog(), CATALOG_TIMEOUT_MS)
    if (catalog === undefined) {
      ctx.logger(PACKAGE_NAME).warn('model catalog unavailable; remembered route left unvalidated')
      return undefined
    }
    const models: CatalogModel[] = []
    for (const group of catalog.groups) {
      for (const model of group.models) {
        models.push({
          provider: group.id,
          providerName: group.name,
          model: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(model.reasoning === undefined
            ? {}
            : {
                efforts: model.reasoning.efforts.map((effort) => ({
                  id: effort.id,
                  name: effort.name,
                })),
                ...(model.reasoning.defaultEffort === undefined
                  ? {}
                  : { defaultEffort: model.reasoning.defaultEffort }),
              }),
        })
      }
    }
    return {
      models,
      failures: catalog.failures.map((failure) => ({
        id: failure.id,
        name: failure.name,
        message: failure.message,
      })),
      providers: [
        ...new Set([
          ...catalog.groups.map((group) => group.id),
          ...catalog.failures.map((failure) => failure.id),
        ]),
      ],
      effortsKnown: true,
    }
  }

  const llm = ctx.get('llm')
  if (llm === undefined) return undefined
  const collect = async (): Promise<CatalogSnapshot> => {
    const providers = await llm.listProviders()
    const models: CatalogModel[] = []
    const failures: CatalogFailure[] = []
    for (const provider of providers) {
      try {
        for (const model of await llm.listModels(provider.id)) {
          models.push({
            provider: model.provider,
            providerName: provider.name,
            model: model.id,
            name: model.name,
            ...(model.description === undefined ? {} : { description: model.description }),
          })
        }
      } catch (error) {
        failures.push({ id: provider.id, name: provider.name, message: String(error) })
      }
    }
    return {
      models,
      failures,
      providers: providers.map((provider) => provider.id),
      effortsKnown: false,
    }
  }
  return settleWithin(collect(), CATALOG_TIMEOUT_MS)
}

/**
 * Why a remembered explicit route cannot be used, or `undefined` when it can
 * (or when the catalog cannot prove it gone).
 *
 * Absence is only evidence when the provider itself answered: a provider
 * listed under `failures` was not enumerated, and a provider missing from the
 * catalog entirely may still route a manually spelled model. An effort is
 * checked only against a model that advertises efforts.
 */
export function modelChoiceIssue(
  catalog: CatalogSnapshot,
  choice: ModelChoice,
): string | undefined {
  if (choice.kind !== 'model') return undefined
  if (catalog.failures.some((failure) => failure.id === choice.provider)) return undefined
  if (!catalog.providers.includes(choice.provider)) return undefined
  const model = catalog.models.find(
    (entry) => entry.provider === choice.provider && entry.model === choice.model,
  )
  if (model === undefined) {
    return `上次使用的模型已不可用：${choice.provider}/${choice.model}`
  }
  // Without adapter reasoning metadata an effort cannot be judged; leave it to
  // the first request instead of rejecting a potentially valid route.
  if (!catalog.effortsKnown || choice.reasoningEffort === undefined) return undefined
  const efforts = model.efforts ?? []
  if (efforts.length === 0 || !efforts.some((effort) => effort.id === choice.reasoningEffort)) {
    return `上次使用的思考强度 ${choice.reasoningEffort} 已不受 ${model.name}（${model.model}）支持`
  }
  return undefined
}
