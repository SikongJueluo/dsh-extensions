/**
 * Sidecar handoff metadata: the durable on-disk record that outlives the
 * in-memory `pending` map (and the whole dsh process).
 *
 * One `<timestamp>-handoff.meta.json` sits next to every brief the command
 * starts. It carries what a retry needs — the task, the origin session, the
 * picks — plus the one fact nothing else can recover: whether the fresh
 * session was ever spawned. A bare `/handoff` scans for the newest record
 * without `spawnedAt` and resumes exactly there.
 *
 * @module dsh-handoff/meta
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { coerceModelChoice, type ModelChoice } from './brief.js'
import type { HandoffTarget } from './workspace.js'

/** The durable record of one handoff attempt. */
export interface HandoffMeta {
  readonly version: 1
  /** The verbatim task description the handoff was started with. */
  readonly task: string
  /** Session id of the agent that was asked to write the brief. */
  readonly originSession: string
  /** The target picked when the handoff started (a retry's default). */
  readonly target: HandoffTarget
  /** The model route picked when the handoff started (a retry's default). */
  readonly choice: ModelChoice
  /** Epoch ms when the command ran. */
  readonly createdAt: number
  /** Epoch ms when the fresh session was created; absent = never spawned. */
  readonly spawnedAt?: number
}

/** What a retry scan recovered: the record plus its two file paths. */
export interface RecoveredHandoff {
  readonly meta: HandoffMeta
  readonly metaPath: string
  readonly briefPath: string
}

const META_SUFFIX = '-handoff.meta.json'

/** The sidecar path for one brief path. */
export function metaPathFor(briefPath: string): string {
  return `${briefPath.replace(/\.md$/, '')}.meta.json`
}

/** Persist one record; callers decide how a failure degrades. */
export async function writeMeta(metaPath: string, meta: HandoffMeta): Promise<void> {
  await mkdir(dirname(metaPath), { recursive: true })
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

/** Narrow one untrusted JSON document into a record; corrupt files read as absent. */
function coerceMeta(value: unknown): HandoffMeta | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== 1) return undefined
  if (typeof record.task !== 'string' || record.task.length === 0) return undefined
  if (typeof record.originSession !== 'string' || record.originSession.length === 0) return undefined
  const target = record.target
  if (typeof target !== 'object' || target === null) return undefined
  const targetRecord = target as Record<string, unknown>
  if (typeof targetRecord.path !== 'string' || targetRecord.path.length === 0) return undefined
  if (typeof targetRecord.title !== 'string' || targetRecord.title.length === 0) return undefined
  const workspaceId = targetRecord.workspaceId
  if (workspaceId !== undefined && typeof workspaceId !== 'string') return undefined
  const choice = coerceModelChoice(record.choice)
  if (choice === undefined) return undefined
  if (typeof record.createdAt !== 'number') return undefined
  const spawnedAt = record.spawnedAt
  if (spawnedAt !== undefined && typeof spawnedAt !== 'number') return undefined
  return {
    version: 1,
    task: record.task,
    originSession: record.originSession,
    target: {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      path: targetRecord.path,
      title: targetRecord.title,
    },
    choice,
    createdAt: record.createdAt,
    ...(spawnedAt === undefined ? {} : { spawnedAt }),
  }
}

/**
 * The newest record that never spawned: the handoff a bare `/handoff`
 * resumes. Timestamp slugs sort lexically, so the file name orders the scan;
 * corrupt records are skipped and an absent directory simply means "nothing
 * to retry".
 */
export async function findLatestUnspawned(dir: string): Promise<RecoveredHandoff | undefined> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return undefined
  }
  const sorted = names.filter(name => name.endsWith(META_SUFFIX)).sort().reverse()
  for (const name of sorted) {
    const metaPath = `${dir.replace(/\/+$/, '')}/${name}`
    try {
      const meta = coerceMeta(JSON.parse(await readFile(metaPath, 'utf8')))
      if (meta !== undefined && meta.spawnedAt === undefined) {
        return { meta, metaPath, briefPath: `${metaPath.slice(0, -'.meta.json'.length)}.md` }
      }
    } catch {
      // Unreadable or corrupt: skip; a newer healthy record wins anyway.
    }
  }
  return undefined
}

/**
 * Record that the fresh session exists, so a later bare `/handoff` cannot
 * double-spawn one brief. Never throws: a missing record (pre-feature brief,
 * or a meta write that already failed with its own warning) is a no-op.
 */
export async function markSpawned(metaPath: string): Promise<boolean> {
  try {
    const meta = coerceMeta(JSON.parse(await readFile(metaPath, 'utf8')))
    if (meta === undefined || meta.spawnedAt !== undefined) return false
    await writeFile(metaPath, `${JSON.stringify({ ...meta, spawnedAt: Date.now() }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
