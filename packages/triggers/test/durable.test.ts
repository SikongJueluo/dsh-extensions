/** @module dsh-triggers/durable.test */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { open, rename } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { Storage, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as domainPlugin from '@deepseek-ai/dsh-storage-domain'
import * as triggersPlugin from '../src/index.js'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import type { RunRecord } from '../src/model.js'

/** The host's crash-durable publish protocol (see dsh-storage-json): tmp -> fsync -> rename. */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = join(path, '..', `.${randomUUID()}.tmp`)
  const handle = await open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
}

/** A minimal single-layout file unit: one JSON document per unit, atomic rewrite per write. */
class FileUnit {
  constructor(
    private readonly file: string,
    private readonly descriptor: KvUnitDescriptor,
  ) {}

  private async load(): Promise<{
    version: number
    tables: Record<string, Record<string, unknown>>
  }> {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: number }
      if (parsed.version !== this.descriptor.version) throw new Error('version-mismatch')
      return parsed as { version: number; tables: Record<string, Record<string, unknown>> }
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: this.descriptor.version, tables: {} }
      }
      throw failure
    }
  }

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    const doc = await this.load()
    const tables: Record<string, Record<string, unknown>> = {}
    for (const name of this.descriptor.tables) tables[name] = doc.tables[name] ?? {}
    return { tables, global: null }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    const doc = await this.load()
    doc.tables[table] = { ...doc.tables[table], [key]: value }
    await writeAtomic(this.file, JSON.stringify(doc))
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    const doc = await this.load()
    const next = { ...doc.tables[table] }
    delete next[key]
    doc.tables[table] = next
    await writeAtomic(this.file, JSON.stringify(doc))
  }

  async close(): Promise<void> {}
}

const fileBackendPlugin = {
  name: 'file-backend',
  inject: ['storage'],
  apply(ctx: Context, config: { root: string }) {
    const units = new Map<string, FileUnit>()
    const backend = {
      kv: {
        open: async (descriptor: KvUnitDescriptor) => {
          if (!UNIT_NAME_RE.test(descriptor.name)) throw new Error('bad unit name')
          const existing = units.get(descriptor.name)
          if (existing !== undefined) return existing as unknown as KvUnit
          const unit = new FileUnit(join(config.root, `${descriptor.name}.json`), descriptor)
          units.set(descriptor.name, unit)
          return unit as unknown as KvUnit
        },
      },
      close: async () => {
        for (const unit of units.values()) await unit.close()
        units.clear()
      },
    }
    ctx.effect(() => {
      const unregister = ctx.storage.backend.register('file', backend)
      return () => unregister()
    })
    ctx.provide(storageBackendServiceKey('file'), backend)
  },
}

interface FakePromptCall {
  requestId: string
  sessionId: string
  text: string
}

/** Boot the FULL plugin stack over a durable directory; returns the seams a test needs. */
async function boot(root: string, options: { queueFails?: boolean } = {}) {
  const prompts: FakePromptCall[] = []
  const admitted = new Set<string>()
  const queue = { fail: options.queueFails ?? false }
  const logs = new Map<string, { type: string; data: unknown }[]>()
  const ctx = new Context()
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('sessionController', {
    prompt: async (request: {
      requestId: string
      sessionId: string
      mode: string
      content: { text: string }[]
    }) => {
      if (queue.fail) throw new Error('queue refused (durable drill)')
      if (!admitted.has(request.requestId)) {
        admitted.add(request.requestId)
        prompts.push({
          requestId: request.requestId,
          sessionId: request.sessionId,
          text: request.content[0]?.text ?? '',
        })
      }
      return { accepted: true as const }
    },
    list: async () => ({ items: [] }),
  })
  ctx.provide('sessionQuery', {
    readSession: async (sessionId: string) => ({
      session: { id: sessionId },
      inheritedEventCount: 0,
      events: [...(logs.get(sessionId) ?? [])].map((event, seq) => ({
        type: event.type,
        seq,
        time: Date.now(),
        data: event.data,
      })),
    }),
  })
  await ctx.plugin(Storage as never, {} as never)
  await ctx.plugin(fileBackendPlugin as never, { root } as never)
  await ctx.plugin(domainPlugin as never, { backend: 'file' } as never)
  await ctx.plugin(triggersPlugin as never, {} as never)
  const svc = present(ctx.get('triggerBindings'), 'triggerBindings service')
  return {
    svc,
    prompts,
    queue,
    logs,
    domain: ctx.storage.domain as unknown as { open(spec: unknown): Promise<Domain<never>> },
    emit: (sessionId: string, event: { type: string; data: unknown }) => {
      const rows = logs.get(sessionId) ?? []
      rows.push(event)
      logs.set(sessionId, rows)
      ctx.emit('session/event', { id: sessionId } as never, event as never)
    },
  }
}

/** Settle queued promise chains (bounded), like the cordis tests' `until`. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++)
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
}

const DIRS: string[] = []
afterAll(() => {
  for (const dir of DIRS.slice()) rmSync(dir, { force: true, recursive: true })
})

/** One fresh durable directory per boot (tracked for cleanup). */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-triggers-durable-'))
  DIRS.push(dir)
  return dir
}

/** Parse the triggers unit file off disk (the medium's own view). */
function readUnit(dir: string): { tables: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dir, 'triggers.json'), 'utf8')) as {
    tables: Record<string, Record<string, unknown>>
  }
}

/** Narrow a possibly-absent fixture lookup; the test fails loud at the site. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to exist`)
  return value
}

/** Parse the stored run record for `runId` off the unit file (the medium's view). */
function readRun(dir: string, runId: string): RunRecord {
  const runs = present(readUnit(dir).tables.runs, 'runs table')
  return present(runs[runId] as RunRecord | undefined, `run ${runId} in the medium`)
}

const EXECUTOR = 'sess-exec'
const PARENT = 'sess-parent'

describe('atomic commit over the real domain + file medium', () => {
  it('a transition and its owed prompt are ONE record in ONE durable write; a fresh boot reads them back whole', async () => {
    const dir = freshDir()
    const first = await boot(dir)
    first.queue.fail = true
    const bound = await first.svc.bindReviewLoop({
      task: 't',
      executorSession: EXECUTOR,
      parentSession: PARENT,
      deliverStart: true,
    })
    await settle()

    const unit = readUnit(dir)
    const stored = readRun(dir, bound.runId)
    expect(stored.status).toBe('paused-error')
    expect(stored.outbox).toHaveLength(1)
    const owed = present(stored.outbox, 'the committed outbox')
    const owedEntry = present(owed[0], 'the owed start entry')
    expect(owedEntry.kind).toBe('start')
    expect(owedEntry.state).toBe('failed')
    expect(present(unit.tables.deliveries, 'deliveries table')[owedEntry.id]).toBeDefined()

    const second = await boot(dir)
    await settle()
    expect(second.prompts).toHaveLength(0)
    const redeliverEntry = present(readRun(dir, bound.runId).outbox, 'the committed outbox')
    const deliveryId = present(redeliverEntry[0], 'the owed start entry').id
    await second.svc.controlRun(bound.runId, 'redeliver', { deliveryId })
    expect(second.prompts).toHaveLength(1)
    expect(present(second.prompts[0], 'first prompt').sessionId).toBe(EXECUTOR)
    expect(present(second.prompts[0], 'first prompt').text).toContain(`runId=${bound.runId}`)
    const after = readRun(dir, bound.runId)
    expect(after.status).toBe('active')
    expect(after.outbox ?? []).toHaveLength(0)
  })

  it('a full loop round-trips through the medium: reopen sees the reviewed state and re-sends nothing', async () => {
    const dir = freshDir()
    const first = await boot(dir)
    const bound = await first.svc.bindReviewLoop({
      task: 't',
      executorSession: EXECUTOR,
      parentSession: PARENT,
    })
    first.emit(EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await first.svc.signal(EXECUTOR, {
      runId: bound.runId,
      outcome: 'deliver',
      summary: '实现完成',
    })
    first.emit(EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await settle()
    expect(first.prompts).toHaveLength(1)

    const second = await boot(dir)
    await settle()
    const stored = readRun(dir, bound.runId)
    expect(stored.phase).toBe('awaiting-review')
    expect(stored.outbox ?? []).toHaveLength(0)
    expect(second.prompts).toHaveLength(0)

    second.emit(PARENT, { type: 'turn/start', data: { turn: 1 } })
    await second.svc.signal(PARENT, { runId: bound.runId, outcome: 'pass', summary: '通过' })
    second.emit(PARENT, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await settle()
    const finished = readRun(dir, bound.runId)
    expect(finished.status).toBe('completed')
    expect(present(second.prompts.at(-1), 'last prompt').sessionId).toBe(EXECUTOR)
  })
})
