/**
 * Storybook fixtures for the provider cards, one story per state a configured route can carry.
 * @module dsh-more-providers/client/providers.stories
 */
import type { Meta, StoryObj } from '@storybook/react-vite'
import { ProvidersSection, SnapshotCards } from './providers'
import { en, translator } from './messages'
import type { SnapshotInstance, SnapshotProvider } from './snapshot'

const t = translator(en)
const now = Date.now()

function instance(providers: SnapshotProvider[]): SnapshotInstance {
  return {
    id: 'more-providers#1',
    file: '/home/you/.dsh/more-providers.yaml',
    state: 'ok',
    revision: 3,
    appliedRevision: 3,
    providers,
  }
}

function Cards({
  providers,
  instances,
}: {
  providers: SnapshotProvider[]
  instances?: SnapshotInstance[]
}) {
  return (
    <div className="dshx:w-[680px] dshx:max-w-full">
      <SnapshotCards
        state={{ status: 'ready', instances: instances ?? [instance(providers)], readAt: now }}
        t={t}
        now={now}
        refetch={{ status: 'idle' }}
        onRetry={() => {}}
      />
    </div>
  )
}

const primary = { id: 'primary', displayName: 'primary', ready: true, healthy: true }

const healthy: SnapshotProvider = {
  route: 'mdkj',
  kind: 'custom',
  auth: 'api-key',
  displayName: 'MDKJ',
  enabled: true,
  registered: true,
  accounts: [primary, { id: 'backup', displayName: 'backup', ready: true }],
  models: { discovered: 14, effective: 12, excluded: ['gpt-4o-mini'], notIncluded: [] },
}

const cooling: SnapshotProvider = {
  ...healthy,
  accounts: [
    primary,
    {
      id: 'backup',
      displayName: 'backup',
      ready: true,
      healthy: false,
      cooldownUntil: now + 186_000,
    },
    { id: 'spare', displayName: 'spare', ready: false },
  ],
}

const degraded: SnapshotProvider = {
  route: 'ikun',
  kind: 'custom',
  auth: 'api-key',
  displayName: 'IKun',
  enabled: true,
  registered: true,
  accounts: [{ id: 'gpt', displayName: 'IKun GPT', ready: true, healthy: true }],
  models: { discovered: 3, effective: 3, excluded: [], notIncluded: [] },
  catalogError: 'model catalog returned 503',
}

const failed: SnapshotProvider = {
  route: 'zai',
  kind: 'builtin',
  auth: 'api-key',
  displayName: 'ZAI Coding',
  enabled: true,
  registered: false,
  accounts: [{ id: 'main', displayName: 'main', ready: true }],
  error: 'no account has a usable model catalog',
}

const disabled: SnapshotProvider = {
  route: 'legacy',
  kind: 'custom',
  auth: 'api-key',
  displayName: 'Legacy gateway',
  enabled: false,
  registered: false,
  accounts: [],
}

const meta = {
  title: 'more-providers/Provider cards',
  parameters: { layout: 'padded' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Available: Story = { render: () => <Cards providers={[healthy]} /> }
export const PoolCooling: Story = { render: () => <Cards providers={[cooling]} /> }
export const CatalogDegraded: Story = { render: () => <Cards providers={[degraded]} /> }
export const Unavailable: Story = { render: () => <Cards providers={[failed]} /> }
export const Disabled: Story = { render: () => <Cards providers={[disabled]} /> }
export const Mixed: Story = {
  render: () => <Cards providers={[healthy, degraded, failed, disabled]} />,
}
export const ConfigInvalid: Story = {
  render: () => (
    <Cards
      providers={[healthy]}
      instances={[
        {
          ...instance([healthy]),
          state: 'invalid',
          error: 'providers.mdkj.models[2].id: must not be empty',
          revision: 4,
          appliedRevision: 3,
        },
      ]}
    />
  ),
}

const chatgpt: SnapshotProvider = {
  route: 'chatgpt',
  kind: 'chatgpt',
  auth: 'oauth',
  displayName: 'ChatGPT (OpenAI)',
  enabled: true,
  registered: true,
  accounts: [],
  models: { discovered: 12, effective: 12, excluded: [], notIncluded: [] },
}

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

/** Answer the section's snapshot and sign-in reads, so the page story renders without a Host. */
async function stubbedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url === '/dsh-more-providers/providers') {
    return jsonResponse({
      instances: [instance([healthy, cooling, degraded, failed, disabled, chatgpt])],
    })
  }
  if (url.startsWith('/dsh-oauth-providers/')) {
    return jsonResponse({
      result: {
        ok: true,
        value: { providers: [{ id: 'chatgpt', label: 'ChatGPT (OpenAI)', signedIn: true }] },
      },
    })
  }
  return originalFetch(input, init)
}

globalThis.fetch = stubbedFetch

export const Section: Story = {
  render: () => (
    <div className="dshx:w-[720px] dshx:max-w-full">
      <ProvidersSection operations={{ discoverModels: async () => ({ ok: true }) }} t={t} />
    </div>
  ),
}
