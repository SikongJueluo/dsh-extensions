/**
 * Restart-resume: keep harness restarts non-destructive for running turns.
 *
 * The plugin mirrors the set of RUNNING sessions into a small durable file on
 * every status transition (not just at shutdown — teardown ordering then
 * cannot lose it, and even a hard kill leaves the last known state behind).
 * On the next boot every fresh entry inside the max-age window is resumed:
 * the session is cold-opened and sent a continuation message, unless its log
 * shows the interrupted turn actually completed (the status write raced the
 * kill) — a session the user stopped manually is never in the set, because
 * stopping flips it to idle and the mirror drops it.
 *
 * A resumed turn that immediately hits a quota failure re-enters the normal
 * quota-wait path, so restart-resume and reset-aligned waiting compose.
 *
 * @module dsh-auto-continue/restart
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type {} from './shims.js'

/** The continuation message sent into a restarted-mid-flight session. */
export const RESTART_RESUME_MESSAGE =
  '[auto-continue] The harness restarted while this session was working and the running turn was interrupted. Continue that work from exactly where it stopped.'

/** One mirrored entry: a session that was RUNNING as of `at`. */
interface RunningEntry {
  sessionId: string
  at: number
}

interface MirrorFile {
  version: 1
  entries: RunningEntry[]
}

/** Where the mirror lives: `$DSH_HOME` (matching dsh-home-paths) over `~/.dsh`. */
export function defaultMirrorPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-auto-continue', 'running.json')
}

/** Stagger between consecutive cold-open resumes at boot. */
const RESUME_STAGGER_MS = 2_000
/** Grace period after boot before the first resume fires. */
const BOOT_SETTLE_MS = 5_000

function isEntry(value: unknown): value is RunningEntry {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.sessionId === 'string' && v.sessionId.length > 0 && typeof v.at === 'number' && Number.isFinite(v.at)
}

/** Whether the session's last completed turn actually finished (race guard). */
function lastTurnCompleted(agent: Agent): boolean {
  const events = agent.session.ownEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined || event.type !== 'turn/end') continue
    const reason = (event.data as { reason?: { kind?: unknown } } | null)?.reason
    return reason?.kind === 'completed'
  }
  return false
}

/**
 * Register the running-sessions mirror and the boot-time resumption pass.
 * Both unwind on plugin disposal.
 */
export function registerRestartResume(
  ctx: Context,
  config: { resumeOnRestart: boolean; resumeMaxAgeMs: number },
  options: { mirrorPath?: string; settleMs?: number; staggerMs?: number } = {},
): void {
  const path = options.mirrorPath ?? defaultMirrorPath()
  const settleMs = options.settleMs ?? BOOT_SETTLE_MS
  const staggerMs = options.staggerMs ?? RESUME_STAGGER_MS
  const lifetime = new AbortController()
  const running = new Map<string, number>()
  let writeChain: Promise<void> = Promise.resolve()

  const persist = (entries: RunningEntry[]): void => {
    const snapshot: MirrorFile = { version: 1, entries }
    writeChain = writeChain
      .then(async () => {
        await mkdir(join(path, '..'), { recursive: true })
        const tmp = `${path}.tmp`
        await writeFile(tmp, `${JSON.stringify(snapshot, null, 1)}\n`, 'utf8')
        await rename(tmp, path)
      })
      .catch(() => {
        // A failed mirror write only narrows restart coverage; waiting goes on.
      })
  }

  // Mirror every transition: running → record, idle → drop. Immediate write,
  // so the file always reflects the last state death could have interrupted.
  ctx.on('agent/status', (payload) => {
    if (lifetime.signal.aborted) return
    const sessionId = String(payload.agent.id)
    if (payload.status === 'running') running.set(sessionId, Date.now())
    else running.delete(sessionId)
    persist([...running.entries()].map(([id, at]) => ({ sessionId: id, at })))
  })

  const resumeMessage = createUserMessage({
    content: [{ type: 'text', text: RESTART_RESUME_MESSAGE }],
    source: { kind: 'user' },
  })

  const resumeOne = async (entry: RunningEntry): Promise<void> => {
    const registry = ctx.get('agents')
    let agent: Agent | undefined = registry?.get(entry.sessionId as Parameters<typeof registry.get>[0])
    if (agent === undefined) {
      const controller = ctx.get('sessionController')
      if (controller === undefined) {
        ctx.logger.warn('auto-continue: no sessionController to resume "%s" after restart', entry.sessionId)
        return
      }
      const result = await controller.agents.resolveAgent(entry.sessionId as Parameters<typeof controller.agents.resolveAgent>[0])
      if ('error' in result) {
        ctx.logger.warn('auto-continue: cannot reopen "%s" after restart (%o)', entry.sessionId, result.error)
        return
      }
      agent = result.agent
    }
    if (lastTurnCompleted(agent)) {
      ctx.logger.info('auto-continue: "%s" finished its turn before the restart — not resumed', entry.sessionId)
      return
    }
    agent.followup(resumeMessage)
    ctx.logger.info('auto-continue: resumed "%s" after restart', entry.sessionId)
  }

  const adoptAtBoot = async (): Promise<void> => {
    if (!config.resumeOnRestart || lifetime.signal.aborted) return
    let doc: MirrorFile | undefined
    try {
      doc = JSON.parse(await readFile(path, 'utf8')) as MirrorFile
    } catch {
      return
    }
    // One-shot: consume the mirror immediately, whatever we do with it.
    persist([])
    const entries = Array.isArray(doc?.entries) ? doc.entries.filter(isEntry) : []
    const now = Date.now()
    const fresh = entries.filter((entry) => now - entry.at < config.resumeMaxAgeMs)
    const stale = entries.length - fresh.length
    if (stale > 0) ctx.logger.info('auto-continue: %d restart-resume entr%s past the max-age window — skipped', stale, stale === 1 ? 'y is' : 'ies are')
    if (fresh.length === 0) return
    // Let the composition settle, then resume one session at a time.
    await new Promise((resolve) => setTimeout(resolve, settleMs))
    for (const entry of fresh) {
      if (lifetime.signal.aborted) return
      try {
        await resumeOne(entry)
      } catch (error) {
        ctx.logger.warn('auto-continue: restart-resume of "%s" failed: %o', entry.sessionId, error)
      }
      await new Promise((resolve) => setTimeout(resolve, staggerMs))
    }
  }

  // The boot pass waits for the plugin tree (and sessionController) to exist;
  // a plain delay is enough because apply runs during composition.
  void adoptAtBoot()

  ctx.effect(() => () => {
    lifetime.abort(new Error('auto-continue plugin disposed'))
  }, 'auto-continue: stop restart-resume')
}
