import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { SessionControllerShim } from './shims.js'
import { isRecord } from './guards.js'

export const RESTART_RESUME_MESSAGE =
  '[auto-continue] The harness restarted while this session was working and the running turn was interrupted. Continue that work from exactly where it stopped.'

interface RunningEntry {
  sessionId: string
  at: number
}

interface MirrorFile {
  version: 1
  entries: RunningEntry[]
}

export function defaultMirrorPath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-auto-continue', 'running.json')
}

const RESUME_STAGGER_MS = 2_000

const BOOT_SETTLE_MS = 5_000

const CONTROLLER_WAIT_MS = 30_000
const CONTROLLER_POLL_MS = 1_000

function isEntry(value: unknown): value is RunningEntry {
  if (!isRecord(value)) return false
  const v = value
  return (
    typeof v.sessionId === 'string' &&
    v.sessionId.length > 0 &&
    typeof v.at === 'number' &&
    Number.isFinite(v.at)
  )
}

function lastTurnCompleted(agent: Agent): boolean {
  // oxlint-disable-next-line typescript/no-deprecated -- A25: the deprecated synchronous session-log readers have no sync replacement; the sanctioned ones are async and optional, so migrating changes exported contracts and control flow.
  const events = agent.session.ownEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event === undefined || event.type !== 'turn/end') continue
    const reason = event.data.reason
    return reason?.kind === 'completed'
  }
  return false
}

export function registerRestartResume(
  ctx: Context,
  config: { resumeOnRestart: boolean; resumeMaxAgeMs: number },
  options: {
    mirrorPath?: string
    settleMs?: number
    staggerMs?: number
    controllerWaitMs?: number
    controllerPollMs?: number
  } = {},
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
        return undefined
      })
      .catch(() => {})
  }

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

  const awaitController = async (): Promise<SessionControllerShim | undefined> => {
    const deadline = Date.now() + (options.controllerWaitMs ?? CONTROLLER_WAIT_MS)
    for (;;) {
      const controller = ctx.get('sessionController')
      if (controller !== undefined || lifetime.signal.aborted || Date.now() >= deadline) {
        return controller ?? undefined
      }
      await new Promise((resolve) => {
        setTimeout(resolve, options.controllerPollMs ?? CONTROLLER_POLL_MS)
      })
    }
  }

  const resumeOne = async (entry: RunningEntry): Promise<boolean> => {
    const registry: AgentRegistry | undefined = ctx.get('agents')
    let agent: Agent | undefined = registry?.get(SessionId(entry.sessionId))
    if (agent === undefined) {
      const controller = await awaitController()
      if (controller === undefined) {
        ctx.logger.warn(
          'auto-continue: no sessionController to resume "%s" after restart',
          entry.sessionId,
        )
        return false
      }
      const result = await controller.agents.resolveAgent(SessionId(entry.sessionId))
      if ('error' in result) {
        ctx.logger.warn(
          'auto-continue: cannot reopen "%s" after restart (%o)',
          entry.sessionId,
          result.error,
        )
        return true
      }
      agent = result.agent
    }
    if (agent === undefined || lastTurnCompleted(agent)) {
      if (agent !== undefined)
        ctx.logger.info(
          'auto-continue: "%s" finished its turn before the restart — not resumed',
          entry.sessionId,
        )
      return true
    }
    agent.followup(resumeMessage)
    ctx.logger.info('auto-continue: resumed "%s" after restart', entry.sessionId)
    return true
  }

  const adoptAtBoot = async (): Promise<void> => {
    if (!config.resumeOnRestart || lifetime.signal.aborted) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      return
    }
    const record = isRecord(parsed) ? parsed : undefined
    const rawEntries = record?.entries
    const entries = Array.isArray(rawEntries) ? rawEntries.filter((entry) => isEntry(entry)) : []

    const now = Date.now()
    const fresh = entries.filter((entry) => now - entry.at < config.resumeMaxAgeMs)
    const stale = entries.length - fresh.length
    if (stale > 0)
      ctx.logger.info(
        'auto-continue: %d restart-resume entr%s past the max-age window — skipped',
        stale,
        stale === 1 ? 'y is' : 'ies are',
      )
    if (fresh.length === 0) return

    await new Promise((resolve) => {
      setTimeout(resolve, settleMs)
    })
    for (const entry of fresh) {
      if (lifetime.signal.aborted) return
      try {
        if (!(await resumeOne(entry))) return
      } catch (error) {
        ctx.logger.warn('auto-continue: restart-resume of "%s" failed: %o', entry.sessionId, error)
      }
      await new Promise((resolve) => {
        setTimeout(resolve, staggerMs)
      })
    }

    persist([])
  }

  void adoptAtBoot()

  ctx.effect(
    () => () => {
      lifetime.abort(new Error('auto-continue plugin disposed'))
    },
    'auto-continue: stop restart-resume',
  )
}
