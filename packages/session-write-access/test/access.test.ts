import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AccessError,
  AccessStore,
  covers,
  type AccessTable,
  type AccessTables,
  type SessionFacts,
} from '../src/access.js'
import type { ForkRecord, GroupRecord, MemberRecord, RequestRecord } from '../src/domain.js'
import { ProtectedWriteRootError } from '../src/paths.js'

class MemoryTable<V> implements AccessTable<V> {
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

function tables(): AccessTables {
  return {
    groups: new MemoryTable<GroupRecord>(),
    members: new MemoryTable<MemberRecord>(),
    requests: new MemoryTable<RequestRecord>(),
    forks: new MemoryTable<ForkRecord>(),
  }
}

function fixtureSessions(): {
  lookup: (sessionId: string) => Promise<SessionFacts | undefined>
  add: (facts: SessionFacts) => void
} {
  const sessions = new Map<string, SessionFacts>()
  return {
    lookup: async sessionId => sessions.get(sessionId),
    add: facts => { sessions.set(facts.sessionId, facts) },
  }
}

function makeStore(overrides: { protectedRoots?: string[]; workspace?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-swa-'))
  const workspace = overrides.workspace ?? join(root, 'workspace')
  const protectedRoot = join(root, 'protected')
  mkdirSync(workspace)
  mkdirSync(protectedRoot)
  const sessions = fixtureSessions()
  const tableSet = tables()
  let clock = 1000
  let counter = 0
  const store = new AccessStore(tableSet, {
    protectedRoots: overrides.protectedRoots ?? [protectedRoot],
    workspaceFallback: workspace,
    lookup: sessions.lookup,
    newId: () => `id-${++counter}`,
    now: () => ++clock,
  })
  return { root, workspace, protectedRoot, sessions, store, tables: tableSet }
}

describe('AccessStore path containment', () => {
  it('treats the root as covering every absolute path', () => {
    expect(covers('/', '/home/u')).toBe(true)
    expect(covers('/', '/')).toBe(true)
    expect(covers('/a', '/a/b')).toBe(true)
    expect(covers('/a', '/ab')).toBe(false)
  })
})

describe('AccessStore attribution', () => {
  it('creates one root group with its frozen workspace and no grants', async () => {
    const { workspace, store } = makeStore()
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    const status = store.status('root')
    expect(status.groupId).toBe('root')
    expect(status.workspaceRoot).toBe(workspace)
    expect(status.grants).toEqual([])
    expect(status.revision).toBe(1)
  })

  it('attributes a local child to the parent group and ignores the child cwd', async () => {
    const { root, workspace, store } = makeStore()
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.ensureChildSession({ sessionId: 'child', parentSessionId: 'root', cwd: elsewhere, origin: 'subagent' })
    expect(store.status('child').groupId).toBe('root')
    expect(store.status('child').workspaceRoot).toBe(workspace)
  })

  it('reconstructs a cold child group from persisted parent headers', async () => {
    const { workspace, sessions, store } = makeStore()
    sessions.add({ sessionId: 'root', cwd: workspace })
    sessions.add({ sessionId: 'child', cwd: workspace, parentSessionId: 'root', origin: 'subagent' })
    await store.ensureChildSession({ sessionId: 'child', parentSessionId: 'root', origin: 'subagent' })
    expect(store.status('child').groupId).toBe('root')
    expect(store.member('root')?.role).toBe('root')
  })

  it('refuses an unattributed session', () => {
    const { store } = makeStore()
    expect(() => store.status('missing')).toThrow(AccessError)
  })

  it('refuses the filesystem root as a workspace or grant', async () => {
    const { store } = makeStore()
    await expect(store.ensureRootSession({ sessionId: 'root', cwd: '/' })).rejects.toThrow(/overlaps/)
    // A group created from a normal workspace still cannot grant '/'.
    const workspace = mkdtempSync(join(tmpdir(), 'dsh-swa-root-'))
    const other = new AccessStore(tables(), {
      protectedRoots: ['/home/example/.dsh'],
      workspaceFallback: workspace,
      lookup: async () => undefined,
    })
    await other.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await expect(other.addGrant('root', '/')).rejects.toThrow(/overlaps/)
    expect(other.status('root').grants).toEqual([])
  })

  it('audits a stored root workspace as overlapping protected data', async () => {
    const { store, tables: tableSet } = makeStore()
    await tableSet.groups.put('root-group', {
      version: 1,
      groupId: 'root-group',
      workspaceRoot: '/',
      grants: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(() => store.auditProtectedState()).toThrow(/overlaps protected/)
  })

  it('refuses a workspace that overlaps protected data', async () => {
    const { root, protectedRoot, store } = makeStore()
    await expect(store.ensureRootSession({ sessionId: 'root', cwd: root })).rejects.toThrow(/overlaps protected/)
    await expect(store.ensureRootSession({ sessionId: 'other', cwd: protectedRoot })).rejects.toThrow(/overlaps protected/)
  })
})

describe('AccessStore grants', () => {
  it('adds, shares, and revokes one directory across the family', async () => {
    const { root, workspace, store } = makeStore()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.ensureChildSession({ sessionId: 'child', parentSessionId: 'root', origin: 'subagent' })
    const added = await store.addGrant('child', shared)
    expect(added.group.grants.map(grant => grant.path)).toEqual([shared])
    expect(store.status('root').grants.map(grant => grant.path)).toEqual([shared])
    const removed = await store.removeGrant('root', shared)
    expect(removed.removed).toBe(true)
    expect(store.status('child').grants).toEqual([])
  })

  it('reports an already-covered directory instead of duplicating it', async () => {
    const { root, workspace, store } = makeStore()
    const parent = join(root, 'parent')
    const child = join(parent, 'child')
    mkdirSync(child, { recursive: true })
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', parent)
    const again = await store.addGrant('root', child)
    expect(again.coveredBy).toBe(parent)
    expect(again.group.revision).toBe(2)
  })

  it('keeps a child grant visible after a parent grant is revoked', async () => {
    const { root, workspace, store } = makeStore()
    const parent = join(root, 'parent')
    const child = join(parent, 'child')
    mkdirSync(child, { recursive: true })
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', child)
    await store.addGrant('root', parent)
    const view = store.status('root')
    expect(view.grants.find(grant => grant.path === child)?.coveredBy).toBe(parent)
  })

  it('refuses a grant overlapping protected data', async () => {
    const { root, protectedRoot, store } = makeStore()
    await store.ensureRootSession({ sessionId: 'root', cwd: join(root, 'workspace') })
    await expect(store.addGrant('root', root)).rejects.toThrow(ProtectedWriteRootError)
    await expect(store.addGrant('root', protectedRoot)).rejects.toThrow(ProtectedWriteRootError)
  })

  it('refuses a symlinked grant but accepts a symlinked session workspace', async () => {
    const { root, workspace, store } = makeStore()
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real)
    symlinkSync(real, link)
    await store.ensureRootSession({ sessionId: 'linked', cwd: link })
    expect(store.status('linked').workspaceRoot).toBe(real)
    await expect(store.addGrant('linked', link)).rejects.toThrow(/symlinked grants are not supported/)
  })
})

describe('AccessStore requests', () => {
  it('deduplicates a pending request for the same directory', async () => {
    const { root, workspace, store } = makeStore()
    const wanted = join(root, 'wanted')
    mkdirSync(wanted)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    const first = await store.request('root', wanted, 'edit tests')
    const second = await store.request('root', wanted, 'edit tests again')
    expect(first.kind).toBe('pending')
    expect(second.kind).toBe('pending')
    if (first.kind !== 'pending' || second.kind !== 'pending') throw new Error('unreachable')
    expect(second.request.requestId).toBe(first.request.requestId)
    expect(store.status('root').pending).toHaveLength(1)
  })

  it('refuses an empty reason', async () => {
    const { root, workspace, store } = makeStore()
    const wanted = join(root, 'wanted')
    mkdirSync(wanted)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await expect(store.request('root', wanted, '   ')).rejects.toThrow(/short reason/)
  })

  it('does not create a request for an already granted directory', async () => {
    const { root, workspace, store } = makeStore()
    const wanted = join(root, 'wanted')
    mkdirSync(wanted)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', wanted)
    expect((await store.request('root', wanted, 'again')).kind).toBe('granted')
  })

  it('allows with the expected revision and refuses a stale page', async () => {
    const { root, workspace, store } = makeStore()
    const wanted = join(root, 'wanted')
    mkdirSync(wanted)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    const requested = await store.request('root', wanted, 'needed')
    if (requested.kind !== 'pending') throw new Error('unreachable')
    const requestId = requested.request.requestId
    await expect(store.decide('root', requestId, 'allow', 9)).rejects.toMatchObject({ code: 'STALE_REVISION' })
    const allowed = await store.decide('root', requestId, 'allow', 1)
    expect(allowed.changed).toBe(true)
    expect(store.status('root').grants.map(grant => grant.path)).toEqual([wanted])
    const again = await store.decide('root', requestId, 'allow', 1)
    expect(again.changed).toBe(false)
  })

  it('does not resurrect a revoked grant through an old allowed request', async () => {
    const { root, workspace, store } = makeStore()
    const wanted = join(root, 'wanted')
    mkdirSync(wanted)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    const requested = await store.request('root', wanted, 'needed')
    if (requested.kind !== 'pending') throw new Error('unreachable')
    await store.decide('root', requested.request.requestId, 'allow', 1)
    await store.removeGrant('root', wanted)
    const replay = await store.decide('root', requested.request.requestId, 'allow', 1)
    expect(replay.changed).toBe(false)
    expect(store.status('root').grants).toEqual([])
  })

  it('denies without changing the group', async () => {
    const { root, workspace, store } = makeStore()
    const wanted = join(root, 'wanted')
    mkdirSync(wanted)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    const requested = await store.request('root', wanted, 'needed')
    if (requested.kind !== 'pending') throw new Error('unreachable')
    await store.decide('root', requested.request.requestId, 'deny', 1)
    expect(store.status('root').grants).toEqual([])
    expect(store.status('root').pending).toEqual([])
  })

  it('refuses a decision issued through another group', async () => {
    const { root, workspace, store } = makeStore()
    const wanted = join(root, 'wanted')
    mkdirSync(wanted)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.ensureRootSession({ sessionId: 'other', cwd: workspace })
    const requested = await store.request('root', wanted, 'needed')
    if (requested.kind !== 'pending') throw new Error('unreachable')
    await expect(store.decide('other', requested.request.requestId, 'allow', 1)).rejects.toMatchObject({ code: 'REQUEST_MISSING' })
  })
})

describe('AccessStore fork', () => {
  it('copies click-time grants into an independent group', async () => {
    const { root, workspace, store } = makeStore()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', shared)
    const fork = await store.beginFork('root')
    await store.commitFork(fork.forkId, 'forked')
    expect(store.status('forked').workspaceRoot).toBe(workspace)
    expect(store.status('forked').grants.map(grant => grant.path)).toEqual([shared])
    await store.removeGrant('root', shared)
    expect(store.status('forked').grants.map(grant => grant.path)).toEqual([shared])
    expect(store.forks().find(record => record.forkId === fork.forkId)?.stage).toBe('committed')
  })

  it('marks a pending record without a target as failed on reconcile', async () => {
    const { root, workspace, store } = makeStore()
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    const fork = await store.beginFork('root')
    await store.reconcileForks()
    expect(store.forks().find(record => record.forkId === fork.forkId)?.stage).toBe('failed')
  })
})

describe('AccessStore fork commit recovery', () => {
  it('reconciles a failed final marker without losing inherited grants', async () => {
    const { root, workspace, store, tables: tableSet } = makeStore()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', shared)
    const fork = await store.beginFork('root')
    const put = tableSet.forks.put.bind(tableSet.forks)
    tableSet.forks.put = async (key, value) => {
      if (value.stage === 'committed') throw new Error('marker write failed')
      return put(key, value)
    }
    await expect(store.commitFork(fork.forkId, 'forked')).rejects.toThrow('marker write failed')
    expect(store.status('forked').grants.map(grant => grant.path)).toEqual([shared])
    expect(store.forks().find(record => record.forkId === fork.forkId)?.stage).toBe('committing')
    tableSet.forks.put = put
    await store.reconcileForks()
    const record = store.forks().find(candidate => candidate.forkId === fork.forkId)
    expect(record?.stage).toBe('committed')
    expect(record?.targetSessionId).toBe('forked')
  })

  it('rebuilds a missing group after a failed group write', async () => {
    const { root, workspace, store, tables: tableSet } = makeStore()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', shared)
    const fork = await store.beginFork('root')
    const put = tableSet.groups.put.bind(tableSet.groups)
    tableSet.groups.put = async (key, value) => {
      if (key === 'forked') throw new Error('group write failed')
      return put(key, value)
    }
    await expect(store.commitFork(fork.forkId, 'forked')).rejects.toThrow('group write failed')
    expect(store.member('forked')).toBeUndefined()
    tableSet.groups.put = put
    await store.reconcileForks()
    expect(store.status('forked').grants.map(grant => grant.path)).toEqual([shared])
  })

  it('rebuilds a missing member after a failed member write, including after reopen', async () => {
    const { root, workspace, store, tables: tableSet } = makeStore()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', shared)
    const fork = await store.beginFork('root')
    const put = tableSet.members.put.bind(tableSet.members)
    tableSet.members.put = async (key, value) => {
      if (key === 'forked') throw new Error('member write failed')
      return put(key, value)
    }
    await expect(store.commitFork(fork.forkId, 'forked')).rejects.toThrow('member write failed')
    expect(store.member('forked')).toBeUndefined()
    tableSet.members.put = put
    // Simulate a restart: a fresh store over the same durable tables.
    const reopened = new AccessStore(tableSet, {
      protectedRoots: [join(root, 'protected')],
      workspaceFallback: workspace,
      lookup: async () => undefined,
    })
    await reopened.reconcileForks()
    expect(reopened.status('forked').grants.map(grant => grant.path)).toEqual([shared])
  })

  it('aborts a partial commit and does not revive it after reopen', async () => {
    const { root, workspace, store, tables: tableSet } = makeStore()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', shared)
    const fork = await store.beginFork('root')
    const putMember = tableSet.members.put.bind(tableSet.members)
    tableSet.members.put = async (key, value) => {
      if (key === 'forked') throw new Error('member write failed')
      return putMember(key, value)
    }
    await expect(store.commitFork(fork.forkId, 'forked')).rejects.toThrow('member write failed')
    tableSet.members.put = putMember
    await store.abortFork(fork.forkId, 'forked')
    expect(store.member('forked')).toBeUndefined()
    expect(store.group('forked')).toBeUndefined()
    const record = store.forks().find(candidate => candidate.forkId === fork.forkId)
    expect(record?.stage).toBe('failed')
    expect(record?.targetSessionId).toBe('forked')
    const reopened = new AccessStore(tableSet, {
      protectedRoots: [join(root, 'protected')],
      workspaceFallback: workspace,
      lookup: async () => undefined,
    })
    await reopened.reconcileForks()
    expect(reopened.member('forked')).toBeUndefined()
    await reopened.ensureRootSession({ sessionId: 'forked', cwd: workspace })
    expect(reopened.status('forked').grants).toEqual([])
  })

  it('completes an empty group left by a partial commit on retry', async () => {
    const { root, workspace, store, tables: tableSet } = makeStore()
    const shared = join(root, 'shared')
    mkdirSync(shared)
    await store.ensureRootSession({ sessionId: 'root', cwd: workspace })
    await store.addGrant('root', shared)
    await tableSet.groups.put('forked', {
      version: 1,
      groupId: 'forked',
      workspaceRoot: workspace,
      grants: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    await store.ensureRootSession(
      { sessionId: 'forked', cwd: workspace },
      { workspaceRoot: workspace, grants: [shared], forkSourceSessionId: 'root' },
    )
    expect(store.status('forked').grants.map(grant => grant.path)).toEqual([shared])
  })
})

describe('AccessStore loaded-state audit', () => {
  it('refuses a stored group whose workspace overlaps protected data', async () => {
    const { root, protectedRoot, store, tables: tableSet } = makeStore()
    await tableSet.groups.put('bad', {
      version: 1,
      groupId: 'bad',
      workspaceRoot: root,
      grants: [],
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    expect(() => store.auditProtectedState()).toThrow(/overlaps protected/)
    expect(protectedRoot.length).toBeGreaterThan(0)
  })
})
