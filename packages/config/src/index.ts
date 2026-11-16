/**
 * Shared external-configuration loader for this repository's Host plugins.
 *
 * A plugin registers one file definition: its default name under `$DSH_HOME`,
 * an optional explicit path from its plugin row, and a validator that owns the
 * plugin's schema. The loader owns everything around that validator — path
 * resolution, YAML reading, the published state (valid value or the reason the
 * file is unusable), optional watching, revision counting, and a read-only
 * status route the browser half can poll.
 *
 * Configuration is fail-closed: when the file is missing or invalid, `get()`
 * returns `undefined` and the plugin must refuse the work that depends on it.
 * There is deliberately no last-known-good fallback. The store publishes only
 * when the validated value (or the error) actually changes, so a save that
 * leaves the policy untouched does not disturb in-flight work.
 *
 * The validator returns JSON data. That is the store's fingerprint contract:
 * equal values mean equal policy, and the revision changes only for a real
 * change.
 *
 * @module @dsh-extensions/config
 */
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalizeWatchPath, dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { parse } from 'yaml'

/** A configuration problem that is reported to the user as a reason, not a stack. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Where a plugin's file lives and what it is called. */
export interface ConfigFileOptions {
  /** File name under `$DSH_HOME` when the plugin row names no path. */
  filename: string
  /** Explicit path from the plugin row; relative paths resolve against the process cwd. */
  configFile?: string
}

/** The published state of one external configuration file. */
export interface ConfigState<T> {
  /** Absolute path the store reads. */
  readonly file: string
  /** Whether the first read has completed. */
  readonly loaded: boolean
  /** Monotonic version of the published state; 0 before the first read. */
  readonly revision: number
  /** The validated value, or `undefined` when the file is not usable. */
  readonly value: T | undefined
  /** Why the file is not usable, or `undefined` when it is valid. */
  readonly error: string | undefined
}

/** Read-only handle a plugin holds for its configuration file. */
export interface ConfigStore<T> {
  /** Absolute path the store reads. */
  readonly file: string
  /** Resolves with the first published state; never rejects. */
  readonly ready: Promise<ConfigState<T>>
  state(): ConfigState<T>
  /** The validated value, or `undefined` while unloaded or invalid. */
  get(): T | undefined
  /** Subscribe to published changes; returns the exact unsubscribe function. */
  subscribe(listener: (state: ConfigState<T>) => void): () => void
  /**
   * Publish a failure the file itself cannot express, such as a startup build
   * error discovered after the document validated. The store becomes unusable
   * until a later successful read replaces the state.
   */
  reportFailure(error: string): void
  /** Stop reading and watching; later file changes are never published. */
  dispose(): Promise<void>
}

/** The logger surface the loader needs; a Cordis logger satisfies it. */
export interface ConfigLogger {
  warn(message: string, ...args: unknown[]): void
}

/** One plugin's registration. */
export interface ConfigOptions<T> extends ConfigFileOptions {
  /** Parse and validate one YAML document; throw {@link ConfigError} on a problem. */
  validate(value: unknown): T
  /** Watch the containing directory and reload after each change. @default false */
  watch?: boolean
  /** Receives watcher setup failures; the plugin's own logger. */
  logger?: ConfigLogger
}

/** Delay that collapses the several events one editor save produces. */
const RELOAD_DEBOUNCE_MS = 80

/** Resolve the absolute file path a plugin should read. */
export function resolveConfigFile(options: ConfigFileOptions): string {
  const explicit = options.configFile?.trim()
  if (explicit !== undefined && explicit !== '') {
    const expanded = expandHomePath(explicit)
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  return dshHomePath(options.filename)
}

/** A short single-line rendering of an error. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const single = message.replaceAll(/\s+/gu, ' ').trim()
  return single.length > 500 ? `${single.slice(0, 497)}…` : single
}

/** Read and validate one file. Every failure is a `ConfigError` with a user-facing reason. */
export async function readConfigFile<T>(file: string, validate: (value: unknown) => T): Promise<T> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new ConfigError(`cannot read the file: ${reasonOf(error)}`)
  }
  let value: unknown
  try {
    value = parse(text)
  } catch (error) {
    throw new ConfigError(`invalid YAML: ${reasonOf(error)}`)
  }
  return validate(value)
}

/**
 * Register one external configuration file.
 *
 * The first read starts immediately. When `watch` is set, the containing
 * directory is watched — not only the file — so an atomic replacement, a Nix
 * symlink swap, and delete-then-recreate all reload. Development files are
 * debounced; reads are serialized by a generation token, so an older read can
 * never overwrite a newer one.
 */
export function registerConfig<T>(ctx: Context, options: ConfigOptions<T>): ConfigStore<T> {
  const file = resolveConfigFile(options)
  const listeners = new Set<(state: ConfigState<T>) => void>()
  let current: ConfigState<T> = {
    file,
    loaded: false,
    revision: 0,
    value: undefined,
    error: undefined,
  }
  let fingerprint: string | undefined
  let generation = 0
  let disposed = false
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const publish = (value: T | undefined, error: string | undefined): void => {
    const next = value === undefined ? `!${error ?? ''}` : `=${JSON.stringify(value)}`
    if (current.loaded && next === fingerprint) return
    fingerprint = next
    current = { file, loaded: true, revision: current.revision + 1, value, error }
    for (const listener of listeners) listener(current)
  }

  const reload = async (): Promise<ConfigState<T>> => {
    const mine = ++generation
    let value: T | undefined
    let error: string | undefined
    try {
      value = await readConfigFile(file, (document) => options.validate(document))
    } catch (failure) {
      error = reasonOf(failure)
    }
    if (!disposed && mine === generation) publish(value, error)
    return current
  }

  const scheduleReload = (): void => {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void reload()
    }, RELOAD_DEBOUNCE_MS)
  }

  const armWatcher = async (): Promise<void> => {
    if (options.watch !== true || disposed) return
    let directory: string
    try {
      directory = await canonicalizeWatchPath(dirname(file))
    } catch (error) {
      options.logger?.warn(
        'config: cannot resolve %s for watching: %s',
        dirname(file),
        reasonOf(error),
      )
      return
    }
    if (disposed) return
    try {
      watcher = watch(directory, { persistent: false }, (_event, changed) => {
        // `null` is a directory-level event; name the target whenever the
        // backend provides one so sibling writes never reload this file.
        if (changed !== null && changed !== basename(file)) return
        scheduleReload()
      })
      watcher.on('error', (error: unknown) => {
        options.logger?.warn(
          'config: stopped watching %s for %s: %s',
          directory,
          basename(file),
          reasonOf(error),
        )
        watcher?.close()
        watcher = undefined
      })
    } catch (error) {
      options.logger?.warn(
        'config: cannot watch %s for %s changes: %s',
        directory,
        basename(file),
        reasonOf(error),
      )
    }
  }

  const ready = reload().then((state) => {
    void armWatcher()
    return state
  })

  const store: ConfigStore<T> = {
    file,
    ready,
    state: () => current,
    get: () => current.value,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    reportFailure(error) {
      if (!disposed) publish(undefined, reasonOf(error))
    },
    async dispose() {
      disposed = true
      generation += 1
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      watcher?.close()
      watcher = undefined
      listeners.clear()
    },
  }

  ctx.effect(() => () => store.dispose(), `config:${basename(file)}`)
  return store
}

/** One plugin instance's current state as the browser half reads it. */
export interface ConfigInstanceStatus {
  /** Process-local instance id, for diagnostics and stable ordering. */
  id: number
  /** Display name of the owning plugin. */
  title: string
  /** Absolute path of the file. */
  file: string
  state: 'loading' | 'valid' | 'invalid'
  /** Why the file is unusable; present when `state` is `invalid`. */
  error?: string
  revision: number
  /** Whether fixing the file recovers without a restart. */
  recovery: 'auto' | 'restart'
}

/** The aggregate one plugin's status route serves. */
export interface ConfigStatusPayload {
  /** Every live instance of the plugin, including preset generations. */
  instances: ConfigInstanceStatus[]
}

/** Where and how to serve one store's status. */
export interface ConfigStatusRouteOptions {
  /** Plugin route prefix, e.g. `/dsh-crew`; the status path is appended. */
  prefix: string
  /** Display name shown in the notice. */
  title: string
  /** `auto` when the plugin watches the file, `restart` when a fix needs a new process. */
  recovery: 'auto' | 'restart'
  store: ConfigStore<unknown>
}

/** One live registration behind a status route. */
interface StatusClient {
  id: number
  store: ConfigStore<unknown>
  title: string
  recovery: 'auto' | 'restart'
  webServer?: Context['webServer']
}

/** All registrations for one status path, plus the single route serving them. */
interface StatusHub {
  clients: Map<number, StatusClient>
  route?: { ownerId: number; dispose: () => void }
  nextId: number
}

/**
 * One hub per status path, process-wide. A plugin can be mounted several times
 * (agent presets eagerly activate each definition and keep an older generation
 * while sessions still use it), but the host rejects a second route for the
 * same path. The hub therefore owns exactly one route and aggregates every
 * live instance; when the route's owning instance unloads, a surviving
 * instance re-registers it.
 */
const statusHubs = new Map<string, StatusHub>()

function hubFor(path: string): StatusHub {
  const existing = statusHubs.get(path)
  if (existing !== undefined) return existing
  const hub: StatusHub = { clients: new Map(), nextId: 0 }
  statusHubs.set(path, hub)
  return hub
}

function instanceStatus(client: StatusClient): ConfigInstanceStatus {
  const state = client.store.state()
  return {
    id: client.id,
    title: client.title,
    file: state.file,
    state: !state.loaded ? 'loading' : state.value === undefined ? 'invalid' : 'valid',
    ...(state.error === undefined ? {} : { error: state.error }),
    revision: state.revision,
    recovery: client.recovery,
  }
}

/** Ensure the hub's one route exists, using any instance whose web server is ready. */
function ensureStatusRoute(hub: StatusHub, path: string): void {
  if (hub.route !== undefined || hub.clients.size === 0) return
  const owner = [...hub.clients.values()].find((client) => client.webServer !== undefined)
  if (owner?.webServer === undefined) return
  const server = owner.webServer
  const dispose = server.register({
    kind: 'exact',
    path,
    resource: async () =>
      new Response(
        JSON.stringify({
          instances: [...hub.clients.values()].map((client) => instanceStatus(client)),
        }),
        {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        },
      ),
  })
  hub.route = { ownerId: owner.id, dispose }
}

/**
 * Serve every live instance's status at `<prefix>/config-status`.
 *
 * The route is read-only host state: the browser half polls it on load and
 * after a reconnect, so an error that happened while the page was closed still
 * surfaces. Multiple plugin instances share one route and one aggregate
 * payload; the route moves to a surviving instance when its owner unloads.
 */
export function registerConfigStatusRoute(ctx: Context, options: ConfigStatusRouteOptions): void {
  const prefix = options.prefix.replace(/\/+$/u, '')
  if (!prefix.startsWith('/') || prefix === '/') {
    throw new Error(`config: status prefix must be an absolute path, got "${options.prefix}"`)
  }
  const path = `${prefix}/config-status`
  const hub = hubFor(path)
  const id = ++hub.nextId
  hub.clients.set(id, {
    id,
    store: options.store,
    title: options.title,
    recovery: options.recovery,
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
      if (hub.clients.size === 0) statusHubs.delete(path)
    },
    `${path} config status`,
  )
}
