import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent'
import {
  apply,
  callConfigOf,
  inject,
  name,
  parseCrewPolicy,
  routeName,
  selectRoute,
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

function throwsConfig(fn, fragment, label) {
  try {
    fn()
  } catch (error) {
    check(label, error instanceof Error && error.message.includes(fragment))
    return
  }
  check(label, false)
}

async function until(condition, what, attempts = 400) {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) return
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  throw new Error(`timed out waiting for ${what}`)
}

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const MODEL_DEFAULT_EFFORT = 'model-default'

const statusRoutes = []
function registerStatusRoute(route) {
  statusRoutes.push(route)
  return () => {
    const index = statusRoutes.indexOf(route)
    if (index >= 0) statusRoutes.splice(index, 1)
  }
}

const VALID = `routes:
  execute:
    desc: 用于代码实现、文件修改和常规执行任务。
    candidates:
      - provider: provider-a
        model: model-a
        reasoningEffort: high
      - provider: provider-b
        model: model-b
  review:
    desc: 用于审查、设计讨论和复杂推理。
    candidates:
      - provider: provider-c
        model: model-c
`
check('plugin:', name === 'dsh-crew')
check(
  'inject covers the delegation services',
  inject.includes('tools') && inject.includes('subagents'),
)

const policy = parseCrewPolicy({
  routes: {
    execute: {
      desc: 'execution',
      candidates: [
        { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
        { provider: 'provider-b', model: 'model-b' },
      ],
    },
    review: { desc: 'review', candidates: [{ provider: 'provider-c', model: 'model-c' }] },
  },
})
check('two routes parse in order', Object.keys(policy.routes).join(',') === 'execute,review')
check('candidate order is preserved', policy.routes.execute?.candidates[1]?.model === 'model-b')
check(
  'an omitted effort stays omitted',
  policy.routes.execute?.candidates[1]?.reasoningEffort === undefined,
)

throwsConfig(
  () => parseCrewPolicy({ routes: {} }),
  'at least one route',
  'an empty routes map is rejected',
)
throwsConfig(
  () => parseCrewPolicy({ routes: { execute: { candidates: [] } } }),
  'desc',
  'a missing desc is rejected',
)
throwsConfig(
  () => parseCrewPolicy({ routes: { execute: { desc: 'x', candidates: [] } } }),
  'at least one candidate',
  'an empty candidate list is rejected',
)
throwsConfig(
  () => parseCrewPolicy({ routes: { 'Bad Id': { desc: 'x', candidates: [] } } }),
  'route id',
  'an invalid route id is rejected',
)
throwsConfig(
  () => parseCrewPolicy({ routes: { constructor: { desc: 'x', candidates: [] } } }),
  'not a usable route id',
  'a prototype key is rejected as a route id',
)
throwsConfig(
  () =>
    parseCrewPolicy({
      routes: { execute: { desc: 'x', candidates: [{ provider: 'p', model: 'm', extra: 1 }] } },
    }),
  'unknown key',
  'unknown candidate keys are rejected',
)
throwsConfig(
  () =>
    parseCrewPolicy({
      routes: {
        execute: { desc: 'x', candidates: [{ provider: 'p', model: 'm', reasoningEffort: '' }] },
      },
    }),
  'reasoningEffort',
  'an empty effort is rejected rather than silently dropped',
)
throwsConfig(
  () => parseCrewPolicy({ routes: {}, extra: true }),
  'unknown key',
  'unknown root keys are rejected',
)

function makeSelectionCtx({ failFor = [], plan, planThrows = false } = {}) {
  const warnings = []
  const calls = []
  const quotaCalls = []
  const ctx = {
    llm: {
      async resolveCallConfig(callConfig) {
        calls.push(routeName(callConfig))
        if (failFor.includes(callConfig.provider)) {
          throw new Error(`llm: provider route "${callConfig.provider}" is not registered`)
        }
        return {
          ...callConfig,
          reasoningEffort: callConfig.reasoningEffort ?? MODEL_DEFAULT_EFFORT,
        }
      },
    },
    logger: { warn: (message, ...args) => warnings.push([message, ...args].join(' ')) },
    get: (serviceName) =>
      serviceName === 'planUsage' && (plan !== undefined || planThrows)
        ? {
            get: async (provider) => {
              quotaCalls.push(provider)
              if (planThrows) throw new Error('quota backend down')
              return typeof plan === 'function' ? plan(provider) : plan
            },
          }
        : undefined,
  }
  return { ctx, warnings, calls, quotaCalls }
}

{
  const healthy = makeSelectionCtx()
  const picked = await selectRoute(healthy.ctx, policy, 'execute', new AbortController().signal)
  check(
    'the first candidate serves a healthy route',
    picked.target.provider === 'provider-a' && picked.skipped.length === 0,
  )
  check('the resolved config keeps the pinned effort', picked.config.reasoningEffort === 'high')
  check('only the first candidate is preflighted', healthy.calls.length === 1)
}

{
  const fallback = makeSelectionCtx({ failFor: ['provider-a'] })
  const picked = await selectRoute(fallback.ctx, policy, 'execute', new AbortController().signal)
  check(
    'an unavailable candidate falls through to the next approved one',
    picked.target.provider === 'provider-b' && picked.skipped.length === 1,
  )
  check(
    'an unpinned candidate resolves the model default',
    picked.config.reasoningEffort === MODEL_DEFAULT_EFFORT,
  )
  check(
    'the skip names the unavailable candidate and its cause',
    picked.skipped[0]?.reason.includes('route unavailable') === true,
  )
}

{
  const exhaustedWindow = { fiveHour: { percent: 100, resetAt: Date.now() + 3_600_000 } }
  const exhausted = makeSelectionCtx({
    plan: (provider) =>
      provider === 'provider-a' ? exhaustedWindow : { fiveHour: { percent: 5 } },
  })
  const picked = await selectRoute(exhausted.ctx, policy, 'execute', new AbortController().signal)
  check(
    'an exhausted coding-plan window skips that candidate',
    picked.target.provider === 'provider-b' &&
      picked.skipped[0]?.reason === 'coding-plan window exhausted',
  )
  check(
    'each distinct provider is read once',
    exhausted.quotaCalls.join(',') === 'provider-a,provider-b',
  )

  const sharedProvider = {
    routes: {
      execute: {
        desc: 'shared provider',
        candidates: [
          { provider: 'provider-a', model: 'model-a' },
          { provider: 'provider-a', model: 'model-a2' },
          { provider: 'provider-b', model: 'model-b' },
        ],
      },
    },
  }
  const deduped = makeSelectionCtx({
    plan: (provider) =>
      provider === 'provider-a' ? exhaustedWindow : { fiveHour: { percent: 5 } },
  })
  const dedupedPick = await selectRoute(
    deduped.ctx,
    sharedProvider,
    'execute',
    new AbortController().signal,
  )
  check(
    'two candidates on one provider share a single quota read',
    dedupedPick.target.provider === 'provider-b' &&
      deduped.quotaCalls.join(',') === 'provider-a,provider-b',
  )
}

{
  const fresh = makeSelectionCtx({ plan: { fiveHour: { percent: 40 } } })
  const picked = await selectRoute(fresh.ctx, policy, 'execute', new AbortController().signal)
  check('a live window keeps the first candidate', picked.target.provider === 'provider-a')
}

{
  const broken = makeSelectionCtx({ planThrows: true })
  const picked = await selectRoute(broken.ctx, policy, 'execute', new AbortController().signal)
  check('a failed quota read is unknown, not exhausted', picked.target.provider === 'provider-a')
}

{
  const hanging = {
    llm: {
      resolveCallConfig: async (callConfig) => ({
        ...callConfig,
        reasoningEffort: callConfig.reasoningEffort ?? MODEL_DEFAULT_EFFORT,
      }),
    },
    logger: { warn() {} },
    get: () => ({ get: () => new Promise(() => {}) }),
  }
  const startedAt = Date.now()
  const picked = await selectRoute(hanging, policy, 'execute', new AbortController().signal)
  const elapsed = Date.now() - startedAt
  check('a hanging quota read does not block selection', picked.target.provider === 'provider-a')
  check('the shared quota budget bounds the wait', elapsed >= 1_900 && elapsed < 4_000)
}

{
  const bothDown = makeSelectionCtx({ failFor: ['provider-a', 'provider-b'] })
  let error
  try {
    await selectRoute(bothDown.ctx, policy, 'execute', new AbortController().signal)
  } catch (failure) {
    error = failure
  }
  check(
    'every candidate down fails with both reasons',
    error instanceof Error &&
      error.message.includes('provider-a/model-a') &&
      error.message.includes('provider-b/model-b'),
  )
}

{
  const aborted = new AbortController()
  aborted.abort()
  const cancelled = makeSelectionCtx({ failFor: ['provider-a'] })
  let error
  try {
    await selectRoute(cancelled.ctx, policy, 'execute', aborted.signal)
  } catch (failure) {
    error = failure
  }
  check(
    'an aborted delegation never degrades to another candidate',
    error instanceof Error && cancelled.calls.length === 1,
  )
}

{
  const ctx = makeSelectionCtx()
  let error
  try {
    await selectRoute(ctx.ctx, policy, 'missing', new AbortController().signal)
  } catch (failure) {
    error = failure
  }
  check(
    'an unknown route reports the available routes',
    error instanceof Error && error.message.includes('execute, review'),
  )
}

check(
  'callConfigOf carries effort only when pinned',
  callConfigOf({ provider: 'p', model: 'm', reasoningEffort: 'high' }).reasoningEffort === 'high' &&
    callConfigOf({ provider: 'p', model: 'm' }).reasoningEffort === undefined,
)

const directory = await mkdtemp(join(tmpdir(), 'dsh-crew-smoke-'))
const configPath = join(directory, 'crew.yaml')
await writeFile(configPath, VALID)

function makeApplyCtx({ activate, plan, fillDefault = true, llm } = {}) {
  const registered = new Map()
  const warnings = []
  const infos = []
  const errors = []
  const starts = []
  const disposals = []
  const effects = []
  const routes = statusRoutes
  const createdSelections = []
  const listeners = new Map()
  let section
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true },
    prepareContinuable: () => {},
  }
  const log = {
    info: (message, ...args) => infos.push([message, ...args].join(' ')),
    warn: (message, ...args) => warnings.push([message, ...args].join(' ')),
    error: (message, ...args) => errors.push([message, ...args].join(' ')),
  }
  const ctx = {
    logger: () => log,
    get: (serviceName) =>
      serviceName === 'planUsage' && plan !== undefined ? { get: async () => plan } : undefined,
    on: (event, listener) => {
      const subscribers = listeners.get(event) ?? []
      subscribers.push(listener)
      listeners.set(event, subscribers)
      return () => {
        const index = subscribers.indexOf(listener)
        if (index >= 0) subscribers.splice(index, 1)
      }
    },
    effect: (callback) => {
      const dispose = callback()
      if (typeof dispose === 'function') effects.push(dispose)
    },
    inject: (_dependencies, callback) => {
      callback({
        effect: (run) => {
          const dispose = run()
          if (typeof dispose === 'function') effects.push(dispose)
        },
        webServer: { register: registerStatusRoute },
      })
    },
    llm: llm ?? {
      async resolveCallConfig(callConfig) {
        return fillDefault
          ? {
              ...callConfig,
              reasoningEffort: callConfig.reasoningEffort ?? MODEL_DEFAULT_EFFORT,
            }
          : callConfig
      },
    },
    tools: {
      register: (tool) => {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
      get: (toolName) => registered.get(toolName),
    },
    subagents: {
      getProvider: (providerName) => (providerName === 'spawn' ? provider : undefined),
      resolveMaxDepth: () => undefined,
      startActivation: async (spec) => {
        starts.push(spec)
        const childId = spec.childId ?? `child-${starts.length}`

        const agent = {
          id: childId,
          model: {
            select: (selection) => createdSelections.push(selection),
          },
        }
        for (const listener of listeners.get('agent/created') ?? []) listener({ agent })
        if (activate !== undefined) return activate(spec, childId)
        return {
          childId,
          messageId: 'message-1',
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: 'child answer' }],
          }),
          dispose: async () => {
            disposals.push(childId)
          },
        }
      },
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section: (value) => {
        section = value
        return () => {}
      },
    },
  }
  return {
    ctx,
    registered,
    warnings,
    infos,
    errors,
    starts,
    createdSelections,
    disposals,
    effects,
    routes,
    listeners,
    section: () => section,
  }
}

function subagentExec() {
  return {
    agent: { id: 'parent-agent' },
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  }
}

async function executeTool(tool, args) {
  return tool.execute(args, subagentExec())
}

{
  const app = makeApplyCtx()
  await apply(app.ctx, { provider: 'spawn', configFile: configPath })
  const subagent = app.registered.get('subagent')
  const createAgent = app.registered.get('create_agent')
  check(
    'subagent and create_agent are registered',
    subagent !== undefined && createAgent !== undefined,
  )
  check(
    'route is a required plain string parameter',
    subagent.parameters.properties.route.type === 'string' &&
      subagent.parameters.required.includes('route') &&
      subagent.parameters.properties.route.enum === undefined,
  )
  check(
    'the old tier tools are gone',
    app.registered.has('subagent_quick') === false &&
      app.registered.has('subagent_smart') === false,
  )
  check(
    'startup logs the loaded routes',
    app.infos.some((line) => line.includes('loaded 2 delegation route(s)')),
  )
  const healthyStatus = await (
    await app.routes.find((route) => route.path === '/dsh-crew/config-status').resource()
  ).json()
  const healthyInstance = healthyStatus.instances.find((instance) => instance.file === configPath)
  check(
    'the status route reports a valid policy and automatic recovery',
    healthyInstance?.state === 'valid' && healthyInstance.recovery === 'auto',
  )

  const autoActivate = (spec, childId) => ({
    childId,
    messageId: 'message-1',
    result: Promise.resolve({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'child answer' }],
    }),
    dispose: async () => {
      foregroundApp.disposals.push(childId)
    },
  })
  const foregroundApp = makeApplyCtx({ activate: autoActivate })
  await apply(foregroundApp.ctx, { provider: 'spawn', configFile: configPath })
  const foreground = await executeTool(foregroundApp.registered.get('subagent'), {
    route: 'execute',
    description: 'run the task',
    prompt: 'do it',
    run_in_background: false,
  })
  check('a foreground delegation returns the child output', foreground.kind === 'foreground')
  check(
    'the result reports the route and the serving model',
    foreground.route === 'execute' &&
      foreground.provider === 'provider-a' &&
      foreground.model === 'model-a',
  )
  check('a first-candidate run has no notice', foreground.notice === undefined)
  check(
    'the child receives the pinned agent options',
    foregroundApp.starts[0]?.request.agentOptions.provider === 'provider-a',
  )
  check('a finished foreground child is disposed', foregroundApp.disposals.length === 1)

  const backgroundApp = makeApplyCtx({
    activate: (spec, childId) => ({
      childId,
      messageId: 'message-1',
      result: new Promise(() => {}),
      dispose: async () => {
        backgroundApp.disposals.push(childId)
      },
    }),
  })
  await apply(backgroundApp.ctx, { provider: 'spawn', configFile: configPath })
  const background = await executeTool(backgroundApp.registered.get('subagent'), {
    route: 'review',
    description: 'review the change',
    prompt: 'review it',
  })
  check('a background delegation returns its subagent id', background.kind === 'continuable')
  check(
    'an omitted effort is materialized as the model default',
    backgroundApp.starts[0]?.request.agentOptions.reasoningEffort === MODEL_DEFAULT_EFFORT,
  )
  check(
    'a materialized default needs no child selection override',
    backgroundApp.starts[0]?.childId === undefined && backgroundApp.createdSelections.length === 0,
  )
  check(
    'the result reports the effort that actually serves the child',
    background.reasoningEffort === MODEL_DEFAULT_EFFORT,
  )
  check('a background child is not disposed by the tool call', backgroundApp.disposals.length === 0)

  const created = await executeTool(app.registered.get('create_agent'), {
    route: 'review',
    description: 'reviewer',
    role: 'review code',
  })
  check(
    'create_agent reports the route, model and default effort',
    created.kind === 'created' &&
      created.route === 'review' &&
      created.model === 'model-c' &&
      created.reasoningEffort === MODEL_DEFAULT_EFFORT,
  )

  const parent = {
    options: {},
    session: {
      requestHeader: () => ({
        config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
      }),
    },
  }
  const merged = resolveChildAgentOptions(parent, backgroundApp.starts[0]?.request.agentOptions, 1)
  check(
    'an explicit default effort wins over parent inheritance on the same route',
    merged.reasoningEffort === MODEL_DEFAULT_EFFORT,
  )

  const section = app.section()
  check('the system prompt section is registered', section !== undefined)
  const table = section.text({})
  check(
    'the route table lists names and descriptions',
    table.includes('- execute:') && table.includes('- review:') && table.includes('用于审查'),
  )
  check('the route table asks for a route name', table.includes('require `route`'))
}

{
  const app = makeApplyCtx({
    activate: (spec, childId) => ({
      childId,
      messageId: 'message-1',
      result: Promise.resolve({
        stopReason: 'completed',
        output: [{ type: 'text', text: 'fallback answer' }],
      }),
      dispose: async () => {},
    }),
  })
  app.ctx.llm.resolveCallConfig = async (callConfig) => {
    if (callConfig.provider === 'provider-a') throw new Error('provider-a is not registered')
    return callConfig
  }
  await apply(app.ctx, { provider: 'spawn', configFile: configPath })
  const result = await executeTool(app.registered.get('subagent'), {
    route: 'execute',
    description: 'fallback run',
    prompt: 'do it',
    run_in_background: false,
  })
  check(
    'a fallback run reports the serving candidate',
    result.provider === 'provider-b' && result.model === 'model-b',
  )
  check(
    'a fallback run carries the skip reason',
    (result.notice ?? '').includes('provider-a/model-a'),
  )
  check(
    'a fallback is logged',
    app.warnings.some((line) => line.includes('after skipping')),
  )
}

{
  const samePath = join(directory, 'same.yaml')
  await writeFile(
    samePath,
    'routes:\n  same:\n    desc: same route\n    candidates:\n      - provider: provider-a\n        model: model-a\n',
  )
  const app = makeApplyCtx({ fillDefault: false })
  await apply(app.ctx, { provider: 'spawn', configFile: samePath })
  const result = await executeTool(app.registered.get('subagent'), {
    route: 'same',
    description: 'same route run',
    prompt: 'work',
  })
  check(
    'a resolver without a default effort reserves the child identity',
    app.starts[0]?.childId !== undefined,
  )
  check(
    'the child selection names the same route without an effort',
    app.createdSelections.length === 1 &&
      app.createdSelections[0].provider === 'provider-a' &&
      app.createdSelections[0].model === 'model-a' &&
      app.createdSelections[0].reasoningEffort === undefined,
  )
  const parent = {
    options: {},
    session: {
      requestHeader: () => ({
        config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
      }),
    },
  }
  const merged = resolveChildAgentOptions(parent, app.starts[0]?.request.agentOptions, 1)
  check(
    'the SDK merge alone still inherits the parent effort on an identical route',
    merged.reasoningEffort === 'high',
  )
  check(
    'the child selection overrides that inheritance',
    app.createdSelections[0]?.reasoningEffort === undefined,
  )
  check(
    'the result reports no effort for the unpinned candidate',
    result.reasoningEffort === undefined,
  )
}

{
  class NoDefaultEffort extends LlmAdapter {
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
        },
      }
    }

    async *stream() {}
  }

  const root = new Context()
  const llm = new LlmRuntime(root)
  llm.registerAdapter(['provider-a'], new NoDefaultEffort())
  const realPath = join(directory, 'real-resolver.yaml')
  await writeFile(
    realPath,
    'routes:\n  same:\n    desc: same route\n    candidates:\n      - provider: provider-a\n        model: model-a\n',
  )
  const app = makeApplyCtx({ llm })
  await apply(app.ctx, { provider: 'spawn', configFile: realPath })
  const result = await executeTool(app.registered.get('subagent'), {
    route: 'same',
    description: 'real resolver run',
    prompt: 'work',
  })
  check(
    'the real resolver returns no effort when the model has no default',
    app.starts[0]?.request.agentOptions.provider === 'provider-a' &&
      app.starts[0]?.request.agentOptions.model === 'model-a' &&
      app.starts[0]?.request.agentOptions.reasoningEffort === undefined,
  )
  check(
    'the real-resolver child selection also carries no effort',
    app.createdSelections.length === 1 &&
      app.createdSelections[0].provider === 'provider-a' &&
      app.createdSelections[0].model === 'model-a' &&
      app.createdSelections[0].reasoningEffort === undefined,
  )
  check('the real-resolver result reports no effort', result.reasoningEffort === undefined)
  await root.fiber.dispose()
}

{
  const brokenPath = join(directory, 'broken.yaml')
  await writeFile(brokenPath, 'routes: [oops\n')
  const app = makeApplyCtx()
  await apply(app.ctx, { provider: 'spawn', configFile: brokenPath })
  check('invalid config still registers the tools', app.registered.has('subagent'))
  check('invalid config is logged as an error', app.errors.length > 0)
  const brokenStatus = await (
    await app.routes.find((route) => route.path === '/dsh-crew/config-status').resource()
  ).json()
  const brokenInstance = brokenStatus.instances.find((instance) => instance.file === brokenPath)
  check(
    'the status route reports the current error and automatic recovery',
    brokenInstance?.state === 'invalid' &&
      brokenInstance.recovery === 'auto' &&
      brokenInstance.error.includes('invalid YAML'),
  )
  check(
    'the route table explains the disabled state',
    app.section().text({}).includes('Delegation is disabled'),
  )
  let error
  try {
    await executeTool(app.registered.get('subagent'), {
      route: 'execute',
      description: 'blocked',
      prompt: 'blocked',
    })
  } catch (failure) {
    error = failure
  }
  check(
    'an invalid config refuses new delegations',
    error instanceof Error && error.message.includes('not usable'),
  )

  await writeFile(brokenPath, VALID)
  await until(() => app.section().text({}).includes('- execute:'), 'hot reload to recover')
  const recovered = await executeTool(app.registered.get('subagent'), {
    route: 'execute',
    description: 'after recovery',
    prompt: 'work',
  })
  check('fixing the file recovers without a restart', recovered.kind === 'continuable')
  check(
    'recovery is logged',
    app.infos.some((line) => line.includes('valid again')),
  )
}

{
  const racingPath = join(directory, 'racing.yaml')
  await writeFile(racingPath, VALID)
  const app = makeApplyCtx({
    activate: (spec, childId) => ({
      childId,
      messageId: 'message-1',
      result: Promise.resolve({ stopReason: 'completed', output: [] }),
      dispose: async () => {},
    }),
  })
  await apply(app.ctx, { provider: 'spawn', configFile: racingPath })
  const original = app.ctx.llm.resolveCallConfig
  let rewritten = false
  app.ctx.llm.resolveCallConfig = async (callConfig) => {
    if (!rewritten) {
      rewritten = true
      await writeFile(racingPath, VALID.replace('provider-a', 'provider-renamed'))

      await sleep(400)
    }
    return original(callConfig)
  }
  let error
  try {
    await executeTool(app.registered.get('subagent'), {
      route: 'execute',
      description: 'raced',
      prompt: 'raced',
    })
  } catch (failure) {
    error = failure
  }
  check(
    'a policy change during preparation rejects the delegation',
    error instanceof Error && error.message.includes('changed while preparing'),
  )
  check('no child was started for the rejected delegation', app.starts.length === 0)
}

await rm(directory, { recursive: true, force: true })

console.log(
  failures === 0 ? '\ncrew smoke: all checks passed' : `\ncrew smoke: ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
