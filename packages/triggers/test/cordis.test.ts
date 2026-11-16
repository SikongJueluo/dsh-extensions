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
import type { TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import * as triggersPlugin from '../src/index.js'
import {
  type TRIGGER_DOMAIN,
  type BindingRecord,
  type DeliveryRecord,
  type RunRecord,
  type TemplateRecord,
} from '../src/model.js'

type TableNames = keyof (typeof TRIGGER_DOMAIN)['tables']
type TableRecord<N extends TableNames> = TableValueOf<typeof TRIGGER_DOMAIN, N>

/** Per-table record maps backing the fake domain (same names as the spec). */
type TableMaps = { [N in TableNames]: Map<string, TableRecord<N>> }

/**
 * One table handle over the fake maps, enforcing the spec's zod boundary on
 * `put` exactly as the real domain layer does at its durable boundary.
 */
interface FakeTableHandle<N extends TableNames> {
  get(key: string): TableRecord<N> | undefined
  entries(): IterableIterator<[string, TableRecord<N>]>
  keys(): IterableIterator<string>
  readonly size: number
  put(key: string, value: TableRecord<N>): Promise<void>
  delete(key: string): Promise<boolean>
}

/** The prompts the fake session controller queued. */
interface FakePromptCall {
  requestId: string
  sessionId: string
  mode: string
  text: string
}

/** The tool surface the fake `tools` service stores; execute reads only these. */
interface RegisteredTool {
  name: string
  execute(
    args: unknown,
    exec: { agent?: { id: string }; concludeTurn: () => void },
  ): Promise<unknown>
}

/** Narrow a possibly-absent fixture lookup; the test fails loud at the site. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to exist`)
  return value
}

/**
 * One typed table handle over the fake maps, enforcing the spec's zod boundary
 * on `put` exactly as the real domain layer does at its durable boundary.
 */
function fakeTable<N extends TableNames>(
  tables: TableMaps,
  spec: typeof TRIGGER_DOMAIN,
  name: N,
): FakeTableHandle<N> {
  const map = tables[name]
  const valueSchema = spec.tables[name].valueSchema
  return {
    get: (key: string) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() {
      return map.size
    },
    put: async (key: string, value: TableRecord<N>) => {
      const parsed = valueSchema.safeParse(value)
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')
        throw new Error(`zod boundary rejected ${name}[${key}]: ${issues}`)
      }
      map.set(key, structuredClone(value))
    },
    delete: async (key: string) => map.delete(key),
  }
}

/** Minimal host surface; every value TriggerService touches. */
function createHost({ queueFails = false } = {}) {
  const prompts: FakePromptCall[] = []
  const toolDefs = new Map<string, RegisteredTool>()
  const tables: TableMaps = {
    templates: new Map<string, TemplateRecord>(),
    bindings: new Map<string, BindingRecord>(),
    runs: new Map<string, RunRecord>(),
    deliveries: new Map<string, DeliveryRecord>(),
  }

  const tools = {
    register: (definition: RegisteredTool) => {
      toolDefs.set(definition.name, definition)
      return () => toolDefs.delete(definition.name)
    },
  }
  const sessionController = {
    prompt: async (request: {
      requestId: string
      sessionId: string
      mode: string
      content: { text: string }[]
    }) => {
      if (queueFails) throw new Error('queue refused (drill)')
      prompts.push({
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: request.mode,
        text: request.content[0]?.text ?? '',
      })
      return { accepted: true as const }
    },
    list: async () => ({ items: [] }),
  }
  // The host's log reader: this composition keeps no durable history.
  const sessionQuery = {
    readSession: async (sessionId: string) => ({
      session: { id: sessionId },
      inheritedEventCount: 0,
      events: [],
    }),
  }
  const storageDomain = {
    open: async (spec: typeof TRIGGER_DOMAIN) => ({
      name: spec.name,
      global: (): never => {
        throw new Error('the trigger domain declares no global slot')
      },
      table: (name: TableNames) => fakeTable(tables, spec, name),
      close: async () => {},
    }),
  }

  return {
    ctx: { tools, sessionController, sessionQuery, storageDomain },
    prompts,
    toolDefs,
    queue: {
      get fail() {
        return queueFails
      },
    },
    rows: <N extends TableNames>(name: N) => [...tables[name].values()],
  }
}

/** Boot real Cordis with the triggers plugin mounted on stub host services. */
async function boot(options: { queueFails?: boolean } = {}) {
  const host = createHost(options)
  const root = new Context()
  root.reflect.provide('tools', host.ctx.tools)
  root.reflect.provide('sessionController', host.ctx.sessionController)
  root.reflect.provide('sessionQuery', host.ctx.sessionQuery)
  root.reflect.provide('storageDomain', host.ctx.storageDomain)
  await root.plugin(triggersPlugin, {})
  return { root, host }
}

/** Emit one durable session event exactly as the host feed would. */
function emit(root: Context, sessionId: string, event: { type: string; data: unknown }): void {
  root.events.emit('session/event', { id: sessionId }, event)
}

/** Await a condition (bounded), so promise chains can settle. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
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
    if (svc === undefined) throw new Error('missing triggerBindings service')
    const bound = await svc.bindReviewLoop({
      task: '修复构建',
      executorSession: EXECUTOR,
      parentSession: PARENT,
      maxRounds: 5,
    })
    expect(bound.runId).toMatch(/^run-/u)
    expect(bound.bindingId).toMatch(/^bnd-/u)
    const runs = host.rows('runs')
    expect(runs).toHaveLength(1)
    expect(present(runs[0], 'first run').status).toBe('active')
    expect(present(runs[0], 'first run').phase).toBe('awaiting-delivery')
    // handoff binds without delivering its own start prompt
    expect(host.prompts).toHaveLength(0)
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('the loop advances end to end through the proxy and the signal tool', async () => {
    const { root, host } = await boot()
    const svc = present(root.get('triggerBindings'), 'triggerBindings service')
    const bound = await svc.bindReviewLoop({
      task: '任务',
      executorSession: EXECUTOR,
      parentSession: PARENT,
    })

    // Executor round: signal through the real tool surface, then the turn ends.
    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 3 } })
    const tool = present(host.toolDefs.get('trigger_signal'), 'trigger_signal tool')
    const result = await tool.execute(
      { runId: bound.runId, outcome: 'deliver', summary: '实现完成，测试 31/31' },
      { agent: { id: EXECUTOR }, concludeTurn: () => {} },
    )
    expect(result).toMatchObject({ kind: 'accepted' })
    expect(host.prompts).toHaveLength(0)

    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
    await until(() => host.prompts.length === 1, 'review delivery')
    expect(present(host.prompts[0], 'first prompt').sessionId).toBe(PARENT)
    expect(present(host.prompts[0], 'first prompt').text).toContain(`runId=${bound.runId}`)
    expect(present(host.prompts[0], 'first prompt').text).toContain('你是审核者')
    expect(present(host.rows('runs')[0], 'first run').phase).toBe('awaiting-review')

    // Reviewer round: pass through the proxied service surface.
    emit(root, PARENT, { type: 'turn/start', data: { turn: 1 } })
    const verdict = await svc.signal(PARENT, {
      runId: bound.runId,
      outcome: 'pass',
      summary: '通过',
    })
    expect(verdict).toMatchObject({ ok: true })
    emit(root, PARENT, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(
      () => present(host.rows('runs')[0], 'first run').status === 'completed',
      'run completion',
    )
    expect(present(host.prompts.at(-1), 'last prompt').sessionId).toBe(EXECUTOR)
    expect(present(host.prompts.at(-1), 'last prompt').text).toContain('审核通过')
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('an autoDeliver run submits the executor final reply through the proxy without any tool call', async () => {
    const { root, host } = await boot()
    const svc = present(root.get('triggerBindings'), 'triggerBindings service')
    await svc.bindReviewLoop({
      task: '任务',
      executorSession: EXECUTOR,
      parentSession: PARENT,
      autoDeliver: true,
    })
    const runBefore = present(host.rows('runs')[0], 'first run')
    expect(runBefore.autoDeliver).toBe(true)

    // The executor streams its work and simply ends the turn: no tool call.
    emit(root, EXECUTOR, {
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '完成；测试 20/20' }] },
      },
    })
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await until(() => host.prompts.length === 1, 'auto review delivery')
    expect(present(host.prompts[0], 'first prompt').sessionId).toBe(PARENT)
    expect(present(host.prompts[0], 'first prompt').text).toContain('完成；测试 20/20')
    expect(present(host.prompts[0], 'first prompt').text).toContain('你是审核者')
    expect(present(host.rows('runs')[0], 'first run').phase).toBe('awaiting-review')

    // A replayed turn/end (restart replay) must not re-deliver: the reply
    // text was consumed with the first event.
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(host.prompts).toHaveLength(1)
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('an active goal holds the auto-delivery until the goal settles', async () => {
    const { root, host } = await boot()
    const svc = present(root.get('triggerBindings'), 'triggerBindings service')
    await svc.bindReviewLoop({
      task: '任务',
      executorSession: EXECUTOR,
      parentSession: PARENT,
    })
    emit(root, EXECUTOR, {
      type: 'goal/change',
      data: {
        kind: 'goal/change',
        version: 1,
        operation: 'create',
        goal: { phase: 'active' },
        roundsStarted: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    emit(root, EXECUTOR, {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '中途进展' }] },
      },
    })
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(host.prompts).toHaveLength(0) // no premature delivery, and no nudge either

    emit(root, EXECUTOR, {
      type: 'goal/change',
      data: {
        kind: 'goal/change',
        version: 1,
        operation: 'complete',
        goal: { phase: 'complete' },
        roundsStarted: 2,
        createdAt: 1,
        updatedAt: 2,
      },
    })
    emit(root, EXECUTOR, {
      type: 'assistant/message',
      data: {
        turn: 2,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: '目标完成交付' }] },
      },
    })
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await until(() => host.prompts.length === 1, 'auto review delivery after goal settled')
    expect(present(host.prompts[0], 'first prompt').text).toContain('目标完成交付')
    expect(present(host.rows('runs')[0], 'first run').phase).toBe('awaiting-review')
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('a foreign same-numbered turn never commits the pending signal', async () => {
    const { root, host } = await boot()
    const svc = present(root.get('triggerBindings'), 'triggerBindings service')
    const bound = await svc.bindReviewLoop({
      task: 't',
      executorSession: EXECUTOR,
      parentSession: PARENT,
    })

    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    // The reviewer happens to be on its own turn 1 and ends it first: the
    // executor has NOT ended; nothing may advance.
    emit(root, PARENT, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(host.prompts).toHaveLength(0)
    expect(present(host.rows('runs')[0], 'first run').phase).toBe('awaiting-delivery')

    // The real owner's turn end commits exactly once.
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(() => host.prompts.length === 1, 'review delivery')
    expect(present(host.rows('runs')[0], 'first run').phase).toBe('awaiting-review')
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('one session cannot pend the same turn for two runs', async () => {
    const { root } = await boot()
    const svc = present(root.get('triggerBindings'), 'triggerBindings service')
    const first = await svc.bindReviewLoop({
      task: 't1',
      executorSession: EXECUTOR,
      parentSession: PARENT,
    })
    const second = await svc.bindReviewLoop({
      task: 't2',
      executorSession: EXECUTOR,
      parentSession: 'sess-parent-2',
    })

    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 2 } })
    await svc.signal(EXECUTOR, { runId: first.runId, outcome: 'deliver', summary: 's' })
    const rejected = await svc.signal(EXECUTOR, {
      runId: second.runId,
      outcome: 'deliver',
      summary: 's',
    })
    expect(rejected).toMatchObject({ ok: false })
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it("a stale round's failed delivery is refused, not re-sent", async () => {
    const { root, host } = await boot({ queueFails: true })
    const svc = present(root.get('triggerBindings'), 'triggerBindings service')
    const bound = await svc.bindReviewLoop({
      task: 't',
      executorSession: EXECUTOR,
      parentSession: PARENT,
      maxRounds: 5,
    })
    // Round 1: the review delivery fails and parks the run.
    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 'r1' })
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(
      () => present(host.rows('runs')[0], 'first run').status === 'paused-error',
      'parked run',
    )
    const stale = present(
      host.rows('deliveries').find((d) => d.state === 'failed'),
      'failed round-1 delivery',
    )

    // The user resumes with a note and the loop moves on to round 2.
    host.ctx.sessionController.prompt = async (request: {
      requestId: string
      sessionId: string
      mode: string
      content: { text: string }[]
    }) => {
      host.prompts.push({
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: request.mode,
        text: request.content[0]?.text ?? '',
      })
      return { accepted: true as const }
    }
    await svc.controlRun(bound.runId, 'resume', { message: '继续' })
    emit(root, PARENT, { type: 'turn/start', data: { turn: 5 } })
    await svc.signal(PARENT, { runId: bound.runId, outcome: 'rework', summary: '改一版' })
    emit(root, PARENT, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await until(() => present(host.rows('runs')[0], 'first run').round === 2, 'round 2')
    const promptsBefore = host.prompts.length

    // The round-1 review delivery is now stale: re-sending it would wake the
    // reviewer with outdated instructions whose verdict could corrupt round 2.
    await expect(
      svc.controlRun(bound.runId, 'redeliver', { deliveryId: stale.id }),
    ).rejects.toThrow('过期投递')
    expect(host.prompts.length).toBe(promptsBefore)
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })

  it('redelivery resumes before sending, so an immediate answer is accepted; a cancelled run refuses redelivery', async () => {
    const { root, host } = await boot({ queueFails: true })
    const svc = present(root.get('triggerBindings'), 'triggerBindings service')
    const bound = await svc.bindReviewLoop({
      task: 't',
      executorSession: EXECUTOR,
      parentSession: PARENT,
    })
    emit(root, EXECUTOR, { type: 'turn/start', data: { turn: 1 } })
    await svc.signal(EXECUTOR, { runId: bound.runId, outcome: 'deliver', summary: 's' })
    emit(root, EXECUTOR, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await until(
      () => present(host.rows('runs')[0], 'first run').status === 'paused-error',
      'parked run',
    )
    const failed = present(
      host.rows('deliveries').find((d) => d.state === 'failed'),
      'failed round-1 delivery',
    )

    // The counterpart answers the moment the prompt lands — DURING the send,
    // before controlRun returns. The run must already accept signals by then.
    let inlineAnswer: { ok: boolean } | undefined
    host.ctx.sessionController.prompt = async (request: {
      requestId: string
      sessionId: string
      mode: string
      content: { text: string }[]
    }) => {
      host.prompts.push({
        requestId: request.requestId,
        sessionId: request.sessionId,
        mode: request.mode,
        text: request.content[0]?.text ?? '',
      })
      if (request.sessionId === PARENT) {
        emit(root, PARENT, { type: 'turn/start', data: { turn: 5 } })
        inlineAnswer = await svc.signal(PARENT, {
          runId: bound.runId,
          outcome: 'pass',
          summary: '即时通过',
        })
      }
      return { accepted: true as const }
    }
    await svc.controlRun(bound.runId, 'redeliver', { deliveryId: failed.id })
    await until(() => host.prompts.length === 1, 're-sent delivery')
    expect(present(host.prompts[0], 'first prompt').requestId).toBe(failed.requestId)
    expect(present(host.rows('runs')[0], 'first run').status).toBe('active')
    // The immediate answer was accepted — no paused-run rejection window.
    expect(inlineAnswer).toMatchObject({ ok: true })
    emit(root, PARENT, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await until(
      () => present(host.rows('runs')[0], 'first run').status === 'completed',
      'run completion',
    )

    // A cancelled run must never wake the counterpart again.
    const second = await svc.bindReviewLoop({
      task: 't2',
      executorSession: 'sess-exec-2',
      parentSession: PARENT,
    })
    host.ctx.sessionController.prompt = async () => {
      throw new Error('queue refused (drill)')
    }
    emit(root, 'sess-exec-2', { type: 'turn/start', data: { turn: 1 } })
    await svc.signal('sess-exec-2', { runId: second.runId, outcome: 'deliver', summary: 's' })
    emit(root, 'sess-exec-2', {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    await until(
      () =>
        present(
          host.rows('runs').find((r) => r.id === second.runId),
          'second run',
        ).status === 'paused-error',
      'second parked run',
    )
    await svc.controlRun(second.runId, 'cancel')
    const failedSecond = present(
      host
        .rows('deliveries')
        .filter((d) => d.runId === second.runId)
        .find((d) => d.state === 'failed'),
      'failed second-run delivery',
    )
    await expect(
      svc.controlRun(second.runId, 'redeliver', { deliveryId: failedSecond.id }),
    ).rejects.toThrow('运行已结束')
    // (no root.dispose in cordis 4.0.4; fibers clean up with the context)
  })
})
