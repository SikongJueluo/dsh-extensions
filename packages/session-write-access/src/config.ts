/**
 * Plugin-row configuration for the sandbox-policy replacement. The stock
 * fields (`mode`, `workspaceRoot`, `additionalWritableRoots`) are restated
 * because replacing a row replaces its whole config; the remaining fields
 * declare which physical paths the standing workspace-write policy must never
 * be able to rewrite.
 *
 * @module dsh-session-write-access/config
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { expandPath, findProtectedOverlap } from './paths.js'

/** Plugin config; `Config` supplies the same defaults as the stock policy row. */
export interface Config {
  /** File-sandbox mode a session starts from (default: `read-only`, the fail-safe stock default). */
  mode?: SandboxMode
  /**
   * Absolute fallback workspace root for agentless calls or sessions without a
   * cwd. Absent means no fallback: such a `workspace-write` call is refused
   * instead of inheriting whatever directory the host process started in.
   */
  workspaceRoot?: string
  /** Extra physical absolute directories `workspace-write` may write under for every session. */
  additionalWritableRoots?: string[]
  /** Extra physical paths that must never be writable by the standing policy. */
  protectedPaths?: string[]
  /** Protect the DSH home (profile, plugin bundles, authorization storage); default true. */
  protectHomeData?: boolean
  /** Protect this package's own installed directory; default true. */
  protectPluginCode?: boolean
}

/** The schema projected into the settings UI; no `Schema<Config>` annotation by repo rule. */
export const Config = Schema.object({
  mode: Schema.union(['read-only', 'workspace-write', 'danger-full-access'])
    .default('read-only')
    .description('File-sandbox mode a session starts from (stock default: read-only).'),
  workspaceRoot: Schema.string().description(
    'Absolute fallback workspace root for agentless calls or sessions without a cwd. Absent means those calls are refused rather than inheriting the process cwd.',
  ),
  additionalWritableRoots: Schema.array(Schema.string())
    .default([])
    .description(
      'Physical absolute directories every workspace-write session may also write under.',
    ),
  protectedPaths: Schema.array(Schema.string())
    .default([])
    .description(
      'Physical paths the standing workspace-write policy must never be able to modify.',
    ),
  protectHomeData: Schema.boolean()
    .default(true)
    .description(
      'Refuse any workspace or grant overlapping the DSH home (profile, bundles, storage).',
    ),
  protectPluginCode: Schema.boolean()
    .default(true)
    .description('Refuse any workspace or grant overlapping this plugin package.'),
})

/** The package root this module is installed in (lib/.. when built). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Canonicalize an existing path, else keep a resolved absolute spelling. */
function canonicalOrResolve(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/**
 * Resolve the physical paths the standing policy must refuse to cover.
 * @param config - validated plugin config.
 * @param environment - process environment, injectable for tests.
 * @param packageRoot - installed package directory, injectable for tests.
 * @returns deduplicated physical absolute protected paths.
 */
export function resolveProtectedRoots(
  config: Config,
  environment: NodeJS.ProcessEnv = process.env,
  packageRoot: string = PACKAGE_ROOT,
): string[] {
  const paths = (config.protectedPaths ?? []).map((path) => expandPath(path, environment))
  if (config.protectHomeData !== false) {
    paths.push(expandPath('$DSH_HOME', environment))
  }
  if (config.protectPluginCode !== false) paths.push(packageRoot)
  const roots = new Set<string>()
  for (const path of paths) {
    if (!isAbsolute(path)) {
      throw new Error(
        `session-write-access: protected path ${JSON.stringify(path)} must be absolute (or use ~ / $DSH_HOME)`,
      )
    }
    roots.add(canonicalOrResolve(path))
  }
  return [...roots]
}

/**
 * The fallback workspace root the deployment actually stated.
 *
 * Nothing is derived from `process.cwd()`: the host process directory is a
 * deployment detail (a service manager unit usually starts in `$HOME`), not a
 * stated grant. A missing fallback is refused at the call that would need it.
 * @param config - validated plugin config.
 * @returns the physical absolute fallback root, or undefined for none.
 */
export function resolveConfiguredWorkspaceRoot(config: Config): string | undefined {
  return config.workspaceRoot === undefined
    ? undefined
    : canonicalOrResolve(expandPath(config.workspaceRoot))
}

/**
 * Verify the deployment-level roots at load. A deployment that makes the
 * authorization store or plugin code writable must fail loudly rather than
 * run with a policy that can rewrite itself. Only roots the deployment states
 * are checked; an absent fallback contributes nothing here.
 * @param config - validated plugin config.
 * @param protectedRoots - resolved protected paths.
 */
export function assertDeploymentRootsSafe(config: Config, protectedRoots: readonly string[]): void {
  const workspace = resolveConfiguredWorkspaceRoot(config)
  const candidates = [
    ...(workspace === undefined ? [] : [workspace]),
    ...(config.additionalWritableRoots ?? []).map((path) => canonicalOrResolve(expandPath(path))),
  ]
  for (const candidate of candidates) {
    const overlap = findProtectedOverlap(candidate, protectedRoots)
    if (overlap !== undefined) {
      throw new Error(
        `session-write-access: deployment root ${JSON.stringify(candidate)} overlaps protected ` +
          `${JSON.stringify(overlap)}; relocate the workspace/storage or fix protectedPaths`,
      )
    }
  }
}
