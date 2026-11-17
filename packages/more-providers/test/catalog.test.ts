/**
 * ModelCatalog fallback contract: a failing npm registry lookup keeps the catalog usable and logs no error text.
 * @module dsh-more-providers/test/catalog
 */
import type { Logger } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { FetchLike } from '../src/oauth/transport.js'
import { ModelCatalog } from '../src/providers/chatgpt/catalog.js'

function collectingLogger(): { logger: Logger; calls: unknown[][] } {
  const calls: unknown[][] = []
  const logger = {
    name: 'catalog-test',
    debug: (...args: unknown[]) => {
      calls.push(args)
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger
  return { logger, calls }
}

describe('ModelCatalog client version', () => {
  it('falls back to the bundled version when the registry lookup fails', async () => {
    const { logger, calls } = collectingLogger()
    const urls: string[] = []
    const fetch = (async (url: string) => {
      urls.push(url)
      if (url.includes('registry.npmjs.org')) throw new Error('socket-secret-value')
      return new Response(
        JSON.stringify({ models: [{ slug: 'gpt-test', display_name: 'GPT Test' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as FetchLike
    const catalog = new ModelCatalog({
      fetch,
      options: { baseURL: 'https://backend.invalid' },
      logger,
    })

    const models = await catalog.refresh()

    expect(models.map((model) => model.id)).toEqual(['gpt-test'])
    expect(urls[1]).toContain('client_version=0.157.1')
    expect(calls).toHaveLength(1)
    expect(String(calls[0]?.[0])).toContain('client-version lookup failed')
    expect(JSON.stringify(calls)).not.toContain('socket-secret-value')
  })
})
