import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { currentStepCalls, lastHumanSeq } from '../src/batch.js'

let seq = 0
function ev(type: string, data: Record<string, unknown>): SessionEvent {
  seq += 1
  return { type, seq, time: 0, data } as unknown as SessionEvent
}

function assistantMessage(blocks: unknown[]): SessionEvent {
  return ev('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: blocks },
    stream: [],
  })
}

function block(callId: string, name: string, args: string): unknown {
  return { type: 'tool-call', id: callId, name, arguments: args }
}

describe('currentStepCalls (assistant-message batch source)', () => {
  it('returns the whole batch from the last assistant tool-call message', () => {
    const events = [
      assistantMessage([block('c1', 'read', '{"file_path":"a"}')]),
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a"}' }),
      assistantMessage([
        block('c2', 'write', '{"file_path":"b","content":"x"}'),
        { type: 'text', text: 'doing two things' },
        block('c3', 'read', '{"file_path":"c"}'),
      ]),
    ]
    const calls = currentStepCalls(events)
    expect(calls.map((c) => c.callId)).toEqual(['c2', 'c3'])
    expect(calls[0]).toMatchObject({ tool: 'write', argsRaw: '{"file_path":"b","content":"x"}' })
  })

  it('sees the full batch even when only the first tool/call event exists (host appends one at a time)', () => {
    const events = [
      assistantMessage([block('c1', 'read', '{"file_path":"a"}'), block('c2', 'write', '{}')]),
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a"}' }),
    ]
    expect(currentStepCalls(events).map((c) => c.callId)).toEqual(['c1', 'c2'])
  })

  it('stops at the latest assistant message even without tool-call blocks', () => {
    const events = [
      assistantMessage([block('c1', 'read', '{"file_path":"a"}')]),
      assistantMessage([{ type: 'text', text: 'plain answer' }]),
    ]
    expect(currentStepCalls(events)).toEqual([])
  })

  it('yields nothing before any assistant message', () => {
    expect(currentStepCalls([ev('turn/start', { turn: 1 })])).toEqual([])
  })

  it('skips malformed tool-call blocks rather than crashing', () => {
    const events = [
      assistantMessage([
        { type: 'tool-call', id: 7, name: 'read', arguments: '{}' },
        block('c2', 'read', '{"file_path":"x"}'),
      ]),
    ]
    expect(currentStepCalls(events).map((c) => c.callId)).toEqual(['c2'])
  })
})

describe('lastHumanSeq', () => {
  it('finds the latest human user/message and ignores synthetic sources', () => {
    const events = [
      ev('user/message', { source: { kind: 'user' }, content: [] }),
      ev('user/message', { source: { kind: 'agent-inject' }, content: [] }),
      ev('user/message', { source: { kind: 'user' }, content: [] }),
    ]
    const humanSeqs = events.filter((e) => e.type === 'user/message').map((e) => e.seq)
    expect(lastHumanSeq(events)).toBe(humanSeqs[2])
  })

  it('returns -1 with no human message', () => {
    expect(lastHumanSeq([ev('user/message', { source: { kind: 'agent-inject' }, content: [] })])).toBe(-1)
  })
})
