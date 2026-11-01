/**
 * Watcher for the recursive skills provider.
 *
 * The filesystem service watches one file or one directory's direct entries;
 * it is not recursive. Nested discovery therefore keeps one watcher per
 * scanned root or category (child skill addition/removal) plus one per
 * discovered bundle directory (instruction edits and symlink re-targeting).
 * Watching the directory is what makes a `SKILL.md` symlink re-point observable:
 * the filesystem service watches the resolved instruction target, not the
 * directory entry that selects it. Any event only invalidates the provider;
 * the next catalog read rescans and reconciles this watcher set.
 *
 * Every close, including one started from a runtime watcher error and never
 * awaited by a catalog read, is tracked until it settles so provider disposal
 * can wait for it.
 *
 * @module dsh-recursive-skills/watch
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'

interface WatchState {
  readonly target: FsTarget
  readonly controller: AbortController
  /**
   * Opaque path version observed when this watcher was opened. The backend
   * fixes the observation mode from the path state at initialization (absent
   * paths watch their parent filtered to the path; directories watch their
   * direct entries), so a version change means the mode may no longer match.
   */
  version: FsVersion | undefined
  opening?: Promise<void>
  close?: () => Promise<void>
}

interface PathVersion {
  readonly ok: boolean
  readonly version?: FsVersion
}

/** Coalesces watched file/directory events into registration invalidations. */
export class SkillWatcher {
  private readonly ctx: Context
  private readonly fs: FileSystem
  private readonly invalidate: () => void
  private readonly lifecycle = new AbortController()
  private readonly states = new Map<string, WatchState>()
  private readonly retiring = new Set<Promise<void>>()
  private queue: Promise<void> = Promise.resolve()
  private scheduled = false
  private closed = false

  constructor(ctx: Context, fs: FileSystem, invalidate: () => void) {
    this.ctx = ctx
    this.fs = fs
    this.invalidate = invalidate
  }

  /**
   * Make the active watcher set match `targets` exactly. Opens and closes run
   * serialized so two overlapping catalog reads cannot fight over the set.
   * @param targets - directories that currently belong to the discovered tree,
   *   including an absent root observed for later creation.
   * @returns whether at least one watcher was newly opened, meaning the caller's
   *   scan ran before that part of the tree was observable and must be repeated.
   */
  async reconcile(targets: readonly FsTarget[]): Promise<boolean> {
    if (this.closed) return false
    const desired = new Map<string, FsTarget>()
    for (const target of targets) desired.set(target.targetKey, target)
    const run = this.queue.then(() => this.apply(desired))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }

  /** Abort initialization, close every watcher, and ignore later callbacks. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.lifecycle.abort(new Error('recursive-skills watcher disposed'))
    await this.queue.catch(() => undefined)
    const states = [...this.states.values()]
    this.states.clear()
    await Promise.all(states.map((state) => this.closeState(state)))
    // Error-path closes are detached from any catalog read; disposal owns them.
    while (this.retiring.size > 0) await Promise.all([...this.retiring])
  }

  private async apply(desired: ReadonlyMap<string, FsTarget>): Promise<boolean> {
    let opened = false
    const pending: Promise<void>[] = []
    for (const [key, target] of desired) {
      if (this.closed) break
      const existing = this.states.get(key)
      if (existing !== undefined) {
        // Replace a watcher when the path version changed since it opened:
        // absent → directory (and the reverse), a deleted and recreated
        // directory, or a changed direct-entry set. Keeping the old handle
        // would leave it in the mode the backend fixed at initialization.
        const current = await this.versionOf(target)
        if (this.closed) break
        if (!current.ok || current.version === existing.version) continue
        this.states.delete(key)
        pending.push(this.closeState(existing))
      }
      const state: WatchState = { target, controller: new AbortController(), version: undefined }
      this.states.set(key, state)
      state.opening = this.open(key, state).then((didOpen) => {
        if (didOpen) opened = true
      })
      pending.push(state.opening)
    }
    for (const [key, state] of [...this.states]) {
      if (desired.has(key)) continue
      this.states.delete(key)
      pending.push(this.closeState(state))
    }
    await Promise.all(pending)
    return opened
  }

  private async open(key: string, state: WatchState): Promise<boolean> {
    const signal = AbortSignal.any([this.lifecycle.signal, state.controller.signal])
    const current = await this.versionOf(state.target)
    state.version = current.version
    if (this.closed || state.controller.signal.aborted) return false
    let close: () => Promise<void>
    try {
      close = await this.fs.watch(state.target, (error) => this.changed(key, error), signal)
    } catch (error) {
      if (this.closed || state.controller.signal.aborted) return false
      this.states.delete(key)
      this.ctx.logger.warn(
        `recursive-skills: failed to watch ${state.target.displayPath}: ${String(error)}`,
      )
      return false
    }
    if (this.closed || this.states.get(key) !== state) {
      await close()
      return false
    }
    state.close = close
    return true
  }

  /** Probe the path version that decides whether a watcher's mode is current. */
  private async versionOf(target: FsTarget): Promise<PathVersion> {
    if (this.closed) return { ok: false }
    try {
      const info = await this.fs.stat(target, this.lifecycle.signal)
      return { ok: true, ...(info === undefined ? {} : { version: info.version }) }
    } catch (error) {
      if (this.closed) return { ok: false }
      this.ctx.logger.warn(
        `recursive-skills: failed to probe ${target.displayPath} for watch mode: ${String(error)}`,
      )
      return { ok: false }
    }
  }

  private changed(key: string, error?: Error): void {
    if (this.closed) return
    if (error !== undefined) {
      // A failed watcher is dropped so the next catalog read retries it; the
      // catalog itself remains valid, only its hot-refresh path is degraded.
      const state = this.states.get(key)
      const target = state?.target.displayPath ?? key
      this.ctx.logger.warn(`recursive-skills: watcher for ${target} failed: ${String(error)}`)
      if (state !== undefined) {
        this.states.delete(key)
        this.retire(this.closeState(state))
      }
      this.scheduleInvalidate()
      return
    }
    this.scheduleInvalidate()
  }

  private scheduleInvalidate(): void {
    if (this.scheduled || this.closed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (!this.closed) this.invalidate()
    })
  }

  /** Track a detached close so disposal waits for it to settle. */
  private retire(task: Promise<void>): void {
    this.retiring.add(task)
    void task.then(
      () => this.retiring.delete(task),
      () => this.retiring.delete(task),
    )
  }

  private async closeState(state: WatchState): Promise<void> {
    state.controller.abort(new Error('recursive-skills watcher removed'))
    await state.opening?.catch(() => undefined)
    const close = state.close
    state.close = undefined
    if (close === undefined) return
    try {
      await close()
    } catch (error) {
      this.ctx.logger.warn(`recursive-skills: failed to close watcher: ${String(error)}`)
    }
  }
}
