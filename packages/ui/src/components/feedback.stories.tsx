import type { Meta, StoryObj } from '@storybook/react-vite'
import { Alert, Badge, Progress, Root, Spinner } from '../index'

const meta = {
  title: 'UI/Feedback',
  decorators: [
    (Story) => (
      <Root className="dshx:flex dshx:max-w-[520px] dshx:flex-col dshx:gap-4">
        <Story />
      </Root>
    ),
  ],
} satisfies Meta

export default meta
type Story = StoryObj

export const AlertsAndBadges: Story = {
  render: () => (
    <div className="dshx:flex dshx:flex-col dshx:gap-3">
      <Alert>This row is replaced by your overlay declaration.</Alert>
      <Alert variant="success">Session write access granted.</Alert>
      <Alert variant="warn">Quota resets in 12 minutes.</Alert>
      <Alert variant="error">Failed to save: the host rejected the revision.</Alert>
      <div className="dshx:flex dshx:flex-wrap dshx:gap-2">
        <Badge>user</Badge>
        <Badge variant="brand">active</Badge>
        <Badge variant="success">granted</Badge>
        <Badge variant="warn">pending</Badge>
        <Badge variant="danger">denied</Badge>
        <Badge variant="outline">forked</Badge>
      </div>
    </div>
  ),
}

export const ProgressAndLoading: Story = {
  render: () => (
    <div className="dshx:flex dshx:flex-col dshx:gap-4">
      <div className="dshx:flex dshx:flex-col dshx:gap-1">
        <span className="dshx:text-xs dshx:font-semibold">Five-hour window · 42% used</span>
        <Progress value={42} label="Five-hour window" />
      </div>
      <div className="dshx:flex dshx:flex-col dshx:gap-1">
        <span className="dshx:text-xs dshx:font-semibold">Weekly window · 84% used</span>
        <Progress value={84} tone="warn" label="Weekly window" />
      </div>
      <div className="dshx:flex dshx:flex-col dshx:gap-1">
        <span className="dshx:text-xs dshx:font-semibold">Monthly MCP · exhausted</span>
        <Progress value={100} tone="danger" label="Monthly MCP" />
      </div>
      <div className="dshx:flex dshx:flex-col dshx:gap-1">
        <span className="dshx:text-xs dshx:font-semibold">No reset reported</span>
        <Progress value={null} label="Unknown window" />
      </div>
      <div className="dshx:flex dshx:items-center dshx:gap-2 dshx:text-xs dshx:text-fg-muted">
        <Spinner /> Loading quota…
      </div>
    </div>
  ),
}
