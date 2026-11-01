/**
 * dsh-recursive-skills — supplemental discovery for nested skill bundles.
 *
 * The stock filesystem skill provider scans only the direct children of a
 * skill root, so this layout stays invisible:
 *
 * ```text
 * ~/.agents/skills/
 * ├── research/              → discovered (direct bundle)
 * └── anthropic/pdf/         → nested, NOT discovered by the stock scanner
 *     └── SKILL.md
 * ```
 *
 * This bundle mounts one extra provider beside the stock one. Its candidates
 * enter the same `ctx.skills` catalog, and therefore the same initial /
 * replacement catalog messages, `skill` tool, and user `/name` invocation.
 * "Automatic loading" keeps its native meaning: summaries are discovered up
 * front and bodies are read on demand — nested skill text is never injected
 * into the system prompt wholesale.
 *
 * Boundaries, stated once because they are the design:
 *
 * - Direct skills (`<root>/<skill>/SKILL.md`, `<root>/<skill>.md`) are skipped:
 *   the stock provider already owns them at rank 500, while nested candidates
 *   register at rank 501. Duplicate names resolve to the direct skill.
 * - A directory containing `SKILL.md` is a bundle boundary. Nested
 *   `references/`, `scripts/`, and `assets/` markdown never becomes a skill,
 *   and no arbitrary Markdown is imported.
 * - Traversal follows `ctx.fs` targets and deduplicates by target identity, so
 *   symlinked categories work and alias/cycle loops terminate.
 * - Changes are provider-driven: one watcher per scanned directory invalidates
 *   the registration. Body edits need no catalog replacement because `get()`
 *   re-reads the file.
 * - Only host-local-ish roots are supported through the composed filesystem;
 *   the plugin requires `fs`, whose watch capability must work for hot refresh.
 *
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

/** Registers this provider beside the stock filesystem provider. */
export const name = 'recursive-skills'
/** Required services: the catalog registry and the composed filesystem. */
export const inject = ['skills', 'fs']

/** The rank a user-owned nested bundle uses. Direct user skills keep 500. */
export const NESTED_USER_RANK = 501

/** Plugin row configuration. */
export interface Config {
  /** Provider name shown in catalog metadata; must be unique in its layer. */
  providerName: string
  /** Shared agent config root; defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
  /** Additional roots scanned with the same rules; `~` prefixes are expanded. */
  extraRoots: string[]
  /** Deepest bundle directory accepted, relative to each root (root = 0). */
  maxDepth: number
  /** Rank for every nested candidate; lower wins inside one registry layer. */
  rank: number
  /** Watch scanned roots/categories and discovered instruction files. */
  watch: boolean
}

// No `Schema<Config>` annotation: schemastery >= 3.18.4 types volatile modes
// into the schema generics; the inferred shape keeps the loader contract.
export const Config = Schema.object({
  providerName: Schema.string().min(1).default('recursive-filesystem').description(
    'Provider name recorded on every candidate. Must be unique within its registry layer and cannot be "runtime".',
  ),
  agentsHome: Schema.string().description(
    'Shared agent config root; the default scan root is <agentsHome>/skills. Defaults to $DSH_AGENTS_HOME, then ~/.agents. The singular ~/.agent is never guessed.',
  ),
  extraRoots: Schema.array(Schema.string()).default([]).description(
    'Additional skill roots scanned with the same rules (direct skills skipped, nested bundles discovered). Tilde prefixes are expanded; relative paths resolve against the host process cwd.',
  ),
  maxDepth: Schema.natural().min(2).default(4).description(
    'Deepest bundle directory accepted relative to a root, where the root itself is depth 0 and a category child is depth 1. A nested bundle lives at depth >= 2. The default covers category/nested/category layouts.',
  ),
  rank: Schema.natural().default(NESTED_USER_RANK).description(
    'Precedence inside one registry layer (lower wins). The default 501 keeps the stock user-agents provider (500) ahead on duplicate names while still preceding bundled skills (600).',
  ),
  watch: Schema.boolean().default(true).description(
    'Watch scanned roots/categories and each discovered SKILL.md, invalidating this provider registration on changes. Requires ctx.fs.watch; a failing watcher degrades hot refresh but not discovery.',
  ),
})

/**
 * Register the supplemental provider. Everything asynchronous (scanning,
 * parsing, watching) happens after this synchronous registration.
 */
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

  // The registry disposes the registration, but an async effect lets Cordis
  // await watcher shutdown during plugin unload instead of leaving closes in
  // flight after the fiber is gone.
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
