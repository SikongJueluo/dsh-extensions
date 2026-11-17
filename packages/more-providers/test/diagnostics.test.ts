/**
 * Diagnostic secrecy: a thrown string or object must be classified, never echoed, and a throwing log exporter must stay contained.
 * @module dsh-more-providers/test/diagnostics
 */
import type { Logger } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { debugQuietly } from '../src/diagnostics.js'

function collectingLogger(): { logger: Logger; calls: unknown[][] } {
  const calls: unknown[][] = []
  const logger = {
    name: 'diagnostics-test',
    debug: (...args: unknown[]) => {
      calls.push(args)
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger
  return { logger, calls }
}

describe('debugQuietly', () => {
  it.each([
    ['string', 'Bearer sk-string-secret', 'string'],
    ['object', { message: 'secret-provider-body', code: 'secret-code' }, 'object'],
    ['null', null, 'object'],
    ['undefined', undefined, 'undefined'],
  ])('classifies a thrown %s without echoing it', (_label, thrown, expected) => {
    const { logger, calls } = collectingLogger()

    expect(debugQuietly(logger, 'probe failed (%s); using fallback', thrown)).toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.[1]).toBe(expected)
    expect(JSON.stringify(calls)).not.toContain('secret')
  })

  it('keeps an Error class and stable code but drops its message', () => {
    const { logger, calls } = collectingLogger()
    const thrown = Object.assign(new Error('secret-error-message'), { code: 'EPROTO' })

    debugQuietly(logger, 'probe failed (%s, HTTP %d)', thrown, 502)

    expect(calls[0]?.slice(1)).toEqual(['Error/EPROTO', 502])
    expect(JSON.stringify(calls)).not.toContain('secret-error-message')
  })

  it('drops secret-shaped codes and names instead of echoing them', () => {
    const { logger, calls } = collectingLogger()
    const wrapped = Object.assign(new Error('secret-error-message'), {
      code: 'Bearer sk-code-secret',
      name: 'sk-code-secret',
    })
    const caused = new Error('secret-cause-message', {
      cause: Object.assign(new Error('secret-cause'), { code: 'secret-response-body' }),
    })

    debugQuietly(logger, 'wrapped failed (%s)', wrapped)
    debugQuietly(logger, 'caused failed (%s)', caused)

    expect(calls.map((call) => call[1])).toEqual(['object', 'Error'])
    expect(JSON.stringify(calls)).not.toContain('secret')
  })

  it('returns false when the exporter throws and does not rethrow', () => {
    const logger = {
      debug: () => {
        throw new Error('secret-exporter-failure')
      },
    } as unknown as Logger

    expect(debugQuietly(logger, 'probe failed (%s)', 'secret-thrown-value')).toBe(false)
  })

  it('returns false without a logger', () => {
    expect(debugQuietly(undefined, 'probe failed (%s)', 'secret-thrown-value')).toBe(false)
  })
})
