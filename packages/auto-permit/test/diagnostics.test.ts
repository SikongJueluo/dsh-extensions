import { describe, expect, it } from 'vitest'
import { debugQuietly, errorTag, warnQuietly } from '../src/diagnostics.js'

describe('errorTag', () => {
  it('keeps a structured code', () => {
    expect(errorTag(Object.assign(new Error('failed'), { code: 'ENOENT' }))).toBe('Error(ENOENT)')
  })

  it('drops a code that carries free text', () => {
    expect(errorTag(Object.assign(new Error('failed'), { code: 'ENOENT --token sk-secret' }))).toBe(
      'Error',
    )
  })

  it('drops a name that carries free text', () => {
    const error = new Error('failed')
    error.name = 'Command failed: sk-secret'
    expect(errorTag(error)).toBe('Error')
  })

  it('keeps a numeric errno code', () => {
    expect(errorTag(Object.assign(new Error('failed'), { code: -4092 }))).toBe('Error(-4092)')
  })

  it('does not inspect non-errors', () => {
    expect(errorTag({ code: 'ENOENT' })).toBe('non-error')
  })
})

describe('quiet diagnostics', () => {
  it('reports a failed exporter instead of throwing', () => {
    const throwing = {
      warn: () => {
        throw new Error('exporter down')
      },
      debug: () => {
        throw new Error('exporter down')
      },
    }
    expect(warnQuietly(throwing, 'x')).toBe(false)
    expect(debugQuietly(throwing, 'x')).toBe(false)
  })
})
