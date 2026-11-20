/**
 * The read-only `/dsh-more-providers/providers` snapshot: one instance per mounted config, each reporting the routes the plugin assembled, so the settings page can show route, kind, accounts and the catalog outcome without reading the file.
 * @module dsh-more-providers/status
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ConfigState, ConfigStore } from '@dsh-extensions/config'

/** How one route authenticates: a YAML key source or the OAuth sign-in channel. */
export type ProviderAuth = 'api-key' | 'oauth'

/** The provider kinds the snapshot reports; `chatgpt` is the built-in OAuth route. */
export type ProviderKindStatus = 'builtin' | 'custom' | 'command-code' | 'chatgpt'

/** One account behind a route. Stage one has exactly one per route; stage two reports the pool. */
export interface ProviderAccountStatus {
  id: string
  displayName: string
  ready: boolean
  healthy?: boolean
  cooldownUntil?: number
}

/** A route's catalog outcome: what discovery offered and what the filter kept. */
export interface ProviderModelsStatus {
  discovered: number
  effective: number
  excluded: string[]
  notIncluded: string[]
}

/** One configured route as the settings page shows it. */
export interface ProviderStatus {
  route: string
  kind: ProviderKindStatus
  auth: ProviderAuth
  displayName: string
  enabled: boolean
  registered: boolean
  accounts: ProviderAccountStatus[]
  models?: ProviderModelsStatus
  catalogError?: string
  error?: string
}

/**
 * One config file instance and the routes it produced. `revision` counts published file states;
 * `appliedRevision` names the one actually serving, so it trails `revision` while a reload is in
 * flight or after the newest document failed to build.
 */
export interface ProvidersStatusInstance {
  id: string
  file: string
  state: 'ok' | 'invalid' | 'missing'
  error?: string
  revision: number
  appliedRevision?: number
  providers: ProviderStatus[]
}

/** The `GET /dsh-more-providers/providers` body; instances aggregate like `config-status` does. */
export interface ProvidersStatus {
  instances: ProvidersStatusInstance[]
}

/** Routes one instance reports, read fresh on every request. */
export type ProviderStatusSource = () => readonly ProviderStatus[]

interface StatusClient {
  id: number
  title: string
  store: ConfigStore<unknown>
  source: ProviderStatusSource
  applied?: () => number | undefined
  webServer?: Context['webServer']
}

interface StatusHub {
  clients: Map<number, StatusClient>
  route?: { ownerId: number; dispose: () => void }
  nextId: number
}

const hubs = new Map<string, StatusHub>()

function hubFor(path: string): StatusHub {
  const existing = hubs.get(path)
  if (existing !== undefined) return existing
  const hub: StatusHub = { clients: new Map(), nextId: 0 }
  hubs.set(path, hub)
  return hub
}

/** The payload's three states, from the store's own failure reason rather than its message text. */
function instanceState(state: ConfigState<unknown>): ProvidersStatusInstance['state'] {
  if (state.value !== undefined) return 'ok'
  return state.reason === 'missing' ? 'missing' : 'invalid'
}

function instanceStatus(client: StatusClient): ProvidersStatusInstance {
  const state = client.store.state()
  const instance: ProvidersStatusInstance = {
    id: `${client.title}#${String(client.id)}`,
    file: state.file,
    state: instanceState(state),
    revision: state.revision,
    providers: [...client.source()],
  }
  if (state.error !== undefined) instance.error = state.error
  const applied = client.applied?.()
  if (applied !== undefined) instance.appliedRevision = applied
  return instance
}

function ensureStatusRoute(hub: StatusHub, path: string): void {
  if (hub.route !== undefined || hub.clients.size === 0) return
  const owner = [...hub.clients.values()].find((client) => client.webServer !== undefined)
  if (owner?.webServer === undefined) return
  const server = owner.webServer
  const dispose = server.register({
    kind: 'exact',
    path,
    resource: async () => {
      await Promise.all([...hub.clients.values()].map((client) => client.store.ready))
      return new Response(
        JSON.stringify({
          instances: [...hub.clients.values()].map((client) => instanceStatus(client)),
        }),
        {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        },
      )
    },
  })
  hub.route = { ownerId: owner.id, dispose }
}

/** Where one mounted instance reports its routes from, including the revision it has actually applied. */
export interface ProvidersStatusOptions {
  prefix: string
  title: string
  store: ConfigStore<unknown>
  source: ProviderStatusSource
  applied?: () => number | undefined
}

/** Serve `GET <prefix>/providers` for every mounted instance that shares the absolute prefix, for example `/dsh-more-providers`. */
export function registerProvidersStatusRoute(ctx: Context, options: ProvidersStatusOptions): void {
  const prefix = options.prefix.replace(/\/+$/u, '')
  if (!prefix.startsWith('/') || prefix === '/') {
    throw new Error(
      `more-providers: status prefix must be an absolute path, got "${options.prefix}"`,
    )
  }
  const path = `${prefix}/providers`
  const hub = hubFor(path)
  const id = ++hub.nextId
  hub.clients.set(id, {
    id,
    title: options.title,
    store: options.store,
    source: options.source,
    ...(options.applied === undefined ? {} : { applied: options.applied }),
  })

  ctx.inject(['webServer'], (svcCtx) => {
    const client = hub.clients.get(id)
    if (client === undefined) return
    client.webServer = svcCtx.webServer
    ensureStatusRoute(hub, path)
  })
  ctx.effect(
    () => () => {
      hub.clients.delete(id)
      if (hub.route?.ownerId === id) {
        hub.route.dispose()
        hub.route = undefined
        ensureStatusRoute(hub, path)
      }
      if (hub.clients.size === 0) hubs.delete(path)
    },
    `${path} providers status`,
  )
}
