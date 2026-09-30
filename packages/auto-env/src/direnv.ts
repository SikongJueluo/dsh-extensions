/**
 * direnv evaluation for dsh-auto-env.
 *
 * The loader answers one question per working directory: "what environment
 * would direnv load here?", as a plain overlay. It runs `direnv export json`
 * host-side (through `ctx.subprocess`, outside the model bash sandbox — the
 * sandbox denies direnv's allow-record and cache writes), converts the JSON
 * diff into `{ name: value | undefined }` (a `null` in the diff becomes an
 * unset tombstone, which the subprocess seam honors), and caches the result
 * per `.envrc` directory with TTL revalidation. direnv's own `.direnv/cache`
 * keeps repeat evaluations at ~20 ms; a cold devenv/nix evaluation can take
 * tens of seconds and is bounded by `timeoutMs`.
 *
 * Trust model: identical to interactive direnv. `direnv export` refuses an
 * `.envrc` whose hash is not in `~/.local/share/direnv/allow` ("is blocked"),
 * and this loader surfaces that as `blocked` instead of loading anything —
 * it never runs `direnv allow` itself. The allow list is shared with the
 * user's interactive direnv.
 *
 * @module dsh-auto-env/direnv
 */
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'

/**
 * One direnv environment diff: string values are set, `undefined` values are
 * unset tombstones (the subprocess seam drops the inherited key), and every
 * `DSH_*` / `DIRENV_*` key is stripped before the overlay is built.
 */
export type EnvOverlay = Readonly<Record<string, string | undefined>>

/** Terminal state of one `.envrc` evaluation. */
export type DirenvStatus = 'active' | 'none' | 'blocked' | 'timeout' | 'error' | 'missing'

/** Cached facts for one `.envrc` directory. */
export interface DirenvFacts {
  status: DirenvStatus
  overlay: EnvOverlay
  /** Directory containing the `.envrc` backing `overlay`. */
  rcDir?: string
  /** First line of diagnostic context for non-active statuses. */
  detail?: string
  /** When these facts were recorded (epoch ms). */
  at: number
  /**
   * Invalidation generation these facts were computed under; a watcher event
   * during evaluation bumps the current generation and discards the result.
   */
  gen: number
}

/** Loader options; see the plugin `Config` for the user-facing defaults. */
export interface DirenvOptions {
  /** Direnv executable: absolute path or bare PATH name. */
  direnvPath: string
  /** Budget for one `direnv export json` evaluation (ms). */
  timeoutMs: number
  /** Serve a cached overlay until it is this old, then re-evaluate (ms). */
  revalidateMs: number
  /** stdout budget for one evaluation (bytes). */
  stdoutMaxBytes: number
  /** Actively drop cached overlays when direnv inputs change (default on). */
  watch?: boolean
}

/** What `status()` reports for a directory. */
export interface DirenvStatusInfo {
  status: DirenvStatus | 'pending'
  rcDir?: string
  detail?: string
}

const EMPTY_OVERLAY: EnvOverlay = Object.freeze({})
/** Upper bound on cached `.envrc` directories (insertion-order eviction). */
const MAX_CACHED_DIRS = 64
/** How far up from a working directory to look for an `.envrc`. */
const MAX_UPWARD_HOPS = 64
/**
 * Basenames inside an `.envrc` directory whose changes drop the cached
 * overlay immediately (the common devenv inputs). direnv itself watches a
 * superset — whatever the `.envrc` `watch_file`s — so anything not listed
 * here still converges through the TTL revalidation.
 */
const WATCHED_BASENAMES = new Set(['.envrc', 'devenv.nix', 'devenv.yaml', 'devenv.lock'])

/**
 * Find the closest ancestor of `start` (inclusive) holding an `.envrc`,
 * mirroring direnv's own upward search. Returns `undefined` when there is
 * none — direnv would load nothing there.
 */
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

/**
 * Per-process direnv overlay cache with TTL revalidation.
 *
 * The cache is keyed by the `.envrc` directory (not the caller's working
 * directory), so every session and subagent rooted under one environment
 * shares a single evaluation. `ensure` never rejects: evaluation failures
 * resolve to the empty overlay and are reported through `status()`.
 */
export class DirenvLoader {
  readonly #ctx: Context
  readonly #options: DirenvOptions
  readonly #facts = new Map<string, DirenvFacts>()
  readonly #inflight = new Map<string, Promise<EnvOverlay>>()
  readonly #logged = new Map<string, DirenvStatus>()
  /** Invalidation generation per `.envrc` directory (bumped by watchers). */
  readonly #generation = new Map<string, number>()
  /** One directory watcher per cached `.envrc` directory; `undefined` = failed. */
  readonly #watchers = new Map<string, FSWatcher | undefined>()
  /** Watches direnv's allow list so an interactive `direnv allow` lands at once. */
  #allowWatcher: FSWatcher | undefined
  #direnvBin: string | undefined

  constructor(ctx: Context, options: DirenvOptions) {
    this.#ctx = ctx
    this.#options = options
  }

  /** Close every watcher; the owning plugin calls this on disposal. */
  dispose(): void {
    for (const watcher of this.#watchers.values()) this.#closeWatcher(watcher)
    this.#watchers.clear()
    this.#closeWatcher(this.#allowWatcher)
    this.#allowWatcher = undefined
  }

  /**
   * Serve the cached overlay for `dir` without evaluating anything.
   * `undefined` when nothing has been computed yet — the caller should
   * treat it as "no overlay available this once" and kick `ensure`.
   */
  snapshot(dir: string): EnvOverlay | undefined {
    const rcDir = findEnvrcDir(dir)
    if (rcDir === undefined) return EMPTY_OVERLAY
    return this.#facts.get(rcDir)?.overlay
  }

  /**
   * Resolve the overlay for `dir`, evaluating (or re-evaluating) direnv as
   * needed. Concurrent calls for the same environment share one evaluation.
   */
  async ensure(dir: string): Promise<EnvOverlay> {
    const rcDir = findEnvrcDir(dir)
    if (rcDir === undefined) return EMPTY_OVERLAY
    const cached = this.#facts.get(rcDir)
    if (cached !== undefined && Date.now() - cached.at < this.#options.revalidateMs) return cached.overlay
    return this.#revalidate(rcDir)
  }

  /** Report the current state of `dir`'s environment for `$DSH_DIRENV`. */
  status(dir: string): DirenvStatusInfo {
    const rcDir = findEnvrcDir(dir)
    if (rcDir === undefined) return { status: 'none' }
    const facts = this.#facts.get(rcDir)
    if (facts === undefined) return { status: this.#inflight.has(rcDir) ? 'pending' : 'none', rcDir }
    return { status: facts.status, rcDir, ...facts.detail === undefined ? {} : { detail: facts.detail } }
  }

  #revalidate(rcDir: string): Promise<EnvOverlay> {
    const running = this.#inflight.get(rcDir)
    if (running !== undefined) return running
    const task = this.#evaluate(rcDir)
      .catch((error: unknown): EnvOverlay => {
        // #evaluate records its own failure facts; only unexpected throws land here.
        this.#record(rcDir, this.#generation.get(rcDir) ?? 0, { status: 'error', overlay: EMPTY_OVERLAY, detail: describeError(error) })
        return EMPTY_OVERLAY
      })
      .finally(() => {
        this.#inflight.delete(rcDir)
      })
    this.#inflight.set(rcDir, task)
    return task
  }

  /** Run `direnv export json` in `rcDir` and classify the outcome. */
  async #evaluate(rcDir: string): Promise<EnvOverlay> {
    // A watcher event during this evaluation bumps the generation; the
    // then-stale result is discarded instead of cached.
    const gen = this.#generation.get(rcDir) ?? 0
    // Watch from evaluation start, not completion: a change during the very
    // first evaluation of a directory must be seen too.
    this.#startRcDirWatch(rcDir)
    const bin = await this.#resolveBinary()
    if (bin === undefined) {
      this.#record(rcDir, gen, { status: 'missing', overlay: EMPTY_OVERLAY, detail: `direnv executable "${this.#options.direnvPath}" not found` })
      return EMPTY_OVERLAY
    }
    // Own the deadline with a ref'd timer: AbortSignal.timeout() schedules
    // unref'd, so a quiet event loop could exit before the budget elapses.
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
      this.#record(rcDir, gen, { status: 'error', overlay: EMPTY_OVERLAY, detail: describeError(error) })
      return EMPTY_OVERLAY
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      this.#record(rcDir, gen, { status: 'error', overlay: EMPTY_OVERLAY, detail: describeError(error) })
      return EMPTY_OVERLAY
    } finally {
      clearTimeout(timer)
    }
    // Collect dispositions expose both readers by the seam contract; defensive.
    const { stdout, stderr: stderrReader } = handle.collected
    if (stdout === undefined || stderrReader === undefined) {
      this.#record(rcDir, gen, { status: 'error', overlay: EMPTY_OVERLAY, detail: 'subprocess implementation dropped a requested collect stream' })
      return EMPTY_OVERLAY
    }
    const stdoutRead = stdout.readFrom(0)
    const stderr = stderrReader.readFrom(0).text.trim()
    if (settled()) {
      this.#record(rcDir, gen, { status: 'timeout', overlay: EMPTY_OVERLAY, detail: `direnv export did not finish within ${this.#options.timeoutMs} ms` })
      return EMPTY_OVERLAY
    }
    if (outcome.exitCode !== 0) {
      const detail = firstLine(stderr) ?? `direnv export exited with code ${outcome.exitCode ?? 'null'}`
      // direnv refuses an .envrc whose hash is not in its allow list.
      const status: DirenvStatus = stderr.includes('is blocked') ? 'blocked' : 'error'
      this.#record(rcDir, gen, { status, overlay: EMPTY_OVERLAY, detail })
      return EMPTY_OVERLAY
    }
    if (stdoutRead.lossy) {
      this.#record(rcDir, gen, { status: 'error', overlay: EMPTY_OVERLAY, detail: `direnv export output exceeded ${this.#options.stdoutMaxBytes} bytes` })
      return EMPTY_OVERLAY
    }
    let dump: unknown
    try {
      dump = stdoutRead.text.length === 0 ? {} : JSON.parse(stdoutRead.text)
    } catch {
      this.#record(rcDir, gen, { status: 'error', overlay: EMPTY_OVERLAY, detail: 'direnv export emitted invalid JSON' })
      return EMPTY_OVERLAY
    }
    if (typeof dump !== 'object' || dump === null || Array.isArray(dump)) {
      this.#record(rcDir, gen, { status: 'error', overlay: EMPTY_OVERLAY, detail: 'direnv export emitted a non-object JSON document' })
      return EMPTY_OVERLAY
    }
    const overlay = sanitizeDirenvDump(dump as Record<string, unknown>)
    this.#record(rcDir, gen, { status: 'active', overlay, rcDir })
    return overlay
  }

  /** Resolve (and cache) the direnv executable; `undefined` when not found. */
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
      logger.info(`direnv active: ${Object.keys(facts.overlay).length} overlay entries for ${rcDir}`)
    } else {
      logger.warn(`direnv ${facts.status}: ${rcDir}${facts.detail === undefined ? '' : ` — ${facts.detail}`}`)
    }
  }

  /**
   * Drop everything cached for `rcDir` (and any in-flight result) so the
   * next use re-evaluates direnv. Called by the input watchers.
   */
  #invalidate(rcDir: string, reason: string): void {
    this.#generation.set(rcDir, (this.#generation.get(rcDir) ?? 0) + 1)
    const hadFacts = this.#facts.delete(rcDir)
    if (hadFacts) this.#ctx.logger('auto-env').info(`direnv inputs changed (${reason}); re-evaluating ${rcDir} on next use`)
  }

  /** Watch the `.envrc` directory itself (rename-safe, sees new files). */
  #startRcDirWatch(rcDir: string): void {
    if (this.#options.watch === false || this.#watchers.has(rcDir)) return
    try {
      const watcher = watch(rcDir, (_event, filename) => {
        // `null` filenames cannot be filtered; treat them as a hit.
        if (filename === null || WATCHED_BASENAMES.has(basename(filename))) this.#invalidate(rcDir, filename ?? 'unknown change')
      })
      watcher.on('error', (error) => {
        this.#watchers.delete(rcDir)
        try {
          watcher.close()
        } catch {}
        this.#ctx.logger('auto-env').warn(`direnv input watcher stopped for ${rcDir}: ${describeError(error)}`)
      })
      this.#watchers.set(rcDir, watcher)
      this.#startAllowWatch()
    } catch (error) {
      // e.g. the directory vanished; degrade to TTL-only revalidation.
      this.#watchers.set(rcDir, undefined)
      this.#ctx.logger('auto-env').warn(`direnv input watcher unavailable for ${rcDir}: ${describeError(error)}`)
    }
  }

  /**
   * Watch direnv's allow list so an interactive `direnv allow` unblocks the
   * session immediately instead of after the TTL. Any event invalidates
   * every cached environment — allow records are rare and cheap to recheck.
   */
  #startAllowWatch(): void {
    if (this.#options.watch === false || this.#allowWatcher !== undefined) return
    const allowDir = process.env.DIRENV_CONFIG !== undefined
      ? join(process.env.DIRENV_CONFIG, 'allow')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'direnv', 'allow')
    if (!existsSync(allowDir)) return
    try {
      const watcher = watch(allowDir, () => {
        for (const rcDir of [...this.#watchers.keys()]) this.#invalidate(rcDir, 'allow list changed')
      })
      watcher.on('error', () => {
        if (this.#allowWatcher === watcher) this.#allowWatcher = undefined
        try {
          watcher.close()
        } catch {}
      })
      this.#allowWatcher = watcher
    } catch {
      // No allow-list watching; blocked environments still recover via TTL.
    }
  }

  #closeWatcher(watcher: FSWatcher | undefined): void {
    if (watcher === undefined) return
    try {
      watcher.close()
    } catch {}
  }

  /** Evict one `.envrc` directory: facts, generation, and watcher. */
  #forget(rcDir: string): void {
    this.#facts.delete(rcDir)
    this.#generation.delete(rcDir)
    this.#logged.delete(rcDir)
    const watcher = this.#watchers.get(rcDir)
    this.#watchers.delete(rcDir)
    this.#closeWatcher(watcher)
  }
}

/**
 * Convert one `direnv export json` document into an overlay: `null` becomes
 * an unset tombstone, `DSH_*` (harness-managed namespace) and `DIRENV_*`
 * (direnv-internal bookkeeping the child's hook-less shell must not see)
 * are dropped, and every other value is stringified.
 */
export function sanitizeDirenvDump(dump: Record<string, unknown>): EnvOverlay {
  const overlay: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(dump)) {
    if (key.startsWith('DSH_') || key.startsWith('DIRENV_')) continue
    overlay[key] = value === null ? undefined : String(value)
  }
  return Object.freeze(overlay)
}

/** ANSI escape sequences (direnv colorizes stderr for terminals). */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g

function firstLine(text: string): string | undefined {
  // direnv colorizes stderr when it believes a terminal is attached.
  const line = text.replace(ANSI_PATTERN, '').split('\n', 1)[0]?.trim()
  return line === undefined || line.length === 0 ? undefined : line
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const line = firstLine(text)
  return line === undefined ? 'unknown error' : line
}
