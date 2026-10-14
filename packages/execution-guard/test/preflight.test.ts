import { describe, expect, it } from 'vitest'
import { checkBatch, checkCall, describeShape } from '../src/preflight.js'

const readSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    offset: { type: 'integer' },
  },
  required: ['file_path'],
} as const

const writeSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string' },
    content: { type: 'string' },
  },
  required: ['file_path', 'content'],
} as const

const schemas: Record<string, unknown> = { read: readSchema, write: writeSchema }
const schemaOf = (tool: string): unknown | undefined => schemas[tool]

describe('checkCall', () => {
  it('accepts arguments satisfying the schema (parsed args)', () => {
    expect(checkCall(readSchema, { tool: 'read', callId: 'a', args: { file_path: 'x' } })).toEqual({ kind: 'valid' })
  })

  it('reports a missing required property with its field name', () => {
    const verdict = checkCall(readSchema, { tool: 'read', callId: 'a', args: {} })
    expect(verdict.kind).toBe('invalid')
    if (verdict.kind !== 'invalid') return
    expect(verdict.violations[0]).toContain('file_path')
  })

  it('reports a type violation on the offending field', () => {
    const verdict = checkCall(readSchema, { tool: 'read', callId: 'a', args: { file_path: 7 } })
    expect(verdict.kind).toBe('invalid')
    if (verdict.kind !== 'invalid') return
    expect(verdict.violations.join(' ')).toContain('file_path')
  })

  it('maps ONLY the exact empty string to no-arguments (host parseRaw parity)', () => {
    const noArgsSchema = {
      type: 'object',
      properties: { verbose: { type: 'boolean' } },
    } as const
    expect(checkCall(noArgsSchema, { tool: 'list', callId: 'a', argsRaw: '' })).toEqual({ kind: 'valid' })
    // Blank whitespace is truthy on the host: JSON.parse throws and the
    // schema sees a parse failure — strict parity, not a wider allowance.
    expect(checkCall(noArgsSchema, { tool: 'list', callId: 'a', argsRaw: '   ' })).toEqual({
      kind: 'invalid',
      violations: ['arguments: not valid JSON'],
    })
    // Against a schema with required keys the empty form reports the
    // missing property — proving it parsed as {} rather than as JSON junk.
    expect(checkCall(readSchema, { tool: 'read', callId: 'a', argsRaw: '' })).toMatchObject({ kind: 'invalid' })
  })

  it('parses raw sibling JSON and rejects malformed JSON', () => {
    expect(checkCall(readSchema, { tool: 'read', callId: 'a', argsRaw: '{"file_path":"x"}' })).toEqual({ kind: 'valid' })
    expect(checkCall(readSchema, { tool: 'read', callId: 'a', argsRaw: '{file_path' })).toEqual({
      kind: 'invalid',
      violations: ['arguments: not valid JSON'],
    })
  })

  it('marks an unsupported schema unchecked instead of guessing', () => {
    const bogus = { type: 'string', minLength: 3 }
    expect(checkCall(bogus, { tool: 'x', callId: 'a', args: 'ab' })).toEqual({
      kind: 'unchecked',
      why: 'unsupported-schema',
    })
  })

  it('marks a call without any argument source unchecked', () => {
    expect(checkCall(readSchema, { tool: 'read', callId: 'a' })).toEqual({ kind: 'unchecked', why: 'no-schema' })
  })
})

describe('checkBatch', () => {
  it('allows a fully legal batch', () => {
    const decision = checkBatch(
      [
        { tool: 'read', callId: 'a', args: { file_path: 'x' } },
        { tool: 'write', callId: 'b', args: { file_path: 'y', content: 'z' } },
      ],
      schemaOf,
    )
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('denies the whole batch when one member misses a key, naming tool/callId/field', () => {
    const decision = checkBatch(
      [
        { tool: 'read', callId: 'a', args: { file_path: 'x' } },
        { tool: 'write', callId: 'b', args: { file_path: 'y' } },
      ],
      schemaOf,
    )
    expect(decision.kind).toBe('deny')
    if (decision.kind !== 'deny') return
    expect(decision.invalid).toHaveLength(1)
    expect(decision.invalid[0]).toMatchObject({ tool: 'write', callId: 'b' })
    expect(decision.reason).toContain('write')
    expect(decision.reason).toContain('b')
    expect(decision.reason).toContain('content')
  })

  it('does not deny a batch over unknown tools or unsupported schemas', () => {
    const decision = checkBatch(
      [
        { tool: 'mystery', callId: 'a', args: { whatever: 1 } },
        { tool: 'read', callId: 'b', args: { file_path: 'x' } },
      ],
      schemaOf,
    )
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('keeps malformed sibling JSON a batch-level deny', () => {
    const decision = checkBatch(
      [
        { tool: 'read', callId: 'a', argsRaw: '{"file_path":"x"}' },
        { tool: 'write', callId: 'b', argsRaw: 'not json' },
      ],
      schemaOf,
    )
    expect(decision.kind).toBe('deny')
  })
})

describe('describeShape', () => {
  it('summarizes required/optional fields and openness', () => {
    const text = describeShape(writeSchema)
    expect(text).toContain('file_path: string (required)')
    expect(text).toContain('content: string (required)')
    expect(text).toContain('undeclared keys allowed')
  })

  it('degrades gracefully outside the enforced subset', () => {
    expect(describeShape({ minLength: 2 })).toContain('outside the enforced subset')
  })
})
