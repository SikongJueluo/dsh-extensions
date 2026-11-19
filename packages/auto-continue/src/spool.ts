import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { LoggerService } from '@deepseek-ai/cordis'
import { isRecord } from './guards.js'

export interface PendingWait {
  sessionId: string

  provider: string

  code: string

  turn: number

  step?: number

  lastSeq: number

  firstFailureAt: number

  attempts: number

  probes: number

  retryAt: number
}

export function defaultSpoolPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-auto-continue', 'pending.json')
}

export interface SpoolOptions {
  path?: string

  logger?: Pick<LoggerService, 'warn'>
}

function isPendingWait(value: unknown): value is PendingWait {
  if (!isRecord(value)) return false
  const v = value
  return (
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0 &&
    typeof v.provider === 'string' &&
    typeof v.code === 'string' &&
    typeof v.turn === 'number' &&
    Number.isFinite(v.turn) &&
    typeof v.lastSeq === 'number' &&
    Number.isFinite(v.lastSeq) &&
    typeof v.firstFailureAt === 'number' &&
    Number.isFinite(v.firstFailureAt) &&
    typeof v.attempts === 'number' &&
    Number.isFinite(v.attempts) &&
    typeof v.probes === 'number' &&
    Number.isFinite(v.probes) &&
    typeof v.retryAt === 'number' &&
    Number.isFinite(v.retryAt)
  )
}

export class WaitSpool {
  private readonly path: string
  private readonly logger: Pick<LoggerService, 'warn'> | undefined
  private readonly entries = new Map<string, PendingWait>()
  private loading?: Promise<void>

  private writeChain: Promise<void> = Promise.resolve()

  constructor(options: SpoolOptions = {}) {
    this.path = options.path ?? defaultSpoolPath()
    this.logger = options.logger
  }

  load(): Promise<void> {
    this.loading ??= this.read()
    return this.loading
  }

  private async read(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      return
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      const record = isRecord(parsed) ? parsed : undefined
      const pending = record?.pending
      const list: unknown[] = Array.isArray(pending) ? pending : []
      for (const entry of list) {
        if (isPendingWait(entry)) this.entries.set(entry.sessionId, entry)
      }
    } catch (error) {
      warnQuietly(
        this.logger,
        'auto-continue: discarding corrupt pending-wait spool at %s (%s)',
        this.path,
        error instanceof Error ? error.name : 'non-error',
      )
    }
  }

  get(sessionId: string): PendingWait | undefined {
    return this.entries.get(sessionId)
  }

  all(): PendingWait[] {
    return [...this.entries.values()]
  }

  // fallow-ignore-next-line unused-class-member -- only the .mjs smoke calls it; fallow cannot attribute a JS call site
  async set(entry: PendingWait): Promise<void> {
    this.entries.set(entry.sessionId, entry)
    await this.persist()
  }

  async delete(sessionId: string): Promise<void> {
    if (!this.entries.delete(sessionId)) return
    await this.persist()
  }

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

  private persist(): Promise<void> {
    const snapshot = { version: 1, pending: [...this.entries.values()] }
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(join(this.path, '..'), { recursive: true })
        const tmp = `${this.path}.tmp`
        await writeFile(tmp, `${JSON.stringify(snapshot, null, 1)}\n`, 'utf8')
        await rename(tmp, this.path)
        return undefined
      })
      .catch(() => {})
    return this.writeChain
  }
}

function warnQuietly(
  logger: Pick<LoggerService, 'warn'> | undefined,
  format: string,
  ...args: unknown[]
): boolean {
  try {
    logger?.warn(format, ...args)
    return true
  } catch {
    return false
  }
}
