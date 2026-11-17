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
export type {
  DirenvFacts,
  DirenvOptions,
  DirenvStatus,
  DirenvStatusInfo,
  EnvOverlay,
} from './direnv.js'

const DIRENV_DEFAULTS = {
  direnvPath: 'direnv',
  direnvTimeoutMs: 30_000,
  direnvRevalidateMs: 30_000,
  direnvStdoutMaxBytes: 1_048_576,
} as const

export interface Config extends LocalBashConfig {
  direnvPath?: string

  direnvTimeoutMs?: number

  direnvRevalidateMs?: number

  direnvStdoutMaxBytes?: number

  direnvWatch?: boolean
}

export const configFields = {
  cwd: Schema.string()
    .volatile()
    .description('Default working directory for commands (default: process.cwd()).'),
  timeoutMs: Schema.number()
    .step(1)
    .min(1_000)
    .default(120_000)
    .volatile()
    .description('Default per-command timeout (ms).'),
  maxTimeoutMs: Schema.number()
    .step(1)
    .min(1_000)
    .default(600_000)
    .volatile()
    .description('Upper bound a caller may raise the per-command timeout to (ms).'),
  maxOutputBytes: Schema.number()
    .step(1)
    .min(1_024)
    .default(64_000)
    .volatile()
    .description('Default stdout/stderr capture budget per stream (bytes).'),
  maxSpillBytes: Schema.number()
    .step(1)
    .min(65_536)
    .default(67_108_864)
    .volatile()
    .description('Per-stream spill-file cap (bytes).'),
  graceMs: Schema.number()
    .step(1)
    .min(100)
    .max(2_147_483_647)
    .default(3_000)
    .volatile()
    .description('SIGTERM→SIGKILL grace period (ms).'),
  direnvPath: Schema.string()
    .default(DIRENV_DEFAULTS.direnvPath)
    .description(
      'Direnv executable: absolute path or bare PATH name resolved in the harness environment.',
    ),
  direnvTimeoutMs: Schema.number()
    .step(1)
    .min(1_000)
    .default(DIRENV_DEFAULTS.direnvTimeoutMs)
    .description(
      'Budget for one `direnv export json` evaluation; a cold devenv/nix evaluation can take tens of seconds (ms).',
    ),
  direnvRevalidateMs: Schema.number()
    .step(1)
    .min(0)
    .default(DIRENV_DEFAULTS.direnvRevalidateMs)
    .description(
      'Re-evaluate direnv when the cached overlay is older than this; direnv’s own cache keeps repeat runs near 20 ms (ms).',
    ),
  direnvStdoutMaxBytes: Schema.number()
    .step(1)
    .min(4_096)
    .default(DIRENV_DEFAULTS.direnvStdoutMaxBytes)
    .description('stdout budget for one direnv evaluation (bytes).'),
  direnvWatch: Schema.boolean()
    .default(true)
    .description(
      'Drop cached overlays the moment an .envrc or devenv.nix/yaml/lock changes (and when the direnv allow list changes), instead of waiting for direnvRevalidateMs. Private watch_file targets still rely on the TTL.',
    ),
}

export const Config = Schema.object({ ...configFields })

const EMPTY_OVERLAY: EnvOverlay = Object.freeze({})

export function mergeOverlay(spec: ShellExecSpec, overlay: EnvOverlay): ShellExecSpec {
  if (Object.keys(overlay).length === 0) return spec
  const env: Record<string, string | undefined> = { ...overlay, ...spec.env }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A23: the SDK's `ShellExecSpec.env` cannot spell "unset"; the subprocess seam reads an `undefined` value as a tombstone, so this assertion is the only way to hand it one.
  return { ...spec, env: env as Record<string, string> }
}

function bashWorkdir(args: unknown, sessionCwd: string): string {
  if (typeof args !== 'object' || args === null) return sessionCwd
  const workdir = (args as { workdir?: unknown }).workdir
  if (typeof workdir !== 'string' || workdir.length === 0) return sessionCwd
  return isAbsolute(workdir) ? workdir : resolve(sessionCwd, workdir)
}

async function ensureOverlay(loader: DirenvLoader, dir: string): Promise<EnvOverlay> {
  try {
    return await loader.ensure(dir)
  } catch {
    return EMPTY_OVERLAY
  }
}

export class AutoEnvBashExecutor extends SandboxBashExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy', 'shellEnv']
  static Config = Config

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

  override async execute(spec: ShellExecSpec) {
    const overlay = await ensureOverlay(this.direnv, spec.workdir)
    return super.execute(mergeOverlay(spec, overlay))
  }
}

function wireExecutor(ctx: Context, executor: AutoEnvBashExecutor): void {
  ctx.on('agent/created', ({ agent }) => {
    const cwd = agent.session.header.cwd
    if (cwd !== undefined) void ensureOverlay(executor.direnv, cwd)
  })

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
        description:
          'auto-env status for the session directory: active, none, pending, blocked, timeout, error, or missing',
      },
      DSH_DIRENV_RC: {
        description:
          'directory holding the .envrc backing the loaded environment (set when active)',
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

  ctx.effect(() => unregister)

  ctx.effect(() => () => executor.direnv.dispose())
}

export default AutoEnvBashExecutor
