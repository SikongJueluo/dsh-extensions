// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.matchMedia = () => ({ matches: false })

const React = (await import('react')).default
const act = React.act
const { testHandles: T, apply, inject } = await import('../src/client/index.tsx')

const CATALOG = {
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{ id: 'chat', name: 'Chat' }],
    },
  ],
}

function request(overrides = {}) {
  return {
    id: 'req-1',
    task: '交接任务：修好构建',
    inherited: { provider: 'deepseek', model: 'chat', reasoningEffort: 'high' },
    fallback: { provider: 'deepseek', model: 'chat' },
    defaultChoice: { kind: 'inherit' },
    preset: {
      options: [{ id: 'preset-a', name: 'Preset A' }],
      default: { kind: 'inherit' },
    },
    review: { defaultRounds: 5 },
    origin: { id: 'origin', title: 'origin', path: '/repo' },
    workspaces: [],
    pickWorkspace: false,
    ...overrides,
  }
}

function operations() {
  return {
    pending: vi.fn(async () => ({ requests: [] })),
    choose: vi.fn(async () => ({ ok: true })),
    cancel: vi.fn(async () => ({ ok: true })),
    modelCatalog: vi.fn(async () => ({ ok: true, value: CATALOG })),
  }
}

let container
let root

function textOf(node) {
  return node.textContent ?? ''
}

function buttons() {
  return [...container.querySelectorAll('button')]
}

function buttonWith(text) {
  return buttons().find(
    (button) => button.textContent.includes(text) || button.getAttribute('aria-label') === text,
  )
}

async function renderPicker(ops, req) {
  await act(async () => {
    root = createRoot(container)
    root.render(
      React.createElement(T.Picker, {
        request: req,
        operations: ops,
        onSettled: () => {},
      }),
    )
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container.remove()
})

describe('registration', () => {
  it('keeps the shell.overlay contract and module inject list', () => {
    let registration
    const ctx = {
      effect(effect) {
        effect()
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
    expect(registration.options).toMatchObject({
      name: 'shell.overlay',
      id: 'dsh-handoff-picker',
      order: 50,
    })
    expect(inject).toEqual(['slots', 'remote', 'remote.session'])
  })
})

describe('confirmation card', () => {
  it('shows the task and the inherited model without a wizard step', async () => {
    await renderPicker(operations(), request())
    const text = textOf(container)
    expect(text).toContain('交接任务：修好构建')
    expect(text).toContain('deepseek/chat')
    expect(buttonWith('开始交接')).toBeDefined()
  })

  it('submits the host-resolved default exactly once', async () => {
    const ops = operations()
    await renderPicker(ops, request())
    const submit = buttonWith('开始交接')
    await act(async () => {
      submit.click()
      await Promise.resolve()
    })
    expect(ops.choose).toHaveBeenCalledTimes(1)
    expect(ops.choose).toHaveBeenCalledWith('req-1', {
      kind: 'inherit',
      preset: { kind: 'inherit' },
      review: { enabled: false, rounds: 5 },
    })
  })

  it('blocks submission when the remembered default is stale', async () => {
    const ops = operations()
    await renderPicker(ops, request({ defaultChoiceIssue: '模型已不可用，请重新选择' }))
    const text = textOf(container)
    expect(text).toContain('模型已不可用，请重新选择')
    const submit = buttonWith('开始交接')
    expect(submit.disabled).toBe(true)
    await act(async () => {
      submit.click()
      await Promise.resolve()
    })
    expect(ops.choose).not.toHaveBeenCalled()
  })

  it('filters the model list through the restored search box', async () => {
    await renderPicker(operations(), request())
    await act(async () => {
      buttonWith('更改').click()
      await Promise.resolve()
    })
    const search = container.querySelector('input[placeholder="搜索模型 / 厂商…"]')
    expect(search).not.toBeNull()
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    await act(async () => {
      setValue.call(search, 'zzz')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(textOf(container)).toContain('没有匹配的模型')
    await act(async () => {
      setValue.call(search, 'chat')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(textOf(container)).toContain('Chat')
  })

  it('Escape collapses an open selector before it cancels the card', async () => {
    const ops = operations()
    await renderPicker(ops, request())
    const change = buttonWith('更改')
    expect(change).toBeDefined()
    await act(async () => {
      change.click()
      await Promise.resolve()
    })
    expect(textOf(container)).not.toContain('开始交接')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(ops.cancel).not.toHaveBeenCalled()
    expect(textOf(container)).toContain('开始交接')
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await Promise.resolve()
    })
    expect(ops.cancel).toHaveBeenCalledWith('req-1')
  })

  it('cancels through the host channel', async () => {
    const ops = operations()
    await renderPicker(ops, request())
    const cancel = buttonWith('取消')
    await act(async () => {
      cancel.click()
      await Promise.resolve()
    })
    expect(ops.cancel).toHaveBeenCalledWith('req-1')
  })
})
