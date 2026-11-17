/**
 * dsh-rtk-rewrite - rtk command rewriting at the bash executor seam.
 * @module dsh-rtk-rewrite
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AutoEnvBashExecutor, configFields } from 'dsh-auto-env'
import type { Config as AutoEnvConfig } from 'dsh-auto-env'
import { RewriteCache, rewrittenFromStdout } from './rewrite.js'

export { RewriteCache, rewrittenFromStdout } from './rewrite.js'

type ShellExecSpec = Parameters<AutoEnvBashExecutor['execute']>[0]
type ShellExecution = Awaited<ReturnType<AutoEnvBashExecutor['execute']>>

const RTK_DEFAULTS = {
  rtkPath: 'rtk',
  rewriteTimeoutMs: 5_000,
} as const

export interface Config extends AutoEnvConfig {
  rewrite: Volatile<boolean>
  rtkPath: string
  rewriteTimeoutMs: number
}

export const Config = Schema.object({
  ...configFields,
  rewrite: Schema.boolean()
    .default(true)
    .volatile()
    .description(
      'Rewrite supported commands to their rtk equivalents before execution (host-side `rtk rewrite`; stdout decides, exit codes are ignored).',
    ),
  rtkPath: Schema.string()
    .default(RTK_DEFAULTS.rtkPath)
    .description(
      'rtk executable: absolute path or bare PATH name resolved in the harness environment, never inside the model sandbox.',
    ),
  rewriteTimeoutMs: Schema.number()
    .step(100)
    .min(500)
    .default(RTK_DEFAULTS.rewriteTimeoutMs)
    .description(
      'Budget for one `rtk rewrite` query (ms); a timeout or spawn failure runs the original command untouched.',
    ),
})

/** Options for the host-side rewrite-query helper. */
interface RewriterOptions {
  rtkPath: string
  timeoutMs: number
}

/** Runs `rtk rewrite <command>` host-side and memoizes answers. Kept as a plain class (not a Service) so the executor holds the only reference; all state is reachable through public members because proxied executor methods read it. */
export class CommandRewriter {
  bin: string | undefined
  warnedMissing = false
  readonly cache = new RewriteCache(256)

  constructor(
    private readonly ctx: Context,
    private readonly options: RewriterOptions,
  ) {}

  /** Rewrite one command, or return undefined to run it untouched. Never throws: any failure (missing binary, spawn error, timeout) degrades to the original command. */
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
      void outcome
      const { stdout } = handle.collected
      text = stdout?.readFrom(0).text ?? ''
    } catch {
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

/** The `ctx.shell` executor: dsh-auto-env's direnv-overlaid sandboxed bash executor with rtk command rewriting in front. Mount it in place of the auto-env row (this bundle's patch disables that row and appends this one). */
export class RtkBashExecutor extends AutoEnvBashExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy', 'shellEnv']
  static Config = Config

  readonly rewrite: Volatile<boolean>
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
