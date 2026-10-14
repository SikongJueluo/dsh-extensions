import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { AnchorStore, compareAnchor, parseAnchor, type TaskAnchor } from '../src/checkpoint.js'

const tempRoots: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'exec-guard-'))
  tempRoots.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(tempRoots.map((dir) => rm(dir, { recursive: true, force: true })))
})

function anchor(overrides: Partial<TaskAnchor> = {}): TaskAnchor {
  return {
    schemaVersion: 2,
    sessionId: 's1',
    createdAt: 1234,
    repoRoot: '/repo',
    phase: 'implement',
    ownedFiles: ['src/a.ts'],
    verification: 'vitest run green',
    vcs: { tool: 'jj', changeId: 'c1', parentChangeIds: ['p1'] },
    ...overrides,
  }
}

describe('compareAnchor', () => {
  it('reports every field matching when unchanged', () => {
    const c = compareAnchor(anchor({ goal: { goalId: 'g', revision: 4, phase: 'active', proof: 'fold-agrees' } }), {
      repoRoot: '/repo',
      changeId: 'c1',
      parentChangeIds: ['p1'],
      goalId: 'g',
      goalRevision: 4,
      goalPhase: 'active',
    })
    expect(c).toEqual({ rootMatches: true, changeMatches: true, parentsMatch: true, goalIdMatches: true, goalRevisionMatches: true, goalPhaseMatches: true })
  })

  it('reports mismatch on root / change / parents / goal identity drift', () => {
    const c = compareAnchor(anchor({ goal: { goalId: 'g', revision: 2, phase: 'blocked', proof: 'fold-agrees' } }), {
      repoRoot: '/other',
      changeId: 'c2',
      parentChangeIds: ['p2'],
      goalId: 'other',
      goalRevision: 5,
      goalPhase: 'active',
    })
    expect(c).toEqual({ rootMatches: false, changeMatches: false, parentsMatch: false, goalIdMatches: false, goalRevisionMatches: false, goalPhaseMatches: false })
  })

  it('parents compare as an ordered list: same set, different order is drift', () => {
    const a = anchor({ vcs: { tool: 'jj', changeId: 'm', parentChangeIds: ['a', 'b'] } })
    expect(compareAnchor(a, { parentChangeIds: ['b', 'a'] }).parentsMatch).toBe(false)
    expect(compareAnchor(a, { parentChangeIds: ['a', 'b'] }).parentsMatch).toBe(true)
    expect(compareAnchor(a, { parentChangeIds: ['a'] }).parentsMatch).toBe(false)
  })

  it('a completed current goal never matches an active anchor (phase-aware)', () => {
    const a = anchor({ goal: { goalId: 'g', revision: 2, phase: 'active', proof: 'fold-agrees' } })
    expect(compareAnchor(a, { goalId: 'g', goalRevision: 2, goalPhase: 'complete' }).goalPhaseMatches).toBe(false)
    expect(compareAnchor(a, { goalId: 'g', goalRevision: 2, goalPhase: 'blocked' }).goalPhaseMatches).toBe(false)
    expect(compareAnchor(a, { goalId: 'g', goalRevision: 2, goalPhase: 'active' }).goalPhaseMatches).toBe(true)
  })

  it('reads absent facts as unknown, never as a match', () => {
    const c = compareAnchor(anchor(), {})
    expect(c).toEqual({ rootMatches: undefined, changeMatches: undefined, parentsMatch: undefined, goalIdMatches: undefined, goalRevisionMatches: undefined, goalPhaseMatches: undefined })
  })

  it('goal drift alone does not affect vcs fields', () => {
    const c = compareAnchor(anchor({ goal: { goalId: 'g', revision: 2, proof: 'args-only-unverified' } }), {
      repoRoot: '/repo',
      goalId: 'g',
      goalRevision: 9,
    })
    expect(c.rootMatches).toBe(true)
    expect(c.goalRevisionMatches).toBe(false)
  })
})

describe('parseAnchor', () => {
  it('round-trips a valid anchor with parents and phase', () => {
    const a = anchor({ vcs: { tool: 'jj', changeId: 'm', parentChangeIds: ['a', 'b'] }, goal: { goalId: 'g', revision: 1, phase: 'blocked', proof: 'fold-agrees' } })
    expect(parseAnchor(JSON.stringify(a))).toEqual(a)
  })

  it('rejects malformed JSON, wrong schemaVersion (v1 single-parent era), bad vcs, and bad phase', () => {
    expect(parseAnchor('{')).toBeUndefined()
    expect(parseAnchor(JSON.stringify(anchor({ schemaVersion: 1 as never })))).toBeUndefined()
    expect(parseAnchor(JSON.stringify({ ...anchor(), vcs: { tool: 'jj', changeId: 'm' } }))).toBeUndefined()
    expect(parseAnchor(JSON.stringify({ ...anchor(), goal: { goalId: 'g', revision: 1, phase: 'dormant', proof: 'fold-agrees' } }))).toBeUndefined()
  })
})

describe('AnchorStore', () => {
  it('saves and loads an anchor atomically in a temp dir', async () => {
    const dir = await tempDir()
    const store = new AnchorStore(dir)
    await store.save(anchor())
    const loaded = await store.load('s1')
    expect(loaded).toEqual(anchor())
  })

  it('sanitizes session ids into file names', () => {
    const store = new AnchorStore('/tmp/x')
    const base = store.pathFor('a/b c:d').split('/').pop() ?? ''
    expect(base).toBe('a_b_c_d.json')
  })

  it('returns undefined for a missing anchor without reporting a problem', async () => {
    const problems: string[] = []
    const store = new AnchorStore(await tempDir(), { onProblem: (m) => problems.push(m) })
    expect(await store.load('none')).toBeUndefined()
    expect(problems).toEqual([])
  })

  it('reports corrupt and unsupported anchors through onProblem, not silently', async () => {
    const problems: string[] = []
    const dir = await tempDir()
    const store = new AnchorStore(dir, { onProblem: (m) => problems.push(m) })
    await store.save(anchor())
    const target = store.pathFor('s1')
    await writeFile(target, '{ corrupt')
    expect(await store.load('s1')).toBeUndefined()
    const v1 = JSON.stringify({ ...anchor(), schemaVersion: 1 })
    await writeFile(target, v1)
    expect(await store.load('s1')).toBeUndefined()
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('corrupt or unsupported')
    expect(problems[1]).toContain('corrupt or unsupported')
  })

  it('keeps the previous anchor when a save fails mid-way (atomic fail-safe)', async () => {
    const dir = await tempDir()
    const store = new AnchorStore(dir)
    await store.save(anchor())
    const target = store.pathFor('s1')
    await writeFile(`${target}.corrupt`, '{ partial')
    const loaded = await store.load('s1')
    expect(loaded).toEqual(anchor())
    const raw = await readFile(target, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
