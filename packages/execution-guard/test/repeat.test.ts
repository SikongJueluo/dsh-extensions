import { describe, expect, it } from 'vitest'
import { RepeatTracker, fingerprint, hintableCalls, MAX_FINGERPRINTS } from '../src/repeat.js'

describe('fingerprint', () => {
  it('collapses indices and string values so same-shape failures match', () => {
    const a = fingerprint('write', ['arguments.foo[2]: expected string'])
    const b = fingerprint('write', ['arguments.foo[7]: expected string'])
    expect(a).toBe(b)
  })

  it('keeps distinct field names distinct', () => {
    expect(fingerprint('write', ['arguments.file_path: required property missing']))
      .not.toBe(fingerprint('write', ['arguments.content: required property missing']))
  })

  it('separates tools', () => {
    expect(fingerprint('read', ['x'])).not.toBe(fingerprint('write', ['x']))
  })
})

describe('RepeatTracker', () => {
  it('counts same-shape failures and resets on success of that tool', () => {
    const t = new RepeatTracker()
    const v = ['arguments.file_path: required property missing']
    expect(t.noteFailure('write', v)).toBe(1)
    expect(t.noteFailure('write', v)).toBe(2)
    expect(t.noteFailure('write', v)).toBe(3)
    t.noteSuccess('write')
    expect(t.noteFailure('write', v)).toBe(1)
  })

  it('resets everything on a new human turn', () => {
    const t = new RepeatTracker()
    t.noteFailure('write', ['a'])
    t.noteHumanSeq(5)
    t.noteFailure('write', ['a'])
    t.noteHumanSeq(9)
    expect(t.noteFailure('write', ['a'])).toBe(1)
  })

  it('ignores stale/out-of-order human seq', () => {
    const t = new RepeatTracker()
    t.noteHumanSeq(10)
    t.noteFailure('write', ['a'])
    t.noteFailure('write', ['a'])
    t.noteHumanSeq(3)
    t.noteFailure('write', ['a'])
    expect(t.noteFailure('write', ['a'])).toBe(4)
  })

  it('stays bounded by evicting the oldest fingerprint', () => {
    const t = new RepeatTracker()
    for (let i = 0; i < MAX_FINGERPRINTS + 10; i += 1) {
      t.noteFailure(`tool${i}`, [`violation ${i}`])
    }
    expect(t.noteFailure('tool0', ['violation 0'])).toBe(1)
    expect(t.noteFailure(`tool${MAX_FINGERPRINTS + 9}`, [`violation ${MAX_FINGERPRINTS + 9}`])).toBe(2)
  })
})

describe('hintableCalls', () => {
  const deny = {
    kind: 'deny' as const,
    reason: 'r',
    invalid: [
      { tool: 'write', callId: 'a', violations: ['x'] },
      { tool: 'write', callId: 'b', violations: ['y'] },
    ],
    unchecked: [],
  }

  it('selects only calls at their second+ same-shape failure', () => {
    expect(hintableCalls(deny, new Map([['b', 2]]))).toEqual(['b'])
    expect(hintableCalls(deny, new Map([['a', 1], ['b', 3]]))).toEqual(['b'])
    expect(hintableCalls(deny, new Map())).toEqual([])
  })
})
