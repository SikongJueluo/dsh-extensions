import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_API_KEY,
  capturingFetch,
  cleanupYamlFiles,
  collectStream,
  createHarness,
  disposeTracked,
  errorFinish,
  generateOptions,
  chatgptYaml,
  gatewayYaml,
  imageRef,
  registeredAdapter,
  waitFor,
  type Harness,
  type HarnessOptions,
} from './helpers.js'
import { imageContract } from './image-contract.js'

const capture = capturingFetch()
const GATEWAY_YAML = ['providers:', gatewayYaml(), chatgptYaml({ enabled: false })].join('\n')

beforeEach(() => {
  vi.stubGlobal('fetch', capture.fetch)
  capture.calls.length = 0
})

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function gatewayHarness(options: Partial<HarnessOptions> = {}): Promise<Harness> {
  const harness = await createHarness({ yaml: GATEWAY_YAML, ...options })
  await waitFor(
    () => harness.llm.adapters.some((entry) => entry.providers.includes('gateway')),
    'the gateway adapter to register',
  )
  capture.calls.length = 0
  return harness
}

imageContract({
  provider: 'gateway',
  model: 'gateway-large',
  detail: 'auto',
  mount: gatewayHarness,
  capture,
})

describe('gateway protocol behavior', () => {
  it('carries the configured API key on the wire', async () => {
    const harness = await gatewayHarness()
    await collectStream(
      registeredAdapter(harness.llm, 'gateway').stream(
        generateOptions('gateway', 'gateway-large', [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ]),
      ),
    )
    expect(capture.calls).toHaveLength(1)
    expect(new Headers(capture.calls[0]?.init.headers).get('authorization')).toBe(
      `Bearer ${TEST_API_KEY}`,
    )
  })

  it('reports an already aborted request as ABORTED', async () => {
    const harness = await gatewayHarness()
    const { chunks } = await collectStream(
      registeredAdapter(harness.llm, 'gateway').stream(
        generateOptions(
          'gateway',
          'gateway-large',
          [
            {
              role: 'user',
              content: [{ type: 'image', attachment: imageRef('aborted-image') }],
            },
          ],
          { signal: AbortSignal.abort() },
        ),
      ),
    )
    expect(errorFinish(chunks)).toMatchObject({ kind: 'aborted', failure: { code: 'ABORTED' } })
    expect(capture.calls).toHaveLength(0)
  })
})
