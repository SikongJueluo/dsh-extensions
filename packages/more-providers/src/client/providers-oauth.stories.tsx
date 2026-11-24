/**
 * Storybook fixtures for the OAuth card: signed in, signed out, and a failed sign-in refresh.
 * @module dsh-more-providers/client/providers-oauth.stories
 */
import type { Meta, StoryObj } from '@storybook/react-vite'
import { OAuthCardView, type OAuthCardStatus } from './providers'
import { en, translator } from './messages'
import type { SnapshotModels } from './snapshot'

const t = translator(en)

function Card({
  status,
  signedIn,
  models,
}: {
  status: OAuthCardStatus
  signedIn: boolean
  models?: SnapshotModels
}) {
  return (
    <div className="dshx:w-[680px] dshx:max-w-full">
      <OAuthCardView
        provider={{ id: 'chatgpt', label: 'ChatGPT (OpenAI)' }}
        signedIn={signedIn}
        status={status}
        models={models}
        busy={false}
        t={t}
        onSignIn={() => {}}
        onSignOut={() => {}}
        onRefresh={() => {}}
      />
    </div>
  )
}

const meta = {
  title: 'more-providers/OAuth card',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const SignedIn: Story = {
  render: () => (
    <Card
      signedIn
      status={{ kind: 'ok' }}
      models={{ discovered: 9, effective: 8, excluded: ['gpt-5-mini'], notIncluded: [] }}
    />
  ),
}

export const SignedOut: Story = {
  render: () => <Card signedIn={false} status={{ kind: 'yellow', key: 'statusNotSignedIn' }} />,
}

export const EmptyCatalog: Story = {
  render: () => (
    <Card
      signedIn
      status={{ kind: 'ok' }}
      models={{ discovered: 4, effective: 0, excluded: ['a', 'b'], notIncluded: ['c'] }}
    />
  ),
}

export const CatalogFailed: Story = {
  render: () => (
    <Card
      signedIn
      status={{
        kind: 'red',
        key: 'statusRefreshFailed',
        params: { detail: 'invalid_refresh_token' },
      }}
    />
  ),
}
