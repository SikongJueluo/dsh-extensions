/**
 * Real-Cordis integration tests: the exact seam dsh-handoff uses — another
 * plugin resolves `ctx.get('triggerBindings')` and calls it through the
 * Cordis trace/shadow proxy. The plain service tests bypass that wrapper
 * (they `new TriggerService(fakeCtx)`), which is how the ES-`#` proxy
 * incompatibility stayed green while every real cross-plugin call threw.
 *
 * Host services are stubs whose shapes come from the host type declarations;
 * storage puts run the zod boundary the real host enforces.
 *
 * @module dsh-triggers/cordis.test
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import * as triggersPlugin from '../src/index.js'
import { TRIGGER_DOMAIN, type DeliveryRecord, type RunRecord } from '../src/model.js'

/** Minimal host surface; every value TriggerService touches. */
function createHost({ queueFails = false } = {}) {
  const prompts: { requestId: string, sessionId: string, mode: string, text: string }[] = []
  const toolDefs = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const domains = new Map<string, { spec: typeof TRIGGER_DOMAIN, tables: Map<string, Map<string, unknown>> }>()

  const table = (spec: typeof TRIGGER_DOMAIN, store: Map<string, Map<string, unknown>>, name: string) => {
    const map = store.get(name)!
    const valueSchema = (spec.tables as Record<string, { valueSchema?: { safeParse: (v: unknown) => { success: boolean, error?: { issues: { path: (string | number)[], message: string }[] } } } }>)[name]?.valueSchema
    return {
      get: (key: string) => map.get(key),
      entries: () => map.entries() as IterableIterator<[string, never]>,
      keys: () => map.keys() as IterableIterator<string>,
      get size() { return map.size },
      put: async (key: string, value: unknown) => {
        if (valueSchema !== undefined) {
          const parsed = valueSchema.safeParse(value)
          if (!parsed.success) {
            const issues = parsed.error!.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
            throw new Error(`zod boundary rejected ${name}[${key}]: ${issues}`)
          }
        }
        map.set(key, structuredClone(value))
      },
      delete: async (key: string) => map.delete(key),
    }
  }

  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {} }),
    tools: {
      register(def: { name: string }) {
        toolDefs.set(def.name, def as never)
        return () => toolDefs.delete(def.name)
      },
    },
    sessionController: {
      prompt: async (request: { requestId: string, sessionId: string, mode: string, content: { text: string }[] }) => {
        if (queueFails) throw new Error('queue refused (drill)')
        prompts.push({ requestId: request.requestId, sessionId: request.sessionId, mode: request.mode, text: request.content[0]?.text ?? '' })
        return { accepted: true as const }
      },
      list: async () => ({ items: [] }),
    },
    storageDomain: {
      open: async (spec: typeof TRIGGER_DOMAIN) => {
        const store = { spec, tables: new Map<string, Map<string, unknown>>() }
        for (const name of Object.keys(spec.tables)) store.tables.set(name, new Map())
        domains.set(spec.name, store)
        const domain: Domain<typeof TRIGGER_DOMAIN> = {
          table: (name: string) => table(spec, store.tables, name) as never,
          close: async () => {},
        } as never
        return domain
      },
    },
  }
  return {
    ctx, prompts, toolDefs, queue: { get fail() { return queueFails } },
    rows: (name: string) => {
      const store = [...domains.values()].at(-1)
      return store === undefined ? [] : [...store.tables.get(name)!.values()]
    },
  }
}

/** Boot real Cordis with the triggers plugin mounted on stub host services. */
async function boot(options: { queueFails?: boolean } = {}) {
  const host = createHost(options)
  const root = new Context()
  root.provide('tools', host.ctx.tools as never)
  root.provide('sessionController', host.ctx.sessionController as never)
  root.provide('storageDomain', host.ctx.storageDomain as never)
  await root.plugin(triggersPlugin, {} as never)
  return { root, host }
}

/** Emit one durable session event exactly as the host feed would. */
function emit(root: Context, sessionId: string, event: { type: string, data: unknown }): void {
  root.emit('session/event', { id: sessionId } as never, event as never)
}

/** Await a condition (bounded), so promise chains can settle. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timeout waiting for ${what}`)
}

const EXECUTOR = 'sess-exec'
const PARENT = 'sess-parent'

describe('cross-plugin service through the Cordis proxy', () => {
  it('bindReviewLoop is callable via ctx.get() and creates the loop', async () => {
    const { root, host } = await boot()
    // The handoff seam: resolve the service from another consumer through
    // ctx.get(), which returns the trace proxy, not the raw instance.
    const svc = root.get('triggerBindings')
    expect(svc).toBeDefined()
    const bound = await svc!.bindReviewLoop({ task: '修复构建', executorSession: EXECUTOR, parentSession: PARENT, maxRounds: 5 })
    expect(bound.runId).toMatch(/^run-/)
    expect(bound.bindingId).toMatch(/^bnd-/)
    const runs = host.rows('runs') as RunRecord[]
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('active')
    expect(runs[0]!.phase).toBe('awaiting-delivery')
    // handoff binds without delivering its own start prompt
    expect(host.prompts).toHaveLength(0)
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('the loop advances end to end through the proxy and the signal tool', async () => {
    const { root, host } = await boot()
    const svc = root.get('triggerBindings')!
    const bound = await svc.bindReviewLoop({ task: '任务', executorSession: EXECUTOR, parentSession: PARENT })

    // Executor round: signal through the real tool surface, then the turn ends.
    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 3 } })
    const tool = host.toolDefs.get('trigger_signal')!
    const result = await tool.execute(
      { runId: bound.runId, outcome: 'deliver', summary: '实现完成，测试 31/31' },
      { agent: { id: EXECUTOR }, concludeTurn: () => {} },
    )
    expect(result).toMatchObject({ kind: 'accepted' })
    expect(host.prompts).toHaveLength(0)

    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    await until(() => host.prompts.length === 1, 'review delivery')
    expect(host.prompts[0]!.sessionId).toBe(PARENT)
    expect(host.prompts[0]!.text).toContain(`runId=${bound.runId}`)
    expect(host.prompts[0]!.text).toContain('你是审核者')
    expect((host.rows('runs') as RunRecord[])[0]!.phase).toBe('awaiting-review')

    // Reviewer round: pass through the proxied service surface.
    emit(root, PARENT, { type: 'turn/start', data: { turn: 1 } })
    const verdict = await svc.signal(PARENT, { runId: bound.runId, outcome: 'pass', summary: '通过' })
    expect(verdict).toMatchObject({ ok: true })
    emit(root, PARENT, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => (host.rows('runs') as RunRecord[])[0]!.status === 'completed', 'run completion')
    expect(host.prompts.at(-1)!.sessionId).toBe(EXECUTOR)
    expect(host.prompts.at(-1)!.text).toContain('审核通过')
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('a foreign same-numbered turn never commits the pending signal', async () => {
    const { root, host } = await boot()
    const svc = root.get('triggerBindings')!
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })

    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    // The reviewer happens to be on its own turn 1 and ends it first: the
    // executor has NOT ended; nothing may advance.
    emit(root, PARENT, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(host.prompts).toHaveLength(0)
    expect((host.rows('runs') as RunRecord[])[0]!.phase).toBe('awaiting-delivery')

    // The real owner's turn end commits exactly once.
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => host.prompts.length === 1, 'review delivery')
    expect((host.rows('runs') as RunRecord[])[0]!.phase).toBe('awaiting-review')
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('one session cannot pend the same turn for two runs', async () => {
    const { root, host } = await boot()
    const svc = root.get('triggerBindings')!
    const first = await svc.bindReviewLoop({ task: 't1', executorSession: EXECUTOR, parentSession: PARENT })
    const second = await svc.bindReviewLoop({ task: 't2', executorSession: EXECUTOR, parentSession: 'sess-parent-2' })

    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 2 } })
    await svc.signal(EXECUTOR, { runId: first.runId, outcome: 'deliver', summary: 's' })
    const rejected = await svc.signal(EXECUTOR, { runId: second.runId, outcome: 'deliver', summary: 's' })
    expect(rejected).toMatchObject({ ok: false })
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('a stale round\'s failed delivery is refused, not re-sent', async () => {
    const { root, host } = await boot({ queueFails: true })
    const svc = root.get('triggerBindings')!
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT, maxRounds: 5 })
    // Round 1: the review delivery fails and parks the run.
    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 'r1' })
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => (host.rows('runs') as RunRecord[])[0]!.status === 'paused-error', 'parked run')
    const stale = (host.rows('deliveries') as DeliveryRecord[]).find(d => d.state === 'failed')!

    // The user resumes with a note and the loop moves on to round 2.
    host.ctx.sessionController.prompt = async () => ({ accepted: true as const })
    await svc.controlRun(bound.runId, 'resume', { message: '继续' })
    emit(root, PARENT, { type: 'turn/start', data: { turn: 5 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'rework', summary: '改一版' })
    emit(root, PARENT, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await until(() => (host.rows('runs') as RunRecord[])[0]!.round === 2, 'round 2')
    const promptsBefore = host.prompts.length

    // The round-1 review delivery is now stale: re-sending it would wake the
    // reviewer with outdated instructions whose verdict could corrupt round 2.
    await expect(svc.controlRun(bound.runId, 'redeliver', { deliveryId: stale.id })).rejects.toThrow('过期投递')
    expect(host.prompts.length).toBe(promptsBefore)
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('redelivery resumes before sending, so an immediate answer is accepted; a cancelled run refuses redelivery', async () => {
    const { root, host } = await boot({ queueFails: true })
    const svc = root.get('triggerBindings')!
    const bound = await svc.bindReviewLoop({ task: 't', executorSession: EXECUTOR, parentSession: PARENT })
    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => (host.rows('runs') as RunRecord[])[0]!.status === 'paused-error', 'parked run')
    const failed = (host.rows('deliveries') as DeliveryRecord[]).find(d => d.state === 'failed')!

    // The counterpart answers the moment the prompt lands — DURING the send,
    // before controlRun returns. The run must already accept signals by then.
    let inlineAnswer: { ok: boolean } | undefined
    host.ctx.sessionController.prompt = async (request: { requestId: string, sessionId: string, mode: string, content: { text: string }[] }) => {
      host.prompts.push({ requestId: request.requestId, sessionId: request.sessionId, mode: request.mode, text: request.content[0]?.text ?? '' })
      if (request.sessionId === PARENT) {
        emit(root, PARENT, { type: 'turn/start', data: { turn: 5 } })
        inlineAnswer = await svc.signal(PARENT, { runId: bound.runId, outcome: 'pass', summary: '即时通过' }) as { ok: boolean }
      }
      return { accepted: true as const }
    }
    await svc.controlRun(bound.runId, 'redeliver', { deliveryId: failed.id })
    await until(() => host.prompts.length === 1, 're-sent delivery')
    expect(host.prompts[0]!.requestId).toBe(failed.requestId)
    expect((host.rows('runs') as RunRecord[])[0]!.status).toBe('active')
    // The immediate answer was accepted — no paused-run rejection window.
    expect(inlineAnswer).toMatchObject({ ok: true })
    emit(root, PARENT, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await until(() => (host.rows('runs') as RunRecord[])[0]!.status === 'completed', 'run completion')

    // A cancelled run must never wake the counterpart again.
    const second = await svc.bindReviewLoop({ task: 't2', executorSession: 'sess-exec-2', parentSession: PARENT })
    host.ctx.sessionController.prompt = async () => { throw new Error('queue refused (drill)') }
    emit(root, 'sess-exec-2', { type: 'turn/start', data: { turn: 1 } })
    await svc.signal('sess-exec-2', { runId: second.runId, outcome: 'deliver', summary: 's' })
    emit(root, 'sess-exec-2', { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => (host.rows('runs') as RunRecord[]).find(r => r.id === second.runId)!.status === 'paused-error', 'second parked run')
    await svc.controlRun(second.runId, 'cancel')
    const failedSecond = (host.rows('deliveries') as DeliveryRecord[]).filter(d => d.runId === second.runId).find(d => d.state === 'failed')!
    await expect(svc.controlRun(second.runId, 'redeliver', { deliveryId: failedSecond.id })).rejects.toThrow('运行已结束')
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })
})
