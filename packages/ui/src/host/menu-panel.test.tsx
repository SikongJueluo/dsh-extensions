// @vitest-environment jsdom
import { act, createRef, type ReactElement, type RefObject } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MenuPanel } from './menu-panel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** Narrow a lookup the way a failing assertion would, without a test-body branch. */
function requireFound<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`)
  return value
}

let container!: HTMLDivElement
let root!: ReturnType<typeof createRoot>

function setup(element: ReactElement) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(element))
}

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = undefined as never
  }
  container?.remove()
})

function PanelDemo({ anchor, open }: { anchor: RefObject<HTMLButtonElement>; open: boolean }) {
  return (
    <>
      <button ref={anchor} type="button">
        Write scope
      </button>
      {open ? (
        <MenuPanel anchor={anchor} header={<span>Writable workspaces</span>}>
          <button type="button" role="menuitemcheckbox" aria-checked="true">
            /tmp/a
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked="false">
            /tmp/b
          </button>
        </MenuPanel>
      ) : null}
    </>
  )
}

describe('MenuPanel', () => {
  it('anchors the surface to its trigger and keeps rows inside a scrolling viewport', () => {
    const anchor = createRef<HTMLButtonElement>()
    setup(<PanelDemo anchor={anchor} open />)
    const trigger = requireFound(anchor.current, 'trigger')
    const name = trigger.style.getPropertyValue('anchor-name')
    expect(name.startsWith('--dshx-menu-')).toBe(true)

    const panel = requireFound(document.querySelector<HTMLElement>('.dshx-menu-panel'), 'panel')
    expect(panel.style.getPropertyValue('position-anchor')).toBe(name)

    const viewport = requireFound(
      panel.querySelector<HTMLElement>('.dshx-menu-panel-viewport'),
      'viewport',
    )
    expect(viewport.querySelectorAll('[role="menuitemcheckbox"]').length).toBe(2)
    expect(viewport.contains(panel.querySelector('.dshx-menu-panel-header'))).toBe(false)
  })

  it('restores a prior anchor name when the panel unmounts', async () => {
    const anchor = createRef<HTMLButtonElement>()
    setup(<PanelDemo anchor={anchor} open={false} />)
    const trigger = requireFound(anchor.current, 'trigger')
    trigger.style.setProperty('anchor-name', '--preexisting')
    await act(async () => root.render(<PanelDemo anchor={anchor} open />))
    expect(trigger.style.getPropertyValue('anchor-name')).not.toBe('--preexisting')
    await act(async () => root.render(<PanelDemo anchor={anchor} open={false} />))
    expect(trigger.style.getPropertyValue('anchor-name')).toBe('--preexisting')
  })
})
