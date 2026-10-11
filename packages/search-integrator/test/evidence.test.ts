import { describe, expect, it } from 'vitest'
import { buildDigest, buildEvidence, excerptOf, urlDedupKey } from '../src/evidence.js'
import type { RawHit } from '../src/types.js'

function hit(overrides: Partial<RawHit> & Pick<RawHit, 'url'>): RawHit {
  return {
    provider: 'tavily',
    query: 'q',
    snippet: 'snippet',
    ...overrides,
  }
}

describe('urlDedupKey', () => {
  it('strips tracking params and normalizes host case/ports (fragments stay)', () => {
    expect(urlDedupKey('https://Example.com:443/a?utm_source=x&id=7#frag'))
      .toBe(urlDedupKey('https://example.com/a?id=7#frag'))
    expect(urlDedupKey('http://example.com:80/a')).toBe(urlDedupKey('http://example.com/a'))
  })

  it('keeps content-bearing query parameters distinct', () => {
    expect(urlDedupKey('https://example.com/doc?v=1')).not.toBe(urlDedupKey('https://example.com/doc?v=2'))
    expect(urlDedupKey('https://example.com/watch?id=a')).not.toBe(urlDedupKey('https://example.com/watch?id=b'))
  })

  it('preserves parameter order and unknown parameters', () => {
    expect(urlDedupKey('https://example.com/a?b=2&a=1')).not.toBe(urlDedupKey('https://example.com/a?a=1&b=2'))
    expect(urlDedupKey('https://example.com/a?lang=de')).toBe(urlDedupKey('https://example.com/a?lang=de&fbclid=xyz'))
  })

  it('falls back to the raw string for unparseable urls', () => {
    expect(urlDedupKey('not a url')).toBe('not a url')
  })
})

describe('buildEvidence', () => {
  it('merges the same url across providers with union provenance', () => {
    const evidence = buildEvidence([
      hit({ url: 'https://a.example/1', provider: 'tavily', snippet: 'same fact' }),
      hit({ url: 'https://a.example/1?utm_campaign=x', provider: 'exa', snippet: 'longer snippet about the same fact' }),
      hit({ url: 'https://b.example/2', provider: 'exa' }),
    ], ['fact'], 14)
    expect(evidence).toHaveLength(2)
    const top = evidence[0]
    expect(top).toBeDefined()
    if (top === undefined) throw new Error('unreachable')
    expect(top.url).toBe('https://a.example/1')
    expect([...top.providers].sort()).toEqual(['exa', 'tavily'])
    expect(top.id).toBe(1)
  })

  it('ranks cross-source agreement above single-source hits', () => {
    const evidence = buildEvidence([
      hit({ url: 'https://single.example/1' }),
      hit({ url: 'https://shared.example/1', provider: 'tavily' }),
      hit({ url: 'https://shared.example/1', provider: 'exa' }),
    ], [], 14)
    expect(evidence[0]?.providers).toHaveLength(2)
  })

  it('merges verbatim syndication (identical title+snippet) but not near-duplicates', () => {
    const evidence = buildEvidence([
      hit({ url: 'https://one.example/x', title: 'Release notes', snippet: 'Version 2.1 fixed the bug' }),
      hit({ url: 'https://two.example/x', title: 'Release notes', snippet: 'Version 2.1 fixed the bug', provider: 'exa' }),
      hit({ url: 'https://three.example/y', title: 'Release notes', snippet: 'Version 2.2 fixed the bug', provider: 'zhipu' }),
    ], [], 14)
    expect(evidence).toHaveLength(2)
    expect(evidence[0]?.providers).toHaveLength(2)
    expect(evidence.find((s) => s.url.includes('three'))?.snippet).toBe('Version 2.2 fixed the bug')
  })

  it('never merges on title similarity alone (negation/version differences survive)', () => {
    const evidence = buildEvidence([
      hit({ url: 'https://a.example/1', title: 'Is X supported?', snippet: 'X is not supported' }),
      hit({ url: 'https://b.example/2', title: 'Is X supported', snippet: 'X is supported', provider: 'exa' }),
    ], [], 14)
    expect(evidence).toHaveLength(2)
  })

  it('caps the evidence pool after ranking', () => {
    const hits = Array.from({ length: 10 }, (_, i) => hit({ url: `https://x.example/${i}` }))
    expect(buildEvidence(hits, [], 3)).toHaveLength(3)
  })
})

describe('buildDigest / excerptOf', () => {
  const evidence = buildEvidence([
    hit({ url: 'https://a.example/1', title: 'A', snippet: 'short', content: 'x'.repeat(3000) }),
  ], [], 14)

  it('caps excerpts at the requested size', () => {
    expect(excerptOf(evidence[0] as never, 100).length).toBeLessThanOrEqual(101)
  })

  it('numbers sources and keeps url headers even when the char budget runs out', () => {
    const digest = buildDigest(evidence, 10, 120)
    expect(digest).toContain('[1] https://a.example/1')
    const many = buildEvidence(
      Array.from({ length: 8 }, (_, i) => hit({ url: `https://x.example/${i}`, snippet: 'y'.repeat(200) })),
      [], 14,
    )
    const tight = buildDigest(many, 1600, 400)
    for (const source of many) {
      expect(tight).toContain(`[${source.id}]`)
    }
    expect(tight).toContain('(excerpt omitted: digest budget reached)')
  })
})

describe('v3 dedup corrections', () => {
  it('keeps fragments distinct (SPA routes are different pages)', () => {
    expect(urlDedupKey('https://a.example/doc#/page/1')).not.toBe(urlDedupKey('https://a.example/doc#/page/2'))
  })

  it('does NOT merge syndicated titles whose snippets diverge after 160 chars', () => {
    const sharedPrefix = 'x'.repeat(200)
    const evidence = buildEvidence([
      hit({ url: 'https://one.example/a', title: 'Same headline', snippet: sharedPrefix + ' version 1.0' }),
      hit({ url: 'https://two.example/b', title: 'Same headline', snippet: sharedPrefix + ' version 2.0', provider: 'exa' }),
    ], [], 14)
    expect(evidence).toHaveLength(2)
  })

  it('still merges exactly identical title+snippet syndication', () => {
    const evidence = buildEvidence([
      hit({ url: 'https://one.example/a', title: 'Same headline', snippet: 'identical body text' }),
      hit({ url: 'https://two.example/b', title: 'Same headline', snippet: 'identical body text', provider: 'exa' }),
    ], [], 14)
    expect(evidence).toHaveLength(1)
  })
})
