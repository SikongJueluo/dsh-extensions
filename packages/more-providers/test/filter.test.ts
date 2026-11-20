/**
 * Model filter contract: allow/deny lists with deny precedence, empty groups admitting
 * everything, plain compile errors, and the finalization step that hard-deletes ids.
 * @module dsh-more-providers/test/filter
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../src/config.js'
import { compileModelFilter } from '../src/catalog/filter.js'
import { finalizeCatalog } from '../src/catalog/finalize.js'
import type { ModelConfig, ModelDefault } from '../src/config.js'

function ids(models: readonly ModelConfig[]): string[] {
  return models.map((model) => model.id)
}

describe('compileModelFilter', () => {
  it('admits every id without a filter section', () => {
    const filter = compileModelFilter(undefined)
    expect(filter.keeps('anything')).toBe(true)
    expect(filter.reason('anything')).toBeUndefined()
  })

  it('treats an empty allow list as no allow list', () => {
    const filter = compileModelFilter({ include: [], exclude: [] })
    expect(filter.keeps('anything')).toBe(true)
    expect(filter.reason('anything')).toBeUndefined()
  })

  it('keeps only ids matching the allow list', () => {
    const filter = compileModelFilter({ include: [{ match: '^gpt-' }] })
    expect(filter.keeps('gpt-6')).toBe(true)
    expect(filter.keeps('claude-5')).toBe(false)
    expect(filter.reason('claude-5')).toBe('include-miss')
  })

  it('drops ids matching the deny list', () => {
    const filter = compileModelFilter({ exclude: [{ match: '-mini$' }] })
    expect(filter.keeps('gpt-6-mini')).toBe(false)
    expect(filter.reason('gpt-6-mini')).toBe('exclude-hit')
    expect(filter.keeps('gpt-6')).toBe(true)
  })

  it('lets the deny list win over the allow list', () => {
    const filter = compileModelFilter({
      include: [{ match: '^gpt-' }],
      exclude: [{ match: '-mini$' }],
    })
    expect(filter.keeps('gpt-6-mini')).toBe(false)
    expect(filter.reason('gpt-6-mini')).toBe('exclude-hit')
  })

  it('honors flags and stays case-sensitive without them', () => {
    const filter = compileModelFilter({
      exclude: [{ match: '^gpt', flags: 'i' }, { match: '-free$' }],
    })
    expect(filter.keeps('GPT-6')).toBe(false)
    expect(filter.keeps('claude-6-FREE')).toBe(true)
    expect(filter.keeps('gpt-6-free')).toBe(false)
  })

  it('does not leak global-flag state between ids', () => {
    const filter = compileModelFilter({ include: [{ match: 'gpt', flags: 'g' }] })
    expect(filter.keeps('gpt-6')).toBe(true)
    expect(filter.keeps('gpt-7')).toBe(true)
    expect(filter.reason('gpt-8')).toBeUndefined()
  })

  it('throws a plain error naming the offending entry and flags', () => {
    expect(() => compileModelFilter({ include: [{ match: '(' }] })).toThrow(
      /invalid include entry 0 \{match "\("\}/u,
    )
    expect(() => compileModelFilter({ exclude: [{ match: 'a', flags: 'ii' }] })).toThrow(
      /invalid exclude entry 0 \{match "a", flags "ii"\}/u,
    )
    try {
      compileModelFilter({ exclude: [{ match: '[' }] })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(ConfigError)
    }
  })
})

describe('finalizeCatalog', () => {
  it('hard-deletes excluded and not-included ids in catalog order', () => {
    const finalized = finalizeCatalog({
      catalog: [{ id: 'gpt-6' }, { id: 'gpt-6-mini' }, { id: 'claude-5' }, { id: 'claude-5-free' }],
      filter: compileModelFilter({ include: [{ match: '^gpt-' }], exclude: [{ match: '-mini$' }] }),
    })
    expect(ids(finalized.models)).toEqual(['gpt-6'])
    expect(finalized.excluded).toEqual(['gpt-6-mini'])
    expect(finalized.notIncluded).toEqual(['claude-5', 'claude-5-free'])
  })

  it('filters the static fallback when the catalog is unavailable', () => {
    const finalized = finalizeCatalog({
      catalog: [],
      staticModels: [{ id: 'keep' }, { id: 'drop' }],
      filter: compileModelFilter({ include: [{ match: '^keep$' }] }),
    })
    expect(ids(finalized.models)).toEqual(['keep'])
    expect(finalized.notIncluded).toEqual(['drop'])
    expect(finalized.excluded).toEqual([])
  })

  it('runs the filter after metadata merging', () => {
    const defaults: ModelDefault[] = [{ pattern: /^gpt/u, contextWindow: 272000 }]
    const finalized = finalizeCatalog({
      catalog: [{ id: 'gpt-6' }, { id: 'other' }],
      defaults,
      contextWindows: new Map([['gpt-6', 999]]),
      filter: compileModelFilter({ include: [{ match: '^gpt' }] }),
    })
    expect(finalized.models).toEqual([{ id: 'gpt-6', contextWindow: 272000 }])
    expect(finalized.notIncluded).toEqual(['other'])
  })

  it('reports nothing without a filter', () => {
    const finalized = finalizeCatalog({
      catalog: [{ id: 'a' }],
      staticModels: [{ id: 'b' }],
    })
    expect(ids(finalized.models)).toEqual(['a'])
    expect(finalized.excluded).toEqual([])
    expect(finalized.notIncluded).toEqual([])
  })

  it('matches model ids only, never display names', () => {
    const finalized = finalizeCatalog({
      catalog: [{ id: 'gpt-6', name: 'GPT Mini' }],
      filter: compileModelFilter({ exclude: [{ match: 'mini', flags: 'i' }] }),
    })
    expect(ids(finalized.models)).toEqual(['gpt-6'])
    expect(finalized.excluded).toEqual([])
  })
})
