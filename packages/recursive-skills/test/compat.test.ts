import { join } from 'node:path'
import {
  FileSystemSkillProvider,
  type Config as StockConfig,
} from '@deepseek-ai/dsh-skill-filesystem'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import { describe, expect, it } from 'vitest'
import { RecursiveSkillProvider } from '../src/provider.js'
import { createHarness, writeSkill } from './helpers.js'

/**
 * Differential check against the installed stock parser: every nested bundle
 * is also a valid direct bundle when its category directory is handed to the
 * stock provider as a custom root. The two providers must agree on the parsed
 * routing fields, body, instruction path, and resource base.
 */
describe('parser compatibility with the stock provider', () => {
  it('produces the same fields the stock provider parses from the same files', async () => {
    const harness = await createHarness()
    try {
      const category = join(harness.skillsRoot, 'anthropic')
      await writeSkill(join(category, 'plain'), [
        'name: plain-skill',
        'description: Plain description',
      ], '\n# Plain\n\nBody text.\n')
      await writeSkill(join(category, 'routing'), [
        'name: routing-skill',
        'description: "Quoted: description"',
        'whenToUse: When routing matters',
        'metadata:',
        '  owner: docs',
        '  tags: [one, two]',
      ])
      await writeSkill(join(category, 'model-hidden'), [
        'name: model-hidden',
        'description: Hidden from the model',
        'disable-model-invocation: true',
      ])
      await writeSkill(join(category, 'user-hidden'), [
        'name: user-hidden',
        'description: Hidden from users',
        'user-invocable: false',
      ])

      const stock = new FileSystemSkillProvider(
        harness.ctx,
        { signal: new AbortController().signal, invalidate() {} },
        { includeDefaultRoots: false, customSkillDirs: [category], watch: false } satisfies StockConfig,
      )
      const recursive = new RecursiveSkillProvider(
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
      try {
        const stockCandidates = await stock.list({})
        const recursiveCandidates = await recursive.list({})
        expect(Array.isArray(stockCandidates)).toBe(true)
        expect(Array.isArray(recursiveCandidates)).toBe(true)
        const stockList = stockCandidates as readonly SkillCandidate[]
        const recursiveList = recursiveCandidates as readonly SkillCandidate[]
        expect(stockList).toHaveLength(4)
        expect(recursiveList.map((candidate) => candidate.name).sort()).toEqual(
          stockList.map((candidate) => candidate.name).sort(),
        )

        for (const expected of stockList) {
          const actual = recursiveList.find((candidate) => candidate.name === expected.name)
          if (actual === undefined) throw new Error(`missing recursive candidate ${expected.name}`)
          expect(actual).toMatchObject({
            description: expected.description,
            invocation: expected.invocation,
            ...(expected.whenToUse === undefined ? {} : { whenToUse: expected.whenToUse }),
            ...(expected.metadata === undefined ? {} : { metadata: expected.metadata }),
          })
          const expectedDefinition = await stock.get(expected, {})
          const actualDefinition = await recursive.get(actual, {})
          expect(actualDefinition).toMatchObject({
            name: expectedDefinition?.name,
            content: expectedDefinition?.content,
            path: expectedDefinition?.path,
            resourceBase: expectedDefinition?.resourceBase,
          })
        }
      } finally {
        await stock.dispose()
        await recursive.dispose()
      }
    } finally {
      await harness.dispose()
    }
  })
})
