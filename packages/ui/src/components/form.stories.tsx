import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button, Field, Input, Root, Select, Switch } from '../index'

const meta = {
  title: 'UI/Form controls',
  decorators: [
    (Story) => (
      <Root className="dshx:max-w-[440px]">
        <Story />
      </Root>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj

function FormDemo() {
  const [enabled, setEnabled] = useState(true)
  const [model, setModel] = useState('deepseek/deepseek-chat')
  const [base, setBase] = useState('@')
  return (
    <div className="dshx:flex dshx:flex-col dshx:gap-4">
      <div className="dshx:flex dshx:items-center dshx:gap-2">
        <span className="dshx:text-xs dshx:text-fg">Base</span>
        <Select
          variant="ghost"
          value={base}
          onValueChange={setBase}
          aria-label="Base"
          options={[
            { value: '@', label: 'current change (@)' },
            { value: 'main', label: 'main' },
          ]}
        />
      </div>
      <Field label="Judge model" hint="The judge never follows the session model.">
        <Select
          value={model}
          onValueChange={setModel}
          options={[
            { value: 'deepseek/deepseek-chat', label: 'deepseek-chat' },
            { value: 'deepseek/deepseek-reasoner', label: 'deepseek-reasoner (reasoning)' },
          ]}
        />
      </Field>
      <Field label="Working directory" error="The path must be an existing directory.">
        <Input defaultValue="/home/user/projects/not-a-directory" />
      </Field>
      <Field label="Display name" hint="Shown in the session header.">
        <Input placeholder="Session name" disabled />
      </Field>
      <div className="dshx:flex dshx:items-center dshx:justify-between dshx:gap-3">
        <span className="dshx:text-xs dshx:font-medium dshx:text-fg">Enabled</span>
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enabled" />
      </div>
      <div className="dshx:flex dshx:flex-wrap dshx:gap-2">
        <Button variant="default">Save</Button>
        <Button variant="secondary">Cancel</Button>
      </div>
    </div>
  )
}

export const Default: Story = { render: () => <FormDemo /> }
