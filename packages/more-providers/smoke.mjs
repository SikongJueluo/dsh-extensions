/* Runtime smoke test for dsh-more-providers: YAML validation/inheritance, key
 * sources, builtin + custom provider construction, the providerKeys service,
 * Command Code's three-protocol mapping, and the plugin apply path. It never
 * touches the network: custom catalogs are either static or served by a stub
 * fetch. */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  Config,
  ConfigError,
  ProviderKeys,
  apply,
  buildCommandCodeProvider,
  buildProviders,
  defaultSecretDir,
  loadConfig,
  parseCatalog,
  resolveConfig,
  resolveConfigPath,
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

function throwsConfig(fn, label) {
  try {
    fn()
    check(label, false)
  } catch (error) {
    check(label, error instanceof ConfigError)
  }
}

const root = mkdtempSync(join(tmpdir(), 'dsh-more-providers-'))
const keyFile = join(root, 'mdkj-key')
const secretKey = join(root, 'secret-key')
writeFileSync(keyFile, 'file-key\n')
writeFileSync(secretKey, 'secret-key\n')

const baseConfig = {
  secretDir: root,
  providers: {
    mdkj: {
      kind: 'custom',
      displayName: 'MDKJ',
      api: 'openai-responses',
      baseURL: 'https://mdkj.lol/v1',
      models: [
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1 Sol',
          contextWindow: 524288,
          maxTokens: 32768,
          input: ['text', 'image'],
        },
      ],
      accounts: {
        stable: { displayName: 'MDKJ Stable', apiKeyFile: keyFile },
        cheap: { displayName: 'MDKJ Cheap', apiKeyFile: keyFile },
      },
    },
    'zai-coding-cn': {
      kind: 'builtin',
      apiKeyFile: keyFile,
    },
  },
}
const configPath = join(root, 'more-providers.yaml')
writeFileSync(configPath, JSON.stringify(baseConfig))

// ── defaults / paths ────────────────────────────────────────────────────────
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = root
check(
  'default config path under DSH_HOME',
  resolveConfigPath() === join(root, 'more-providers.yaml'),
)
if (previousHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = previousHome
check('explicit config path wins', resolveConfigPath(configPath) === configPath)
const previousRuntime = process.env.XDG_RUNTIME_DIR
process.env.XDG_RUNTIME_DIR = root
check('default secret dir is XDG_RUNTIME_DIR/agenix', defaultSecretDir() === join(root, 'agenix'))
if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR
else process.env.XDG_RUNTIME_DIR = previousRuntime

// ── config resolution / inheritance ─────────────────────────────────────────
const resolved = await loadConfig(configPath)
check(
  'account routes are provider-account',
  JSON.stringify(resolved.map((r) => r.route)) === '["mdkj-stable","mdkj-cheap","zai-coding-cn"]',
)
check('account display name', resolved[0]?.displayName === 'MDKJ Stable')
check(
  'account inherits custom fields',
  resolved[0]?.api === 'openai-responses' && resolved[0]?.baseURL === 'https://mdkj.lol/v1',
)
check(
  'account key file wins',
  resolved[0]?.keySource.kind === 'file' && resolved[0]?.keySource.path === keyFile,
)
check(
  'single provider keeps its id',
  resolved[2]?.route === 'zai-coding-cn' && resolved[2]?.catalog === 'zai-coding-cn',
)

// apiKeyFile wins over secretName at the same level.
const precedencePath = join(root, 'precedence.yaml')
writeFileSync(
  precedencePath,
  JSON.stringify({
    secretDir: root,
    providers: {
      p: {
        kind: 'builtin',
        catalog: 'zai-coding-cn',
        apiKeyFile: keyFile,
        secretName: 'secret-key',
      },
    },
  }),
)
const precedence = await loadConfig(precedencePath)
check(
  'apiKeyFile wins over secretName',
  precedence[0]?.keySource.kind === 'file' && precedence[0]?.keySource.path === keyFile,
)

// ── strict config errors ────────────────────────────────────────────────────
throwsConfig(() => resolveConfig({ providers: {}, extra: true }), 'unknown top-level key rejected')
throwsConfig(() => resolveConfig({ providers: { p: { kind: 'nope' } } }), 'unknown kind rejected')
throwsConfig(
  () =>
    resolveConfig({
      providers: { p: { kind: 'custom', api: 'openai-responses', baseURL: 'https://x.test/v1' } },
    }),
  'custom without models rejected',
)
throwsConfig(
  () =>
    resolveConfig({
      providers: { p: { kind: 'builtin', catalog: 'zai-coding-cn', models: [{ id: 'x' }] } },
    }),
  'builtin models rejected',
)
throwsConfig(
  () => resolveConfig({ providers: { p: { kind: 'builtin', accounts: {} } } }),
  'empty accounts rejected',
)
throwsConfig(
  () => resolveConfig({ providers: { p: { kind: 'builtin' } } }),
  'missing key source rejected',
)
throwsConfig(
  () =>
    resolveConfig({
      secretDir: root,
      providers: {
        p: {
          kind: 'builtin',
          catalog: 'zai-coding-cn',
          accounts: {
            a: { routeId: 'same', secretName: 'not-used' },
            b: { routeId: 'same', secretName: 'not-used' },
          },
        },
      },
    }),
  'duplicate route rejected',
)

// ── missing key is dormant, not config-invalid ──────────────────────────────
const dormantPath = join(root, 'dormant.yaml')
writeFileSync(
  dormantPath,
  JSON.stringify({
    secretDir: root,
    providers: {
      p: { kind: 'builtin', catalog: 'zai-coding-cn', secretName: 'missing-key' },
    },
  }),
)
const dormant = await buildProviders(await loadConfig(dormantPath), {
  info() {},
  warn() {},
  error() {},
})
check('missing key file skips only that route', dormant.profiles.size === 0)

// ── builtin + custom provider construction ─────────────────────────────────
const built = await buildProviders(resolved, { info() {}, warn() {}, error() {} })
check('build registers all keyed routes', built.profiles.size === 3)
check('build keeps key sources', built.keys.get('mdkj-stable')?.kind === 'file')
check(
  'builtin models come from pi-ai catalog',
  (await built.profiles.get('zai-coding-cn').piProvider.getModels()).length > 0,
)
check(
  'custom model has 512K context',
  (await built.profiles.get('mdkj-stable').piProvider.getModels())[0]?.contextWindow === 524288,
)
check(
  'custom reasoning defaults to low/medium/high',
  JSON.stringify(
    (await built.profiles.get('mdkj-stable').piProvider.getModels())[0]?.thinkingLevelMap,
  ) ===
    '{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null}',
)
check(
  'custom image input',
  JSON.stringify((await built.profiles.get('mdkj-stable').piProvider.getModels())[0]?.input) ===
    '["text","image"]',
)

// reasoning: false removes the thinking map.
const noThinkingPath = join(root, 'no-thinking.yaml')
writeFileSync(
  noThinkingPath,
  JSON.stringify({
    secretDir: root,
    providers: {
      p: {
        kind: 'custom',
        api: 'openai-responses',
        baseURL: 'https://x.test/v1',
        models: [{ id: 'plain', reasoning: false }],
        apiKeyFile: keyFile,
      },
    },
  }),
)
const noThinking = await buildProviders(await loadConfig(noThinkingPath), {
  info() {},
  warn() {},
  error() {},
})
const plain = noThinking.profiles.get('p')?.piProvider.getModels()[0]
check(
  'reasoning:false removes thinking levels',
  plain?.reasoning === false && plain?.thinkingLevelMap === undefined,
)

// ── model discovery + static fallback (stubbed fetch) ─────────────────────
const originalFetch = globalThis.fetch
let discoveryCalls = 0
globalThis.fetch = async (_url) => {
  discoveryCalls += 1
  return new Response(
    JSON.stringify({
      data: [{ id: 'gpt-6.1-sol' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
const discoveryPath = join(root, 'discovery.yaml')
writeFileSync(
  discoveryPath,
  JSON.stringify({
    secretDir: root,
    providers: {
      p: {
        kind: 'custom',
        api: 'openai-responses',
        baseURL: 'https://x.test/v1',
        modelsURL: 'https://x.test/v1/models',
        models: [
          { id: 'gpt-6.1-sol', contextWindow: 524288, maxTokens: 32768, input: ['text', 'image'] },
        ],
        apiKeyFile: keyFile,
      },
    },
  }),
)
const discovered = await buildProviders(await loadConfig(discoveryPath), {
  info() {},
  warn() {},
  error() {},
})
check('modelsURL is fetched once per provider', discoveryCalls === 1)
check(
  'discovered model inherits static metadata',
  discovered.profiles.get('p')?.piProvider.getModels()[0]?.contextWindow === 524288 &&
    discovered.profiles.get('p')?.piProvider.getModels()[0]?.maxTokens === 32768,
)
globalThis.fetch = async () => new Response('down', { status: 503 })
const fallbackPath = join(root, 'fallback.yaml')
writeFileSync(
  fallbackPath,
  JSON.stringify({
    secretDir: root,
    providers: {
      p: {
        kind: 'custom',
        api: 'openai-responses',
        baseURL: 'https://x.test/v1',
        modelsURL: 'https://x.test/v1/models',
        models: [{ id: 'fallback' }],
        apiKeyFile: keyFile,
      },
    },
  }),
)
const fallback = await buildProviders(await loadConfig(fallbackPath), {
  info() {},
  warn() {},
  error() {},
})
check(
  'failed catalog falls back to static models',
  fallback.profiles.get('p')?.piProvider.getModels()[0]?.id === 'fallback',
)
globalThis.fetch = originalFetch

// ── providerKeys service ───────────────────────────────────────────────────
const serviceContext = new Context()
const keyService = new ProviderKeys(serviceContext, built.keys)
check('providerKeys service resolves a file key', keyService.key('mdkj-stable') === 'file-key')
check('providerKeys service misses unknown route', keyService.key('unknown') === undefined)
writeFileSync(keyFile, 'rotated-key\n')
const future = new Date(Date.now() + 2000)
utimesSync(keyFile, future, future)
check('providerKeys service reloads by mtime', keyService.key('mdkj-stable') === 'rotated-key')
writeFileSync(keyFile, 'file-key\n')

// ── Command Code three-protocol mapping ────────────────────────────────────
const commandCodeItems = parseCatalog({
  data: [
    { id: 'claude-sonnet-5', context_length: 1_000_000, supported_endpoints: ['/messages'] },
    {
      id: 'gpt-6-astra',
      context_length: 1_050_000,
      supported_endpoints: ['/chat/completions', '/responses'],
    },
    { id: 'deepseek/deepseek-v4-pro', supported_endpoints: ['/chat/completions', '/responses'] },
    { id: 'skip', supported_endpoints: ['/embeddings'] },
  ],
})
const commandCodeModels = toPiModels(commandCodeItems, {
  baseURL: 'https://api.commandcode.ai/provider',
  provider: 'command-code',
})
check(
  'command-code maps three protocols',
  commandCodeModels.length === 3 &&
    commandCodeModels[0]?.api === 'anthropic-messages' &&
    commandCodeModels[1]?.api === 'openai-responses' &&
    commandCodeModels[2]?.api === 'openai-completions',
)
const commandCodeProvider = buildCommandCodeProvider(commandCodeItems, {
  route: 'command-code',
  displayName: 'Command Code',
  baseURL: 'https://api.commandcode.ai/provider',
  zdr: true,
})
check('command-code provider builds', commandCodeProvider.provider.getModels().length === 3)

// ── plugin apply path ──────────────────────────────────────────────────────
class StubLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.registrations = []
  }
  registerAdapter(routes, adapter) {
    this.registrations.push({ routes, adapter })
  }
}
const appContext = new Context()
const llm = new StubLlm(appContext)
await apply(appContext, Config({ configFile: configPath }))
check('apply registers one adapter', llm.registrations.length === 1)
check(
  'apply registers all routes',
  JSON.stringify(llm.registrations[0]?.routes) === '["mdkj-stable","mdkj-cheap","zai-coding-cn"]',
)
check(
  'apply exposes providerKeys',
  appContext.get('providerKeys')?.key('mdkj-stable') === 'file-key',
)
check(
  'apply adapter lists custom models',
  (await llm.registrations[0]?.adapter.listModels('mdkj-stable'))?.length === 1,
)

const missingContext = new Context()
const missingLlm = new StubLlm(missingContext)
await apply(missingContext, Config({ configFile: join(root, 'missing.yaml') }))
check('missing config does not throw or register', missingLlm.registrations.length === 0)

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('smoke OK')
