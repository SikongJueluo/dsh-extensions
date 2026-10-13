/* Runtime smoke test for dsh-crew: tier-route selection with its fallback
 * ladder (route preflight failure, exhausted coding-plan window, no usable
 * fallback), and the delegation path end to end against stub services —
 * asserting the agentOptions the subagent provider actually receives. */
import { name, inject, Config, apply, fallbackTarget, anyWindowExhausted, callConfigOf, routeName, selectTierRoute } from './lib/index.js'

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
check(
  'quick pinned to opencode-go/deepseek-v4.1-flash@max',
  config.quick.provider === 'opencode-go' && config.quick.model === 'deepseek-v4.1-flash' && config.quick.reasoningEffort === 'max',
)
check(
  'quick falls back to deepseek-official/deepseek-flash@max',
  fallbackTarget(config.quick)?.provider === 'deepseek-official' &&
    fallbackTarget(config.quick)?.model === 'deepseek-flash' &&
    fallbackTarget(config.quick)?.reasoningEffort === 'max',
)
check('workhorse/smart name no fallback', fallbackTarget(config.workhorse) === undefined && fallbackTarget(config.smart) === undefined)
check(
  'workhorse and smart routes unchanged',
  routeName(config.workhorse) === 'zai-coding-cn/glm-5.3' && routeName(config.smart) === 'openai-codex/gpt-6.1-sol',
)

// ── window exhaustion ────────────────────────────────────────────────────────
const now = 1_790_000_000_000
check('no snapshot is not exhausted', anyWindowExhausted(undefined, now) === false)
check('below-limit windows are not exhausted', anyWindowExhausted({ fiveHour: { percent: 99.5, resetAt: now + 1000 }, weekly: { percent: 10 } }, now) === false)
check('100% with a future reset is exhausted', anyWindowExhausted({ fiveHour: { percent: 100, resetAt: now + 1000 } }, now) === true)
check('already-reset window is not exhausted', anyWindowExhausted({ weekly: { percent: 100, resetAt: now - 1000 } }, now) === false)
check('percent without a reset counts as exhausted', anyWindowExhausted({ monthly: { percent: 100 } }, now) === true)
check('the monthly MCP window is considered too', anyWindowExhausted({ monthlyMcp: { percent: 100, resetAt: now + 1 } }, now) === true)

// ── call config shaping ──────────────────────────────────────────────────────
const withEffort = callConfigOf({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' })
check('callConfigOf carries the pinned route and effort', withEffort.provider === 'opencode-go' && withEffort.reasoningEffort === 'max')
check('an empty effort is omitted', callConfigOf({ provider: 'p', model: 'm', reasoningEffort: '' }).reasoningEffort === undefined)

// ── route selection matrix ───────────────────────────────────────────────────
function makeSelectionCtx({ failFor = [], plan, planThrows = false } = {}) {
  const warnings = []
  const calls = []
  const ctx = {
    llm: {
      async resolveCallConfig(callConfig) {
        calls.push(routeName(callConfig))
        if (failFor.includes(callConfig.provider)) throw new Error(`llm: provider route "${callConfig.provider}" is not registered`)
        return callConfig
      },
    },
    logger: { warn: (message, ...args) => warnings.push([message, ...args].join(' ')) },
    get: (serviceName) => (serviceName === 'planUsage' && (plan !== undefined || planThrows)
      ? { get: async () => { if (planThrows) throw new Error('quota backend down'); return plan } }
      : undefined),
  }
  return { ctx, warnings, calls }
}

const tier = config.quick
const healthy = makeSelectionCtx()
const healthyPick = await selectTierRoute(healthy.ctx, tier, new AbortController().signal)
check('healthy primary needs no fallback', healthyPick.target.provider === 'opencode-go' && healthyPick.notice === undefined)
check('healthy primary preflights exactly its own route', healthy.calls.length === 1 && healthy.calls[0] === 'opencode-go/deepseek-v4.1-flash')

const unavailable = makeSelectionCtx({ failFor: ['opencode-go'] })
const fallbackPick = await selectTierRoute(unavailable.ctx, tier, new AbortController().signal)
check('unavailable primary falls back', fallbackPick.target.provider === 'deepseek-official' && fallbackPick.target.model === 'deepseek-flash')
check('fallback is preflighted before use', unavailable.calls.join(',') === 'opencode-go/deepseek-v4.1-flash,deepseek-official/deepseek-flash')
check('fallback is announced and logged', (fallbackPick.notice ?? '').includes('deepseek-official/deepseek-flash') && unavailable.warnings.length === 1)
check('notice names the cause', (fallbackPick.notice ?? '').includes('route unavailable'))

const exhaustedPlan = makeSelectionCtx({ plan: { fiveHour: { percent: 100, resetAt: Date.now() + 3600_000 }, weekly: { percent: 12 } } })
const exhaustedPick = await selectTierRoute(exhaustedPlan.ctx, tier, new AbortController().signal)
check('exhausted plan window falls back', exhaustedPick.target.provider === 'deepseek-official')
check('exhaustion notice names the window condition', (exhaustedPick.notice ?? '').includes('coding-plan window exhausted'))

const freshPlan = makeSelectionCtx({ plan: { fiveHour: { percent: 40, resetAt: Date.now() + 3600_000 } } })
check('a live plan window stays on the primary', (await selectTierRoute(freshPlan.ctx, tier, new AbortController().signal)).target.provider === 'opencode-go')
const brokenPlan = makeSelectionCtx({ planThrows: true })
check('a failing planUsage read stays on the primary', (await selectTierRoute(brokenPlan.ctx, tier, new AbortController().signal)).target.provider === 'opencode-go')

{
  // A cold quota cache can hit the upstream API; the routing hint must not
  // delay the delegation behind it.
  const hangingCtx = {
    llm: { resolveCallConfig: async (callConfig) => callConfig },
    logger: { warn() {} },
    get: () => ({ get: () => new Promise(() => {}) }),
  }
  const startedAt = Date.now()
  const picked = await selectTierRoute(hangingCtx, tier, new AbortController().signal)
  const elapsed = Date.now() - startedAt
  check('a hanging planUsage read falls through to the primary', picked.target.provider === 'opencode-go' && picked.notice === undefined)
  check('the quota read budget bounds the wait', elapsed >= 1900 && elapsed < 4000)
}

const noFallbackTier = { ...config.workhorse }
let noFallbackError
try {
  await selectTierRoute(makeSelectionCtx({ failFor: ['zai-coding-cn'] }).ctx, noFallbackTier, new AbortController().signal)
} catch (error) {
  noFallbackError = error
}
check('a tier without a fallback still fails loud', noFallbackError instanceof Error && noFallbackError.message.includes('not registered'))

const bothDown = makeSelectionCtx({ failFor: ['opencode-go', 'deepseek-official'] })
let bothDownError
try {
  await selectTierRoute(bothDown.ctx, tier, new AbortController().signal)
} catch (error) {
  bothDownError = error
}
check(
  'both routes down reports both',
  bothDownError instanceof Error &&
    bothDownError.message.includes('opencode-go/deepseek-v4.1-flash') &&
    bothDownError.message.includes('deepseek-official/deepseek-flash'),
)

const aborted = new AbortController()
aborted.abort()
const cancelled = makeSelectionCtx({ failFor: ['opencode-go'] })
let abortError
try {
  await selectTierRoute(cancelled.ctx, tier, aborted.signal)
} catch (error) {
  abortError = error
}
check('an aborted delegation never degrades to the fallback', abortError instanceof Error && cancelled.calls.length === 1)

// ── delegation path against stub services ────────────────────────────────────
/** Minimal Cordis-shaped context covering exactly what crew's apply() touches. */
function makeApplyCtx({ plan, failFor = [] } = {}) {
  const registered = new Map()
  const warnings = []
  const starts = []
  const provider = {
    name: 'spawn',
    capabilities: { agentOptions: true },
    prepareContinuable: () => {},
  }
  const ctx = {
    logger: { info() {}, warn: (message, ...args) => warnings.push([message, ...args].join(' ')) },
    get: (serviceName) => (serviceName === 'planUsage' && plan !== undefined ? { get: async () => plan } : undefined),
    on: () => () => {},
    effect: () => () => {},
    inject: (_deps, fn) => void fn,
    llm: {
      async resolveCallConfig(callConfig) {
        if (failFor.includes(callConfig.provider)) throw new Error(`llm: provider route "${callConfig.provider}" is not registered`)
        return callConfig
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
      startContinuable: async (request) => {
        // The provider receives the start envelope; the child's own request
        // (prompt + parent + agentOptions) sits inside it.
        starts.push(request.request)
        return { childId: `child-${starts.length}` }
      },
      start: async (_providerName, request) => {
        starts.push(request)
        return {
          id: 'run-1',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'child answer' }] }),
          dispose: () => {},
        }
      },
    },
    systemPrompt: { getSectionOrder: () => 0, section: () => () => {} },
  }
  return { ctx, registered, warnings, starts }
}

const exec = { agent: { id: 'parent' }, signal: new AbortController().signal }
const delegationArgs = { description: 'two word label', prompt: 'do the thing' }

{
  const wired = makeApplyCtx()
  apply(wired.ctx, config)
  check('all four tools register', ['subagent_quick', 'subagent', 'subagent_smart', 'create_agent'].every((toolName) => wired.registered.has(toolName)))
  const value = await wired.registered.get('subagent_quick').execute(delegationArgs, exec)
  check('healthy quick delegates on opencode-go', value.kind === 'continuable' && wired.starts[0].agentOptions.provider === 'opencode-go')
  check('healthy quick records no notice', value.notice === undefined)
  check('the child inherits the pinned effort', wired.starts[0].agentOptions.reasoningEffort === 'max')
}

{
  const wired = makeApplyCtx({ plan: { fiveHour: { percent: 100, resetAt: Date.now() + 3600_000 } } })
  apply(wired.ctx, config)
  const value = await wired.registered.get('subagent_quick').execute(delegationArgs, exec)
  check('an exhausted Go window delegates on deepseek-official', value.kind === 'continuable' && wired.starts[0].agentOptions.provider === 'deepseek-official')
  check('the notice reaches the tool output', typeof value.notice === 'string' && value.notice.includes('deepseek-official/deepseek-flash'))
  check('the fallback is logged', wired.warnings.some((line) => line.includes('coding-plan window exhausted')))
  const rendered = wired.registered.get('subagent_quick').output.render(delegationArgs, value)
  check('the rendered text carries the notice', rendered[0].text.includes('[crew]') && rendered[0].text.includes('deepseek-official/deepseek-flash'))
}

{
  const wired = makeApplyCtx({ failFor: ['opencode-go'] })
  apply(wired.ctx, config)
  const value = await wired.registered.get('create_agent').execute({ description: 'role agent', role: 'reviewer' }, exec)
  check('create_agent follows the same ladder', value.kind === 'created' && wired.starts[0].agentOptions.provider === 'deepseek-official')
}

{
  const wired = makeApplyCtx({ failFor: ['opencode-go'] })
  apply(wired.ctx, config)
  const value = await wired.registered.get('subagent_quick').execute({ ...delegationArgs, run_in_background: false }, exec)
  check('a foreground fallback settles the child run', value.kind === 'foreground' && value.runId === 'run-1')
  check('the foreground child ran on the fallback', wired.starts[0].agentOptions.provider === 'deepseek-official')
  const rendered = wired.registered.get('subagent_quick').output.render(delegationArgs, value)
  check('the foreground render keeps the child text and appends the notice', rendered[0].text.includes('child answer') && rendered[0].text.includes('[crew]'))
}

console.log(failures === 0 ? '\nall crew smoke checks passed' : `\n${failures} crew smoke check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
