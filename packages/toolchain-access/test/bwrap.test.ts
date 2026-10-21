/**
 * Pinned-layout tests for the bwrap splice: the exact stock profile shape
 * both confined modes must have, where grant binds land, and every way a
 * non-stock layout fails closed instead of being edited.
 *
 * @module dsh-toolchain-access/bwrap.test
 */
import { describe, expect, it } from 'vitest'
import { GrantArgvError, expectedStockProfileArgs, insertGrantBinds } from '../src/bwrap.js'
import type { GrantBindSpec } from '../src/bwrap.js'

const POLICY = {
  mode: 'workspace-write',
  workspaceRoot: '/ws/proj',
} as const

const READ_ONLY = {
  mode: 'read-only',
  workspaceRoot: '/ws/proj',
} as const

const HEAD = [
  '--ro-bind', '/', '/',
  '--dev', '/dev',
  '--unshare-pid',
  '--proc', '/proc',
  '--die-with-parent',
]

const WS_TAIL = ['--tmpfs', '/tmp', '--bind', '/ws/proj', '/ws/proj']

function stockConfined(policy: typeof POLICY | typeof READ_ONLY, command: readonly string[]): string[] {
  return ['bwrap', ...expectedStockProfileArgs(policy), '--', ...command]
}

const BIND: GrantBindSpec = { source: '/home/u/.cache/uv', destination: '/home/u/.cache/uv' }

describe('expectedStockProfileArgs', () => {
  it('workspace-write appends tmpfs and the canonical workspace bind', () => {
    expect(expectedStockProfileArgs(POLICY)).toEqual([...HEAD, ...WS_TAIL])
  })

  it('read-only is the head alone', () => {
    expect(expectedStockProfileArgs(READ_ONLY)).toEqual(HEAD)
  })
})

describe('insertGrantBinds', () => {
  it('splices binds after the stock profile, before the separator', () => {
    const command = ['cargo', 'build']
    const confined = stockConfined(POLICY, command)
    expect(insertGrantBinds(confined, command, POLICY, [BIND])).toEqual([
      'bwrap', ...HEAD, ...WS_TAIL,
      '--bind', '/home/u/.cache/uv', '/home/u/.cache/uv',
      '--', 'cargo', 'build',
    ])
  })

  it('keeps multiple binds in order', () => {
    const command = ['true']
    const result = insertGrantBinds(stockConfined(POLICY, command), command, POLICY, [
      { source: '/a', destination: '/a' },
      { source: '/b', destination: '/b' },
    ])
    expect(result.slice(-8)).toEqual(['--bind', '/a', '/a', '--bind', '/b', '/b', '--', 'true'])
  })

  it('a command argument containing "--" cannot move the splice point', () => {
    const command = ['printf', '--', '--ro-bind', '/etc', '/etc']
    const confined = stockConfined(POLICY, command)
    const result = insertGrantBinds(confined, command, POLICY, [BIND])
    // The bind lands before the FIRST "--" only because the whole tail was
    // verified to equal the command verbatim; the command's own "--" stays
    // in place after it.
    expect(result).toEqual([
      'bwrap', ...HEAD, ...WS_TAIL,
      '--bind', '/home/u/.cache/uv', '/home/u/.cache/uv',
      '--', 'printf', '--', '--ro-bind', '/etc', '/etc',
    ])
  })

  it('read-only stock wraps splice identically (position is layout-driven)', () => {
    const command = ['true']
    const result = insertGrantBinds(stockConfined(READ_ONLY, command), command, READ_ONLY, [BIND])
    expect(result).toEqual([
      'bwrap', ...HEAD,
      '--bind', '/home/u/.cache/uv', '/home/u/.cache/uv',
      '--', 'true',
    ])
  })

  it('empty binds return the argv unchanged without layout assumptions', () => {
    const weird = ['/some/wrapper', '--whatever']
    expect(insertGrantBinds(weird, [], READ_ONLY, [])).toEqual(weird)
  })
})

describe('fail-closed on non-stock layouts', () => {
  const command = ['cargo', 'build']

  it('a runnerCommand wrapper prefix is refused', () => {
    const wrapped = ['/opt/bwrap-shim', ...expectedStockProfileArgs(POLICY), '--', ...command]
    expect(() => insertGrantBinds(wrapped, command, POLICY, [BIND])).toThrow(GrantArgvError)
    expect(() => insertGrantBinds(wrapped, command, POLICY, [BIND])).toThrow(/runner is "\/opt\/bwrap-shim"/)
  })

  it('a mutated profile element is refused with its index', () => {
    const mutated = stockConfined(POLICY, command)
    mutated[3] = '/dev/null'
    expect(() => insertGrantBinds(mutated, command, POLICY, [BIND])).toThrow(/profile argument 2/)
  })

  it('an extra profile argument shifts the separator and is refused', () => {
    const extra = ['bwrap', ...expectedStockProfileArgs(POLICY), '--new-flag', '--', ...command]
    expect(() => insertGrantBinds(extra, command, POLICY, [BIND])).toThrow(/"--" separator/)
  })

  it('a missing separator is refused', () => {
    const noSep = ['bwrap', ...expectedStockProfileArgs(POLICY), ...command]
    expect(() => insertGrantBinds(noSep, command, POLICY, [BIND])).toThrow(/separator/)
  })

  it('a tail that differs from the caller argv is refused', () => {
    const swapped = ['bwrap', ...expectedStockProfileArgs(POLICY), '--', 'cargo', 'build', '--release']
    expect(() => insertGrantBinds(swapped, command, POLICY, [BIND])).toThrow(/caller argv/)
  })

  it('the Landlock launcher is not the stock runner and is refused', () => {
    const landlock = ['/usr/lib/landlock-run', '--ro', '/', '--', ...command]
    expect(() => insertGrantBinds(landlock, command, POLICY, [BIND])).toThrow(GrantArgvError)
  })
})
