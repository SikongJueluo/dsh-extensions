import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'

// Regression for the real Client dependency contract: this file mounts the
// shipped client module on a real Cordis context. The Forge Remote namespace
// (`remote.forgePanel`) is a Cordis service, not a plain property of `remote`;
// the plugin must wait for it before registering the replacement worktree
// control, which the plain-object mocks in client.test.mjs cannot enforce.
globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { apply as applyClient, inject as clientInject } from '../src/client/index.tsx'
const client = { apply: applyClient, inject: clientInject }

const PANEL = {
  directory: '/fixture',
  checkout: { state: 'none' },
  worktree: {
    editable: true,
    blocker: 'not-git',
    request: null,
    created: null,
    creation: null,
  },
}

class RemoteService extends Service {
  constructor(ctx) {
    super(ctx, 'remote')
  }
}

class ForgePanelService extends Service {
  constructor(ctx) {
    super(ctx, 'remote.forgePanel')
  }

  follow() {
    return (async function* () {
      yield PANEL
    })()
  }

  branches() {
    return Promise.resolve({ ok: true, value: { current: 'main', branches: [] } })
  }

  requestWorktree() {
    return Promise.resolve({ ok: true })
  }

  cancelWorktree() {
    return Promise.resolve({ ok: true })
  }
}

class SlotsService extends Service {
  constructor(ctx) {
    super(ctx, 'slots')
    this.entries = []
  }

  // Mirror the real registry: the controller belongs to the caller's fiber.
  inject(_key, callback) {
    const dispose = this.ctx.effect(callback, 'test slots.inject')
    return () => dispose()
  }

  register(options, component) {
    const entry = { options, component }
    this.entries.push(entry)
    return () => {
      this.entries = this.entries.filter((candidate) => candidate !== entry)
    }
  }
}

class LocaleService extends Service {
  constructor(ctx) {
    super(ctx, 'locale')
  }

  register() {
    return () => {}
  }

  bind() {
    return (key) => key
  }
}

const tick = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 10)
  })
const originalFetch = globalThis.fetch
let statusCalls

beforeEach(() => {
  statusCalls = 0
  globalThis.fetch = async () => {
    statusCalls += 1
    return new Response(
      JSON.stringify({
        type: 'server-response',
        result: { ok: true, value: { kind: 'jj', blocker: null, bookmarks: [] } },
      }),
      { headers: { 'content-type': 'application/json' } },
    )
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function mount({ withForge }) {
  const root = new Context()
  const handles = []
  let forgeHandle
  const register = async (plugin) => {
    const handle = root.plugin(plugin)
    await handle
    handles.push(handle)
    return handle
  }

  await register(RemoteService)
  await register(SlotsService)
  await register(LocaleService)
  if (withForge) forgeHandle = await register(ForgePanelService)

  await register({ name: 'dsh-jj-workspace', inject: client.inject, apply: client.apply })
  await tick()

  const slots = root.get('slots')
  const forgeEntry = () =>
    slots.entries.find((entry) => entry.options.id === 'forge-panel.worktree')
  const taskEntry = () => slots.entries.find((entry) => entry.options.id === 'jj-workspace.task')

  return {
    forgeEntry,
    taskEntry,
    async mountForge() {
      if (forgeHandle) return
      forgeHandle = await register(ForgePanelService)
      await tick()
    },
    async unmountForge() {
      if (!forgeHandle) return
      const handle = forgeHandle
      forgeHandle = undefined
      handles.splice(handles.indexOf(handle), 1)
      await handle.dispose()
      await tick()
    },
    async cleanup() {
      for (const handle of handles.reverse()) await handle.dispose()
    },
  }
}

describe('real Client dependency contract', () => {
  it('registers the worktree control only once the Forge namespace is mounted', async () => {
    const app = await mount({ withForge: false })
    try {
      expect(app.forgeEntry()).toBeUndefined()
      expect(app.taskEntry()).toBeDefined()

      await app.mountForge()
      expect(app.forgeEntry()).toBeDefined()
    } finally {
      await app.cleanup()
    }
  })

  it('withdraws the worktree control when the Forge namespace is unmounted', async () => {
    const app = await mount({ withForge: true })
    try {
      expect(app.forgeEntry()).toBeDefined()

      await app.unmountForge()
      expect(app.forgeEntry()).toBeUndefined()
      expect(app.taskEntry()).toBeDefined()
    } finally {
      await app.cleanup()
    }
  })

  it('follows the Forge panel and asks for status with the real context', async () => {
    const app = await mount({ withForge: true })
    let renderer
    try {
      const entry = app.forgeEntry()
      expect(entry).toBeDefined()
      const props = {
        ...entry.options.inject('fixture-session'),
        sessionId: 'fixture-session',
        useProjection: () => undefined,
      }
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(entry.component, props))
        await tick()
      })
      expect(statusCalls).toBe(1)
      expect(renderer.toJSON()).not.toBeNull()
      expect(renderer.root.findByType('input')).toBeDefined()
    } finally {
      if (renderer) await act(async () => renderer.unmount())
      await app.cleanup()
    }
  })
})
