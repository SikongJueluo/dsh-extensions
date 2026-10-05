/* Runtime smoke test for dsh-handoff.
 *
 * Part 1 — plugin surface: load, config defaults, command registration, and
 * the argument-validation paths, against a minimal stub context.
 *
 * Part 2 — full flow: drive the browser channel (pending → choose), let the
 * handler queue its brief instruction and arm the watcher, drop a
 * completion-marked brief where the instruction asked for it, and assert the
 * fresh session is created on the chosen model with the brief as its first
 * prompt.
 */
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { name, inject, Config, apply, COMMAND_NAME } from './lib/index.js'

let registered = null
const disposers = []
const ctx = {
  commands: {
    register(def) {
      registered = def
      return () => { registered = null }
    },
  },
  logger() {
    return { info() {}, warn() {} }
  },
  effect(fn) {
    disposers.push(fn())
    return () => {}
  },
  get(name) {
    if (name === 'agentDefaultModel') {
      return { currentSelection: () => ({ provider: 'global-provider', model: 'global-model', reasoningEffort: 'low' }) }
    }
    if (name === 'llm') return { listProviders: async () => [], listModels: async () => [] }
    return undefined
  },
  // Optional-service acquisitions (connection/webServer, presets, …) simply
  // never call back in this stub: the plugin must still apply cleanly.
  inject() {
    return () => {}
  },
}

const config = Config({})
console.log('plugin:', name, '| inject:', inject)
console.log('defaults:', JSON.stringify(config))
if (config.dir !== '.dsh/handoff') throw new Error('bad dir default')
if (config.timeoutMs !== 300000) throw new Error('bad timeout default')
if (config.confirm !== true) throw new Error('bad confirm default')
if (config.modelMenu !== true) throw new Error('bad modelMenu default')
if (config.pickTimeoutMs !== 120000) throw new Error('bad pickTimeoutMs default')

apply(ctx, config)
if (registered === null || registered.name !== COMMAND_NAME) throw new Error('command not registered')
console.log('registered command:', registered.name, '|', registered.description)

const result = await registered.handler({ rawInput: '   ', agent: null, signal: null })
console.log('empty-args result:', JSON.stringify(result))
if (result.kind !== 'error') throw new Error('expected usage error')

const badModelFlag = await registered.handler({ rawInput: '--model nogood fix readme', agent: null, signal: null })
console.log('bad-model-flag result:', JSON.stringify(badModelFlag))
if (badModelFlag.kind !== 'error' || !badModelFlag.text.includes('Usage')) throw new Error('expected flag usage error')

const flagNoTask = await registered.handler({ rawInput: '--model deepseek/chat', agent: null, signal: null })
console.log('flag-no-task result:', JSON.stringify(flagNoTask))
if (flagNoTask.kind !== 'error' || !flagNoTask.text.includes('Usage')) throw new Error('expected flag+task usage error')

// ---------------------------------------------------------------- part 2 ---
// A full stub context: channel route captured, agents.create recorded, and a
// writable workspace for the brief — plus a two-entry workspace registry so
// the cross-workspace paths (picker payload, --workspace, target copy) run.
const cwd = fileURLToPath(new URL('./.smoke-workspace', import.meta.url)).replace(/\/+$/, '')
const targetCwd = fileURLToPath(new URL('./.smoke-target', import.meta.url)).replace(/\/+$/, '')
await rm(cwd, { recursive: true, force: true })
await mkdir(cwd, { recursive: true })
await rm(targetCwd, { recursive: true, force: true })
await mkdir(targetCwd, { recursive: true })

let route = null
let created = null
let renamed = null
const followups = []           // the origin agent's queued prompt
const spawnedFollowups = []    // the fresh agent's first prompt
const attached = []            // [workspaceId, sessionId] attach records
const flowDisposers = []

function stubWorkspace(id, title, path) {
  return {
    id,
    title,
    path,
    sessionIds: [],
    status: async () => 'ok',
    attachSession: async (sessionId) => { attached.push([id, sessionId]) },
  }
}
const wsOrigin = stubWorkspace('ws-origin', 'Origin Space', cwd)
const wsTarget = stubWorkspace('ws-target', 'Target Space', targetCwd)
const registry = {
  list: () => [wsOrigin, wsTarget],
  get: (id) => (id === 'ws-origin' ? wsOrigin : id === 'ws-target' ? wsTarget : undefined),
  resolveByPath: async (path) => (path === cwd ? wsOrigin : undefined),
}

const svcCtx = {
  logger: ctx.logger,
  effect(fn) { flowDisposers.push(fn()); return () => {} },
  connection: { requestRejection: () => undefined },
  webServer: { register(spec) { route = spec; return () => { route = null } } },
}
const flowCtx = {
  commands: ctx.commands,
  logger: ctx.logger,
  effect: ctx.effect,
  get: ctx.get,
  inject(_services, cb) { cb(svcCtx) },
  agents: {
    async create(options) {
      created = options
      return {
        agent: { id: options.sessionId, followup: (message) => { spawnedFollowups.push(message) } },
        dispose: async () => {},
      }
    },
  },
}
flowCtx.get = (key) => {
  if (key === 'sessionTitle') return { rename: (_session, title) => { renamed = title } }
  if (key === 'workspaceRegistry') return registry
  // The origin session's durable selection: what it is actually on, including
  // the effort — deliberately different from the agent's creation options.
  if (key === 'sessionProjections') {
    return {
      stateOf: () => ({
        lastUsed: { provider: 'origin-provider', model: 'origin-model', reasoningEffort: 'low' },
        pending: { provider: 'origin-provider', model: 'origin-model', reasoningEffort: 'medium' },
      }),
    }
  }
  return ctx.get(key)
}

apply(flowCtx, { ...config, pollMs: 25, timeoutMs: 3000 })
if (route === null) throw new Error('channel route was not registered')
console.log('channel route registered:', route.path)

/** One channel call exactly as the browser half sends it. */
async function channel(endpoint, payload) {
  const body = JSON.stringify({ type: 'client-request', rpcId: `smoke-${endpoint}`, method: endpoint, payload })
  const req = {
    method: 'POST',
    url: `/dsh-handoff/${endpoint}`,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') },
  }
  let status = 0
  let text = ''
  const res = { writeHead(code) { status = code }, end(chunk) { text = chunk ?? '' }, destroy() {} }
  await route.handler(req, res)
  if (status !== 200) throw new Error(`channel ${endpoint} -> HTTP ${status}`)
  return JSON.parse(text).result
}

// A browser polls once, which is also the liveness signal that makes the
// command wait for a real picker.
const before = await channel('pending', {})
if (before.requests.length !== 0) throw new Error('expected no pending picks before the command')

const agent = {
  id: 'origin-session',
  options: { provider: 'origin-provider', model: 'origin-model', maxTokens: 4096 },
  session: { header: { cwd } },
  followup(message) { followups.push(message) },
}

/**
 * Write the completion-marked brief the instruction asked for and wait for
 * the watcher to spawn the fresh session.
 */
async function completeBrief() {
  const briefText = followups[0].content[0].text
  const briefPath = briefText.match(/\S+handoff\.md/)?.[0]
  if (briefPath === undefined) throw new Error('brief instruction names no target file')
  await mkdir(dirname(briefPath), { recursive: true })
  await writeFile(briefPath, `# Goal\nsmoke\n<!-- handoff:complete -->\n`, 'utf8')
  for (let i = 0; i < 200 && created === null; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  if (created === null) throw new Error('the watcher never spawned the fresh session')
  return { briefPath, briefText }
}

/**
 * Run one complete handoff cycle through the browser dialog: start the
 * command, answer the pending pick, complete the brief, await the spawn.
 */
async function runHandoff(rawInput, choice) {
  created = null
  followups.length = 0
  spawnedFollowups.length = 0
  const handled = registered.handler({ rawInput, agent, signal: null })
  let pick = null
  for (let i = 0; i < 40 && pick === null; i += 1) {
    const listed = await channel('pending', {})
    if (listed.requests.length > 0) pick = listed.requests[0]
    else await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (pick === null) throw new Error(`"${rawInput}": the command never published a pending pick`)
  const chosen = await channel('choose', { requestId: pick.id, choice })
  if (chosen.ok !== true) throw new Error(`"${rawInput}": choose rejected: ${JSON.stringify(chosen)}`)
  const answer = await handled
  if (answer.kind !== 'success') throw new Error(`"${rawInput}": command failed: ${JSON.stringify(answer)}`)
  const brief = await completeBrief()
  return {
    pick,
    answer,
    options: created.agentOptions,
    meta: created.meta,
    sessionId: created.sessionId,
    ...brief,
  }
}

/**
 * Run one flag-resolved handoff cycle (no dialog is published at all).
 */
async function runFlagged(rawInput) {
  created = null
  followups.length = 0
  spawnedFollowups.length = 0
  const answer = await registered.handler({ rawInput, agent, signal: null })
  if (answer.kind !== 'success') throw new Error(`"${rawInput}": flagged command failed: ${JSON.stringify(answer)}`)
  const brief = await completeBrief()
  return {
    answer,
    options: created.agentOptions,
    meta: created.meta,
    sessionId: created.sessionId,
    ...brief,
  }
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const handled = registered.handler({ rawInput: 'fix the readme', agent, signal: null })

let pending = null
for (let i = 0; i < 40 && pending === null; i += 1) {
  const listed = await channel('pending', {})
  if (listed.requests.length > 0) pending = listed.requests[0]
  else await new Promise(resolve => setTimeout(resolve, 10))
}
if (pending === null) throw new Error('the command never published a pending pick')
console.log('pending pick:', JSON.stringify(pending))
// Both base options must carry the effort their route is actually on: the
// origin session's durable (pending) selection, and the deployment default.
if (pending.inherited?.reasoningEffort !== 'medium') {
  throw new Error(`inherit route lost the session effort: ${JSON.stringify(pending.inherited)}`)
}
if (pending.fallback?.reasoningEffort !== 'low') {
  throw new Error(`global default lost its effort: ${JSON.stringify(pending.fallback)}`)
}
// The pick carries the workspace roster: origin first, others as the list.
if (pending.origin?.path !== cwd || pending.origin?.title !== 'Origin Space') {
  throw new Error(`origin workspace missing from the pick: ${JSON.stringify(pending.origin)}`)
}
if (pending.pickWorkspace !== true || pending.workspaces?.length !== 1 || pending.workspaces[0].id !== 'ws-target') {
  throw new Error(`workspace roster missing from the pick: ${JSON.stringify(pending.workspaces)}`)
}

const chosen = await channel('choose', {
  requestId: pending.id,
  choice: {
    kind: 'model',
    provider: 'picked-provider',
    model: 'picked-model',
    reasoningEffort: 'high',
    workspace: 'ws-target',
  },
})
if (chosen.ok !== true) throw new Error(`choose rejected: ${JSON.stringify(chosen)}`)

const answer = await handled
console.log('command result:', JSON.stringify(answer))
if (answer.kind !== 'success' || !answer.text.includes('picked-provider/picked-model')) {
  throw new Error('command result does not name the picked route')
}
if (!answer.text.includes('强度 high')) throw new Error('command result does not name the picked effort')
if (!answer.text.includes('Target Space') || !answer.text.includes(targetCwd)) {
  throw new Error('command result does not name the target workspace')
}
if (followups.length !== 1) throw new Error('expected exactly one briefing turn on the origin agent')

// Simulate the origin agent writing the brief it was asked for.
const briefText = followups[0].content[0].text
const briefPath = briefText.match(/\S+handoff\.md/)?.[0]
if (briefPath === undefined) throw new Error('brief instruction names no target file')
if (!briefText.includes('另一个工作区')) throw new Error('cross-workspace brief instruction lacks the inline hint')
await mkdir(dirname(briefPath), { recursive: true })
await writeFile(briefPath, `# Goal\nsmoke\n<!-- handoff:complete -->\n`, 'utf8')

for (let i = 0; i < 200 && created === null; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
if (created === null) throw new Error('the watcher never spawned the fresh session')
if (created.agentOptions.provider !== 'picked-provider' || created.agentOptions.model !== 'picked-model') {
  throw new Error(`fresh session used the wrong route: ${JSON.stringify(created.agentOptions)}`)
}
if (created.agentOptions.reasoningEffort !== 'high') {
  throw new Error(`fresh session dropped the picked effort: ${JSON.stringify(created.agentOptions)}`)
}
if (created.meta.cwd !== targetCwd) {
  throw new Error(`fresh session did not spawn on the target workspace: ${JSON.stringify(created.meta)}`)
}
if (!attached.some(([id, sessionId]) => id === 'ws-target' && sessionId === created.sessionId)) {
  throw new Error(`fresh session was not attached to the target workspace: ${JSON.stringify(attached)}`)
}
// The full brief must exist as a readable copy inside the target workspace.
const copyPath = `${targetCwd}/.dsh/handoff/${briefPath.split('/').pop()}`
if (!await fileExists(copyPath)) throw new Error(`no brief copy in the target workspace: ${copyPath}`)
if (!spawnedFollowups[0].content[0].text.includes('另一个工作区') || !spawnedFollowups[0].content[0].text.includes('smoke')) {
  throw new Error('the cross-workspace bootstrap prompt lacks the note or the brief')
}
if (renamed !== 'Handoff: fix the readme') throw new Error(`unexpected session title: ${renamed}`)
console.log('spawned:', JSON.stringify(created.agentOptions), '| title:', renamed, '| copy:', copyPath)

// Inheriting the window must carry the session's durable effort (medium), not
// the creation-option effort (absent), and must keep the origin output cap.
// Picking the origin workspace keeps everything inside the origin cwd: no
// target-side copy, attach goes to the origin workspace.
await rm(`${targetCwd}/.dsh/handoff`, { recursive: true, force: true })
const inherit = await runHandoff('inherited cycle', { kind: 'inherit', workspace: 'origin' })
console.log('inherit spawn:', JSON.stringify(inherit.options))
if (inherit.options.provider !== 'origin-provider' || inherit.options.model !== 'origin-model') {
  throw new Error(`inherit used the wrong route: ${JSON.stringify(inherit.options)}`)
}
if (inherit.options.reasoningEffort !== 'medium') {
  throw new Error(`inherit lost the session effort: ${JSON.stringify(inherit.options)}`)
}
if (inherit.options.maxTokens !== 4096) {
  throw new Error(`inherit lost the origin maxTokens: ${JSON.stringify(inherit.options)}`)
}
if (!inherit.answer.text.includes('强度 medium')) {
  throw new Error(`inherit result does not name the effort: ${inherit.answer.text}`)
}
if (inherit.meta.cwd !== cwd) {
  throw new Error(`origin pick must spawn on the origin cwd: ${JSON.stringify(inherit.meta)}`)
}
if (inherit.briefText.includes('另一个工作区')) {
  throw new Error('same-workspace brief instruction must not carry the cross hint')
}
if (await fileExists(`${targetCwd}/.dsh/handoff`)) {
  throw new Error('same-workspace handoff must not copy the brief into the target')
}
if (!attached.some(([id, sessionId]) => id === 'ws-origin' && sessionId === inherit.sessionId)) {
  throw new Error(`origin pick must attach to the origin workspace: ${JSON.stringify(attached)}`)
}
if (!spawnedFollowups[0].content[0].text.includes('smoke')) {
  throw new Error('the brief was not handed to the fresh session as its first prompt')
}

// The deployment default must carry its own effort.
const fallback = await runHandoff('default cycle', { kind: 'default', workspace: 'ws-target' })
console.log('default spawn:', JSON.stringify(fallback.options))
if (fallback.options.provider !== 'global-provider' || fallback.options.model !== 'global-model') {
  throw new Error(`default used the wrong route: ${JSON.stringify(fallback.options)}`)
}
if (fallback.options.reasoningEffort !== 'low') {
  throw new Error(`default lost its effort: ${JSON.stringify(fallback.options)}`)
}
if (fallback.meta.cwd !== targetCwd) {
  throw new Error(`default pick must honor the workspace verdict: ${JSON.stringify(fallback.meta)}`)
}

// `--workspace <title>` resolves the target without the browser step: the
// published pick asks for no workspace verdict, and the flag wins regardless
// of the (placeholder) workspace the browser sends back.
const flagged = await runHandoff('--workspace Target Space flag cycle', { kind: 'inherit' })
if (flagged.pick.pickWorkspace !== undefined && flagged.pick.pickWorkspace !== false) {
  throw new Error(`flag-resolved pick must not ask for a workspace: ${JSON.stringify(flagged.pick)}`)
}
if (flagged.meta.cwd !== targetCwd) {
  throw new Error(`--workspace did not steer the spawn: ${JSON.stringify(flagged.meta)}`)
}
console.log('flag spawn cwd:', flagged.meta.cwd)

// A --workspace spec that matches nothing fails up front with the candidates.
const badFlag = await registered.handler({ rawInput: '--workspace nosuch fix readme', agent, signal: null })
console.log('bad-flag result:', JSON.stringify(badFlag))
if (badFlag.kind !== 'error' || !badFlag.text.includes('Target Space')) {
  throw new Error('bad --workspace spec must fail naming the candidates')
}

// Both flags together skip the dialog entirely; order is free.
const ordered = await runFlagged('--workspace Target Space --model picked-provider/picked-model ordered cycle')
if (ordered.meta.cwd !== targetCwd || ordered.options.provider !== 'picked-provider' || ordered.options.model !== 'picked-model') {
  throw new Error(`flag order broke resolution: ${JSON.stringify(ordered)}`)
}
console.log('ordered flags spawn:', ordered.meta.cwd)

for (const dispose of [...flowDisposers, ...disposers]) dispose()
await rm(cwd, { recursive: true, force: true })
await rm(targetCwd, { recursive: true, force: true })
console.log('smoke OK')
