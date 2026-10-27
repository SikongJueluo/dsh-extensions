/* Client-half tests for the handoff configuration card: the real
 * client/client.js loaded in a VM with a minimal React hooks runtime. Covers
 * the contract the research established: one card (no wizard), model/preset
 * independence, host-resolved defaults, a stale default that demands a
 * reselect, and nothing sent before the fixed 开始交接 button.
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
    // React's style prop must be an object (react.dev/errors/62); enforce it
    // here so a text/style mixup fails the tests instead of only real browsers.
    const style = (props ?? {}).style
    if (style !== undefined && (typeof style !== 'object' || style === null || Array.isArray(style))) {
      throw new Error(`style contract violated for <${typeof type === 'string' ? type : 'component'}>: style must be an object, got ${typeof style} "${String(style)}"`)
    }
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
const REVIEW_LABEL = '自动审核'
const PRESET_A = {
  id: 'preset-a',
  name: 'Preset A',
  description: 'default preset',
}
const PRESETS = [
  PRESET_A,
  { id: 'preset-b', name: 'Preset B', description: 'second preset' },
  { id: 'preset-broken', name: 'Broken Preset', description: 'cannot compose', broken: 'missing service' },
]

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

// ══ tests ══════════════════════════════════════════════════════════════════

const changeButtonFor = (tree, label) => {
  let best
  for (const holder of [...walk(tree)]) {
    if (holder.type !== 'div') continue
    if (!holder.children.some(child => textOf(child) === label)) continue
    const buttons = byType(holder, 'button').filter(b => textOf(b) === '更改')
    if (buttons.length !== 1) continue
    const size = [...walk(holder)].length
    if (best === undefined || size < best.size) best = { button: buttons[0], size }
  }
  return best === undefined ? undefined : best.button
}
const checkbox = (tree) => byType(tree, 'input').find(input => input.props.type === 'checkbox')
const submit = (tree) => byText(tree, 'button', '开始交接')

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

test('the card opens with the resolved defaults and submits only on 开始交接', async () => {
  const choices = []
  const request = {
    id: 'req-defaults', sessionId: 'session-1', task: '修 README',
    inherited: { provider: 'prov', model: 'reasoner', reasoningEffort: 'low' },
    fallback: { provider: 'prov', model: 'simple' },
    defaultChoice: { kind: 'inherit' },
    preset: { inherited: 'preset-a', options: PRESETS, default: { kind: 'inherit' } },
    origin: { id: 'origin', title: 'Origin', path: '/home/u/project', missing: false },
    pickWorkspace: false, workspaces: [],
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  const text = textOf(inst.tree)
  assert.ok(text.includes('交接任务'), 'card title')
  assert.ok(text.includes('prov/reasoner'), 'the inherited route is the default value')
  assert.ok(text.includes('继承当前 · Preset A'), 'the preset row names the inherited preset')
  assert.ok(text.includes(REVIEW_LABEL), 'the review row is visible on the card')
  assert.ok(!text.includes('轮预算'), 'no round-budget controls')
  assert.ok(!text.includes('执行者 = 新会话'), 'no role explanation paragraph')
  assert.ok(changeButtonFor(inst.tree, '模型'), 'model has a 更改 button')
  assert.ok(changeButtonFor(inst.tree, 'Preset'), 'preset has a 更改 button')
  assert.equal(changeButtonFor(inst.tree, '工作区'), undefined, 'no workspace row without a roster')
  assert.equal(choices.length, 0, 'nothing submitted by merely opening the card')

  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit',
    preset: { kind: 'inherit' },
    review: { enabled: false, rounds: 5 },
  }))
})

test('更改 flows: pick a model, adjust its effort, and enable review without a budget picker', async () => {
  const choices = []
  const request = {
    id: 'req-change', sessionId: 'session-1', task: '换脑任务',
    inherited: { provider: 'prov', model: 'reasoner', reasoningEffort: 'low' },
    fallback: { provider: 'prov', model: 'simple' },
    defaultChoice: { kind: 'inherit' },
    pickWorkspace: false, workspaces: [],
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)
  assert.ok(!textOf(inst.tree).includes('Preset'), 'no preset row without a preset block')

  // 更改模型 → the selector replaces the card body; picking returns to the card.
  changeButtonFor(inst.tree, '模型').props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('新会话使用哪个模型？'), 'model selector expanded')
  byLabel(inst.tree, 'Reasoner').props.onPick()
  inst.render(props)
  runEffects(inst)
  const cardText = textOf(inst.tree)
  assert.ok(cardText.includes('Reasoner'), 'the card shows the picked model')
  assert.ok(cardText.includes('模型默认强度'), 'effort rides the model default until changed')

  // 更改强度 → effort selector → back on the card with the effort named.
  changeButtonFor(inst.tree, '思考强度').props.onClick()
  inst.render(props)
  runEffects(inst)
  byLabel(inst.tree, 'High').props.onPick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('强度 High'), 'the card shows the chosen effort')

  // Review on the card: one toggle row, the budget shown but not editable.
  checkbox(inst.tree).props.onChange({ target: { checked: true } })
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('最多 5 轮'), 'the fixed default budget is shown')
  assert.equal(byText(inst.tree, 'button', '8'), undefined, 'no per-round buttons')

  assert.equal(choices.length, 0, 'selectors never submit')
  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'model', provider: 'prov', model: 'reasoner', reasoningEffort: 'high',
    review: { enabled: true, rounds: 5 },
  }))
})

test('workspace 更改 selects and returns to the card; the submit carries the pick', async () => {
  const choices = []
  const request = {
    id: 'req-ws', sessionId: 'session-1', task: '跨区任务',
    defaultChoice: { kind: 'inherit' },
    origin: { id: 'origin', title: 'Origin', path: '/home/u/project', missing: false },
    workspaces: [{ id: 'ws-1', title: 'Other', path: '/home/u/other', missing: false }],
    pickWorkspace: true,
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  changeButtonFor(inst.tree, '工作区').props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('新会话开在哪个工作区？'), 'workspace selector expanded')
  byLabel(inst.tree, 'Other').props.onPick()
  await Promise.resolve()
  assert.equal(choices.length, 0, 'a selector pick must not submit')

  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('Other（/home/u/other）'), 'the card names the picked workspace')

  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit', workspace: 'ws-1',
    review: { enabled: false, rounds: 5 },
  }))
})

test('flag-fixed fields display 命令指定, offer no 更改, and the actual review budget shows', async () => {
  const choices = []
  const request = {
    id: 'req-fixed', sessionId: 'session-1', task: '脚本任务',
    inherited: { provider: 'prov', model: 'reasoner' },
    fallback: { provider: 'prov', model: 'simple' },
    defaultChoice: { kind: 'inherit' },
    preset: { inherited: 'preset-a', options: PRESETS, default: { kind: 'inherit' } },
    pickWorkspace: false, workspaces: [],
    modelFixed: true, fixedModel: { provider: 'flagged/provider', model: 'flagged-model' },
    fixedWorkspace: { id: 'ws-flag', title: 'Flagged Space', path: '/home/u/flagged', missing: false },
    review: { defaultRounds: 8, enabled: true, fixed: true },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  const text = textOf(inst.tree)
  assert.ok(text.includes('flagged/provider/flagged-model'), 'the fixed route is shown')
  assert.ok(text.includes('Flagged Space（/home/u/flagged）'), 'the fixed workspace is shown')
  assert.ok(text.includes('最多 8 轮'), 'the flag-decided budget is the one shown')
  const badges = (text.match(/命令指定/g) || []).length
  assert.ok(badges >= 3, `model, workspace, and review each carry 命令指定, got ${badges}`)
  assert.equal(changeButtonFor(inst.tree, '模型'), undefined, 'a fixed model offers no 更改')
  assert.equal(changeButtonFor(inst.tree, '工作区'), undefined, 'a fixed workspace offers no 更改')
  assert.ok(changeButtonFor(inst.tree, 'Preset'), 'the preset stays selectable beside fixed fields')
  assert.equal(checkbox(inst.tree), undefined, 'a fixed review shows no toggle')
  assert.equal(submit(inst.tree).props.disabled, false)

  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit',
    preset: { kind: 'inherit' },
    review: { enabled: true, rounds: 8 },
  }))
})

test('a retry pre-fills the host-resolved model and workspace and submits what the card shows', async () => {
  const choices = []
  const request = {
    id: 'req-retry', sessionId: 'session-1', task: '重试任务',
    inherited: { provider: 'prov', model: 'simple' },
    fallback: { provider: 'prov', model: 'simple' },
    defaultChoice: { kind: 'model', provider: 'prov', model: 'reasoner', reasoningEffort: 'low' },
    origin: { id: 'origin', title: 'Origin', path: '/home/u/project', missing: false },
    workspaces: [{ id: 'ws-1', title: 'Other', path: '/home/u/other', missing: false }],
    pickWorkspace: true,
    previous: { workspaceId: 'ws-1' },
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  const text = textOf(inst.tree)
  assert.ok(text.includes('Reasoner'), 'the card pre-fills the resolved model')
  assert.ok(text.includes('强度 Low'), 'the resolved effort is shown')
  assert.ok(text.includes('Other（/home/u/other）'), 'the card pre-fills the previous workspace')
  assert.ok(!text.includes('原工作区（/home/u/project）'), 'the summary must not claim the origin')

  // Submit WITHOUT touching anything: the payload must match the summary.
  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'model', provider: 'prov', model: 'reasoner', reasoningEffort: 'low',
    workspace: 'ws-1',
    review: { enabled: false, rounds: 5 },
  }))
})

test('a stale remembered model blocks submit until the operator reselects', async () => {
  const choices = []
  const request = {
    id: 'req-stale', sessionId: 'session-1', task: '旧模型',
    inherited: { provider: 'prov', model: 'reasoner' },
    fallback: { provider: 'prov', model: 'simple' },
    defaultChoice: { kind: 'model', provider: 'prov', model: 'gone' },
    defaultChoiceIssue: '上次使用的模型已不可用：prov/gone',
    pickWorkspace: false, workspaces: [],
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  const text = textOf(inst.tree)
  assert.ok(text.includes('上次使用的模型已不可用'), 'the stale default is explained on the card')
  assert.equal(submit(inst.tree).props.disabled, true, 'submit is blocked while the default is stale')

  changeButtonFor(inst.tree, '模型').props.onClick()
  inst.render(props)
  runEffects(inst)
  byLabel(inst.tree, 'Simple').props.onPick()
  inst.render(props)
  runEffects(inst)
  assert.ok(!textOf(inst.tree).includes('上次使用的模型已不可用'), 'the issue clears after a reselect')
  assert.equal(submit(inst.tree).props.disabled, false)

  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'model', provider: 'prov', model: 'simple',
    review: { enabled: false, rounds: 5 },
  }))
})

test('the preset selector picks an explicit preset, keeps broken rows unselectable', async () => {
  const choices = []
  const request = {
    id: 'req-preset', sessionId: 'session-1', task: '执行预设',
    defaultChoice: { kind: 'inherit' },
    preset: { inherited: 'preset-a', options: PRESETS, default: { kind: 'inherit' } },
    pickWorkspace: false, workspaces: [],
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  changeButtonFor(inst.tree, 'Preset').props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('新会话使用哪个预设？'), 'preset selector expanded')
  const broken = byLabel(inst.tree, 'Broken Preset')
  assert.equal(broken.props.muted, true, 'a broken preset is disabled')
  assert.ok(String(broken.props.description).includes('missing service'), 'the broken reason stays visible')
  byLabel(inst.tree, 'Preset B').props.onPick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('继承当前 · Preset A') === false, 'the explicit pick replaces inherit')
  assert.ok(textOf(inst.tree).includes('Preset B'), 'the card names the picked preset')

  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit',
    preset: { kind: 'preset', id: 'preset-b' },
    review: { enabled: false, rounds: 5 },
  }))
})

test('no review offer: the row is absent and the payload carries no review key', async () => {
  const choices = []
  const request = {
    id: 'req-plain', sessionId: 'session-1', task: '普通交接',
    inherited: { provider: 'prov', model: 'reasoner' },
    fallback: { provider: 'prov', model: 'simple' },
    defaultChoice: { kind: 'inherit' },
    pickWorkspace: false, workspaces: [],
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  assert.ok(!textOf(inst.tree).includes(REVIEW_LABEL), 'no review row without an offer')
  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({ kind: 'inherit' }))
})
