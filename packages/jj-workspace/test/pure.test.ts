import { describe, expect, it } from 'vitest'
import { isWithin, listBookmarks, parseTaskRecords, serializeTaskRecord, type JjTaskRecord, type JjWorkspaceHost } from '../src/jj.js'
import { validateProcessConfig } from '../src/process.js'

const record: JjTaskRecord = {
  version: 1,
  sessionId: 'session-1',
  projectRoot: '/project',
  workspace: 'task',
  path: '/project/.agents/workspaces/task',
  bookmark: 'task',
  changeId: 'abc',
  baseChange: 'def',
  baseCommit: '0123456789abcdef',
  origin: 'ui',
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('task records', () => {
  it('round-trips one JSON line per record', () => {
    const text = serializeTaskRecord(record) + serializeTaskRecord({ ...record, workspace: 'two' })
    expect(parseTaskRecords(text)).toEqual([record, { ...record, workspace: 'two' }])
  })
})

describe('bookmark parsing', () => {
  it('keeps only local present refs and never lets a remote row overwrite one', async () => {
    const host: JjWorkspaceHost = {
      run: async () =>
        [
          'task\t\ttrue\tfalse\tlocal-change',
          'task\torigin\ttrue\tfalse\tremote-old',
          'other\t\tfalse\tfalse\t',
          'conflict\t\ttrue\ttrue\t',
        ].join('\n'),
      exists: async () => false,
      prepare: async () => {},
    }
    const bookmarks = await listBookmarks(host, '/project', new AbortController().signal)
    expect(bookmarks.get('task')).toEqual({ name: 'task', conflict: false, changeId: 'local-change' })
    expect(bookmarks.has('other')).toBe(false)
    expect(bookmarks.get('conflict')).toEqual({ name: 'conflict', conflict: true, changeId: '' })
  })
})

describe('isWithin', () => {
  it('accepts equality and descendants, rejects siblings and traversal', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true)
    expect(isWithin('/a/b', '/a/b/c')).toBe(true)
    expect(isWithin('/a/b', '/a/c')).toBe(false)
    expect(isWithin('/a/b', '/a/b/../c')).toBe(false)
  })
})

describe('validateProcessConfig', () => {
  const valid = {
    jjCommand: 'jj',
    nodeCommand: 'node',
    timeoutMs: 60_000,
    graceMs: 3_000,
    maxOutputBytes: 65_536,
    workspaceDirectory: '.agents/workspaces',
  }

  it('accepts the defaults', () => {
    expect(() => validateProcessConfig(valid)).not.toThrow()
  })

  it('rejects an absolute or dot-segment pool', () => {
    expect(() => validateProcessConfig({ ...valid, workspaceDirectory: '/tmp/ws' })).toThrow()
    expect(() => validateProcessConfig({ ...valid, workspaceDirectory: '../ws' })).toThrow()
    expect(() => validateProcessConfig({ ...valid, workspaceDirectory: 'a/../b' })).toThrow()
  })

  it('rejects an empty command and invalid limit', () => {
    expect(() => validateProcessConfig({ ...valid, jjCommand: ' ' })).toThrow()
    expect(() => validateProcessConfig({ ...valid, timeoutMs: 0 })).toThrow()
  })
})
