/**
 * dsh-rtk-rewrite — rtk command rewriting at the bash executor seam.
 *
 * rtk (rtk-ai/rtk) is a prefix-style CLI proxy: `rtk git status` runs the
 * real git and prints a deterministically compacted output. The supported
 * integration point is command REWRITING before execution, and DSH's
 * `tools/pre-execute` excludes input rewriting by design — so this plugin
 * takes the one seam where rewriting is native: the `ctx.shell` executor,
 * the exact pattern dsh-auto-env established (a SandboxBashExecutor subclass
 * adjusting the spec before `super.execute`).
 *
 * Chain: RtkBashExecutor extends dsh-auto-env's AutoEnvBashExecutor, so the
 * direnv/devenv overlay keeps applying — the rewriter only replaces
 * `spec.command` with what `rtk rewrite` printed. Everything above the
 * executor (jobs promotion, sandbox escalation approvals, output caps, spill
 * files, presentation) is untouched.
 *
 * Trust model: the rewrite query runs HOST-side through `ctx.subprocess`
 * (never inside the model bash sandbox), exactly like auto-env's
 * `direnv export`. The REWRITTEN command then executes under the normal
 * sandbox; rtk inside the sandbox degrades gracefully when its tracking DB
 * writes are denied (verified: compact output, exit 0, no stderr noise).
 * Approvals stay anchored on the model's original command — the rewrite is a
 * deterministic, locally-configured prefix, the same trust Claude Code's
 * `updatedInput` integration grants.
 *
 * No `#private` members on the executor (cordis rebinds service-method
 * receivers to a shadow proxy; V8 private-brand checks reject proxies) — the
 * same constraint auto-env documents. The rewriter helper keeps its state
 * because it is only ever invoked on the real instance captured here.
 *
 * @module dsh-rtk-rewrite
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AutoEnvBashExecutor, configFields } from 'dsh-auto-env'
import type { Config as AutoEnvConfig } from 'dsh-auto-env'
import { RewriteCache, rewrittenFromStdout } from './rewrite.js'

export { RewriteCache, rewrittenFromStdout } from './rewrite.js'

// Derive the seam types from the class we extend instead of importing
// '@deepseek-ai/dsh-shell' directly: auto-env's bundled d.ts inlines its own
// copy of the branded spec chain, and a second pristine import makes the two
// nominal brands collide (TS2416 on the execute override). One identity.
type ShellExecSpec = Parameters<AutoEnvBashExecutor['execute']>[0]
type ShellExecution = Awaited<ReturnType<AutoEnvBashExecutor['execute']>>

/** The rtk knobs this plugin adds, in one place for schema and fallback. */
const RTK_DEFAULTS = {
  rtkPath: 'rtk',
  rewriteTimeoutMs: 5_000,
} as const

/**
 * Plugin-row configuration: dsh-auto-env's executor and direnv knobs (all
 * inherited verbatim from `configFields`) plus the rtk fields this plugin
 * adds. `rewrite` is volatile (toggle live); `rtkPath`/`rewriteTimeoutMs` are
 * plain fields — editing one remounts the executor, the right blast radius
 * for a changed binary path. A row replacing the auto-env row must restate
 * the direnv keys it needs (patch rows replace config wholesale).
 */
export interface Config extends AutoEnvConfig {
  /** Live rewrite switch; false runs every command unrewritten. */
  rewrite: Volatile<boolean>
  /** rtk executable: absolute path or bare PATH name (host environment). */
  rtkPath: string
  /** Budget for one `rtk rewrite` query (ms). */
  rewriteTimeoutMs: number
}

// No `Schema<Config>` annotation: schemastery ≥ 3.18.4 types volatile modes
// into the schema generics, and an annotation would fight the inference the
// loader checks `static Config` against.
export const Config = Schema.object({
  ...configFields,
  rewrite: Schema.boolean().default(true).volatile().description(
    'Rewrite supported commands to their rtk equivalents before execution (host-side `rtk rewrite`; stdout decides, exit codes are ignored).',
  ),
  rtkPath: Schema.string().default(RTK_DEFAULTS.rtkPath).description(
    'rtk executable: absolute path or bare PATH name resolved in the harness environment, never inside the model sandbox.',
  ),
  rewriteTimeoutMs: Schema.number().step(100).min(500).default(RTK_DEFAULTS.rewriteTimeoutMs).description(
    'Budget for one `rtk rewrite` query (ms); a timeout or spawn failure runs the original command untouched.',
  ),
})

/** Options for the host-side rewrite-query helper. */
interface RewriterOptions {
  rtkPath: string
  timeoutMs: number
}

/**
 * Runs `rtk rewrite <command>` host-side and memoizes answers. Kept as a
 * plain class (not a Service) so the executor holds the only reference; all
 * state is reachable through public members because proxied executor methods
 * read it.
 */
export class CommandRewriter {
  /** Resolved rtk binary; undefined until the first successful resolve. */
  bin: string | undefined
  /** Whether the missing-binary warning already fired (warn once). */
  warnedMissing = false
  /** Bounded command→answer memo (null = checked, no rewrite). */
  readonly cache = new RewriteCache(256)

  constructor(
    private readonly ctx: Context,
    private readonly options: RewriterOptions,
  ) {}

  /**
   * Rewrite one command, or return undefined to run it untouched. Never
   * throws: any failure (missing binary, spawn error, timeout) degrades to
   * the original command.
   */
  async query(command: string, cwd?: string): Promise<string | undefined> {
    const hit = this.cache.get(command)
    if (hit !== undefined) return hit ?? undefined

    if (this.bin === undefined) {
      try {
        this.bin = await this.ctx.subprocess.resolveExecutable(this.options.rtkPath)
      } catch {
        this.bin = undefined
      }
      if (this.bin === undefined) {
        if (!this.warnedMissing) {
          this.warnedMissing = true
          this.ctx.logger.warn(
            'rtk-rewrite: rtk executable "%s" not found; running commands unrewritten',
            this.options.rtkPath,
          )
        }
        this.cache.set(command, null)
        return undefined
      }
    }

    // Own the deadline with a ref'd timer (AbortSignal.timeout schedules
    // unref'd, so a quiet loop could exit before the budget elapses).
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs)
    let text = ''
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [this.bin, 'rewrite', command],
        cwd: cwd ?? process.cwd(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 65_536 },
          stderr: { maxBytes: 16_384 },
        },
        graceMs: 3_000,
        signal: controller.signal,
      })
      const outcome = await handle.done
      // Exit codes are deliberately ignored: rtk 0.49.0 exits 3 for a
      // successful rewrite and 1 for "no equivalent", already disagreeing
      // with its documented 0/2/3 — stdout presence is the stable contract.
      void outcome
      const { stdout } = handle.collected
      text = stdout?.readFrom(0).text ?? ''
    } catch {
      // Spawn failure, abort, or a dropped collect stream: passthrough.
      this.cache.set(command, null)
      return undefined
    } finally {
      clearTimeout(timer)
    }

    const rewritten = rewrittenFromStdout(text)
    this.cache.set(command, rewritten ?? null)
    return rewritten
  }
}

/**
 * The `ctx.shell` executor: dsh-auto-env's direnv-overlaid sandboxed bash
 * executor with rtk command rewriting in front. Mount it in place of the
 * auto-env row (this bundle's patch disables that row and appends this one).
 */
export class RtkBashExecutor extends AutoEnvBashExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy', 'shellEnv']
  static Config = Config

  /** Live rewrite switch (volatile reference from the row config). */
  readonly rewrite: Volatile<boolean>
  /** Host-side rewrite-query helper; public because proxied methods read it. */
  readonly rewriter: CommandRewriter

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    this.rewrite = config.rewrite
    this.rewriter = new CommandRewriter(ctx, {
      rtkPath: config.rtkPath,
      timeoutMs: config.rewriteTimeoutMs,
    })
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    if (!this.rewrite.get()) return super.execute(spec)
    let rewritten: string | undefined
    try {
      rewritten = await this.rewriter.query(spec.command, spec.workdir)
    } catch {
      rewritten = undefined
    }
    if (rewritten === undefined) return super.execute(spec)
    return super.execute({ ...spec, command: rewritten })
  }
}

export default RtkBashExecutor
