// @vitest-environment jsdom
/**
 * Interaction tests for the worktree option in the DOM. The host Menu owns the
 * list's keyboard walk and focus return, so these exercise the real component
 * rather than asserting class names: a request, an explicit base pick, Escape,
 * and withdrawal all have to go through it.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { WorktreeOption } from '../src/client/worktree-option.tsx'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub })
Object.assign(window, { ResizeObserver: ResizeObserverStub })
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })

let host
let root

afterEach(async () => {
  if (root) await act(async () => root.unmount())
  host?.remove()
  root = undefined
  host = undefined
})

function props(overrides = {}) {
  return {
    kind: 'jj',
    label: 'jj workspace',
    menuLabel: 'Base change or bookmark',
    requested: true,
    usable: true,
    disabled: false,
    baseText: 'current change (@)',
    hint: 'Create a jj workspace from the current change.',
    choices: [
      { value: '@', label: 'current change (@)' },
      { value: 'base-bm', label: 'base-bm' },
    ],
    selected: '@',
    error: '',
    onCheckedChange() {},
    onPick() {},
    ...overrides,
  }
}

async function render(overrides = {}) {
  const picked = []
  const checked = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(WorktreeOption, {
        ...props(overrides),
        onPick: (value) => picked.push(value),
        onCheckedChange: (value) => checked.push(value),
      }),
    )
  })
  return { container: host, picked, checked }
}

function trigger(scope) {
  return scope.querySelector('button[aria-haspopup="menu"]')
}

it('opens the host menu, selects a base, and closes', async () => {
  const { container, picked } = await render()
  const anchor = trigger(container)
  await act(async () => {
    anchor.click()
  })
  expect(anchor.getAttribute('aria-expanded')).toBe('true')
  const list = container.querySelector('[role="menu"]')
  expect(list).not.toBeNull()
  expect(list.className).toContain('max-h-[min(320px,40vh)]!')

  const row = [...container.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === 'base-bm',
  )
  expect(row).toBeDefined()
  await act(async () => {
    row.click()
  })
  expect(picked).toEqual(['base-bm'])
  expect(container.querySelector('[role="menu"]')).toBeNull()
})

it('closes on Escape and returns focus to the trigger', async () => {
  const { container } = await render()
  const anchor = trigger(container)
  anchor.focus()
  await act(async () => {
    anchor.click()
  })
  expect(container.querySelector('[role="menu"]')).not.toBeNull()

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(container.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(anchor)
})

it('keeps a blocked request withdrawable instead of opening a menu', async () => {
  const { container, checked } = await render({ usable: false, hint: 'This session is read-only.' })
  expect(container.querySelector('button[aria-haspopup="menu"]')).toBeNull()
  const current = container.querySelector('button[aria-label]')
  expect(current.getAttribute('aria-label')).toBe('current change (@)')

  const input = container.querySelector('input[type="checkbox"]')
  expect(input.disabled).toBe(false)
  expect(input.checked).toBe(true)
  await act(async () => {
    input.click()
  })
  expect(checked).toEqual([false])
})

it('re-submits the selected base so a failed attempt can be retried', async () => {
  const { container, picked } = await render()
  const anchor = trigger(container)
  await act(async () => {
    anchor.click()
  })
  const row = [...container.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === 'current change (@)',
  )
  expect(row).toBeDefined()
  await act(async () => {
    row.click()
  })
  expect(picked).toEqual(['@'])
  expect(container.querySelector('[role="menu"]')).toBeNull()
})

it('keeps menu content in the slot and removes the host body backing on close', async () => {
  const { container } = await render()
  const anchor = trigger(container)
  await act(async () => {
    anchor.click()
  })
  const backing = document.querySelector('[data-menu-backing]')
  expect(backing).not.toBeNull()
  expect(backing.getAttribute('aria-hidden')).toBe('true')
  expect(backing.parentElement).toBe(document.body)
  // The menu itself stays in the slot subtree, not under the body.
  const menu = container.querySelector('[role="menu"]')
  expect(menu).not.toBeNull()
  expect(container.contains(menu)).toBe(true)

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  expect(document.querySelector('[data-menu-backing]')).toBeNull()

  // Unmounting while open must remove the backing too.
  await act(async () => {
    anchor.click()
  })
  expect(document.querySelector('[data-menu-backing]')).not.toBeNull()
  await act(async () => {
    root.unmount()
  })
  root = undefined
  expect(document.querySelector('[data-menu-backing]')).toBeNull()
})

it('surfaces a failed request as an alert next to the control', async () => {
  const { container } = await render({ error: 'Workspace request failed: the pool is busy' })
  const alert = container.querySelector('[role="alert"]')
  expect(alert).not.toBeNull()
  expect(alert.textContent).toBe('Workspace request failed: the pool is busy')
  expect(alert.getAttribute('title')).toBe('Workspace request failed: the pool is busy')
})

it('disables the checkbox while a request is in flight but keeps the branch tip readable', async () => {
  const { container } = await render({ requested: false, disabled: true })
  expect(container.querySelector('input').disabled).toBe(true)
  // The stock control keeps the current-branch button focusable so its full
  // name and tip stay reachable while creation runs.
  expect(container.querySelector('button[aria-label]').disabled).toBe(false)
})
