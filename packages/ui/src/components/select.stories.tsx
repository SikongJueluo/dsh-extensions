import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Root, Select } from '../index'

const meta = {
  title: 'UI/Select',
  decorators: [
    (Story) => (
      <Root className="dshx:p-4">
        <Story />
      </Root>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj

function InlineSelector() {
  const [base, setBase] = useState('@')
  return (
    <div className="dshx:flex dshx:min-w-0 dshx:items-center dshx:gap-2 dshx:rounded-[10px] dshx:border dshx:border-border dshx:bg-surface dshx:p-2">
      <span className="dshx:text-sm dshx:text-fg">Base</span>
      <span className="dshx:ml-auto dshx:flex dshx:min-w-0">
        <Select
          variant="ghost"
          align="end"
          className="dshx:max-w-[min(200px,45vw)]"
          value={base}
          onValueChange={setBase}
          aria-label="Base"
          options={[
            { value: '@', label: 'current change (@)' },
            { value: 'main', label: 'main' },
            {
              value: 'feature/a-very-long-branch-name-that-expands-the-popup',
              label: 'feature/a-very-long-branch-name-that-expands-the-popup',
            },
          ]}
        />
      </span>
    </div>
  )
}

export const Inline: Story = { render: () => <InlineSelector /> }
