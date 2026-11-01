/**
 * Shared fixtures for the recursive-skills tests: a temporary agents home, a
 * real composed filesystem, the real skill registry, and the plugin mounted as
 * the loader would mount it.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import {
  apply as stockApply,
  Config as StockConfig,
  inject as stockInject,
  name as stockName,
} from '@deepseek-ai/dsh-skill-filesystem'
import { apply, Config, inject, name } from '../src/index.js'

/** Plugin object in the shape Cordis mounts from a package entry. */
const plugin = { apply, Config, inject, name }

export interface HarnessOptions {
  /** Mount a LocalFileSystem subclass (failure injection) instead of the stock one. */
  fsPlugin?: typeof LocalFileSystem
  /** Mount the stock skill-filesystem provider on the same root first. */
  stockProvider?: boolean
  extraRoots?: string[]
  maxDepth?: number
  rank?: number
  watch?: boolean
}

export interface Harness {
  readonly ctx: Context
  readonly home: string
  readonly skillsRoot: string
  dispose(): Promise<void>
}

/** Create an isolated agents home and mount registry, filesystem, and plugin. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-recursive-skills-'))
  const skillsRoot = join(home, 'skills')
  await mkdir(skillsRoot, { recursive: true })

  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const FsPlugin = options.fsPlugin ?? LocalFileSystem
  await ctx.plugin(FsPlugin, { cwd: process.cwd() })
  if (options.stockProvider === true) {
    await ctx.plugin(
      { apply: stockApply, Config: StockConfig, inject: stockInject, name: stockName },
      { includeDefaultRoots: false, customSkillDirs: [skillsRoot], watch: false },
    )
  }
  await ctx.plugin(plugin, {
    providerName: 'recursive-filesystem',
    agentsHome: home,
    extraRoots: options.extraRoots ?? [],
    maxDepth: options.maxDepth ?? 4,
    rank: options.rank ?? 501,
    watch: options.watch ?? false,
  })

  return {
    ctx,
    home,
    skillsRoot,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** Create a temporary directory outside a harness (extra roots, external targets). */
export async function tempDir(prefix = 'dsh-recursive-skills-extra-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** Write one skill bundle: `<directory>/SKILL.md` with the given frontmatter lines. */
export async function writeSkill(
  directory: string,
  frontmatter: readonly string[],
  body = '# Skill\n',
): Promise<string> {
  await mkdir(directory, { recursive: true })
  const path = join(directory, 'SKILL.md')
  await writeFile(path, skillDocument(frontmatter, body))
  return path
}

/** Build a SKILL.md text from literal frontmatter lines. */
export function skillDocument(frontmatter: readonly string[], body = '# Skill\n'): string {
  return ['---', ...frontmatter, '---', body].join('\n')
}

/** Write an arbitrary file, creating its parent directory. */
export async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/** Poll an async predicate until it holds or the timeout expires. */
export async function eventually(
  predicate: () => Promise<boolean>,
  description: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  for (;;) {
    try {
      if (await predicate()) return
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${description}${lastError === undefined ? '' : `: ${String(lastError)}`}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Names currently visible in the merged catalog. */
export async function catalogNames(ctx: Context): Promise<string[]> {
  return (await ctx.skills.list()).map((skill) => skill.name)
}
