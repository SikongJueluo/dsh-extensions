/**
 * Judge output-budget schema: a bounded, configurable per-request cap that
 * defaults above the old fixed 1024 tokens.
 *
 * @module dsh-auto-permit/settings.test
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { Config, JUDGE_OUTPUT_TOKENS, registerSettings } from '../src/settings.js'

const read = (input: Record<string, unknown>) => registerSettings({} as Context, Config(input))()

describe('judge output-token budget', () => {
  it('defaults to 8192 for a row written before the field existed', () => {
    expect(JUDGE_OUTPUT_TOKENS.default).toBe(8192)
    expect(read({ provider: 'p', model: 'm' }).maxOutputTokens).toBe(8192)
  })

  it('passes a configured in-range budget through to the judge settings', () => {
    expect(read({ maxOutputTokens: 4096 }).maxOutputTokens).toBe(4096)
  })

  it('rejects out-of-range and non-integer budgets instead of clamping them', () => {
    expect(() => Config({ maxOutputTokens: JUDGE_OUTPUT_TOKENS.min - 1 })).toThrow()
    expect(() => Config({ maxOutputTokens: JUDGE_OUTPUT_TOKENS.max + 1 })).toThrow()
    expect(() => Config({ maxOutputTokens: 4096.5 })).toThrow()
  })
})
