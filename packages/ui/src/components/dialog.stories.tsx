import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button, Dialog, Field, Input, Root } from '../index'

const meta = {
  title: 'UI/Dialog',
  decorators: [
    (Story) => (
      <Root>
        <Story />
      </Root>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj

function DialogDemo({ long = false }: { long?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        Open write scope
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Write scope"
        description="Extra writable directories shared by this session and its local subagents."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="default" onClick={() => setOpen(false)}>
              Add directory
            </Button>
          </>
        }
      >
        <div className="dshx:flex dshx:flex-col dshx:gap-3">
          <Field label="Directory" hint="Absolute path of an existing directory.">
            <Input placeholder="/home/user/shared" />
          </Field>
          {long ? (
            <div className="dshx:flex dshx:flex-col dshx:gap-2">
              {Array.from({ length: 20 }, (_, index) => (
                <p key={index} className="dshx:text-xs dshx:text-fg-muted">
                  Long content row {index + 1}: this body scrolls inside the dialog instead of
                  growing past the viewport, and the footer stays reachable.
                </p>
              ))}
            </div>
          ) : (
            <p className="dshx:text-xs dshx:text-fg-muted">
              The workspace above is writable. Grants apply to new calls; already running shells
              keep the permissions they started with.
            </p>
          )}
        </div>
      </Dialog>
    </>
  )
}

export const Default: Story = { render: () => <DialogDemo /> }
export const LongContent: Story = { render: () => <DialogDemo long /> }
