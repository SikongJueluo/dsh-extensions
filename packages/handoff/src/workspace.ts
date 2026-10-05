/**
 * Workspace roster and target resolution for cross-workspace handoffs.
 *
 * The registry is consumed exactly the way the Web sidebar does: `list()` for
 * enumeration, `resolveByPath()` for the origin, `status()` to grey out
 * workspaces whose directory disappeared. Everything here is host-side and
 * therefore unsandboxed; agents never write through this module.
 *
 * @module dsh-handoff/workspace
 */
import { realpath } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `Context.workspaceRegistry` augmentation in.
import type {} from '@deepseek-ai/dsh-workspace'
import { DEFAULT_BRIEF_DIR } from './identity.js'

/** The registry service face this module consumes (absent in minimal compositions). */
type Registry = Context['workspaceRegistry']
/** One registry entity, as narrowly as we use it. */
type WorkspaceEntity = NonNullable<Awaited<ReturnType<Registry['resolveByPath']>>>

/** One workspace row as pickers show it (browser wire and question card alike). */
export interface WorkspaceSummary {
  /** Registry id; empty for an unregistered origin cwd. */
  readonly id: string
  readonly title: string
  readonly path: string
  /** `status()` reported the directory gone; pickers grey the row out. */
  readonly missing: boolean
}

/** Where the fresh session should live. */
export interface HandoffTarget {
  /** Registry id when the target is a registered workspace. */
  readonly workspaceId?: string
  /** Canonical absolute cwd for the fresh session (`meta.cwd`). */
  readonly path: string
  /** Display title; the origin fallback is the final path segment. */
  readonly title: string
}

/** Everything the pickers need, snapshotted at command time. */
export interface WorkspaceRoster {
  /** The origin session's workspace (or its bare cwd when ungrouped). */
  readonly origin: WorkspaceSummary
  /** Registered workspaces other than the origin's, in registry order. */
  readonly others: readonly WorkspaceSummary[]
}

/** Final path segment, for titling an unregistered origin cwd. */
function lastSegment(path: string): string {
  const parts = path.split('/').filter((segment) => segment.length > 0)
  return parts.length > 0 ? (parts[parts.length - 1] as string) : path
}

/** One entity row with a live directory check. */
async function summarize(entity: WorkspaceEntity): Promise<WorkspaceSummary> {
  let missing = false
  try {
    missing = (await entity.status()) !== 'ok'
  } catch {
    // A failing status check degrades to "missing" rather than blocking the roster.
    missing = true
  }
  return { id: String(entity.id), title: entity.title, path: entity.path, missing }
}

/**
 * Snapshot the roster for one origin cwd: its own workspace (registry-resolved
 * when registered, the bare cwd otherwise) plus every other registered
 * workspace with a `status()` precheck. Compositions without the registry
 * service get an origin-only roster, which reproduces today's behavior.
 */
export async function snapshotRoster(ctx: Context, cwd: string): Promise<WorkspaceRoster> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    return { origin: { id: '', title: lastSegment(cwd), path: cwd, missing: false }, others: [] }
  }
  const originEntity = await registry.resolveByPath(cwd)
  const origin: WorkspaceSummary = originEntity === undefined
    ? { id: '', title: lastSegment(cwd), path: cwd, missing: false }
    : await summarize(originEntity)
  const entities = registry.list().filter((entity) => String(entity.id) !== origin.id)
  const others = await Promise.all(entities.map(summarize))
  return { origin, others }
}

/** The target that keeps today's semantics: spawn on the origin cwd. */
export function targetForOrigin(roster: WorkspaceRoster): HandoffTarget {
  return {
    ...(roster.origin.id.length === 0 ? {} : { workspaceId: roster.origin.id }),
    path: roster.origin.path,
    title: roster.origin.title,
  }
}

/**
 * Resolve a picked registry id back into a target, re-checking that the
 * workspace is still registered (the pick may outlive a registry edit).
 */
export async function resolveTargetById(ctx: Context, id: string): Promise<HandoffTarget | undefined> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  const entity = registry.get(id as Parameters<Registry['get']>[0])
  if (entity === undefined) return undefined
  return { workspaceId: id, path: entity.path, title: entity.title }
}

/**
 * Consume a `--workspace` argument that names a workspace by its (possibly
 * space-bearing) title: the longest registered title that prefixes `rest`
 * wins, so `--workspace Target Space fix readme` splits into spec
 * "Target Space" + task "fix readme". Path specs fall through (returned as
 * undefined) for the caller's single-token handling.
 */
export function consumeTitleSpec(ctx: Context, rest: string): { spec: string; remaining: string } | undefined {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  let best: { spec: string; remaining: string } | undefined
  for (const entity of registry.list()) {
    const title = entity.title
    if (title.length === 0) continue
    if (rest === title || rest.startsWith(`${title} `)) {
      const remaining = rest.slice(title.length).trim()
      if (best === undefined || title.length > best.spec.length) best = { spec: title, remaining }
    }
  }
  return best
}

/** Outcome of parsing a `--workspace` spec (or a question card's custom input). */
export type FlagTargetResult = { target: HandoffTarget } | { error: string }

/**
 * Resolve a typed workspace spec against the registry: a unique exact title,
 * or a path that realpaths onto a registered workspace's canonical path.
 * Misses and ambiguities come back as user-facing errors naming the candidates.
 */
export async function resolveFlagTarget(ctx: Context, spec: string): Promise<FlagTargetResult> {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) {
    return { error: 'this composition has no workspace registry, so --workspace cannot resolve' }
  }
  const trimmed = spec.trim()
  if (trimmed.length === 0) return { error: 'empty --workspace spec' }
  const entities = registry.list()
  const byTitle = entities.filter((entity) => entity.title === trimmed)
  if (byTitle.length === 1) return check(registry, byTitle[0] as WorkspaceEntity)
  if (byTitle.length > 1) {
    return { error: `多个工作区同名 "${trimmed}"，请改用路径：${spell(byTitle)}` }
  }
  let canonical: string
  try {
    canonical = await realpath(trimmed)
  } catch {
    return { error: `无法解析工作区 "${trimmed}"（按 title 或 workspace 根路径写；候选：${spell(entities)}）` }
  }
  const byPath = entities.filter((entity) => entity.path === canonical)
  if (byPath.length === 1) return check(registry, byPath[0] as WorkspaceEntity)
  return { error: `"${trimmed}" 不是已注册的工作区根路径（候选：${spell(entities)}）` }
}

/** Reject a resolved-but-directory-less target before any session exists. */
async function check(_registry: Registry, entity: WorkspaceEntity): Promise<FlagTargetResult> {
  const summary = await summarize(entity)
  if (summary.missing) {
    return { error: `工作区 "${summary.title}" 的目录已不存在（${summary.path}）` }
  }
  return { target: { workspaceId: summary.id, path: summary.path, title: summary.title } }
}

/** Compact candidate list for error messages, bounded. */
function spell(entities: readonly WorkspaceEntity[]): string {
  return entities
    .slice(0, 8)
    .map((entity) => `"${entity.title}" (${entity.path})`)
    .join('、')
}

/** Build the cross-workspace brief-copy directory for a target. */
export function targetBriefDir(dir: string | undefined, target: HandoffTarget): string {
  if (dir !== undefined && dir.startsWith('/')) return dir.replace(/\/+$/, '')
  return `${target.path.replace(/\/+$/, '')}/${dir ?? DEFAULT_BRIEF_DIR}`
}
