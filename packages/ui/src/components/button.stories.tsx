import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button, Root } from '../index'

const meta = {
  title: 'UI/Button',
  component: Button,
  decorators: [
    (Story) => (
      <Root>
        <Story />
      </Root>
    ),
  ],
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Variants: Story = {
  render: () => (
    <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
      <Button variant="default">Save changes</Button>
      <Button variant="secondary">Refresh</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="danger">Revoke</Button>
      <Button variant="link">Open details</Button>
    </div>
  ),
}

export const SizesAndStates: Story = {
  render: () => (
    <div className="dshx:flex dshx:flex-col dshx:gap-3">
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="icon" aria-label="Close">
          ×
        </Button>
      </div>
      <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2">
        <Button disabled>Disabled</Button>
        <Button variant="default" disabled>
          Disabled primary
        </Button>
      </div>
      <Button className="dshx:w-fit">
        A deliberately long button label that wraps only at the container edge
      </Button>
    </div>
  ),
}
