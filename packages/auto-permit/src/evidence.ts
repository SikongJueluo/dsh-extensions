import { isAbsolute, sep } from 'node:path'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { isRecord } from './record.js'

export interface BashCall {
  command: string
  description?: string

  workdir?: string
  sandboxPermissions?: string
  justification?: string
}

export interface Evidence {
  call: BashCall | undefined

  workspace?: string

  effectiveCwd?: string

  resolvedWorkdir?: string

  prompts: readonly string[]

  approved: readonly string[]

  exactRepeat: boolean

  exactRepeatSources: readonly string[]
}

const MAX_PROMPTS = 16
const MAX_PROMPT_CHARS = 12000
const MAX_APPROVED = 8
const MAX_APPROVED_CHARS = 400

export const MAX_COMMAND_CHARS = 8000

export const MAX_PATH_CHARS = 4096

interface Folded {
  calls: Map<string, BashCall>
  asked: Map<string, { toolName: string; callId?: string }>
  decided: Map<string, string>
  prompts: string[]

  cwd?: string
}

function textOf(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type !== 'text' || typeof record.text !== 'string') continue
    parts.push(record.text)
  }
  return parts.join('\n')
}

function parseBashArguments(raw: unknown): BashCall | undefined {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!isRecord(parsed)) return undefined
  const args = parsed
  if (typeof args.command !== 'string') return undefined
  return {
    command: args.command,
    description: typeof args.description === 'string' ? args.description : undefined,
    workdir: typeof args.workdir === 'string' ? args.workdir : undefined,
    sandboxPermissions:
      typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : undefined,
    justification: typeof args.justification === 'string' ? args.justification : undefined,
  }
}

function sameBashCall(a: BashCall, b: BashCall): boolean {
  return (
    a.command === b.command &&
    (a.description ?? '') === (b.description ?? '') &&
    (a.workdir ?? '') === (b.workdir ?? '') &&
    (a.sandboxPermissions ?? '') === (b.sandboxPermissions ?? '') &&
    (a.justification ?? '') === (b.justification ?? '')
  )
}

function workspaceOf(session: Session): string | undefined {
  const header = (session as { header?: { cwd?: unknown } }).header
  const cwd = header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

function boundedPath(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  return value.length > MAX_PATH_CHARS ? undefined : value
}

function resolveWorkdir(workdir: string | undefined, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (workdir === undefined) return cwd
  if (workdir.length > MAX_PATH_CHARS) return undefined
  return isAbsolute(workdir) ? workdir : `${cwd}${sep}${workdir}`
}

function claimCall(
  calls: Map<string, BashCall>,
  tainted: Set<string>,
  id: string,
  bash: boolean,
  parsed: BashCall | undefined,
): void {
  if (!bash || parsed === undefined) {
    calls.delete(id)
    tainted.add(id)
    return
  }
  if (tainted.has(id)) return
  const existing = calls.get(id)
  if (existing === undefined) {
    calls.set(id, parsed)
    return
  }
  if (!sameBashCall(existing, parsed)) {
    calls.delete(id)
    tainted.add(id)
  }
}

function fold(events: readonly SessionEvent[]): Folded {
  const calls = new Map<string, BashCall>()
  const tainted = new Set<string>()
  const asked = new Map<string, { toolName: string; callId?: string }>()
  const decided = new Map<string, string>()
  const prompts: string[] = []
  let cwd: string | undefined
  for (const event of events) {
    const rawData: unknown = event.data
    const data = isRecord(rawData) ? rawData : undefined
    if (data === undefined) continue

    const type: string = event.type
    switch (type) {
      case 'tool/call': {
        if (typeof data.callId !== 'string' || typeof data.name !== 'string') break
        claimCall(
          calls,
          tainted,
          data.callId,
          data.name === 'bash',
          data.name === 'bash' ? parseBashArguments(data.arguments) : undefined,
        )
        break
      }
      case 'tool/ptc-dispatch-start': {
        if (typeof data.subCallId !== 'string' || typeof data.name !== 'string') break
        claimCall(
          calls,
          tainted,
          data.subCallId,
          data.name === 'bash',
          data.name === 'bash' ? parseBashArguments(data.arguments) : undefined,
        )
        break
      }
      case 'approval/asked': {
        if (typeof data.id !== 'string') break
        asked.set(data.id, {
          toolName: typeof data.toolName === 'string' ? data.toolName : '',
          callId: typeof data.callId === 'string' ? data.callId : undefined,
        })
        break
      }
      case 'approval/decided': {
        if (typeof data.id !== 'string' || typeof data.outcome !== 'string') break
        decided.set(data.id, data.outcome)
        break
      }
      case 'working-directory/change': {
        if (typeof data.cwd === 'string' && data.cwd !== '') cwd = data.cwd
        break
      }
      case 'user/message': {
        const message = data as { source?: { kind?: unknown }; content?: unknown }
        if (message.source?.kind !== 'user') break
        if (!Array.isArray(message.content)) break
        const text = textOf(message.content).trim()
        if (text !== '') prompts.push(text)
        break
      }
      default:
        break
    }
  }
  return { calls, asked, decided, prompts, ...(cwd === undefined ? {} : { cwd }) }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text
}

interface TaskSection {
  start: number

  text: string
}

function findTaskSection(text: string): TaskSection | undefined {
  const pattern = /^(#{1,3})[ \t]+(?:Task|任务)\b.*$/gimu
  let match: RegExpExecArray | null = null
  let last: RegExpExecArray | null = null
  while ((match = pattern.exec(text)) !== null) last = match
  if (last === null) return undefined
  const level = (last[1] ?? '#').length
  const bodyStart = last.index + last[0].length
  const nextHeading = new RegExp(`\\n#{1,${level}}[ \\t]+`, 'gu')
  nextHeading.lastIndex = bodyStart
  const next = nextHeading.exec(text)
  const end = next === null ? text.length : next.index + 1
  return { start: last.index, text: text.slice(last.index, end) }
}

const marker = (count: number): string => `\n…[${Math.max(0, count)} characters omitted]…\n`

export function foldPrompt(text: string, budget: number): string {
  if (text.length <= budget) return text
  if (budget < 200) return text.slice(0, Math.max(0, budget))
  const reserve = 160
  const tasks = budget >= 800 ? findTaskSection(text) : undefined
  const baseHead = Math.floor((budget - reserve) * 0.55)
  if (tasks !== undefined) {
    const inTail = tasks.start >= text.length - Math.floor(budget * 0.4)
    const inHead = tasks.start < baseHead
    if (!inTail && !inHead) {
      const taskText = tasks.text.slice(0, Math.min(tasks.text.length, Math.floor(budget * 0.4)))
      const rest = Math.max(200, budget - reserve - taskText.length - 24)
      const headBudget = Math.floor(rest * 0.5)
      const tailBudget = rest - headBudget
      const head = text.slice(0, headBudget)
      const tail = text.slice(text.length - tailBudget)
      const omitted = text.length - head.length - tail.length - taskText.length
      return `${head}${marker(omitted)}## Task (extracted)\n${taskText}${
        tailBudget > 0 ? `\n…[end of prompt]…\n${tail}` : ''
      }`
    }
  }
  const headBudget = baseHead
  const tailBudget = budget - reserve - headBudget
  const head = text.slice(0, headBudget)
  const tail = text.slice(text.length - tailBudget)
  return `${head}${marker(text.length - head.length - tail.length)}${tail}`
}

export function collectEvidence(session: Session, callId: string, effectiveCwd?: string): Evidence {
  // oxlint-disable-next-line typescript/no-deprecated -- A25: the only synchronous full-log read; the sanctioned `sessionQuery.readSession` is async and an optional service, so switching would change this exported function's synchronous contract and drop hosts that do not mount it.
  const { calls, asked, decided, prompts, cwd } = fold(session.snapshotEvents())

  const approved: string[] = []
  for (const [id, ask] of asked) {
    if (ask.toolName !== 'bash' || ask.callId === undefined) continue
    if (decided.get(id) !== 'allowed-once') continue
    const call = calls.get(ask.callId)
    if (call === undefined) continue
    approved.push(call.command)
  }

  const pending = calls.get(callId)
  const repeatSources: string[] = []
  if (pending !== undefined) {
    const mode = pending.sandboxPermissions ?? ''
    for (const [id, ask] of asked) {
      if (ask.toolName !== 'bash' || ask.callId === undefined) continue
      if (callId === ask.callId) continue
      if (decided.get(id) !== 'allowed-once') continue
      const prior = calls.get(ask.callId)
      if (prior === undefined) continue
      if (prior.command === pending.command && (prior.sandboxPermissions ?? '') === mode) {
        repeatSources.push(ask.callId)
      }
    }
  }

  const call = pending

  const workspace = boundedPath(workspaceOf(session))

  const currentCwd =
    effectiveCwd !== undefined
      ? boundedPath(effectiveCwd)
      : cwd !== undefined
        ? boundedPath(cwd)
        : workspace

  const promptWindow: string[] = []
  let budget = MAX_PROMPT_CHARS
  for (let i = prompts.length - 1; i >= 0 && promptWindow.length < MAX_PROMPTS; i -= 1) {
    const text = prompts[i]
    if (text === undefined) break
    if (text.length > budget) {
      promptWindow.unshift(foldPrompt(text, budget))
      break
    }
    budget -= text.length
    promptWindow.unshift(text)
  }

  return {
    call:
      call === undefined
        ? undefined
        : {
            ...call,
            ...(call.workdir === undefined ? {} : { workdir: clip(call.workdir, MAX_PATH_CHARS) }),
          },
    workspace,
    effectiveCwd: currentCwd,
    resolvedWorkdir: resolveWorkdir(call?.workdir, currentCwd),
    prompts: promptWindow,
    approved: approved.slice(-MAX_APPROVED).map((command) => clip(command, MAX_APPROVED_CHARS)),
    exactRepeat: repeatSources.length > 0,
    exactRepeatSources: repeatSources,
  }
}
