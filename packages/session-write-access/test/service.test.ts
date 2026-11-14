import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { Config } from '../src/config.js'
import { SessionWriteAccessPolicy } from '../src/service.js'

class MemoryTable<V> {
  readonly map = new Map<string, V>()

  get(key: string): V | undefined {
    return this.map.get(key)
  }

  async put(key: string, value: V): Promise<void> {
    this.map.set(key, value)
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries()
  }
}

/** The smallest storage-domain facility the policy needs. */
function fakeStorageFacility() {
  const tables = new Map<string, MemoryTable<unknown>>()
  const specTables = new Map<string, string[]>()
  const domain = {
    name: 'session-write-access',
    table(name: string) {
      let table = tables.get(name)
      if (table === undefined) {
        table = new MemoryTable<unknown>()
        tables.set(name, table)
      }
      return table
    },
    async close() {},
  }
  return {
    get: () => undefined,
    open: async (spec: DomainSpec) => {
      specTables.set(spec.name, Object.keys(spec.tables))
      return domain
    },
  }
}

function fakeSessionQuery(headers: Map<string, Record<string, unknown>>) {
  return {
    observeSession: async (id: string) => {
      const header = headers.get(id)
      if (header === undefined) throw new Error('not found')
      return { header, events: [] }
    },
  }
}

async function mount(options: {
  workspace: string
  protectedRoots?: string[]
  headers?: Map<string, Record<string, unknown>>
}) {
  const ctx = new Context()
  const storage = fakeStorageFacility()
  const sessions = options.headers ?? new Map()
  const routes: Array<{ kind: string; path: string }> = []
  ctx.provide('storageDomain', storage)
  ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => null }) })
  ctx.provide('sessionQuery', fakeSessionQuery(sessions))
  ctx.provide('connection', { requestRejection: () => undefined })
  ctx.provide('webServer', {
    register(route: { kind: string; path: string }) {
      routes.push(route)
      return () => {}
    },
  })
  const config = Config({
    mode: 'workspace-write',
    workspaceRoot: options.workspace,
    additionalWritableRoots: [],
    protectedPaths: options.protectedRoots ?? [],
    protectHomeData: false,
    protectPluginCode: false,
  })
  await ctx.plugin(SessionWriteAccessPolicy, config)
  const service = ctx.get('sandboxPolicy') as SessionWriteAccessPolicy
  return { ctx, service, storage, routes }
}

describe('SessionWriteAccessPolicy mounting', () => {
  it('mounts as sandboxPolicy, attributes a root session, and resolves its scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-service-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service, routes } = await mount({ workspace })
    expect(routes.some(route => route.kind === 'prefix' && route.path === '/dsh-session-write-access')).toBe(true)
    const session = { id: 'root', header: { cwd: workspace, isSeeded: false } }
    await ctx.serial('agent/created', { agent: { session }, source: 'fresh' } as never)
    expect(service.view('root').groupId).toBe('root')
    const before = service.resolve({ session: { id: 'root', header: { cwd: workspace } } } as never)
    expect(before.mode).toBe('workspace-write')
    expect(before.workspaceRoot).toBe(workspace)
    expect(before.additionalWritableRoots).toBeUndefined()
    await service.addDirectory('root', extra)
    const after = service.resolve({ session: { id: 'root', header: { cwd: workspace } } } as never)
    expect(after.additionalWritableRoots).toEqual([extra])
  })

  it('gives a local child the family workspace and grants, never its own cwd', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-service-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    const childCwd = join(root, 'child-cwd')
    for (const path of [workspace, extra, childCwd]) mkdirSync(path)
    const { ctx, service } = await mount({ workspace })
    await ctx.serial('agent/created', { agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } }, source: 'fresh' } as never)
    await service.addDirectory('root', extra)
    await ctx.serial('agent/created', {
      agent: { session: { id: 'child', header: { cwd: childCwd, parentSession: 'root', origin: 'subagent', isSeeded: false } } },
      source: 'fresh',
    } as never)
    const policy = service.resolve({ session: { id: 'child', header: { cwd: childCwd } } } as never)
    expect(policy.workspaceRoot).toBe(workspace)
    expect(policy.additionalWritableRoots).toEqual([extra])
  })

  it('refuses to mount when the deployment workspace overlaps a protected path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-service-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const ctx = new Context()
    ctx.provide('storageDomain', fakeStorageFacility())
    ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => null }) })
    const config = Config({
      mode: 'workspace-write',
      workspaceRoot: workspace,
      protectedPaths: [root],
      protectHomeData: false,
      protectPluginCode: false,
    })
    await expect(ctx.plugin(SessionWriteAccessPolicy, config)).rejects.toThrow(/overlaps protected/)
  })
})

describe('SessionWriteAccessPolicy fork integration', () => {
  function preStep(ctx: Context, sessionId: string) {
    return ctx.waterfall(
      'agent/pre-step',
      {
        agent: { session: { id: sessionId } },
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
        modelSelection: { provider: 'p', model: 'm' },
      } as never,
      async () => ({ kind: 'enter' as const }),
    )
  }

  it('holds a seeded creation during the host Fork, then inherits the click-time grants', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-fork-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service } = await mount({ workspace })
    await ctx.serial('agent/created', { agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } }, source: 'fresh' } as never)
    await service.addDirectory('root', extra)

    let during: unknown
    ctx.provide('sessionController', {
      fork: async () => {
        const child = { id: 'forked', header: { cwd: workspace, isSeeded: true } }
        await ctx.serial('agent/created', { agent: { session: child }, source: 'fork' } as never)
        during = await preStep(ctx, 'forked')
        return { sessionId: 'forked' }
      },
    })
    const created = await service.forkSession('root')
    expect(created.sessionId).toBe('forked')
    expect(during).toEqual({ kind: 'reject' })
    expect(service.view('forked').grants.map(grant => grant.path)).toEqual([extra])
    expect((await preStep(ctx, 'forked')).kind).toBe('enter')
  })

  it('keeps a session created by a failed Fork safe and ungranted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-fork-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service } = await mount({ workspace })
    await ctx.serial('agent/created', { agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } }, source: 'fresh' } as never)
    await service.addDirectory('root', extra)
    ctx.provide('sessionController', {
      fork: async () => {
        await ctx.serial('agent/created', {
          agent: { session: { id: 'orphan', header: { cwd: workspace, isSeeded: true } } },
          source: 'fork',
        } as never)
        throw new Error('workspace attach failed')
      },
    })
    await expect(service.forkSession('root')).rejects.toThrow('workspace attach failed')
    expect(service.view('orphan').grants).toEqual([])
    expect(service.view('root').grants.map(grant => grant.path)).toEqual([extra])
    expect(service.view('root').forks[0]?.stage).toBe('failed')
  })
})
