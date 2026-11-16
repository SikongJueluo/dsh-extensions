import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { FsDirEntry, FsTarget } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { describe, expect, it } from 'vitest'
import { RecursiveSkillProvider } from '../src/provider.js'
import {
  catalogNames,
  createHarness,
  skillDocument,
  tempDir,
  writeFileAt,
  writeSkill,
} from './helpers.js'

async function seed(root: string): Promise<void> {
  // Direct skills: the stock provider owns these; this provider must skip them.
  await writeSkill(join(root, 'direct'), ['name: direct', 'description: Direct bundle'])
  await writeFileAt(
    join(root, 'flat.md'),
    skillDocument(['name: flat', 'description: Flat markdown skill']),
  )

  // Nested bundles at depth 2 and 3.
  await writeSkill(
    join(root, 'anthropic', 'pdf'),
    ['name: pdf', 'description: PDF skill'],
    '# PDF\n',
  )
  await writeSkill(join(root, 'anthropic', 'docx'), ['name: docx', 'description: DOCX skill'])
  await writeSkill(join(root, 'deep', 'one', 'two'), ['name: deep-two', 'description: Deep skill'])

  // A bundle boundary: resources under a skill directory are not skills.
  await writeSkill(join(root, 'anthropic', 'pdf', 'references', 'nested'), [
    'name: hidden-ref',
    'description: Must never surface',
  ])

  // Arbitrary markdown is not a skill.
  await writeFileAt(join(root, 'anthropic', 'notes.md'), '# Notes\n')

  // Invalid documents are ignored without hiding valid siblings.
  await writeSkill(join(root, 'broken', 'yaml'), ['name: [unclosed'])
  await writeSkill(join(root, 'broken', 'missing'), ['name: no-description'])
  await writeSkill(join(root, 'broken', 'name'), ['name: Bad_Name', 'description: Bad name'])
  await writeSkill(join(root, 'broken', 'invocation'), [
    'name: legacy',
    'description: Legacy invocation',
    'modelInvocable: true',
  ])
  await writeSkill(join(root, 'broken', 'ok'), ['name: sibling', 'description: Sibling survives'])

  // Duplicate names resolve in deterministic scan order.
  await writeSkill(join(root, 'duplicate', 'a'), ['name: dup', 'description: First wins'])
  await writeSkill(join(root, 'duplicate', 'b'), ['name: dup', 'description: Second loses'])

  // Invocation policy is preserved, not re-exposed by the recursive path.
  await writeSkill(join(root, 'policy', 'disabled'), [
    'name: disabled-skill',
    'description: Model-hidden but user-visible',
    'disable-model-invocation: true',
  ])
}

describe('recursive discovery', () => {
  it('discovers nested bundles, skips direct skills and bundle resources', async () => {
    const harness = await createHarness()
    try {
      await seed(harness.skillsRoot)
      const names = await catalogNames(harness.ctx)
      expect(names.toSorted()).toEqual(
        ['deep-two', 'disabled-skill', 'docx', 'dup', 'pdf', 'sibling'].toSorted(),
      )
    } finally {
      await harness.dispose()
    }
  })

  it('loads the body on demand and preserves the directory resource base', async () => {
    const harness = await createHarness()
    try {
      await seed(harness.skillsRoot)
      await catalogNames(harness.ctx)
      const skill = await harness.ctx.skills.get('pdf')
      expect(skill).toBeDefined()
      expect(skill?.content).toBe('# PDF')
      expect(skill?.provider).toBe('recursive-filesystem')
      expect(skill?.source).toBe('user-agents')
      expect(skill?.resourceBase).toEqual({
        kind: 'directory',
        path: join(harness.skillsRoot, 'anthropic', 'pdf'),
      })
      expect(skill?.path).toBe(join(harness.skillsRoot, 'anthropic', 'pdf', 'SKILL.md'))
    } finally {
      await harness.dispose()
    }
  })

  it('preserves invocation policy for duplicated and disabled skills', async () => {
    const harness = await createHarness()
    try {
      await seed(harness.skillsRoot)
      const skills = await harness.ctx.skills.list()
      expect(skills.find((skill) => skill.name === 'disabled-skill')?.invocation).toEqual({
        modelInvocable: false,
        userInvocable: true,
      })
      expect(skills.filter((skill) => skill.name === 'dup')).toHaveLength(1)
      expect((await harness.ctx.skills.get('dup'))?.description).toBe('First wins')
    } finally {
      await harness.dispose()
    }
  })

  it('honours maxDepth and extra roots with their own source label', async () => {
    const extra = await tempDir()
    const harness = await createHarness({ maxDepth: 2, extraRoots: [extra] })
    try {
      await seed(harness.skillsRoot)
      await writeSkill(join(extra, 'vendor', 'lib'), [
        'name: vendor-lib',
        'description: Extra root',
      ])
      const skills = await harness.ctx.skills.list()
      const names = skills.map((skill) => skill.name)
      expect(names).toContain('pdf')
      expect(names).not.toContain('deep-two')
      expect(skills.find((skill) => skill.name === 'vendor-lib')?.source).toBe('custom')
    } finally {
      await harness.dispose()
      await rm(extra, { recursive: true, force: true })
    }
  })

  it('follows symlinked categories and terminates on aliases and loops', async () => {
    const external = await tempDir()
    const harness = await createHarness()
    try {
      await writeSkill(join(external, 'linked-skill'), [
        'name: linked-skill',
        'description: Via symlink',
      ])
      await writeSkill(join(harness.skillsRoot, 'category', 'real'), [
        'name: real-skill',
        'description: Real directory',
      ])
      await symlink(external, join(harness.skillsRoot, 'category', 'external'), 'dir')
      await symlink(
        join(harness.skillsRoot, 'category', 'real'),
        join(harness.skillsRoot, 'category', 'alias'),
        'dir',
      )
      await symlink(harness.skillsRoot, join(harness.skillsRoot, 'category', 'loop'), 'dir')

      const names = await catalogNames(harness.ctx)
      expect(names.toSorted()).toEqual(['linked-skill', 'real-skill'])
      expect(await harness.ctx.skills.get('linked-skill')).toMatchObject({
        content: '# Skill',
      })
    } finally {
      await harness.dispose()
      await rm(external, { recursive: true, force: true })
    }
  })

  it('does not let a deep symlink alias shadow a shallower real directory', async () => {
    const harness = await createHarness()
    try {
      await writeSkill(join(harness.skillsRoot, 'z', 'category', 'pdf'), [
        'name: pdf',
        'description: Real path at depth 3',
      ])
      await mkdir(join(harness.skillsRoot, 'a', 'one'), { recursive: true })
      await symlink(
        join(harness.skillsRoot, 'z'),
        join(harness.skillsRoot, 'a', 'one', 'alias'),
        'dir',
      )
      expect(await catalogNames(harness.ctx)).toEqual(['pdf'])
    } finally {
      await harness.dispose()
    }
  })

  it('reports an incomplete observation when one directory cannot be read', async () => {
    const harness = await createHarness({ fsPlugin: FlakyFileSystem })
    try {
      await seed(harness.skillsRoot)
      await writeSkill(join(harness.skillsRoot, 'flaky', 'broken'), [
        'name: broken-dir',
        'description: Unreadable directory',
      ])
      await writeSkill(join(harness.skillsRoot, 'flaky', 'good'), [
        'name: good-dir',
        'description: Readable sibling',
      ])
      const fs = harness.ctx.fs as FlakyFileSystem
      fs.failList.add(join(harness.skillsRoot, 'flaky', 'broken'))

      const snapshot = await harness.ctx.skills.snapshot()
      expect(snapshot.complete).toBe(false)
      expect(snapshot.skills.map((skill) => skill.name)).toContain('good-dir')
      expect(snapshot.skills.map((skill) => skill.name)).toContain('pdf')
    } finally {
      await harness.dispose()
    }
  })

  it('stops discovery when the lookup signal is already aborted', async () => {
    const harness = await createHarness()
    try {
      await seed(harness.skillsRoot)
      const control = new AbortController()
      const provider = new RecursiveSkillProvider(
        harness.ctx,
        { signal: new AbortController().signal, invalidate() {} },
        {
          providerName: 'recursive-filesystem',
          roots: [{ path: harness.skillsRoot, source: 'user-agents' }],
          maxDepth: 4,
          rank: 501,
          watch: false,
        },
      )
      control.abort()
      await expect(provider.list({ signal: control.signal })).rejects.toThrow()
      await provider.dispose()
    } finally {
      await harness.dispose()
    }
  })

  it('returns candidates without loading bodies', async () => {
    const harness = await createHarness()
    try {
      await seed(harness.skillsRoot)
      const control = new AbortController()
      const provider = new RecursiveSkillProvider(
        harness.ctx,
        { signal: control.signal, invalidate() {} },
        {
          providerName: 'recursive-filesystem',
          roots: [{ path: harness.skillsRoot, source: 'user-agents' }],
          maxDepth: 4,
          rank: 501,
          watch: false,
        },
      )
      try {
        const candidates = await provider.list({})
        expect(Array.isArray(candidates)).toBe(true)
        const list = candidates as readonly { name: string; content?: string }[]
        expect(list.length).toBeGreaterThan(0)
        for (const candidate of list) expect(candidate).not.toHaveProperty('content')
      } finally {
        await provider.dispose()
      }
    } finally {
      await harness.dispose()
    }
  })
})

/** Local filesystem with per-path list failures for the incomplete path. */
class FlakyFileSystem extends LocalFileSystem {
  readonly failList = new Set<string>()

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    if (this.failList.has(target.displayPath)) {
      throw Object.assign(new Error('simulated list failure'), { code: 'FS_IO_ERROR' })
    }
    return super.listDir(target, signal)
  }
}
