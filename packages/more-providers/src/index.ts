/**
 * YAML-configured providers: every route, including the optional ChatGPT OAuth one, registers through the same registry path and receives the same request-time host image services. Invalid startup configuration registers no provider routes.
 * @module dsh-more-providers
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { registerConfig, registerConfigStatusRoute, type ConfigState } from '@dsh-extensions/config'
import { ConfigError, resolveConfig, type ResolvedConfig } from './config.js'
import { readKey } from './keys.js'
import type { RouteBuildReport } from './providers.js'
import { buildRoutes, createRegistry, type BuildOutcome } from './providers/registry.js'
import { toProviderSpecs } from './providers/spec.js'
import { registerProvidersRefreshRoute } from './refresh.js'
import {
  registerProvidersStatusRoute,
  type ProviderAccountStatus,
  type ProviderStatus,
} from './status.js'
import { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
import { createProviderImageServices } from './runtime.js'
import type { ChatGptStatusView } from './providers/chatgpt/index.js'

export { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
export { OAuthProvidersService } from './oauth/service.js'
export type { OAuthToken, TokenResolver } from './oauth/service.js'
export {
  ConfigError,
  defaultSecretDir,
  loadConfig,
  resolveConfig,
  resolveConfigPath,
} from './config.js'
export type {
  ModelConfig,
  ModelDefault,
  ModelMetadata,
  ProviderKind,
  ResolvedConfig,
} from './config.js'
export type {
  AccountSpec,
  ApiKeyProviderSpec,
  BuiltinProviderSpec,
  ChatGptProviderSpec,
  CommandCodeProviderSpec,
  CustomProviderSpec,
  ProviderSpec,
} from './providers/spec.js'
export { toProviderSpecs } from './providers/spec.js'
export { ProviderKeys, readKey } from './keys.js'
export type { KeySource } from './keys.js'
export { buildRoutes, createRegistry } from './providers/registry.js'
export type { BuildOutcome, Registry, RegistryDeps } from './providers/registry.js'
export type { RouteBuildReport, RouteModelCounts } from './providers.js'
export {
  DEFAULT_BASE_URL,
  DEFAULT_CAPABILITIES_URL,
  DEFAULT_MODELS_URL,
  buildCommandCodeProvider,
  fetchCapabilities,
  fetchCatalog,
  mergeCapabilities,
  parseCapabilities,
  parseCatalog,
  toPiModels,
} from './commandcode.js'

/** Plugin-row configuration: only the YAML path is configured here. */
export interface Config {
  configFile?: string
}

export const Config = Schema.object({
  configFile: Schema.string().description(
    'YAML provider config path; empty uses $DSH_HOME/more-providers.yaml.',
  ),
})

export const name = PLUGIN_NAME
export const inject = ['llm']

export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = ctx.logger(PACKAGE_NAME)
  const store = registerConfig(ctx, {
    filename: 'more-providers.yaml',
    configFile: config.configFile,
    validate: resolveConfig,
    watch: true,
    logger: log,
  })
  registerConfigStatusRoute(ctx, {
    prefix: '/dsh-more-providers',
    title: 'more-providers',
    recovery: 'auto',
    store,
  })
  const registry = createRegistry(ctx, { images: createProviderImageServices(ctx) })
  const live: {
    resolved?: ResolvedConfig
    built?: BuildOutcome
    appliedRevision?: number
  } = {}
  let running: Promise<void> | undefined
  let pending: ConfigState<ResolvedConfig> | undefined
  let rescans = 0
  let rescanWaiters: ((error: string | undefined) => void)[] = []

  const install = async (next: ConfigState<ResolvedConfig>): Promise<void> => {
    const resolved = next.value
    if (resolved === undefined) {
      if (live.appliedRevision !== undefined) {
        log.warn(
          'more-providers: config %s is unusable (%s); the previous registration stays live',
          next.file,
          next.error ?? 'unknown error',
        )
      }
      return
    }
    let built: BuildOutcome
    try {
      built = await buildRoutes(toProviderSpecs(resolved), log)
    } catch (error) {
      const reason = error instanceof ConfigError ? error.message : String(error)
      log.error(
        'more-providers: config %s could not be rebuilt: %s; the previous registration stays live',
        next.file,
        reason,
      )
      store.reportFailure(reason)
      return
    }
    if (pending !== undefined) return
    try {
      registry.apply(built)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      log.error('more-providers: config %s could not be registered: %s', next.file, reason)
      store.reportFailure(reason)
      return
    }
    live.resolved = resolved
    live.built = built
    live.appliedRevision = next.revision
    log.info(
      'more-providers: applied revision %d (%d API-key route(s), ChatGPT OAuth %s); config %s',
      next.revision,
      built.profiles.size,
      resolved.chatgpt?.enabled === true ? 'enabled' : 'disabled',
      next.file,
    )
  }

  /** Rebuild from the last applied configuration, re-reading every `modelsURL`; a manual retry never touches the file or its revision, keeps the working routes, and reports the ones still without a catalog. */
  const rescan = async (): Promise<void> => {
    const resolved = live.resolved ?? store.get()
    if (resolved === undefined) {
      throw new Error('no usable configuration has been applied yet')
    }
    const built = await buildRoutes(toProviderSpecs(resolved), log)
    const failures = rebuildFailures(built)
    const next = retainFailedRoutes(built, live.built)
    registry.apply(next)
    live.built = next
    log.info(
      'more-providers: re-fetched the model catalog (%d API-key route(s))',
      built.profiles.size,
    )
    if (failures.length > 0) throw new Error(failures.join('; '))
  }

  /** One queue for both edit-driven reloads and manual re-fetches, so a stale rebuild never replaces a newer one. */
  const drain = async (): Promise<void> => {
    for (;;) {
      if (pending !== undefined) {
        const target = pending
        pending = undefined
        await install(target)
        continue
      }
      if (rescans === 0) return
      rescans = 0
      const waiters = rescanWaiters
      rescanWaiters = []
      let error: string | undefined
      try {
        await rescan()
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
        log.error('more-providers: catalog re-fetch failed: %s', error)
      }
      for (const waiter of waiters) waiter(error)
    }
  }

  const start = (): void => {
    if (running !== undefined) return
    const task = drain()
    running = task
    void task.finally(() => {
      if (running === task) running = undefined
    })
  }

  const rebuild = (next: ConfigState<ResolvedConfig>): void => {
    pending = next
    start()
  }

  /** Queue one catalog re-fetch, coalesced with clicks already waiting; resolves with the failure text or `undefined`. */
  const retryCatalog = (): Promise<string | undefined> =>
    new Promise((resolve) => {
      rescanWaiters.push(resolve)
      rescans += 1
      start()
    })

  const state = await store.ready
  registerProvidersStatusRoute(ctx, {
    prefix: '/dsh-more-providers',
    title: 'more-providers',
    store,
    applied: () => live.appliedRevision,
    source: () =>
      live.resolved === undefined || live.built === undefined
        ? []
        : routeStatuses(
            live.resolved,
            live.built.accounts,
            live.built.reports,
            registry.chatGptView(),
          ),
  })
  registerProvidersRefreshRoute(ctx, {
    prefix: '/dsh-more-providers',
    title: 'more-providers',
    rescan: async () => {
      const error = await retryCatalog()
      if (error !== undefined) throw new Error(error)
    },
  })

  store.subscribe((next) => {
    rebuild(next)
  })

  if (state.value === undefined) {
    log.error(
      'more-providers: config %s is unusable: %s — fix the file and it reloads automatically',
      state.file,
      state.error ?? 'unknown error',
    )
    return
  }
  await install(state)
}

/** The routes a rebuild could not serve: a failed catalog, or nothing registerable left. */
function rebuildFailures(outcome: BuildOutcome): string[] {
  return [...outcome.reports.values()].flatMap((report) =>
    report.catalogError !== undefined
      ? [`${report.route}: ${report.catalogError}`]
      : report.registered
        ? []
        : [`${report.route}: ${report.error ?? 'no usable models'}`],
  )
}

/** Put the still-serving registration back for every failed route, so a re-fetch that fails again never drops a working route. */
function retainFailedRoutes(
  outcome: BuildOutcome,
  previous: BuildOutcome | undefined,
): BuildOutcome {
  if (previous === undefined) return outcome
  const profiles = new Map(outcome.profiles)
  const accounts = new Map(outcome.accounts)
  const reports = new Map(outcome.reports)
  for (const [route, report] of outcome.reports) {
    if (report.registered && report.catalogError === undefined) continue
    const kept = previous.reports.get(route)
    if (kept === undefined || !kept.registered) continue
    const profile = previous.profiles.get(route)
    if (profile !== undefined) profiles.set(route, profile)
    const keptAccounts = previous.accounts.get(route)
    if (keptAccounts !== undefined) accounts.set(route, keptAccounts)
    reports.set(route, kept)
  }
  return { ...outcome, profiles, accounts, reports }
}

/** The settings page's route snapshot: configuration facts from the resolved config, catalog outcome from the build reports. */
function routeStatuses(
  config: ResolvedConfig,
  poolAccounts: BuildOutcome['accounts'] | undefined,
  reports: ReadonlyMap<string, RouteBuildReport>,
  chatGpt: ChatGptStatusView | undefined,
): ProviderStatus[] {
  const statuses: ProviderStatus[] = config.providers.map((provider) => {
    const report = reports.get(provider.route)
    const snapshot = poolAccounts?.get(provider.route)?.pool?.snapshot().accounts ?? []
    return {
      route: provider.route,
      kind: provider.kind,
      auth: 'api-key',
      displayName: provider.displayName,
      enabled: provider.enabled,
      registered: report?.registered ?? false,
      accounts: provider.accounts.map((account): ProviderAccountStatus => {
        const runtime = snapshot.find((entry) => entry.id === account.id)
        const status: ProviderAccountStatus = {
          id: account.id,
          displayName: account.displayName,
          ready: readKey(account.keySource) !== undefined,
        }
        if (runtime !== undefined) status.healthy = runtime.healthy
        if (runtime?.cooldownUntil !== undefined) status.cooldownUntil = runtime.cooldownUntil
        return status
      }),
      ...(report?.models === undefined ? {} : { models: report.models }),
      ...(report?.catalogError === undefined ? {} : { catalogError: report.catalogError }),
      ...(report?.error === undefined ? {} : { error: report.error }),
    }
  })
  const chatgpt = config.chatgpt
  if (chatgpt !== undefined) {
    const view = chatGpt?.()
    statuses.push({
      route: chatgpt.route,
      kind: 'chatgpt',
      auth: 'oauth',
      displayName: chatgpt.displayName,
      enabled: chatgpt.enabled,
      registered: view?.registered ?? false,
      accounts: [],
      ...(view?.models === undefined ? {} : { models: view.models }),
      ...(view?.catalogError === undefined ? {} : { catalogError: view.catalogError }),
    })
  }
  return statuses
}
