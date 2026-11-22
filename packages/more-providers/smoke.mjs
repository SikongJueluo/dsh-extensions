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
  buildRoutes,
  toProviderSpecs,
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

const LOG = { info() {}, warn() {}, error() {} }

/** Resolve one config file and build its routes through the single registry path. */
async function buildOf(configPath) {
  return buildRoutes(toProviderSpecs(await loadConfig(configPath)), LOG)
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

const { providers: resolved } = await loadConfig(configPath)
check(
  'one provider registers one pooled route',
  JSON.stringify(resolved.map((r) => r.route)) === '["mdkj","zai-coding-cn"]',
)
check(
  'accounts keep their YAML priority order',
  JSON.stringify(resolved[0]?.accounts?.map((account) => account.id)) === '["stable","cheap"]',
)
check('account display name', resolved[0]?.accounts?.[0]?.displayName === 'MDKJ Stable')
check(
  'provider keeps the shared connection fields',
  resolved[0]?.api === 'openai-responses' && resolved[0]?.baseURL === 'https://mdkj.lol/v1',
)
check(
  'account key file wins',
  resolved[0]?.accounts?.[0]?.keySource.kind === 'file' &&
    resolved[0]?.accounts?.[0]?.keySource.path === keyFile,
)
check(
  'single provider keeps its id',
  resolved[1]?.route === 'zai-coding-cn' && resolved[1]?.catalog === 'zai-coding-cn',
)
check(
  'a single-key provider still gets a one-member pool',
  resolved[1]?.accounts?.length === 1 && resolved[1]?.accounts?.[0]?.id === 'zai-coding-cn',
)

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
const { providers: precedence } = await loadConfig(precedencePath)
check(
  'apiKeyFile wins over secretName',
  precedence[0]?.accounts?.[0]?.keySource.kind === 'file' &&
    precedence[0]?.accounts?.[0]?.keySource.path === keyFile,
)

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
        first: {
          kind: 'builtin',
          catalog: 'zai-coding-cn',
          routeId: 'same',
          secretName: 'not-used',
        },
        second: {
          kind: 'builtin',
          catalog: 'zai-coding-cn',
          routeId: 'same',
          secretName: 'not-used',
        },
      },
    }),
  'duplicate route rejected',
)
throwsConfig(
  () =>
    resolveConfig({
      secretDir: root,
      providers: {
        p: {
          kind: 'custom',
          api: 'openai-responses',
          baseURL: 'https://x.test/v1',
          models: [{ id: 'x' }],
          accounts: { a: { secretName: 'not-used', routeId: 'p-a' } },
        },
      },
    }),
  'account routeId rejected with a migration hint',
)
throwsConfig(
  () => resolveConfig({ providers: { chatgpt: { baseURL: 'https://x.test/v1' } } }),
  'chatgpt without kind rejected with a migration hint',
)

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
const dormant = await buildOf(dormantPath)
check('missing key file skips only that route', dormant.profiles.size === 0)

const built = await buildOf(configPath)
check('build registers all keyed routes', built.profiles.size === 2)
check(
  'build keeps the pool key sources',
  built.accounts.get('mdkj')?.accounts[0]?.keySource.kind === 'file' &&
    built.accounts.get('mdkj')?.accounts.length === 2,
)
check(
  'builtin models come from pi-ai catalog',
  (await built.profiles.get('zai-coding-cn').piProvider.getModels()).length > 0,
)
check(
  'custom model has 512K context',
  (await built.profiles.get('mdkj').piProvider.getModels())[0]?.contextWindow === 524288,
)
check(
  'custom reasoning defaults to low/medium/high',
  JSON.stringify((await built.profiles.get('mdkj').piProvider.getModels())[0]?.thinkingLevelMap) ===
    '{"off":null,"minimal":null,"low":"low","medium":"medium","high":"high","xhigh":null,"max":null}',
)
check(
  'custom image input',
  JSON.stringify((await built.profiles.get('mdkj').piProvider.getModels())[0]?.input) ===
    '["text","image"]',
)

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
const noThinking = await buildOf(noThinkingPath)
const plain = noThinking.profiles.get('p')?.piProvider.getModels()[0]
check(
  'reasoning:false removes thinking levels',
  plain?.reasoning === false && plain?.thinkingLevelMap === undefined,
)

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
const discovered = await buildOf(discoveryPath)
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
const fallback = await buildOf(fallbackPath)
check(
  'failed catalog falls back to static models',
  fallback.profiles.get('p')?.piProvider.getModels()[0]?.id === 'fallback',
)
check(
  'catalog failure is reported next to the static fallback',
  fallback.reports.get('p')?.registered === true &&
    fallback.reports.get('p')?.catalogError?.includes('503') === true,
)
const commandFailurePath = join(root, 'command-failure.yaml')
writeFileSync(
  commandFailurePath,
  JSON.stringify({
    secretDir: root,
    providers: { command: { kind: 'command-code', apiKeyFile: keyFile } },
  }),
)
const commandFailure = await buildOf(commandFailurePath)
check(
  'command-code catalog failure records catalogError and error',
  commandFailure.profiles.size === 0 &&
    commandFailure.reports.get('command')?.registered === false &&
    commandFailure.reports.get('command')?.catalogError?.includes('503') === true &&
    commandFailure.reports.get('command')?.error?.includes('503') === true,
)
globalThis.fetch = originalFetch

const filterPath = join(root, 'filter.yaml')
writeFileSync(
  filterPath,
  JSON.stringify({
    secretDir: root,
    providers: {
      p: {
        kind: 'custom',
        api: 'openai-responses',
        baseURL: 'https://x.test/v1',
        models: [{ id: 'gpt-6' }, { id: 'gpt-6-mini' }, { id: 'claude-5' }],
        filter: {
          include: [{ match: '^gpt-' }],
          exclude: [{ match: '-mini$' }],
        },
        apiKeyFile: keyFile,
      },
      empty: {
        kind: 'custom',
        api: 'openai-responses',
        baseURL: 'https://x.test/v1',
        models: [{ id: 'only' }],
        filter: { include: [{ match: '^nothing$' }] },
        apiKeyFile: keyFile,
      },
      'zai-filtered': {
        kind: 'builtin',
        catalog: 'zai-coding-cn',
        apiKeyFile: keyFile,
        filter: { exclude: [{ match: '.' }] },
      },
    },
  }),
)
const filtered = await buildOf(filterPath)
const filteredIds = filtered.profiles
  .get('p')
  ?.piProvider.getModels()
  .map((model) => model.id)
check('filter keeps the allow list and drops the deny list', filteredIds?.[0] === 'gpt-6')
check(
  'filter reports count the dropped ids',
  JSON.stringify(filtered.reports.get('p')?.models) ===
    '{"discovered":3,"effective":1,"excluded":["gpt-6-mini"],"notIncluded":["claude-5"]}',
)
check(
  'a filtered-out custom route is not registered',
  !filtered.profiles.has('empty') &&
    filtered.reports.get('empty')?.registered === false &&
    filtered.reports.get('empty')?.models?.effective === 0,
)
check(
  'a filtered-out builtin route is not registered',
  !filtered.profiles.has('zai-filtered') &&
    (filtered.reports.get('zai-filtered')?.models?.excluded.length ?? 0) > 0,
)

const defaultsPath = join(root, 'defaults.yaml')
writeFileSync(
  defaultsPath,
  JSON.stringify({
    secretDir: root,
    defaults: {
      contextWindows: { 'gpt-6.1-sol': 272000, shared: 128000 },
      modelDefaults: [{ match: '-sol$', reasoning: ['low', 'high'] }],
      filter: { exclude: [{ match: '-free$' }] },
    },
    providers: {
      p: {
        kind: 'custom',
        api: 'openai-responses',
        baseURL: 'https://x.test/v1',
        models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-sol-thinking' }, { id: 'gpt-6.1-sol-free' }],
        contextWindows: { 'gpt-6.1-sol': 500000 },
        modelDefaults: [{ match: '-sol$', contextWindow: 1000000 }],
        filter: { exclude: [{ match: '-thinking$' }] },
        apiKeyFile: keyFile,
      },
    },
  }),
)
const defaulted = await buildOf(defaultsPath)
const defaultedModels = defaulted.profiles.get('p')?.piProvider.getModels() ?? []
check(
  'defaults filter and provider filter both apply',
  defaultedModels.map((model) => model.id).join(',') === 'gpt-6.1-sol',
)
const defaultSpec = (await loadConfig(defaultsPath)).providers[0]
check(
  'provider model defaults come first, global ones follow',
  JSON.stringify(defaultSpec.modelDefaults?.map((rule) => rule.pattern.source)) ===
    '["-sol$","-sol$"]',
)
check(
  'provider context windows beat global ones by id',
  defaultSpec.contextWindows?.get('gpt-6.1-sol') === 500000 &&
    defaultSpec.contextWindows?.get('shared') === 128000,
)
throwsConfig(
  () =>
    resolveConfig({
      providers: {
        p: {
          kind: 'builtin',
          catalog: 'zai-coding-cn',
          apiKeyFile: keyFile,
          filter: { include: [{ match: '(' }] },
        },
      },
    }),
  'invalid filter pattern rejected',
)
throwsConfig(
  () =>
    resolveConfig({
      defaults: { filter: { include: [{ match: '(' }] } },
      providers: { p: { kind: 'builtin', catalog: 'zai-coding-cn', apiKeyFile: keyFile } },
    }),
  'invalid defaults pattern rejected with the defaults path',
)
throwsConfig(
  () =>
    resolveConfig({
      providers: {
        p: {
          kind: 'builtin',
          catalog: 'zai-coding-cn',
          accounts: { a: { apiKeyFile: keyFile, filter: { exclude: [{ match: '.' }] } } },
        },
      },
    }),
  'account-level filter rejected',
)

const serviceContext = new Context()
const keyService = new ProviderKeys(serviceContext, built.accounts)
check('providerKeys service resolves a file key', keyService.key('mdkj') === 'file-key')
check('providerKeys service misses unknown route', keyService.key('unknown') === undefined)
writeFileSync(keyFile, 'rotated-key\n')
const future = new Date(Date.now() + 2000)
utimesSync(keyFile, future, future)
check('providerKeys service reloads by mtime', keyService.key('mdkj') === 'rotated-key')
writeFileSync(keyFile, 'file-key\n')

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
  JSON.stringify(llm.registrations[0]?.routes) === '["mdkj","zai-coding-cn"]',
)
check('apply exposes providerKeys', appContext.get('providerKeys')?.key('mdkj') === 'file-key')
check(
  'apply adapter lists custom models',
  (await llm.registrations[0]?.adapter.listModels('mdkj'))?.length === 1,
)
check(
  'apply leaves the unconfigured chatgpt route unregistered',
  JSON.stringify(llm.registrations[0]?.routes) === '["mdkj","zai-coding-cn"]' &&
    appContext.get('oauthProviders') === undefined,
)

const missingContext = new Context()
const missingLlm = new StubLlm(missingContext)
await apply(missingContext, Config({ configFile: join(root, 'missing.yaml') }))
check('missing config does not throw or register', missingLlm.registrations.length === 0)

class StubWebServer extends Service {
  constructor(ctx) {
    super(ctx, 'webServer')
    this.routes = []
  }
  register(route) {
    this.routes.push(route)
    return () => {}
  }
}
const statusContext = new Context()
const statusServer = new StubWebServer(statusContext)
const statusLlm = new StubLlm(statusContext)
const brokenPath = join(root, 'broken.yaml')
writeFileSync(brokenPath, 'providers:\n  p:\n    kind: builtin\n')
await apply(statusContext, Config({ configFile: brokenPath }))
const statusRoute = statusServer.routes.find(
  (route) => route.path === '/dsh-more-providers/config-status',
)
check('an invalid config still serves its status route', statusRoute !== undefined)
const brokenStatus = await (await statusRoute.resource()).json()
const brokenInstance = brokenStatus.instances.find((instance) => instance.file === brokenPath)
check(
  'the status reports the error and the automatic-reload recovery',
  brokenInstance?.state === 'invalid' &&
    brokenInstance.recovery === 'auto' &&
    brokenInstance.error.includes('no key source'),
)
check('no provider was registered from the broken config', statusLlm.registrations.length === 0)
await statusContext.fiber.dispose()

process.env.REVIEW_FAKE_KEY = 'review-value'
const badCatalogPath = join(root, 'bad-catalog.yaml')
writeFileSync(
  badCatalogPath,
  'providers:\n  wrong:\n    kind: builtin\n    catalog: definitely-not-a-real-catalog\n    apiKeyEnv: REVIEW_FAKE_KEY\n',
)
const catalogContext = new Context()
const catalogServer = new StubWebServer(catalogContext)
const catalogLlm = new StubLlm(catalogContext)
await apply(catalogContext, Config({ configFile: badCatalogPath }))
const catalogRoute = catalogServer.routes.find(
  (route) => route.path === '/dsh-more-providers/config-status',
)
const catalogStatus = await (await catalogRoute.resource()).json()
const catalogInstance = catalogStatus.instances.find((instance) => instance.file === badCatalogPath)
check(
  'a provider build failure is reported through the config status',
  catalogInstance?.state === 'invalid' &&
    catalogInstance.recovery === 'auto' &&
    catalogInstance.error.includes('unknown builtin catalog'),
)
check('the failed build registered no adapter', catalogLlm.registrations.length === 0)
delete process.env.REVIEW_FAKE_KEY

rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('smoke OK')
