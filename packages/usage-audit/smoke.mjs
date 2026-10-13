/**
 * Smoke checks for dsh-usage-audit (and the oauth-providers cache-affinity
 * wire shape it exists to measure). Run from the package dir: `node smoke.mjs`.
 *
 * 1. collectAudit + formatReport against the real $DSH_HOME session logs
 *    (skipped when the sessions root does not exist).
 * 2. serializeRequest stamps `prompt_cache_key` from the session id when
 *    affinity is on, omits it when off, and clamps >64-char ids.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join as joinPath } from 'node:path'
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

// --- 1. Real-data audit -------------------------------------------------
const home = process.env.DSH_HOME ?? joinPath(homedir(), '.dsh')
const sessionsRoot = joinPath(home, 'sessions')
if (existsSync(sessionsRoot)) {
  const started = Date.now()
  const report = await collectAudit(sessionsRoot, joinPath(home, 'storages', 'session_projcache', 'sessions'), {
    days: 2,
    sessionLimit: 5,
    now: Date.now(),
  })
  const elapsed = Date.now() - started
  console.log(`scanned ${report.scannedSessionFiles} logs in ${elapsed}ms; ${report.sessionsWithUsage} sessions with usage`)
  check('scan found some usage in the last 2 days', report.models.length > 0)
  const text = formatReport(report)
  check('report renders with both tables', text.includes('按 provider/model 汇总') && text.includes('按会话'))
  console.log('\n--- formatReport(days=2) ---\n')
  console.log(text)
  console.log('\n--- end ---\n')
} else {
  console.log(`skip - no sessions root at ${sessionsRoot}`)
}

// --- 2. serializeRequest cache affinity ---------------------------------
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
