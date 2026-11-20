import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { FetchLike } from '../src/oauth/transport.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHATGPT_BASE_URL,
  capturingFetch,
  cleanupYamlFiles,
  collectStream,
  createHarness,
  disposeTracked,
  generateOptions,
  imageRef,
  registeredAdapter,
  waitFor,
  wireBody,
  type Harness,
  type HarnessOptions,
} from './helpers.js'
import { imageContract } from './image-contract.js'

const oauthFetch = vi.hoisted(() => ({ current: undefined as FetchLike | undefined }))

vi.mock(import('../src/oauth/transport.js'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    createFetch: async () => {
      const fetch = oauthFetch.current
      if (fetch === undefined) throw new Error('OAuth fixture fetch is not initialized')
      return fetch
    },
  }
})

const capture = capturingFetch()
oauthFetch.current = capture.fetch as unknown as FetchLike
const CHATGPT_YAML = [
  'providers:',
  '  chatgpt:',
  '    kind: chatgpt',
  `    baseURL: ${CHATGPT_BASE_URL}`,
  '    clientVersion: 9.9.9-test',
].join('\n')

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
  vi.unstubAllEnvs()
})

async function oauthHarness(options: Partial<HarnessOptions> = {}): Promise<Harness> {
  const harness = await createHarness({ yaml: CHATGPT_YAML, ...options })
  await waitFor(
    () => harness.llm.adapters.some((entry) => entry.providers.includes('chatgpt')),
    'the ChatGPT adapter to mount',
  )
  capture.calls.length = 0
  return harness
}

imageContract({
  provider: 'chatgpt',
  model: 'gpt-5.2',
  detail: 'high',
  mount: oauthHarness,
  capture,
})

function streamChatgpt(harness: Harness, extra: Partial<GenerateOptions> = {}) {
  return collectStream(
    registeredAdapter(harness.llm, 'chatgpt').stream(
      generateOptions(
        'chatgpt',
        'gpt-5.2',
        [
          {
            role: 'user',
            content: [{ type: 'image', attachment: imageRef('protocol-image') }],
          },
        ],
        extra,
      ),
    ),
  )
}

describe('ChatGPT protocol and credential behavior', () => {
  it('uses the preserved grant and account headers at the configured backend', async () => {
    const harness = await oauthHarness()
    await streamChatgpt(harness)
    expect(capture.calls).toHaveLength(1)
    expect(capture.calls[0]?.url).toBe(`${CHATGPT_BASE_URL}/responses`)
    const headers = new Headers(capture.calls[0]?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer test-access-token')
    expect(headers.get('chatgpt-account-id')).toBe('acct-1')
    expect(headers.get('oai-product-sku')).toBe('codex')
  })

  it('reports the fixture HTTP 400 after sending the request', async () => {
    const harness = await oauthHarness()
    const { error } = await streamChatgpt(harness)
    expect(capture.calls).toHaveLength(1)
    expect(error).toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('stamps the cache key and affinity headers from the session id', async () => {
    const harness = await oauthHarness()
    await streamChatgpt(harness, { sessionId: 'session-abcdef' as GenerateOptions['sessionId'] })
    expect(wireBody(capture.calls[0]).prompt_cache_key).toBe('session-abcdef')
    const headers = new Headers(capture.calls[0]?.init.headers)
    expect(headers.get('session-id')).toBe('session-abcdef')
    expect(headers.get('x-client-request-id')).toBe('session-abcdef')
  })

  it('honors the YAML option to disable cache affinity', async () => {
    const harness = await oauthHarness({ yaml: `${CHATGPT_YAML}\n    promptCacheKey: false\n` })
    await streamChatgpt(harness, { sessionId: 'session-abcdef' as GenerateOptions['sessionId'] })
    expect(wireBody(capture.calls[0]).prompt_cache_key).toBeUndefined()
    expect(new Headers(capture.calls[0]?.init.headers).get('session-id')).toBeNull()
  })

  it('requires a stored grant before dispatch', async () => {
    const harness = await oauthHarness({ chatgptGrant: false })
    const { error } = await streamChatgpt(harness)
    expect(error).toBeDefined()
    expect(capture.calls).toHaveLength(0)
  })

  it('reports an already aborted request as ABORTED', async () => {
    const harness = await oauthHarness()
    const { error } = await streamChatgpt(harness, { signal: AbortSignal.abort() })
    expect(error).toMatchObject({ code: 'ABORTED' })
    expect(capture.calls).toHaveLength(0)
  })
})
