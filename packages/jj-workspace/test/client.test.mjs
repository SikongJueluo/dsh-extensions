import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The browser module registers through the page loader; this harness keeps the
// real component, effects, and Forge Remote calls, and replaces only the page
// services around them. Panel frames are queued so tests can drive several
// directory/permission states through the real stream effect.
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let factory
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      factory = definition.factory
    },
  },
}
await import('../client/client.js')
const client = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected module ${name}`)
})

const t = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)
const calls = []
let registrations
let renderers
let panels
let panelWaiters
let statusCalls

function mount() {
  calls.length = 0
  registrations = {}
  panels = []
  panelWaiters = []
  statusCalls = 0
  let slot = ''
  const ctx = {
    effect(fn) {
      fn()
      return () => {}
    },
    locale: {
      register() {},
      bind() {
        return t
      },
    },
    slots: {
      inject(name, callback) {
        slot = name
        registrations[name] = {}
        registrations[name].value = callback()
        return () => {}
      },
      register(options, component) {
        registrations[slot] = { ...registrations[slot], options, component }
        return () => {}
      },
    },
    remote: {
      forgePanel: {
        follow(_sessionId, signal) {
          return (async function* () {
            while (true) {
              if (signal.aborted) return
              if (panels.length > 0) {
                yield panels.shift()
                continue
              }
              await new Promise((resolve) => {
                const wake = () => resolve()
                panelWaiters.push(wake)
                signal.addEventListener('abort', wake, { once: true })
              })
            }
          })()
        },
        branches() {
          return Promise.resolve({ ok: true, value: { current: 'main', branches: ['main', 'other'] } })
        },
        requestWorktree(sessionId, from) {
          calls.push(['request', sessionId, from])
          return Promise.resolve({ ok: true })
        },
        cancelWorktree(sessionId) {
          calls.push(['cancel', sessionId])
          return Promise.resolve({ ok: true })
        },
      },
    },
  }
  client.apply(ctx)
}

function pushPanel(panel) {
  panels.push(panel)
  const waiters = panelWaiters
  panelWaiters = []
  for (const wake of waiters) wake()
}

async function flush() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

function jjPanel(worktree = {}) {
  return {
    directory: '/project',
    checkout: { state: 'none' },
    worktree: {
      editable: true,
      blocker: 'not-git',
      request: null,
      created: null,
      creation: null,
      ...worktree,
    },
  }
}

function gitPanel(worktree = {}) {
  return {
    directory: '/repo',
    checkout: { state: 'ready', checkout: { branch: 'main', commit: 'abc1234' } },
    worktree: {
      editable: true,
      blocker: null,
      request: null,
      created: null,
      creation: null,
      ...worktree,
    },
  }
}

function toggleProps({ status, override = {} }) {
  const registration = registrations['conversation.hero.options']
  const face = registration.options.inject('session-1')
  return {
    ...face,
    sessionId: 'session-1',
    useProjection: () => undefined,
    status: (...args) => {
      statusCalls += 1
      return status(...args)
    },
    ...override,
  }
}

async function renderToggle({ panel, status, override = {} }) {
  pushPanel(panel)
  const registration = registrations['conversation.hero.options']
  const props = toggleProps({ status, override })
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(registration.component, props))
    await flush()
  })
  renderers.push(renderer)
  return renderer
}

async function renderTask(tasks) {
  const registration = registrations['conversation.session.header.utilities']
  const face = registration.options.inject('session-1')
  let renderer
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(registration.component, {
        ...face,
        sessionId: 'session-1',
        tasks: () => Promise.resolve({ tasks }),
      }),
    )
    await flush()
  })
  renderers.push(renderer)
  return renderer
}

beforeEach(() => {
  renderers = []
  mount()
})

afterEach(async () => {
  for (const renderer of renderers) {
    await act(async () => {
      renderer.unmount()
    })
  }
  vi.useRealTimers()
})

describe('new-session worktree control', () => {
  it('requests the current change for a colocated jj project, not the Git branch', async () => {
    const renderer = await renderToggle({
      panel: jjPanel(),
      status: () => Promise.resolve({ kind: 'jj', hasGit: true, blocker: null, bookmarks: ['main'] }),
    })
    const input = renderer.root.findByType('input')
    expect(input.props.disabled).toBe(false)
    await act(async () => {
      input.props.onChange({ currentTarget: { checked: true } })
      await flush()
    })
    expect(calls).toContainEqual(['request', 'session-1', null])
  })

  it('passes an explicitly selected bookmark as the base', async () => {
    const renderer = await renderToggle({
      panel: jjPanel({ request: { from: null } }),
      status: () => Promise.resolve({ kind: 'jj', hasGit: false, blocker: null, bookmarks: ['base-bm'] }),
    })
    const select = renderer.root.findByType('select')
    expect(select.props.value).toBe('@')
    expect(select.findAllByType('option').map((option) => option.props.value)).toEqual(['@', 'base-bm'])
    await act(async () => {
      select.props.onChange({ currentTarget: { value: 'base-bm' } })
      await flush()
    })
    expect(calls).toContainEqual(['request', 'session-1', 'base-bm'])
  })

  it('keeps the stock Git default branch for a Git checkout', async () => {
    const renderer = await renderToggle({
      panel: gitPanel(),
      status: () => Promise.resolve({ kind: 'git', root: '/repo' }),
    })
    const input = renderer.root.findByType('input')
    await act(async () => {
      input.props.onChange({ currentTarget: { checked: true } })
      await flush()
    })
    expect(calls).toContainEqual(['request', 'session-1', 'main'])
  })

  it('offers and sends an explicit Git base branch', async () => {
    const renderer = await renderToggle({
      panel: gitPanel({ request: { from: 'main' } }),
      status: () => Promise.resolve({ kind: 'git', root: '/repo' }),
    })
    await act(async () => {
      await flush()
    })
    const select = renderer.root.findByType('select')
    expect(select.findAllByType('option').map((option) => option.props.value)).toEqual(['main', 'other'])
    await act(async () => {
      select.props.onChange({ currentTarget: { value: 'other' } })
      await flush()
    })
    expect(calls).toContainEqual(['request', 'session-1', 'other'])
  })

  it('rediscovers a read-only status after the permission becomes writable', async () => {
    let permission = { currentValue: 'read-only' }
    const useProjection = () => permission
    const status = () => {
      const blocked = permission.currentValue === 'read-only'
      return Promise.resolve({ kind: 'jj', hasGit: false, blocker: blocked ? 'read-only' : null, bookmarks: [] })
    }
    const props = toggleProps({ status, override: { useProjection } })
    pushPanel(jjPanel())
    const registration = registrations['conversation.hero.options']
    let renderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(registration.component, props))
      await flush()
    })
    renderers.push(renderer)
    expect(renderer.root.findByType('input').props.disabled).toBe(true)
    expect(statusCalls).toBe(1)

    permission = { currentValue: 'workspace-write' }
    const next = toggleProps({ status, override: { useProjection } })
    await act(async () => {
      renderer.update(React.createElement(registration.component, next))
      await flush()
    })
    expect(statusCalls).toBe(2)
    expect(renderer.root.findByType('input').props.disabled).toBe(false)
  })

  it('invalidates a writable status when the permission becomes read-only', async () => {
    let permission = { currentValue: 'workspace-write' }
    const useProjection = () => permission
    const status = () => {
      const blocked = permission.currentValue === 'read-only'
      return Promise.resolve({ kind: 'jj', hasGit: false, blocker: blocked ? 'read-only' : null, bookmarks: [] })
    }
    const props = toggleProps({ status, override: { useProjection } })
    pushPanel(jjPanel())
    const registration = registrations['conversation.hero.options']
    let renderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(registration.component, props))
      await flush()
    })
    renderers.push(renderer)
    expect(renderer.root.findByType('input').props.disabled).toBe(false)

    permission = { currentValue: 'read-only' }
    const next = toggleProps({ status, override: { useProjection } })
    await act(async () => {
      renderer.update(React.createElement(registration.component, next))
      await flush()
    })
    expect(statusCalls).toBe(2)
    expect(renderer.root.findByType('input').props.disabled).toBe(true)
  })

  it('does not use the old VCS semantics while a new directory status is pending', async () => {
    let statusCall = 0
    let resolveGit
    const status = () => {
      statusCall += 1
      if (statusCall === 1) return Promise.resolve({ kind: 'jj', hasGit: false, blocker: null, bookmarks: ['base-bm'] })
      return new Promise((resolve) => {
        resolveGit = resolve
      })
    }
    const renderer = await renderToggle({ panel: jjPanel(), status })
    expect(renderer.root.findByType('input')).toBeDefined()

    pushPanel(gitPanel())
    await act(async () => {
      await flush()
    })
    expect(renderer.toJSON()).toBeNull()
    expect(statusCall).toBe(2)

    await act(async () => {
      resolveGit({ kind: 'git', root: '/repo' })
      await flush()
    })
    const input = renderer.root.findByType('input')
    expect(input.props.disabled).toBe(false)
    await act(async () => {
      input.props.onChange({ currentTarget: { checked: true } })
      await flush()
    })
    expect(calls).toContainEqual(['request', 'session-1', 'main'])
  })

  it('retries a failed initial status instead of hiding the entry forever', async () => {
    vi.useFakeTimers()
    let statusCall = 0
    const status = () => {
      statusCall += 1
      if (statusCall === 1) return Promise.reject(new Error('transient'))
      return Promise.resolve({ kind: 'git', root: '/repo' })
    }
    const registration = registrations['conversation.hero.options']
    pushPanel(gitPanel())
    const props = toggleProps({ status })
    let renderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(registration.component, props))
      await flush()
    })
    renderers.push(renderer)
    expect(renderer.toJSON()).toBeNull()
    expect(statusCall).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
      await flush()
    })
    expect(statusCall).toBe(2)
    expect(renderer.root.findByType('input')).toBeDefined()
  })

  it('disables creation with a clear read-only reason', async () => {
    const blocked = await renderToggle({
      panel: jjPanel(),
      status: () => Promise.resolve({ kind: 'jj', hasGit: false, blocker: 'read-only', bookmarks: [] }),
    })
    const input = blocked.root.findByType('input')
    expect(input.props.disabled).toBe(true)
    expect(blocked.root.findByType('label').props.title).toBe('blockerReadOnly')
  })

  it('allows a requested workspace to be withdrawn while blocked', async () => {
    const requested = await renderToggle({
      panel: jjPanel({ request: { from: null } }),
      status: () => Promise.resolve({ kind: 'jj', hasGit: false, blocker: 'read-only', bookmarks: [] }),
    })
    const checked = requested.root.findByType('input')
    expect(checked.props.disabled).toBe(false)
    await act(async () => {
      checked.props.onChange({ currentTarget: { checked: false } })
      await flush()
    })
    expect(calls).toContainEqual(['cancel', 'session-1'])
  })

  it('disables creation while an attempt is running', async () => {
    const renderer = await renderToggle({
      panel: jjPanel({ creation: { phase: 'prepare', branch: 'dsh-1' } }),
      status: () => Promise.resolve({ kind: 'jj', hasGit: false, blocker: null, bookmarks: [] }),
    })
    expect(renderer.root.findByType('input').props.disabled).toBe(true)
  })

  it('hides once the session can no longer change its worktree', async () => {
    const renderer = await renderToggle({
      panel: jjPanel({ editable: false }),
      status: () => Promise.resolve({ kind: 'jj', hasGit: false, blocker: null, bookmarks: [] }),
    })
    expect(renderer.toJSON()).toBeNull()
  })
})

describe('task pill', () => {
  it('shows a moved bookmark in the original header row', async () => {
    const renderer = await renderTask([
      {
        workspace: 'task',
        state: 'moved',
        path: '/project/.agents/workspaces/task',
        bookmark: 'task',
        changeId: 'old',
        currentChangeId: 'new',
        baseChange: 'base',
      },
    ])
    const pill = renderer.root.findByProps({ className: 'dsh-jjw-task' })
    expect(pill.props['data-state']).toBe('moved')
    expect(pill.props.title).toContain('taskDetail')
    expect(JSON.stringify(renderer.toJSON())).toContain('taskMoved')
  })

  it('renders nothing without a recorded task', async () => {
    const renderer = await renderTask([])
    expect(renderer.toJSON()).toBeNull()
  })
})
