import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, testHandles as T } from '../src/client/index.tsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
}

const SESSION = 'session-current'
const PEER = 'session-peer'
const SESSIONS = {
  [SESSION]: { displayTitle: '当前会话', running: false },
  [PEER]: { displayTitle: '重构任务', running: false },
}

const t = (key, vars) => {
  let text = T.zh[key] ?? key
  if (vars !== undefined)
    text = text.replaceAll(/\{(\w+)\}/gu, (_, name) => String(vars[name] ?? ''))
  return text
}

function binding(overrides) {
  return {
    id: 'bnd-1',
    name: '循环 · 修 README',
    executor: PEER,
    parent: SESSION,
    maxRounds: 5,
    enabled: true,
    autoDeliver: true,
    templates: { start: 'start', review: 'review', rework: 'rework' },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function run(overrides) {
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
    startedAt: 1_700_000_000_000,
    autoDeliver: true,
    history: [],
    ...overrides,
  }
}

function delivery(overrides) {
  return {
    id: 'dlv-1',
    runId: 'run-1',
    round: 2,
    to: SESSION,
    kind: 'review',
    state: 'failed',
    createdAt: 1_700_000_000_100,
    ...overrides,
  }
}

function dataWith({ bindings = [], runs = [], deliveries = [] } = {}) {
  return { templates: [], bindings, runs, deliveries }
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children ?? []).map((child) => textOf(child)).join('')
}

function buttons(renderer) {
  return renderer.root.findAllByType('button')
}

function buttonWith(renderer, text) {
  return buttons(renderer).find(
    (button) => textOf(button) === text || button.props['aria-label'] === text,
  )
}

async function mountView(data) {
  let registration
  const ctx = {
    effect(effect) {
      effect()
    },
    locale: {
      register() {},
      bind: () => t,
    },
    slots: {
      inject(_name, callback) {
        callback()
      },
      register(options, component) {
        registration = { options, component }
      },
    },
    remote: {},
  }
  apply(ctx)
  if (registration === undefined) throw new Error('conversation.view was not registered')

  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { ok: true, value: data } }),
    })),
  )

  let renderer
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(registration.component, {
        sessionId: SESSION,
        useSessions: (selector) => selector({ byId: SESSIONS }),
      }),
    )
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return { renderer, registration }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('registration', () => {
  it('keeps the Conversation-tab contract and module inject list', () => {
    let registration
    const ctx = {
      effect(effect) {
        effect()
      },
      locale: { register() {}, bind: () => t },
      slots: {
        inject(_name, callback) {
          callback()
        },
        register(options, component) {
          registration = { options, component }
        },
      },
      remote: {},
    }
    apply(ctx)
    expect(registration.options).toMatchObject({
      name: 'conversation.view',
      id: 'triggers',
      order: 30,
      locale: 'triggers',
    })
    expect(inject).toEqual(['slots', 'locale'])
  })
})

describe('session-scoped grouping', () => {
  it('returns one group with the current run and the peer role', () => {
    const scoped = T.scopeSnapshot(dataWith({ bindings: [binding()], runs: [run()] }), SESSION)
    const groups = T.buildGroups(scoped, SESSION)
    expect(groups).toHaveLength(1)
    expect(groups[0].role).toBe('parent')
    expect(groups[0].current.id).toBe('run-1')
    expect(groups[0].runs).toHaveLength(1)
  })

  it('drops runs and bindings that do not involve this session', () => {
    const foreign = run({ id: 'run-x', executor: 'session-x', parent: 'session-y' })
    const scoped = T.scopeSnapshot(
      dataWith({ bindings: [binding()], runs: [run(), foreign] }),
      SESSION,
    )
    expect(scoped.runs.map((entry) => entry.id)).toEqual(['run-1'])
  })

  it('shortens session ids without collisions', () => {
    const ids = [
      'session-1',
      'session-2',
      'session-10',
      'session-3f2a9c1d-8b44-4e6a-9f01-c2d3e4f5a6b7',
    ]
    expect(new Set(ids.map((id) => T.shortId(id))).size).toBe(ids.length)
  })
})

describe('list view', () => {
  it('renders the no-trigger empty state', async () => {
    const { renderer } = await mountView(dataWith())
    const text = textOf(renderer.toJSON())
    expect(text).toContain(t('emptyTitle'))
    expect(text).toContain(t('emptyHint'))
  })

  it('shows the running loop with role, task, peer title and round', async () => {
    const { renderer } = await mountView(dataWith({ bindings: [binding()], runs: [run()] }))
    const text = textOf(renderer.toJSON())
    expect(text).toContain('修复构建')
    expect(text).toContain(t('roleReviewer'))
    expect(text).toContain('重构任务')
    expect(text).toContain(t('round', { round: 2, max: 5 }))
  })
})

describe('run controls', () => {
  it('pauses an active run through run.control', async () => {
    const { renderer } = await mountView(dataWith({ bindings: [binding()], runs: [run()] }))
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['aria-expanded'] === false)
        .props.onClick()
    })
    const pause = buttonWith(renderer, t('pause'))
    expect(pause).toBeDefined()
    await act(async () => {
      pause.props.onClick()
      await Promise.resolve()
    })
    const body = globalThis.fetch.mock.calls
      .map(([, init]) => JSON.parse(init.body))
      .find((entry) => entry.method === 'run.control')
    expect(body.payload).toEqual({ runId: 'run-1', action: 'pause' })
  })

  it('extends a budget-paused run', async () => {
    const paused = run({ status: 'paused-budget' })
    const { renderer } = await mountView(dataWith({ bindings: [binding()], runs: [paused] }))
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.props['aria-expanded'] === false)
        .props.onClick()
    })
    const extend = buttonWith(renderer, t('extend'))
    expect(extend).toBeDefined()
    await act(async () => {
      extend.props.onClick()
      await Promise.resolve()
    })
    const body = globalThis.fetch.mock.calls
      .map(([, init]) => JSON.parse(init.body))
      .find((entry) => entry.method === 'run.control')
    expect(body.payload).toEqual({ runId: 'run-1', action: 'extend' })
  })
})

describe('redelivery gating', () => {
  it('allows a failed review delivery on the awaited round', () => {
    expect(T.canRedeliver(run(), delivery())).toBe(true)
  })

  it('refuses a delivery from an older round or a terminal run', () => {
    expect(T.canRedeliver(run(), delivery({ round: 1 }))).toBe(false)
    expect(T.canRedeliver(run({ status: 'completed' }), delivery())).toBe(false)
  })
})
