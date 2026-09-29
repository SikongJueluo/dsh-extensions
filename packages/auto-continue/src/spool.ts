/**
 * Durable pending-wait records: the persistence half of auto-continue.
 *
 * One JSON spool file under `$DSH_HOME/storages/dsh-auto-continue/` holds one
 * record per session whose recovery wait is in flight. Records are written
 * before every wait begins (atomically: tmp file + rename) and removed when
 * the wait fires, is cancelled by the user, or gives up — but deliberately
 * KEPT when the plugin unloads mid-wait, so a restarted (or updated) plugin
 * adopts them and the session still resumes at the quota reset even across
 * harness restarts.
 *
 * The single-process assumption matches the deployment (one dsh host); a
 * second process reading the same spool would at worst duplicate one resume
 * message.
 *
 * @module dsh-auto-continue/spool
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'

/** One pending auto-continue wait, as persisted across restarts. */
export interface PendingWait {
  /** The session whose turn is waiting. */
  sessionId: string
  /** Provider route that reported the failure. */
  provider: string
  /** Failure code being recovered (`QUOTA` / `RATE_LIMIT`). */
  code: string
  /** The interrupted turn number. */
  turn: number
  /** Session log seq of the `llm/retry` event that scheduled this wait. */
  lastSeq: number
  /** When the first owned failure for this turn arrived (deadline anchor). */
  firstFailureAt: number
  /** Retry counter so far (continues across restarts). */
  attempts: number
  /** Probe index so far (for fallback probing without quota snapshots). */
  probes: number
  /** Epoch ms when the wait should fire (reset-aligned or probe). */
  retryAt: number
}

/** Where the spool lives by default: `$DSH_HOME` (matching dsh-home-paths) over `~/.dsh`. */
export function defaultSpoolPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-auto-continue', 'pending.json')
}

export interface SpoolOptions {
  /** Spool file path (default: {@link defaultSpoolPath}). */
  path?: string
}

function isPendingWait(value: unknown): value is PendingWait {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.sessionId === 'string' && v.sessionId.length > 0 &&
    typeof v.provider === 'string' &&
    typeof v.code === 'string' &&
    typeof v.turn === 'number' && Number.isFinite(v.turn) &&
    typeof v.lastSeq === 'number' && Number.isFinite(v.lastSeq) &&
    typeof v.firstFailureAt === 'number' && Number.isFinite(v.firstFailureAt) &&
    typeof v.attempts === 'number' && Number.isFinite(v.attempts) &&
    typeof v.probes === 'number' && Number.isFinite(v.probes) &&
    typeof v.retryAt === 'number' && Number.isFinite(v.retryAt)
  )
}

export class WaitSpool {
  private readonly path: string
  private readonly entries = new Map<string, PendingWait>()
  private loaded = false
  /** Serialize disk writes; each set/delete replaces the queued snapshot. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: SpoolOptions = {}) {
    this.path = options.path ?? defaultSpoolPath()
  }

  /** Read the spool once; a missing or corrupt file starts empty. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const list = Array.isArray((parsed as { pending?: unknown })?.pending) ? (parsed as { pending: unknown[] }).pending : []
      for (const entry of list) {
        if (isPendingWait(entry)) this.entries.set(entry.sessionId, entry)
      }
    } catch {
      // Corrupt spool: start empty rather than refusing to work.
    }
  }

  /** The session's pending record, when loaded. */
  get(sessionId: string): PendingWait | undefined {
    return this.entries.get(sessionId)
  }

  /** Every pending record (after {@link load}). */
  all(): PendingWait[] {
    return [...this.entries.values()]
  }

  /** Insert or replace one session's record, then persist. */
  async set(entry: PendingWait): Promise<void> {
    this.entries.set(entry.sessionId, entry)
    await this.persist()
  }

  /** Remove one session's record (wait fired / cancelled / given up), then persist. */
  async delete(sessionId: string): Promise<void> {
    if (!this.entries.delete(sessionId)) return
    await this.persist()
  }

  /** Drop records whose total wait budget is exhausted; returns the dropped ids. */
  async pruneExpired(maxWaitMs: number, now: number = Date.now()): Promise<string[]> {
    const dropped: string[] = []
    for (const entry of this.entries.values()) {
      if (now - entry.firstFailureAt >= maxWaitMs) dropped.push(entry.sessionId)
    }
    if (dropped.length > 0) {
      for (const id of dropped) this.entries.delete(id)
      await this.persist()
    }
    return dropped
  }

  /** Atomic write: tmp file + rename, serialized behind any prior write. */
  private persist(): Promise<void> {
    const snapshot = { version: 1, pending: [...this.entries.values()] }
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(join(this.path, '..'), { recursive: true })
        const tmp = `${this.path}.tmp`
        await writeFile(tmp, `${JSON.stringify(snapshot, null, 1)}\n`, 'utf8')
        await rename(tmp, this.path)
      })
      .catch(() => {
        // A failed spool write degrades to in-memory-only waiting; the next
        // successful write re-persists the full snapshot.
      })
    return this.writeChain
  }
}
