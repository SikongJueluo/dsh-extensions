import { describe, expect, it } from 'vitest'
import {
  extractJsonObject, parseIntegration, planQueries, runIntegration,
} from '../src/integrate.js'
import type { LlmCall, LlmPort } from '../src/llm.js'

/** A scripted LlmPort: pops queued outcomes and records requests. */
function fakeLlm(outcomes: { ok?: boolean; finishKind?: string; text?: string; error?: string; usage?: { inputTokens: number; outputTokens: number } }[]) {
  const calls: LlmCall[] = []
  const queue = [...outcomes]
  const port: LlmPort = {
    async call(req) {
      calls.push(req)
      const next = queue.shift()
      if (next === undefined) throw new Error('fake llm exhausted')
      if (next.ok === false) {
        return { ok: false, text: '', finishKind: next.finishKind ?? 'error', error: next.error ?? 'boom' }
      }
      return {
        ok: true,
        text: next.text ?? '',
        finishKind: 'stop',
        ...(next.usage === undefined ? {} : { usage: next.usage }),
      }
    },
  }
  return { port, calls }
}

const okIntegration = {
  summary: 'It works.',
  points: [
    { text: 'Fact one', status: 'supported', sources: [1, 2] },
    { text: 'Fact two conflicts', status: 'conflict', sources: [1, 3] },
    { text: 'Weak fact', status: 'insufficient', sources: [2] },
  ],
  unknowns: ['release date unclear'],
  followup: { needed: false, queries: [] },
}

describe('extractJsonObject', () => {
  it('extracts from fences and surrounding prose', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJsonObject('Here you go: {"a": {"b": "}"}} hope it helps')).toBe('{"a": {"b": "}"}}')
  })

  it('returns undefined without a complete object', () => {
    expect(extractJsonObject('no json here')).toBeUndefined()
    expect(extractJsonObject('{"a": 1')).toBeUndefined()
  })
})

describe('parseIntegration', () => {
  it('accepts a valid contract', () => {
    const parsed = parseIntegration(okIntegration, 3)
    expect(parsed?.summary).toBe('It works.')
    expect(parsed?.points).toHaveLength(3)
    expect(parsed?.followupNeeded).toBe(false)
  })

  it('strips fabricated ids; a point left with none moves to unknowns (v3)', () => {
    const parsed = parseIntegration({
      ...okIntegration,
      points: [
        { text: 'ok', status: 'supported', sources: [1, 99] },
        { text: 'all fabricated', status: 'supported', sources: [42] },
      ],
    }, 2)
    expect(parsed?.points).toHaveLength(1)
    expect(parsed?.points[0]?.sources).toEqual([1])
    expect(parsed?.unknowns.some((text) => text.includes('all fabricated'))).toBe(true)
  })

  it('rejects missing summary or points', () => {
    expect(parseIntegration({ points: okIntegration.points }, 3)).toBeUndefined()
    expect(parseIntegration({ summary: 's' }, 3)).toBeUndefined()
    expect(parseIntegration('nope', 3)).toBeUndefined()
  })
})

describe('planQueries', () => {
  it('parses planned queries', async () => {
    const { port } = fakeLlm([{ text: '{"queries": ["q1", "q2"]}' }])
    expect(await planQueries(port, 'question', new AbortController().signal)).toEqual(['q1', 'q2'])
  })

  it('falls back to undefined on any failure', async () => {
    const bad = fakeLlm([{ text: 'not json' }])
    expect(await planQueries(bad.port, 'q', new AbortController().signal)).toBeUndefined()
    const err = fakeLlm([{ ok: false, error: 'x' }])
    expect(await planQueries(err.port, 'q', new AbortController().signal)).toBeUndefined()
  })
})

describe('runIntegration', () => {
  const digest = '[1] https://a.example\n    evidence one\n[2] https://b.example\n    evidence two'

  it('succeeds on the first attempt', async () => {
    const { port, calls } = fakeLlm([{ text: JSON.stringify(okIntegration) }])
    const outcome = await runIntegration(port, 'q', digest, 3, new AbortController().signal)
    expect(outcome.kind).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.user).toContain('Evidence (3 numbered sources')
  })

  it('repairs once on malformed json', async () => {
    const { port, calls } = fakeLlm([
      { text: 'sure! {"summary": "trunc' },
      { text: JSON.stringify(okIntegration) },
    ])
    const outcome = await runIntegration(port, 'q', digest, 3, new AbortController().signal)
    expect(outcome.kind).toBe('ok')
    expect(calls).toHaveLength(2)
    expect(calls[1]?.user).toContain('rejected')
  })

  it('fails after a failed repair', async () => {
    const { port } = fakeLlm([{ text: 'garbage' }, { text: 'still garbage' }])
    const outcome = await runIntegration(port, 'q', digest, 3, new AbortController().signal)
    expect(outcome.kind).toBe('failed')
  })

  it('retries a transient adapter error once, then fails', async () => {
    const { port, calls } = fakeLlm([
      { ok: false, finishKind: 'error', error: 'model adapter error' },
      { ok: false, finishKind: 'error', error: 'still erroring' },
    ])
    const outcome = await runIntegration(port, 'q', digest, 3, new AbortController().signal)
    expect(outcome.kind).toBe('failed')
    expect(calls).toHaveLength(2)
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toBe('still erroring')
      expect(outcome.attempts).toBe(2)
    }
  })

  it('fails immediately on max-tokens without burning a repair attempt', async () => {
    const { port, calls } = fakeLlm([{ ok: false, finishKind: 'max-tokens', error: 'model hit the output token limit' }])
    const outcome = await runIntegration(port, 'q', digest, 3, new AbortController().signal)
    expect(outcome.kind).toBe('failed')
    expect(calls).toHaveLength(1)
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toContain('token limit')
      expect(outcome.attempts).toBe(1)
    }
  })

  it('fails immediately on abort without retrying', async () => {
    const { port, calls } = fakeLlm([{ ok: false, finishKind: 'aborted', error: 'model call aborted' }])
    const outcome = await runIntegration(port, 'q', digest, 3, new AbortController().signal)
    expect(outcome.kind).toBe('failed')
    expect(calls).toHaveLength(1)
    if (outcome.kind === 'failed') expect(outcome.reason).toContain('aborted')
  })

  it('aggregates usage across attempts', async () => {
    const { port } = fakeLlm([
      { text: 'garbage', usage: { inputTokens: 10, outputTokens: 5 } },
      { text: JSON.stringify(okIntegration), usage: { inputTokens: 20, outputTokens: 7 } },
    ])
    const outcome = await runIntegration(port, 'q', digest, 3, new AbortController().signal)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind === 'ok') {
      expect(outcome.usage.inputTokens).toBe(30)
      expect(outcome.usage.outputTokens).toBe(12)
    }
  })

  it('marks the final round so the model cannot request follow-up', async () => {
    const { port, calls } = fakeLlm([{ text: JSON.stringify(okIntegration) }])
    await runIntegration(port, 'q', digest, 3, new AbortController().signal, { finalRound: true })
    expect(calls[0]?.user).toContain('FINAL round')
  })
})

describe('parseIntegration v3 hardening', () => {
  const base = { summary: 's', unknowns: [], followup: { needed: false, queries: [] } }

  it('moves points with no valid citation into unknowns instead of keeping them', () => {
    const parsed = parseIntegration({
      ...base,
      points: [
        { text: 'well cited', status: 'supported', sources: [1] },
        { text: 'uncited claim', status: 'supported' },
        { text: 'all fabricated', status: 'supported', sources: [42] },
      ],
    }, 2)
    expect(parsed?.points).toHaveLength(1)
    expect(parsed?.points[0]?.text).toBe('well cited')
    expect(parsed?.unknowns.some((text) => text.includes('uncited claim'))).toBe(true)
    expect(parsed?.unknowns.some((text) => text.includes('all fabricated'))).toBe(true)
  })

  it('scrubs invalid [n] markers from point text and summary', () => {
    const parsed = parseIntegration({
      summary: 'answer [9] here',
      points: [{ text: 'fact [99] with valid [1] and bad [7] refs', status: 'supported', sources: [1] }],
      unknowns: [],
      followup: { needed: false, queries: [] },
    }, 2)
    expect(parsed?.summary).toBe('answer here')
    expect(parsed?.points[0]?.text).toBe('fact with valid [1] and bad refs')
  })

  it('validates and keeps attributed conflict sides', () => {
    const parsed = parseIntegration({
      ...base,
      points: [{
        text: 'params differ',
        status: 'conflict',
        sources: [1, 2],
        sides: [
          { text: 'side A says 300B', sources: [1] },
          { text: 'side B says 320B', sources: [2, 99] },
          { text: 'side C no valid ids', sources: [77] },
        ],
      }],
    }, 2)
    const point = parsed?.points[0]
    expect(point?.sides).toHaveLength(2)
    expect(point?.sides?.[1]?.sources).toEqual([2])
    expect(point?.sides?.[0]?.text).toBe('side A says 300B')
  })

  it('accepts a sides-only point when the flat list is missing', () => {
    const parsed = parseIntegration({
      ...base,
      points: [{
        text: 'conflict via sides',
        status: 'conflict',
        sides: [
          { text: 'A', sources: [1] },
          { text: 'B', sources: [2] },
        ],
      }],
    }, 2)
    expect(parsed?.points).toHaveLength(1)
    expect(parsed?.points[0]?.sources).toEqual([1, 2])
  })

  it('keeps a truncated quote for audit', () => {
    const parsed = parseIntegration({
      ...base,
      points: [{ text: 't', status: 'supported', sources: [1], quote: 'x'.repeat(300) }],
    }, 1)
    expect(parsed?.points[0]?.quote?.length).toBe(120)
  })
})
