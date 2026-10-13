/**
 * Session-log usage audit: scan the local DSH session event logs and
 * aggregate per-request token usage into cache-hit statistics.
 *
 * The session event log (`$DSH_HOME/sessions/<cwd-dir>/<sessionId>/session.v*.jsonl.zstd`)
 * records one `assistant/message` event per completed model request, each
 * carrying the disjoint usage buckets already normalized by the adapter
 * (`inputTokens` excludes cached reads; `cacheReadTokens` is the cached
 * share). Summing them per provider/model and per session yields exactly
 * the numbers quota-drain and cache-affinity investigations need:
 *
 *   cache hit rate = cacheRead / (cacheRead + uncachedInput)
 *
 * Titles come from the session projection cache
 * (`$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json`),
 * read best-effort — a missing projection just leaves the row untitled.
 *
 * @module dsh-usage-audit/audit
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { decompress } from 'fzstd'

/** One per-request usage sample pulled off an `assistant/message` event. */
interface UsageSample {
  time: number
  provider: string
  model: string
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}

/** Aggregate for one provider/model route. */
export interface ModelAggregate {
  provider: string
  model: string
  requests: number
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  sessions: number
  first: number
  last: number
}

/** Aggregate for one session (may span several routes). */
export interface SessionAggregate {
  id: string
  title: string | undefined
  cwd: string | undefined
  first: number
  last: number
  requests: number
  uncachedInput: number
  cacheRead: number
  output: number
  /** Per-route breakdown as `provider/model ×N` strings, sorted by requests. */
  routes: string[]
}

export interface AuditReport {
  /** Window length in days, or `undefined` for the full history. */
  windowDays: number | undefined
  scannedSessionFiles: number
  sessionsWithUsage: number
  models: ModelAggregate[]
  sessions: SessionAggregate[]
}

export interface AuditOptions {
  /** Only count events at or after now - days*24h; undefined = all history. */
  days: number | undefined
  /** How many sessions to keep in the per-session table (sorted by uncached input). */
  sessionLimit: number
  now: number
}

/** A minimal `{ provider, model }` pair key. */
function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Read and zstd-decompress one session event log; returns '' when unreadable. */
async function readLogText(path: string): Promise<string> {
  try {
    const buffer = await readFile(path)
    return new TextDecoder().decode(decompress(new Uint8Array(buffer)))
  } catch {
    // Unreadable / partially written logs are skipped, not fatal.
    return ''
  }
}

/** Extract usage samples plus the session header's cwd from one log's text. */
function parseLog(text: string): { samples: UsageSample[]; cwd: string | undefined } {
  const samples: UsageSample[] = []
  let cwd: string | undefined
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event: {
      type?: string
      time?: number
      cwd?: string
      data?: {
        usage?: {
          inputTokens?: number
          cacheReadTokens?: number
          cacheWriteTokens?: number
          outputTokens?: number
          reasoningTokens?: number
        }
        message?: { source?: { provider?: string; model?: string } }
      }
    }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    if (event.type === 'session' && typeof event.cwd === 'string') {
      cwd = event.cwd
      continue
    }
    if (event.type !== 'assistant/message') continue
    const usage = event.data?.usage
    const source = event.data?.message?.source
    if (usage === undefined || source?.provider === undefined || source.model === undefined) continue
    if (typeof event.time !== 'number') continue
    samples.push({
      time: event.time,
      provider: source.provider,
      model: source.model,
      inputTokens: usage.inputTokens ?? 0,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
    })
  }
  return { samples, cwd }
}

/** Best-effort title lookup in the session projection cache. */
async function readTitle(projcacheDir: string, sessionId: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(projcacheDir, `${sessionId}.json`), 'utf8')
    const title = (JSON.parse(text) as { record?: { rows?: { title?: { val?: unknown } } } })
      ?.record?.rows?.title?.val
    return typeof title === 'string' && title.length > 0 ? title : undefined
  } catch {
    return undefined
  }
}

/** True when the directory entry may contain session logs (mirrors dsh naming). */
function isSessionDirName(name: string): boolean {
  return name.startsWith('--') && name.endsWith('--')
}

export async function collectAudit(
  sessionsRoot: string,
  projcacheDir: string,
  options: AuditOptions,
): Promise<AuditReport> {
  const windowStart = options.days === undefined ? 0 : options.now - options.days * 86_400_000
  const models = new Map<string, ModelAggregate>()
  const sessions = new Map<string, SessionAggregate>()
  const sessionModels = new Map<string, Map<string, number>>()
  let scannedSessionFiles = 0

  let workspaceDirs: string[] = []
  try {
    workspaceDirs = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isSessionDirName(entry.name))
      .map((entry) => entry.name)
  } catch {
    return {
      windowDays: options.days,
      scannedSessionFiles: 0,
      sessionsWithUsage: 0,
      models: [],
      sessions: [],
    }
  }

  for (const workspaceDir of workspaceDirs) {
    let sessionIds: string[] = []
    try {
      sessionIds = (await readdir(join(sessionsRoot, workspaceDir), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const sessionId of sessionIds) {
      const sessionDir = join(sessionsRoot, workspaceDir, sessionId)
      let files: string[] = []
      try {
        files = (await readdir(sessionDir)).filter((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name))
      } catch {
        continue
      }
      for (const file of files) {
        const path = join(sessionDir, file)
        // Cheap mtime prefilter: no event in a file can be newer than its mtime.
        try {
          if ((await stat(path)).mtimeMs < windowStart) continue
        } catch {
          continue
        }
        scannedSessionFiles++
        const { samples, cwd } = parseLog(await readLogText(path))
        for (const sample of samples) {
          if (sample.time < windowStart) continue
          const key = routeKey(sample.provider, sample.model)
          let model = models.get(key)
          if (model === undefined) {
            model = {
              provider: sample.provider,
              model: sample.model,
              requests: 0,
              uncachedInput: 0,
              cacheRead: 0,
              cacheWrite: 0,
              output: 0,
              reasoning: 0,
              sessions: 0,
              first: sample.time,
              last: sample.time,
            }
            models.set(key, model)
          }
          model.requests++
          model.uncachedInput += sample.inputTokens
          model.cacheRead += sample.cacheReadTokens
          model.cacheWrite += sample.cacheWriteTokens
          model.output += sample.outputTokens
          model.reasoning += sample.reasoningTokens
          model.first = Math.min(model.first, sample.time)
          model.last = Math.max(model.last, sample.time)

          let session = sessions.get(sessionId)
          if (session === undefined) {
            session = {
              id: sessionId,
              title: undefined,
              cwd,
              first: sample.time,
              last: sample.time,
              requests: 0,
              uncachedInput: 0,
              cacheRead: 0,
              output: 0,
              routes: [],
            }
            sessions.set(sessionId, session)
            sessionModels.set(sessionId, new Map())
          }
          session.requests++
          session.uncachedInput += sample.inputTokens
          session.cacheRead += sample.cacheReadTokens
          session.output += sample.outputTokens
          session.first = Math.min(session.first, sample.time)
          session.last = Math.max(session.last, sample.time)
          const perModel = sessionModels.get(sessionId)!
          perModel.set(key, (perModel.get(key) ?? 0) + 1)
        }
      }
    }
  }

  const sessionList = [...sessions.values()]
  for (const session of sessionList) {
    const perModel = sessionModels.get(session.id)
    session.routes = [...(perModel?.entries() ?? [])]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => (count === 1 ? key : `${key}×${count}`))
  }
  // Distinct-session count per route, derived after the scan.
  for (const perModel of sessionModels.values()) {
    for (const key of perModel.keys()) {
      const model = models.get(key)
      if (model !== undefined) model.sessions++
    }
  }
  // Titles resolved concurrently after the scan; failures keep `undefined`.
  await Promise.all(sessionList.map(async (session) => {
    session.title = await readTitle(projcacheDir, session.id)
  }))

  return {
    windowDays: options.days,
    scannedSessionFiles,
    sessionsWithUsage: sessionList.length,
    models: [...models.values()].sort((a, b) => b.uncachedInput - a.uncachedInput),
    sessions: sessionList
      .sort((a, b) => b.uncachedInput - a.uncachedInput)
      .slice(0, options.sessionLimit),
  }
}

/** Format a token count compactly (7,801,315 → 7.8M). */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function formatClock(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function hitRate(cacheRead: number, uncached: number): string {
  const total = cacheRead + uncached
  return total === 0 ? '—' : `${((cacheRead / total) * 100).toFixed(1)}%`
}

/** Render the report as the command's reply text. */
export function formatReport(report: AuditReport): string {
  const window = report.windowDays === undefined ? '全部历史' : `近 ${report.windowDays} 天`
  const lines: string[] = []
  lines.push(`usage-audit：扫描 ${report.scannedSessionFiles} 个会话日志（${window}），${report.sessionsWithUsage} 个会话有用量。`)
  lines.push('')

  if (report.models.length === 0) {
    lines.push('窗口内没有模型用量。')
    return lines.join('\n')
  }

  lines.push('**按 provider/model 汇总**（命中率 = cacheRead / (cacheRead + uncached输入)）')
  lines.push('')
  lines.push('| 路由 | 请求 | prompt总量 | 缓存命中 | 命中率 | 输出 | 会话数 |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const model of report.models) {
    const promptTotal = model.uncachedInput + model.cacheRead
    lines.push(
      `| ${routeKey(model.provider, model.model)} | ${model.requests} | ${formatTokens(promptTotal)} | ${formatTokens(model.cacheRead)} | ${hitRate(model.cacheRead, model.uncachedInput)} | ${formatTokens(model.output)} | ${model.sessions === 0 ? '—' : model.sessions} |`,
    )
  }
  lines.push('')

  lines.push(`**按会话**（uncached输入最多的前 ${report.sessions.length} 个）`)
  lines.push('')
  lines.push('| 会话 | 时间范围 | 路由 | 请求 | uncached | 命中率 |')
  lines.push('|---|---|---|---:|---:|---:|')
  for (const session of report.sessions) {
    const title = session.title === undefined ? session.id.slice(0, 12) : session.title.replace(/\|/g, '丨')
    lines.push(
      `| ${title} | ${formatClock(session.first)}→${formatClock(session.last)} | ${session.routes.slice(0, 2).join(' + ')}${session.routes.length > 2 ? ' +…' : ''} | ${session.requests} | ${formatTokens(session.uncachedInput)} | ${hitRate(session.cacheRead, session.uncachedInput)} |`,
    )
  }
  lines.push('')

  const worst = report.models[0]
  if (worst === undefined) return lines.join('\n')
  const worstPrompt = worst.uncachedInput + worst.cacheRead
  const at97 = Math.max(0, Math.round(worstPrompt * 0.03))
  lines.push(
    `输入量最大的路由 ${routeKey(worst.provider, worst.model)}：若命中率达 97%，其 uncached 输入约为 ${formatTokens(at97)}（现为 ${formatTokens(worst.uncachedInput)}）。`,
  )
  return lines.join('\n')
}
