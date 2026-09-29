/* Runtime smoke test for dsh-plan-usage: quota parser against live-response
 * test vectors (captured by OpenTokenUsage / opencodex, both MIT), monitor
 * resolution and dedupe, service registration on a real Cordis context, and
 * the apply wiring with a stub context. */
import { Context } from '@deepseek-ai/cordis'
import { name, inject, Config, apply, PlanUsageService } from './lib/index.js'
import { parseQuotaBody, resolveMonitor, monitoredProviders, QuotaMonitor } from './lib/index.js'

let failures = 0
function check(label, condition) {
  if (condition) {
    console.log('ok -', label)
  } else {
    failures += 1
    console.error('FAIL -', label)
  }
}

// ── defaults ─────────────────────────────────────────────────────────────────
const config = Config({})
console.log('plugin:', name, '| inject:', inject)
check('quotaCacheMs default 60s', config.quotaCacheMs === 60_000)
check('providers default empty', Object.keys(config.providers).length === 0)

// ── monitor resolution ───────────────────────────────────────────────────────
check('zai-coding-cn builtin monitor', resolveMonitor('zai-coding-cn')?.monitorBaseUrl === 'https://open.bigmodel.cn')
check('zai builtin monitor', resolveMonitor('zai')?.monitorBaseUrl === 'https://api.z.ai')
check('unknown provider has no monitor', resolveMonitor('unknown') === undefined)
check(
  'user override wins',
  resolveMonitor('zai-coding-cn', { 'zai-coding-cn': { monitorBaseUrl: 'https://proxy.example' } })?.monitorBaseUrl === 'https://proxy.example',
)
check(
  'user addition without baseUrl has no monitor',
  resolveMonitor('custom', { custom: { apiKeyEnv: 'K' } }) === undefined,
)
check(
  'user addition with baseUrl works',
  resolveMonitor('custom', { custom: { monitorBaseUrl: 'https://m.example', apiKeyEnv: 'K' } })?.apiKeyEnv[0] === 'K',
)
check('monitoredProviders merges builtins and config', monitoredProviders({ extra: { monitorBaseUrl: 'https://x' } }).includes('extra'))

// ── quota body parsing (live-response vectors) ──────────────────────────────
const v2Limits = parseQuotaBody({
  success: true,
  data: {
    limits: [
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 0, remaining: 4000, percentage: 0, nextResetTime: 1788073095998, usageDetails: [] },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 100, nextResetTime: 1787056863927 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 20, nextResetTime: 1787641095989 },
    ],
    level: 'max',
  },
})
check('v2 limits: 5h 100%', v2Limits?.fiveHour?.percent === 100)
check('v2 limits: 5h resetAt', v2Limits?.fiveHour?.resetAt === 1787056863927)
check('v2 limits: weekly 20%', v2Limits?.weekly?.percent === 20)
check('v2 limits: monthly MCP present', v2Limits?.monthlyMcp?.percent === 0)
check('v2 limits: level', v2Limits?.level === 'max')

const creditLimits = parseQuotaBody({
  success: true,
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 20, currentValue: 200, usage: 1000, nextResetTime: 1789000000000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, currentValue: 156, usage: 300, nextResetTime: 1789600000000 },
    ],
    level: 'pro',
  },
})
check('CREDIT_LIMIT alias parsed as 5h', creditLimits?.fiveHour?.percent === 20)
check('weekly percentage derived from used/total', creditLimits?.weekly?.percent === 52)
check('no TIME_LIMIT row means no monthly window', creditLimits?.monthlyMcp === undefined)

const mismatchedUnits = parseQuotaBody({
  success: true,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, number: 2, percentage: 40, nextResetTime: 1789000000000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 2, percentage: 52, nextResetTime: 1789600000000 },
      { type: 'TIME_LIMIT', percentage: 12.3, nextResetTime: 1789000000000 },
    ],
  },
})
check('window lengths must match 5h/weekly', mismatchedUnits?.fiveHour === undefined && mismatchedUnits?.weekly === undefined)

const emptyLimitsWithLegacy = parseQuotaBody({ success: true, data: { limits: [], fiveHourPercent: 40.5, weeklyPercent: 52 } })
check('present-but-empty limits array does not fall back', emptyLimitsWithLegacy === null)

const legacy = parseQuotaBody({ success: true, data: { fiveHourPercent: 40.5, weeklyPercent: 52, monthlyMCPUsage: 12.3 } })
check('legacy flat fields parsed', legacy?.source === 'legacy' && legacy?.fiveHour?.percent === 40.5 && legacy?.monthlyMcp?.percent === 12.3)

const unsuccessful = parseQuotaBody({ success: false, data: { limits: [] } })
check('success:false payload rejected', unsuccessful === null)

// ── QuotaMonitor with a stub fetch ───────────────────────────────────────────
let fetchCalls = 0
const stubFetch = async (url, init) => {
  fetchCalls += 1
  if (!String(url).includes('/api/monitor/usage/quota/limit')) {
    return new Response('{}', { status: 404 })
  }
  if (init?.headers?.authorization !== 'Bearer k-1') {
    return new Response('{}', { status: 401 })
  }
  return new Response(JSON.stringify({
    success: true,
    data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 7, nextResetTime: 1790003600000 }] },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
process.env.SMOKE_QUOTA_KEY = 'k-1'
const mon = new QuotaMonitor({ fetchImpl: stubFetch, logger: { warn() {} } })
const cfg = { monitorBaseUrl: 'https://open.bigmodel.cn', apiKeyEnv: ['SMOKE_QUOTA_KEY'] }
const s1 = await mon.get('zai-coding-cn', cfg, { force: true })
check('monitor fetch parses', s1?.fiveHour?.percent === 7)
const s2 = await mon.get('zai-coding-cn', cfg)
check('monitor caches within TTL', s2?.fiveHour?.percent === 7 && fetchCalls === 1)
const alias = await mon.get('glm', cfg)
check('providers sharing a monitor share the upstream call', alias?.provider === 'glm' && alias?.fiveHour?.percent === 7 && fetchCalls === 1)
const noKey = new QuotaMonitor({ fetchImpl: stubFetch, logger: { warn() {} } })
const s4 = await noKey.get('zai-coding-cn', { monitorBaseUrl: 'https://open.bigmodel.cn', apiKeyEnv: ['DEFINITELY_UNSET_VAR'] }, {})
check('missing key resolves undefined without throwing', s4 === undefined)

// ── apply + service registration on a real Cordis context ───────────────────
const root = new Context()
apply(root, config)
const service = root.get('planUsage')
check('apply registers the planUsage service', service instanceof PlanUsageService)
check('service lists built-in providers', service?.providers().includes('zai-coding-cn'))
check('unmonitored provider resolves undefined', (await service?.get('unknown-provider')) === undefined)
check('monitored() reflects key resolution', service?.monitored('zai-coding-cn') === (process.env.ZAI_CODING_CN_API_KEY !== undefined || process.env.GLM_API_KEY !== undefined))

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('smoke OK')
