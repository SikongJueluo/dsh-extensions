/**
 * dsh-recursive-skills - supplemental discovery for nested skill bundles.
 * @module dsh-recursive-skills
 */
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillSource } from '@deepseek-ai/dsh-skill'
import { expandHomePath, resolveAgentsHome } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { RecursiveSkillProvider, type ProviderConfig, type RootSpec } from './provider.js'

export { RecursiveSkillProvider } from './provider.js'
export type { ProviderConfig, RootSpec } from './provider.js'
export { parseSkillDocument } from './frontmatter.js'
export type { ParsedSkill, SkillParse } from './frontmatter.js'

export const name = 'recursive-skills'
export const inject = ['skills', 'fs']

export const NESTED_USER_RANK = 501

/** Plugin row configuration. */
export interface Config {
  providerName: string
  agentsHome?: string
  extraRoots: string[]
  maxDepth: number
  rank: number
  watch: boolean
}

export const Config = Schema.object({
  providerName: Schema.string()
    .min(1)
    .default('recursive-filesystem')
    .description(
      'Provider name recorded on every candidate. Must be unique within its registry layer and cannot be "runtime".',
    ),
  agentsHome: Schema.string().description(
    'Shared agent config root; the default scan root is <agentsHome>/skills. Defaults to $DSH_AGENTS_HOME, then ~/.agents. The singular ~/.agent is never guessed.',
  ),
  extraRoots: Schema.array(Schema.string())
    .default([])
    .description(
      'Additional skill roots scanned with the same rules (direct skills skipped, nested bundles discovered). Tilde prefixes are expanded; relative paths resolve against the host process cwd.',
    ),
  maxDepth: Schema.natural()
    .min(2)
    .default(4)
    .description(
      'Deepest bundle directory accepted relative to a root, where the root itself is depth 0 and a category child is depth 1. A nested bundle lives at depth >= 2. The default covers category/nested/category layouts.',
    ),
  rank: Schema.natural()
    .default(NESTED_USER_RANK)
    .description(
      'Precedence inside one registry layer (lower wins). The default 501 keeps the stock user-agents provider (500) ahead on duplicate names while still preceding bundled skills (600).',
    ),
  watch: Schema.boolean()
    .default(true)
    .description(
      'Watch scanned roots/categories and each discovered SKILL.md, invalidating this provider registration on changes. Requires ctx.fs.watch; a failing watcher degrades hot refresh but not discovery.',
    ),
})

/** Register the supplemental provider. Everything asynchronous (scanning, parsing, watching) happens after this synchronous registration. */
export function apply(ctx: Context, config: Config): void {
  const providerConfig: ProviderConfig = {
    providerName: config.providerName,
    roots: resolveRoots(config),
    maxDepth: config.maxDepth,
    rank: config.rank,
    watch: config.watch,
  }

  let provider: RecursiveSkillProvider | undefined
  ctx.skills.registerProvider((control) => {
    provider = new RecursiveSkillProvider(ctx, control, providerConfig)
    return provider
  })

  ctx.effect(
    () => async () => {
      await provider?.dispose()
    },
    'recursive-skills watcher',
  )
}

/** Resolve the default user root plus configured extras, preserving order. */
function resolveRoots(config: Config): RootSpec[] {
  const roots: RootSpec[] = []
  const seen = new Set<string>()
  const add = (path: string, source: SkillSource): void => {
    const absolute = resolve(expandHomePath(path))
    if (seen.has(absolute)) return
    seen.add(absolute)
    roots.push({ path: absolute, source })
  }
  add(join(resolveAgentsHome(config.agentsHome), 'skills'), 'user-agents')
  for (const root of config.extraRoots) add(root, 'custom')
  return roots
}
