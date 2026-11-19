import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { SessionControllerShim } from './shims.js'
import type { WaitSpool } from './spool.js'
import { cancellableSleep } from './recovery.js'
import { isRecord } from './guards.js'

export const RESTART_RESUME_MESSAGE =
  '[auto-continue] The harness restarted while this session was working and the running turn was interrupted. Continue from its recorded progress. Verify the outcome of any tool call marked unknown before repeating it.'

interface RunningEntry {
  sessionId: string
  at: number
  turn?: number
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
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    value.sessionId.length > 0 &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    (value.turn === undefined ||
      (typeof value.turn === 'number' && Number.isSafeInteger(value.turn)))
  )
}

function isDisposal(reason: TurnEndReason | null): boolean {
  return reason?.kind === 'aborted' && reason.reason.kind === 'disposed'
}

function canResume(agent: Agent, entry: RunningEntry): boolean {
  if (agent.status !== 'idle' || agent.session.header.origin === 'subagent') return false
  // oxlint-disable-next-line typescript/no-deprecated -- A25: the deprecated synchronous session-log readers have no sync replacement; the sanctioned ones are async and optional, so migrating changes exported contracts and control flow.
  const events = agent.session.ownEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'user/message' && event.data.source.kind === 'user') return false
    if (event?.type === 'turn/start') return false
    if (event?.type !== 'turn/end') continue
    const { reason, turn } = event.data
    return (
      (entry.turn === undefined || entry.turn === turn) &&
      (reason?.kind === 'interrupted' || isDisposal(reason))
    )
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
    spool?: WaitSpool
  } = {},
): void {
  if (!config.resumeOnRestart) return
  const path = options.mirrorPath ?? defaultMirrorPath()
  const lifetime = new AbortController()
  const { signal } = lifetime
  const running = new Map<string, RunningEntry>()

  const load = async (): Promise<RunningEntry[]> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      const stored = isRecord(parsed) ? parsed.entries : undefined
      const entries = Array.isArray(stored) ? stored.filter((entry) => isEntry(entry)) : []
      for (const entry of entries) running.set(entry.sessionId, entry)
      return [...running.values()]
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') {
        ctx.logger.warn('auto-continue: cannot read restart mirror: %o', error)
      }
      return []
    }
  }
  const loaded = load()
  let writes: Promise<void> = loaded.then(() => undefined)
  const update = (mutate: () => boolean): Promise<void> => {
    writes = writes
      .then(async () => {
        if (!mutate()) return undefined
        await mkdir(dirname(path), { recursive: true })
        const tmp = `${path}.tmp`
        await writeFile(tmp, `${JSON.stringify({ version: 1, entries: [...running.values()] })}\n`)
        return rename(tmp, path)
      })
      .catch((error: unknown) =>
        ctx.logger.warn('auto-continue: cannot write restart mirror: %o', error),
      )
    return writes
  }

  ctx.on('session/event', (session, event) => {
    if (signal.aborted || session.header.origin === 'subagent') return
    if (event.type === 'turn/start') {
      void update(() => {
        running.set(session.id, { sessionId: session.id, at: event.time, turn: event.data.turn })
        return true
      })
    } else if (event.type === 'turn/end' && !isDisposal(event.data.reason)) {
      void update(() => running.delete(session.id))
    }
  })

  const awaitController = async (): Promise<SessionControllerShim | undefined> => {
    const deadline = Date.now() + (options.controllerWaitMs ?? CONTROLLER_WAIT_MS)
    while (!signal.aborted) {
      const controller = ctx.get('sessionController')
      if (controller !== undefined || Date.now() >= deadline) return controller
      await cancellableSleep(options.controllerPollMs ?? CONTROLLER_POLL_MS, signal)
    }
    return undefined
  }

  const resumeOne = async (entry: RunningEntry): Promise<boolean> => {
    const id = SessionId(entry.sessionId)
    const archived = (): boolean =>
      ctx.get('workspaceRegistry')?.archivedSessionIds.includes(id) === true
    if (options.spool?.get(id) !== undefined || archived()) return true
    let agent = ctx.get('agents')?.get(id)
    if (agent === undefined) {
      const controller = await awaitController()
      if (signal.aborted) return false
      if (controller === undefined) {
        ctx.logger.warn('auto-continue: no sessionController to resume "%s" after restart', id)
        return false
      }
      const result = await controller.resolveAgent(id)
      if ('error' in result) {
        ctx.logger.warn('auto-continue: cannot reopen "%s" after restart (%o)', id, result.error)
        return result.error.code === 'session/not-found'
      }
      agent = result.agent
    }
    if (signal.aborted) return false
    if (running.get(id) !== entry || archived() || !canResume(agent, entry)) return true
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: RESTART_RESUME_MESSAGE }],
        source: { kind: 'user' },
      }),
    )
    ctx.logger.info('auto-continue: resumed "%s" after restart', id)
    return true
  }

  const adopt = async (): Promise<void> => {
    const entries = await loaded
    if (entries.length === 0) return
    await options.spool?.load()
    if (!(await cancellableSleep(options.settleMs ?? BOOT_SETTLE_MS, signal))) return
    for (const entry of entries) {
      if (signal.aborted) return
      if (running.get(entry.sessionId) !== entry) continue
      try {
        if (Date.now() - entry.at >= config.resumeMaxAgeMs || (await resumeOne(entry))) {
          await update(
            () => running.get(entry.sessionId) === entry && running.delete(entry.sessionId),
          )
        }
      } catch (error) {
        ctx.logger.warn('auto-continue: restart-resume of "%s" failed: %o', entry.sessionId, error)
      }
      await cancellableSleep(options.staggerMs ?? RESUME_STAGGER_MS, signal)
    }
  }

  const adoption = adopt()
  ctx.effect(
    () => async () => {
      lifetime.abort()
      await adoption
      await writes
    },
    'auto-continue: drain restart mirror',
  )
}
