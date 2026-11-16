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

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key)
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
    tables,
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
    tables,
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
  /** Omit to mount a deployment that states no fallback workspace root. */
  workspaceRoot?: string | null
  protectedRoots?: string[]
  headers?: Map<string, Record<string, unknown>>
  reject?: number
  sessionQuery?: {
    observeSession: (id: string) => Promise<{ header: Record<string, unknown>; events: unknown[] }>
  }
}) {
  const ctx = new Context()
  const storage = fakeStorageFacility()
  const sessions = options.headers ?? new Map()
  const routes: Array<{ kind: string; path: string }> = []
  const liveAgents = new Map<string, { session: { id: string; header: Record<string, unknown> } }>()
  ctx.provide('storageDomain', storage)
  ctx.provide('sessionProjections', { register: async () => ({ stateOf: () => null }) })
  ctx.provide('sessionQuery', options.sessionQuery ?? fakeSessionQuery(sessions))
  ctx.provide('agents', {
    list: () => [...liveAgents.values()],
    get: (id: string) => liveAgents.get(id),
  })
  ctx.provide('connection', { requestRejection: () => options.reject })
  ctx.provide('webServer', {
    register(route: { kind: string; path: string }) {
      routes.push(route)
      return () => {}
    },
  })
  const config = Config({
    mode: 'workspace-write',
    ...(options.workspaceRoot === null
      ? {}
      : { workspaceRoot: options.workspaceRoot ?? options.workspace }),
    additionalWritableRoots: [],
    protectedPaths: options.protectedRoots ?? [],
    protectHomeData: false,
    protectPluginCode: false,
  })
  await ctx.plugin(SessionWriteAccessPolicy, config)
  const service = ctx.get('sandboxPolicy') as SessionWriteAccessPolicy
  return { ctx, service, storage, routes, liveAgents }
}

describe('SessionWriteAccessPolicy mounting', () => {
  it('mounts as sandboxPolicy, attributes a root session, and resolves its scope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-service-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service, routes } = await mount({ workspace })
    expect(
      routes.some((route) => route.kind === 'prefix' && route.path === '/dsh-session-write-access'),
    ).toBe(true)
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
    await ctx.serial('agent/created', {
      agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } },
      source: 'fresh',
    } as never)
    await service.addDirectory('root', extra)
    await ctx.serial('agent/created', {
      agent: {
        session: {
          id: 'child',
          header: { cwd: childCwd, parentSession: 'root', origin: 'subagent', isSeeded: false },
        },
      },
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

  it('mounts and refuses cwd-less calls when the deployment states no fallback root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-service-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    // The host process runs inside a protected path: with no stated fallback
    // there is nothing to refuse at load, so the provider must still mount.
    const { service } = await mount({
      workspace,
      workspaceRoot: null,
      protectedRoots: [process.cwd()],
    })
    const cwdless = { id: 'agentless', header: {} } as never
    expect(() => service.resolve({ session: cwdless })).toThrow(/no workspaceRoot/)
    // A call that carries a session cwd keeps working.
    const stated = service.resolve({ session: { id: 'root', header: { cwd: workspace } } as never })
    expect(stated.mode).toBe('workspace-write')
  })
})

describe('SessionWriteAccessPolicy live-child attribution', () => {
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

  it('waits for a slow parent lookup and never resolves the child cwd meanwhile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-live-'))
    const workspace = join(root, 'workspace')
    const childCwd = join(root, 'child-cwd')
    mkdirSync(workspace)
    mkdirSync(childCwd)
    let releaseParent: () => void = () => {}
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const childHeader = {
      cwd: childCwd,
      parentSession: 'root',
      origin: 'subagent',
      isSeeded: false,
    }
    const { ctx, service, liveAgents } = await mount({
      workspace,
      sessionQuery: {
        observeSession: async (id: string) => {
          if (id !== 'root') throw new Error('unknown session')
          await parentGate
          return { header: { cwd: workspace }, events: [] }
        },
      },
    })
    liveAgents.set('child', { session: { id: 'child', header: childHeader } })
    // The synchronous resolver must refuse, not fall back to child.cwd.
    expect(() =>
      service.resolve({ session: { id: 'child', header: childHeader } } as never),
    ).toThrow(/has no committed write-access group/)
    let settled = false
    const pending = preStep(ctx, 'child').then((decision: { kind: string }) => {
      settled = true
      return decision
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    releaseParent()
    expect((await pending).kind).toBe('enter')
    const policy = service.resolve({ session: { id: 'child', header: childHeader } } as never)
    expect(policy.workspaceRoot).toBe(workspace)
    expect(policy.workspaceRoot).not.toBe(childCwd)
  })

  it('rejects the step and keeps refusing resolve when attribution fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-live-'))
    const workspace = join(root, 'workspace')
    const childCwd = join(root, 'child-cwd')
    mkdirSync(workspace)
    mkdirSync(childCwd)
    const childHeader = {
      cwd: childCwd,
      parentSession: 'missing',
      origin: 'subagent',
      isSeeded: false,
    }
    const { ctx, service, liveAgents } = await mount({
      workspace,
      sessionQuery: {
        observeSession: async () => {
          throw new Error('session not found')
        },
      },
    })
    liveAgents.set('child', { session: { id: 'child', header: childHeader } })
    expect((await preStep(ctx, 'child')).kind).toBe('reject')
    expect(() =>
      service.resolve({ session: { id: 'child', header: childHeader } } as never),
    ).toThrow(/has no committed write-access group/)
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
    const { ctx, service, liveAgents } = await mount({ workspace })
    await ctx.serial('agent/created', {
      agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } },
      source: 'fresh',
    } as never)
    await service.addDirectory('root', extra)

    let during: unknown
    ctx.provide('sessionController', {
      fork: async () => {
        const child = { id: 'forked', header: { cwd: workspace, isSeeded: true } }
        liveAgents.set('forked', { session: child })
        await ctx.serial('agent/created', { agent: { session: child }, source: 'fork' } as never)
        during = await preStep(ctx, 'forked')
        return { sessionId: 'forked' }
      },
    })
    const created = await service.forkSession('root')
    expect(created.sessionId).toBe('forked')
    expect(during).toEqual({ kind: 'reject' })
    expect(service.view('forked').grants.map((grant) => grant.path)).toEqual([extra])
    expect((await preStep(ctx, 'forked')).kind).toBe('enter')
  })

  it('keeps a session created by a failed Fork safe and ungranted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-fork-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service } = await mount({ workspace })
    await ctx.serial('agent/created', {
      agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } },
      source: 'fresh',
    } as never)
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
    expect(service.view('root').grants.map((grant) => grant.path)).toEqual([extra])
    expect(service.view('root').forks[0]?.stage).toBe('failed')
  })
})

describe('SessionWriteAccessPolicy fork partial commit', () => {
  it('returns success when a failed final marker left the inherited grants durably applied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-fork-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service, storage, liveAgents } = await mount({ workspace })
    await ctx.serial('agent/created', {
      agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } },
      source: 'fresh',
    } as never)
    await service.addDirectory('root', extra)
    const forks = storage.tables.get('forks') as unknown as {
      put: (key: string, value: { stage?: string }) => Promise<void>
      get: (key: string) => { stage?: string } | undefined
    }
    const put = forks.put.bind(forks)
    let failMarker = true
    forks.put = async (key, value) => {
      if (value.stage === 'committed' && failMarker) {
        failMarker = false
        throw new Error('marker write failed')
      }
      return put(key, value)
    }
    ctx.provide('sessionController', {
      fork: async () => {
        const child = { id: 'forked', header: { cwd: workspace, isSeeded: true } }
        liveAgents.set('forked', { session: child })
        await ctx.serial('agent/created', { agent: { session: child }, source: 'fork' } as never)
        return { sessionId: 'forked' }
      },
    })
    const created = await service.forkSession('root')
    expect(created.sessionId).toBe('forked')
    expect(service.view('forked').grants.map((grant) => grant.path)).toEqual([extra])
    const record = [...service.view('root').forks][0]
    expect(record?.stage).toBe('committed')
  })
})

describe('write-scope route admission', () => {
  function fakeRequest(body?: unknown) {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      [Symbol.asyncIterator]: async function* () {
        if (payload !== undefined) yield payload
      },
    }
  }

  function fakeResponse() {
    const state = {
      status: 0,
      body: '',
      headers: {} as Record<string, string>,
      writeHead(status: number, headers?: Record<string, string>) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body?: string) {
        state.body = body ?? ''
      },
    }
    return state
  }

  it('rejects a request without an admitted peer before reading the body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-route-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const { routes } = await mount({ workspace, reject: 401 })
    const route = routes.find(
      (candidate) => candidate.path === '/dsh-session-write-access',
    ) as unknown as {
      handler: (req: unknown, res: unknown) => Promise<void>
    }
    const response = fakeResponse()
    await route.handler(fakeRequest({ method: 'add', sessionId: 'root', path: '/tmp' }), response)
    expect(response.status).toBe(401)
    expect(response.body).toBe('unauthorized')
  })

  it('serves state for an admitted session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-route-'))
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const { ctx, liveAgents, routes } = await mount({ workspace })
    await ctx.serial('agent/created', {
      agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } },
      source: 'fresh',
    } as never)
    liveAgents.set('root', { session: { id: 'root', header: { cwd: workspace } } })
    const route = routes.find(
      (candidate) => candidate.path === '/dsh-session-write-access',
    ) as unknown as {
      handler: (req: unknown, res: unknown) => Promise<void>
    }
    const response = fakeResponse()
    await route.handler(fakeRequest({ method: 'state', sessionId: 'root' }), response)
    expect(response.status).toBe(200)
    const envelope = JSON.parse(response.body) as { ok: boolean; value: { groupId: string } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value.groupId).toBe('root')
  })
})

describe('SessionWriteAccessPolicy fork intent and host failure', () => {
  it('persists the target intent before retrying after the first intent write fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-fork-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service, storage, liveAgents } = await mount({ workspace })
    await ctx.serial('agent/created', {
      agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } },
      source: 'fresh',
    } as never)
    await service.addDirectory('root', extra)
    const forks = storage.tables.get('forks') as unknown as {
      put: (key: string, value: { stage?: string }) => Promise<void>
    }
    const put = forks.put.bind(forks)
    let failIntent = true
    forks.put = async (key, value) => {
      if (value.stage === 'committing' && failIntent) {
        failIntent = false
        throw new Error('intent write failed')
      }
      return put(key, value)
    }
    ctx.provide('sessionController', {
      fork: async () => {
        const child = { id: 'forked', header: { cwd: workspace, isSeeded: true } }
        liveAgents.set('forked', { session: child })
        await ctx.serial('agent/created', { agent: { session: child }, source: 'fork' } as never)
        return { sessionId: 'forked' }
      },
    })
    const created = await service.forkSession('root')
    expect(created.sessionId).toBe('forked')
    const record = service.view('root').forks[0]
    expect(record?.stage).toBe('committed')
    expect(record?.targetSessionId).toBe('forked')
    expect(service.view('forked').grants.map((grant) => grant.path)).toEqual([extra])
  })

  it('does not inherit when the host Fork fails after creating the session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-fork-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service, liveAgents } = await mount({ workspace })
    await ctx.serial('agent/created', {
      agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } },
      source: 'fresh',
    } as never)
    await service.addDirectory('root', extra)
    ctx.provide('sessionController', {
      fork: async () => {
        const child = { id: 'forked', header: { cwd: workspace, isSeeded: true } }
        liveAgents.set('forked', { session: child })
        await ctx.serial('agent/created', { agent: { session: child }, source: 'fork' } as never)
        throw Object.assign(new Error('workspace attach failed'), {
          details: { sessionId: 'forked' },
        })
      },
    })
    await expect(service.forkSession('root')).rejects.toThrow(
      /Fork failed after creating session forked/,
    )
    const record = service.view('root').forks[0]
    expect(record?.stage).toBe('failed')
    expect(record?.targetSessionId).toBe('forked')
    expect(service.view('forked').grants).toEqual([])
    const policy = service.resolve({
      session: { id: 'forked', header: { cwd: workspace } },
    } as never)
    expect(policy.additionalWritableRoots).toBeUndefined()
  })

  it('reports a default-only session when cleanup cannot write membership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-swa-fork-'))
    const workspace = join(root, 'workspace')
    const extra = join(root, 'extra')
    mkdirSync(workspace)
    mkdirSync(extra)
    const { ctx, service, storage, liveAgents } = await mount({ workspace })
    await ctx.serial('agent/created', {
      agent: { session: { id: 'root', header: { cwd: workspace, isSeeded: false } } },
      source: 'fresh',
    } as never)
    await service.addDirectory('root', extra)
    const members = storage.tables.get('members') as unknown as {
      put: (key: string, value: unknown) => Promise<void>
    }
    const put = members.put.bind(members)
    members.put = async (key, value) => {
      if (key === 'forked') throw new Error('member write failed')
      return put(key, value)
    }
    ctx.provide('sessionController', {
      fork: async () => {
        const child = { id: 'forked', header: { cwd: workspace, isSeeded: true } }
        liveAgents.set('forked', { session: child })
        await ctx.serial('agent/created', { agent: { session: child }, source: 'fork' } as never)
        return { sessionId: 'forked' }
      },
    })
    await expect(service.forkSession('root')).rejects.toThrow(/default workspace only/)
    members.put = put
    const record = service.view('root').forks[0]
    expect(record?.stage).toBe('failed')
    expect(record?.targetSessionId).toBe('forked')
    await service.ensureSession('forked')
    expect(service.view('forked').grants).toEqual([])
  })
})
