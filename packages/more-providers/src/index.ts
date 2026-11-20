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

  let running: Promise<void> | undefined
  let pending: ConfigState<ResolvedConfig> | undefined

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

  const rebuild = (next: ConfigState<ResolvedConfig>): void => {
    pending = next
    if (running !== undefined) return
    running = (async () => {
      try {
        while (pending !== undefined) {
          const target = pending
          pending = undefined
          await install(target)
        }
      } catch (error) {
        log.error('more-providers: reload failed: %o', error)
      } finally {
        running = undefined
      }
    })()
  }

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
