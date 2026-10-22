/* Client-half tests for the spawn wizard: the real client/client.js loaded
 * in a VM with a minimal React hooks runtime. Covers the wizard contract the
 * research found broken: the review toggle must be reachable on every path,
 * workspace rows must select (not submit), and nothing is sent before the
 * fixed 开始交接 button.
 *
 * Run: node --test test/   (after pnpm build — the client is plain JS, no
 * build step; only the host half needs one)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// ── minimal React + hooks runtime ──────────────────────────────────────────
let currentInstance = null

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const flat = []
    const push = (child) => {
      if (Array.isArray(child)) child.forEach(push)
      else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
    }
    children.forEach(push)
    return { type, props: props ?? {}, children: flat }
  },
  useState(initial) {
    const inst = currentInstance
    if (!inst) throw new Error('useState called outside a harness render')
    const index = inst.hookIndex++
    if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? initial() : initial
    return [inst.hooks[index], (value) => {
      inst.hooks[index] = typeof value === 'function' ? value(inst.hooks[index]) : value
    }]
  },
  useEffect(fn, deps) {
    const inst = currentInstance
    if (!inst) throw new Error('useEffect called outside a harness render')
    const index = inst.hookIndex++
    inst.pendingEffects.push({ index, fn, deps })
  },
  useRef(initial) {
    const inst = currentInstance
    if (!inst) throw new Error('useRef called outside a harness render')
    const index = inst.hookIndex++
    if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
    return inst.hooks[index]
  },
  useCallback(fn) { return fn },
}

function mount(Component, props) {
  const inst = {
    Component,
    props,
    hooks: {},
    hookIndex: 0,
    pendingEffects: [],
    effectDeps: [],
    cleanups: {},
    tree: null,
    render(nextProps) {
      if (nextProps !== undefined) inst.props = nextProps
      inst.hookIndex = 0
      inst.pendingEffects = []
      currentInstance = inst
      try {
        inst.tree = inst.Component(inst.props)
      } finally {
        currentInstance = null
      }
      return inst.tree
    },
  }
  inst.render()
  runEffects(inst)
  return inst
}

function runEffects(inst) {
  const pending = inst.pendingEffects
  inst.pendingEffects = []
  for (const { index, fn, deps } of pending) {
    const previous = inst.effectDeps[index]
    if (
      deps !== undefined && previous !== undefined &&
      deps.length === previous.length && deps.every((value, i) => Object.is(value, previous[i]))
    ) continue
    inst.effectDeps[index] = deps
    const cleanup = fn()
    if (typeof cleanup === 'function') inst.cleanups[index] = cleanup
  }
}

async function settle(inst, props) {
  inst.render(props)
  runEffects(inst)
  await Promise.resolve()
  await Promise.resolve()
  inst.render(props)
  runEffects(inst)
  await Promise.resolve()
  inst.render(props)
  runEffects(inst)
}

// ── load the real client module ────────────────────────────────────────────
function loadClient() {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = 'exports.apply = apply;'
  if (source.split(marker).length !== 2) throw new Error('unexpected client shape: apply marker not unique')
  const inject = 'exports.__test = { Picker };'
  const instrumented = source.replace(marker, `${inject}\n    ${marker}`)
  let definition = null
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def) { definition = def } },
      confirm: () => false,
      matchMedia: () => ({ matches: false }),
      addEventListener() {}, removeEventListener() {},
    },
    console,
    fetch: () => Promise.reject(new Error('fetch is not used by this harness')),
    document: { addEventListener() {}, removeEventListener() {} },
    setInterval: () => 0,
    clearInterval: () => {},
  }
  sandbox.globalThis = sandbox
  runInNewContext(instrumented, sandbox, { filename: 'client.js' })
  if (definition === null || definition.id !== 'dsh-handoff') throw new Error('client factory not registered')
  const clientExports = definition.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })
  if (!clientExports.__test) throw new Error('test exports missing')
  return clientExports.__test
}

const H = loadClient()
const REVIEW_LABEL = '执行完成后自动交回当前会话审核'

// ── element helpers ────────────────────────────────────────────────────────
function* walk(node) {
  if (Array.isArray(node)) { for (const item of node) yield* walk(item); return }
  if (node === null || typeof node !== 'object') return
  yield node
  for (const child of node.children ?? []) yield* walk(child)
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node !== null && typeof node === 'object' && Array.isArray(node.children)) return node.children.map(textOf).join('')
  return ''
}

const byType = (tree, type) => [...walk(tree)].filter(node => node.type === type)
const byText = (tree, type, text) => [...walk(tree)].find(node => node.type === type && textOf(node).includes(text))
const byLabel = (tree, label) => [...walk(tree)].find(node => node.props && node.props.label === label)
const checkbox = (tree) => byType(tree, 'input').find(input => input.props.type === 'checkbox')

function operations(choices) {
  return {
    modelCatalog: () => Promise.resolve({
      ok: true,
      value: {
        groups: [{
          id: 'prov',
          name: 'Provider',
          models: [
            {
              id: 'reasoner',
              name: 'Reasoner',
              description: 'reasoning model',
              reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
            },
            { id: 'simple', name: 'Simple' },
          ],
        }],
        failures: [],
      },
    }),
    choose: (requestId, choice) => { choices.push({ requestId, choice }); return Promise.resolve({ ok: true }) },
    cancel: () => Promise.resolve({ ok: true }),
    pending: () => Promise.resolve({ requests: [] }),
  }
}

// ══ tests ══════════════════════════════════════════════════════════════════

test('model → effort → dedicated review step → confirm carries the verdict', async () => {
  const choices = []
  const request = {
    id: 'req-effort', sessionId: 'session-1', task: '修 README',
    inherited: { provider: 'prov', model: 'reasoner', reasoningEffort: 'low' },
    fallback: { provider: 'prov', model: 'simple' },
    pickWorkspace: false, workspaces: [],
    review: { defaultRounds: 5 },
  }
  const ops = operations(choices)
  const props = { request, operations: ops, onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  assert.ok(textOf(inst.tree).includes('新会话使用哪个模型？'), 'model step first')
  byLabel(inst.tree, 'Reasoner').props.onPick()
  await settle(inst, props)
  assert.ok(textOf(inst.tree).includes('思考强度'), 'effort step after a reasoning model')
  byLabel(inst.tree, 'High').props.onPick()
  await settle(inst, props)
  assert.ok(textOf(inst.tree).includes('自动审核'), 'review step is reachable after effort')
  assert.ok(textOf(inst.tree).includes(REVIEW_LABEL), 'review toggle label')

  checkbox(inst.tree).props.onChange({ target: { checked: true } })
  inst.render(props)
  runEffects(inst)
  const rounds8 = byText(inst.tree, 'button', '8')
  assert.ok(rounds8, 'round budget buttons')
  rounds8.props.onClick()
  inst.render(props)
  runEffects(inst)
  byText(inst.tree, 'button', '继续').props.onClick()
  inst.render(props)
  runEffects(inst)

  assert.ok(textOf(inst.tree).includes('开始交接'), 'confirm step')
  assert.ok(textOf(inst.tree).includes('最多 8 轮'), 'confirm shows the round budget')
  assert.ok(textOf(inst.tree).includes('执行者 = 新会话，审核者 = 当前会话'), 'confirm names both roles')
  assert.equal(choices.length, 0, 'nothing submitted before the fixed button')
  byText(inst.tree, 'button', '开始交接').props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'model', provider: 'prov', model: 'reasoner', reasoningEffort: 'high',
    review: { enabled: true, rounds: 8 },
  }))
})

test('workspace rows select; only 开始交接 submits', async () => {
  const choices = []
  const request = {
    id: 'req-ws', sessionId: 'session-1', task: '跨区任务',
    origin: { id: 'origin', title: 'Origin', path: '/home/u/project', missing: false },
    workspaces: [{ id: 'ws-1', title: 'Other', path: '/home/u/other', missing: false }],
    pickWorkspace: true, modelFixed: true,
    review: { defaultRounds: 5 },
  }
  const ops = operations(choices)
  const props = { request, operations: ops, onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  assert.ok(textOf(inst.tree).includes('新会话开在哪个工作区？'), 'workspace step first for --model')
  const next = byText(inst.tree, 'button', '继续')
  assert.equal(next.props.disabled, true, '继续 disabled before a selection')
  byLabel(inst.tree, 'Other').props.onPick()
  await Promise.resolve()
  assert.equal(choices.length, 0, 'a row click must not submit')

  inst.render(props)
  runEffects(inst)
  assert.ok(byLabel(inst.tree, 'Other').props.badge === '已选', 'selected row is marked')
  const next2 = byText(inst.tree, 'button', '继续')
  assert.equal(next2.props.disabled, false, '继续 enabled after selection')
  next2.props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('自动审核'), 'review step after workspace')
  byText(inst.tree, 'button', '继续').props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('Other（/home/u/other）'), 'confirm names the picked workspace')

  byText(inst.tree, 'button', '开始交接').props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit', workspace: 'ws-1',
    review: { enabled: false, rounds: 5 },
  }))
})

test('--model without a workspace step starts at the review step and names the fixed model', async () => {
  const choices = []
  const request = {
    id: 'req-fixed', sessionId: 'session-1', task: '脚本任务',
    inherited: { provider: 'prov', model: 'reasoner' },
    fallback: { provider: 'prov', model: 'simple' },
    pickWorkspace: false, workspaces: [],
    modelFixed: true, fixedModel: { provider: 'flagged/provider', model: 'flagged-model' },
    review: { defaultRounds: 5 },
  }
  const ops = operations(choices)
  const props = { request, operations: ops, onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  assert.ok(!textOf(inst.tree).includes('新会话使用哪个模型？'), 'model list must be skipped')
  assert.ok(textOf(inst.tree).includes('自动审核'), 'review step is the first step')

  checkbox(inst.tree).props.onChange({ target: { checked: true } })
  inst.render(props)
  runEffects(inst)
  byText(inst.tree, 'button', '继续').props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('flagged/provider/flagged-model'), 'confirm names the fixed route')
  byText(inst.tree, 'button', '开始交接').props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit',
    review: { enabled: true, rounds: 5 },
  }))
})

test('no review offer: model pick goes straight to confirm, payload carries no review key', async () => {
  const choices = []
  const request = {
    id: 'req-plain', sessionId: 'session-1', task: '普通交接',
    inherited: { provider: 'prov', model: 'reasoner' },
    fallback: { provider: 'prov', model: 'simple' },
    pickWorkspace: false, workspaces: [],
  }
  const ops = operations(choices)
  const props = { request, operations: ops, onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  byLabel(inst.tree, 'Simple').props.onPick()
  await settle(inst, props)
  assert.ok(textOf(inst.tree).includes('开始交接'), 'confirm directly after a plain model')
  assert.ok(!textOf(inst.tree).includes(REVIEW_LABEL), 'no review UI without an offer')
  byText(inst.tree, 'button', '开始交接').props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({ kind: 'model', provider: 'prov', model: 'simple' }))
})

test('back retraces the wizard steps instead of losing everything', async () => {
  const choices = []
  const request = {
    id: 'req-back', sessionId: 'session-1', task: '返回测试',
    origin: { id: 'origin', title: 'Origin', path: '/home/u/project', missing: false },
    workspaces: [{ id: 'ws-1', title: 'Other', path: '/home/u/other', missing: false }],
    pickWorkspace: true,
    review: { defaultRounds: 5 },
  }
  const ops = operations(choices)
  const props = { request, operations: ops, onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  byLabel(inst.tree, 'Simple').props.onPick()
  await settle(inst, props)
  assert.ok(textOf(inst.tree).includes('新会话开在哪个工作区？'), 'workspace step')
  byLabel(inst.tree, 'Other').props.onPick()
  inst.render(props)
  runEffects(inst)
  byText(inst.tree, 'button', '继续').props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('自动审核'), 'review step')
  byText(inst.tree, 'button', '返回').props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('新会话开在哪个工作区？'), 'back returns to workspace')
  assert.equal(byLabel(inst.tree, 'Other').props.badge, '已选', 'selection survives the round trip')
})
