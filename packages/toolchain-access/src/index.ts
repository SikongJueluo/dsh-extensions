/**
 * dsh-toolchain-access - narrow writable-directory grants for toolchain caches inside the DSH file sandbox.
 * @module dsh-toolchain-access
 */
import { chmodSync, closeSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import type { Config as LocalSandboxConfig } from '@deepseek-ai/dsh-sandbox-local'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { workspaceWritableRoots } from '@deepseek-ai/dsh-sandbox'
import { GrantArgvError, insertGrantBinds } from './bwrap.js'
import { PRESET_IDS, resolveGrants } from './grants.js'
import type {
  GrantEnv,
  GrantFs,
  GrantIssue,
  GrantOverrides,
  GrantPlan,
  PresetId,
} from './grants.js'

export { insertGrantBinds, expectedStockProfileArgs, GrantArgvError } from './bwrap.js'
export type { GrantBindSpec } from './bwrap.js'
export { PRESET_IDS, defaultBaseTrees, pathCovers, resolveGrants } from './grants.js'
export type {
  GrantBind,
  GrantEnv,
  GrantFs,
  GrantIssue,
  GrantNote,
  GrantOverrides,
  GrantPlan,
  GrantStat,
  PresetId,
} from './grants.js'

export const TOOLCHAIN_GRANT_UNAVAILABLE = 'TOOLCHAIN_GRANT_UNAVAILABLE'

/** Fail-closed refusal: an enabled preset cannot be honored; the command never runs. */
export class ToolchainGrantError extends HarnessError {
  readonly issues: readonly GrantIssue[]

  constructor(issues: readonly GrantIssue[]) {
    const lines = issues.map((issue) => `toolchain-access: ${issue.message}`)
    super(lines.join('\n'), TOOLCHAIN_GRANT_UNAVAILABLE)
    this.name = 'ToolchainGrantError'
    this.issues = issues
  }
}

/** Explicit per-anchor path overrides (`paths` in the row config). */
export interface PathsConfig {
  uvCache?: string
  cargoHome?: string
  pnpmHome?: string
  pnpmStore?: string
  pnpmRuntimeLocks?: string
  gradleUserHome?: string
  mavenHome?: string
  semgrepState?: string
  semgrepVersionCache?: string
}

/** Row configuration: the stock sandbox-local knobs plus the grant fields. */
export interface Config extends LocalSandboxConfig {
  presets: readonly PresetId[]
  paths: Readonly<PathsConfig>
}

export const DEFAULT_PRESETS = [
  'uv-cache',
  'typst-cache',
  'cargo-cache',
  'pnpm-store',
  'pnpm-runtime-locks',
  'gradle-cache',
  'maven-cache',
  'semgrep-state',
] as const satisfies readonly PresetId[]

export const configFields = {
  runnerCommand: Schema.array(Schema.string())
    .default([])
    .description(
      'Override the runner argv (stock sandbox-local field restated; bwrap-compatible profile arguments are appended). The verdict for directory grants is on the FINAL argv layout: a wrapper whose resulting layout is not the pinned stock bwrap shape fails closed, while one indistinguishable from stock (a bare [bwrap]) is spliced normally.',
    ),
  runnerFailureSignatures: Schema.array(Schema.string())
    .default([])
    .description(
      'Case-insensitive stderr substrings for a configured runnerCommand refusing its profile (stock sandbox-local field restated; required with runnerCommand, rejected without it).',
    ),
  probeTimeoutMs: Schema.natural()
    .default(5000)
    .description(
      'Positive timeout in ms for each functional runner probe (stock sandbox-local field restated).',
    ),
  presets: Schema.array(Schema.union([...PRESET_IDS]))
    .default([...DEFAULT_PRESETS])
    .description(
      "Enabled writable-directory presets; the per-preset grant paths are in the package README. Omitted: the eight ordinary cache/state presets default on (uv-cache, typst-cache, cargo-cache, pnpm-store, pnpm-runtime-locks, gradle-cache, maven-cache, semgrep-state). presets: [] turns every preset off (stock sandbox); a non-empty list replaces the default exactly. pnpm-engine and gradle-jdks are whole toolchain installs and stay opt-in only, never default. Each enabled preset makes its exact directories writable for EVERY process in the sandbox under workspace-write, never a parent tree; semgrep-state instead mounts a private writable state directory over semgrep's data folder, so its credential-bearing settings.yml never becomes writable. A preset that cannot be honored (missing/invalid path, missing/invalid XDG_RUNTIME_DIR, non-stock backend) fails the confined command with a reason instead of being silently skipped.",
    ),
  paths: Schema.object({
    uvCache: Schema.string().description(
      'Explicit uv cache directory (default: paths from UV_CACHE_DIR, else <XDG_CACHE_HOME|~/.cache>/uv).',
    ),
    cargoHome: Schema.string().description(
      'Explicit CARGO_HOME anchor for cargo-cache (default: $CARGO_HOME, else ~/.cargo).',
    ),
    pnpmHome: Schema.string().description(
      'Explicit pnpm home anchor for pnpm-store/pnpm-engine (default: $PNPM_HOME, else <XDG_DATA_HOME|~/.local/share>/pnpm).',
    ),
    pnpmStore: Schema.string().description(
      'Explicit package-store directory for pnpm-store (default: <pnpm home>/store).',
    ),
    pnpmRuntimeLocks: Schema.string().description(
      "Explicit spelling of pnpm's shared operation-lock directory (default: $XDG_RUNTIME_DIR/pnpm-store-operation-locks-<uid>). pnpm derives this from XDG_RUNTIME_DIR and cannot be redirected: an override may re-spell the same directory (e.g. via symlink) but is refused if it points anywhere else, and it never bypasses the runtime-root validation.",
    ),
    gradleUserHome: Schema.string().description(
      'Explicit GRADLE_USER_HOME anchor for gradle-cache/gradle-jdks (default: $GRADLE_USER_HOME or ~/.gradle). Only its cache/lock subdirectories become writable; gradle.properties and init scripts at the root stay read-only.',
    ),
    mavenHome: Schema.string().description(
      'Explicit Maven user-home anchor for maven-cache (default ~/.m2, covering repository/ + wrapper/). Maven has no standard env var for it; a settings.xml <localRepository> relocation must be configured here explicitly. settings.xml stays read-only.',
    ),
    semgrepState: Schema.string().description(
      "Explicit host directory mounted over semgrep's data folder (default: <XDG_CACHE_HOME|~/.cache>/semgrep-state). It holds the sandbox-private settings.yml/semgrep.log; the host data folder (default ~/.semgrep) is never made writable.",
    ),
    semgrepVersionCache: Schema.string().description(
      'Explicit semgrep version-check cache file (default: <XDG_CACHE_HOME|~/.cache>/semgrep_version; $SEMGREP_VERSION_CACHE_PATH is honored when set).',
    ),
  })
    .default({})
    .description(
      'Explicit grant paths. Every entry must be an absolute path to an existing, user-owned directory (or lock file) that is not group-writable; a preset whose path is missing or refuses validation fails closed.',
    ),
}

export const Config = Schema.object({ ...configFields })

/** Keep an absolute directory value; drop empty or relative ones. */
function absolute(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' && value.startsWith('/') ? value : undefined
}

/** Collect the ambient host facts grants derive from. The dsh host process inherits the operator's session environment - this is deliberately NOT the per-session direnv overlay (auto-env's), which is agent-workspace state and must never widen grants. */
export function grantEnvFrom(
  home: string,
  uid: number,
  env: Record<string, string | undefined>,
): GrantEnv {
  return {
    home,
    uid,
    xdgCacheHome: absolute(env.XDG_CACHE_HOME),
    xdgDataHome: absolute(env.XDG_DATA_HOME),
    xdgRuntimeDir: absolute(env.XDG_RUNTIME_DIR),
    xdgConfigHome: absolute(env.XDG_CONFIG_HOME),
    cargoHome: absolute(env.CARGO_HOME),
    pnpmHome: absolute(env.PNPM_HOME),
    uvCache: absolute(env.UV_CACHE_DIR),
    gradleUserHome: absolute(env.GRADLE_USER_HOME),
    semgrepLogFile: absolute(env.SEMGREP_LOG_FILE),
    semgrepVersionCache: absolute(env.SEMGREP_VERSION_CACHE_PATH),
  }
}

/** The real host filesystem slice (injectable in tests). */
export function nodeGrantFs(): GrantFs {
  return {
    realpath: (path) => realpathSync(path),
    stat: (path) => {
      const stats = statSync(path)
      return {
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        uid: stats.uid,
        mode: stats.mode,
      }
    },
    ensure: (path, kind) => {
      if (kind === 'lock-file') {
        const fd = openSync(path, 'wx', 0o644)
        closeSync(fd)
        return
      }
      if (kind === 'state-file') {
        mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
        const fd = openSync(path, 'wx', 0o644)
        closeSync(fd)
        return
      }
      mkdirSync(path, { recursive: true, mode: kind === 'lock-dir' ? 0o700 : 0o755 })
      if (kind === 'lock-dir') {
        chmodSync(path, 0o700)
      }
    },
  }
}

/** The sandbox provider: `LocalSandboxProvider` with exact directory grants spliced into its stock bwrap wraps. Mount this row in place of the base composition's `sandbox` row (the bundle patch disables that row and appends this one - patch layers cannot rename a row). */
export class ToolchainAccessSandboxProvider extends LocalSandboxProvider {
  static Config = Config

  grantPresets: readonly PresetId[]
  grantPaths: Readonly<GrantOverrides>
  grantEnv: GrantEnv
  grantFs: GrantFs

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.grantPresets = config.presets
    this.grantPaths = config.paths
    this.grantEnv = grantEnvFrom(homedir(), process.getuid?.() ?? -1, process.env)
    this.grantFs = nodeGrantFs()
    this.logPlan(ctx, this.plan([], false))
  }

  /** Resolve the current plan for `workspaceRoots`. `prepare` allows the controlled creation of missing implicit-default paths (confine time only - plugin load passes false so mounting stays side-effect-free). */
  private plan(workspaceRoots: readonly string[], prepare: boolean): GrantPlan {
    return resolveGrants({
      presets: this.grantPresets,
      overrides: this.grantPaths,
      env: this.grantEnv,
      workspaceRoots,
      fs: this.grantFs,
      prepare,
    })
  }

  private logPlan(ctx: Context, plan: GrantPlan): void {
    for (const issue of plan.issues) ctx.logger.warn('toolchain-access: %s', issue.message)
    for (const note of plan.notes) {
      ctx.logger.info(
        'toolchain-access: grant %s (%s) adds nothing — covered by %s',
        note.path,
        note.preset,
        note.covered,
      )
    }
    if (plan.binds.length > 0) {
      ctx.logger.info(
        'toolchain-access: workspace-write commands may write: %s',
        plan.binds.map((bind) => bind.source).join(', '),
      )
    }
  }

  override async confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    if (
      this.grantPresets.length > 0 &&
      policy.mode === 'workspace-write' &&
      process.platform !== 'linux'
    ) {
      throw new GrantArgvError(
        `directory grants are only implemented for the stock Linux bwrap backend, not ${process.platform}`,
      )
    }
    const base = await super.confine(argv, policy, signal)
    if (this.grantPresets.length === 0) return base
    if (policy.mode !== 'workspace-write') return base
    const plan = this.plan(workspaceWritableRoots(policy), true)
    if (plan.issues.length > 0) throw new ToolchainGrantError(plan.issues)
    if (plan.binds.length === 0) return base
    return {
      ...base,
      argv: insertGrantBinds(base.argv, argv, policy, plan.binds),
    }
  }
}

export default ToolchainAccessSandboxProvider
