/**
 * dsh-remote-exec — whitelisted remote container execution for DSH.
 *
 * One `remote_exec` tool runs fish commands inside a fixed Docker container
 * on a whitelisted SSH host, mirroring Mini-Nav's `remote.py` flow plus an
 * autoStart branch. Four DSH seams carry the whole design (see
 * docs/research-dsh-remote-exec-tool.md for the source-verified contracts):
 *
 * - `ctx.tools.register` + `defineTool` — the model-facing tool. The model
 *   only ever picks a `target` key from the operator-owned whitelist and
 *   supplies a container-side command; hosts, containers, users and ssh
 *   options never cross that boundary.
 * - `ctx.subprocess.spawn` — the ssh client runs HOST-side, in the harness
 *   process (argv, never a local shell), so the real `~/.ssh` config, jump
 *   chains, agent forwarding (`SSH_AUTH_SOCK` survives the env scrub) and
 *   known_hosts all apply. The model bash sandbox is never involved.
 * - `ctx.get('approval')` — the first use of a target per session asks
 *   through the same approval waterfall bash escalation uses (Web UI
 *   popup, `approval/asked`/`decided` audit pair in the session log).
 *   A missing approval service fails closed; `approvalMode: 'never'` is an
 *   explicit operator opt-out for fully trusted targets.
 * - plugin-row `Config` — the whitelist is operator config (nixos overlay or
 *   bundle layer); editing it remounts this plugin, refreshing the tool's
 *   target listing.
 *
 * Failure semantics are deliberate: prep failures (no docker / no container /
 * start failed) are terminal — nothing ever falls back to the remote host
 * shell — and a spent budget only kills the LOCAL ssh, so a timeout reports
 * "unknown", never "failed": the remote command may still be running.
 *
 * @module dsh-remote-exec
 */
import { homedir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  DEFAULT_CONTAINER_SHELL,
  PREP_MARKER,
  REMOTE_OUTCOMES,
  buildRemoteScript,
  buildSshArgv,
  classifyOutcome,
  type RemoteOutcome,
  type RemoteTarget,
} from './exec.js'

export {
  DEFAULT_CONTAINER_SHELL,
  DEFAULT_CONTAINER_USER,
  PREP_EXIT_CODE,
  PREP_MARKER,
  REMOTE_OUTCOMES,
  SSH_EXIT_CODE,
  buildRemoteScript,
  buildSshArgv,
  classifyOutcome,
  shQuote,
} from './exec.js'
export type { RemoteOutcome, RemoteScriptOptions, RemoteTarget } from './exec.js'

/** The one tool this plugin registers. */
export const TOOL_NAME = 'remote_exec'

/**
 * Plugin-row configuration. Everything here is operator-owned: the target
 * whitelist, the budgets, and the approval mode. Plain (non-volatile) fields
 * on purpose — editing the whitelist remounts the plugin, which re-registers
 * the tool with a fresh target listing. No `Schema<Config>` annotation:
 * schemastery ≥ 3.18.4 bakes volatile modes into the schema generics and the
 * loader checks the inferred shape (same discipline as auto-env).
 */
export interface Config {
  /** ssh executable: absolute path or bare PATH name. */
  readonly sshPath: string
  /** Per-target authorization: ask once per session, every call, or never. */
  readonly approvalMode: 'session' | 'every' | 'never'
  /** Default per-call budget (ms). */
  readonly defaultTimeoutMs: number
  /** Upper bound a caller may raise the per-call budget to (ms). */
  readonly maxTimeoutMs: number
  /** Budget for docker start + running-state poll (ms). */
  readonly startTimeoutMs: number
  /** TERM→KILL grace for the local ssh when a budget expires (ms). */
  readonly graceMs: number
  /** stdout retention per call (bytes); older bytes spill to disk. */
  readonly stdoutMaxBytes: number
  /** stderr retention per call (bytes); older bytes spill to disk. */
  readonly stderrMaxBytes: number
  /** The whitelist. The model only ever picks a key of this dict. */
  readonly targets: Record<string, RemoteTarget>
}

export const Config = Schema.object({
  sshPath: Schema.string().default('ssh').description('ssh executable: absolute path or bare PATH name resolved in the harness environment.'),
  approvalMode: Schema.union(['session', 'every', 'never'])
    .default('session')
    .description('Per-target authorization: "session" asks once per session then remembers in memory, "every" asks on every call, "never" skips approval entirely — only for targets you fully trust.'),
  defaultTimeoutMs: Schema.number().step(1).min(1_000).default(600_000).description('Default per-call budget (ms).'),
  maxTimeoutMs: Schema.number().step(1).min(1_000).default(3_600_000).description('Upper bound a caller may raise the per-call budget to (ms).'),
  startTimeoutMs: Schema.number().step(1).min(1_000).default(60_000).description('Budget for docker start + running-state poll before a call (ms).'),
  graceMs: Schema.number().step(100).min(100).default(5_000).description('TERM→KILL grace for the local ssh when a budget expires (ms).'),
  stdoutMaxBytes: Schema.number().step(1).min(4_096).default(1_048_576).description('stdout kept per call (bytes); the retained tail is returned, older bytes spill to disk (64 MiB cap).'),
  stderrMaxBytes: Schema.number().step(1).min(1_024).default(65_536).description('stderr kept per call (bytes); the retained tail is returned, older bytes spill to disk (64 MiB cap).'),
  targets: Schema.dict(
    Schema.object({
      sshHost: Schema.string().required().description('~/.ssh/config alias (or user@host) of the remote docker host — never model-controlled.'),
      sshPort: Schema.number().step(1).min(1).max(65_535).description('Remote ssh port; omit to let the ssh config decide.'),
      sshOptions: Schema.array(Schema.string()).description('Operator-trusted extra ssh options, pre-split (e.g. [-o, ProxyJump=bastion]). Model input never reaches these; BatchMode=yes is forced and cannot be weakened.'),
      container: Schema.string().required().description('Container name on the remote host. Only docker inspect/start/exec ever touch it; it is never created or rebuilt.'),
      containerUser: Schema.string().description('docker exec -u spec, double-quoted in the script so $(…) stays live. Default: $(id -u):$(id -g) — the remote login user.'),
      workdir: Schema.string().required().description('docker exec -w workdir inside the container.'),
      shell: Schema.string()
        .default(DEFAULT_CONTAINER_SHELL)
        .description(`Container shell, inserted verbatim into the script (may embed $(id -un)); invoked as <shell> -l -c <command>. Default: ${DEFAULT_CONTAINER_SHELL}`),
      envInit: Schema.union(['direnv', 'none'])
        .default('direnv')
        .description('direnv mirrors remote.py (fish_add_path + direnv allow . + eval (direnv export fish) when a .envrc exists); none skips the direnv block.',
        ),
      autoStart: Schema.boolean().default(true).description('docker-start a stopped container before exec (existing containers only — never create, rebuild, or swap images).'),
      description: Schema.string().description('Human hint shown in approval prompts.'),
    }),
  )
    .default({})
    .description('Whitelisted remote targets. The model only ever picks a key of this dict; every value here is operator-owned.'),
})

/** Per-stream spill cap for collected stdout/stderr (bytes). */
const SPILL_MAX_BYTES = 64 * 1024 * 1024

/** Sessions remembered by one GrantStore before the oldest is evicted. */
const MAX_GRANT_SESSIONS = 256

/**
 * In-memory per-session target grants ("asked once, remembered for the
 * session"). Restarting the harness forgets everything — a resumed session
 * simply asks again; fold the session log's approval audit pairs here if
 * that ever needs to change (auto-permit's evidence.ts is the precedent).
 */
export class GrantStore {
  readonly #granted = new Map<string, Set<string>>()

  /** Whether `session` already holds a grant for `target`. */
  has(session: string, target: string): boolean {
    return this.#granted.get(session)?.has(target) ?? false
  }

  /** Record a grant, evicting the oldest session beyond the cap. */
  add(session: string, target: string): void {
    let targets = this.#granted.get(session)
    if (targets === undefined) {
      if (this.#granted.size >= MAX_GRANT_SESSIONS) {
        const oldest = this.#granted.keys().next().value
        if (oldest !== undefined) this.#granted.delete(oldest)
      }
      targets = new Set()
      this.#granted.set(session, targets)
    }
    targets.add(target)
  }
}

/** Per-call options for {@link RemoteRunner.run}. */
export interface RemoteRunOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/** The canonical value every remote_exec call resolves to. */
export interface RemoteRunResult {
  readonly target: string
  readonly outcome: RemoteOutcome
  readonly exitCode?: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  readonly lossy?: boolean
}

/** One host-side ssh invocation against a whitelisted target. */
export class RemoteRunner {
  readonly #ctx: Context
  readonly #config: Config
  #sshBin: string | undefined

  constructor(ctx: Context, config: Config) {
    this.#ctx = ctx
    this.#config = config
  }

  /**
   * Run `command` in `target`'s container. Never throws for remote-side
   * outcomes — every failure mode comes back as a classified
   * {@link RemoteRunResult}; only local ssh resolution failures produce
   * `spawn-error` (also as a value). The caller owns neither deadline: the
   * per-call budget and `options.signal` both abort the local ssh, and an
   * aborted run is reported as `timeout-unknown` / `cancelled-unknown`
   * because the remote command's fate is unknowable from here.
   */
  async run(name: string, target: RemoteTarget, command: string, options: RemoteRunOptions): Promise<RemoteRunResult> {
    const startedAt = Date.now()
    const script = buildRemoteScript(target, {
      command,
      startAttempts: Math.ceil(this.#config.startTimeoutMs / 1000),
    })
    let timedOut = false
    let cancelled = false
    const controller = new AbortController()
    const onCallerAbort = (): void => {
      cancelled = true
      controller.abort()
    }
    if (options.signal?.aborted === true) onCallerAbort()
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    // Own the deadline with a ref'd timer: AbortSignal.timeout() schedules
    // unref'd, so a quiet event loop could exit before the budget elapses
    // (same discipline as auto-env's direnv budget).
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    try {
      const bin = await this.#resolveSsh()
      const handle = this.#ctx.subprocess.spawn({
        argv: buildSshArgv(bin, target),
        cwd: homedir(),
        stdio: {
          stdin: { data: script },
          stdout: { maxBytes: this.#config.stdoutMaxBytes, spill: { maxBytes: SPILL_MAX_BYTES } },
          stderr: { maxBytes: this.#config.stderrMaxBytes, spill: { maxBytes: SPILL_MAX_BYTES } },
        },
        graceMs: this.#config.graceMs,
        signal: controller.signal,
      })
      let exitCode: number | null = null
      try {
        exitCode = (await handle.done).exitCode
      } catch {
        // Aborted mid-flight (or the handle rejected): the flags decide.
      }
      const stdoutRead = handle.collected.stdout?.readFrom(0)
      const stderrRead = handle.collected.stderr?.readFrom(0)
      const lossy = stdoutRead?.lossy === true || stderrRead?.lossy === true
      // Canonical tool values must be LOSSLESS JSON: a property explicitly
      // set to undefined fails dsh-util-values' snapshotJsonValue (undefined
      // is not a JSON value) and the registry rejects the whole result with
      // "value is not lossless JSON". Optional fields are therefore OMITTED,
      // never assigned undefined.
      const result: {
        target: string
        outcome: RemoteOutcome
        stdout: string
        stderr: string
        durationMs: number
        exitCode?: number
        lossy?: boolean
      } = {
        target: name,
        outcome: classifyOutcome(exitCode, stderrRead?.text ?? '', timedOut, cancelled),
        stdout: stdoutRead?.text ?? '',
        stderr: stderrRead?.text ?? '',
        durationMs: Date.now() - startedAt,
      }
      if (exitCode !== null) result.exitCode = exitCode
      if (lossy) result.lossy = true
      return result
    } catch (error) {
      // ssh resolution or the spawn itself failed (implementation-level).
      return {
        target: name,
        outcome: 'spawn-error',
        stdout: '',
        stderr: describeError(error),
        durationMs: Date.now() - startedAt,
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
    }
  }

  /** Resolve (and cache) the ssh executable; throws when not found. */
  async #resolveSsh(): Promise<string> {
    this.#sshBin ??= await this.#ctx.subprocess.resolveExecutable(this.#config.sshPath)
    return this.#sshBin
  }
}

/** Render one classified result for the model (and the transcript). */
function formatResult(value: RemoteRunResult): string {
  const head = `remote_exec[${value.target}] ${value.outcome}${value.exitCode === undefined ? '' : ` exit=${value.exitCode}`} (${(value.durationMs / 1000).toFixed(1)}s)`
  const lines = [head]
  if (value.outcome === 'timeout-unknown' || value.outcome === 'cancelled-unknown') {
    lines.push('The local ssh was stopped; the remote command may STILL BE RUNNING and its result is unknown — do not blindly re-run it.')
  }
  if (value.lossy === true) lines.push('Output exceeded the retention budget; only the retained tail is shown (full output spilled to disk).')
  if (value.stdout !== '') lines.push('--- stdout ---', value.stdout)
  if (value.stderr !== '') lines.push('--- stderr ---', value.stderr)
  return lines.join('\n')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const name = 'remote-exec'
// approval is fetched opportunistically (ctx.get('approval')) so this plugin
// also loads in compositions without an approval service — such loads then
// fail closed per call unless approvalMode is explicitly 'never'.
export const inject = ['tools', 'subprocess']

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('remote-exec')
  const runner = new RemoteRunner(ctx, config)
  const grants = new GrantStore()
  const targetNames = Object.keys(config.targets).sort()
  const listing =
    targetNames.length > 0 ? targetNames.join(' | ') : 'NONE (the operator must add targets in the plugin config first)'
  logger.info(`mounted with ${targetNames.length} target(s)${targetNames.length > 0 ? `: ${targetNames.join(', ')}` : ''}`)

  /** Ask for (or recall) this session's grant for one target. Fail-closed. */
  async function authorize(exec: ToolRunContext, name: string, target: RemoteTarget): Promise<void> {
    if (config.approvalMode === 'never') return
    const agent = exec.agent
    if (agent === undefined) {
      throw new Error(
        `remote_exec needs an owning agent to ask for target approval; refusing to run "${name}" (approvalMode is not "never")`,
      )
    }
    if (config.approvalMode === 'session' && grants.has(agent.id, name)) return
    const approval = ctx.get('approval')
    if (approval === undefined) {
      throw new Error(
        'no approval service available — failing closed. Run inside a composition with approval (e.g. web), or set approvalMode "never" for targets you explicitly trust.',
      )
    }
    const outcome = await approval.request({
      agent,
      toolName: TOOL_NAME,
      callId: exec.callId,
      reason:
        `run container commands on target "${name}" (${target.container} @ ${target.sshHost}` +
        `${target.autoStart ? ', may docker-start the stopped container' : ''})` +
        `${target.description === undefined ? '' : ` — ${target.description}`}`,
      displayReason: {
        en: `Allow remote_exec on target "${name}" (container "${target.container}" on ${target.sshHost}) for this session?`,
        zh: `允许本会话使用远端目标「${name}」(${target.sshHost} 上的容器「${target.container}」)吗?`,
      },
      signal: exec.signal,
    })
    if (outcome === 'allowed-once') {
      if (config.approvalMode === 'session') grants.add(agent.id, name)
      return
    }
    throw new Error(
      `remote target "${name}" was not authorized (approval outcome: ${outcome}); stop and tell the user instead of retrying`,
    )
  }

  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        'Run a command inside a fixed Docker container on a whitelisted remote host, over the operator ssh config (jump chains, agent forwarding and known_hosts all apply). ' +
        'The command runs through a login fish in the configured workdir — fish syntax: `env VAR=1 cmd ...`, not `VAR=1 cmd`; a project .envrc is direnv-exported first when present. ' +
        'A stopped container is docker-started first; a missing container or failed start is a terminal error — this tool never falls back to any host shell. ' +
        'Spending the budget only stops the local ssh: the remote command may still be running and its result is unknown — do not blindly re-run. ' +
        `Whitelisted targets: ${listing}.`,
      parameters: {
        target: { type: 'string', required: true, description: `Whitelisted target name. Configured: ${listing}.` },
        command: { type: 'string', required: true, description: 'fish-compatible command executed in the container workdir.' },
        timeoutMs: {
          type: 'integer',
          description: `Optional per-call budget in ms (default ${config.defaultTimeoutMs}, capped at ${config.maxTimeoutMs}).`,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: { type: 'string', required: true },
            outcome: { type: 'string', enum: REMOTE_OUTCOMES, required: true },
            exitCode: { type: 'integer', description: 'Remote exit code; omitted when unknown (timeout/cancel).' },
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
            durationMs: { type: 'integer', required: true },
            lossy: { type: 'boolean', description: 'True when an output stream exceeded its retention budget.' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: formatResult(value) }],
      },
      // Model-invisible framework backstop; per-call budgets are additionally
      // clamped against maxTimeoutMs inside execute. Declaring it asserts this
      // tool forwards exec.signal, which run() does.
      timeoutMs: config.maxTimeoutMs,
      async execute(args, exec) {
        const target = config.targets[args.target]
        if (target === undefined) {
          throw new Error(`unknown remote target ${JSON.stringify(args.target)}; configured: ${listing}`)
        }
        await authorize(exec, args.target, target)
        const timeoutMs = Math.min(Math.max(args.timeoutMs ?? config.defaultTimeoutMs, 1_000), config.maxTimeoutMs)
        const result = await runner.run(args.target, target, args.command, { timeoutMs, signal: exec.signal })
        logger.info(
          `remote_exec ${args.target} -> ${result.outcome} (exit=${result.exitCode ?? 'unknown'}, ${(result.durationMs / 1000).toFixed(1)}s)`,
        )
        return result
      },
    }),
  )
}
