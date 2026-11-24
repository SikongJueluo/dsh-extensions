import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalizeWatchPath, dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { parse } from 'yaml'

/** Why a config file has no usable value. Consumers switch on this instead of matching error text. */
export type ConfigFailure = 'missing' | 'unreadable' | 'invalid'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** A file that could not be read at all: absent (`missing`) or present but unreadable. */
export class ConfigReadError extends ConfigError {
  readonly failure: 'missing' | 'unreadable'

  constructor(message: string, failure: 'missing' | 'unreadable') {
    super(message)
    this.name = 'ConfigReadError'
    this.failure = failure
  }
}

export interface ConfigFileOptions {
  filename: string

  configFile?: string
}

export interface ConfigState<T> {
  readonly file: string

  readonly loaded: boolean

  readonly revision: number

  readonly value: T | undefined

  readonly error: string | undefined

  readonly reason?: ConfigFailure
}

export interface ConfigStore<T> {
  readonly file: string

  readonly ready: Promise<ConfigState<T>>
  state(): ConfigState<T>

  get(): T | undefined

  subscribe(listener: (state: ConfigState<T>) => void): () => void

  reportFailure(error: string): void

  dispose(): Promise<void>
}

export interface ConfigLogger {
  warn(message: string, ...args: unknown[]): void
}

export interface ConfigOptions<T> extends ConfigFileOptions {
  validate(value: unknown): T

  watch?: boolean

  logger?: ConfigLogger
}

const RELOAD_DEBOUNCE_MS = 80

/** Change-detection key: JSON plus the values plain serialization drops or flattens to `{}`. */
function fingerprintOf(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof RegExp) return { regexp: entry.source, flags: entry.flags }
    if (entry instanceof Map) return { map: [...entry.entries()] }
    return entry
  })
}

export function resolveConfigFile(options: ConfigFileOptions): string {
  const explicit = options.configFile?.trim()
  if (explicit !== undefined && explicit !== '') {
    const expanded = expandHomePath(explicit)
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  return dshHomePath(options.filename)
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const single = message.replaceAll(/\s+/gu, ' ').trim()
  return single.length > 500 ? `${single.slice(0, 497)}…` : single
}

function failureOf(error: unknown): 'missing' | 'unreadable' {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
    ? 'missing'
    : 'unreadable'
}

export async function readConfigFile<T>(file: string, validate: (value: unknown) => T): Promise<T> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new ConfigReadError(`cannot read the file: ${reasonOf(error)}`, failureOf(error))
  }
  let value: unknown
  try {
    value = parse(text)
  } catch (error) {
    throw new ConfigError(`invalid YAML: ${reasonOf(error)}`)
  }
  return validate(value)
}

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

  const publish = (
    value: T | undefined,
    error: string | undefined,
    reason?: ConfigFailure,
  ): void => {
    const next =
      value === undefined ? `!${reason ?? ''}:${error ?? ''}` : `=${fingerprintOf(value)}`
    if (current.loaded && next === fingerprint) return
    fingerprint = next
    current = {
      file,
      loaded: true,
      revision: current.revision + 1,
      value,
      error,
      ...(reason === undefined ? {} : { reason }),
    }
    for (const listener of listeners) listener(current)
  }

  const reload = async (): Promise<ConfigState<T>> => {
    const mine = ++generation
    let value: T | undefined
    let error: string | undefined
    let reason: ConfigFailure | undefined
    try {
      value = await readConfigFile(file, (document) => options.validate(document))
    } catch (failure) {
      error = reasonOf(failure)
      reason = failure instanceof ConfigReadError ? failure.failure : 'invalid'
    }
    if (!disposed && mine === generation) publish(value, error, reason)
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
      if (!disposed) publish(undefined, reasonOf(error), 'invalid')
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

export interface ConfigInstanceStatus {
  id: number

  title: string

  file: string
  state: 'loading' | 'valid' | 'invalid'

  error?: string
  revision: number

  recovery: 'auto' | 'restart'
}

export interface ConfigStatusPayload {
  instances: ConfigInstanceStatus[]
}

export interface ConfigStatusRouteOptions {
  prefix: string

  title: string

  recovery: 'auto' | 'restart'
  store: ConfigStore<unknown>
}

interface StatusClient {
  id: number
  store: ConfigStore<unknown>
  title: string
  recovery: 'auto' | 'restart'
  webServer?: Context['webServer']
}

interface StatusHub {
  clients: Map<number, StatusClient>
  route?: { ownerId: number; dispose: () => void }
  nextId: number
}

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
