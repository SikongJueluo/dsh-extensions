import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigError,
  registerConfig,
  registerConfigStatusRoute,
  resolveConfigFile,
  type ConfigState,
  type ConfigStatusPayload,
  type ConfigStore,
} from '../src/index.js'

interface NamePolicy {
  name: string
}

function validateName(value: unknown): NamePolicy {
  if (typeof value !== 'object' || value === null)
    throw new ConfigError('config: expected an object')
  const name = (value as { name?: unknown }).name
  if (typeof name !== 'string' || name.trim() === '')
    throw new ConfigError('config.name: expected a non-empty string')
  return { name }
}

function fakeContext() {
  const ctx = {
    effect(callback: () => unknown) {
      callback()
    },
  }
  return { ctx: ctx as unknown as Context }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await new Promise<void>((settle) => {
      setTimeout(settle, 5)
    })
  }
  throw new Error(`timed out waiting for ${what}`)
}

const sleep = (ms: number) =>
  new Promise<void>((settle) => {
    setTimeout(settle, ms)
  })

const directories: string[] = []
async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-config-'))
  directories.push(directory)
  return directory
}

const stores: ConfigStore<NamePolicy>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function watchedStore(file: string, watchChanges = true) {
  const { ctx } = fakeContext()
  const store = registerConfig(ctx, {
    filename: 'test.yaml',
    configFile: file,
    validate: validateName,
    watch: watchChanges,
  })
  stores.push(store)
  return store
}

describe('resolveConfigFile', () => {
  it('uses $DSH_HOME/<filename> when the plugin row names no path', () => {
    expect(resolveConfigFile({ filename: 'crew.yaml' })).toBe(dshHomePath('crew.yaml'))
  })

  it('resolves a relative explicit path against the process cwd', () => {
    expect(resolveConfigFile({ filename: 'crew.yaml', configFile: '.tmp/crew.yaml' })).toBe(
      resolve('.tmp/crew.yaml'),
    )
  })

  it('expands a home-relative explicit path', () => {
    expect(resolveConfigFile({ filename: 'crew.yaml', configFile: '~/crew.yaml' })).toBe(
      join(homedir(), 'crew.yaml'),
    )
  })
})

describe('config store', () => {
  it('reports a missing file as invalid and recovers when it appears', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    const store = await watchedStore(file)
    const initial = await store.ready
    expect(initial.loaded).toBe(true)
    expect(initial.value).toBeUndefined()
    expect(initial.error).toContain('cannot read the file')
    expect(initial.revision).toBe(1)

    await writeFile(file, 'name: first\n')
    await waitFor(() => store.get()?.name === 'first', 'the created file to load')
    expect(store.state().error).toBeUndefined()
    expect(store.state().revision).toBe(2)
  })

  it('rejects invalid YAML, then a validator error, then recovers', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: [unclosed\n')
    const store = await watchedStore(file)
    expect((await store.ready).error).toContain('invalid YAML')
    expect(store.get()).toBeUndefined()

    await writeFile(file, 'other: 1\n')
    await waitFor(() => store.state().revision === 2, 'the validator error')
    expect(store.state().error).toContain('config.name')

    await writeFile(file, 'name: fixed\n')
    await waitFor(() => store.get()?.name === 'fixed', 'the repaired file')
    expect(store.state().error).toBeUndefined()
    expect(store.state().revision).toBe(3)
  })

  it('reloads an in-place write and an atomic replacement', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: one\n')
    const store = await watchedStore(file)
    expect((await store.ready).value).toEqual({ name: 'one' })

    await writeFile(file, 'name: two\n')
    await waitFor(() => store.get()?.name === 'two', 'the in-place write')

    const staged = join(directory, 'staged.yaml')
    await writeFile(staged, 'name: three\n')
    await rename(staged, file)
    await waitFor(() => store.get()?.name === 'three', 'the atomic replacement')
  })

  it('reports deletion and then recreation', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: alive\n')
    const store = await watchedStore(file)
    expect((await store.ready).value).toEqual({ name: 'alive' })

    await rm(file)
    await waitFor(() => store.state().error?.includes('cannot read') === true, 'the deletion')

    await writeFile(file, 'name: back\n')
    await waitFor(() => store.get()?.name === 'back', 'the recreation')
  })

  it('does not publish or bump the revision when the policy is unchanged', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: same\n')
    const store = await watchedStore(file)
    await store.ready
    const revision = store.state().revision

    await writeFile(file, '# a comment-only edit\nname: same\n')
    await sleep(300)
    expect(store.state().revision).toBe(revision)
  })

  it('notifies subscribers and stops after dispose', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: watched\n')
    const store = await watchedStore(file)
    await store.ready
    const seen: ConfigState<NamePolicy>[] = []
    const unsubscribe = store.subscribe((state) => {
      seen.push(state)
    })

    await writeFile(file, 'name: notified\n')
    await waitFor(() => seen.length > 0, 'the change notification')
    expect(seen.at(-1)?.value).toEqual({ name: 'notified' })

    unsubscribe()
    await writeFile(file, 'name: after-unsubscribe\n')
    await sleep(300)
    expect(seen).toHaveLength(1)

    await store.dispose()
    const revision = store.state().revision
    await writeFile(file, 'name: after-dispose\n')
    await sleep(300)
    expect(store.state().revision).toBe(revision)
  })

  it('never publishes a read that finishes after dispose', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: raced\n')
    const { ctx } = fakeContext()
    const store = registerConfig(ctx, {
      filename: 'test.yaml',
      configFile: file,
      validate: validateName,
    })
    stores.push(store)
    await store.dispose()
    await sleep(50)
    expect(store.state().loaded).toBe(false)
    expect(store.state().revision).toBe(0)
  })

  it('without watching, reads once and ignores later writes', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: once\n')
    const store = await watchedStore(file, false)
    expect((await store.ready).value).toEqual({ name: 'once' })
    await writeFile(file, 'name: later\n')
    await sleep(300)
    expect(store.get()?.name).toBe('once')
  })
})

describe('status route', () => {
  it('serves the current state with its recovery mode', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: [broken\n')
    const store = await watchedStore(file)
    await store.ready

    let resource: (() => Promise<Response>) | undefined
    let cleanup: (() => void) | undefined
    const ctx = {
      effect(run: () => unknown) {
        const dispose = run()
        if (typeof dispose === 'function') cleanup = dispose as () => void
      },
      inject(_dependencies: string[], onReady: (scoped: unknown) => void) {
        onReady({
          effect: (run: () => unknown) => run(),
          webServer: {
            register(route: { path: string; resource: () => Promise<Response> }) {
              expect(route.path).toBe('/dsh-test-single/config-status')
              resource = route.resource
              return () => {}
            },
          },
        })
      },
    }
    registerConfigStatusRoute(ctx as unknown as Context, {
      prefix: '/dsh-test-single',
      title: 'Test plugin',
      recovery: 'restart',
      store,
    })
    expect(resource).toBeDefined()
    const payload = (
      await (resource as () => Promise<Response>)()
    ).json() as Promise<ConfigStatusPayload>
    const status = await payload
    expect(status.instances).toHaveLength(1)
    expect(status.instances[0]).toMatchObject({
      id: 1,
      title: 'Test plugin',
      file,
      state: 'invalid',
      recovery: 'restart',
      revision: 1,
    })
    expect(status.instances[0]?.error).toContain('invalid YAML')
    cleanup?.()
  })
})

describe('runtime failure reporting', () => {
  it('makes a valid store unusable and visible in the status payload', async () => {
    const directory = await tempDirectory()
    const file = join(directory, 'test.yaml')
    await writeFile(file, 'name: valid\n')
    const store = await watchedStore(file)
    await store.ready
    const revision = store.state().revision

    store.reportFailure('providers.p: unknown builtin catalog "nope"')
    expect(store.get()).toBeUndefined()
    expect(store.state().error).toContain('unknown builtin catalog')
    expect(store.state().revision).toBe(revision + 1)
  })
})

interface StubRoute {
  kind: string
  path: string
  resource: () => Promise<Response>
}

/** A real Cordis service implementing only what the status route registers. */
class FakeWebServer extends Service {
  readonly routes = new Map<string, StubRoute>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: StubRoute): () => void {
    if (this.routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
    this.routes.set(route.path, route)
    return () => {
      this.routes.delete(route.path)
    }
  }
}

async function statusOf(route: StubRoute): Promise<ConfigStatusPayload> {
  return (await (await route.resource()).json()) as Promise<ConfigStatusPayload>
}

describe('status route across plugin instances', () => {
  it('aggregates instances and re-registers the one route when its owner unloads', async () => {
    const directory = await tempDirectory()
    const firstFile = join(directory, 'first.yaml')
    const secondFile = join(directory, 'second.yaml')
    await writeFile(firstFile, 'name: first\n')
    await writeFile(secondFile, 'name: [broken\n')

    const root = new Context()
    const server = new FakeWebServer(root)
    const load = (file: string) =>
      root.plugin(async (ctx) => {
        const store = registerConfig(ctx, {
          filename: 'test.yaml',
          configFile: file,
          validate: validateName,
        })
        await store.ready
        registerConfigStatusRoute(ctx, {
          prefix: '/dsh-test-multi',
          title: 'Test plugin',
          recovery: 'auto',
          store,
        })
      })

    const first = load(firstFile)
    await first
    const second = load(secondFile)
    await second
    await waitFor(() => server.routes.size === 1, 'one shared route')

    const firstRoute = server.routes.get('/dsh-test-multi/config-status')
    if (firstRoute === undefined) throw new Error('the status route was not registered')
    const both = await statusOf(firstRoute)
    expect(both.instances).toHaveLength(2)
    expect(both.instances.map((instance) => instance.state).toSorted()).toEqual([
      'invalid',
      'valid',
    ])

    // The first instance owned the route; its unload must hand the same path to
    // the survivor instead of leaving a hole.
    await first.dispose()
    await waitFor(() => server.routes.size === 1, 'the route handoff')
    const survivorRoute = server.routes.get('/dsh-test-multi/config-status')
    if (survivorRoute === undefined) throw new Error('the handoff route was not registered')
    const remaining = await statusOf(survivorRoute)
    expect(remaining.instances).toHaveLength(1)
    expect(remaining.instances[0]?.state).toBe('invalid')

    await second.dispose()
    await waitFor(() => server.routes.size === 0, 'the route removal')
    await root.fiber.dispose()
  })
})
