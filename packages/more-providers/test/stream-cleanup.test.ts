/**
 * Stream teardown contract: a failing upstream iterator cannot mask the primary transport error, even when the log exporter also throws.
 * @module dsh-more-providers/test/stream-cleanup
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupYamlFiles,
  collectStream,
  createHarness,
  disposeTracked,
  generateOptions,
  registeredAdapter,
  waitFor,
} from './helpers.js'

const CHATGPT_YAML = [
  'providers:',
  '  chatgpt:',
  '    baseURL: https://chatgpt.invalid/backend-api/codex',
  '    clientVersion: 9.9.9-test',
].join('\n')

afterEach(async () => {
  await disposeTracked()
  await cleanupYamlFiles()
})

describe('ChatGPT stream teardown', () => {
  it('keeps the primary transport error when cleanup and the log exporter both throw', async () => {
    const harness = await createHarness({ yaml: CHATGPT_YAML })
    await waitFor(
      () => harness.llm.adapters.some((entry) => entry.providers.includes('chatgpt')),
      'the ChatGPT adapter to mount',
    )
    const adapter = registeredAdapter(harness.llm, 'chatgpt') as unknown as {
      stream(options: ReturnType<typeof generateOptions>): AsyncIterable<StreamChunk>
      request: (...args: unknown[]) => AsyncIterable<never>
      logger: { debug: (...args: unknown[]) => void }
    }
    let cleanupCalled = false
    let debugCalled = false
    adapter.request = () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            throw new Error('upstream-secret-failure')
          },
          async return(): Promise<IteratorResult<never>> {
            cleanupCalled = true
            throw new Error('cleanup-secret-failure')
          },
        }
      },
    })
    adapter.logger = {
      debug: () => {
        debugCalled = true
        throw new Error('exporter-secret-failure')
      },
    }

    const { error } = await collectStream(
      adapter.stream(
        generateOptions('chatgpt', 'gpt-5.2', [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        ]),
      ),
    )

    expect(cleanupCalled).toBe(true)
    expect(debugCalled).toBe(true)
    expect(error).toMatchObject({ code: 'TRANSPORT' })
    expect(JSON.stringify(error)).not.toContain('secret')
  })
})
