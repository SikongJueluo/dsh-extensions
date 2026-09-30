/**
 * dsh-auto-env — per-session direnv/devenv environment injection.
 *
 * DSH runs every bash command as `bash -c` (non-interactive, non-login), so
 * nothing ever sources the workspace's direnv environment: a devenv project's
 * `.devenv/profile/bin` never reaches `PATH`. This plugin replaces the stock
 * sandboxed bash executor with one that layers the direnv diff on top:
 *
 * - `agent/session-start` kicks a host-side `direnv export json` for the
 *   session directory, so the overlay is warm before the model's first
 *   command (the event is a synchronous notification — the kick is
 *   fire-and-forget by design).
 * - `tools/pre-execute` awaits the overlay for every `bash` tool call — the
 *   awaitable waterfall gate that closes the race for foreground AND
 *   background commands alike.
 * - the executor itself merges the overlay into `ShellExecSpec.env` — the
 *   seam dsh-shell documents for in-process plugins (the hooks bridges set
 *   `CLAUDE_PROJECT_DIR` through it). The overlay merges below any
 *   caller-supplied `env`, values survive the credential scrub, and `null`
 *   diff entries become unset tombstones the subprocess seam honors.
 *
 * direnv runs host-side (via `ctx.subprocess`), never inside the model bash
 * sandbox: the sandbox denies direnv's allow-record and cache writes, and no
 * model-side command can `direnv allow` its way out. Trust therefore stays
 * exactly where interactive direnv keeps it — the user's
 * `~/.local/share/direnv/allow` list, shared with their shell. An `.envrc`
 * that is not allowed surfaces as `$DSH_DIRENV=blocked` and loads nothing.
 *
 * The status is model-visible via `ctx.shellEnv` (`$DSH_DIRENV`,
 * `$DSH_DIRENV_RC`), so a failed load can be diagnosed from inside the
 * session instead of silently degrading.
 *
 * Confinement is unchanged: the class extends `SandboxBashExecutor`, so every
 * command still runs under the resolved per-session sandbox policy; the
 * overlay only changes the environment the confined command sees.
 *
 * @module dsh-auto-env
 */
import { isAbsolute, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import type { Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local'
import type { ShellExecSpec } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { DirenvLoader, type EnvOverlay } from './direnv.js'

export { DirenvLoader, findEnvrcDir, sanitizeDirenvDump } from './direnv.js'
export type { DirenvFacts, DirenvOptions, DirenvStatus, DirenvStatusInfo, EnvOverlay } from './direnv.js'

/** The direnv knobs this plugin adds, in one place for schema and fallback. */
const DIRENV_DEFAULTS = {
  direnvPath: 'direnv',
  direnvTimeoutMs: 30_000,
  direnvRevalidateMs: 30_000,
  direnvStdoutMaxBytes: 1_048_576,
} as const

/**
 * Plugin-row configuration: the sandboxed bash executor's knobs (see
 * `@deepseek-ai/dsh-bash-local`) plus the `direnv*` fields this plugin
 * adds — optional in the interface so the class's static `Config` stays
 * assignable to the parent executor's; the schema fills the defaults, and
 * the constructor falls back to {@link DIRENV_DEFAULTS} for direct callers.
 */
export interface Config extends LocalBashConfig {
  /** Direnv executable: absolute path or bare PATH name. */
  direnvPath?: string
  /** Budget for one `direnv export json` evaluation (ms). */
  direnvTimeoutMs?: number
  /** Re-evaluate direnv when the cached overlay is older than this (ms). */
  direnvRevalidateMs?: number
  /** stdout budget for one direnv evaluation (bytes). */
  direnvStdoutMaxBytes?: number
  /** Actively invalidate cached overlays when direnv inputs change. */
  direnvWatch?: boolean
}

// The executor fields mirror LocalBashExecutor's schema defaults verbatim; a
// row that only sets `timeoutMs` (like the stock `bash-sandbox` row) keeps
// the stock behavior everywhere else.
export const Config: Schema<Config> = Schema.object({
  cwd: Schema.string().description('Default working directory for commands (default: process.cwd()).'),
  timeoutMs: Schema.number().step(1).min(1_000).default(120_000).description('Default per-command timeout (ms).'),
  maxTimeoutMs: Schema.number().step(1).min(1_000).default(600_000).description('Upper bound a caller may raise the per-command timeout to (ms).'),
  maxOutputBytes: Schema.number().step(1).min(1_024).default(64_000).description('Default stdout/stderr capture budget per stream (bytes).'),
  maxSpillBytes: Schema.number().step(1).min(65_536).default(67_108_864).description('Per-stream spill-file cap (bytes).'),
  graceMs: Schema.number().step(1).min(100).max(2_147_483_647).default(3_000).description('SIGTERM→SIGKILL grace period (ms).'),
  direnvPath: Schema.string().default(DIRENV_DEFAULTS.direnvPath).description('Direnv executable: absolute path or bare PATH name resolved in the harness environment.'),
  direnvTimeoutMs: Schema.number().step(1).min(1_000).default(DIRENV_DEFAULTS.direnvTimeoutMs).description('Budget for one `direnv export json` evaluation; a cold devenv/nix evaluation can take tens of seconds (ms).'),
  direnvRevalidateMs: Schema.number().step(1).min(0).default(DIRENV_DEFAULTS.direnvRevalidateMs).description('Re-evaluate direnv when the cached overlay is older than this; direnv’s own cache keeps repeat runs near 20 ms (ms).'),
  direnvStdoutMaxBytes: Schema.number().step(1).min(4_096).default(DIRENV_DEFAULTS.direnvStdoutMaxBytes).description('stdout budget for one direnv evaluation (bytes).'),
  direnvWatch: Schema.boolean().default(true).description('Drop cached overlays the moment an .envrc or devenv.nix/yaml/lock changes (and when the direnv allow list changes), instead of waiting for direnvRevalidateMs. Private watch_file targets still rely on the TTL.'),
})

const EMPTY_OVERLAY: EnvOverlay = Object.freeze({})

/**
 * Merge one direnv overlay into a resolved execution spec. The overlay sits
 * below any caller-supplied `env`, an empty overlay leaves the spec
 * untouched, and tombstones (`undefined` values) ride along for the
 * subprocess seam to unset — the declared `Record<string, string>` cannot
 * spell that, hence the cast.
 */
export function mergeOverlay(spec: ShellExecSpec, overlay: EnvOverlay): ShellExecSpec {
  if (Object.keys(overlay).length === 0) return spec
  const env: Record<string, string | undefined> = { ...overlay, ...spec.env }
  return { ...spec, env: env as Record<string, string> }
}

/** Resolve the directory a bash tool call will run in, mirroring tool-bash. */
function bashWorkdir(args: unknown, sessionCwd: string): string {
  if (typeof args !== 'object' || args === null) return sessionCwd
  const workdir = (args as { workdir?: unknown }).workdir
  if (typeof workdir !== 'string' || workdir.length === 0) return sessionCwd
  return isAbsolute(workdir) ? workdir : resolve(sessionCwd, workdir)
}

/**
 * Resolve the overlay for `dir` without ever rejecting (evaluation failures
 * degrade to the empty overlay and surface through `$DSH_DIRENV`).
 */
async function ensureOverlay(loader: DirenvLoader, dir: string): Promise<EnvOverlay> {
  try {
    return await loader.ensure(dir)
  } catch {
    return EMPTY_OVERLAY
  }
}

/**
 * The `ctx.shell` provider: the stock sandboxed bash executor with a direnv
 * overlay merged into every execution. Mount it in place of the base
 * composition's `bash-sandbox` row (the bundle patch disables that row and
 * appends this one — patch layers cannot rename a row). Foreground `run`
 * awaits a fresh overlay; background `start` reads the snapshot warmed by
 * `agent/session-start` / `tools/pre-execute` and kicks a recompute when
 * even that is missing, so a cold start degrades for at most one command.
 *
 * No `#private` members here on purpose: cordis rebinds service-method
 * receivers to a shadow Proxy (`createShadowMethod` in @deepseek-ai/cordis
 * replaces `thisArg` so method calls see the caller's active context), and
 * V8's private-brand check rejects Proxy receivers outright — one `this.#x`
 * inside `run`/`start` throws "Receiver must be an instance of class …" on
 * every command. Everything reached from a proxied method stays public;
 * `DirenvLoader` keeps its private state because it is only ever invoked on
 * the real instance captured here.
 */
export class AutoEnvBashExecutor extends SandboxBashExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy', 'shellEnv']
  static Config = Config

  /** Direnv overlay cache; public because proxied methods read it. */
  direnv: DirenvLoader

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.direnv = new DirenvLoader(ctx, {
      direnvPath: config.direnvPath ?? DIRENV_DEFAULTS.direnvPath,
      timeoutMs: config.direnvTimeoutMs ?? DIRENV_DEFAULTS.direnvTimeoutMs,
      revalidateMs: config.direnvRevalidateMs ?? DIRENV_DEFAULTS.direnvRevalidateMs,
      stdoutMaxBytes: config.direnvStdoutMaxBytes ?? DIRENV_DEFAULTS.direnvStdoutMaxBytes,
      watch: config.direnvWatch ?? true,
    })
    wireExecutor(ctx, this)
  }

  override async run(spec: ShellExecSpec) {
    const overlay = await ensureOverlay(this.direnv, spec.workdir)
    return super.run(mergeOverlay(spec, overlay))
  }

  override start(spec: ShellExecSpec) {
    const overlay = this.direnv.snapshot(spec.workdir)
    if (overlay === undefined) void ensureOverlay(this.direnv, spec.workdir)
    return super.start(mergeOverlay(spec, overlay ?? EMPTY_OVERLAY))
  }
}

/** Register the session-start kick, the pre-execute gate, and `$DSH_DIRENV`. */
function wireExecutor(ctx: Context, executor: AutoEnvBashExecutor): void {
  // Warm the session directory's overlay before the first turn; the event
  // is a synchronous notification, so the kick is deliberately un-awaited.
  ctx.on('agent/session-start', ({ agent }) => {
    const cwd = agent.session.header.cwd
    if (cwd !== undefined) void ensureOverlay(executor.direnv, cwd)
  })
  // Close the race for every bash tool call (foreground and background):
  // this waterfall is awaited before the tool executes, by which time the
  // executor reads a warm snapshot.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const cwd = exec.agent?.session.header.cwd
    if (exec.name === 'bash' && cwd !== undefined) {
      await ensureOverlay(executor.direnv, bashWorkdir(exec.arguments, cwd))
    }
    return next()
  })
  const unregister = ctx.shellEnv.register({
    name: 'auto-env',
    variables: {
      DSH_DIRENV: {
        description: 'auto-env status for the session directory: active, none, pending, blocked, timeout, error, or missing',
      },
      DSH_DIRENV_RC: {
        description: 'directory holding the .envrc backing the loaded environment (set when active)',
      },
    },
    resolve: (execution) => {
      const values: Record<string, string> = {}
      const cwd = execution.agent?.session.header.cwd
      if (cwd === undefined) {
        values.DSH_DIRENV = 'none'
        return values
      }
      const facts = executor.direnv.status(cwd)
      values.DSH_DIRENV = facts.status
      if (facts.status === 'active' && facts.rcDir !== undefined) values.DSH_DIRENV_RC = facts.rcDir
      return values
    },
  })
  // shellEnv.register ties disposal to the registry's fiber; keep our own
  // handle as well so an executor reload unregisters deterministically.
  ctx.effect(() => unregister)
  // Close the direnv input watchers with the executor.
  ctx.effect(() => () => executor.direnv.dispose())
}

export default AutoEnvBashExecutor
