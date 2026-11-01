import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { describe, expect, it } from 'vitest'
import {
  catalogNames,
  createHarness,
  eventually,
  skillDocument,
  writeSkill,
} from './helpers.js'

describe('hot refresh', () => {
  it('discovers a newly created category and skill without restarting', async () => {
    const harness = await createHarness({ watch: true })
    try {
      await writeSkill(join(harness.skillsRoot, 'category', 'first'), [
        'name: first',
        'description: First skill',
      ])
      expect(await catalogNames(harness.ctx)).toContain('first')

      await writeSkill(join(harness.skillsRoot, 'later', 'second'), [
        'name: second',
        'description: Created after startup',
      ])
      await eventually(
        async () => (await catalogNames(harness.ctx)).includes('second'),
        'new nested skill to appear',
      )
    } finally {
      await harness.dispose()
    }
  })

  it('replaces the catalog when frontmatter routing fields change', async () => {
    const harness = await createHarness({ watch: true })
    const directory = join(harness.skillsRoot, 'category', 'pdf')
    try {
      await writeSkill(directory, ['name: pdf', 'description: Old description'])
      expect((await harness.ctx.skills.list()).find((skill) => skill.name === 'pdf')?.description)
        .toBe('Old description')

      await writeSkill(directory, ['name: pdf', 'description: Updated description'])
      await eventually(
        async () =>
          (await harness.ctx.skills.list()).find((skill) => skill.name === 'pdf')?.description ===
          'Updated description',
        'updated description to reach the catalog',
      )
    } finally {
      await harness.dispose()
    }
  })

  it('removes a deleted skill and reloads edited bodies without replacing the catalog', async () => {
    const harness = await createHarness({ watch: true })
    const directory = join(harness.skillsRoot, 'category', 'pdf')
    try {
      const path = await writeSkill(
        directory,
        ['name: pdf', 'description: PDF skill'],
        '# Original body\n',
      )
      expect(await catalogNames(harness.ctx)).toContain('pdf')
      expect((await harness.ctx.skills.get('pdf'))?.content).toBe('# Original body')

      await writeFile(
        path,
        skillDocument(['name: pdf', 'description: PDF skill'], '# Updated body\n'),
      )
      expect((await harness.ctx.skills.get('pdf'))?.content).toBe('# Updated body')

      await rm(directory, { recursive: true, force: true })
      await eventually(
        async () => !(await catalogNames(harness.ctx)).includes('pdf'),
        'deleted skill to leave the catalog',
      )
    } finally {
      await harness.dispose()
    }
  })

  it('upgrades an absent-root watcher and keeps discovering later categories', async () => {
    const harness = await createHarness({ watch: true })
    try {
      await rm(harness.skillsRoot, { recursive: true, force: true })
      expect(await catalogNames(harness.ctx)).toEqual([])

      await writeSkill(join(harness.skillsRoot, 'one', 'first'), [
        'name: first',
        'description: Root created after startup',
      ])
      await eventually(
        async () => (await catalogNames(harness.ctx)).includes('first'),
        'the first category after root creation',
      )

      // The root watcher was opened in absent mode. A later category is only
      // observed if the watcher is replaced once the root is a directory.
      await writeSkill(join(harness.skillsRoot, 'two', 'second'), [
        'name: second',
        'description: Second category after the root appeared',
      ])
      await eventually(
        async () => (await catalogNames(harness.ctx)).includes('second'),
        'a second category without any unrelated event',
      )
    } finally {
      await harness.dispose()
    }
  })

  it('keeps discovering categories after the root is deleted and recreated', async () => {
    const harness = await createHarness({ watch: true })
    try {
      await writeSkill(join(harness.skillsRoot, 'one', 'first'), [
        'name: first',
        'description: First skill',
      ])
      await eventually(
        async () => (await catalogNames(harness.ctx)).includes('first'),
        'the original skill',
      )

      await rm(harness.skillsRoot, { recursive: true, force: true })
      await eventually(
        async () => (await catalogNames(harness.ctx)).length === 0,
        'the deleted root to empty the catalog',
      )

      await writeSkill(join(harness.skillsRoot, 'two', 'second'), [
        'name: second',
        'description: Recreated root',
      ])
      await eventually(
        async () => (await catalogNames(harness.ctx)).includes('second'),
        'a skill under the recreated root',
      )
    } finally {
      await harness.dispose()
    }
  })

  it('watches an absent root and discovers it when it appears', async () => {
    const harness = await createHarness({ watch: true })
    try {
      await rm(harness.skillsRoot, { recursive: true, force: true })
      expect(await catalogNames(harness.ctx)).toEqual([])

      await writeSkill(join(harness.skillsRoot, 'created', 'skill'), [
        'name: created-skill',
        'description: Root created after startup',
      ])
      await eventually(
        async () => (await catalogNames(harness.ctx)).includes('created-skill'),
        'a skill created together with its root',
      )
    } finally {
      await harness.dispose()
    }
  })

  it('follows a re-pointed SKILL.md symlink, including a name change', async () => {
    const harness = await createHarness({ watch: true })
    const directory = join(harness.skillsRoot, 'category', 'linked')
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, 'old.md'),
        skillDocument(['name: old-name', 'description: Old target']),
      )
      await writeFile(
        join(directory, 'new.md'),
        skillDocument(['name: new-name', 'description: New target']),
      )
      const link = join(directory, 'SKILL.md')
      await symlink('old.md', link)
      expect(await catalogNames(harness.ctx)).toEqual(['old-name'])

      await rm(link)
      await symlink('new.md', link)
      await eventually(
        async () => (await catalogNames(harness.ctx)).includes('new-name'),
        're-pointed SKILL.md to replace the catalog entry',
      )
      expect(await catalogNames(harness.ctx)).not.toContain('old-name')
    } finally {
      await harness.dispose()
    }
  })

  it('does not cache away a change made before the first watcher is ready', async () => {
    const harness = await createHarness({ watch: true, fsPlugin: FirstWatchWritesFileSystem })
    const fs = harness.ctx.fs as FirstWatchWritesFileSystem
    try {
      await writeSkill(join(harness.skillsRoot, 'category', 'first'), [
        'name: first',
        'description: Before the watcher',
      ])
      fs.missedRoot = harness.skillsRoot
      const first = await catalogNames(harness.ctx)
      expect(first.sort()).toEqual(['first', 'missed'])
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect((await catalogNames(harness.ctx)).sort()).toEqual(['first', 'missed'])
    } finally {
      await harness.dispose()
    }
  })

  it('waits for a watcher close started by a runtime error before disposal resolves', async () => {
    const harness = await createHarness({ watch: true, fsPlugin: DeferredCloseFileSystem })
    const fs = harness.ctx.fs as DeferredCloseFileSystem
    let disposalResolved = false
    try {
      await writeSkill(join(harness.skillsRoot, 'category', 'pdf'), [
        'name: pdf',
        'description: PDF skill',
      ])
      await catalogNames(harness.ctx)
      expect(fs.opened).toBeGreaterThan(0)
      fs.callbacks[0]?.(new Error('simulated watcher failure'))

      const disposal = harness.ctx.fiber.dispose().then(() => {
        disposalResolved = true
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(disposalResolved).toBe(false)

      fs.releaseGate()
      await disposal
      expect(disposalResolved).toBe(true)
      expect(fs.closed).toBe(fs.opened)
    } finally {
      fs.releaseGate()
      await harness.ctx.fiber.dispose().catch(() => undefined)
      await rm(harness.home, { recursive: true, force: true })
    }
  })

  it('closes every watcher it opened when the plugin unloads', async () => {
    const harness = await createHarness({ watch: true, fsPlugin: CountingFileSystem })
    const directory = join(harness.skillsRoot, 'category', 'pdf')
    await writeSkill(directory, ['name: pdf', 'description: PDF skill'])
    await catalogNames(harness.ctx)
    const fs = harness.ctx.fs as CountingFileSystem
    expect(fs.opened).toBeGreaterThan(0)

    await harness.dispose()
    expect(fs.closed).toBe(fs.opened)
  })
})

/** Counts watch handles so teardown can be observed, not assumed. */
class CountingFileSystem extends LocalFileSystem {
  opened = 0
  closed = 0

  override async watch(
    target: FsTarget,
    changed: (error?: Error) => void,
    signal: AbortSignal,
  ): Promise<() => Promise<void>> {
    this.opened += 1
    const close = await super.watch(target, changed, signal)
    return async () => {
      this.closed += 1
      await close()
    }
  }
}

/** Writes a new nested skill from the first watch call, before it observes. */
class FirstWatchWritesFileSystem extends LocalFileSystem {
  missedRoot: string | undefined
  private armed = true

  override async watch(
    target: FsTarget,
    changed: (error?: Error) => void,
    signal: AbortSignal,
  ): Promise<() => Promise<void>> {
    if (this.armed && this.missedRoot !== undefined) {
      this.armed = false
      await writeSkill(join(this.missedRoot, 'later', 'missed'), [
        'name: missed',
        'description: Created during watcher setup',
      ])
    }
    return await super.watch(target, changed, signal)
  }
}

/** Lets one watcher close be delayed until the test releases it. */
class DeferredCloseFileSystem extends LocalFileSystem {
  opened = 0
  closed = 0
  readonly callbacks: Array<(error?: Error) => void> = []
  private release: () => void = () => undefined
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })

  releaseGate(): void {
    this.release()
  }

  override async watch(
    target: FsTarget,
    changed: (error?: Error) => void,
    signal: AbortSignal,
  ): Promise<() => Promise<void>> {
    const close = await super.watch(target, changed, signal)
    const index = this.opened
    this.opened += 1
    this.callbacks.push(changed)
    if (index === 0) {
      return async () => {
        await this.gate
        this.closed += 1
        await close()
      }
    }
    return async () => {
      this.closed += 1
      await close()
    }
  }
}
