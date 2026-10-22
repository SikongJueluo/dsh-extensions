/* Cross-plugin integration test: the real Cordis runtime with BOTH real
 * built plugins (dsh-triggers + dsh-handoff from lib/), stub host services
 * whose shapes come from the host type declarations. This is the seam that
 * proved the auto-review binding broken: handoff resolves the triggers
 * service through ctx.get() — the Cordis trace proxy — at spawn time.
 *
 * Requires `pnpm build` in both packages first (lib/ is the runtime under
 * test). Run: node --test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import * as handoffPlugin from '../lib/index.js'
import * as triggersPlugin from '../../triggers/lib/index.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, ms, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const value = await fn()
    if (value) return value
    await sleep(10)
  }
  throw new Error(`timeout waiting for ${what}`)
}

/** Stub host surface (shapes verified against host .d.ts files). */
function makeHost({ queueFails = false } = {}) {
  const state = {
    toolDefs: new Map(),
    commandDefs: new Map(),
    prompts: [],
    createdAgents: [],
    followups: new Map(),
    routes: [],
    domains: new Map(),
  }
  const tools = {
    register(def) { state.toolDefs.set(def.name, def); return () => state.toolDefs.delete(def.name) },
  }
  const sessionController = {
    async prompt(request) {
      if (queueFails) throw new Error('queue refused (drill)')
      state.prompts.push({ ...request, text: request.content?.[0]?.text })
      return { accepted: true }
    },
    async list() { return { items: [] } },
  }
  const storageDomain = {
    async open(spec) {
      const store = { tables: new Map() }
      for (const name of Object.keys(spec.tables)) store.tables.set(name, new Map())
      state.domains.set(spec.name, store)
      return {
        table(name) {
          const map = store.tables.get(name)
          if (map === undefined) throw new Error(`unknown table ${name}`)
          const valueSchema = spec.tables[name]?.valueSchema
          return {
            get: k => map.get(k),
            entries: () => map.entries(),
            keys: () => map.keys(),
            get size() { return map.size },
            async put(k, v) {
              if (valueSchema) {
                const parsed = valueSchema.safeParse(v)
                if (!parsed.success) {
                  throw new Error(`zod boundary rejected ${name}[${k}]: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
                }
              }
              map.set(k, structuredClone(v))
            },
            async delete(k) { return map.delete(k) },
          }
        },
        async close() {},
      }
    },
  }
  const commands = {
    register(def) { state.commandDefs.set(def.name, def); return () => state.commandDefs.delete(def.name) },
  }
  const agents = {
    async create(options) {
      state.createdAgents.push(options)
      const sid = String(options.sessionId)
      state.followups.set(sid, state.followups.get(sid) ?? [])
      return {
        agent: { id: options.sessionId, followup: message => state.followups.get(sid).push(message) },
        dispose: async () => {},
      }
    },
  }
  const connection = { requestRejection: () => undefined }
  const webServer = { register(route) { state.routes.push(route); return () => {} } }
  return { state, tools, sessionController, storageDomain, commands, agents, connection, webServer }
}

async function boot({ withTriggers = true, queueFails = false, config } = {}) {
  const host = makeHost({ queueFails })
  const root = new Context()
  root.provide('tools', host.tools)
  root.provide('sessionController', host.sessionController)
  root.provide('storageDomain', host.storageDomain)
  root.provide('commands', host.commands)
  root.provide('agents', host.agents)
  root.provide('connection', host.connection)
  root.provide('webServer', host.webServer)
  if (withTriggers) await root.plugin(triggersPlugin, {})
  await root.plugin(handoffPlugin, { ...config })
  return { root, host }
}


/** boot with extra provided services (e.g. a workspace registry). */
async function bootWithServices(config, extra) {
  const host = makeHost({})
  const root = new Context()
  root.provide('tools', host.tools)
  root.provide('sessionController', host.sessionController)
  root.provide('storageDomain', host.storageDomain)
  root.provide('commands', host.commands)
  root.provide('agents', host.agents)
  root.provide('connection', host.connection)
  root.provide('webServer', host.webServer)
  for (const [name, value] of Object.entries(extra)) root.provide(name, value)
  await root.plugin(triggersPlugin, {})
  await root.plugin(handoffPlugin, { ...config })
  return { root, host }
}

const emit = (root, sessionId, event) => root.emit('session/event', { id: sessionId }, event)

/** One channel call exactly as the browser half sends it. */
async function channel(host, endpoint, payload) {
  const route = host.state.routes.find(r => r.path === '/dsh-handoff')
  if (route === undefined) throw new Error('handoff channel route not mounted')
  const body = JSON.stringify({ type: 'client-request', rpcId: `it-${endpoint}`, method: endpoint, payload })
  const req = {
    method: 'POST', url: `/dsh-handoff/${endpoint}`, headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') },
  }
  let status = 0
  let text = ''
  const res = { writeHead(code) { status = code }, end(chunk) { text = chunk ?? '' }, destroy() {} }
  await route.handler(req, res)
  if (status !== 200) throw new Error(`channel ${endpoint} -> HTTP ${status}`)
  return JSON.parse(text).result
}

/** Run the trigger_signal tool through the real ToolDefinition.execute. */
async function callSignalTool(host, callerSessionId, args) {
  const def = host.state.toolDefs.get('trigger_signal')
  if (def === undefined) throw new Error('trigger_signal tool is not registered')
  return {
    result: await def.execute(args, {
      agent: { id: callerSessionId },
      signal: new AbortController().signal,
      concludeTurn: () => {},
    }),
  }
}

const triggerRows = (host, table) => {
  const store = host.state.domains.get('triggers')
  return store === undefined ? [] : [...store.tables.get(table).values()]
}

/** An origin agent plus a writable workspace directory. */
async function originFixture(host, label) {
  const cwd = new URL(`./.smoke-review-ws/${label}`, import.meta.url).pathname
  await rm(new URL(`./.smoke-review-ws/${label}`, import.meta.url), { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  const id = `origin-${label}`
  host.state.followups.set(id, [])
  return {
    cwd,
    agent: {
      id,
      options: { provider: 'origin-provider', model: 'origin-model' },
      session: { header: { cwd } },
      followup: m => host.state.followups.get(id).push(m),
    },
  }
}

/** Answer the pending browser pick (liveness poll + choose). */
async function answerPick(host, choice) {
  await channel(host, 'pending', {})
  const pick = await until(async () => (await channel(host, 'pending', {})).requests[0], 3000, 'pending pick')
  const chosen = await channel(host, 'choose', { requestId: pick.id, choice })
  assert.equal(chosen.ok, true, `choose rejected: ${JSON.stringify(chosen)}`)
  return pick
}

/** Write the completion-marked brief and await the spawn. */
async function completeBrief(host, originId) {
  const briefMsg = await until(() => host.state.followups.get(originId)?.[0], 3000, 'briefing followup')
  const briefPath = briefMsg.content[0].text.match(/\S+handoff\.md/)?.[0]
  if (briefPath === undefined) throw new Error('brief instruction names no file')
  await writeFile(briefPath, '# Goal\nintegration\n<!-- handoff:complete -->\n', 'utf8')
  const created = await until(() => host.state.createdAgents.at(-1), 5000, 'agents.create')
  return { briefPath, created }
}

test('flag path: --review binds the loop before the first prompt and the loop closes', async () => {
  const config = handoffPlugin.Config ? handoffPlugin.Config({}) : {}
  const { root, host } = await boot({ config: { ...config, pollMs: 100, timeoutMs: 8000 } })
  const t = await test.context
  try {
    const command = host.state.commandDefs.get('handoff')
    assert.ok(command, 'handoff command registered')
    assert.ok(host.state.toolDefs.has('trigger_signal'), 'signal tool registered')
    assert.equal(typeof root.get('triggerBindings')?.bindReviewLoop, 'function', 'cross-plugin service visible')

    const { cwd, agent } = await originFixture(host, 'flag')
    // The liveness poll must precede the command: clientAttached() decides
    // whether waiting for a real picker is worthwhile.
    await channel(host, 'pending', {})
    const handled = command.handler({ rawInput: '--review --model prov/model fix the flaky tests', agent, signal: null })
    await answerPick(host, { kind: 'inherit' })
    const answer = await handled
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    assert.ok(answer.text.includes('Auto review: 已请求'), answer.text)
    assert.ok(answer.text.includes('绑定随新会话创建'), 'result separates intent from binding')

    const { briefPath, created } = await completeBrief(host, 'origin-flag')

    // bindReview runs after agents.create resolves; wait for it to land.
    const bindings = await until(() => {
      const rows = triggerRows(host, 'bindings').filter(b => b.parent === 'origin-flag')
      return rows.length === 1 ? rows : undefined
    }, 3000, 'review binding')
    const runs = triggerRows(host, 'runs')
    assert.equal(bindings.length, 1, `one binding, got ${JSON.stringify(bindings.map(b => b.parent))}`)
    assert.equal(bindings[0].parent, 'origin-flag')
    assert.equal(bindings[0].executor, String(created.sessionId))
    assert.ok(runs.length >= 1)
    const run = runs.find(r => r.parent === 'origin-flag')
    assert.ok(run, 'run for this origin exists')
    assert.equal(run.status, 'active')
    assert.equal(run.phase, 'awaiting-delivery')
    assert.equal(run.maxRounds, 5)

    const metaPath = briefPath.replace(/\.md$/, '.meta.json')
    await until(async () => {
      const metaNow = JSON.parse(await readFile(metaPath, 'utf8'))
      return metaNow.review?.runId
    }, 3000, 'meta bound runId')
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    assert.equal(meta.review?.runId, run.id, 'meta records the bound runId')
    assert.equal(meta.review?.bindingId, bindings[0].id)

    const firstPrompt = await until(
      () => host.state.followups.get(String(created.sessionId))?.[0], 3000, 'first prompt')
    const promptText = firstPrompt.content[0].text
    assert.ok(promptText.includes('[triggers]'), 'bootstrap prompt carries the triggers section')
    assert.ok(promptText.includes(`runId=${run.id}`))
    assert.ok(promptText.includes('trigger_signal'))
    assert.equal(host.state.prompts.length, 0, 'handoff-style bind delivers no start prompt of its own')

    // Executor round: deliver signal, turn end → review queued to the origin.
    const exec = String(created.sessionId)
    emit(root, exec, { type: 'turn/start', data: { turn: 1 } })
    const sig = await callSignalTool(host, exec, { runId: run.id, outcome: 'deliver', summary: '修好；测试 31/31' })
    assert.equal(sig.result?.kind, 'accepted')
    emit(root, exec, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const review = await until(() => host.state.prompts.find(p => p.sessionId === 'origin-flag'), 3000, 'review delivery')
    assert.equal(review.mode, 'queue')
    assert.ok(review.text.includes(`runId=${run.id}`))
    assert.ok(review.text.includes('你是审核者'))
    assert.ok(review.text.includes('31/31'))

    // Reviewer round: pass → notice → completed.
    emit(root, 'origin-flag', { type: 'turn/start', data: { turn: 7 } })
    const verdict = await callSignalTool(host, 'origin-flag', { runId: run.id, outcome: 'pass', summary: '通过' })
    assert.equal(verdict.result?.kind, 'accepted')
    emit(root, 'origin-flag', { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    await until(() => triggerRows(host, 'runs').find(r => r.id === run.id)?.status === 'completed', 3000, 'run completion')

    const promptsBefore = host.state.prompts.length
    emit(root, 'origin-flag', { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
    await sleep(120)
    assert.equal(host.state.prompts.length, promptsBefore, 'replayed turn/end queues nothing extra')
  } finally {
    await rm(new URL('./.smoke-review-ws/flag', import.meta.url), { recursive: true, force: true })
  }
})

test('dialog path: the review verdict from the browser binds with its budget', async () => {
  const config = handoffPlugin.Config ? handoffPlugin.Config({}) : {}
  const { root, host } = await boot({ config: { ...config, pollMs: 100, timeoutMs: 8000 } })
  try {
    const command = host.state.commandDefs.get('handoff')
    const { agent } = await originFixture(host, 'dialog')

    await channel(host, 'pending', {})
    const handled = command.handler({ rawInput: 'channel review toggle task', agent, signal: null })
    const pick = await until(async () => (await channel(host, 'pending', {})).requests[0], 3000, 'pending pick')
    assert.equal(pick.review?.defaultRounds, 5, `pick offers the review toggle: ${JSON.stringify(pick.review)}`)
    const chosen = await channel(host, 'choose', {
      requestId: pick.id,
      choice: { kind: 'inherit', workspace: 'origin', review: { enabled: true, rounds: 8 } },
    })
    assert.equal(chosen.ok, true, JSON.stringify(chosen))
    const answer = await handled
    assert.equal(answer.kind, 'success')
    assert.ok(answer.text.includes('最多 8 轮'), answer.text)

    const { created } = await completeBrief(host, 'origin-dialog')
    const run = await until(() => triggerRows(host, 'runs').find(r => r.parent === 'origin-dialog'), 3000, 'bound run')
    assert.ok(run, 'run bound')
    assert.equal(run.maxRounds, 8, 'dialog budget honored')
    const firstPrompt = await until(
      () => host.state.followups.get(String(created.sessionId))?.[0], 3000, 'first prompt')
    assert.ok(firstPrompt.content[0].text.includes('预算 8 轮'))
  } finally {
    await rm(new URL('./.smoke-review-ws/dialog', import.meta.url), { recursive: true, force: true })
  }
})

test('no triggers mounted: --review degrades to a plain handoff with a visible notice', async () => {
  const config = handoffPlugin.Config ? handoffPlugin.Config({}) : {}
  const { host } = await boot({ withTriggers: false, config: { ...config, pollMs: 100, timeoutMs: 8000 } })
  try {
    const command = host.state.commandDefs.get('handoff')
    const { agent } = await originFixture(host, 'plain')
    await channel(host, 'pending', {})
    const handled = command.handler({ rawInput: '--review --model p/m task without triggers', agent, signal: null })
    await answerPick(host, { kind: 'inherit' })
    const answer = await handled
    assert.equal(answer.kind, 'success')

    const { created } = await completeBrief(host, 'origin-plain')
    const firstPrompt = await until(
      () => host.state.followups.get(String(created.sessionId))?.[0], 3000, 'first prompt')
    assert.ok(!firstPrompt.content[0].text.includes('[triggers]'), 'plain handoff without the loop')
    const notice = host.state.followups.get('origin-plain')
      .map(m => m.content?.[0]?.text ?? '')
      .find(text => text.includes('普通交接'))
    assert.ok(notice, 'the degradation notice is queued on the origin session')
  } finally {
    await rm(new URL('./.smoke-review-ws/plain', import.meta.url), { recursive: true, force: true })
  }
})

test('flag-fixed summary: --workspace + --review reaches the card with the real target and verdict', async () => {
  const config = handoffPlugin.Config ? handoffPlugin.Config({}) : {}
  // A two-workspace registry so --workspace resolves a non-origin target.
  const registry = {
    list: () => [
      { id: 'ws-origin', title: 'Origin Space', path: '/int/origin', status: async () => 'ok' },
      { id: 'ws-other', title: 'Other Space', path: '/int/other', status: async () => 'ok' },
    ],
    get: (id) => (id === 'ws-other'
      ? { id: 'ws-other', title: 'Other Space', path: '/int/other', status: async () => 'ok' }
      : id === 'ws-origin'
        ? { id: 'ws-origin', title: 'Origin Space', path: '/int/origin', status: async () => 'ok' }
        : undefined),
    resolveByPath: async () => undefined,
  }
  try {
    const { host: host2 } = await bootWithServices(config, { workspaceRegistry: registry })
    const command = host2.state.commandDefs.get('handoff')
    const { agent } = await originFixture(host2, 'flags')
    await channel(host2, 'pending', {})
    const handled = command.handler({
      rawInput: '--workspace Other Space --review flag summary task',
      agent,
      signal: null,
    })
    const pick = await until(async () => (await channel(host2, 'pending', {})).requests[0], 3000, 'pending pick')
    // The card's summary must state what will actually run: the flag target
    // and the flag-decided review verdict, not the defaults.
    assert.equal(pick.fixedWorkspace?.id, 'ws-other', `fixedWorkspace: ${JSON.stringify(pick.fixedWorkspace)}`)
    assert.equal(pick.fixedWorkspace?.path, '/int/other')
    assert.equal(pick.review?.fixed, true, `review: ${JSON.stringify(pick.review)}`)
    assert.equal(pick.review?.enabled, true)
    assert.equal(pick.review?.defaultRounds, 5)
    const chosen = await channel(host2, 'choose', { requestId: pick.id, choice: { kind: 'inherit' } })
    assert.equal(chosen.ok, true, JSON.stringify(chosen))
    const answer = await handled
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    assert.ok(answer.text.includes('已请求'), answer.text)
    const { briefPath } = await completeBrief(host2, 'origin-flags')
    const meta = JSON.parse(await readFile(briefPath.replace(/\.md$/, '.meta.json'), 'utf8'))
    assert.equal(meta.target?.path, '/int/other', 'the flag target actually runs')
    assert.equal(meta.review?.maxRounds, 5)
  } finally {
    await rm(new URL('./.smoke-review-ws/flags', import.meta.url), { recursive: true, force: true })
  }
})
