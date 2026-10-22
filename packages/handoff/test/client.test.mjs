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

test('the card opens with defaults filled and submits only on 开始交接', async () => {
  const choices = []
  const request = {
    id: 'req-defaults', sessionId: 'session-1', task: '修 README',
    inherited: { provider: 'prov', model: 'reasoner', reasoningEffort: 'low' },
    fallback: { provider: 'prov', model: 'simple' },
    origin: { id: 'origin', title: 'Origin', path: '/home/u/project', missing: false },
    pickWorkspace: false, workspaces: [],
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  const text = textOf(inst.tree)
  assert.ok(text.includes('交接任务'), 'card title')
  assert.ok(text.includes('继承当前会话'), 'model defaults to inherit')
  assert.ok(text.includes('原工作区'), 'workspace defaults to origin')
  assert.ok(text.includes(REVIEW_LABEL), 'the review block is visible on the card')
  assert.ok(changeButtonFor(inst.tree, '模型'), 'model has a 更改 button')
  assert.equal(changeButtonFor(inst.tree, '工作区'), undefined, 'no workspace selector without a roster')
  assert.equal(choices.length, 0, 'nothing submitted by merely opening the card')

  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit',
    review: { enabled: false, rounds: 5 },
  }))
})

test('更改 flows: pick a model, adjust its effort, enable review with a 44px budget button', async () => {
  const choices = []
  const request = {
    id: 'req-change', sessionId: 'session-1', task: '换脑任务',
    inherited: { provider: 'prov', model: 'reasoner', reasoningEffort: 'low' },
    fallback: { provider: 'prov', model: 'simple' },
    pickWorkspace: false, workspaces: [],
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

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

  // Review on the card, with touch-sized budget buttons.
  checkbox(inst.tree).props.onChange({ target: { checked: true } })
  inst.render(props)
  runEffects(inst)
  const rounds8 = byText(inst.tree, 'button', '8')
  assert.ok(rounds8, 'round budget buttons')
  assert.ok(Number(rounds8.props.style.minHeight) >= 44, `budget buttons must be ≥44px, got ${rounds8.props.style.minHeight}`)
  rounds8.props.onClick()
  inst.render(props)
  runEffects(inst)
  assert.ok(textOf(inst.tree).includes('执行者 = 新会话，审核者 = 当前会话'), 'the card names both roles')

  assert.equal(choices.length, 0, 'selectors never submit')
  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'model', provider: 'prov', model: 'reasoner', reasoningEffort: 'high',
    review: { enabled: true, rounds: 8 },
  }))
})

test('workspace 更改 selects and returns to the card; the submit carries the pick', async () => {
  const choices = []
  const request = {
    id: 'req-ws', sessionId: 'session-1', task: '跨区任务',
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

test('flag-fixed fields display 命令指定, offer no 更改, and the review verdict shows fixed', async () => {
  const choices = []
  const request = {
    id: 'req-fixed', sessionId: 'session-1', task: '脚本任务',
    inherited: { provider: 'prov', model: 'reasoner' },
    fallback: { provider: 'prov', model: 'simple' },
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
  assert.ok(text.includes('自动审核 · 开启，最多 8 轮'), 'the flag-decided review verdict is shown')
  const badges = (text.match(/命令指定/g) || []).length
  assert.ok(badges >= 3, `model, workspace, and review each carry 命令指定, got ${badges}`)
  assert.equal(changeButtonFor(inst.tree, '模型'), undefined, 'a fixed model offers no 更改')
  assert.equal(changeButtonFor(inst.tree, '工作区'), undefined, 'a fixed workspace offers no 更改')
  assert.equal(checkbox(inst.tree), undefined, 'a fixed review shows no toggle')
  assert.equal(submit(inst.tree).props.disabled, false)

  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit',
    review: { enabled: true, rounds: 8 },
  }))
})

test('a retry pre-fills the previous workspace and submits exactly what the card shows', async () => {
  const choices = []
  const request = {
    id: 'req-retry', sessionId: 'session-1', task: '重试任务',
    inherited: { provider: 'prov', model: 'reasoner' },
    fallback: { provider: 'prov', model: 'simple' },
    origin: { id: 'origin', title: 'Origin', path: '/home/u/project', missing: false },
    workspaces: [{ id: 'ws-1', title: 'Other', path: '/home/u/other', missing: false }],
    pickWorkspace: true,
    previous: { choice: { kind: 'inherit' }, workspaceId: 'ws-1' },
    review: { defaultRounds: 5 },
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  const text = textOf(inst.tree)
  assert.ok(text.includes('Other（/home/u/other）'), 'the card pre-fills the previous workspace')
  assert.ok(!text.includes('原工作区（/home/u/project）'), 'the summary must not claim the origin')

  // Submit WITHOUT touching anything: the payload must match the summary.
  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({
    kind: 'inherit', workspace: 'ws-1',
    review: { enabled: false, rounds: 5 },
  }))
})

test('no review offer: the block is absent and the payload carries no review key', async () => {
  const choices = []
  const request = {
    id: 'req-plain', sessionId: 'session-1', task: '普通交接',
    inherited: { provider: 'prov', model: 'reasoner' },
    fallback: { provider: 'prov', model: 'simple' },
    pickWorkspace: false, workspaces: [],
  }
  const props = { request, operations: operations(choices), onSettled: () => {} }
  const inst = mount(H.Picker, props)
  await settle(inst, props)

  assert.ok(!textOf(inst.tree).includes(REVIEW_LABEL), 'no review block without an offer')
  submit(inst.tree).props.onClick()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(JSON.stringify(choices[0].choice), JSON.stringify({ kind: 'inherit' }))
})
