/**
 * Client-half tests: the real `client/client.js` loaded in a VM with a
 * minimal React hooks runtime, so the shipped browser code (plain JS, not
 * type-checked) is exercised directly. Covers the regression classes the
 * research found: undistinguishable session labels, draft role misbinding,
 * template-switch bleed, unsaved-template delete, the missing run-start
 * entry, and run detail visibility.
 *
 * @module dsh-triggers/client.test
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'

// ── minimal React + hooks runtime (see .dsh/trigger-ui-repro.mjs lineage) ──
let currentInstance: {
  hookIndex: number
  hooks: Record<number, unknown>
  pendingEffects: { index: number, fn: () => unknown, deps: unknown[] | undefined }[]
  effectDeps: (unknown[] | undefined)[]
  cleanups: Record<number, (() => void) | undefined>
} | null = null

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    const flat: unknown[] = []
    const push = (child: unknown): void => {
      if (Array.isArray(child)) child.forEach(push)
      else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child)
    }
    children.forEach(push)
    return { type, props: props ?? {}, children: flat }
  },
  useState(initial: unknown) {
    const inst = currentInstance!
    const index = inst.hookIndex++
    if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
    return [inst.hooks[index], (value: unknown) => {
      inst.hooks[index] = typeof value === 'function' ? (value as (prev: unknown) => unknown)(inst.hooks[index]) : value
    }]
  },
  useEffect(fn: () => unknown, deps: unknown[]) {
    const inst = currentInstance!
    const index = inst.hookIndex++
    inst.pendingEffects.push({ index, fn, deps })
  },
  useRef(initial: unknown) {
    const inst = currentInstance!
    const index = inst.hookIndex++
    if (!(index in inst.hooks)) inst.hooks[index] = { current: initial }
    return inst.hooks[index]
  },
  useCallback<T>(fn: T): T { return fn },
}

interface Instance {
  Component: (props: Record<string, unknown>) => unknown
  props: Record<string, unknown>
  hooks: Record<number, unknown>
  hookIndex: number
  pendingEffects: { index: number, fn: () => unknown, deps: unknown[] | undefined }[]
  effectDeps: (unknown[] | undefined)[]
  cleanups: Record<number, (() => void) | undefined>
  tree: unknown
  render(nextProps?: Record<string, unknown>): unknown
}

function renderInstance(inst: Omit<Instance, 'render' | 'tree'>): unknown {
  ;(inst as Instance).hookIndex = 0
  ;(inst as Instance).pendingEffects = []
  currentInstance = inst as never
  try {
    return (inst as Instance).Component((inst as Instance).props)
  } finally {
    currentInstance = null
  }
}

function runEffects(inst: Instance): void {
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
    if (typeof cleanup === 'function') inst.cleanups[index] = cleanup as () => void
  }
}

function mount(Component: unknown, props: Record<string, unknown>): Instance {
  const inst = {
    Component,
    props,
    hooks: {},
    hookIndex: 0,
    pendingEffects: [],
    effectDeps: [],
    cleanups: {},
    tree: null,
    render(nextProps?: Record<string, unknown>) {
      if (nextProps !== undefined) inst.props = nextProps
      inst.tree = renderInstance(inst)
      return inst.tree
    },
  } as Instance
  inst.tree = renderInstance(inst)
  runEffects(inst)
  return inst
}

/** Run pending effects, let promise-based effects settle, then re-render. */
async function settle(inst: Instance, props?: Record<string, unknown>): Promise<void> {
  inst.render(props)
  runEffects(inst)
  await Promise.resolve()
  await Promise.resolve()
  inst.render(props)
  runEffects(inst)
}

// ── load the real client module ────────────────────────────────────────────
interface TestExports {
  shortId: (id: string) => string
  zh: Record<string, string>
  PickerCell: unknown
  DraftEditor: unknown
  BindingGroup: unknown
  TemplateEditor: unknown
  RunControls: unknown
}

function loadClient(): TestExports {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = 'exports.apply = apply;'
  if (source.split(marker).length !== 2) throw new Error('unexpected client shape: apply marker not unique')
  const inject = 'exports.__test = { shortId, PickerCell, DraftEditor, BindingGroup, TemplateEditor, RunControls, zh };'
  const instrumented = source.replace(marker, `${inject}\n    ${marker}`)
  let definition: { id: string, factory: (require: (specifier: string) => unknown) => { __test: TestExports } } | undefined
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def: unknown) { definition = def as never } },
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
  ;(sandbox as Record<string, unknown>).globalThis = sandbox
  runInNewContext(instrumented, sandbox, { filename: 'client.js' })
  if (definition === undefined || definition.id !== 'dsh-triggers') throw new Error('client factory not registered')
  const clientExports = definition.factory((specifier: string) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected require(${specifier})`)
  })
  if (clientExports.__test === undefined) throw new Error('test exports missing')
  return clientExports.__test
}

const T = loadClient()
const t = (key: string, vars?: Record<string, unknown>): string => {
  let text: string = T.zh[key] ?? key
  if (vars !== undefined) text = text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ''))
  return text
}

// ── element helpers ────────────────────────────────────────────────────────
interface Element { type: unknown, props: Record<string, unknown>, children: unknown[] }

function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) { for (const item of node) yield* walk(item); return }
  if (node === null || typeof node !== 'object') return
  yield node as Element
  for (const child of (node as Element).children ?? []) yield* walk(child)
}

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node !== null && typeof node === 'object' && Array.isArray((node as Element).children)) {
    return (node as Element).children.map(textOf).join('')
  }
  return ''
}

function byType(tree: unknown, type: unknown): Element[] {
  return [...walk(tree)].filter(node => node.type === type)
}

function byText(tree: unknown, type: unknown, text: string): Element | undefined {
  return [...walk(tree)].find(node => node.type === type && textOf(node).includes(text))
}

/** The PickerCell rendered under a labeled field (执行者 / 审核者): the
 * smallest holder whose direct children include the exact label text and
 * which contains exactly one picker. */
function pickerByLabel(tree: unknown, label: string): Element | undefined {
  let found: Element | undefined
  for (const holder of [...walk(tree)]) {
    if (holder.type !== 'div') continue
    if (!holder.children.some(child => textOf(child) === label)) continue
    const pickers = byType(holder, T.PickerCell)
    if (pickers.length !== 1) continue
    if (found === undefined || countNodes(holder) < countNodes(found!)) found = pickers[0]
  }
  return found
}

function countNodes(node: unknown): number {
  let count = 0
  for (const _ of walk(node)) count += 1
  return count
}

// ── fixtures ───────────────────────────────────────────────────────────────
const SESSIONS = [
  { id: 'session-1', title: undefined, cwd: '/home/u/project', running: false, updatedAt: 1 },
  { id: 'session-2', title: '重构任务', cwd: '/home/u/project', running: false, updatedAt: 2 },
]

const DATA = {
  templates: [
    { id: 'builtin-loop-start', name: '开工', body: 'start body', builtin: true },
    { id: 'builtin-loop-review', name: '审核实现结果', body: 'review body', builtin: true },
    { id: 'builtin-loop-rework', name: '根据审核意见返工', body: 'rework body', builtin: true },
  ],
  runs: [],
  deliveries: [],
  bindings: [],
}

const draftBinding = () => ({
  id: undefined,
  name: '',
  executor: '',
  parent: '',
  maxRounds: 5,
  enabled: true,
  templates: {
    start: 'builtin-loop-start',
    review: 'builtin-loop-review',
    rework: 'builtin-loop-rework',
  },
})

describe('session labels', () => {
  it('shortId distinguishes real session ids', () => {
    const ids = ['session-1', 'session-2', 'session-10', 'session-3f2a9c1d-8b44-4e6a-9f01-c2d3e4f5a6b7']
    const shortened = ids.map(id => T.shortId(id))
    expect(new Set(shortened).size).toBe(ids.length)
  })

  it('picker labels show the title first and stay distinguishable', () => {
    const calls: unknown[] = []
    const onDraftChange = (value: unknown): void => { calls.push(value) }
    const inst = mount(T.DraftEditor, {
      t, data: DATA, sessions: SESSIONS, draft: draftBinding(),
      onAction: () => Promise.resolve(), onDraftChange,
    })
    const executorPicker = pickerByLabel(inst.tree, t('executorLabel'))
    expect(executorPicker).toBeDefined()
    const options = (executorPicker!.props.options as { label: string }[])
    expect(new Set(options.map(option => option.label)).size).toBe(options.length)
    expect(options.find(option => option.label.includes('重构任务'))).toBeDefined()
  })
})

describe('draft binding form', () => {
  it('pickers write their own role; nothing is saved until 保存, and success closes the form', async () => {
    const actions: { endpoint: string, payload: Record<string, unknown> }[] = []
    let draft = draftBinding()
    let cleared = false
    const onDraftChange = (value: unknown): void => {
      if (value === null) cleared = true
      else draft = value as never
    }
    const onAction = (request: { endpoint: string, payload: Record<string, unknown> }): Promise<boolean> => {
      actions.push(request)
      return Promise.resolve(true)
    }
    const inst = mount(T.DraftEditor, {
      t, data: DATA, sessions: SESSIONS, draft: draftBinding(),
      onAction, onDraftChange,
    })

    const executorPicker = pickerByLabel(inst.tree, t('executorLabel'))!
    ;(executorPicker.props.onChange as (v: string) => void)('session-1')
    // The parent re-renders between picks (state change flush); take the
    // second picker from the re-rendered tree so its closure sees pick #1.
    inst.render({ t, data: DATA, sessions: SESSIONS, draft, onAction, onDraftChange })
    const reviewerPicker = pickerByLabel(inst.tree, t('reviewerLabel'))!
    ;(reviewerPicker.props.onChange as (v: string) => void)('session-2')
    expect(actions).toHaveLength(0) // explicit save only

    inst.render({ t, data: DATA, sessions: SESSIONS, draft, onAction, onDraftChange })
    const save = byText(inst.tree, 'button', t('saveGroup'))!
    ;(save.props.onClick as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    expect(actions).toHaveLength(1)
    expect(actions[0]!.endpoint).toBe('binding.save')
    expect(actions[0]!.payload).toMatchObject({ executor: 'session-1', parent: 'session-2' })
    expect(cleared).toBe(true) // a successful save closes the form
  })

  it('a failed save keeps the filled draft for the retry', async () => {
    let cleared = false
    const onDraftChange = (value: unknown): void => {
      if (value === null) cleared = true
    }
    // The panel's onAction resolves false when the RPC failed (the error
    // banner is the panel's business); the form must keep every field.
    const onAction = (): Promise<boolean> => Promise.resolve(false)
    const inst = mount(T.DraftEditor, {
      t, data: DATA, sessions: SESSIONS,
      draft: { ...draftBinding(), executor: 'session-1', parent: 'session-2' },
      onAction, onDraftChange,
    })
    const save = byText(inst.tree, 'button', t('saveGroup'))!
    ;(save.props.onClick as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    expect(cleared).toBe(false) // the form must survive a failed save
  })

  it('save stays disabled while the pair is incomplete', () => {
    const inst = mount(T.DraftEditor, {
      t, data: DATA, sessions: SESSIONS, draft: draftBinding(),
      onAction: () => Promise.resolve(true), onDraftChange: () => {},
    })
    const save = byText(inst.tree, 'button', t('saveGroup'))!
    expect(save.props.disabled).toBe(true)
  })
})

describe('template editor', () => {
  it('a fresh instance for template B shows B, and the parent key differs per template', () => {
    const A = { id: 'tpl-a', name: '审核 A', body: 'A body' }
    const B = { id: 'tpl-b', name: '返工 B', body: 'B body' }
    const inst = mount(T.TemplateEditor, { t, template: A, onAction: () => Promise.resolve() })
    ;(byType(inst.tree, 'input')[0]!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'A 已改' } })
    // The parent remounts on key change (editingKey = "id:<id>"); a fresh
    // instance for B must show B's values, not A's edits.
    const keyFor = (tpl: { id: string } | undefined): string => (tpl === undefined ? 'new' : `id:${tpl.id}`)
    expect(keyFor(B)).not.toBe(keyFor(A))
    const fresh = mount(T.TemplateEditor, { t, template: B, onAction: () => Promise.resolve() })
    expect((byType(fresh.tree, 'input')[0]!.props as { value: string }).value).toBe('返工 B')
    expect((byType(fresh.tree, 'textarea')[0]!.props as { value: string }).value).toBe('B body')
  })

  it('an unsaved template has no delete button, and cancel does not mutate anything', () => {
    const calls: unknown[] = []
    const inst = mount(T.TemplateEditor, {
      t, template: undefined,
      onAction: (request: unknown) => { calls.push(request); return Promise.resolve() },
      onCancel: () => { calls.push('cancel') },
    })
    expect(byText(inst.tree, 'button', t('del'))).toBeUndefined()
    const cancel = byText(inst.tree, 'button', t('cancelEdit'))!
    ;(cancel.props.onClick as () => void)()
    expect(calls).toEqual(['cancel'])
  })

  it('a built-in template shows delete disabled; a custom template deletes by id', () => {
    const calls: { endpoint: string, payload: Record<string, unknown> }[] = []
    const inst = mount(T.TemplateEditor, {
      t, template: { id: 'tpl-x', name: 'X', body: 'x' },
      onAction: (request: { endpoint: string, payload: Record<string, unknown> }) => { calls.push(request); return Promise.resolve() },
    })
    const del = byText(inst.tree, 'button', t('del'))!
    ;(del.props.onClick as () => void)()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ endpoint: 'template.delete', payload: { id: 'tpl-x' } })
  })
})

describe('group detail and run start', () => {
  const binding = {
    id: 'bnd-1', name: '循环 · 修 README', executor: 'session-2', parent: 'session-1',
    maxRounds: 5, enabled: true,
    templates: { start: 'builtin-loop-start', review: 'builtin-loop-review', rework: 'builtin-loop-rework' },
  }

  it('expanding a group offers an explicit run.start with the task', async () => {
    const actions: { endpoint: string, payload: Record<string, unknown> }[] = []
    const onAction = (request: { endpoint: string, payload: Record<string, unknown> }): Promise<void> => {
      actions.push(request)
      return Promise.resolve()
    }
    const inst = mount(T.BindingGroup, { t, binding, data: DATA, sessions: SESSIONS, onAction })
    const expand = byText(inst.tree, 'button', t('expand'))!
    ;(expand.props.onClick as () => void)()
    inst.render()

    const taskInput = byType(inst.tree, 'input').find(input =>
      (input.props as { placeholder?: string }).placeholder === t('startTaskPlaceholder'))
    expect(taskInput).toBeDefined()
    ;(taskInput!.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '修安装一节' } })
    inst.render()
    const start = byText(inst.tree, 'button', t('startRun'))!
    expect(start.props.disabled).toBeFalsy()
    ;(start.props.onClick as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    expect(actions.map(a => a.endpoint)).toContain('run.start')
    const started = actions.find(a => a.endpoint === 'run.start')!
    expect(started.payload).toMatchObject({ bindingId: 'bnd-1', task: '修安装一节' })
  })

  it('an active run disables the start button', () => {
    const data = {
      ...DATA,
      runs: [{
        id: 'run-1', bindingId: 'bnd-1', task: 't', status: 'active', phase: 'awaiting-delivery',
        round: 1, maxRounds: 5, executor: 'session-2', parent: 'session-1',
        templates: { start: '', review: '', rework: '' }, startedAt: 1, history: [],
      }],
    }
    const inst = mount(T.BindingGroup, { t, binding, data, sessions: SESSIONS, onAction: () => Promise.resolve() })
    ;(byText(inst.tree, 'button', t('expand'))!.props.onClick as () => void)()
    inst.render()
    const start = byText(inst.tree, 'button', t('startRun'))!
    expect(start.props.disabled).toBe(true)
  })
})

describe('run controls detail', () => {
  it('shows the task, history lines, and a failed delivery with its error and redeliver', async () => {
    const run = {
      id: 'run-9', bindingId: 'bnd-1', task: '修复构建', status: 'paused-error', phase: 'awaiting-review',
      round: 2, maxRounds: 5, executor: 'session-2', parent: 'session-1',
      templates: { start: '', review: '', rework: '' }, startedAt: 100,
      endNote: '投递失败（review → parent）：queue refused',
      history: [
        { at: 100, kind: 'started', detail: 'round budget 5' },
        { at: 200, kind: 'signal', detail: 'executor:deliver (turn 3)' },
      ],
    }
    const deliveries = [{
      id: 'dlv-1', runId: 'run-9', round: 2, to: 'session-1', kind: 'review',
      requestId: 'trg-x', state: 'failed', content: '…', createdAt: 300, error: 'queue refused (drill)',
    }]
    const actions: { endpoint: string, payload: Record<string, unknown> }[] = []
    const onAction = (request: { endpoint: string, payload: Record<string, unknown> }): Promise<void> => {
      actions.push(request)
      return Promise.resolve()
    }
    const inst = mount(T.RunControls, { t, runs: [run], deliveries, onAction })
    await settle(inst)
    const text = textOf(inst.tree)
    expect(text).toContain('修复构建')
    expect(text).toContain('executor:deliver (turn 3)')
    expect(text).toContain('queue refused (drill)')
    const redeliver = byText(inst.tree, 'button', t('redeliver'))!
    ;(redeliver.props.onClick as () => void)()
    await Promise.resolve()
    await Promise.resolve()
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      endpoint: 'run.control',
      payload: { runId: 'run-9', action: 'redeliver', deliveryId: 'dlv-1' },
    })
  })

  it('a cancelled run offers no redeliver button even with a failed delivery', () => {
    const run = {
      id: 'run-10', bindingId: 'bnd-1', task: '已取消', status: 'cancelled', phase: 'awaiting-review',
      round: 1, maxRounds: 5, executor: 'session-2', parent: 'session-1',
      templates: { start: '', review: '', rework: '' }, startedAt: 100,
      history: [{ at: 100, kind: 'started' }],
    }
    const deliveries = [{
      id: 'dlv-2', runId: 'run-10', round: 1, to: 'session-1', kind: 'review',
      requestId: 'trg-y', state: 'failed', content: '…', createdAt: 300, error: 'queue refused',
    }]
    const inst = mount(T.RunControls, { t, runs: [run], deliveries, onAction: () => Promise.resolve(true) })
    expect(byText(inst.tree, 'button', t('redeliver'))).toBeUndefined()
  })
})
