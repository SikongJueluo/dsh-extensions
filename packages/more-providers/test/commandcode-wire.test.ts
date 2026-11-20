/**
 * Command Code's Anthropic wire encoding: capability levels must reach the
 * request as distinct adaptive efforts rather than collapsing into one budget.
 * @module dsh-more-providers/test/command-code-wire
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CAPABILITIES_URL, DEFAULT_MODELS_URL } from '../src/commandcode.js'
import {
  TEST_ENV_KEY,
  capturingFetch,
  chatgptYaml,
  cleanupYamlFiles,
  collectStream,
  createHarness,
  disposeTracked,
  generateOptions,
  registeredAdapter,
  waitFor,
  wireBody,
  type Harness,
} from './helpers.js'

const capture = capturingFetch()

const YAML = [
  'providers:',
  '  command:',
  '    kind: command-code',
  `    apiKeyEnv: ${TEST_ENV_KEY}`,
  chatgptYaml({ enabled: false }),
].join('\n')

const MODELS = {
  data: [{ id: 'claude-haiku-5-5', context_length: 1000000, supported_endpoints: ['/messages'] }],
}

const CAPABILITIES = {
  schemaVersion: 1,
  data: [
    {
      id: 'claude-haiku-5-5',
      context_length: 1000000,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
  ],
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

let servingCatalogs = true

async function catalogFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const href = String(url)
  if (servingCatalogs && href === DEFAULT_MODELS_URL) return json(MODELS)
  if (servingCatalogs && href === DEFAULT_CAPABILITIES_URL) return json(CAPABILITIES)
  return capture.fetch(url, init)
}

beforeEach(() => {
  servingCatalogs = true
  capture.calls.length = 0
  vi.stubGlobal('fetch', catalogFetch)
})

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function mount(): Promise<Harness> {
  const harness = await createHarness({ yaml: YAML })
  await waitFor(
    () => harness.llm.adapters.some((entry) => entry.providers.includes('command')),
    'the Command Code adapter to register',
  )
  servingCatalogs = false
  capture.calls.length = 0
  return harness
}

describe('Command Code Anthropic reasoning wire', () => {
  it('sends distinct adaptive efforts for high, xhigh, and max', async () => {
    const harness = await mount()
    const adapter = registeredAdapter(harness.llm, 'command')

    for (const effort of ['high', 'xhigh', 'max'] as const) {
      capture.calls.length = 0
      await collectStream(
        adapter.stream(
          generateOptions(
            'command',
            'claude-haiku-5-5',
            [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            { reasoningEffort: effort as never },
          ),
        ),
      )

      expect(capture.calls).toHaveLength(1)
      const body = wireBody(capture.calls[0]) as {
        thinking?: { type?: string; budget_tokens?: number }
        output_config?: { effort?: string }
      }
      expect(body.thinking).toMatchObject({ type: 'adaptive' })
      expect(body.thinking?.budget_tokens).toBeUndefined()
      expect(body.output_config?.effort).toBe(effort)
    }
  })
})
