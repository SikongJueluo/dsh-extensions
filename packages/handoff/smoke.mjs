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
import { mkdir, rm, writeFile } from 'node:fs/promises'
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

const badFlag = await registered.handler({ rawInput: '--model nogood fix readme', agent: null, signal: null })
console.log('bad-flag result:', JSON.stringify(badFlag))
if (badFlag.kind !== 'error' || !badFlag.text.includes('Usage')) throw new Error('expected flag usage error')

const flagNoTask = await registered.handler({ rawInput: '--model deepseek/chat', agent: null, signal: null })
console.log('flag-no-task result:', JSON.stringify(flagNoTask))
if (flagNoTask.kind !== 'error' || !flagNoTask.text.includes('Usage')) throw new Error('expected flag+task usage error')

// ---------------------------------------------------------------- part 2 ---
// A full stub context: channel route captured, agents.create recorded, and a
// writable workspace for the brief.
const cwd = fileURLToPath(new URL('./.smoke-workspace/', import.meta.url))
await rm(cwd, { recursive: true, force: true })
await mkdir(cwd, { recursive: true })

let route = null
let created = null
let renamed = null
const followups = []           // the origin agent's queued prompt
const spawnedFollowups = []    // the fresh agent's first prompt
const flowDisposers = []

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
 * Run one complete handoff cycle: start the command, answer the pending pick,
 * hand it a completion-marked brief, and wait for the spawn.
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
  const briefText = followups[0].content[0].text
  const briefPath = briefText.match(/\S+handoff\.md/)?.[0]
  if (briefPath === undefined) throw new Error('brief instruction names no target file')
  await mkdir(dirname(briefPath), { recursive: true })
  await writeFile(briefPath, `# Goal\nsmoke\n<!-- handoff:complete -->\n`, 'utf8')
  for (let i = 0; i < 200 && created === null; i += 1) await new Promise(resolve => setTimeout(resolve, 10))
  if (created === null) throw new Error(`"${rawInput}": the watcher never spawned the fresh session`)
  return { pick, answer, options: created.agentOptions, meta: created.meta }
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

const chosen = await channel('choose', {
  requestId: pending.id,
  choice: { kind: 'model', provider: 'picked-provider', model: 'picked-model', reasoningEffort: 'high' },
})
if (chosen.ok !== true) throw new Error(`choose rejected: ${JSON.stringify(chosen)}`)

const answer = await handled
console.log('command result:', JSON.stringify(answer))
if (answer.kind !== 'success' || !answer.text.includes('picked-provider/picked-model')) {
  throw new Error('command result does not name the picked route')
}
if (!answer.text.includes('强度 high')) throw new Error('command result does not name the picked effort')
if (followups.length !== 1) throw new Error('expected exactly one briefing turn on the origin agent')

// Simulate the origin agent writing the brief it was asked for.
const briefText = followups[0].content[0].text
const briefPath = briefText.match(/\S+handoff\.md/)?.[0]
if (briefPath === undefined) throw new Error('brief instruction names no target file')
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
if (created.meta.cwd !== cwd) throw new Error('fresh session did not inherit the workspace cwd')
if (spawnedFollowups.length !== 1 || !spawnedFollowups[0].content[0].text.includes('smoke')) {
  throw new Error('the brief was not handed to the fresh session as its first prompt')
}
if (renamed !== 'Handoff: fix the readme') throw new Error(`unexpected session title: ${renamed}`)
console.log('spawned:', JSON.stringify(created.agentOptions), '| title:', renamed)

// Inheriting the window must carry the session's durable effort (medium), not
// the creation-option effort (absent), and must keep the origin output cap.
const inherit = await runHandoff('inherited cycle', { kind: 'inherit' })
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

// The deployment default must carry its own effort.
const fallback = await runHandoff('default cycle', { kind: 'default' })
console.log('default spawn:', JSON.stringify(fallback.options))
if (fallback.options.provider !== 'global-provider' || fallback.options.model !== 'global-model') {
  throw new Error(`default used the wrong route: ${JSON.stringify(fallback.options)}`)
}
if (fallback.options.reasoningEffort !== 'low') {
  throw new Error(`default lost its effort: ${JSON.stringify(fallback.options)}`)
}

for (const dispose of [...flowDisposers, ...disposers]) dispose()
await rm(cwd, { recursive: true, force: true })
console.log('smoke OK')
