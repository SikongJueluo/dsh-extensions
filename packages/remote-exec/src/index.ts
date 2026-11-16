/**
 * dsh-remote-exec — whitelisted remote container execution for DSH.
 *
 * One `remote_exec` tool runs fish commands inside a fixed Docker container
 * on a whitelisted SSH host. Targets are execution environments (host +
 * container + policy); the container directory is a per-call choice, so
 * adding a project no longer requires editing Nix config and restarting DSH.
 *
 * Four DSH seams carry the design (see docs/research-dsh-remote-exec-tool.md
 * for the original source-verified contracts):
 *
 * - `ctx.tools.register` + `defineTool` — the model-facing tool. The model
 *   picks a target key, an optional absolute container cwd, and a command;
 *   hosts, containers, users and ssh options never cross that boundary.
 * - `ctx.subprocess.spawn` — the ssh client runs HOST-side, in the harness
 *   process (argv, never a local shell), so the real `~/.ssh` config, jump
 *   chains, agent forwarding (`SSH_AUTH_SOCK` survives the env scrub) and
 *   known_hosts all apply. The model bash sandbox is never involved.
 * - `ctx.get('approval')` — the first use of a target per session asks
 *   through the same approval waterfall bash escalation uses. A missing
 *   approval service fails closed; `approvalMode: 'never'` is an explicit
 *   operator opt-out for fully trusted targets.
 * - `ctx.get('spillStore')` — when the model-facing excerpt truncates a
 *   stream, the full raw stream is saved as a session-scoped spill artifact
 *   and its locator is returned; the model retrieves it with its normal
 *   read/grep tools.
 *
 * Failure semantics are deliberate: prep failures (no docker / no container /
 * start failed) are terminal — nothing ever falls back to the remote host
 * shell — and a spent budget only kills the LOCAL ssh, so a timeout reports
 * "unknown", never "failed": the remote command may still be running.
 *
 * @module dsh-remote-exec
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
// Type-only: pulls the `ctx.spillStore` declaration merge into the program, so
// `ctx.get('spillStore')` is typed instead of `any`.
import type {} from '@deepseek-ai/dsh-spill'
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  DEFAULT_CONTAINER_SHELL,
  REMOTE_OUTCOMES,
  buildRemoteScript,
  buildSshArgv,
  classifyOutcome,
  parseControl,
  type RemoteOutcome,
  type RemoteTarget,
} from './exec.js'
import { formatDisplay } from './display.js'

export {
  CWD_EXIT_CODE,
  DEFAULT_CONTAINER_SHELL,
  DEFAULT_CONTAINER_USER,
  ENV_EXIT_CODE,
  PREP_EXIT_CODE,
  REMOTE_CONTROL_KINDS,
  REMOTE_OUTCOMES,
  SSH_EXIT_CODE,
  buildRemoteScript,
  buildSshArgv,
  classifyOutcome,
  parseControl,
  shQuote,
} from './exec.js'
export type {
  RemoteControl,
  RemoteControlKind,
  RemoteOutcome,
  RemoteScriptOptions,
  RemoteTarget,
} from './exec.js'
export { formatDisplay } from './display.js'
export type { DisplayView } from './display.js'

/** The one tool this plugin registers. */
export const TOOL_NAME = 'remote_exec'

/** A target as written in the plugin config; `defaultCwd` is validated at mount. */
export interface ConfiguredTarget {
  readonly sshHost: string
  readonly sshPort?: number
  readonly sshOptions?: readonly string[]
  readonly container: string
  readonly containerUser?: string
  /** Default container directory for calls that omit `cwd` (absolute path). */
  readonly defaultCwd: string
  readonly shell: string
  readonly envInit: 'direnv' | 'none'
  readonly autoStart: boolean
  readonly description?: string
}

/**
 * Plugin-row configuration. Everything here is operator-owned: the target
 * whitelist, the budgets, and the approval mode. Plain (non-volatile) fields
 * on purpose — editing a target remounts the plugin, which re-registers the
 * tool with a fresh target listing. No `Schema<Config>` annotation:
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
  /** stdout raw retention per call (bytes); older bytes spill to disk. */
  readonly stdoutMaxBytes: number
  /** stderr raw retention per call (bytes); older bytes spill to disk. */
  readonly stderrMaxBytes: number
  /** Per-stream model-facing display budget (bytes). */
  readonly displayMaxBytes: number
  /** The whitelist. The model only ever picks a key of this dict. */
  readonly targets: Record<string, ConfiguredTarget>
}

export const Config = Schema.object({
  sshPath: Schema.string()
    .default('ssh')
    .description(
      'ssh executable: absolute path or bare PATH name resolved in the harness environment.',
    ),
  approvalMode: Schema.union(['session', 'every', 'never'])
    .default('session')
    .description(
      'Per-target authorization: "session" asks once per session then remembers in memory, "every" asks on every call, "never" skips approval entirely — only for targets you fully trust.',
    ),
  defaultTimeoutMs: Schema.number()
    .step(1)
    .min(1_000)
    .default(600_000)
    .description('Default per-call budget (ms).'),
  maxTimeoutMs: Schema.number()
    .step(1)
    .min(1_000)
    .default(3_600_000)
    .description('Upper bound a caller may raise the per-call budget to (ms).'),
  startTimeoutMs: Schema.number()
    .step(1)
    .min(1_000)
    .default(60_000)
    .description('Budget for docker start + running-state poll before a call (ms).'),
  graceMs: Schema.number()
    .step(100)
    .min(100)
    .default(5_000)
    .description('TERM→KILL grace for the local ssh when a budget expires (ms).'),
  stdoutMaxBytes: Schema.number()
    .step(1)
    .min(4_096)
    .default(1_048_576)
    .description(
      'Raw stdout retained per call (bytes); the retained tail stays in memory and the complete stream spills to a local file (64 MiB cap). This is not the model-facing display budget.',
    ),
  stderrMaxBytes: Schema.number()
    .step(1)
    .min(1_024)
    .default(65_536)
    .description(
      'Raw stderr retained per call (bytes); the retained tail stays in memory and the complete stream spills to a local file (64 MiB cap). This is not the model-facing display budget.',
    ),
  displayMaxBytes: Schema.number()
    .step(1)
    .min(1_024)
    .default(16_384)
    .description(
      'Per-stream model-facing display budget (bytes). Longer streams are shown as a bounded head/tail excerpt and saved to the session spill store when possible.',
    ),
  targets: Schema.dict(
    Schema.object({
      sshHost: Schema.string()
        .required()
        .description(
          '~/.ssh/config alias (or user@host) of the remote docker host — never model-controlled.',
        ),
      sshPort: Schema.number()
        .step(1)
        .min(1)
        .max(65_535)
        .description('Remote ssh port; omit to let the ssh config decide.'),
      sshOptions: Schema.array(Schema.string()).description(
        'Operator-trusted extra ssh options, pre-split (e.g. [-o, ProxyJump=bastion]). Model input never reaches these; BatchMode=yes is forced and cannot be weakened.',
      ),
      container: Schema.string()
        .required()
        .description(
          'Container name on the remote host. Only docker inspect/start/exec ever touch it; it is never created or rebuilt.',
        ),
      containerUser: Schema.string().description(
        'docker exec -u spec, double-quoted in the script so $(…) stays live. Default: $(id -u):$(id -g) — the remote login user.',
      ),
      defaultCwd: Schema.string()
        .required()
        .description(
          'Absolute container directory for calls that omit cwd. Adding a project under this directory needs no config change.',
        ),
      shell: Schema.string()
        .default(DEFAULT_CONTAINER_SHELL)
        .description(
          `Container shell, inserted into a double-quoted assignment (may embed $(id -un)); invoked as <shell> -l -c <wrapper>. Default: ${DEFAULT_CONTAINER_SHELL}`,
        ),
      envInit: Schema.union(['direnv', 'none'])
        .default('direnv')
        .description(
          'direnv mirrors remote.py (fish_add_path + direnv allow . + direnv export fish) when a .envrc exists; none skips the direnv block. Environment-init failures are reported and the command is not started.',
        ),
      autoStart: Schema.boolean()
        .default(true)
        .description(
          'docker-start a stopped container before exec (existing containers only — never create, rebuild, or swap images).',
        ),
      description: Schema.string().description('Human hint shown in approval prompts.'),
    }),
  )
    .default({})
    .description(
      'Whitelisted remote targets. The model only ever picks a key of this dict; every value here is operator-owned.',
    ),
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

/** A spill artifact returned to the model for full-output retrieval. */
export interface RemoteSpill {
  readonly locator: string
  readonly bytes: number
  readonly hint: string
}

/**
 * The subset of the host `spillStore` service this plugin uses. Structural on
 * purpose: the service is host-provided and optional, so the bundle needs no
 * compile-time dependency on the spill package; the shapes mirror its
 * SaveTextSpill/SpillRef contract.
 */
/** The canonical value every remote_exec call resolves to. */
export interface RemoteRunResult {
  readonly target: string
  /** The absolute container directory this call started in. */
  readonly cwd: string
  readonly outcome: RemoteOutcome
  /** The command's exit code; present only when the command ran and returned one. */
  readonly exitCode?: number
  /** Bounded model-facing stdout excerpt (cleaned ANSI/CR/repeats). */
  readonly stdout: string
  /** Bounded model-facing stderr excerpt (command stderr, env log, or setup error). */
  readonly stderr: string
  /** Total stdout bytes before the display excerpt. */
  readonly stdoutBytes: number
  /** Total stderr content bytes before the display excerpt (control line excluded). */
  readonly stderrBytes: number
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly durationMs: number
  /** Protocol detail for setup/env/cwd failures; absent when the command ran. */
  readonly detail?: string
  /** True when a raw stream exceeded retention and only its tail is available. */
  readonly lossy?: boolean
  readonly stdoutSpill?: RemoteSpill
  readonly stderrSpill?: RemoteSpill
  /** Why a truncated stream could not be saved to the session spill store. */
  readonly spillError?: string
}

type AgentSessionId = NonNullable<ToolRunContext['agent']>['id']
type ToolCallId = ToolRunContext['callId']

/** Per-call options for {@link RemoteRunner.run}. */
export interface RemoteRunOptions {
  /** Absolute container directory (validated by the caller). */
  readonly cwd: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** Owning session for spill artifacts; omit when unavailable. */
  readonly owner?: { readonly sessionId: AgentSessionId }
  /** Tool call id for spill artifacts. */
  readonly callId?: ToolCallId
}

interface CollectedStream {
  readonly text: string
  readonly totalBytes: number
  readonly lossy: boolean
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
   * Run `command` in `target`'s container at `options.cwd`. Never throws for
   * remote-side outcomes — every failure mode comes back as a classified
   * {@link RemoteRunResult}; only local ssh resolution failures produce
   * `spawn-error` (also as a value). The caller owns neither deadline: the
   * per-call budget and `options.signal` both abort the local ssh, and an
   * aborted run is reported as `timeout-unknown` / `cancelled-unknown`
   * because the remote command's fate is unknowable from here.
   */
  async run(
    name: string,
    target: RemoteTarget,
    command: string,
    options: RemoteRunOptions,
  ): Promise<RemoteRunResult> {
    const startedAt = Date.now()
    const nonce = randomBytes(16).toString('hex')
    const script = buildRemoteScript(target, {
      command,
      cwd: options.cwd,
      nonce,
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
      const stdout = await this.#readCollected(handle.collected.stdout)
      const stderr = await this.#readCollected(handle.collected.stderr)
      const control = parseControl(stderr.text, nonce)
      const stderrContent = control?.before ?? stderr.text
      const controlLineBytes =
        control === undefined
          ? 0
          : Buffer.byteLength(stderr.text, 'utf8') - Buffer.byteLength(control.before, 'utf8')
      const stderrBytes = Math.max(0, stderr.totalBytes - controlLineBytes)
      const outcome = classifyOutcome(exitCode, control, timedOut, cancelled)
      const commandExitCode =
        outcome === 'ok' && control?.kind === 'command-start'
          ? parseExitCode(control.detail, exitCode)
          : undefined
      const detail =
        control === undefined || control.kind === 'command-start' ? undefined : control.detail
      const stdoutView = formatDisplay(stdout.text, this.#config.displayMaxBytes)
      const stderrView = formatDisplay(stderrContent, this.#config.displayMaxBytes)
      const stdoutTruncated = stdoutView.truncated || stdout.lossy
      const stderrTruncated = stderrView.truncated || stderr.lossy
      const lossy = stdout.lossy || stderr.lossy
      const spillError: string[] = []
      let stdoutSpill: RemoteSpill | undefined
      let stderrSpill: RemoteSpill | undefined
      if ((stdoutView.truncated || stdout.lossy) && stdout.text !== '') {
        try {
          stdoutSpill = await this.#saveSpill('stdout', name, stdout.text, stdout.lossy, options)
        } catch (error) {
          spillError.push(`stdout: ${describeError(error)}`)
        }
      }
      if ((stderrView.truncated || stderr.lossy) && stderrContent !== '') {
        try {
          stderrSpill = await this.#saveSpill('stderr', name, stderrContent, stderr.lossy, options)
        } catch (error) {
          spillError.push(`stderr: ${describeError(error)}`)
        }
      }
      const spillErrorText = spillError.length > 0 ? spillError.join('; ').slice(0, 500) : undefined
      // Canonical tool values must be LOSSLESS JSON: a property explicitly
      // set to undefined fails dsh-util-values' snapshotJsonValue and the
      // registry rejects the whole result. Optional fields are therefore
      // OMITTED, never assigned undefined.
      return {
        target: name,
        cwd: options.cwd,
        outcome,
        ...(commandExitCode === undefined ? {} : { exitCode: commandExitCode }),
        stdout: stdoutView.text,
        stderr: stderrView.text,
        stdoutBytes: stdout.totalBytes,
        stderrBytes,
        stdoutTruncated,
        stderrTruncated,
        ...(detail === undefined ? {} : { detail }),
        ...(lossy ? { lossy: true } : {}),
        ...(stdoutSpill === undefined ? {} : { stdoutSpill }),
        ...(stderrSpill === undefined ? {} : { stderrSpill }),
        ...(spillErrorText === undefined ? {} : { spillError: spillErrorText }),
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      // ssh resolution or the spawn itself failed (implementation-level).
      const message = describeError(error)
      return {
        target: name,
        cwd: options.cwd,
        outcome: 'spawn-error',
        stdout: '',
        stderr: message,
        stdoutBytes: 0,
        stderrBytes: Buffer.byteLength(message, 'utf8'),
        stdoutTruncated: false,
        stderrTruncated: false,
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

  /**
   * Read one collected stream. When the in-memory tail lost its head and the
   * provider left a spill file, read the complete stream back from it; if
   * that read fails (or the stream exceeded the spill cap), keep the tail and
   * mark the stream lossy.
   */
  async #readCollected(reader: SubprocessOutputReader | undefined): Promise<CollectedStream> {
    if (reader === undefined) return { text: '', totalBytes: 0, lossy: false }
    const read = reader.readFrom(0)
    if (!read.lossy || read.spillPath === undefined) {
      return { text: read.text, totalBytes: read.nextOffset, lossy: read.lossy }
    }
    try {
      return {
        text: await readFile(read.spillPath, 'utf8'),
        totalBytes: read.nextOffset,
        lossy: false,
      }
    } catch {
      return { text: read.text, totalBytes: read.nextOffset, lossy: true }
    }
  }

  /** Save the full raw stream as a session-scoped spill artifact. */
  async #saveSpill(
    stream: 'stdout' | 'stderr',
    target: string,
    content: string,
    lossy: boolean,
    options: RemoteRunOptions,
  ): Promise<RemoteSpill> {
    const store = this.#ctx.get('spillStore')
    if (store === undefined) throw new Error('the spill store service is not mounted')
    if (options.owner === undefined) throw new Error('no owning session is available')
    if (options.callId === undefined) throw new Error('no tool call id is available')
    const ref = await store.saveText({
      owner: { sessionId: options.owner.sessionId },
      source: {
        kind: 'tool',
        toolName: TOOL_NAME,
        callId: options.callId,
        label: `${stream} of remote_exec[${target}]`,
      },
      suggestedName: `remote-exec-${target}-${stream}${lossy ? '-tail' : ''}.log`,
      content,
    })
    return { locator: ref.locator, bytes: ref.bytes, hint: ref.retrievalHint }
  }
}

/**
 * Parse the host-recorded command exit code, falling back to the ssh exit code.
 * `detail` is the shell's own `$?` (always a decimal 0-255), so `Number` and
 * `Number.parseInt` agree on every reachable value.
 */
function parseExitCode(detail: string, fallback: number | null): number | undefined {
  const parsed = Number(detail)
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 255) return parsed
  return fallback ?? undefined
}

/** Render one classified result for the model (and the transcript). */
export function formatResult(value: RemoteRunResult): string {
  const head = `remote_exec[${value.target}] ${value.outcome}${value.exitCode === undefined ? '' : ` exit=${value.exitCode}`} (${(value.durationMs / 1000).toFixed(1)}s) cwd=${JSON.stringify(value.cwd)}`
  const lines = [head]
  switch (value.outcome) {
    case 'timeout-unknown':
    case 'cancelled-unknown':
      lines.push(
        'The local ssh was stopped; the remote command may STILL BE RUNNING and its result is unknown — do not blindly re-run it.',
      )
      break
    case 'ssh-error':
      lines.push(
        'The ssh transport failed; if the command had started, it may still be running — do not blindly re-run it.',
      )
      break
    case 'prep-error':
      lines.push('Preparation failed; the command was NOT started.')
      break
    case 'cwd-error':
      lines.push('The requested cwd is not accessible; the command was NOT started.')
      break
    case 'env-error':
      lines.push('Environment initialization failed; the command was NOT started.')
      break
    case 'status-unknown':
      lines.push(
        'The command may have run, but its completion status could not be read; do not blindly re-run it.',
      )
      break
    case 'spawn-error':
      lines.push('The local ssh could not be started; the command was NOT started.')
      break
    case 'ok':
      break
  }
  if (value.detail !== undefined) lines.push(`detail: ${value.detail}`)
  if (value.stdout !== '') {
    lines.push(
      `--- stdout (${value.stdoutBytes} bytes${value.stdoutTruncated ? ', excerpt' : ''}) ---`,
      value.stdout,
    )
  } else if (value.stdoutBytes > 0) {
    lines.push(`--- stdout (${value.stdoutBytes} bytes, not shown) ---`)
  }
  if (value.stderr !== '') {
    lines.push(
      `--- stderr (${value.stderrBytes} bytes${value.stderrTruncated ? ', excerpt' : ''}) ---`,
      value.stderr,
    )
  } else if (value.stderrBytes > 0) {
    lines.push(`--- stderr (${value.stderrBytes} bytes, not shown) ---`)
  }
  if (value.stdoutSpill !== undefined) {
    lines.push(
      `full stdout: ${value.stdoutSpill.locator} (${value.stdoutSpill.bytes} bytes; ${value.stdoutSpill.hint})`,
    )
  }
  if (value.stderrSpill !== undefined) {
    lines.push(
      `full stderr: ${value.stderrSpill.locator} (${value.stderrSpill.bytes} bytes; ${value.stderrSpill.hint})`,
    )
  }
  if (value.lossy === true) {
    lines.push(
      'Raw output exceeded retention; only the retained tail is available (a spill artifact, if present, is that tail).',
    )
  }
  if (value.spillError !== undefined) lines.push(`Full output unavailable: ${value.spillError}`)
  return lines.join('\n')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve config targets: one required default cwd per target, validated at mount. */
export function resolveTargets(
  targets: Record<string, ConfiguredTarget>,
): Map<string, RemoteTarget> {
  const resolved = new Map<string, RemoteTarget>()
  for (const [name, target] of Object.entries(targets)) {
    resolved.set(name, resolveTarget(name, target))
  }
  return resolved
}

function resolveTarget(name: string, target: ConfiguredTarget): RemoteTarget {
  assertAbsoluteCwd(`remote target "${name}"`, target.defaultCwd)
  return {
    sshHost: target.sshHost,
    ...(target.sshPort === undefined ? {} : { sshPort: target.sshPort }),
    ...(target.sshOptions === undefined ? {} : { sshOptions: target.sshOptions }),
    container: target.container,
    ...(target.containerUser === undefined ? {} : { containerUser: target.containerUser }),
    defaultCwd: target.defaultCwd,
    shell: target.shell,
    envInit: target.envInit,
    autoStart: target.autoStart,
    ...(target.description === undefined ? {} : { description: target.description }),
  }
}

function assertAbsoluteCwd(label: string, cwd: string): void {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    throw new Error(`${label} cwd must be an absolute container path: ${JSON.stringify(cwd)}`)
  }
  if (cwd.includes('\0')) {
    throw new Error(`${label} cwd must not contain NUL`)
  }
}

function resolveCallCwd(requested: string | undefined, target: RemoteTarget): string {
  if (requested === undefined) return target.defaultCwd
  assertAbsoluteCwd('remote_exec', requested)
  return requested
}

export const name = 'remote-exec'
// approval is fetched opportunistically (ctx.get('approval')) so this plugin
// also loads in compositions without an approval service — such loads then
// fail closed per call unless approvalMode is explicitly 'never'. The spill
// store is equally optional; a missing store only degrades full-output
// retrieval, never the command result.
export const inject = ['tools', 'subprocess']

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('remote-exec')
  const resolvedTargets = resolveTargets(config.targets)
  const runner = new RemoteRunner(ctx, config)
  const grants = new GrantStore()
  const targetEntries = [...resolvedTargets.entries()].toSorted(([a], [b]) => a.localeCompare(b))
  const targetNames = targetEntries.map(([id]) => id)
  const listing =
    targetEntries.length > 0
      ? targetEntries.map(([id, target]) => `${id} (default cwd: ${target.defaultCwd})`).join(' | ')
      : 'NONE (the operator must add targets in the plugin config first)'
  logger.info(
    `mounted with ${targetNames.length} target(s)${targetNames.length > 0 ? `: ${targetNames.join(', ')}` : ''}`,
  )

  /** Ask for (or recall) this session's grant for one target. Fail-closed. */
  async function authorize(
    exec: ToolRunContext,
    targetName: string,
    target: RemoteTarget,
  ): Promise<void> {
    if (config.approvalMode === 'never') return
    const agent = exec.agent
    if (agent === undefined) {
      throw new Error(
        `remote_exec needs an owning agent to ask for target approval; refusing to run "${targetName}" (approvalMode is not "never")`,
      )
    }
    if (config.approvalMode === 'session' && grants.has(agent.id, targetName)) return
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
      reason: `run container commands on target "${targetName}" (${target.container} @ ${target.sshHost}${target.autoStart ? ', may docker-start the stopped container' : ''})${target.description === undefined ? '' : ` — ${target.description}`}`,
      displayReason: {
        en: `Allow remote_exec on target "${targetName}" (container "${target.container}" on ${target.sshHost}) for this session?`,
        zh: `允许本会话使用远端目标「${targetName}」(${target.sshHost} 上的容器「${target.container}」)吗?`,
      },
      signal: exec.signal,
    })
    if (outcome === 'allowed-once') {
      if (config.approvalMode === 'session') grants.add(agent.id, targetName)
      return
    }
    throw new Error(
      `remote target "${targetName}" was not authorized (approval outcome: ${outcome}); stop and tell the user instead of retrying`,
    )
  }

  const targetParameter =
    targetNames.length > 0
      ? {
          type: 'string' as const,
          required: true as const,
          enum: targetNames,
          description: `Whitelisted target name. Configured: ${listing}.`,
        }
      : {
          type: 'string' as const,
          required: true as const,
          description: `Whitelisted target name. ${listing}.`,
        }

  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        'Run a fish command inside a fixed Docker container on a whitelisted remote host, over the operator ssh config (jump chains, agent forwarding and known_hosts all apply). ' +
        'Choose a target and an optional absolute container cwd; each call starts in that cwd and shares no shell state with other calls. A project .envrc is direnv-exported before the command; environment-init failures are reported separately and the command is not started. ' +
        'A stopped container is docker-started first; a missing container or failed start is a terminal error — this tool never falls back to any host shell. ' +
        'Output is a bounded head/tail view; when it is truncated, the result includes a spill locator for the full raw output (read/grep it). ' +
        'Spending the budget only stops the local ssh: the remote command may still be running and its result is unknown — do not blindly re-run. ' +
        `Targets: ${listing}.`,
      parameters: {
        target: targetParameter,
        cwd: {
          type: 'string',
          description:
            'Absolute directory inside the container for this call. Omit to use the target default cwd. The directory must already exist; it is never created.',
        },
        command: {
          type: 'string',
          required: true,
          description:
            'fish-compatible command executed in cwd (fish syntax: `env VAR=1 cmd`, not `VAR=1 cmd`).',
        },
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
            cwd: { type: 'string', required: true },
            outcome: { type: 'string', enum: REMOTE_OUTCOMES, required: true },
            exitCode: {
              type: 'integer',
              description:
                'Command exit code; omitted when the command did not run or its exit is unknown.',
            },
            stdout: { type: 'string', required: true },
            stderr: { type: 'string', required: true },
            stdoutBytes: {
              type: 'integer',
              required: true,
              description: 'Total stdout bytes before the display excerpt.',
            },
            stderrBytes: {
              type: 'integer',
              required: true,
              description:
                'Total stderr content bytes before the display excerpt (protocol control line excluded).',
            },
            stdoutTruncated: {
              type: 'boolean',
              required: true,
              description: 'True when stdout is an excerpt, not the complete stream.',
            },
            stderrTruncated: {
              type: 'boolean',
              required: true,
              description: 'True when stderr is an excerpt, not the complete stream.',
            },
            durationMs: { type: 'integer', required: true },
            detail: {
              type: 'string',
              description:
                'Protocol detail for setup/env/cwd failures; absent when the command ran.',
            },
            lossy: {
              type: 'boolean',
              description:
                'True when a raw stream exceeded retention and only its tail is available.',
            },
            spillError: {
              type: 'string',
              description:
                'Set when a truncated stream could not be saved to the session spill store.',
            },
            stdoutSpill: {
              type: 'object',
              additionalProperties: false,
              properties: {
                locator: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                hint: { type: 'string', required: true },
              },
            },
            stderrSpill: {
              type: 'object',
              additionalProperties: false,
              properties: {
                locator: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                hint: { type: 'string', required: true },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: formatResult(value) }],
      },
      // Model-invisible framework backstop; per-call budgets are additionally
      // clamped against maxTimeoutMs inside execute. Declaring it asserts this
      // tool forwards exec.signal, which run() does.
      timeoutMs: config.maxTimeoutMs,
      async execute(args, exec) {
        const target = resolvedTargets.get(args.target)
        if (target === undefined) {
          throw new Error(
            `unknown remote target ${JSON.stringify(args.target)}; configured: ${listing}`,
          )
        }
        const cwd = resolveCallCwd(args.cwd, target)
        await authorize(exec, args.target, target)
        const timeoutMs = Math.min(
          Math.max(args.timeoutMs ?? config.defaultTimeoutMs, 1_000),
          config.maxTimeoutMs,
        )
        const result = await runner.run(args.target, target, args.command, {
          cwd,
          timeoutMs,
          signal: exec.signal,
          ...(exec.agent === undefined ? {} : { owner: { sessionId: exec.agent.id } }),
          callId: exec.callId,
        })
        logger.info(
          `remote_exec ${args.target} cwd=${JSON.stringify(cwd)} -> ${result.outcome} (exit=${result.exitCode ?? 'unknown'}, ${(result.durationMs / 1000).toFixed(1)}s)`,
        )
        if (result.spillError !== undefined)
          logger.warn(`remote_exec ${args.target}: ${result.spillError}`)
        return result
      },
    }),
  )
}
