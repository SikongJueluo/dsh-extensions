/**
 * The one build-and-register path: provider specs in, adapter profiles and per-route reports out, then registration applied once.
 * @module dsh-more-providers/providers/registry
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { ConfigError } from '../config.js'
import { ProviderKeys, readKey } from '../keys.js'
import type { RouteAccounts } from '../keys.js'
import type { ProviderImageServices } from '../runtime.js'
import {
  CatalogError,
  buildBuiltinCatalog,
  buildCommandCodeCatalog,
  buildCustomCatalog,
  fetchCustomCatalog,
  unionCatalogs,
  type BuiltCatalog,
  type ProviderLogger,
  type RouteBuildReport,
} from '../providers.js'
import { AccountPool, adoptPoolHealth, type PoolAccount } from './pool.js'
import { FailoverPiAiAdapter } from './failover.js'
import { OAuthProvidersService } from '../oauth/service.js'
import { registerAuthChannel, type AuthChannel } from '../oauth/channel.js'
import {
  registerChatGpt,
  type ChatGptRegistration,
  type ChatGptStatusView,
} from './chatgpt/index.js'
import type {
  AccountSpec,
  ApiKeyProviderSpec,
  ChatGptProviderSpec,
  CustomProviderSpec,
  ProviderSpec,
} from './spec.js'
import type { ModelConfig } from '../config.js'

const DEFAULT_RETRY_POLICY = {
  mode: 'normal' as const,
  maxRetries: 5,
  retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
}

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

/** What one validated configuration produced before registration: profiles, per-route pools, reports. */
export interface BuildOutcome {
  profiles: Map<string, ResolvedPiAiProviderProfile>
  accounts: Map<string, RouteAccounts>
  reports: ReadonlyMap<string, RouteBuildReport>
  chatgpt?: ChatGptProviderSpec
}

/** Everything registration needs besides the outcome. */
export interface RegistryDeps {
  images: ProviderImageServices
}

function profileFor(
  route: string,
  displayName: string,
  piProvider: BuiltCatalog['provider'],
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

/** Why a route ended without registerable models; a catalog failure is reported separately. */
function emptyReason(built: BuiltCatalog): string {
  return built.discovered === 0
    ? 'the model catalog listed no usable models'
    : 'every model was filtered out'
}

/** One route's report; `built` is present whenever finalization ran. */
function routeReport(
  route: string,
  registered: boolean,
  built: BuiltCatalog | undefined,
  details: { error?: string; catalogError?: string } = {},
): RouteBuildReport {
  const catalogError = built?.catalogError ?? details.catalogError
  return {
    route,
    registered,
    ...(built === undefined
      ? {}
      : {
          models: {
            discovered: built.discovered,
            effective: built.models.length,
            excluded: built.excluded,
            notIncluded: built.notIncluded,
          },
        }),
    ...(catalogError === undefined ? {} : { catalogError }),
    ...(details.error === undefined ? {} : { error: details.error }),
  }
}

/** One readable pool member and the key it yielded at startup. */
interface ReadableAccount {
  account: AccountSpec
  key: string
}

/**
 * One account's share of a pooled catalog: the models its `modelsURL` returned and the
 * ids it can serve. Static fallbacks stay out of `discovered`, so `modelDefaults` keeps
 * its catalog-only meaning.
 */
interface Contribution {
  account: AccountSpec
  discovered: readonly ModelConfig[]
  served?: readonly string[]
  error?: string
}

function readableAccounts(accounts: readonly AccountSpec[]): ReadableAccount[] {
  const readable: ReadableAccount[] = []
  for (const account of accounts) {
    const key = readKey(account.keySource)
    if (key !== undefined) readable.push({ account, key })
  }
  return readable
}

/** Fetch every account's catalog concurrently; a failed or empty catalog falls back to the static list. */
async function customContributions(
  spec: CustomProviderSpec,
  readable: readonly ReadableAccount[],
  log: ProviderLogger,
): Promise<Contribution[]> {
  const staticIds = (spec.models ?? []).map((model) => model.id)
  return Promise.all(
    readable.map(async ({ account, key }): Promise<Contribution> => {
      const fallback: Contribution = {
        account,
        discovered: [],
        ...(staticIds.length === 0 ? {} : { served: staticIds }),
      }
      if (spec.modelsURL === undefined) return fallback
      try {
        const discovered = await fetchCustomCatalog(spec, key)
        if (discovered.length > 0) {
          return {
            account,
            discovered,
            served: discovered.map((model) => model.id),
          }
        }
        log.warn(
          'more-providers: %s account %s catalog was empty; using the static fallback',
          spec.route,
          account.id,
        )
        return fallback
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn(
          'more-providers: %s account %s model catalog failed: %o',
          spec.route,
          account.id,
          error,
        )
        return { ...fallback, error: message }
      }
    }),
  )
}

/** Each effective model to the accounts that serve it, in pool priority order. */
function coverageOf(
  members: readonly Contribution[],
  effectiveIds: readonly string[],
  poolIds: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const coverage = new Map<string, readonly string[]>()
  for (const id of effectiveIds) {
    const serving = members.flatMap((member) =>
      member.served?.includes(id) === true ? [member.account.id] : [],
    )
    coverage.set(id, serving.length === 0 ? poolIds : serving)
  }
  return coverage
}

/** One route-level catalog error: a single message stays readable, several name their account. */
function failureSummary(failures: readonly { id: string; message: string }[]): string | undefined {
  if (failures.length === 0) return undefined
  if (failures.length === 1) return failures[0]?.message
  return failures.map((failure) => `${failure.id}: ${failure.message}`).join('; ')
}

function poolAccounts(accounts: readonly AccountSpec[]): PoolAccount[] {
  return accounts.map((account) => ({
    id: account.id,
    displayName: account.displayName,
    keySource: account.keySource,
  }))
}

/** Report one pooled route: the catalog is built, one pool holds its members and coverage. */
function registerRoute(
  spec: ApiKeyProviderSpec,
  built: BuiltCatalog,
  members: readonly AccountSpec[],
  coverage: ReadonlyMap<string, readonly string[]>,
  profiles: Map<string, ResolvedPiAiProviderProfile>,
  accounts: Map<string, RouteAccounts>,
): void {
  profiles.set(spec.route, profileFor(spec.route, spec.displayName, built.provider, built.headers))
  const members2 = poolAccounts(members)
  accounts.set(spec.route, {
    accounts: members2,
    pool: new AccountPool({ route: spec.route, accounts: members2, coverage }),
  })
}

/** Build every enabled api-key route and keep the OAuth spec for registration. A config error throws; a runtime failure skips only its route. */
export async function buildRoutes(
  specs: readonly ProviderSpec[],
  log: ProviderLogger,
): Promise<BuildOutcome> {
  const profiles = new Map<string, ResolvedPiAiProviderProfile>()
  const accounts = new Map<string, RouteAccounts>()
  const reports = new Map<string, RouteBuildReport>()
  let chatgpt: ChatGptProviderSpec | undefined

  for (const spec of specs) {
    if (spec.kind === 'chatgpt') {
      chatgpt = spec
      continue
    }
    if (spec.accounts.length === 0) {
      log.warn('more-providers: %s has every account disabled; route stays dormant', spec.route)
      reports.set(
        spec.route,
        routeReport(spec.route, false, undefined, { error: 'every account is disabled' }),
      )
      continue
    }
    const readable = readableAccounts(spec.accounts)
    if (readable.length === 0) {
      log.warn('more-providers: %s has no readable key; route stays dormant', spec.route)
      reports.set(
        spec.route,
        routeReport(spec.route, false, undefined, { error: 'no readable key' }),
      )
      continue
    }

    let built: BuiltCatalog
    let members: AccountSpec[]
    let coverage: ReadonlyMap<string, readonly string[]>
    try {
      if (spec.kind === 'custom') {
        const contributions = await customContributions(spec, readable, log)
        const servable = contributions.filter((entry) => entry.served !== undefined)
        if (servable.length === 0) {
          const reason = 'no account has a usable model catalog'
          log.error('more-providers: %s has no usable catalog (%s)', spec.route, reason)
          reports.set(spec.route, routeReport(spec.route, false, undefined, { error: reason }))
          continue
        }
        const failures = contributions.flatMap((entry) =>
          entry.error === undefined ? [] : [{ id: entry.account.id, message: entry.error }],
        )
        built = buildCustomCatalog(
          spec,
          unionCatalogs(servable.map((entry) => entry.discovered)),
          failureSummary(failures),
        )
        members = servable.map((entry) => entry.account)
        coverage = coverageOf(
          servable,
          built.models.map((model) => model.id),
          members.map((account) => account.id),
        )
      } else {
        built =
          spec.kind === 'builtin'
            ? buildBuiltinCatalog(spec)
            : await buildCommandCodeCatalog(spec, log)
        members = readable.map((entry) => entry.account)
        const ids = members.map((account) => account.id)
        coverage = new Map(built.models.map((model) => [model.id, ids]))
      }
    } catch (error) {
      if (error instanceof ConfigError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      if (error instanceof CatalogError) {
        log.error('more-providers: %s model catalog failed: %o', spec.route, error.cause)
        reports.set(
          spec.route,
          routeReport(spec.route, false, undefined, { error: reason, catalogError: reason }),
        )
        continue
      }
      log.error('more-providers: %s could not be built: %o', spec.route, error)
      reports.set(spec.route, routeReport(spec.route, false, undefined, { error: reason }))
      continue
    }
    if (built.models.length === 0) {
      const reason = emptyReason(built)
      const message = 'more-providers: %s has no effective models (%s); route stays unregistered'
      if (built.catalogError === undefined) log.warn(message, spec.route, reason)
      else log.error(message, spec.route, reason)
      reports.set(spec.route, routeReport(spec.route, false, built, { error: reason }))
      continue
    }
    registerRoute(spec, built, members, coverage, profiles, accounts)
    reports.set(spec.route, routeReport(spec.route, true, built))
  }
  return { profiles, accounts, reports, ...(chatgpt === undefined ? {} : { chatgpt }) }
}

/** The live plugin-side registration one plugin instance owns; every applied generation replaces its adapter. */
export interface Registry {
  /** The ChatGPT view of the mounted generation, if the configuration has one. */
  chatGptView(): ChatGptStatusView | undefined
  /** Install one built generation: atomic route replacement, carried-over pool health, OAuth remount. */
  apply(outcome: BuildOutcome): void
}

/** One mounted OAuth generation: its view plus what a reload has to release. */
interface ChatGptMount {
  view(): ChatGptStatusView | undefined
  dispose(): void
}

function poolsOf(outcome: BuildOutcome | undefined): ReadonlyMap<string, AccountPool> {
  const pools = new Map<string, AccountPool>()
  for (const [route, entry] of outcome?.accounts ?? []) {
    if (entry.pool !== undefined) pools.set(route, entry.pool)
  }
  return pools
}

/** Mount one ChatGPT generation; the credentials-gated registration can still be pending when apply returns. */
function mountChatGpt(
  ctx: Context,
  spec: ChatGptProviderSpec,
  plumbing: { tokens: OAuthProvidersService; channel: AuthChannel; images: ProviderImageServices },
): ChatGptMount {
  let registration: ChatGptRegistration | undefined
  let disposed = false
  ctx.inject(['credentials'], (oauthCtx) => {
    if (disposed) return
    registration = registerChatGpt(oauthCtx, {
      channel: plumbing.channel,
      displayName: spec.displayName,
      tokens: plumbing.tokens,
      config: spec.config,
      images: plumbing.images,
    })
  })
  return {
    view: () => registration?.view,
    dispose: () => {
      disposed = true
      registration?.dispose()
      registration = undefined
      plumbing.tokens.unregister(spec.route)
    },
  }
}

/** One installed generation: the live adapter, its route set, and the OAuth mount beside it. */
interface Generation {
  routes: string[]
  adapter: FailoverPiAiAdapter | undefined
  handle: AdapterRegistrationHandle | undefined
  chatgptSpec?: ChatGptProviderSpec
  chatgpt?: ChatGptMount
}

/**
 * The plugin's registration across reloads. Each generation gets a fresh failover adapter
 * whose profiles and pools are immutable; a reload swaps generations synchronously and
 * restores the previous one when the new route set is refused.
 */
export function createRegistry(ctx: Context, deps: RegistryDeps): Registry {
  const accounts = new Map<string, RouteAccounts>()
  let keyService: ProviderKeys | undefined
  let current: BuildOutcome | undefined
  let generation: Generation | undefined
  let tokens: OAuthProvidersService | undefined
  let channel: AuthChannel | undefined

  const adapterFor = (outcome: BuildOutcome): FailoverPiAiAdapter =>
    new FailoverPiAiAdapter({
      ...deps.images,
      profiles: () => outcome.profiles,
      resolveApiKey: async (provider) => keyService?.key(provider),
      auth: AUTH,
      pools: () => poolsOf(outcome),
    })

  const plumbing = (): { tokens: OAuthProvidersService; channel: AuthChannel } => {
    tokens ??= new OAuthProvidersService(ctx)
    channel ??= registerAuthChannel(ctx)
    return { tokens, channel }
  }

  const mount = (spec: ChatGptProviderSpec): ChatGptMount =>
    mountChatGpt(ctx, spec, { ...plumbing(), images: deps.images })

  /** Put the previous adapter back after a refused generation; returns why that failed, if it did. */
  const restoreAdapter = (previous: Generation): string | undefined => {
    if (previous.adapter === undefined || previous.routes.length === 0) return undefined
    try {
      previous.handle = ctx.llm.registerAdapter(previous.routes, previous.adapter)
      return undefined
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const apply = (outcome: BuildOutcome): void => {
    for (const [route, entry] of outcome.accounts) {
      const previous = current?.accounts.get(route)?.pool
      if (previous !== undefined && entry.pool !== undefined) {
        adoptPoolHealth(entry.pool, previous)
      }
    }
    keyService ??= new ProviderKeys(ctx, accounts)
    const routes = [...outcome.profiles.keys()]
    const nextAdapter = routes.length === 0 ? undefined : adapterFor(outcome)
    const previous = generation
    previous?.handle?.()
    if (previous !== undefined) previous.handle = undefined
    let handle: AdapterRegistrationHandle | undefined
    try {
      handle =
        routes.length === 0 || nextAdapter === undefined
          ? undefined
          : ctx.llm.registerAdapter(routes, nextAdapter)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const restoreFailure = previous === undefined ? undefined : restoreAdapter(previous)
      const restored =
        previous === undefined || restoreFailure !== undefined
          ? `the previous registration could not be restored: ${restoreFailure ?? 'nothing was registered before'}`
          : 'the previous registration was restored'
      throw new Error(`more-providers: the new route set was refused (${reason}); ${restored}`, {
        cause: error,
      })
    }

    accounts.clear()
    for (const [route, entry] of outcome.accounts) accounts.set(route, entry)
    current = outcome
    previous?.chatgpt?.dispose()
    const chatgpt = outcome.chatgpt === undefined ? undefined : mount(outcome.chatgpt)
    generation = {
      routes,
      adapter: nextAdapter,
      handle,
      ...(outcome.chatgpt === undefined ? {} : { chatgptSpec: outcome.chatgpt }),
      ...(chatgpt === undefined ? {} : { chatgpt }),
    }
    ctx.emit('llm/adapters-updated')
  }

  ctx.effect(
    () => () => {
      generation?.chatgpt?.dispose()
      generation?.handle?.()
      generation = undefined
      accounts.clear()
      current = undefined
    },
    'more-providers registration',
  )

  return { apply, chatGptView: () => generation?.chatgpt?.view() }
}
