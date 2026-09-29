/* Runtime smoke test for dsh-plan-usage: parser vectors for all three
 * sources (captured live payloads from OpenTokenUsage / opencodex / headroom
 * / ai-usagebar, all MIT), the GLM monitor dedupe, service registration on a
 * real Cordis context, and live-route filtering via a stub llm service. */
import { Context, Service } from '@deepseek-ai/cordis'
import { name, inject, Config, apply, PlanUsageService } from './lib/index.js'
import { parseQuotaBody, resolveMonitor, monitoredProviders, QuotaMonitor } from './lib/index.js'
import { parseCodexUsage, OpenAiUsageSource } from './lib/index.js'
import { parseMiniMaxRemains, consumedFromRemaining, MiniMaxSource } from './lib/index.js'

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

// ── GLM monitor resolution ───────────────────────────────────────────────────
check('zai-coding-cn builtin monitor', resolveMonitor('zai-coding-cn')?.monitorBaseUrl === 'https://open.bigmodel.cn')
check('zai builtin monitor', resolveMonitor('zai')?.monitorBaseUrl === 'https://api.z.ai')
check('unknown provider has no monitor', resolveMonitor('unknown') === undefined)
check(
  'user override wins',
  resolveMonitor('zai-coding-cn', { 'zai-coding-cn': { monitorBaseUrl: 'https://proxy.example' } })?.monitorBaseUrl === 'https://proxy.example',
)
check('monitoredProviders merges builtins and config', monitoredProviders({ extra: { monitorBaseUrl: 'https://x' } }).includes('extra'))

// ── GLM payload parsing (live-response vectors) ──────────────────────────────
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
check('glm v2: 5h 100% + reset + windowMinutes', v2Limits?.fiveHour?.percent === 100 && v2Limits?.fiveHour?.resetAt === 1787056863927 && v2Limits?.fiveHour?.windowMinutes === 300)
check('glm v2: weekly 20%', v2Limits?.weekly?.percent === 20)
check('glm v2: monthly MCP present', v2Limits?.monthlyMcp?.percent === 0)
check('glm v2: level', v2Limits?.level === 'max')

const creditLimits = parseQuotaBody({
  success: true,
  data: {
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, percentage: 20, currentValue: 200, usage: 1000, nextResetTime: 1789000000000 },
      { type: 'TOKENS_LIMIT', unit: 6, number: 1, currentValue: 156, usage: 300, nextResetTime: 1789600000000 },
    ],
  },
})
check('glm CREDIT_LIMIT alias parsed as 5h', creditLimits?.fiveHour?.percent === 20)
check('glm weekly percentage derived from used/total', creditLimits?.weekly?.percent === 52)
check('glm empty limits array does not fall back', parseQuotaBody({ success: true, data: { limits: [], fiveHourPercent: 40 } }) === null)
check('glm legacy flat fields parsed', parseQuotaBody({ success: true, data: { fiveHourPercent: 40.5, weeklyPercent: 52 } })?.source === 'glm:legacy')
check('glm success:false rejected', parseQuotaBody({ success: false, data: { limits: [] } }) === null)

// ── OpenAI Codex usage parsing (headroom's live capture) ─────────────────────
const codexBody = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 42.5, limit_window_seconds: 18000, reset_at: 1787056863 },
    secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1787641095 },
  },
  credits: { has_credits: false, unlimited: false, balance: '$0.00' },
  rate_limit_reached_type: null,
  promo: null,
}
const codex = parseCodexUsage(codexBody)
check('codex: primary window mapped to fiveHour', codex?.fiveHour?.percent === 42.5)
check('codex: reset_at seconds converted to ms', codex?.fiveHour?.resetAt === 1787056863000)
check('codex: window minutes derived', codex?.fiveHour?.windowMinutes === 300)
check('codex: secondary window mapped to weekly', codex?.weekly?.percent === 10 && codex?.weekly?.resetAt === 1787641095000 && codex?.weekly?.windowMinutes === 10080)
check('codex: plan_type as level', codex?.level === 'plus')

const codexNoSecondary = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 5, reset_at: 1787056863 } } })
check('codex: missing secondary tolerated', codexNoSecondary?.fiveHour?.percent === 5 && codexNoSecondary?.weekly === undefined)
check('codex: no rate_limit rejected', parseCodexUsage({ plan_type: 'plus' }) === undefined)

// OpenAI source: token missing → undefined; token present → fetched snapshot.
const openaiFetches = []
const openai = new OpenAiUsageSource({
  getToken: async () => undefined,
  fetchImpl: async (url, init) => {
    openaiFetches.push({ url, auth: init?.headers?.authorization, account: init?.headers?.['chatgpt-account-id'] })
    return new Response(JSON.stringify(codexBody), { status: 200, headers: { 'content-type': 'application/json' } })
  },
  logger: { warn() {} },
})
check('openai: missing token resolves undefined without fetching', (await openai.get('chatgpt')) === undefined && openaiFetches.length === 0)
const signedIn = new OpenAiUsageSource({
  getToken: async () => ({ access: 'tok-1', accountId: 'acc-9' }),
  fetchImpl: openai.fetchImpl,
  logger: { warn() {} },
})
const codexSnapshot = await signedIn.get('chatgpt')
check('openai: authenticated fetch parses', codexSnapshot?.provider === 'chatgpt' && codexSnapshot?.fiveHour?.percent === 42.5 && codexSnapshot?.source === 'openai:usage')
check('openai: codex headers sent', openaiFetches[0]?.auth === 'Bearer tok-1' && openaiFetches[0]?.account === 'acc-9' && String(openaiFetches[0]?.url).endsWith('/backend-api/wham/usage'))

// ── MiniMax token_plan parsing (ai-usagebar's live capture) ──────────────────
const minimaxLive = {
  model_remains: [
    {
      start_time: 1785164400000, end_time: 1785182400000,
      model_name: 'general',
      weekly_start_time: 1785110400000, weekly_end_time: 1785715200000,
      current_interval_remaining_percent: 99,
      current_weekly_remaining_percent: 99,
    },
    {
      start_time: 1785110400000, end_time: 1785196800000,
      model_name: 'video',
      weekly_start_time: 1785110400000, weekly_end_time: 1785715200000,
      current_interval_remaining_percent: 100,
      current_weekly_remaining_percent: 100,
    },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
}
const minimax = parseMiniMaxRemains(minimaxLive)
check('minimax: remaining inverted to consumed', minimax.fiveHour?.percent === 1 && minimax.weekly?.percent === 1)
check('minimax: interval reset from end_time ms', minimax.fiveHour?.resetAt === 1785182400000)
check('minimax: interval window derived per bucket (5h)', minimax.fiveHour?.windowMinutes === 300)
check('minimax: weekly window 7d', minimax.weekly?.windowMinutes === 10080)
check('minimax: consumed clamps out-of-range', consumedFromRemaining(150) === 0 && consumedFromRemaining(-5) === 100)
check('minimax: in-band auth failure rejected', 'error' in parseMiniMaxRemains({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } }))
check('minimax: video-only bucket is an error', 'error' in parseMiniMaxRemains({ model_remains: [{ model_name: 'video', start_time: 1, end_time: 2, current_interval_remaining_percent: 100, weekly_start_time: 1, weekly_end_time: 2, current_weekly_remaining_percent: 100 }], base_resp: { status_code: 0 } }))
check('minimax: degenerate bounds drop reset but keep percent', (() => {
  const parsed = parseMiniMaxRemains({ model_remains: [{ model_name: 'general', start_time: 0, end_time: 0, current_interval_remaining_percent: 40, weekly_start_time: 0, weekly_end_time: 0, current_weekly_remaining_percent: 55 }], base_resp: { status_code: 0 } })
  return !('error' in parsed) && parsed.fiveHour?.percent === 60 && parsed.fiveHour?.resetAt === undefined && parsed.weekly?.percent === 45
})())

const minimaxCalls = []
const minimaxEnv = { MINIMAX_API_KEY: 'mm-key' }
const minimaxSource = new MiniMaxSource({
  env: minimaxEnv,
  fetchImpl: async (url, init) => {
    minimaxCalls.push({ url, auth: init?.headers?.authorization })
    return new Response(JSON.stringify(minimaxLive), { status: 200, headers: { 'content-type': 'application/json' } })
  },
  logger: { warn() {} },
})
check('minimax: unkeyed route not ready', minimaxSource.ready('minimax-cn') === false && minimaxSource.ready('minimax') === true)
const minimaxSnapshot = await minimaxSource.get('minimax')
check('minimax: keyed route fetches global host', minimaxSnapshot?.provider === 'minimax' && minimaxCalls[0]?.auth === 'Bearer mm-key' && String(minimaxCalls[0]?.url).startsWith('https://api.minimax.io/'))
check('minimax: unkeyed route resolves undefined', (await minimaxSource.get('minimax-cn')) === undefined && minimaxCalls.length === 1)

// Region fallback: a CN key behind the global route flips hosts and remembers.
const regionCalls = []
const regionSource = new MiniMaxSource({
  env: { MINIMAX_API_KEY: 'cn-key' },
  fetchImpl: async (url, init) => {
    regionCalls.push(String(url))
    if (url.startsWith('https://api.minimax.io/')) {
      return new Response(JSON.stringify({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify(minimaxLive), { status: 200, headers: { 'content-type': 'application/json' } })
  },
  logger: { warn() {} },
})
const flipped = await regionSource.get('minimax')
check('minimax: wrong-region key flips to the other host', flipped?.fiveHour?.percent === 1 && regionCalls.length === 2 && regionCalls[0].includes('minimax.io') && regionCalls[1].includes('minimaxi.com'))
const flippedAgain = await regionSource.get('minimax')
check('minimax: region choice is remembered', flippedAgain !== undefined && regionCalls.length === 3 && regionCalls[2].includes('minimaxi.com'))

// ── GLM QuotaMonitor with a stub fetch (shared-monitor dedupe) ───────────────
let fetchCalls = 0
const stubFetch = async (url, init) => {
  fetchCalls += 1
  if (!String(url).includes('/api/monitor/usage/quota/limit')) return new Response('{}', { status: 404 })
  if (init?.headers?.authorization !== 'Bearer k-1') return new Response('{}', { status: 401 })
  return new Response(JSON.stringify({
    success: true,
    data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 7, nextResetTime: 1790003600000 }] },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
process.env.SMOKE_QUOTA_KEY = 'k-1'
const mon = new QuotaMonitor({ fetchImpl: stubFetch, logger: { warn() {} } })
const cfg = { monitorBaseUrl: 'https://open.bigmodel.cn', apiKeyEnv: ['SMOKE_QUOTA_KEY'] }
const s1 = await mon.get('zai-coding-cn', cfg, { force: true })
check('glm monitor fetch parses', s1?.fiveHour?.percent === 7)
await mon.get('zai-coding-cn', cfg)
check('glm monitor caches within TTL', fetchCalls === 1)
const alias = await mon.get('glm', cfg)
check('glm providers sharing a monitor share the upstream call', alias?.provider === 'glm' && fetchCalls === 1)

// ── service on a real Cordis context: registration + live-route filter ──────
const root = new Context()
apply(root, config)
const service = root.get('planUsage')
check('apply registers the planUsage service', service instanceof PlanUsageService)

// Without an llm service every known source route is listed.
const unfiltered = service.providers()
check('no llm service → all source routes listed', unfiltered.includes('zai-coding-cn') && unfiltered.includes('chatgpt') && unfiltered.includes('minimax-cn'))

// A stub llm service narrows the list to routes actually registered.
class StubLlm extends Service {
  constructor(ctx) { super(ctx, 'llm') }
  listProviders() { return [{ id: 'zai-coding-cn', name: 'Z.AI Coding CN' }, { id: 'chatgpt', name: 'ChatGPT' }] }
}
const stubLlm = new StubLlm(root)
root.emit('llm/adapters-updated')
const filtered = service.providers()
check('live registry collapses the GLM alias family', JSON.stringify(filtered) === JSON.stringify(['chatgpt', 'zai-coding-cn']))
check('unmonitored provider resolves undefined', (await service.get('unknown-provider')) === undefined)
check('monitored() reflects key resolution', service.monitored('zai-coding-cn') === (process.env.ZAI_CODING_CN_API_KEY !== undefined || process.env.GLM_API_KEY !== undefined))
void stubLlm

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('smoke OK')
