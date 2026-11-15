import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorktreeOption } from './worktree-option'

/**
 * The new-session worktree option in its host states. The `Hero*` stories
 * reproduce the stock hero: the control sits in a vertically centred composer
 * inside the conversation scroll container, which is the layout the in-place
 * menu has to survive.
 */
const meta = {
  title: 'jj-workspace/Worktree option',
  component: WorktreeOption,
  parameters: { layout: 'centered' },
  args: {
    kind: 'jj',
    label: 'jj workspace',
    menuLabel: 'Base change or bookmark',
    requested: false,
    usable: true,
    disabled: false,
    baseText: 'current change (@)',
    hint: 'Create a jj workspace from the current change and enter it for this session.',
    choices: [
      { value: '@', label: 'current change (@)' },
      { value: 'base-bm', label: 'base-bm' },
      { value: 'feature/worktree-ui', label: 'feature/worktree-ui' },
    ],
    selected: '@',
    error: '',
    onCheckedChange() {},
    onPick() {},
  },
} satisfies Meta<typeof WorktreeOption>

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {}

export const Requested: Story = {
  args: {
    requested: true,
    baseText: 'current change (@)',
  },
}

export const GitCurrentBranch: Story = {
  args: {
    kind: 'git',
    label: 'worktree',
    menuLabel: 'Base branch',
    requested: true,
    baseText: 'main',
    hint: 'Create a Git worktree from the selected branch and enter it for this session.',
    choices: [
      { value: 'main', label: 'main', note: 'current' },
      { value: 'release/2026-11', label: 'release/2026-11' },
    ],
    selected: 'main',
  },
}

export const LongBookmark: Story = {
  args: {
    requested: true,
    baseText: 'feature/a-very-long-bookmark-name-that-has-to-truncate',
    choices: [
      { value: '@', label: 'current change (@)' },
      {
        value: 'feature/a-very-long-bookmark-name-that-has-to-truncate',
        label: 'feature/a-very-long-bookmark-name-that-has-to-truncate',
      },
      { value: 'release-2026-11', label: 'release-2026-11' },
    ],
    selected: 'feature/a-very-long-bookmark-name-that-has-to-truncate',
  },
}

export const BlockedReadOnly: Story = {
  args: {
    requested: true,
    usable: false,
    baseText: 'base-bm',
    hint: 'This session is read-only.',
  },
}

export const RequestError: Story = {
  args: {
    requested: false,
    error: 'Workspace request failed: the pool is busy',
    hint: 'Workspace request failed: the pool is busy',
  },
}

export const Pending: Story = {
  args: {
    requested: false,
    disabled: true,
    hint: 'The workspace is created before the first message.',
  },
}

const heroRender: Story['render'] = (args) => (
  <div
    data-hero-frame=""
    style={{
      width: 'min(920px, 94vw)',
      height: '90vh',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 12,
    }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px 0 20px',
        marginTop: 4,
      }}
    >
      <span style={{ height: 32, flex: 1 }} />
      <WorktreeOption {...args} />
    </div>
  </div>
)

const manyChoices = Array.from({ length: 20 }, (_, index) => ({
  value: `bookmark-${String(index)}`,
  label: `feature/bookmark-${String(index)}-with-a-long-name`,
}))

const manyArgs = {
  requested: true,
  baseText: 'feature/bookmark-0-with-a-long-name',
  selected: 'feature/bookmark-0-with-a-long-name',
  choices: [{ value: '@', label: 'current change (@)' }, ...manyChoices],
}

export const HeroFrame: Story = {
  render: heroRender,
  args: { requested: true, baseText: 'base-bm' },
}

export const HeroManyBookmarks: Story = {
  render: heroRender,
  args: manyArgs,
}
