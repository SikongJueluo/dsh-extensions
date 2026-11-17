import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { collectAudit, formatReport } from './lib/index.js'
import { serializeRequest, clampSessionAffinityKey } from '../oauth-providers/lib/index.js'

let failures = 0
function check(name, condition) {
  if (condition) {
    console.log(`ok - ${name}`)
  } else {
    failures++
    console.error(`FAIL - ${name}`)
  }
}

const now = Date.now()
const fixtureRoot = await mkdtemp(joinPath(tmpdir(), 'context-audit-smoke-'))
const sessionsRoot = joinPath(fixtureRoot, 'sessions')
const projcacheDir = joinPath(fixtureRoot, 'storages', 'session_projcache', 'sessions')
const fixtureSessionId = 'session-fixture-1'
const fixtureSessionDir = joinPath(sessionsRoot, '--fake-workspace--', fixtureSessionId)
await mkdir(fixtureSessionDir, { recursive: true })
await mkdir(projcacheDir, { recursive: true })

const fixtureEvents = [
  { type: 'session', time: now - 60_000, cwd: '/fake/workspace' },
  {
    type: 'assistant/message',
    time: now - 50_000,
    data: {
      usage: {
        inputTokens: 1_000,
        cacheReadTokens: 400,
        cacheWriteTokens: 10,
        outputTokens: 200,
        reasoningTokens: 50,
      },
      message: { source: { provider: 'fixture-provider', model: 'fixture-model' } },
    },
  },
  {
    type: 'assistant/message',
    time: now - 40_000,
    data: {
      usage: { inputTokens: 500, cacheReadTokens: 100, outputTokens: 80 },
      message: { source: { provider: 'fixture-provider', model: 'fixture-model' } },
    },
  },
  { type: 'tool/call', time: now - 30_000, data: { name: 'read', callId: 'call-read' } },
  { type: 'tool/result', time: now - 29_900, data: { message: { toolCallId: 'call-read' } } },
  { type: 'tool/call', time: now - 20_000, data: { name: 'bash', callId: 'call-bash' } },
  {
    type: 'tool/result',
    time: now - 19_000,
    data: { message: { toolCallId: 'call-bash', isError: true }, error: { code: 'E_BASH' } },
  },
  { type: 'tool/call', time: now - 10_000, data: { name: 'grep', callId: 'call-grep' } },
]
const fixtureLog = `${fixtureEvents.map((event) => JSON.stringify(event)).join('\n')}\n`
await writeFile(
  joinPath(fixtureSessionDir, 'session.v1.jsonl.zstd'),
  zstdCompressSync(Buffer.from(fixtureLog)),
)
await writeFile(
  joinPath(projcacheDir, `${fixtureSessionId}.json`),
  JSON.stringify({ record: { rows: { title: { val: 'Fixture session' } } } }),
)

const report = await collectAudit(sessionsRoot, projcacheDir, { days: 2, sessionLimit: 5, now })
await rm(fixtureRoot, { recursive: true, force: true })

check('scanned exactly one fixture log', report.scannedSessionFiles === 1)
const fixtureModel = report.models[0]
check(
  'usage aggregates by provider/model',
  report.models.length === 1 &&
    fixtureModel.provider === 'fixture-provider' &&
    fixtureModel.model === 'fixture-model' &&
    fixtureModel.requests === 2,
)
check(
  'token fields stay separate',
  fixtureModel.uncachedInput === 1_500 &&
    fixtureModel.cacheRead === 500 &&
    fixtureModel.cacheWrite === 10 &&
    fixtureModel.output === 280,
)
check(
  'one session spans one route',
  report.sessions.length === 1 &&
    report.sessions[0].routes.join(',') === 'fixture-provider/fixture-model×2',
)
check(
  'session title comes from the projection cache',
  report.sessions[0].title === 'Fixture session',
)
check('session cwd comes from the header event', report.sessions[0].cwd === '/fake/workspace')

const read = report.tools.find((tool) => tool.name === 'read')
const bash = report.tools.find((tool) => tool.name === 'bash')
const grep = report.tools.find((tool) => tool.name === 'grep')
check(
  'completed call is counted',
  read !== undefined && read.calls === 1 && read.completed === 1 && read.errors === 0,
)
check(
  'error result is counted with its code',
  bash !== undefined &&
    bash.errors === 1 &&
    bash.completed === 1 &&
    bash.errorCodes[0][0] === 'E_BASH',
)
check(
  'call without a result is unfinished',
  grep !== undefined && grep.unfinished === 1 && grep.completed === 0,
)
check(
  'tool totals are internally consistent',
  report.tools.every(
    (tool) => tool.completed + tool.unfinished === tool.calls && tool.errors <= tool.completed,
  ),
)
const text = formatReport(report)
check(
  'report renders with all three tables',
  text.includes('按 provider/model 汇总') && text.includes('按工具汇总') && text.includes('按会话'),
)

if (process.argv.includes('--real')) {
  const home = process.env.DSH_HOME ?? joinPath(homedir(), '.dsh')
  const realRoot = joinPath(home, 'sessions')
  if (!existsSync(realRoot)) {
    console.log(`skip - no sessions root at ${realRoot}`)
  } else {
    const started = Date.now()
    const real = await collectAudit(
      realRoot,
      joinPath(home, 'storages', 'session_projcache', 'sessions'),
      {
        days: 2,
        sessionLimit: 5,
        now: Date.now(),
      },
    )
    console.log(
      `real logs: scanned ${real.scannedSessionFiles} files in ${Date.now() - started}ms; ${real.sessionsWithUsage} sessions with usage`,
    )
    console.log(`real logs: ${real.models.length} routes, ${real.tools.length} tools`)
  }
}

const sessionId = 'session-21537589-5751-4490-af91-ef25bced6b1f'
const base = { provider: 'chatgpt', model: 'gpt-6.1-sol', messages: [] }
const withId = serializeRequest({ ...base, sessionId }, undefined, { promptCacheKey: true })
check('prompt_cache_key stamped from session id', withId.prompt_cache_key === sessionId)
const off = serializeRequest({ ...base, sessionId }, undefined, { promptCacheKey: false })
check('prompt_cache_key omitted when affinity off', off.prompt_cache_key === undefined)
const defaulted = serializeRequest({ ...base, sessionId })
check('affinity defaults to on (no affinity object)', defaulted.prompt_cache_key === sessionId)
check('clamp keeps ≤64 code points', clampSessionAffinityKey('x'.repeat(100)).length === 64)
check('clamp is a no-op for session ids', clampSessionAffinityKey(sessionId) === sessionId)

process.exit(failures === 0 ? 0 : 1)
