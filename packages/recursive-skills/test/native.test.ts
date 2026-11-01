import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHarness, writeSkill } from './helpers.js'

describe('coexistence with the stock provider', () => {
  it('keeps the stock direct skill ahead of a nested duplicate and merges the rest', async () => {
    const harness = await createHarness({ stockProvider: true })
    try {
      await writeSkill(join(harness.skillsRoot, 'shared'), [
        'name: shared',
        'description: Direct copy',
      ])
      await writeSkill(join(harness.skillsRoot, 'category', 'shared'), [
        'name: shared',
        'description: Nested copy',
      ])
      await writeSkill(join(harness.skillsRoot, 'category', 'only-nested'), [
        'name: nested-only',
        'description: Nested only',
      ])

      const skills = await harness.ctx.skills.list()
      const shared = skills.find((skill) => skill.name === 'shared')
      expect(shared?.provider).toBe('filesystem')
      expect(shared?.source).toBe('custom')
      expect(skills.find((skill) => skill.name === 'nested-only')?.provider).toBe(
        'recursive-filesystem',
      )
    } finally {
      await harness.dispose()
    }
  })
})
