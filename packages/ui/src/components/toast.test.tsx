// @vitest-environment jsdom
/**
 * Config-status toast tests: the real Base UI Toast in jsdom, a stubbed status
 * route, and the behaviours the host relies on — one shared viewport across
 * plugin bundles, no repeat within one connection generation, and a fresh
 * announcement after the user dismisses and the DSH connection reconnects.
 */
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigStatusToast, type ConfigInstanceStatus, type ConfigStatusPayload } from './toast'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub })
Object.assign(window, { ResizeObserver: ResizeObserverStub })
window.matchMedia = (() => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
})) as unknown as typeof window.matchMedia
Element.prototype.scrollIntoView = () => {}

const originalFetch = globalThis.fetch
const routes = new Map<string, ConfigInstanceStatus[]>()
let generationId: number | undefined = 1
const generationListeners = new Set<() => void>()

function connection() {
  return {
    generation: {
      getSnapshot: () => (generationId === undefined ? undefined : { id: generationId }),
      subscribe(listener: () => void) {
        generationListeners.add(listener)
        return () => {
          generationListeners.delete(listener)
        }
      },
    },
  }
}

function notifyGeneration(): void {
  for (const listener of generationListeners) listener()
}

function disconnect(): void {
  generationId = undefined
  notifyGeneration()
}

function reconnect(): void {
  generationId = (generationId ?? 0) + 1
  notifyGeneration()
}

let holdFetch = false
let releaseFetch: (() => void) | undefined

function mockFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (holdFetch) {
      holdFetch = false
      await new Promise<void>((settle) => {
        releaseFetch = settle
      })
    }
    const payload: ConfigStatusPayload = { instances: routes.get(url) ?? [] }
    return { ok: true, json: async () => payload }
  }) as unknown as typeof fetch
}

function releasePendingFetch(): void {
  releaseFetch?.()
  releaseFetch = undefined
}

function invalid(overrides: Partial<ConfigInstanceStatus> = {}): ConfigInstanceStatus {
  return {
    id: 1,
    title: 'crew 委派路由',
    file: '/home/user/.dsh/crew.yaml',
    state: 'invalid',
    error: 'config.routes.execute.desc: expected a non-empty string',
    revision: 2,
    recovery: 'auto',
    ...overrides,
  }
}

function valid(overrides: Partial<ConfigInstanceStatus> = {}): ConfigInstanceStatus {
  return {
    id: 1,
    title: 'crew 委派路由',
    file: '/home/user/.dsh/crew.yaml',
    state: 'valid',
    revision: 3,
    recovery: 'auto',
    ...overrides,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((settle) => {
      setTimeout(settle, 20)
    })
  })
}

async function render(children: ReactNode): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(children)
  })
  await flush()
}

async function refresh(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await flush()
}

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = undefined as never
  }
  container?.remove()
  globalThis.fetch = originalFetch
  routes.clear()
  generationListeners.clear()
  generationId = 1
  holdFetch = false
  releaseFetch = undefined
})

describe('ConfigStatusToast', () => {
  it('shows a current error on mount without touching the page body', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    mockFetch()
    const bodyChildren = document.body.children.length
    await render(<ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />)

    expect(container.textContent).toContain('crew 委派路由 配置错误')
    expect(container.textContent).toContain('expected a non-empty string')
    expect(container.textContent).toContain('/home/user/.dsh/crew.yaml')
    expect(container.textContent).toContain('自动恢复')
    expect(container.querySelectorAll('[data-config-toast-viewport]')).toHaveLength(1)
    expect(document.body.children.length).toBe(bodyChildren + 1)
  })

  it('shows nothing while the configuration is valid', async () => {
    routes.set('/dsh-crew/config-status', [valid()])
    mockFetch()
    await render(<ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />)
    expect(container.textContent).toBe('')
  })

  it('replaces the error with one recovery notice', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    mockFetch()
    await render(<ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />)
    expect(container.textContent).toContain('配置错误')

    routes.set('/dsh-crew/config-status', [valid()])
    await refresh()

    expect(container.textContent).not.toContain('配置错误')
    expect(container.textContent).toContain('crew 委派路由 配置已恢复')
    expect(container.textContent).toContain('新的操作已可用')
  })

  it('renders two plugins in one shared viewport', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    routes.set('/dsh-more-providers/config-status', [
      invalid({
        id: 2,
        title: 'more-providers',
        file: '/home/user/.dsh/more-providers.yaml',
        error: 'providers.x: unknown key "wrong"',
        recovery: 'restart',
      }),
    ])
    mockFetch()
    await render(
      <>
        <ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />
        <ConfigStatusToast statusUrl="/dsh-more-providers/config-status" pollMs={60_000} />
      </>,
    )

    expect(container.querySelectorAll('[data-config-toast-viewport]')).toHaveLength(1)
    expect(container.textContent).toContain('crew 委派路由 配置错误')
    expect(container.textContent).toContain('more-providers 配置错误')
    expect(container.textContent).toContain('修好后需重启 dsh')
  })

  it('recovers after a dismissed error and reports a later recurrence', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    mockFetch()
    await render(<ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />)

    const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')
    await act(async () => {
      close?.click()
    })
    await flush()
    expect(container.textContent).not.toContain('配置错误')

    routes.set('/dsh-crew/config-status', [valid()])
    await refresh()
    expect(container.textContent).toContain('crew 委派路由 配置已恢复')

    // The same error recurring after a genuine recovery is a new failure and
    // must surface again.
    routes.set('/dsh-crew/config-status', [invalid()])
    await refresh()
    expect(container.textContent).toContain('crew 委派路由 配置错误')
  })

  it('reports recovery only when every instance of one file is valid', async () => {
    routes.set('/dsh-crew/config-status', [invalid({ id: 1 }), valid({ id: 2, revision: 3 })])
    mockFetch()
    await render(<ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />)
    expect(container.textContent).toContain('配置错误')

    // One generation becomes valid while another still reports the file as
    // broken: the file is not recovered yet.
    routes.set('/dsh-crew/config-status', [invalid({ id: 1 }), valid({ id: 2, revision: 4 })])
    await refresh()
    expect(container.textContent).not.toContain('配置已恢复')

    routes.set('/dsh-crew/config-status', [valid({ id: 1 }), valid({ id: 2 })])
    await refresh()
    expect(container.textContent).toContain('crew 委派路由 配置已恢复')
  })

  it('updates the message instead of reporting recovery when the error changes', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    mockFetch()
    await render(<ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />)
    expect(container.textContent).toContain('expected a non-empty string')

    routes.set('/dsh-crew/config-status', [
      invalid({ error: 'config.routes.review: unknown key "fallback"', revision: 3 }),
    ])
    await refresh()

    expect(container.textContent).toContain('unknown key "fallback"')
    expect(container.textContent).not.toContain('配置已恢复')
  })

  it('does not report recovery when the plugin unloads its status group', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    mockFetch()
    await render(<ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />)
    expect(container.textContent).toContain('配置错误')

    // No instances means the plugin host unloaded, not that the file is fixed.
    routes.set('/dsh-crew/config-status', [])
    await refresh()
    expect(container.textContent).not.toContain('配置错误')
    expect(container.textContent).not.toContain('配置已恢复')
  })

  it('does not reopen a dismissed error when the connection drops', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    mockFetch()
    await render(
      <ConfigStatusToast
        statusUrl="/dsh-crew/config-status"
        pollMs={60_000}
        connection={connection()}
      />,
    )
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')
    await act(async () => {
      close?.click()
    })
    await flush()
    expect(container.textContent).not.toContain('配置错误')

    disconnect()
    await flush()
    expect(container.textContent).not.toContain('配置错误')
  })

  it('does not replay a cached error before the fresh status arrives', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    mockFetch()
    await render(
      <ConfigStatusToast
        statusUrl="/dsh-crew/config-status"
        pollMs={60_000}
        connection={connection()}
      />,
    )
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')
    await act(async () => {
      close?.click()
    })
    await flush()
    expect(container.textContent).not.toContain('配置错误')

    // The Host fixed the file while the page was disconnected; the reconnect
    // poll is still in flight.
    routes.set('/dsh-crew/config-status', [valid()])
    holdFetch = true
    reconnect()
    await flush()
    expect(container.textContent).not.toContain('配置错误')

    releasePendingFetch()
    await flush()
    expect(container.textContent).not.toContain('配置错误')
    expect(container.textContent).toContain('crew 委派路由 配置已恢复')
  })

  it('keeps a dismissed error hidden in one generation and returns it after reconnect', async () => {
    routes.set('/dsh-crew/config-status', [invalid()])
    mockFetch()
    await render(
      <ConfigStatusToast
        statusUrl="/dsh-crew/config-status"
        pollMs={60_000}
        connection={connection()}
      />,
    )
    expect(container.textContent).toContain('配置错误')

    const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')
    expect(close).not.toBeNull()
    await act(async () => {
      close?.click()
    })
    await flush()
    expect(container.textContent).not.toContain('配置错误')

    // A poll in the same connection generation must not re-open it.
    await refresh()
    expect(container.textContent).not.toContain('配置错误')

    // A new DSH generation re-announces the still-current error.
    await act(async () => {
      reconnect()
    })
    await flush()
    expect(container.textContent).toContain('crew 委派路由 配置错误')
  })

  it('ignores a malformed status payload', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ instances: [{ state: 'invalid' }] }),
    })) as unknown as typeof fetch
    await render(<ConfigStatusToast statusUrl="/dsh-crew/config-status" pollMs={60_000} />)
    expect(container.textContent).toBe('')
  })
})
