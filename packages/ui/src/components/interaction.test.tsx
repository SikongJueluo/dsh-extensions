// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { buttonVariants, Dialog, Root, Select } from '../index'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

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

/** Narrow a lookup the way a failing assertion would, without a test-body branch. */
function requireFound<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`)
  return value
}

let container!: HTMLDivElement
let root!: ReturnType<typeof createRoot>

function setup() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
}

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    root = undefined as never
  }
  container?.remove()
})

function DialogDemo() {
  const [open, setOpen] = useState(false)
  return (
    <Root>
      <button id="open-scope" type="button" onClick={() => setOpen(true)}>
        Open write scope
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Write scope"
        closeLabel="Close"
        footer={<button type="button">Done</button>}
      >
        <p>Extra writable directories</p>
      </Dialog>
    </Root>
  )
}

function GhostSelectDemo() {
  const [value, setValue] = useState('a')
  return (
    <Root>
      <Select
        variant="ghost"
        value={value}
        onValueChange={setValue}
        aria-label="Base"
        options={[
          { value: 'a', label: 'current change' },
          { value: 'b', label: 'main' },
        ]}
      />
    </Root>
  )
}

function SelectDemo() {
  const [value, setValue] = useState('a')
  return (
    <Root>
      <Select
        value={value}
        onValueChange={setValue}
        aria-label="Judge model"
        options={[
          { value: 'a', label: 'Model A' },
          { value: 'b', label: 'Model B' },
        ]}
      />
    </Root>
  )
}

describe('Button', () => {
  it('keeps a visible keyboard focus ring and no outline suppression', () => {
    for (const variant of ['default', 'secondary', 'ghost', 'danger', 'link'] as const) {
      const classes = buttonVariants({ variant })
      expect(classes).toContain('focus-visible:outline-2')
      expect(classes).toContain('focus-visible:outline-brand')
      expect(classes).not.toContain('outline-none')
    }
  })
})

describe('Dialog', () => {
  it('renders in the slot subtree, closes on Escape and returns focus', async () => {
    setup()
    await act(async () => {
      root.render(<DialogDemo />)
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })

    const trigger = requireFound(
      container.querySelector<HTMLButtonElement>('#open-scope'),
      '#open-scope',
    )
    expect(trigger).toBeInstanceOf(HTMLButtonElement)
    trigger.focus()
    await act(async () => {
      trigger.click()
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(container.textContent).toContain('Write scope')
    expect(container.textContent).toContain('Extra writable directories')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(container.textContent).not.toContain('Extra writable directories')
    expect(document.activeElement).toBe(trigger)
  })
})

describe('Select', () => {
  it('renders the ghost variant without boxed chrome', async () => {
    setup()
    await act(async () => {
      root.render(<GhostSelectDemo />)
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    const trigger = requireFound(
      container.querySelector<HTMLButtonElement>('[role="combobox"]'),
      '[role="combobox"]',
    )
    expect(trigger).toBeInstanceOf(HTMLButtonElement)
    expect(trigger.className).toContain('dshx:bg-transparent')
    expect(trigger.className).toContain('dshx:border-0')
    expect(trigger.className).not.toContain('dshx:bg-surface-2')
  })

  it('renders options inside the component subtree and reports the pick', async () => {
    setup()
    await act(async () => {
      root.render(<SelectDemo />)
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })

    const trigger = requireFound(
      container.querySelector<HTMLButtonElement>('[role="combobox"]'),
      '[role="combobox"]',
    )
    expect(trigger).toBeInstanceOf(HTMLButtonElement)
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger.click()
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })

    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox).not.toBeNull()
    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Model A', 'Model B'])
    await act(async () => {
      const second = requireFound(options[1], 'second option')
      expect(second).toBeDefined()
      second.click()
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(trigger.textContent).toContain('Model B')
  })
})

/** Minimal stand-in for the browser top layer, which jsdom does not implement. */
function installTopLayer(): void {
  Object.defineProperty(HTMLElement.prototype, 'showPopover', {
    configurable: true,
    value(this: HTMLElement) {
      this.dataset.open = ''
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'hidePopover', {
    configurable: true,
    value(this: HTMLElement) {
      delete this.dataset.open
    },
  })
}

describe('portal anchor', () => {
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'showPopover')
    Reflect.deleteProperty(HTMLElement.prototype, 'hidePopover')
  })

  it('promotes the anchor while open and releases it when the popup closes', async () => {
    installTopLayer()
    setup()
    await act(async () => {
      root.render(<SelectDemo />)
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    const anchor = requireFound(container.querySelector<HTMLDivElement>('[popover]'), 'anchor')
    expect(anchor.getAttribute('popover')).toBe('manual')
    expect(Object.hasOwn(anchor.dataset, 'open')).toBe(false)
    expect(anchor.style.width).toBe('0px')
    expect(anchor.style.backgroundColor).toBe('transparent')

    const trigger = requireFound(
      container.querySelector<HTMLButtonElement>('[role="combobox"]'),
      '[role="combobox"]',
    )
    await act(async () => {
      trigger.click()
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(Object.hasOwn(anchor.dataset, 'open')).toBe(true)

    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
    await act(async () => {
      requireFound(options[1], 'second option').click()
      await new Promise((resolve) => {
        setTimeout(resolve, 0)
      })
    })
    expect(Object.hasOwn(anchor.dataset, 'open')).toBe(false)
    expect(trigger.textContent).toContain('Model B')
  })
})
