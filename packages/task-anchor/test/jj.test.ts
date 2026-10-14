import { describe, expect, it } from 'vitest'
import { readJjFacts, workingLayerArgv, workspaceRootArgv, type ExecFile } from '../src/jj.js'

function okLayer(changeId: string, parents: readonly string[]): string {
  return `${changeId}\n${parents.join(' ')}\n`
}

interface FakeOpts {
  first: string
  root?: string
  recheck?: string
  calls: string[][]
}

function fakeExecResponses(opts: FakeOpts): ExecFile {
  let layerReads = 0
  return async (_file, args) => {
    opts.calls.push([...args])
    if (args.includes('workspace')) {
      return { stdout: `${opts.root ?? '/repo'}\n`, stderr: '', code: 0 }
    }
    layerReads += 1
    return { stdout: layerReads === 1 ? opts.first : (opts.recheck ?? opts.first), stderr: '', code: 0 }
  }
}

describe('argv discipline', () => {
  it('reads change id and parents in ONE process with full ids, read-only flags, no shell', () => {
    const argv = workingLayerArgv()
    expect(argv).toContain('--ignore-working-copy')
    expect(argv).toContain('--no-pager')
    // Shell-metacharacter scan over every arg EXCEPT the -T template (jj's
    // own language uses `|` and quotes; execFile passes argv verbatim).
    const templateIndex = argv.indexOf('-T')
    const nonTemplate = argv.filter((_, i) => i !== templateIndex && i !== templateIndex + 1)
    expect(nonTemplate.join(' ')).not.toMatch(/[;&|`$><]/)
    expect(argv).toContain('-r')
    expect(argv).toContain('@')
    const template = argv[templateIndex + 1] ?? ''
    expect(template).toContain('parents.map(|p| p.change_id())')
    expect(template).not.toContain('.short()')
    expect(workspaceRootArgv()).toContain('workspace')
  })
})

describe('readJjFacts', () => {
  it('reads layer + workspace root + stability recheck (three invocations)', async () => {
    const calls: string[][] = []
    const layer = okLayer('fullchangeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', ['fullparentbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2'])
    const read = await readJjFacts('/repo/sub', fakeExecResponses({ first: layer, root: '/repo', recheck: layer, calls }), 'jj', 5000)
    expect(read).toEqual({
      ok: true,
      facts: {
        changeId: 'fullchangeaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
        parentChangeIds: ['fullparentbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2'],
        workspaceRoot: '/repo',
      },
    })
    expect(calls).toHaveLength(3)
    expect(calls.filter((args) => args.includes('workspace'))).toHaveLength(1)
    expect(calls[0]).toEqual(calls[2])
  })

  it('reports merge commits as an ordered multi-parent list', async () => {
    const layer = okLayer('mergecccccccccccccccccccccccccccccccccccccc3', ['p1ddddddddddddddddddddddddddddddddddddddd4', 'p2eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee5'])
    const read = await readJjFacts('/repo', fakeExecResponses({ first: layer, root: '/repo', recheck: layer, calls: [] }), 'jj', 5000)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.facts.parentChangeIds).toEqual(['p1ddddddddddddddddddddddddddddddddddddddd4', 'p2eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee5'])
  })

  it('a parentless root commit yields an empty parent list', async () => {
    const layer = 'rootfffffffffffffffffffffffffffffffffffffff6\n\n'
    const read = await readJjFacts('/repo', fakeExecResponses({ first: layer, root: '/repo', recheck: layer, calls: [] }), 'jj', 5000)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.facts.parentChangeIds).toEqual([])
  })

  it('fails as drift when the working layer moved between the reads (no retry)', async () => {
    const calls: string[][] = []
    const read = await readJjFacts('/repo', fakeExecResponses({
      first: okLayer('before111111111111111111111111111111111111111111', ['p00000000000000000000000000000000000000000000']),
      recheck: okLayer('after222222222222222222222222222222222222222222', ['p00000000000000000000000000000000000000000000']),
      root: '/repo',
      calls,
    }), 'jj', 5000)
    expect(read).toMatchObject({ ok: false, reason: 'drift' })
    expect(calls).toHaveLength(3)
  })

  it('fails as drift when only the parents were rewired (rebase keeps the change id)', async () => {
    const read = await readJjFacts('/repo', fakeExecResponses({
      first: okLayer('same3333333333333333333333333333333333333333333', ['oldp444444444444444444444444444444444444444444']),
      recheck: okLayer('same3333333333333333333333333333333333333333333', ['newp555555555555555555555555555555555555555555']),
      root: '/repo',
      calls: [],
    }), 'jj', 5000)
    expect(read).toMatchObject({ ok: false, reason: 'drift' })
  })

  it('classifies a non-jj root as not-jj (no git fallback)', async () => {
    const exec: ExecFile = async () => {
      throw Object.assign(new Error('Error: Not a jj repo'), { stderr: 'Error: Not a jj repo (no .jj directory)' })
    }
    const read = await readJjFacts('/repo', exec, 'jj', 5000)
    expect(read).toMatchObject({ ok: false, reason: 'not-jj' })
  })

  it('classifies a killed child as timeout', async () => {
    const exec: ExecFile = async () => {
      throw Object.assign(new Error('spawn timed out'), { killed: true })
    }
    const read = await readJjFacts('/repo', exec, 'jj', 100)
    expect(read).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('classifies other failures as failed, never throwing', async () => {
    const exec: ExecFile = async () => {
      throw new Error('ENOENT: no such file jj')
    }
    const read = await readJjFacts('/repo', exec, 'jj', 5000)
    expect(read).toMatchObject({ ok: false, reason: 'failed' })
  })

  it('rejects empty layer output', async () => {
    const read = await readJjFacts('/repo', fakeExecResponses({ first: '\n\n', recheck: '\n\n', root: '/repo', calls: [] }), 'jj', 5000)
    expect(read).toMatchObject({ ok: false, reason: 'failed' })
  })
})
