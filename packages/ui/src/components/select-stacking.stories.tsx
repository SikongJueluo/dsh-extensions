/**
 * Harness for popups inside a modal-like host surface: a fixed high-z-index overlay whose content
 * root is either plain or transformed.
 * @module dsh-extensions/ui/components/select-stacking.stories
 */
import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './button'
import { Dialog } from './dialog'
import { Field } from './field'
import { Select } from './select'

const meta = {
  title: 'UI/Select stacking',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const OPTIONS = [
  { value: 'a', label: 'Model A' },
  { value: 'b', label: 'Model B' },
  { value: 'c', label: 'Model C' },
  { value: 'd', label: 'Model D' },
  { value: 'e', label: 'Model E' },
  { value: 'f', label: 'Model F' },
]

function HostModal({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.55)',
        }}
      />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: 'min(560px, 100%)',
          maxHeight: '78vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 14,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-2)',
        }}
      >
        <div style={{ overflowY: 'auto', padding: 16 }}>{children}</div>
      </div>
    </div>
  )
}

function DialogLauncher() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button id="open-nested-dialog" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Open nested dialog
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Nested dialog" closeLabel="Close">
        <p>Dialog body inside the same host surface.</p>
      </Dialog>
    </>
  )
}

function Form({ transform }: { transform: boolean }) {
  const [judge, setJudge] = useState('a')
  const [effort, setEffort] = useState('b')
  return (
    <div
      className="dshx:flex dshx:flex-col dshx:gap-3"
      style={transform ? { transform: 'translateZ(0)' } : undefined}
    >
      <p className="dshx:text-xs dshx:text-fg-muted">
        A judge model checks risky commands before the approval dialog.
      </p>
      <Field label="Judge model">
        <Select value={judge} onValueChange={setJudge} aria-label="Judge model" options={OPTIONS} />
      </Field>
      <Field label="Reasoning effort">
        <Select
          value={effort}
          onValueChange={setEffort}
          aria-label="Reasoning effort"
          options={OPTIONS}
        />
      </Field>
      <div className="dshx:rounded-control dshx:border dshx:border-border dshx:bg-surface dshx:p-3 dshx:text-xs dshx:text-fg-muted">
        Following card content that must not cover the popup.
      </div>
      <DialogLauncher />
    </div>
  )
}

export const InModal: Story = {
  render: () => (
    <HostModal>
      <Form transform={false} />
    </HostModal>
  ),
}

export const InTransformedPanel: Story = {
  render: () => (
    <HostModal>
      <Form transform />
    </HostModal>
  ),
}
