/* Runtime smoke test for dsh-more-providers: catalog parsing, the three-way
 * protocol mapping, env key resolution, and registration on a stub llm
 * service. The adapter is the real PiAiAdapter, so listModels/resolveModel
 * exercise the same path the host uses. */
import {
  COMMAND_CODE_ROUTE,
  CommandCodeConfig,
  Config,
  createCommandCodeAdapter,
  inject,
  name,
  parseCatalog,
  registerCommandCode,
  resolveApiKey,
  toPiModels,
} from './lib/index.js'

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
const defaults = CommandCodeConfig({})
check('plugin name', name === 'dsh-more-providers')
check('injects llm', inject.includes('llm'))
check('config default apiKeyEnv', defaults.apiKeyEnv === 'CMD_API_KEY')
check('config default baseURL', defaults.baseURL === 'https://api.commandcode.ai/provider')
check('config default zdr off', defaults.zdr === false)
check('row config fills commandCode defaults', Config({}).commandCode.apiKeyEnv === 'CMD_API_KEY')
check('row config merges a partial section', Config({ commandCode: { zdr: true } }).commandCode.zdr === true && Config({ commandCode: { zdr: true } }).commandCode.timeoutMs === 10_000)

// ── catalog parsing ──────────────────────────────────────────────────────────
const items = [
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1_000_000, supported_endpoints: ['/messages'] },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', context_length: 1_050_000, supported_endpoints: ['/chat/completions', '/responses'] },
  { id: 'deepseek/deepseek-v4-pro', supported_endpoints: ['/chat/completions', '/responses'] },
  { id: 'no-route', supported_endpoints: ['/embeddings'] },
  { noId: true },
]
check('parse data envelope', parseCatalog({ data: items }).length === 4)
check('parse bare array', parseCatalog(items).length === 4)
check('drop entries without an id', parseCatalog({ data: [{ noId: true }] }).length === 0)
let threw = false
try {
  parseCatalog({})
} catch {
  threw = true
}
check('reject a body without data', threw)

// ── protocol mapping ─────────────────────────────────────────────────────────
const models = toPiModels(parseCatalog({ data: items }), { baseURL: 'https://api.commandcode.ai/provider', provider: COMMAND_CODE_ROUTE })
check('skip unsupported endpoints', models.length === 3)
const claude = models.find((model) => model.id === 'claude-sonnet-5')
const gpt = models.find((model) => model.id === 'gpt-6-astra')
const deepseek = models.find((model) => model.id === 'deepseek/deepseek-v4-pro')
check('claude uses anthropic-messages', claude?.api === 'anthropic-messages')
check('claude base URL is the API root', claude?.baseUrl === 'https://api.commandcode.ai/provider')
check('claude forces adaptive thinking', claude?.compat?.forceAdaptiveThinking === true)
check('claude declares vision', JSON.stringify(claude?.input) === '["text","image"]')
check('gpt uses openai-responses', gpt?.api === 'openai-responses')
check('gpt base URL is /v1', gpt?.baseUrl === 'https://api.commandcode.ai/provider/v1')
check('deepseek uses openai-completions', deepseek?.api === 'openai-completions')
check('completions disables developer role', deepseek?.compat?.supportsDeveloperRole === false)
check('completions uses max_tokens field', deepseek?.compat?.maxTokensField === 'max_tokens')
check('missing context falls back to 131072', deepseek?.contextWindow === 131_072)
check('missing maxTokens falls back to 32768', deepseek?.maxTokens === 32_768)
check('unknown families stay text-only', JSON.stringify(deepseek?.input) === '["text"]')

// ── env key resolution ──────────────────────────────────────────────────────
check('CMD_API_KEY wins', resolveApiKey({ apiKeyEnv: 'CMD_API_KEY' }, { CMD_API_KEY: 'a', COMMAND_CODE_API_KEY: 'b' }) === 'a')
check('COMMAND_CODE_API_KEY fallback', resolveApiKey({ apiKeyEnv: 'CMD_API_KEY' }, { COMMAND_CODE_API_KEY: 'b' }) === 'b')
check('missing key is undefined', resolveApiKey({ apiKeyEnv: 'CMD_API_KEY' }, {}) === undefined)
check('blank key is undefined', resolveApiKey({ apiKeyEnv: 'CMD_API_KEY' }, { CMD_API_KEY: '   ' }) === undefined)

// ── adapter: listModels + resolveModel through the real PiAiAdapter ─────────
const registration = createCommandCodeAdapter(parseCatalog({ data: items }), defaults, 'sk-smoke')
check('adapter reports the model count', registration?.modelCount === 3)
check('no usable models yields no adapter', createCommandCodeAdapter([], defaults, 'sk-smoke') === undefined)
const listed = await registration.adapter.listModels(COMMAND_CODE_ROUTE)
check('adapter lists three models', listed.length === 3)
const resolved = await registration.adapter.resolveModel(COMMAND_CODE_ROUTE, 'claude-sonnet-5')
check('adapter resolves context', resolved.context.contextWindow === 1_000_000)
check('adapter resolves reasoning efforts', resolved.reasoning.efforts.some((effort) => effort.id === 'high'))

// ── registration on a stub llm service ─────────────────────────────────────
function stubContext(registrations, logs = []) {
  return {
    logger: () => ({
      info: (...args) => logs.push(['info', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    }),
    llm: {
      registerAdapter: (routes, adapter) => {
        registrations.push({ routes, adapter })
      },
    },
  }
}

const registrations = []
const logs = []
const ctx = stubContext(registrations, logs)
let requestedURL
await registerCommandCode(ctx, defaults, {
  env: { CMD_API_KEY: 'sk-smoke' },
  fetchImpl: async (url) => {
    requestedURL = url
    return new Response(JSON.stringify({ data: items }), { status: 200, headers: { 'content-type': 'application/json' } })
  },
})
check('register uses the default catalog URL', requestedURL === 'https://api.commandcode.ai/provider/v1/models')
check('register calls registerAdapter once', registrations.length === 1)
check('register owns only command-code', JSON.stringify(registrations[0]?.routes) === '["command-code"]')

const dormant = []
await registerCommandCode(stubContext(dormant), defaults, {
  env: {},
  fetchImpl: async () => {
    throw new Error('must not fetch without a key')
  },
})
check('no key registers nothing', dormant.length === 0)

const unavailable = []
await registerCommandCode(stubContext(unavailable), defaults, {
  env: { CMD_API_KEY: 'sk-smoke', CMD_MODELS_URL: 'https://staging.example/models' },
  fetchImpl: async (url) => {
    check('CMD_MODELS_URL overrides', url === 'https://staging.example/models')
    return new Response('down', { status: 503 })
  },
})
check('catalog failure registers nothing', unavailable.length === 0)

const unroutable = []
await registerCommandCode(stubContext(unroutable), defaults, {
  env: { CMD_API_KEY: 'sk-smoke' },
  fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'embeddings-only', supported_endpoints: ['/embeddings'] }] }), { status: 200, headers: { 'content-type': 'application/json' } }),
})
check('catalog with no routable models registers nothing', unroutable.length === 0)

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('smoke OK')
