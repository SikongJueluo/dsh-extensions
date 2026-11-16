/* Host-half tests for remembered model defaults and independent preset
 * selection: the real built plugin (lib/) with stub host services whose shapes
 * come from the host type declarations. The storage stub keeps its domain
 * tables in a caller-owned map, so a second boot reuses the same "disk".
 *
 * Requires `pnpm build` first (lib/ is the runtime under test).
 * Run: node --test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import * as handoffPlugin from '../lib/index.js'

const COMPLETE = '<!-- handoff:complete -->'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, ms, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const value = await fn()
    if (value) return value
    await sleep(10)
  }
  throw new Error(`timeout waiting for ${what}`)
}

const PRESET_ROWS = [
  { id: 'preset-a', name: 'Preset A', description: 'origin preset' },
  { id: 'preset-b', name: 'Preset B', description: 'executor preset' },
  {
    id: 'preset-broken',
    name: 'Broken Preset',
    description: 'cannot compose',
    broken: 'missing service',
  },
]

const CATALOG = {
  default: { provider: 'prov', model: 'reasoner', reasoningEffort: 'low' },
  routableProviders: ['prov'],
  groups: [
    {
      id: 'prov',
      name: 'Provider',
      models: [
        {
          id: 'reasoner',
          name: 'Reasoner',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'low',
          },
        },
        { id: 'simple', name: 'Simple' },
      ],
    },
  ],
  failures: [],
}

function makePresets({ inherited = 'preset-a', rows = PRESET_ROWS } = {}) {
  const mounts = []
  return {
    mounts,
    composedPreset(agentCtx) {
      return agentCtx && agentCtx.livePreset !== undefined ? agentCtx.livePreset : inherited
    },
    async list() {
      return rows
    },
    async resolve(id) {
      const target = id === undefined ? inherited : id
      const row = rows.find((entry) => entry.id === target)
      if (row === undefined) throw new Error(`agent-preset/not-found: ${target}`)
      return { ...row }
    },
    async mount(agentCtx, id) {
      mounts.push(id)
      const row = rows.find((entry) => entry.id === id)
      if (row === undefined) throw new Error(`agent-preset/not-found: ${id}`)
      if (row.broken !== undefined) throw new Error(`cannot compose ${id}: ${row.broken}`)
      return { ...row }
    },
  }
}

/** Stub host surface (shapes verified against host .d.ts files). */
function makeHost({ domains, presets, catalog = CATALOG, putFails = false } = {}) {
  const state = {
    commandDefs: new Map(),
    createdAgents: [],
    followups: new Map(),
    routes: [],
    domains,
  }
  const storageDomain = {
    get(name) {
      const store = domains.get(name)
      if (store === undefined) return undefined
      return domainHandle(store, putFails)
    },
    async open(spec) {
      let store = domains.get(spec.name)
      if (store === undefined) {
        store = { tables: new Map() }
        for (const name of Object.keys(spec.tables)) store.tables.set(name, new Map())
        domains.set(spec.name, store)
      }
      return domainHandle(store, putFails)
    },
  }
  const commands = {
    register(def) {
      state.commandDefs.set(def.name, def)
      return () => state.commandDefs.delete(def.name)
    },
  }
  const agents = {
    async create(options) {
      state.createdAgents.push(options)
      const sid = String(options.sessionId)
      state.followups.set(sid, state.followups.get(sid) ?? [])
      // The real factory runs setup before publishing; preset mounts ride it.
      if (typeof options.setup === 'function') await options.setup({ fake: sid }, { id: sid })
      return {
        agent: {
          id: options.sessionId,
          options: options.agentOptions ?? {},
          session: { header: { cwd: options.meta.cwd } },
          followup: (message) => state.followups.get(sid).push(message),
        },
        dispose: async () => {},
      }
    },
  }
  const sessionController = {
    async modelCatalog() {
      return catalog
    },
  }
  const agentDefaultModel = {
    currentSelection() {
      return { provider: 'prov', model: 'reasoner', reasoningEffort: 'low' }
    },
  }
  const connection = { requestRejection: () => undefined }
  const webServer = {
    register(route) {
      state.routes.push(route)
      return () => {}
    },
  }
  return {
    state,
    storages: {
      storageDomain,
      commands,
      agents,
      sessionController,
      agentDefaultModel,
      connection,
      webServer,
    },
    presets,
  }
}

function domainHandle(store, putFails = false) {
  return {
    table(name) {
      const map = store.tables.get(name)
      if (map === undefined) throw new Error(`unknown table ${name}`)
      return {
        get: (key) => map.get(key),
        entries: () => map.entries(),
        keys: () => map.keys(),
        get size() {
          return map.size
        },
        async put(key, value) {
          if (putFails) throw new Error('disk full (test)')
          map.set(key, structuredClone(value))
        },
        async delete(key) {
          return map.delete(key)
        },
        async update(key, fn) {
          const next = fn(map.get(key))
          map.set(key, next)
          return next
        },
      }
    },
    async close() {},
  }
}

async function boot({
  confirm = true,
  domains = new Map(),
  presets,
  catalog,
  putFails = false,
  withChannel = true,
  withSessionController = true,
  userQuestions,
  llm,
  pickTimeoutMs = 120000,
} = {}) {
  const host = makeHost({ domains, presets, catalog, putFails })
  const root = new Context()
  for (const [name, value] of Object.entries(host.storages)) {
    if (!withChannel && (name === 'connection' || name === 'webServer')) continue
    if (!withSessionController && name === 'sessionController') continue
    root.provide(name, value)
  }
  if (presets !== undefined) root.provide('agentPresets', presets)
  if (userQuestions !== undefined) root.provide('userQuestions', userQuestions)
  if (llm !== undefined) root.provide('llm', llm)
  const config = {
    ...handoffPlugin.Config({}),
    confirm,
    pollMs: 100,
    timeoutMs: 8000,
    pickTimeoutMs,
  }
  await root.plugin(handoffPlugin, config)
  return { root, host: { ...host, state: host.state } }
}

/** A scripted `ctx.userQuestions` answerer: answers are queued before the ask. */
function makeQuestions() {
  const seen = []
  const answers = []
  return {
    seen,
    answers,
    ask(request) {
      seen.push(request)
      const next = answers.shift()
      if (next === undefined) return Promise.reject(new Error('no scripted answer'))
      return Promise.resolve(next)
    },
  }
}

/** One channel call exactly as the browser half sends it. */
async function channel(host, endpoint, payload) {
  const route = host.state.routes.find((entry) => entry.path === '/dsh-handoff')
  if (route === undefined) throw new Error('handoff channel route not mounted')
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `it-${endpoint}`,
    method: endpoint,
    payload,
  })
  const req = {
    method: 'POST',
    url: `/dsh-handoff/${endpoint}`,
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(chunk) {
      text = chunk ?? ''
    },
    destroy() {},
  }
  await route.handler(req, res)
  if (status !== 200) throw new Error(`channel ${endpoint} -> HTTP ${status}`)
  return JSON.parse(text).result
}

async function answerPick(host, choice) {
  await channel(host, 'pending', {})
  const pick = await until(
    async () => (await channel(host, 'pending', {})).requests[0],
    3000,
    'pending pick',
  )
  const chosen = await channel(host, 'choose', { requestId: pick.id, choice })
  assert.equal(chosen.ok, true, `choose rejected: ${JSON.stringify(chosen)}`)
  return pick
}

/**
 * An origin agent whose `model` accessor folds like the host's: the durable
 * selection when one exists, otherwise the creation options. `selection` stands
 * in for a recorded `/model` choice.
 */
function originModel(selection) {
  return {
    current: () => selection ?? { provider: 'origin-provider', model: 'origin-model' },
    select() {},
  }
}

async function originFixture(host, label, livePreset = 'preset-a', selection) {
  const cwd = new URL(`./.smoke-prefs/${label}`, import.meta.url).pathname
  await rm(cwd, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  const id = `origin-${label}`
  host.state.followups.set(id, [])
  return {
    cwd,
    agent: {
      id,
      options: { provider: 'origin-provider', model: 'origin-model' },
      model: originModel(selection),
      session: { header: { cwd } },
      ctx: { livePreset },
      followup: (message) => host.state.followups.get(id).push(message),
    },
  }
}

/** Write the completion-marked brief and await the next spawn. */
async function completeBrief(host, originId) {
  const briefMsg = await until(
    () => host.state.followups.get(originId)?.[0],
    3000,
    'briefing followup',
  )
  const briefPath = briefMsg.content[0].text.match(/\S+handoff\.md/)?.[0]
  if (briefPath === undefined) throw new Error('brief instruction names no file')
  const before = host.state.createdAgents.length
  await writeFile(briefPath, `# Goal\nintegration\n${COMPLETE}\n`, 'utf8')
  const created = await until(
    () => (host.state.createdAgents.length > before ? host.state.createdAgents.at(-1) : undefined),
    5000,
    'agents.create',
  )
  return { briefPath, created }
}

/** Write a retry sidecar with an already-complete brief (a lost watch). */
async function writeSidecar(
  cwd,
  {
    task = 'retry task',
    originSession = 'origin-sidecar',
    choice = { kind: 'inherit' },
    preset = { kind: 'inherit' },
  } = {},
) {
  const dir = `${cwd}/.dsh/handoff`
  await mkdir(dir, { recursive: true })
  const briefPath = `${dir}/20260102-000000-handoff.md`
  const metaPath = `${dir}/20260102-000000-handoff.meta.json`
  await writeFile(briefPath, `# Goal\nsidecar\n${COMPLETE}\n`, 'utf8')
  await writeFile(
    metaPath,
    `${JSON.stringify(
      {
        version: 1,
        task,
        originSession,
        target: { path: cwd, title: 'sidecar' },
        choice,
        preset,
        createdAt: Date.now(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return { briefPath, metaPath }
}

const prefRows = (host) => [
  ...(host.state.domains.get('handoff')?.tables.get('preferences')?.values() ?? []),
]
const pref = (host) => prefRows(host)[0]
/** Wait for the post-spawn preference write (it lands just after agents.create). */
const waitPref = (host, predicate, what) =>
  until(
    () => {
      const row = pref(host)
      return row !== undefined && predicate(row) ? row : undefined
    },
    3000,
    what,
  )
const metaFor = async (briefPath) =>
  JSON.parse(await readFile(briefPath.replace(/\.md$/, '.meta.json'), 'utf8'))

async function handoff(host, agent, rawInput) {
  const command = host.state.commandDefs.get('handoff')
  if (command === undefined) throw new Error('handoff command not registered')
  return command.handler({ rawInput, agent, signal: null })
}

// ══ tests ══════════════════════════════════════════════════════════════════

test('a successful handoff remembers its model and the next card starts there', async () => {
  const domains = new Map()
  const presets = makePresets()
  const { host } = await boot({ domains, presets })
  try {
    const first = await originFixture(host, 'first')
    await channel(host, 'pending', {})
    const pendingFirst = handoff(host, first.agent, 'first task')
    const pick = await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'reasoner',
      reasoningEffort: 'low',
      preset: { kind: 'inherit' },
    })
    assert.equal(pick.preset?.inherited, 'preset-a')
    assert.equal(pick.preset?.default?.kind, 'inherit')
    assert.deepEqual(pick.defaultChoice, { kind: 'inherit' }, 'the first handoff inherits')

    const started = await pendingFirst
    assert.equal(started.kind, 'success', JSON.stringify(started))
    const { briefPath, created } = await completeBrief(host, 'origin-first')
    assert.equal(created.meta.agentPreset, 'preset-a', 'inherit mounts the origin preset')
    const remembered = await waitPref(
      host,
      (row) => row.choice.kind === 'model' && row.choice.model === 'reasoner',
      'remembered model',
    )
    assert.equal(remembered.choice.reasoningEffort, 'low')
    assert.equal((await metaFor(briefPath)).preset.kind, 'inherit')

    // A later handoff in another session starts from that remembered route.
    const second = await originFixture(host, 'second')
    await channel(host, 'pending', {})
    const pendingSecond = handoff(host, second.agent, 'second task')
    const nextPick = await answerPick(host, { kind: 'default', preset: { kind: 'inherit' } })
    assert.deepEqual(nextPick.defaultChoice, {
      kind: 'model',
      provider: 'prov',
      model: 'reasoner',
      reasoningEffort: 'low',
    })
    assert.equal(nextPick.defaultChoiceIssue, undefined)
    const secondStarted = await pendingSecond
    assert.equal(secondStarted.kind, 'success', JSON.stringify(secondStarted))
    await completeBrief(host, 'origin-second')
    await waitPref(host, (row) => row.choice.kind === 'default', 'accepted default preference')
  } finally {
    await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
  }
})

test('--model never overwrites the remembered default; a restart keeps it', async () => {
  const domains = new Map()
  const presets = makePresets()
  {
    const { host } = await boot({ domains, presets })
    // First remember reasoner/low through the normal card.
    const first = await originFixture(host, 'remember')
    await channel(host, 'pending', {})
    const pendingFirst = handoff(host, first.agent, 'remember task')
    await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'reasoner',
      reasoningEffort: 'low',
      preset: { kind: 'inherit' },
    })
    assert.equal((await pendingFirst).kind, 'success')
    await completeBrief(host, 'origin-remember')
    await waitPref(host, (row) => row.choice.model === 'reasoner', 'remembered model')

    // A flag override is one-off: the stored route must not change.
    const flagged = await originFixture(host, 'flag-model')
    const pendingFlag = handoff(host, flagged.agent, '--model prov/simple flag task')
    const answer = await pendingFlag
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    assert.ok(answer.text.includes('prov/simple'), answer.text)
    await completeBrief(host, 'origin-flag-model')
    assert.equal(pref(host).choice.model, 'reasoner', 'a --model override writes no preference')
  }
  {
    // A fresh process (new root) reopens the same domain: the preference from
    // the first boot is still the default, with no browser pick needed.
    const { host } = await boot({ confirm: false, domains, presets })
    const origin = await originFixture(host, 'restart')
    const answer = await handoff(host, origin.agent, 'restart task')
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    const { created } = await completeBrief(host, 'origin-restart')
    assert.deepEqual(created.agentOptions, {
      provider: 'prov',
      model: 'reasoner',
      reasoningEffort: 'low',
    })
    assert.equal(created.meta.agentPreset, 'preset-a')
  }
  await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
})

test('a stale remembered route is reported and cannot be spawned silently', async () => {
  const domains = new Map()
  const presets = makePresets()
  const withRetired = {
    ...CATALOG,
    groups: [
      {
        id: 'prov',
        name: 'Provider',
        models: [...CATALOG.groups[0].models, { id: 'retired', name: 'Retired' }],
      },
    ],
  }
  {
    // Remember a route that the next deployment no longer advertises.
    const { host } = await boot({ domains, presets, catalog: withRetired })
    const origin = await originFixture(host, 'remember-stale')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'remember stale task')
    await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'retired',
      reasoningEffort: 'low',
      preset: { kind: 'inherit' },
    })
    assert.equal((await pending).kind, 'success')
    await completeBrief(host, 'origin-remember-stale')
    await waitPref(host, (row) => row.choice.model === 'retired', 'remembered retired model')
  }
  {
    const { host } = await boot({ domains, presets })
    const origin = await originFixture(host, 'stale')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'stale task')
    const pick = await until(
      async () => (await channel(host, 'pending', {})).requests[0],
      3000,
      'pending pick',
    )
    assert.match(pick.defaultChoiceIssue ?? '', /retired/)
    // The picker offers a reselect; answering the stale route anyway must not spawn.
    const chosen = await channel(host, 'choose', {
      requestId: pick.id,
      choice: {
        kind: 'model',
        provider: 'prov',
        model: 'retired',
        reasoningEffort: 'low',
        preset: { kind: 'inherit' },
      },
    })
    assert.equal(chosen.ok, true)
    const answer = await pending
    assert.equal(answer.kind, 'error', JSON.stringify(answer))
    assert.match(answer.text, /不可用/)
    assert.equal(host.state.followups.get('origin-stale').length, 0, 'no briefing turn was queued')
  }

  const withUltra = {
    ...CATALOG,
    groups: [
      {
        id: 'prov',
        name: 'Provider',
        models: [
          {
            id: 'reasoner',
            name: 'Reasoner',
            reasoning: {
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
                { id: 'ultra', name: 'Ultra' },
              ],
              defaultEffort: 'low',
            },
          },
          { id: 'simple', name: 'Simple' },
        ],
      },
    ],
  }
  {
    const { host } = await boot({ domains, presets, catalog: withUltra })
    const origin = await originFixture(host, 'remember-ultra')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'remember ultra task')
    await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'reasoner',
      reasoningEffort: 'ultra',
      preset: { kind: 'inherit' },
    })
    assert.equal((await pending).kind, 'success')
    await completeBrief(host, 'origin-remember-ultra')
    await waitPref(host, (row) => row.choice.reasoningEffort === 'ultra', 'remembered ultra effort')
  }
  {
    // The effort is no longer supported: a valid reselect still proceeds.
    const { host } = await boot({ domains, presets })
    const origin = await originFixture(host, 'stale-effort')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'stale effort task')
    const pick = await until(
      async () => (await channel(host, 'pending', {})).requests[0],
      3000,
      'pending pick',
    )
    assert.match(pick.defaultChoiceIssue ?? '', /思考强度/)
    await answerPick(host, { kind: 'inherit', preset: { kind: 'inherit' } })
    const answer = await pending
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    const { created } = await completeBrief(host, 'origin-stale-effort')
    assert.deepEqual(created.agentOptions, { provider: 'origin-provider', model: 'origin-model' })
  }
  await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
})

test('an inherited route follows the origin durable selection, not its creation options', async () => {
  const presets = makePresets()
  const { host } = await boot({ domains: new Map(), presets })
  try {
    const origin = await originFixture(host, 'durable-selection', 'preset-a', {
      provider: 'switched-provider',
      model: 'switched-model',
      reasoningEffort: 'high',
    })
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'switched model task')
    await answerPick(host, { kind: 'inherit', preset: { kind: 'inherit' } })
    assert.equal((await pending).kind, 'success')
    const { created } = await completeBrief(host, 'origin-durable-selection')
    assert.deepEqual(created.agentOptions, {
      provider: 'switched-provider',
      model: 'switched-model',
      reasoningEffort: 'high',
    })
  } finally {
    await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
  }
})

test('preset and model stay independent: default model keeps the origin preset; an explicit preset mounts', async () => {
  const domains = new Map()
  const presets = makePresets()
  const { host } = await boot({ domains, presets })
  try {
    const globalDefault = await originFixture(host, 'global-default')
    await channel(host, 'pending', {})
    const pendingDefault = handoff(host, globalDefault.agent, 'global default brain')
    await answerPick(host, { kind: 'default', preset: { kind: 'inherit' } })
    assert.equal((await pendingDefault).kind, 'success')
    const first = await completeBrief(host, 'origin-global-default')
    assert.equal(
      first.created.meta.agentPreset,
      'preset-a',
      'a global-default model must not switch the preset',
    )
    assert.equal(first.created.agentOptions.provider, 'prov')
    assert.equal(first.created.agentOptions.model, 'reasoner')

    const explicit = await originFixture(host, 'explicit-preset')
    await channel(host, 'pending', {})
    const pendingExplicit = handoff(host, explicit.agent, 'executor preset task')
    const pick = await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'simple',
      preset: { kind: 'preset', id: 'preset-b' },
    })
    assert.equal(pick.preset?.default?.kind, 'inherit')
    assert.equal((await pendingExplicit).kind, 'success')
    const second = await completeBrief(host, 'origin-explicit-preset')
    assert.equal(second.created.meta.agentPreset, 'preset-b')
    assert.deepEqual(second.created.agentOptions, { provider: 'prov', model: 'simple' })
    assert.ok(presets.mounts.includes('preset-b'), `mounts: ${JSON.stringify(presets.mounts)}`)
  } finally {
    await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
  }
})

test('a broken preset fails visibly instead of composing a preset-less session', async () => {
  const domains = new Map()
  const presets = makePresets()
  {
    const { host } = await boot({ domains, presets })
    const origin = await originFixture(host, 'broken-explicit')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'broken preset task')
    await answerPick(host, { kind: 'inherit', preset: { kind: 'preset', id: 'preset-broken' } })
    const answer = await pending
    assert.equal(answer.kind, 'error', JSON.stringify(answer))
    assert.match(answer.text, /不可用/)
    assert.equal(host.state.createdAgents.length, 0, 'no session was created')
    assert.equal(host.state.followups.get('origin-broken-explicit').length, 0)
  }
  {
    // The origin itself runs a now-broken preset: the card must report it and
    // accept a valid replacement.
    const { host } = await boot({ domains, presets })
    const origin = await originFixture(host, 'broken-inherited', 'preset-broken')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'inherit broken task')
    const pick = await until(
      async () => (await channel(host, 'pending', {})).requests[0],
      3000,
      'pending pick',
    )
    assert.match(pick.preset?.defaultIssue ?? '', /不可用/)
    assert.equal(pick.preset?.inherited, 'preset-broken')
    await answerPick(host, { kind: 'inherit', preset: { kind: 'preset', id: 'preset-b' } })
    const answer = await pending
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    const { created } = await completeBrief(host, 'origin-broken-inherited')
    assert.equal(created.meta.agentPreset, 'preset-b')
  }
  {
    // No card in a confirm:false composition: fail before writing a brief.
    const { host } = await boot({ confirm: false, domains, presets })
    const origin = await originFixture(host, 'broken-confirm-false', 'preset-broken')
    const answer = await handoff(host, origin.agent, 'no dialog task')
    assert.equal(answer.kind, 'error', JSON.stringify(answer))
    assert.match(answer.text, /不可用/)
    assert.equal(host.state.followups.get('origin-broken-confirm-false').length, 0)
  }
  await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
})

test('a failed preference write only costs the memory, never the handoff', async () => {
  const domains = new Map()
  const presets = makePresets()
  const { host } = await boot({ domains, presets, putFails: true })
  try {
    const origin = await originFixture(host, 'write-fails')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'write failure task')
    await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'simple',
      preset: { kind: 'inherit' },
    })
    const answer = await pending
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    const { created } = await completeBrief(host, 'origin-write-fails')
    assert.equal(created.meta.agentPreset, 'preset-a', 'the session itself still exists')
    const notices = await until(
      () => {
        const list = host.state.followups.get('origin-write-fails') ?? []
        return list.some((message) =>
          String(message.content?.[0]?.text ?? '').includes('本次选择未记住'),
        )
          ? list
          : undefined
      },
      3000,
      'visible write-failure notice',
    )
    assert.ok(notices.length >= 2, 'the briefing turn plus the notice')
    assert.equal(prefRows(host).length, 0, 'nothing was persisted')
  } finally {
    await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
  }
})

test('without effort metadata the remembered effort is left to the first request, not misjudged', async () => {
  const domains = new Map()
  const presets = makePresets()
  const llm = {
    async listProviders() {
      return [{ id: 'prov', name: 'Provider' }]
    },
    async listModels() {
      return [{ provider: 'prov', id: 'reasoner', name: 'Reasoner' }]
    },
  }
  const { host } = await boot({ domains, presets, withSessionController: false, llm })
  try {
    const first = await originFixture(host, 'llm-only-first')
    await channel(host, 'pending', {})
    const pendingFirst = handoff(host, first.agent, 'llm only task')
    await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'reasoner',
      reasoningEffort: 'ultra',
      preset: { kind: 'inherit' },
    })
    assert.equal((await pendingFirst).kind, 'success')
    await completeBrief(host, 'origin-llm-only-first')
    await waitPref(host, (row) => row.choice.reasoningEffort === 'ultra', 'remembered effort')

    const second = await originFixture(host, 'llm-only-second')
    await channel(host, 'pending', {})
    const pendingSecond = handoff(host, second.agent, 'llm only second')
    const pick = await until(
      async () => (await channel(host, 'pending', {})).requests[0],
      3000,
      'pending pick',
    )
    assert.equal(
      pick.defaultChoiceIssue,
      undefined,
      'no adapter metadata means the effort is unknown, not unsupported',
    )
    await answerPick(host, { kind: 'inherit', preset: { kind: 'inherit' } })
    assert.equal((await pendingSecond).kind, 'success')
    await completeBrief(host, 'origin-llm-only-second')
  } finally {
    await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
  }
})

test('the question-card fallback starts from the remembered model and asks for a preset reselect', async () => {
  const domains = new Map()
  const presets = makePresets()
  {
    const questions = makeQuestions()
    const { host } = await boot({ domains, presets, withChannel: false, userQuestions: questions })
    const first = await originFixture(host, 'card-first')
    // The model card from a first handoff: pick the displayed model name.
    questions.answers.push({ answers: [{ id: 'model', selected: ['Reasoner'] }] })
    const pending = handoff(host, first.agent, 'card task')
    assert.equal((await pending).kind, 'success')
    await completeBrief(host, 'origin-card-first')
    await waitPref(host, (row) => row.choice.model === 'reasoner', 'remembered card model')

    // The next handoff offers the remembered route first; accepting it works
    // without any browser and without guessing the inherited (expensive) one.
    const second = await originFixture(host, 'card-second')
    questions.answers.push({ answers: [{ id: 'model', selected: ['上次使用的模型'] }] })
    const pendingSecond = handoff(host, second.agent, 'card second task')
    const answer = await pendingSecond
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    const { created } = await completeBrief(host, 'origin-card-second')
    assert.deepEqual(created.agentOptions, { provider: 'prov', model: 'reasoner' })
    const lastCard = questions.seen.at(-1)
    assert.equal(lastCard.questions[0].options[0].label, '上次使用的模型')
  }
  {
    // The remembered model is gone: the card states why and does not offer it.
    const questions = makeQuestions()
    const { host } = await boot({
      domains,
      presets,
      withChannel: false,
      userQuestions: questions,
      catalog: {
        ...CATALOG,
        groups: [{ id: 'prov', name: 'Provider', models: [{ id: 'simple', name: 'Simple' }] }],
      },
    })
    const origin = await originFixture(host, 'card-stale')
    questions.answers.push({ answers: [{ id: 'model', selected: ['继承当前会话'] }] })
    const pending = handoff(host, origin.agent, 'card stale task')
    assert.equal((await pending).kind, 'success')
    const card = questions.seen[0].questions[0]
    assert.match(card.detail ?? '', /reasoner/)
    assert.ok(!card.options.some((option) => option.label === '上次使用的模型'))
    await completeBrief(host, 'origin-card-stale')
  }
  {
    // A broken inherited preset asks a dedicated card after the model card;
    // a valid replacement is mounted.
    const questions = makeQuestions()
    const { host } = await boot({ domains, presets, withChannel: false, userQuestions: questions })
    const origin = await originFixture(host, 'card-preset', 'preset-broken')
    questions.answers.push({ answers: [{ id: 'model', selected: ['上次使用的模型'] }] })
    questions.answers.push({ answers: [{ id: 'preset', selected: ['Preset B'] }] })
    const pending = handoff(host, origin.agent, 'card preset task')
    const answer = await pending
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    assert.match(questions.seen[1].questions[0].detail ?? '', /不可用/)
    const { created } = await completeBrief(host, 'origin-card-preset')
    assert.equal(created.meta.agentPreset, 'preset-b')
  }
  await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
})

test('a browser card timeout uses the retry default but never remembers it', async () => {
  const domains = new Map()
  const presets = makePresets()
  {
    const { host } = await boot({ domains, presets })
    const origin = await originFixture(host, 'timeout-seed')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'seed preference')
    await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'reasoner',
      reasoningEffort: 'low',
      preset: { kind: 'inherit' },
    })
    assert.equal((await pending).kind, 'success')
    await completeBrief(host, 'origin-timeout-seed')
    await waitPref(host, (row) => row.choice.model === 'reasoner', 'seeded preference')
  }
  {
    // The browser is attached (so a real picker is requested) but never
    // answers. The retry sidecar's choice must still run and must NOT replace
    // the remembered reasoner/low.
    const realSetTimeout = globalThis.setTimeout
    // pickTimeoutMs is schema-bounded at 5s; clamp that timer so the test can
    // exercise the real timeout branch quickly.
    globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 5000 ? 100 : ms, ...args)
    try {
      const { host } = await boot({ domains, presets, pickTimeoutMs: 5000 })
      const origin = await originFixture(host, 'timeout-retry')
      const { metaPath } = await writeSidecar(origin.cwd, {
        task: 'timeout retry',
        originSession: 'origin-timeout-retry',
        choice: { kind: 'model', provider: 'prov', model: 'simple' },
      })
      await channel(host, 'pending', {})
      const answer = await handoff(host, origin.agent, '')
      assert.equal(answer.kind, 'success', JSON.stringify(answer))
      const created = await until(
        () => host.state.createdAgents.at(-1),
        3000,
        'timeout fallback spawn',
      )
      assert.equal(created.agentOptions.model, 'simple', 'the retry default still runs')
      await until(
        async () => JSON.parse(await readFile(metaPath, 'utf8')).spawnedAt !== undefined,
        3000,
        'spawned meta',
      )
      assert.equal(
        pref(host).choice.model,
        'reasoner',
        'an unanswered card must not overwrite the preference',
      )
      assert.equal(pref(host).choice.reasoningEffort, 'low')
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  }
  await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
})

test('an unanswered question card uses its default but never remembers it', async () => {
  const domains = new Map()
  const presets = makePresets()
  {
    const { host } = await boot({ domains, presets })
    const origin = await originFixture(host, 'card-timeout-seed')
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, 'seed card preference')
    await answerPick(host, {
      kind: 'model',
      provider: 'prov',
      model: 'reasoner',
      reasoningEffort: 'low',
      preset: { kind: 'inherit' },
    })
    assert.equal((await pending).kind, 'success')
    await completeBrief(host, 'origin-card-timeout-seed')
    await waitPref(host, (row) => row.choice.model === 'reasoner', 'seeded card preference')
  }
  {
    const realSetTimeout = globalThis.setTimeout
    // The card timeout is a fixed 60s; clamp it so the test can exercise the
    // actual timeout branch instead of the separate no-answerer branch.
    globalThis.setTimeout = (fn, ms, ...args) =>
      realSetTimeout(fn, ms >= 60_000 ? 100 : ms, ...args)
    try {
      const never = { ask: () => new Promise(() => {}) }
      const { host } = await boot({ domains, presets, withChannel: false, userQuestions: never })
      const origin = await originFixture(host, 'card-timeout')
      const { metaPath } = await writeSidecar(origin.cwd, {
        task: 'card timeout',
        originSession: 'origin-card-timeout',
        choice: { kind: 'model', provider: 'prov', model: 'simple' },
      })
      const answer = await handoff(host, origin.agent, '')
      assert.equal(answer.kind, 'success', JSON.stringify(answer))
      const created = await until(() => host.state.createdAgents.at(-1), 3000, 'card timeout spawn')
      assert.equal(created.agentOptions.model, 'simple', 'the retry default still runs')
      await until(
        async () => JSON.parse(await readFile(metaPath, 'utf8')).spawnedAt !== undefined,
        3000,
        'spawned meta',
      )
      assert.equal(
        pref(host).choice.model,
        'reasoner',
        'an unanswered card must not overwrite the preference',
      )
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  }
  await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
})

test('an explicit sidecar preset fails visibly when the registry is missing or unreadable', async () => {
  const choice = { kind: 'inherit' }
  const preset = { kind: 'preset', id: 'preset-b' }
  for (const label of ['missing', 'unreadable']) {
    const presets =
      label === 'missing'
        ? undefined
        : {
            ...makePresets(),
            async list() {
              throw new Error('roster unavailable (test)')
            },
          }
    const { host } = await boot({ domains: new Map(), presets, withChannel: false })
    const origin = await originFixture(host, `no-registry-${label}`)
    const { metaPath } = await writeSidecar(origin.cwd, {
      task: `no registry ${label}`,
      originSession: `origin-no-registry-${label}`,
      choice,
      preset,
    })
    const answer = await handoff(host, origin.agent, '')
    assert.equal(answer.kind, 'error', JSON.stringify(answer))
    assert.match(answer.text, /preset-b/)
    assert.match(answer.text, /预设注册表/)
    assert.equal(host.state.createdAgents.length, 0, 'no preset-less session was created')
    assert.equal(
      host.state.followups.get(`origin-no-registry-${label}`).length,
      0,
      'no briefing turn was queued',
    )
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    assert.equal(meta.spawnedAt, undefined, 'the record stays retryable')
    assert.deepEqual(meta.preset, preset, 'the explicit preset intent is preserved')
  }
  await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
})

test('an omitted preset field keeps the retry sidecar intent', async () => {
  const domains = new Map()
  const presets = makePresets()
  const { host } = await boot({ domains, presets })
  try {
    const origin = await originFixture(host, 'wire-preset')
    const { metaPath } = await writeSidecar(origin.cwd, {
      task: 'wire preset',
      originSession: 'origin-wire-preset',
      choice: { kind: 'inherit' },
      preset: { kind: 'preset', id: 'preset-b' },
    })
    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, '')
    const pick = await until(
      async () => (await channel(host, 'pending', {})).requests[0],
      3000,
      'pending pick',
    )
    assert.deepEqual(pick.preset?.default, { kind: 'preset', id: 'preset-b' })
    // An older client sends no preset field: the host must keep the sidecar
    // intent instead of substituting inherit.
    const chosen = await channel(host, 'choose', {
      requestId: pick.id,
      choice: { kind: 'inherit' },
    })
    assert.equal(chosen.ok, true)
    const answer = await pending
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    const created = await until(() => host.state.createdAgents.at(-1), 3000, 'spawn')
    assert.equal(created.meta.agentPreset, 'preset-b')
    const meta = JSON.parse(await readFile(metaPath, 'utf8'))
    assert.deepEqual(
      meta.preset,
      { kind: 'preset', id: 'preset-b' },
      'the record keeps the explicit intent',
    )
  } finally {
    await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
  }
})

test('a sidecar written before presets existed still retries and inherits the origin preset', async () => {
  const domains = new Map()
  const presets = makePresets()
  const { host } = await boot({ domains, presets })
  try {
    const origin = await originFixture(host, 'legacy', 'preset-a')
    const dir = `${origin.cwd}/.dsh/handoff`
    await mkdir(dir, { recursive: true })
    const briefPath = `${dir}/20260101-000000-handoff.md`
    await writeFile(briefPath, `# Goal\nlegacy\n${COMPLETE}\n`, 'utf8')
    await writeFile(
      `${dir}/20260101-000000-handoff.meta.json`,
      `${JSON.stringify(
        {
          version: 1,
          task: 'legacy task',
          originSession: 'origin-legacy',
          target: { path: origin.cwd, title: 'legacy' },
          choice: { kind: 'inherit' },
          createdAt: Date.now(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    await channel(host, 'pending', {})
    const pending = handoff(host, origin.agent, '')
    const pick = await until(
      async () => (await channel(host, 'pending', {})).requests[0],
      3000,
      'pending pick',
    )
    assert.equal(pick.preset?.default?.kind, 'inherit', 'an old sidecar has no preset intent')
    await answerPick(host, { kind: 'inherit', preset: { kind: 'inherit' } })
    const answer = await pending
    assert.equal(answer.kind, 'success', JSON.stringify(answer))
    const created = await until(() => host.state.createdAgents.at(-1), 3000, 'resumed spawn')
    assert.equal(created.meta.agentPreset, 'preset-a')
    const meta = await until(
      async () => {
        try {
          return await metaFor(briefPath)
        } catch {
          return undefined
        }
      },
      3000,
      'rewritten meta',
    )
    assert.deepEqual(meta.preset, { kind: 'inherit' })
    assert.equal(typeof meta.spawnedAt, 'number')
  } finally {
    await rm(new URL('./.smoke-prefs', import.meta.url), { recursive: true, force: true })
  }
})
