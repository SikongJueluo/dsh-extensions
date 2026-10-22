/**
 * dsh-toolchain-access — narrow writable-directory grants for toolchain
 * caches inside the DSH file sandbox.
 *
 * The stock `workspace-write` sandbox mounts the host read-only and the
 * workspace writable, so every tool with a shared HOME cache (uv, Cargo,
 * pnpm) dies on EROFS and the old workaround was a full-access escalation
 * per command. This plugin replaces the sandbox row with a
 * `LocalSandboxProvider` subclass that, for `workspace-write` policies,
 * appends exact `--bind <granted path> <itself>` mounts after the stock
 * bwrap profile:
 *
 * ```text
 * trusted row config + built-in presets
 *            ↓  (grants.ts: derive, realpath, validate, dedupe — fail closed)
 * precise writable-bind list
 *            ↓  (bwrap.ts: pinned layout verify, splice before "--")
 * sandbox adapter  →  official runner selection / probing / metadata intact
 *            ↓
 * the command still runs confined — one more exact subtree is writable
 * ```
 *
 * Trust semantics, stated exactly once because they are the whole design:
 *
 * - Enabling a preset makes that directory writable for EVERY process in
 *   the confined sandbox, not just the tool it is named after.
 * - Grants come from the plugin row (the operator's explicit choice) and
 *   ambient host anchors (HOME/XDG/CARGO_HOME/PNPM_HOME/UV_CACHE_DIR as
 *   exported by the operator's session). Agent claims, repository files and
 *   session env overlays are never grant sources: a project that points
 *   `UV_CACHE_DIR` elsewhere does not widen anything — it just keeps
 *   failing until the operator configures that path explicitly.
 * - The added mounts are exact-path only. Neighbors and parent directories
 *   stay read-only (verified on-host), no parent is ever widened to cover a
 *   missing directory, and any configured-but-unhonorable grant fails the
 *   confined call with a precise reason instead of silently degrading to
 *   the old EROFS loop.
 * - `read-only` policies are returned untouched — this layer adds write
 *   capability and therefore adds nothing there.
 * - Only the pinned stock Linux bwrap layout is edited. A configured
 *   `runnerCommand` wrapper, the Landlock/Seatbelt/ACL rungs, or a changed
 *   profile in a future dsh release fails closed with `GrantArgvError`
 *   rather than guessing where binds belong in an unfamiliar argv.
 *
 * Like every sandbox-provider service, methods here avoid `#private`
 * fields: cordis rebinds service-method receivers to a shadow proxy and
 * V8 private-brand checks reject proxy receivers (see dsh-auto-env, which
 * documents the same constraint).
 *
 * @module dsh-toolchain-access
 */
import { chmodSync, closeSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import LocalSandboxProvider from '@deepseek-ai/dsh-sandbox-local'
import type { Config as LocalSandboxConfig } from '@deepseek-ai/dsh-sandbox-local'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import { GrantArgvError, insertGrantBinds } from './bwrap.js'
import { PRESET_IDS, resolveGrants } from './grants.js'
import type { GrantEnv, GrantFs, GrantIssue, GrantOverrides, GrantPlan, PresetId } from './grants.js'

export { insertGrantBinds, expectedStockProfileArgs, GrantArgvError } from './bwrap.js'
export type { GrantBindSpec } from './bwrap.js'
export {
  PRESET_IDS,
  defaultBaseTrees,
  pathCovers,
  resolveGrants,
} from './grants.js'
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

/** Error code carried through the structured channel when grants cannot be honored. */
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
}

/** Row configuration: the stock sandbox-local knobs plus the grant fields. */
export interface Config extends LocalSandboxConfig {
  /** Enabled directory-grant presets; empty means stock behavior everywhere. */
  presets: readonly PresetId[]
  /** Explicit path overrides; unset anchors fall back to ambient host env then defaults. */
  paths: Readonly<PathsConfig>
}

/**
 * The schema mirrors `LocalSandboxProvider.Config` verbatim (this row
 * replaces the stock `sandbox` row, whose config it must be able to
 * restate) and adds the grant fields. No `Schema<Config>` annotation:
 * schemastery ≥ 3.18.4 types volatile modes into the schema generics and an
 * annotation would fight the loader's `static Config` inference. The grant
 * fields are deliberately NOT volatile — editing them remounts the
 * provider, which revalidates every grant from scratch.
 */
export const configFields = {
  runnerCommand: Schema.array(Schema.string()).default([]).description(
    'Override the runner argv (stock sandbox-local field restated; bwrap-compatible profile arguments are appended). The verdict for directory grants is on the FINAL argv layout: a wrapper whose resulting layout is not the pinned stock bwrap shape fails closed, while one indistinguishable from stock (a bare [bwrap]) is spliced normally.',
  ),
  runnerFailureSignatures: Schema.array(Schema.string()).default([]).description(
    'Case-insensitive stderr substrings for a configured runnerCommand refusing its profile (stock sandbox-local field restated; required with runnerCommand, rejected without it).',
  ),
  probeTimeoutMs: Schema.natural().default(5000).description(
    'Positive timeout in ms for each functional runner probe (stock sandbox-local field restated).',
  ),
  presets: Schema.array(Schema.union([...PRESET_IDS])).default([]).description(
    'Enabled writable-directory presets: uv-cache ($XDG_CACHE_HOME/uv), cargo-cache (registry, git and the .package-cache lock under CARGO_HOME), pnpm-store (<pnpm home>/store), pnpm-runtime-locks ($XDG_RUNTIME_DIR/pnpm-store-operation-locks-<uid>), pnpm-engine (the whole pnpm home incl. executable engine copies — separate trust decision, keep off unless you need cold engine installs). Grants apply to every process in the sandbox under workspace-write; missing or invalid paths fail the confined command with a reason.',
  ),
  paths: Schema.object({
    uvCache: Schema.string().description('Explicit uv cache directory (default: paths from UV_CACHE_DIR, else <XDG_CACHE_HOME|~/.cache>/uv).'),
    cargoHome: Schema.string().description('Explicit CARGO_HOME anchor for cargo-cache (default: $CARGO_HOME, else ~/.cargo).'),
    pnpmHome: Schema.string().description('Explicit pnpm home anchor for pnpm-store/pnpm-engine (default: $PNPM_HOME, else <XDG_DATA_HOME|~/.local/share>/pnpm).'),
    pnpmStore: Schema.string().description('Explicit package-store directory for pnpm-store (default: <pnpm home>/store).'),
    pnpmRuntimeLocks: Schema.string().description('Explicit spelling of pnpm\'s shared operation-lock directory (default: $XDG_RUNTIME_DIR/pnpm-store-operation-locks-<uid>). pnpm derives this from XDG_RUNTIME_DIR and cannot be redirected: an override may re-spell the same directory (e.g. via symlink) but is refused if it points anywhere else, and it never bypasses the runtime-root validation.'),
  }).default({}).description(
    'Explicit grant paths. Every entry must be an absolute path to an existing, user-owned directory (or lock file) that is not group-writable; a preset whose path is missing or refuses validation fails closed.',
  ),
}

// No `Schema<Config>` annotation on this object (see Config's doc comment);
// the spread keeps every sibling bundle's schema-extension pattern intact.
export const Config = Schema.object({ ...configFields })

/**
 * Collect the ambient host facts grants derive from. The dsh host process
 * inherits the operator's session environment — this is deliberately NOT
 * the per-session direnv overlay (auto-env's), which is agent-workspace
 * state and must never widen grants.
 */
export function grantEnvFrom(home: string, uid: number, env: Record<string, string | undefined>): GrantEnv {
  const absolute = (value: string | undefined): string | undefined =>
    value !== undefined && value !== '' && value.startsWith('/') ? value : undefined
  return {
    home,
    uid,
    xdgCacheHome: absolute(env.XDG_CACHE_HOME),
    xdgDataHome: absolute(env.XDG_DATA_HOME),
    xdgRuntimeDir: absolute(env.XDG_RUNTIME_DIR),
    cargoHome: absolute(env.CARGO_HOME),
    pnpmHome: absolute(env.PNPM_HOME),
    uvCache: absolute(env.UV_CACHE_DIR),
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
    // Controlled preparation for missing implicit defaults: create exactly
    // what the owning tool would have created (uv/cargo/pnpm create these
    // on first run — impossible to do from inside the sandbox).
    ensure: (path, kind) => {
      if (kind === 'lock-file') {
        const fd = openSync(path, 'wx', 0o644)
        closeSync(fd)
        return
      }
      mkdirSync(path, { recursive: true, mode: kind === 'lock-dir' ? 0o700 : 0o755 })
      if (kind === 'lock-dir') {
        // mkdir's mode is masked by umask and ignored for recursive
        // intermediates; pnpm requires 0700 and chmods unconditionally,
        // so create it exactly right up front.
        chmodSync(path, 0o700)
      }
    },
  }
}

/**
 * The sandbox provider: `LocalSandboxProvider` with exact directory grants
 * spliced into its stock bwrap wraps. Mount this row in place of the base
 * composition's `sandbox` row (the bundle patch disables that row and
 * appends this one — patch layers cannot rename a row).
 */
export class ToolchainAccessSandboxProvider extends LocalSandboxProvider {
  static Config = Config

  /** Enabled presets; public because the proxied confine reads it. */
  grantPresets: readonly PresetId[]
  /** Explicit path overrides; public likewise. */
  grantPaths: Readonly<GrantOverrides>
  /** Ambient host facts; captured once, public for tests to pin. */
  grantEnv: GrantEnv
  /** Filesystem slice; public for tests that swap it after construction. */
  grantFs: GrantFs

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.grantPresets = config.presets
    this.grantPaths = config.paths
    // getuid() is typed `number | undefined` (platforms without uids); an
    // undefined uid can never match an owner, so every grant fails closed.
    this.grantEnv = grantEnvFrom(homedir(), process.getuid?.() ?? -1, process.env)
    this.grantFs = nodeGrantFs()
    // Early visibility only: a grant that cannot be honored right now is
    // logged at load, but the fail point is confine() — directories may
    // appear later, and the provider never refuses to START over one.
    this.logPlan(ctx, this.plan([], false))
  }

  /**
   * Resolve the current plan for `workspaceRoots`. `prepare` allows the
   * controlled creation of missing implicit-default paths (confine time
   * only — plugin load passes false so mounting stays side-effect-free).
   */
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

  /**
   * Wrap, then splice. Everything official — runner selection and probing,
   * enforcement reporting, denial signatures, runner-failure rules, the
   * fail-closed `SANDBOX_UNAVAILABLE` path — is `super.confine()`'s and is
   * returned verbatim; the only edit is extra `--bind` arguments inside an
   * argv whose entire layout has been verified against the pinned stock
   * shape. Any deviation from that shape, or any enabled grant that cannot
   * be honored, throws: the command does not run under a silently weaker
   * contract than the row promised.
   */
  override async confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    if (this.grantPresets.length > 0 && policy.mode === 'workspace-write' && process.platform !== 'linux') {
      // Refuse BEFORE super.confine(): another platform's rung (windows-acl)
      // materializes its own side effects (ACEs, temp dirs) inside confine,
      // and this package only ever edits the pinned Linux bwrap layout.
      throw new GrantArgvError(
        `directory grants are only implemented for the stock Linux bwrap backend, not ${process.platform}`,
      )
    }
    const base = await super.confine(argv, policy, signal)
    if (this.grantPresets.length === 0) return base
    if (policy.mode !== 'workspace-write') return base
    // Canonicalize the root the same way super.confine did before building
    // its --bind, so the subtraction below compares like-for-like paths.
    // prepare=true: a missing implicit default (e.g. pnpm's lock dir after
    // a reboot wiped /run/user) is created now, exactly once per confine.
    const plan = this.plan([canonicalPath(policy.workspaceRoot)], true)
    if (plan.issues.length > 0) throw new ToolchainGrantError(plan.issues)
    if (plan.binds.length === 0) return base
    return {
      ...base,
      argv: insertGrantBinds(base.argv, argv, policy, plan.binds),
    }
  }
}

export default ToolchainAccessSandboxProvider
