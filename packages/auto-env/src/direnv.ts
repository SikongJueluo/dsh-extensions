import { existsSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'

export type EnvOverlay = Readonly<Record<string, string | undefined>>

export type DirenvStatus = 'active' | 'none' | 'blocked' | 'timeout' | 'error' | 'missing'

export interface DirenvFacts {
  status: DirenvStatus
  overlay: EnvOverlay

  rcDir?: string

  detail?: string

  at: number

  gen: number
}

export interface DirenvOptions {
  direnvPath: string

  timeoutMs: number

  revalidateMs: number

  stdoutMaxBytes: number

  watch?: boolean
}

export interface DirenvStatusInfo {
  status: DirenvStatus | 'pending'
  rcDir?: string
  detail?: string
}

const EMPTY_OVERLAY: EnvOverlay = Object.freeze({})

const MAX_CACHED_DIRS = 64

const MAX_UPWARD_HOPS = 64

const WATCHED_BASENAMES = new Set(['.envrc', 'devenv.nix', 'devenv.yaml', 'devenv.lock'])

export function findEnvrcDir(start: string): string | undefined {
  let dir = resolve(start)
  for (let hops = 0; hops < MAX_UPWARD_HOPS; hops++) {
    if (existsSync(join(dir, '.envrc'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

export class DirenvLoader {
  readonly #ctx: Context
  readonly #options: DirenvOptions
  readonly #facts = new Map<string, DirenvFacts>()
  readonly #inflight = new Map<string, Promise<EnvOverlay>>()
  readonly #logged = new Map<string, DirenvStatus>()

  readonly #generation = new Map<string, number>()

  readonly #watchers = new Map<string, FSWatcher | undefined>()

  #allowWatcher: FSWatcher | undefined
  #direnvBin: string | undefined

  constructor(ctx: Context, options: DirenvOptions) {
    this.#ctx = ctx
    this.#options = options
  }

  dispose(): void {
    for (const [rcDir, watcher] of this.#watchers) this.#closeWatcher(watcher, rcDir)
    this.#watchers.clear()
    this.#closeWatcher(this.#allowWatcher, 'the allow list')
    this.#allowWatcher = undefined
  }

  // fallow-ignore-next-line unused-class-member -- only the .mjs smoke calls it; fallow cannot attribute a JS call site
  snapshot(dir: string): EnvOverlay | undefined {
    const rcDir = findEnvrcDir(dir)
    if (rcDir === undefined) return EMPTY_OVERLAY
    return this.#facts.get(rcDir)?.overlay
  }

  async ensure(dir: string): Promise<EnvOverlay> {
    const rcDir = findEnvrcDir(dir)
    if (rcDir === undefined) return EMPTY_OVERLAY
    const cached = this.#facts.get(rcDir)
    if (cached !== undefined && Date.now() - cached.at < this.#options.revalidateMs)
      return cached.overlay
    return this.#revalidate(rcDir)
  }

  status(dir: string): DirenvStatusInfo {
    const rcDir = findEnvrcDir(dir)
    if (rcDir === undefined) return { status: 'none' }
    const facts = this.#facts.get(rcDir)
    if (facts === undefined)
      return { status: this.#inflight.has(rcDir) ? 'pending' : 'none', rcDir }
    return {
      status: facts.status,
      rcDir,
      ...(facts.detail === undefined ? {} : { detail: facts.detail }),
    }
  }

  #revalidate(rcDir: string): Promise<EnvOverlay> {
    const running = this.#inflight.get(rcDir)
    if (running !== undefined) return running
    const task = this.#evaluate(rcDir)
      .catch((error: unknown): EnvOverlay => {
        this.#record(rcDir, this.#generation.get(rcDir) ?? 0, {
          status: 'error',
          overlay: EMPTY_OVERLAY,
          detail: describeError(error),
        })
        return EMPTY_OVERLAY
      })
      .finally(() => {
        this.#inflight.delete(rcDir)
      })
    this.#inflight.set(rcDir, task)
    return task
  }

  async #evaluate(rcDir: string): Promise<EnvOverlay> {
    const gen = this.#generation.get(rcDir) ?? 0

    this.#startRcDirWatch(rcDir)
    const bin = await this.#resolveBinary()
    if (bin === undefined) {
      this.#record(rcDir, gen, {
        status: 'missing',
        overlay: EMPTY_OVERLAY,
        detail: `direnv executable "${this.#options.direnvPath}" not found`,
      })
      return EMPTY_OVERLAY
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs)
    const settled = (): boolean => controller.signal.aborted
    let handle
    try {
      handle = this.#ctx.subprocess.spawn({
        argv: [bin, 'export', 'json'],
        cwd: rcDir,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.#options.stdoutMaxBytes, spill: { maxBytes: 16 * 1024 * 1024 } },
          stderr: { maxBytes: 16384 },
        },
        graceMs: 3_000,
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      this.#record(rcDir, gen, {
        status: 'error',
        overlay: EMPTY_OVERLAY,
        detail: describeError(error),
      })
      return EMPTY_OVERLAY
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      this.#record(rcDir, gen, {
        status: 'error',
        overlay: EMPTY_OVERLAY,
        detail: describeError(error),
      })
      return EMPTY_OVERLAY
    } finally {
      clearTimeout(timer)
    }

    const { stdout, stderr: stderrReader } = handle.collected
    if (stdout === undefined || stderrReader === undefined) {
      this.#record(rcDir, gen, {
        status: 'error',
        overlay: EMPTY_OVERLAY,
        detail: 'subprocess implementation dropped a requested collect stream',
      })
      return EMPTY_OVERLAY
    }
    const stdoutRead = stdout.readFrom(0)
    const stderr = stderrReader.readFrom(0).text.trim()
    if (settled()) {
      this.#record(rcDir, gen, {
        status: 'timeout',
        overlay: EMPTY_OVERLAY,
        detail: `direnv export did not finish within ${this.#options.timeoutMs} ms`,
      })
      return EMPTY_OVERLAY
    }
    if (outcome.exitCode !== 0) {
      const detail =
        firstLine(stderr) ?? `direnv export exited with code ${outcome.exitCode ?? 'null'}`

      const status: DirenvStatus = stderr.includes('is blocked') ? 'blocked' : 'error'
      this.#record(rcDir, gen, { status, overlay: EMPTY_OVERLAY, detail })
      return EMPTY_OVERLAY
    }
    if (stdoutRead.lossy) {
      this.#record(rcDir, gen, {
        status: 'error',
        overlay: EMPTY_OVERLAY,
        detail: `direnv export output exceeded ${this.#options.stdoutMaxBytes} bytes`,
      })
      return EMPTY_OVERLAY
    }
    let dump: unknown
    try {
      dump = stdoutRead.text.length === 0 ? {} : JSON.parse(stdoutRead.text)
    } catch {
      this.#record(rcDir, gen, {
        status: 'error',
        overlay: EMPTY_OVERLAY,
        detail: 'direnv export emitted invalid JSON',
      })
      return EMPTY_OVERLAY
    }
    if (!isJsonObject(dump)) {
      this.#record(rcDir, gen, {
        status: 'error',
        overlay: EMPTY_OVERLAY,
        detail: 'direnv export emitted a non-object JSON document',
      })
      return EMPTY_OVERLAY
    }
    const overlay = sanitizeDirenvDump(dump)
    this.#record(rcDir, gen, { status: 'active', overlay, rcDir })
    return overlay
  }

  async #resolveBinary(): Promise<string | undefined> {
    if (this.#direnvBin !== undefined) return this.#direnvBin
    try {
      this.#direnvBin = await this.#ctx.subprocess.resolveExecutable(this.#options.direnvPath)
    } catch {
      return undefined
    }
    return this.#direnvBin
  }

  #record(rcDir: string, gen: number, facts: Omit<DirenvFacts, 'at' | 'gen'>): void {
    if (gen === (this.#generation.get(rcDir) ?? 0)) {
      const entry: DirenvFacts = { ...facts, rcDir: facts.rcDir ?? rcDir, at: Date.now(), gen }
      this.#facts.delete(rcDir)
      this.#facts.set(rcDir, entry)
      if (this.#facts.size > MAX_CACHED_DIRS) {
        const oldest = this.#facts.keys().next().value
        if (oldest !== undefined) this.#forget(oldest)
      }
      this.#startRcDirWatch(rcDir)
    }
    const previous = this.#logged.get(rcDir)
    if (previous === facts.status) return
    this.#logged.set(rcDir, facts.status)
    const logger = this.#ctx.logger('auto-env')
    if (facts.status === 'active') {
      logger.info(
        `direnv active: ${Object.keys(facts.overlay).length} overlay entries for ${rcDir}`,
      )
    } else {
      logger.warn(
        `direnv ${facts.status}: ${rcDir}${facts.detail === undefined ? '' : ` — ${facts.detail}`}`,
      )
    }
  }

  #invalidate(rcDir: string, reason: string): void {
    this.#generation.set(rcDir, (this.#generation.get(rcDir) ?? 0) + 1)
    const hadFacts = this.#facts.delete(rcDir)
    if (hadFacts)
      this.#ctx
        .logger('auto-env')
        .info(`direnv inputs changed (${reason}); re-evaluating ${rcDir} on next use`)
  }

  #startRcDirWatch(rcDir: string): void {
    if (this.#options.watch === false || this.#watchers.has(rcDir)) return
    try {
      const watcher = watch(rcDir, (_event, filename) => {
        if (filename === null || WATCHED_BASENAMES.has(basename(filename)))
          this.#invalidate(rcDir, filename ?? 'unknown change')
      })
      watcher.on('error', (error) => {
        this.#watchers.delete(rcDir)
        try {
          watcher.close()
        } catch (closeError) {
          this.#logDiagnostic(
            'debug',
            `direnv input watcher close failed for ${rcDir}: ${errorTag(closeError)}`,
          )
        }
        this.#ctx
          .logger('auto-env')
          .warn(`direnv input watcher stopped for ${rcDir}: ${describeError(error)}`)
      })
      this.#watchers.set(rcDir, watcher)
      this.#startAllowWatch()
    } catch (error) {
      this.#watchers.set(rcDir, undefined)
      this.#ctx
        .logger('auto-env')
        .warn(`direnv input watcher unavailable for ${rcDir}: ${describeError(error)}`)
    }
  }

  #startAllowWatch(): void {
    if (this.#options.watch === false || this.#allowWatcher !== undefined) return
    const allowDir =
      process.env.DIRENV_CONFIG !== undefined
        ? join(process.env.DIRENV_CONFIG, 'allow')
        : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'direnv', 'allow')
    if (!existsSync(allowDir)) return
    try {
      const watcher = watch(allowDir, () => {
        for (const rcDir of this.#watchers.keys()) this.#invalidate(rcDir, 'allow list changed')
      })
      watcher.on('error', (error) => {
        if (this.#allowWatcher === watcher) this.#allowWatcher = undefined
        try {
          watcher.close()
        } catch (closeError) {
          this.#logDiagnostic(
            'debug',
            `direnv allow-list watcher close failed: ${errorTag(closeError)}`,
          )
        }
        this.#logDiagnostic('warn', `direnv allow-list watcher stopped: ${errorTag(error)}`)
      })
      this.#allowWatcher = watcher
    } catch (error) {
      this.#logDiagnostic(
        'warn',
        `direnv allow-list watcher unavailable for ${allowDir}: ${errorTag(error)}`,
      )
    }
  }

  #logDiagnostic(level: 'debug' | 'warn', message: string): boolean {
    try {
      this.#ctx.logger('auto-env')[level](message)
      return true
    } catch {
      return false
    }
  }

  #closeWatcher(watcher: FSWatcher | undefined, scope: string): void {
    if (watcher === undefined) return
    try {
      watcher.close()
    } catch (error) {
      this.#logDiagnostic('debug', `direnv watcher close failed for ${scope}: ${errorTag(error)}`)
    }
  }

  #forget(rcDir: string): void {
    this.#facts.delete(rcDir)
    this.#generation.delete(rcDir)
    this.#logged.delete(rcDir)
    const watcher = this.#watchers.get(rcDir)
    this.#watchers.delete(rcDir)
    this.#closeWatcher(watcher, rcDir)
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function sanitizeDirenvDump(dump: Record<string, unknown>): EnvOverlay {
  const overlay: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(dump)) {
    if (key.startsWith('DSH_') || key.startsWith('DIRENV_')) continue
    overlay[key] =
      value === null ? undefined : typeof value === 'string' ? value : JSON.stringify(value)
  }
  return Object.freeze(overlay)
}

// oxlint-disable-next-line eslint/no-control-regex -- the pattern exists to match ANSI escapes
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/gu

function firstLine(text: string): string | undefined {
  const line = text.replaceAll(ANSI_PATTERN, '').split('\n', 1)[0]?.trim()
  return line === undefined || line.length === 0 ? undefined : line
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = firstLine(text)
  return line ?? 'unknown error'
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u

/** Stable error identity for logs; only structured names and codes survive. */
function errorTag(error: unknown): string {
  if (!(error instanceof Error)) return 'non-error'
  const name = NAME_PATTERN.test(error.name) ? error.name : 'Error'
  const code: unknown = 'code' in error ? error.code : undefined
  if (typeof code === 'string') return CODE_PATTERN.test(code) ? `${name}(${code})` : name
  if (typeof code === 'number' && Number.isSafeInteger(code)) return `${name}(${code})`
  return name
}
