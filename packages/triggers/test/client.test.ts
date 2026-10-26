/**
 * Client-half tests: the real `client/client.js` loaded in a VM with a
 * minimal React hooks runtime, so the shipped browser code (plain JS, not
 * type-checked) is exercised directly. Covers the session-scoped view: role
 * labels, the no-create empty state, expandable run details, run controls,
 * redelivery gating, and the single Conversation-tab registration.
 *
 * @module dsh-triggers/client.test
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'

// ── minimal React + hooks runtime ──────────────────────────────────────────
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
    const previousCleanup = inst.cleanups[index]
    if (typeof previousCleanup === 'function') {
      previousCleanup()
      inst.cleanups[index] = undefined
    }
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

// ── load the real client module ────────────────────────────────────────────
interface TestExports {
  shortId: (id: string) => string
  TriggerListView: unknown
  TriggersView: unknown
  TriggerRow: unknown
  RunEntry: unknown
  RunBody: unknown
  RunDetails: unknown
  Disclosure: unknown
  RunActions: unknown
  HistoryList: unknown
  DeliveryList: unknown
  ConfigFacts: unknown
  buildGroups: (data: unknown, sessionId: string) => GroupFixture[]
  scopeSnapshot: (data: unknown, sessionId: string) => unknown
  canRedeliver: (run: RunFixture, delivery: DeliveryFixture) => boolean
  zh: Record<string, string>
  en: Record<string, string>
  apply: (ctx: unknown) => void
  setConfirm: (value: boolean) => void
  setFetch: (impl: (url: string, init: { body: string }) => Promise<unknown>) => void
}

interface BindingFixture {
  id: string
  name: string
  executor: string
  parent: string
  maxRounds: number
  enabled: boolean
  autoDeliver?: boolean
  templates: { start: string, review: string, rework: string }
  createdAt: number
  updatedAt: number
}

interface RunFixture {
  id: string
  bindingId: string
  task: string
  status: string
  phase: string
  round: number
  maxRounds: number
  executor: string
  parent: string
  templates: { start: string, review: string, rework: string }
  startedAt: number
  endedAt?: number
  endNote?: string
  history: { at: number, kind: string, detail?: string }[]
  pendingSignal?: { outcome: string, summary: string, turn: number, at: number }
  pendingRework?: { summary: string, round: number }
  pausedBy?: 'executor' | 'parent'
  autoDeliver?: boolean
}

interface GroupFixture {
  id: string
  binding?: BindingFixture
  runs: RunFixture[]
  current?: RunFixture
  role?: 'executor' | 'parent'
  peer?: string
}

interface DeliveryFixture {
  id: string
  runId: string
  round: number
  to: string
  kind: string
  requestId: string
  state: 'pending' | 'sent' | 'failed'
  content: string
  createdAt: number
  error?: string
}

function loadClient(): TestExports {
  const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  const marker = 'exports.apply = apply;'
  if (source.split(marker).length !== 2) throw new Error('unexpected client shape: apply marker not unique')
  const inject = 'exports.__test = { shortId, TriggerListView, TriggersView, TriggerRow, RunEntry, RunBody, RunDetails, Disclosure, RunActions, HistoryList, DeliveryList, ConfigFacts, buildGroups, scopeSnapshot, canRedeliver, zh, en };'
  const instrumented = source.replace(marker, `${inject}\n    ${marker}`)
  let definition: {
    id: string
    factory: (require: (specifier: string) => unknown) => { __test: TestExports, apply: (ctx: unknown) => void }
  } | undefined
  let confirmValue = false
  let fetchImpl: (url: string, init: { body: string }) => Promise<unknown> = () => Promise.reject(new Error('fetch is not used by this harness'))
  const sandbox = {
    window: {
      __ModuleLoader__: { load(def: unknown) { definition = def as never } },
      confirm: () => confirmValue,
      matchMedia: () => ({ matches: false }),
      addEventListener() {}, removeEventListener() {},
    },
    console,
    fetch: (url: string, init: { body: string }) => fetchImpl(url, init),
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
  const test = clientExports.__test
  test.apply = clientExports.apply
  test.setConfirm = (value: boolean) => { confirmValue = value }
  test.setFetch = (impl) => { fetchImpl = impl }
  return test
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

function buttonContaining(tree: unknown, text: string): Element | undefined {
  return [...walk(tree)].find(node =>
    node.type === 'button' &&
    (textOf(node).includes(text) || String((node.props as { 'aria-label'?: string })['aria-label'] ?? '') === text)
  )
}

function rowMain(tree: unknown): Element {
  const row = [...walk(tree)].find(node =>
    node.type === 'button' && String((node.props as { className?: string }).className ?? '').includes('dsh-triggers-row-main')
  )
  if (row === undefined) throw new Error('row main button missing')
  return row
}

// ── fixtures ───────────────────────────────────────────────────────────────
const SESSION = 'session-current'
const PEER = 'session-peer'
const SESSIONS = {
  [SESSION]: { displayTitle: '当前会话', running: false },
  [PEER]: { displayTitle: '重构任务', running: false },
  'session-new-peer': { displayTitle: '新执行会话', running: false },
}

const TEMPLATES = [
  { id: 'builtin-loop-start', name: '开工', body: 'start body', builtin: true },
  { id: 'builtin-loop-review', name: '审核实现结果', body: 'review body', builtin: true },
  { id: 'builtin-loop-rework', name: '根据审核意见返工', body: 'rework body', builtin: true },
]

function binding(overrides?: Partial<BindingFixture>): BindingFixture {
  return {
    id: 'bnd-1',
    name: '循环 · 修 README',
    executor: PEER,
    parent: SESSION,
    maxRounds: 5,
    enabled: true,
    autoDeliver: true,
    templates: { start: 'builtin-loop-start', review: 'builtin-loop-review', rework: 'builtin-loop-rework' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function run(overrides?: Partial<RunFixture>): RunFixture {
  return {
    id: 'run-1',
    bindingId: 'bnd-1',
    task: '修复构建',
    status: 'active',
    phase: 'awaiting-review',
    round: 2,
    maxRounds: 5,
    executor: PEER,
    parent: SESSION,
    templates: { start: '', review: '', rework: '' },
    startedAt: 1_700_000_000_000,
    autoDeliver: true,
    history: [],
    ...overrides,
  }
}

function delivery(overrides?: Partial<DeliveryFixture>): DeliveryFixture {
  return {
    id: 'dlv-1',
    runId: 'run-1',
    round: 2,
    to: SESSION,
    kind: 'review',
    requestId: 'trg-1',
    state: 'failed',
    content: '…',
    createdAt: 1_700_000_000_100,
    error: 'queue refused',
    ...overrides,
  }
}

function dataWith(input: { bindings?: BindingFixture[], runs?: RunFixture[], deliveries?: DeliveryFixture[] }) {
  return {
    templates: TEMPLATES,
    bindings: input.bindings ?? [],
    runs: input.runs ?? [],
    deliveries: input.deliveries ?? [],
  }
}

function mountList(
  data: ReturnType<typeof dataWith>,
  props?: Partial<Record<string, unknown>>,
): Instance {
  return mount(T.TriggerListView, {
    t,
    sessionId: SESSION,
    data,
    loading: false,
    error: undefined,
    actionError: undefined,
    sessionsById: SESSIONS,
    onAction: () => Promise.resolve(true),
    onRefresh: () => {},
    onDismissActionError: () => {},
    ...props,
  })
}


function mountGroup(data: ReturnType<typeof dataWith>, props?: Partial<Record<string, unknown>>): Instance {
  const scoped = T.scopeSnapshot(data, SESSION) as ReturnType<typeof dataWith>
  const groups = T.buildGroups(scoped, SESSION)
  if (groups.length === 0) throw new Error('group fixture missing')
  const group = groups[0]!
  return mount(T.TriggerRow, {
    t,
    group,
    sessionId: SESSION,
    sessionsById: SESSIONS,
    templates: scoped.templates,
    deliveries: scoped.deliveries,
    onAction: () => Promise.resolve(true),
    ...props,
  })
}

function mountRunBody(runFixture: RunFixture, deliveries: DeliveryFixture[], props?: Partial<Record<string, unknown>>): Instance {
  return mount(T.RunBody, {
    t,
    run: runFixture,
    sessionId: SESSION,
    sessionsById: SESSIONS,
    deliveries,
    onAction: () => Promise.resolve(true),
    binding: binding(),
    showConfig: true,
    templates: TEMPLATES,
    ...props,
  })
}

function mountRunDetails(runFixture: RunFixture, deliveries: DeliveryFixture[], props?: Partial<Record<string, unknown>>): Instance {
  return mount(T.RunDetails, {
    t,
    run: runFixture,
    sessionsById: SESSIONS,
    deliveries,
    onAction: () => Promise.resolve(true),
    binding: binding(),
    templates: TEMPLATES,
    ...props,
  })
}

function disclosureByLabel(tree: unknown, label: string): Element | undefined {
  return [...walk(tree)].find(node =>
    node.type === T.Disclosure && (node.props as { label?: string }).label === label)
}

function expandRow(inst: Instance): void {
  ;(rowMain(inst.tree).props.onClick as () => void)()
  inst.render()
}

async function click(inst: Instance, element: Element): Promise<void> {
  ;(element.props.onClick as () => void)()
  await Promise.resolve()
  await Promise.resolve()
  inst.render()
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

function rpcResponse(value: unknown): { json: () => Promise<unknown> } {
  return { json: () => Promise.resolve({ result: { ok: true, value } }) }
}

// ── tests ──────────────────────────────────────────────────────────────────
describe('session labels', () => {
  it('shortId distinguishes real session ids', () => {
    const ids = ['session-1', 'session-2', 'session-10', 'session-3f2a9c1d-8b44-4e6a-9f01-c2d3e4f5a6b7']
    const shortened = ids.map(id => T.shortId(id))
    expect(new Set(shortened).size).toBe(ids.length)
  })
})

describe('session-scoped list', () => {
  it('keeps one summary line for the current run', () => {
    const inst = mountGroup(dataWith({ bindings: [binding()], runs: [run()] }))
    const text = textOf(inst.tree)
    expect(text).toContain('修复构建')
    expect(text).toContain(t('roleReviewer'))
    expect(text).toContain('重构任务')
    expect(text).toContain(t('round', { round: 2, max: 5 }))
    expect(text).toContain(t('statusActiveReview'))
    expect(text).not.toContain('自动送审')
    expect(text.match(/修复构建/g)).toHaveLength(1)
    expect(text.match(/等待审核/g)).toHaveLength(1)
    expect(text.match(/第 2\/5 轮/g)).toHaveLength(1)

    expandRow(inst)
    expect(byType(inst.tree, T.RunEntry)).toHaveLength(0)
    expect(byType(inst.tree, T.RunBody)).toHaveLength(1)
    const expanded = textOf(inst.tree)
    expect(expanded.match(/修复构建/g)).toHaveLength(1)
    expect(expanded.match(/等待审核/g)).toHaveLength(1)
  })

  it('defensively drops bindings and runs that do not name this session', () => {
    const foreignRun = run({ id: 'run-foreign', bindingId: 'bnd-foreign', task: '别人的任务', executor: 'session-x', parent: 'session-y' })
    const data = dataWith({
      bindings: [binding(), binding({ id: 'bnd-foreign', name: '别人的绑定', executor: 'session-x', parent: 'session-y' })],
      runs: [run(), foreignRun],
    })
    const scoped = T.scopeSnapshot(data, SESSION) as ReturnType<typeof dataWith>
    expect(scoped.bindings).toHaveLength(1)
    expect(scoped.runs).toHaveLength(1)
    const inst = mountGroup(data)
    const text = textOf(inst.tree)
    expect(text).toContain('修复构建')
    expect(text).not.toContain('别人的任务')
    expect(text).not.toContain('别人的绑定')
  })

  it('shows a not-started binding without inventing a create or start action', () => {
    const inst = mountGroup(dataWith({ bindings: [binding({ autoDeliver: false })] }))
    expect(textOf(inst.tree)).toContain(t('noRun'))
    expect(buttonContaining(inst.tree, '新建')).toBeUndefined()
    expect(buttonContaining(inst.tree, '启动运行')).toBeUndefined()

    expandRow(inst)
    expect(textOf(inst.tree)).toContain(t('noRunHint'))
    expect(disclosureByLabel(inst.tree, t('configTitle'))).toBeDefined()
    expect(byType(inst.tree, T.RunBody)).toHaveLength(0)
    expect(buttonContaining(inst.tree, '启动运行')).toBeUndefined()
  })

  it('empty state has no create button', () => {
    const inst = mountList(dataWith({}))
    const text = textOf(inst.tree)
    expect(text).toContain(t('emptyTitle'))
    expect(text).toContain(t('emptyHint'))
    expect(buttonContaining(inst.tree, '新建')).toBeUndefined()
  })

  it('renders one row component per participating group and keeps one header summary', () => {
    const inst = mountList(dataWith({ bindings: [binding()], runs: [run()] }))
    const rows = byType(inst.tree, T.TriggerRow)
    expect(rows).toHaveLength(1)
    expect((rows[0]!.props.group as GroupFixture).current!.id).toBe('run-1')
    const text = textOf(inst.tree)
    expect(text).toContain(t('activeSummary', { n: 1 }))
    expect(text.match(/个运行进行中/g)).toHaveLength(1)
    expect(text).not.toContain('状态推进由宿主完成')
    expect(text).not.toContain('当前会话参与的执行与审核循环')
  })

  it('groups other runs behind a collapsed disclosure', () => {
    const ended = run({ id: 'run-ended', task: '上一轮任务', status: 'completed', phase: 'awaiting-review', round: 1, startedAt: 1_699_000_000_000 })
    const inst = mountGroup(dataWith({ bindings: [binding()], runs: [run(), ended] }))
    expect(textOf(inst.tree)).not.toContain('另有')

    expandRow(inst)
    const otherRuns = disclosureByLabel(inst.tree, t('otherRuns') + ' (1)')
    expect(otherRuns).toBeDefined()
    const entries = byType(inst.tree, T.RunEntry)
    expect(entries).toHaveLength(1)
    expect((entries[0]!.props.run as RunFixture).id).toBe('run-ended')
    expect(entries[0]!.props.defaultOpen).toBeUndefined()
    expect(byType(inst.tree, T.RunBody)).toHaveLength(1) // current run body
  })

  it('keeps a run whose binding is no longer visible, with an honest note', () => {
    const inst = mountGroup(dataWith({ runs: [run({ bindingId: 'bnd-gone', task: '遗留运行' })] }))
    expect(textOf(inst.tree)).toContain('遗留运行')
    expandRow(inst)
    expect(textOf(inst.tree)).toContain(t('missingBindingNote'))
    expect(byType(inst.tree, T.RunBody)).toHaveLength(1)
    expect(byType(inst.tree, T.ConfigFacts)).toHaveLength(0)
  })

  it('notes when the binding pair differs from the run snapshot', () => {
    const changed = binding({ executor: 'session-new-peer' })
    const inst = mountGroup(dataWith({ bindings: [changed], runs: [run()] }))
    expandRow(inst)
    expect(textOf(inst.tree)).toContain(t('snapshotNote'))
    expect(textOf(inst.tree)).toContain('重构任务')
    const bodies = byType(inst.tree, T.RunBody)
    expect(bodies).toHaveLength(1)
    expect((bodies[0]!.props.binding as BindingFixture).executor).toBe('session-new-peer')
    expect(byType(inst.tree, T.ConfigFacts)).toHaveLength(0) // folded inside the body's details
  })

  it('keeps binding status out of the row summary', () => {
    const inst = mountGroup(dataWith({ bindings: [binding({ enabled: false })], runs: [run()] }))
    expect(textOf(inst.tree)).not.toContain(t('configDisabled'))
  })

  it('summarizes active runs even when a paused run is the representative', () => {
    const paused = run({ id: 'run-paused', status: 'paused-error', phase: 'awaiting-review' })
    const active = run({ id: 'run-active', status: 'active', phase: 'awaiting-delivery', startedAt: 1_700_000_001_000 })
    const inst = mountList(dataWith({ bindings: [binding()], runs: [paused, active] }))
    const rows = byType(inst.tree, T.TriggerRow)
    expect((rows[0]!.props.group as GroupFixture).current!.status).toBe('paused-error')
    expect(textOf(inst.tree)).toContain(t('activeSummary', { n: 1 }))
  })
})

describe('run details and controls', () => {
  it('keeps the reason, attention deliveries, and actions visible while folding history and config', () => {
    const inst = mountRunBody(
      run({
        status: 'paused-user', phase: 'awaiting-delivery', pausedBy: 'parent', endNote: '请确认',
        history: [{ at: 1_700_000_000_000, kind: 'started', detail: 'round budget 5' }],
      }),
      [
        delivery({ id: 'dlv-failed', state: 'failed', error: 'queue refused' }),
        delivery({ id: 'dlv-pending', state: 'pending', error: undefined }),
        delivery({ id: 'dlv-sent', state: 'sent', error: undefined }),
      ],
    )
    const text = textOf(inst.tree)
    expect(text).toContain(t('reasonPausedUserSelf'))
    expect(text).toContain('请确认')

    const attention = byType(inst.tree, T.DeliveryList)
    expect(attention).toHaveLength(1)
    const attentionProps = attention[0]!.props as { title: string, deliveries: DeliveryFixture[] }
    expect(attentionProps.title).toBe(t('attentionDeliveries'))
    expect(attentionProps.deliveries.map(entry => entry.id)).toEqual(['dlv-failed', 'dlv-pending'])

    const walkOrder = [...walk(inst.tree)]
    const actionsIndex = walkOrder.findIndex(node => node.type === T.RunActions)
    const detailsIndex = walkOrder.findIndex(node => node.type === T.RunDetails)
    expect(walkOrder.indexOf(attention[0]!)).toBeLessThan(actionsIndex)
    expect(walkOrder.indexOf(attention[0]!)).toBeLessThan(detailsIndex)
    expect(byType(inst.tree, T.HistoryList)).toHaveLength(0)
    expect(byType(inst.tree, T.ConfigFacts)).toHaveLength(0)
    const details = byType(inst.tree, T.RunDetails)
    expect(details).toHaveLength(1)
    expect((details[0]!.props as { binding?: BindingFixture }).binding).toBeDefined()
  })

  it('states the terminal reason and end note without opening history', () => {
    const inst = mountRunBody(
      run({
        status: 'completed', phase: 'awaiting-review', endNote: '已合并',
        history: [{ at: 1_700_000_000_000, kind: 'end', detail: 'pass' }],
      }),
      [],
    )
    const text = textOf(inst.tree)
    expect(text).toContain(t('reasonCompleted'))
    expect(text).toContain('已合并')
    expect(byType(inst.tree, T.RunDetails)).toHaveLength(1)
    expect(byType(inst.tree, T.HistoryList)).toHaveLength(0)
  })

  it('keeps a non-current run closed until its compact header is opened', () => {
    const inst = mount(T.RunEntry, {
      t,
      run: run({ status: 'completed', phase: 'awaiting-review', endNote: '已合并' }),
      sessionId: SESSION,
      sessionsById: SESSIONS,
      deliveries: [],
      onAction: () => Promise.resolve(true),
    })
    const text = textOf(inst.tree)
    expect(text).toContain(t('statusCompleted'))
    expect(text).toContain('修复构建')
    expect(text).toContain(t('round', { round: 2, max: 5 }))
    expect(byType(inst.tree, T.RunBody)).toHaveLength(0)

    const head = [...walk(inst.tree)].find(node =>
      node.type === 'button' && String((node.props as { className?: string }).className ?? '').includes('dsh-triggers-run-head'))
    expect(head).toBeDefined()
    ;(head!.props.onClick as () => void)()
    inst.render()
    expect(byType(inst.tree, T.RunBody)).toHaveLength(1)
  })

  it('opens a disclosure only on demand', async () => {
    const inst = mount(T.Disclosure, {
      label: '详情',
      children: React.createElement('span', null, 'folded content'),
    })
    expect(textOf(inst.tree)).not.toContain('folded content')
    const toggle = buttonContaining(inst.tree, '详情')!
    expect(toggle).toBeDefined()
    await click(inst, toggle)
    expect(textOf(inst.tree)).toContain('folded content')
  })

  it('folds history, sent deliveries, and config behind one details disclosure', () => {
    const inst = mountRunDetails(
      run({ history: [{ at: 1_700_000_000_000, kind: 'advance', detail: 'step 2' }] }),
      [delivery({ state: 'sent', error: undefined }), delivery({ state: 'failed' })],
    )
    const disclosure = byType(inst.tree, T.Disclosure)
    expect(disclosure).toHaveLength(1)
    expect(disclosure[0]!.props.label).toBe(t('details'))
    expect(byType(inst.tree, T.HistoryList)).toHaveLength(1)
    expect(byType(inst.tree, T.ConfigFacts)).toHaveLength(1)
    const sent = byType(inst.tree, T.DeliveryList)
    expect(sent).toHaveLength(1)
    expect((sent[0]!.props as { title: string }).title).toBe(t('sentDeliveries'))
    expect((sent[0]!.props as { deliveries: DeliveryFixture[] }).deliveries.map(entry => entry.state)).toEqual(['sent'])
  })

  it('labels a config-only drawer as configuration', () => {
    const inst = mountRunDetails(run({ history: [] }), [])
    const disclosure = byType(inst.tree, T.Disclosure)
    expect(disclosure).toHaveLength(1)
    expect(disclosure[0]!.props.label).toBe(t('configTitle'))
  })

  it('has no details disclosure when a run carries nothing folded and no binding', () => {
    const inst = mountRunDetails(run({ history: [] }), [], { binding: undefined })
    expect(inst.tree).toBeNull()
  })

  it('history shows recent entries and names the truncation', () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      at: 1_700_000_000_000 + index, kind: 'advance', detail: `step ${index}`,
    }))
    const inst = mount(T.HistoryList, { t, run: run({ history }) })
    const text = textOf(inst.tree)
    expect(text).toContain(t('historyTruncated', { shown: 6, total: 8 }))
    expect(text).toContain('step 2')
    expect(text).not.toContain('step 1')
    expect(text).toContain('step 7')
  })

  it('config facts expose the binding and its templates read-only', () => {
    const inst = mount(T.ConfigFacts, {
      t, binding: binding({ enabled: false }), sessionsById: SESSIONS, templates: TEMPLATES,
    })
    const text = textOf(inst.tree)
    expect(text).toContain(t('configExecutor'))
    expect(text).toContain('重构任务')
    expect(text).toContain('当前会话')
    expect(text).toContain(t('configEnabled'))
    expect(text).toContain(t('configDisabled'))
    expect(text).toContain(t('tplStart') + ' 开工')
    expect(text).toContain(t('configHint'))
    expect(buttonContaining(inst.tree, '保存')).toBeUndefined()
  })

  it('resume with a note sends the message; pause and extend send their controls', async () => {
    const actions: { endpoint: string, payload: Record<string, unknown> }[] = []
    const onAction = (endpoint: string, payload: Record<string, unknown>): Promise<boolean> => {
      actions.push({ endpoint, payload })
      return Promise.resolve(true)
    }

    const paused = mount(T.RunActions, { t, run: run({ status: 'paused-user', pausedBy: 'parent' }), onAction })
    const input = byType(paused.tree, 'input').find(node =>
      (node.props as { placeholder?: string }).placeholder === t('resumeNotePlaceholder'))
    expect(input).toBeDefined()
    ;(input!.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: '补充说明' } })
    paused.render()
    await click(paused, buttonContaining(paused.tree, t('resume'))!)
    expect(actions.at(-1)).toMatchObject({
      endpoint: 'run.control',
      payload: { runId: 'run-1', action: 'resume', message: '补充说明' },
    })

    const active = mount(T.RunActions, { t, run: run(), onAction })
    await click(active, buttonContaining(active.tree, t('pause'))!)
    expect(actions.at(-1)).toMatchObject({ endpoint: 'run.control', payload: { runId: 'run-1', action: 'pause' } })

    const budget = mount(T.RunActions, {
      t, run: run({ status: 'paused-budget', phase: 'awaiting-delivery', pendingRework: { summary: '请补测试', round: 3 } }), onAction,
    })
    await click(budget, buttonContaining(budget.tree, t('extend'))!)
    expect(actions.at(-1)).toMatchObject({ endpoint: 'run.control', payload: { runId: 'run-1', action: 'extend' } })
  })

  it('demotes cancel to a quiet action but still asks for confirmation', async () => {
    const actions: { endpoint: string, payload: Record<string, unknown> }[] = []
    const inst = mount(T.RunActions, {
      t,
      run: run(),
      onAction: (endpoint: string, payload: Record<string, unknown>) => {
        actions.push({ endpoint, payload })
        return Promise.resolve(true)
      },
    })
    const cancel = buttonContaining(inst.tree, t('cancel'))!
    expect(cancel.props['data-variant']).toBe('quiet')
    T.setConfirm(false)
    await click(inst, cancel)
    expect(actions).toHaveLength(0)
    T.setConfirm(true)
    await click(inst, buttonContaining(inst.tree, t('cancel'))!)
    expect(actions.at(-1)).toMatchObject({ endpoint: 'run.control', payload: { runId: 'run-1', action: 'cancel' } })
  })
})

describe('deliveries', () => {
  it('offers redelivery only for the round and side the run is waiting on', async () => {
    const actions: { endpoint: string, payload: Record<string, unknown> }[] = []
    const inst = mount(T.DeliveryList, {
      t,
      run: run({ status: 'paused-error', phase: 'awaiting-review' }),
      sessionsById: SESSIONS,
      deliveries: [delivery()],
      onAction: (endpoint: string, payload: Record<string, unknown>) => {
        actions.push({ endpoint, payload })
        return Promise.resolve(true)
      },
    })
    expect(textOf(inst.tree)).toContain('queue refused')
    await click(inst, buttonContaining(inst.tree, t('redeliver'))!)
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({
      endpoint: 'run.control',
      payload: { runId: 'run-1', action: 'redeliver', deliveryId: 'dlv-1' },
    })
  })

  it('a stale round or a terminal run has no redeliver button', () => {
    const stale = mount(T.DeliveryList, {
      t,
      run: run({ status: 'active', phase: 'awaiting-delivery', round: 2 }),
      sessionsById: SESSIONS,
      deliveries: [delivery({ round: 1 })],
      onAction: () => Promise.resolve(true),
    })
    expect(buttonContaining(stale.tree, t('redeliver'))).toBeUndefined()

    const cancelled = mount(T.DeliveryList, {
      t,
      run: run({ status: 'cancelled', phase: 'awaiting-review' }),
      sessionsById: SESSIONS,
      deliveries: [delivery()],
      onAction: () => Promise.resolve(true),
    })
    expect(buttonContaining(cancelled.tree, t('redeliver'))).toBeUndefined()
  })

  it('canRedeliver mirrors the server gate', () => {
    expect(T.canRedeliver(run({ status: 'paused-error' }), delivery())).toBe(true)
    expect(T.canRedeliver(run({ status: 'active' }), delivery())).toBe(true)
    expect(T.canRedeliver(run({ status: 'completed' }), delivery())).toBe(false)
    expect(T.canRedeliver(run({ status: 'paused-budget' }), delivery())).toBe(false)
    expect(T.canRedeliver(run({ status: 'active' }), delivery({ state: 'sent' }))).toBe(false)
    expect(T.canRedeliver(run({ status: 'active', round: 3 }), delivery({ round: 2 }))).toBe(false)
  })
})

describe('session switching', () => {
  it('ignores a previous session response after the view switched', async () => {
    const pending: { sessionId: string, resolve: (value: unknown) => void }[] = []
    T.setFetch((_url, init) => {
      const body = JSON.parse(init.body) as { payload: { sessionId: string } }
      return new Promise(resolve => {
        pending.push({ sessionId: body.payload.sessionId, resolve })
      })
    })
    try {
      const inst = mount(T.TriggersView, { t, sessionId: SESSION, useSessions: () => SESSIONS })
      expect(pending.map(request => request.sessionId)).toEqual([SESSION])

      inst.render({ t, sessionId: 'session-other', useSessions: () => SESSIONS })
      runEffects(inst)
      expect(pending.map(request => request.sessionId)).toEqual([SESSION, 'session-other'])

      // The old request settles after the switch; its data must not leak into
      // the new session's view.
      pending[0]!.resolve(rpcResponse(dataWith({ bindings: [binding()], runs: [run()] })))
      await flushMicrotasks()
      inst.render({ t, sessionId: 'session-other', useSessions: () => SESSIONS })
      let list = byType(inst.tree, T.TriggerListView)[0]!
      expect((list.props as { data: unknown }).data).toBeNull()

      pending[1]!.resolve(rpcResponse(dataWith({})))
      await flushMicrotasks()
      inst.render({ t, sessionId: 'session-other', useSessions: () => SESSIONS })
      list = byType(inst.tree, T.TriggerListView)[0]!
      expect((list.props as { data: unknown }).data).toEqual(dataWith({}))
    } finally {
      T.setFetch(() => Promise.reject(new Error('fetch is not used by this harness')))
    }
  })
})

describe('scroll ownership', () => {
  it('contributes normal-flow content without a nested scroll container', () => {
    const inst = mountList(dataWith({ bindings: [binding()], runs: [run()] }))
    const nodes = [...walk(inst.tree)]
    expect(nodes.some(node => (node.props as { className?: string }).className === 'dsh-triggers-scroll')).toBe(false)
    const root = nodes.find(node => (node.props as { className?: string }).className === 'dsh-triggers-root')
    expect(root).toBeDefined()
    expect((root!.props as { style?: unknown }).style).toBeUndefined()

    // Structural guard against reintroducing the fixed-height inner scrollport
    // that blocked wheel input; real wheel behavior still needs the host.
    const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
    expect(source).not.toContain('dsh-triggers-scroll')
    expect(source).not.toMatch(/dsh-triggers-root\{[^}]*height:100%/)
    expect(source).not.toMatch(/dsh-triggers-root\{[^}]*overflow/)
  })
})

describe('slot registration', () => {
  it('registers exactly one Conversation tab at order 30', () => {
    const injected: string[] = []
    const registrations: { options: Record<string, unknown> }[] = []
    const ctx = {
      effect: (fn: () => unknown) => { const result = fn(); return typeof result === 'function' ? result : () => {} },
      locale: { register: () => () => {}, bind: () => t },
      slots: {
        inject: (name: string, callback: () => unknown) => { injected.push(name); return callback() },
        register: (options: Record<string, unknown>) => { registrations.push({ options }); return () => {} },
      },
    }
    T.apply(ctx)
    expect(injected).toEqual(['conversation.view'])
    expect(registrations).toHaveLength(1)
    expect(registrations[0]!.options).toMatchObject({ name: 'conversation.view', id: 'triggers', order: 30 })
    expect((registrations[0]!.options.label as () => string)()).toBe('触发器')
  })
})
