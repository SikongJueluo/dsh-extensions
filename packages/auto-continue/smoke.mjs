import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'node:test'
import {
  name,
  inject,
  Config,
  apply,
  planResetWait,
  planProbeWait,
  cancellableSleep,
  registerRecovery,
  registerResume,
  WaitSpool,
  resumeMessage,
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

async function recordDecision(pending, decisions) {
  const decision = await pending
  decisions.push(decision)
  return decision
}

const config = Config({})
console.log('plugin:', name, '| inject:', inject)
check('maxWaitMs default 6h', config.maxWaitMs === 21_600_000)
check('resetMarginMs default 60s', config.resetMarginMs === 60_000)

const now = 1_790_000_000_000
const opts = { maxWaitMs: 6 * 3600_000, resetMarginMs: 60_000 }
const exhaustedSnapshot = {
  provider: 'zai-coding-cn',
  fetchedAt: now,
  source: 'limits',
  fiveHour: { percent: 100, resetAt: now + 3600_000 },
  weekly: { percent: 40, resetAt: now + 10 * 3600_000 },
}
const plan5h = planResetWait(exhaustedSnapshot, now, 0, opts)
check(
  'exhausted 5h waits until reset + margin',
  plan5h.kind === 'wait' && plan5h.window === 'fiveHour' && plan5h.delayMs === 3600_000 + 60_000,
)

const bothExhausted = {
  ...exhaustedSnapshot,
  weekly: { percent: 100, resetAt: now + 10 * 3600_000 },
}
const planWeekly = planResetWait(bothExhausted, now, 0, opts)
check('both exhausted binds the weekly (later) reset', planWeekly.kind === 'give-up')

const freshSnapshot = {
  provider: 'zai-coding-cn',
  fetchedAt: now,
  source: 'limits',
  fiveHour: { percent: 42, resetAt: now + 3600_000 },
  weekly: { percent: 10, resetAt: now + 10 * 3600_000 },
}
const planFresh = planResetWait(freshSnapshot, now, 0, opts)
check(
  'non-exhausted snapshot falls back to probing',
  planFresh.kind === 'wait' && planFresh.window === 'probe',
)

const noSnapshot = planResetWait(undefined, now, 0, opts)
check('no snapshot probes', noSnapshot.kind === 'wait' && noSnapshot.window === 'probe')

const overdue = planResetWait(
  { ...exhaustedSnapshot, fiveHour: { percent: 100, resetAt: now - 1000 } },
  now,
  0,
  opts,
)
check('already-reset window retries immediately', overdue.kind === 'wait' && overdue.delayMs === 0)

const budgetExhausted = planResetWait(exhaustedSnapshot, now, opts.maxWaitMs + 1, opts)
check('no budget left gives up', budgetExhausted.kind === 'give-up')

const p0 = planProbeWait(now, 0, 0, opts)
const p1 = planProbeWait(now, p0.kind === 'wait' ? p0.delayMs : 0, 1, opts)
check(
  'probe schedule staged',
  p0.kind === 'wait' && p0.delayMs === 120_000 && p1.kind === 'wait' && p1.delayMs === 300_000,
)
const pTight = planProbeWait(now, 4 * 3600_000 + 1, 0, opts)
check('probes tighten after 4h', pTight.kind === 'wait' && pTight.delayMs === 300_000)
const pClip = planProbeWait(now, opts.maxWaitMs - 60_000, 0, opts)
check('final probe clipped to remaining budget', pClip.kind === 'wait' && pClip.delayMs === 60_000)
const pOver = planProbeWait(now, opts.maxWaitMs, 0, opts)
check('probe beyond budget gives up', pOver.kind === 'give-up')

const slept = await cancellableSleep(20, new AbortController().signal)
check('sleep completes', slept === true)
const aborted = new AbortController()
aborted.abort()
check(
  'aborted sleep returns false immediately',
  (await cancellableSleep(1000, aborted.signal)) === false,
)
const during = new AbortController()
const sleeping = cancellableSleep(60_000, during.signal)
setTimeout(() => during.abort(), 20)
check('abort mid-sleep interrupts', (await sleeping) === false)

function makeCtx(services) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (serviceName) => services[serviceName],
    on(event, listener, options) {
      const previous = listeners.get(event)
      const combined =
        previous === undefined
          ? listener
          : options?.prepend
            ? (payload, next) => listener(payload, () => previous(payload, next))
            : (payload, next) => previous(payload, () => listener(payload, next))
      listeners.set(event, combined)
      return () => {
        if (listeners.get(event) !== combined) return
        if (previous === undefined) listeners.delete(event)
        else listeners.set(event, previous)
      }
    },
    effect(fn) {
      effects.push(fn)
      return () => {}
    },
    inject(_deps, fn) {
      void fn
    },
  }
  return { ctx, listeners, effects }
}

const settle = (ms = 80) =>
  new Promise((r) => {
    setTimeout(r, ms)
  })

const events = []
const session = { id: 'sess-1', append: (type, data) => events.push({ type, data }) }
const deliver = (listener, payload) => listener(payload, async () => 'delegated')

const bare = makeCtx({})
apply(bare.ctx, config)
let delegated = undefined
delegated = await deliver(bare.listeners.get('agent/request-error'), {
  agent: { session },
  turn: 1,
  step: 1,
  provider: 'zai-coding-cn',
  failure: { code: 'AUTH', message: 'bad key' },
  signal: new AbortController().signal,
})
check('non-owned failure delegates', delegated === 'delegated')
check('no retry event for non-owned failure', events.length === 0)

{
  const wired = makeCtx({})
  apply(wired.ctx, Config({ persist: false, resumeOnRestart: false }))
  const retries = []
  const ctrl = new AbortController()
  const payload = {
    agent: {
      session: {
        id: 'sess-outage',
        append: (type, data) => {
          retries.push({ type, data })
          return { seq: retries.length }
        },
      },
    },
    turn: 1,
    step: 1,
    provider: 'unstable-provider',
    failure: {
      code: 'PI_AI_ERROR',
      message: 'The service is temporarily unavailable. Please retry later.',
    },
    signal: ctrl.signal,
  }
  const listener = wired.listeners.get('agent/request-error')
  const nativeRetry = { kind: 'retry' }
  check(
    'native retry takes precedence',
    (await listener(payload, async () => nativeRetry)) === nativeRetry && retries.length === 0,
  )
  check(
    'unclassified provider errors remain terminal',
    (await listener(
      { ...payload, failure: { code: 'PI_AI_ERROR', message: 'bad credentials' } },
      async () => undefined,
    )) === undefined && retries.length === 0,
  )
  const backoffs = [5000, 15_000, 30_000, 60_000]
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (const [index, delay] of backoffs.entries()) {
      const action = listener(payload, async () => undefined)
      await Promise.resolve()
      const event = retries.at(-1)
      check(
        `outage retry ${index + 1} records the open step and delay`,
        event?.type === 'llm/retry' &&
          event.data.retry === index + 1 &&
          event.data.delayMs === delay &&
          event.data.turn === 1 &&
          event.data.step === 1,
      )
      mock.timers.tick(delay)
      check(`outage retry ${index + 1} returns retry`, (await action)?.kind === 'retry')
    }
    check(
      'outage retry budget is finite',
      (await listener(payload, async () => undefined)) === undefined && retries.length === 8,
    )
    const abortedRetry = listener(
      {
        ...payload,
        step: 2,
        failure: { code: 'SERVER', status: 503, message: 'Service unavailable' },
      },
      async () => undefined,
    )
    await Promise.resolve()
    ctrl.abort()
    check(
      'stopping an outage retry never starts another attempt',
      (await abortedRetry) === undefined && retries.at(-1)?.type === 'llm/retry',
    )
  } finally {
    mock.timers.reset()
  }
  await wired.effects[0]()()
}

{
  const cloudflareMessage = `mdkj-stable API error (502): 502 ${JSON.stringify({
    type: 'https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-502/',
    title: 'Error 502: Bad gateway',
    status: 502,
    detail:
      'The origin web server returned an invalid or incomplete response to Cloudflare. This typically indicates the origin is overloaded or misconfigured.',
    instance: 'a5cd8e89999420dc',
    error_code: 502,
    error_name: 'origin_bad_gateway',
    error_category: 'origin',
    ray_id: 'a5cd8e89999420dc',
    timestamp: '2026-11-19T07:38:44Z',
    zone: 'mdkj.lol',
    cloudflare_error: true,
    retryable: true,
    retry_after: 60,
    owner_action_required: true,
    what_you_should_do:
      '**Wait and retry.** Back off for at least 60 seconds. If the error persists, the website operator should check their origin server health and configuration.',
    footer: 'This error was generated by Cloudflare on behalf of the website owner.',
  })}`
  const wired = makeCtx({})
  const retries = []
  const nativeHints = []
  wired.ctx.on('agent/request-error', async (payload, next) => {
    const hint = payload.failure.providerRetryAfterMs
    nativeHints.push(hint)
    if (hint > 10_000) return next()
    await new Promise((resolve) => {
      setTimeout(resolve, hint ?? 500)
    })
    return { kind: 'retry' }
  })
  apply(wired.ctx, Config({ persist: false, resumeOnRestart: false }))
  const listener = wired.listeners.get('agent/request-error')
  const failure = { code: 'SERVER', message: cloudflareMessage }
  const payload = {
    agent: {
      session: {
        id: 'sess-cloudflare',
        append(type, data) {
          retries.push({ type, data })
          return { seq: retries.length }
        },
      },
    },
    turn: 1,
    step: 1,
    provider: 'mdkj-stable',
    failure,
    signal: new AbortController().signal,
  }
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (let retry = 1; retry <= 4; retry += 1) {
      const decisions = []
      const action = recordDecision(
        listener({ ...payload }, async () => undefined),
        decisions,
      )
      await Promise.resolve()
      check(
        `Cloudflare retry ${retry} passes the 60s hint to native recovery`,
        nativeHints.at(-1) === 60_000 && retries.at(-1)?.data.delayMs === 60_000,
      )
      mock.timers.tick(59_999)
      await Promise.resolve()
      check(`Cloudflare retry ${retry} never starts before 60s`, decisions.length === 0)
      mock.timers.tick(1)
      check(`Cloudflare retry ${retry} resumes at 60s`, (await action)?.kind === 'retry')
    }
    check(
      'body hints keep the four-retry fallback budget and leave the original failure intact',
      (await listener({ ...payload }, async () => undefined)) === undefined &&
        retries.length === 8 &&
        failure.providerRetryAfterMs === undefined,
    )
    const nativeCalls = nativeHints.length
    check(
      'over-budget body hint stops before downstream native recovery',
      (await listener(
        { ...payload, failure: { code: 'SERVER', message: '502 {"retry_after":121}' } },
        async () => undefined,
      )) === undefined && nativeHints.length === nativeCalls,
    )
    const nativeDecisions = []
    const nativeAction = recordDecision(
      listener(
        { ...payload, failure: { code: 'SERVER', message: '502 {"retry_after":3}' } },
        async () => undefined,
      ),
      nativeDecisions,
    )
    mock.timers.tick(2999)
    await Promise.resolve()
    check('native short retry also waits for its JSON body hint', nativeDecisions.length === 0)
    mock.timers.tick(1)
    check(
      'native short retry owns recovery without a fallback event',
      (await nativeAction)?.kind === 'retry' && retries.length === 8,
    )

    const cases = [
      ['no hint', 'Bad gateway', undefined, 5000],
      ['malformed JSON', '502 {"retry_after":60', undefined, 5000],
      ['trailing non-JSON text', '502 {"retry_after":60} extra', undefined, 5000],
      ['text without a JSON body', 'retry_after: 60', undefined, 5000],
      ['negative hint', '502 {"retry_after":-1}', undefined, 5000],
      ['string hint', '502 {"retry_after":"60"}', undefined, 5000],
      ['null hint', '502 {"retry_after":null}', undefined, 5000],
      ['nested non-contract hint', '502 {"error":{"retry_after":60}}', undefined, 5000],
      ['fractional seconds', '502 {"retry_after":60.5}', undefined, 60_500],
      ['non-finite hint', '502 {"retry_after":1e999}', undefined, 5000],
      ['zero hint', '502 {"retry_after":0}', undefined, 5000],
      ['maximum hint', '502 {"retry_after":120}', undefined, 120_000],
      ['over-budget hint', '502 {"retry_after":120.001}', undefined, undefined],
      ['huge finite hint', '502 {"retry_after":1e308}', undefined, undefined],
      ['structured hint precedence', cloudflareMessage, 30_000, 30_000],
      ['larger structured hint', cloudflareMessage, 90_000, 90_000],
      ['over-budget structured hint', cloudflareMessage, 120_001, undefined],
    ]
    for (const [label, message, providerRetryAfterMs, expectedDelay] of cases) {
      const isolated = makeCtx({})
      const recorded = []
      apply(isolated.ctx, Config({ persist: false, resumeOnRestart: false }))
      const action = isolated.listeners.get('agent/request-error')(
        {
          ...payload,
          agent: { session: { id: label, append: (type, data) => recorded.push({ type, data }) } },
          failure: { code: 'SERVER', message, providerRetryAfterMs },
        },
        async () => undefined,
      )
      await Promise.resolve()
      if (expectedDelay === undefined) {
        check(
          `${label} never retries early to fit the budget`,
          (await action) === undefined && recorded.length === 0,
        )
      } else {
        check(
          `${label} selects the expected delay`,
          recorded.at(-1)?.data.delayMs === expectedDelay,
        )
        mock.timers.tick(expectedDelay)
        check(`${label} retries after its delay`, (await action)?.kind === 'retry')
      }
      await isolated.effects[0]()()
    }

    for (const [label, code, retryPolicy] of [
      ['non-transient failure', 'AUTH', undefined],
      ['explicitly disabled retry', 'SERVER', { mode: 'normal', maxRetries: 0 }],
      ['always-owned retry', 'SERVER', { mode: 'always' }],
    ]) {
      const untouched = { code, message: cloudflareMessage }
      const isolated = makeCtx({})
      apply(isolated.ctx, Config({ persist: false, resumeOnRestart: false }))
      const forwarded = { ...payload, failure: untouched, retryPolicy }
      const action = await isolated.listeners.get('agent/request-error')(
        forwarded,
        async () => 'delegated',
      )
      check(
        `${label} keeps its original policy ownership`,
        action === 'delegated' && forwarded.failure === untouched,
      )
      await isolated.effects[0]()()
    }

    const ctrl = new AbortController()
    const cancelled = listener({ ...payload, step: 2, signal: ctrl.signal }, async () => undefined)
    await Promise.resolve()
    ctrl.abort()
    check(
      'cancelling a body-hint wait never starts another attempt',
      (await cancelled) === undefined && retries.at(-1)?.type === 'llm/retry',
    )
  } finally {
    mock.timers.reset()
  }
  await wired.effects[0]()()
}

{
  const ctrl = new AbortController()
  const pending = deliver(bare.listeners.get('agent/request-error'), {
    agent: { session },
    turn: 2,
    step: 1,
    provider: 'unknown-provider',
    failure: { code: 'QUOTA', message: 'The usage limit has been reached' },
    signal: ctrl.signal,
  })
  setTimeout(() => ctrl.abort(), 20)
  const action = await Promise.race([
    pending,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('recovery did not settle')), 5000)
    }),
  ])
  check('cancelled probe wait returns undefined (terminal)', action === undefined)
  check(
    'probe retry event recorded before the wait',
    events.some(
      (e) =>
        e.type === 'llm/retry' &&
        e.data.provider === 'unknown-provider' &&
        e.data.mode === 'always',
    ),
  )
  check('no retry-started after cancellation', !events.some((e) => e.type === 'llm/retry-started'))
}

{
  const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-cr-')), 'p.json') })
  await sp.load()
  const wired = makeCtx({})
  const adopter = registerResume(wired.ctx, { maxWaitMs: 6 * 3600_000 }, sp)
  const stubUsage = { get: async () => undefined }
  const rearmCtx = makeCtx({ planUsage: stubUsage })
  registerRecovery(rearmCtx.ctx, {
    maxWaitMs: 60_000,
    resetMarginMs: 0,
    spool: sp,
    onWaitKept: (entry) => adopter.schedule(entry),
  })
  const sent = []
  const fakeAgent = {
    status: 'idle',
    session: {
      id: 'sess-cr',
      header: {},
      ownEvents: () => [{ seq: 5, type: 'user/message', data: { source: { kind: 'user' } } }],
    },
    followup: (m) => sent.push(m),
  }

  wired.ctx.get = (serviceName) => (serviceName === 'agents' ? { get: () => fakeAgent } : undefined)
  const cancelEvents = []
  const cancelSession = {
    id: 'sess-cr',
    append: (t, d) => {
      cancelEvents.push({ type: t, data: d })
      return { seq: 5 }
    },
  }

  const stubPlan = {
    get: async () => ({
      provider: 'p',
      fetchedAt: Date.now(),
      source: 'limits',
      fiveHour: { percent: 100, resetAt: Date.now() + 120 },
      weekly: { percent: 10, resetAt: Date.now() + 9 * 3600_000 },
    }),
  }
  rearmCtx.ctx.get = (serviceName) => (serviceName === 'planUsage' ? stubPlan : undefined)
  const ctrl = new AbortController()
  const pending = rearmCtx.listeners.get('agent/request-error')(
    {
      agent: { session: cancelSession },
      turn: 1,
      step: 1,
      provider: 'zai-coding-cn',
      failure: { code: 'QUOTA', message: 'x' },
      signal: ctrl.signal,
    },
    async () => undefined,
  )
  await new Promise((r) => {
    setTimeout(r, 40)
  })
  ctrl.abort()
  await pending
  check('aborted wait record kept with future retryAt', sp.get('sess-cr') !== undefined)
  await new Promise((r) => {
    setTimeout(r, 300)
  })
  check(
    're-armed wait resumes in-process after abort',
    sent.length === 1 && sp.get('sess-cr') === undefined,
  )
  await wired.effects[0]()()
  await rearmCtx.effects[0]()()
}

{
  const stubUsage = {
    get: async () => ({
      provider: 'zai-coding-cn',
      fetchedAt: Date.now(),
      source: 'limits',
      fiveHour: { percent: 100, resetAt: Date.now() + 80 },
      weekly: { percent: 30, resetAt: Date.now() + 10 * 3600_000 },
    }),
  }
  const wired = makeCtx({ planUsage: stubUsage })
  apply(wired.ctx, { maxWaitMs: 6 * 3600_000, resetMarginMs: 0 })
  const action = await deliver(wired.listeners.get('agent/request-error'), {
    agent: { session },
    turn: 3,
    step: 1,
    provider: 'zai-coding-cn',
    failure: { code: 'QUOTA', message: 'The usage limit has been reached', status: 429 },
    signal: new AbortController().signal,
  })
  check('reset-aligned wait returns retry', JSON.stringify(action) === '{"kind":"retry"}')
  const retry = events.findLast((e) => e.type === 'llm/retry')
  const started = events.findLast((e) => e.type === 'llm/retry-started')
  check(
    'reset-aligned retry event recorded',
    retry?.data.provider === 'zai-coding-cn' &&
      retry.data.delayMs > 0 &&
      retry.data.delayMs <= 2000,
  )
  check(
    'retry-started recorded after the wait',
    started !== undefined && started.data.retryId === retry?.data.retryId,
  )
}

{
  const throwingUsage = { get: async () => undefined }
  const wired = makeCtx({ planUsage: throwingUsage })
  apply(wired.ctx, { maxWaitMs: 60_000, resetMarginMs: 0 })
  const ctrl = new AbortController()
  const pending = deliver(wired.listeners.get('agent/request-error'), {
    agent: { session },
    turn: 4,
    step: 1,
    provider: 'zai-coding-cn',
    failure: { code: 'RATE_LIMIT', message: 'slow down' },
    signal: ctrl.signal,
  })
  setTimeout(() => ctrl.abort(), 20)
  const action = await Promise.race([
    pending,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('recovery did not settle')), 5000)
    }),
  ])
  check('snapshot-less service degrades to probe', action === undefined)
}

await bare.effects[0]()()
console.log('disposed OK')

const spoolDir = await mkdtemp(join(tmpdir(), 'ac-spool-'))
const spoolPath = join(spoolDir, 'pending.json')
const spool = new WaitSpool({ path: spoolPath })
await spool.load()
const entry = {
  sessionId: 'sess-9',
  provider: 'zai-coding-cn',
  code: 'QUOTA',
  turn: 7,
  lastSeq: 42,
  firstFailureAt: Date.now() - 1000,
  attempts: 2,
  probes: 1,
  retryAt: Date.now() + 1000,
}
await spool.set(entry)
check('spool persists the record', spool.get('sess-9')?.lastSeq === 42)

const reloaded = new WaitSpool({ path: spoolPath })
await reloaded.load()
check(
  'spool roundtrips through disk',
  reloaded.get('sess-9')?.provider === 'zai-coding-cn' && reloaded.get('sess-9')?.attempts === 2,
)

await writeFile(spoolPath, '{not json', 'utf8')
const spoolWarnings = []
const corrupted = new WaitSpool({
  path: spoolPath,
  logger: {
    warn: (format, ...args) => {
      spoolWarnings.push([format, ...args])
    },
  },
})
await corrupted.load()
check('corrupt spool starts empty', corrupted.all().length === 0)
check(
  'corrupt spool is reported',
  spoolWarnings.some(([format]) => String(format).includes('corrupt pending-wait spool')),
)

const stale = new WaitSpool({ path: join(spoolDir, 'stale.json') })
await stale.load()
await stale.set({ ...entry, sessionId: 'old-1', firstFailureAt: Date.now() - 10 * 3600_000 })
await stale.set({ ...entry, sessionId: 'fresh-1', firstFailureAt: Date.now() })
const dropped = await stale.pruneExpired(6 * 3600_000)
check(
  'pruneExpired drops only stale records',
  JSON.stringify(dropped) === '["old-1"]' && stale.get('fresh-1') !== undefined,
)
await rm(spoolDir, { recursive: true, force: true })

{
  const cancelSpool = new WaitSpool({
    path: join(await mkdtemp(join(tmpdir(), 'ac-c-')), 'p.json'),
  })
  await cancelSpool.load()
  const cancelCtx = makeCtx({})
  const cancelConfig = Config({})
  registerRecovery(cancelCtx.ctx, { ...cancelConfig, resetMarginMs: 0, spool: cancelSpool })
  const cancelEvents = []
  const cancelSession = {
    id: 'sess-c',
    append: (t, d) => {
      cancelEvents.push({ type: t, data: d })
      return { seq: 10 }
    },
  }
  const ctrl = new AbortController()
  const pendingCancel = cancelCtx.listeners.get('agent/request-error')(
    {
      agent: { session: cancelSession },
      turn: 1,
      step: 1,
      provider: 'unknown-provider',
      failure: { code: 'QUOTA', message: 'x' },
      signal: ctrl.signal,
    },
    async () => undefined,
  )
  await new Promise((r) => {
    setTimeout(r, 60)
  })
  check('wait record persisted before sleeping', cancelSpool.get('sess-c') !== undefined)
  ctrl.abort()
  await pendingCancel

  check('turn abort keeps the wait record', cancelSpool.get('sess-c') !== undefined)

  const disposeSpool = new WaitSpool({
    path: join(await mkdtemp(join(tmpdir(), 'ac-d-')), 'p.json'),
  })
  await disposeSpool.load()
  const disposeCtx = makeCtx({})
  registerRecovery(disposeCtx.ctx, { ...Config({}), resetMarginMs: 0, spool: disposeSpool })
  const disposeSession = { id: 'sess-d', append: () => ({ seq: 3 }) }
  const pendingDispose = disposeCtx.listeners.get('agent/request-error')(
    {
      agent: { session: disposeSession },
      turn: 1,
      step: 1,
      provider: 'unknown-provider',
      failure: { code: 'QUOTA', message: 'x' },
      signal: new AbortController().signal,
    },
    async () => undefined,
  )
  await new Promise((r) => {
    setTimeout(r, 60)
  })
  check('record in flight before disposal', disposeSpool.get('sess-d') !== undefined)
  await disposeCtx.effects[0]()()
  await pendingDispose
  check(
    'plugin disposal keeps the wait record for adoption',
    disposeSpool.get('sess-d') !== undefined,
  )
}

{
  {
    const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-r1-')), 'p.json') })
    await sp.load()
    await sp.set({ ...entry, sessionId: 'gone-1', firstFailureAt: Date.now() - 10 * 3600_000 })
    const resumeCtx = makeCtx({})
    registerResume(resumeCtx.ctx, { maxWaitMs: 6 * 3600_000 }, sp)
    await settle()
    check('expired wait pruned at boot', sp.get('gone-1') === undefined)
    await resumeCtx.effects[0]()()
  }

  {
    const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-r2-')), 'p.json') })
    await sp.load()
    await sp.set({ ...entry, sessionId: 'sess-r', lastSeq: 50, retryAt: Date.now() - 1 })
    const sent = []
    const fakeAgent = {
      status: 'idle',
      session: {
        id: 'sess-r',
        header: {},
        ownEvents: () => [
          { seq: 49, type: 'user/message', data: { source: { kind: 'user' } } },
          { seq: 50, type: 'llm/retry', data: {} },
          { seq: 51, type: 'turn/end', data: {} },
        ],
      },
      followup: (m) => sent.push(m),
    }
    const resumeCtx = makeCtx({ agents: { get: () => fakeAgent } })
    registerResume(resumeCtx.ctx, { maxWaitMs: 6 * 3600_000 }, sp)
    await settle()
    const expected = resumeMessage({ ...entry, sessionId: 'sess-r' })
    check(
      'resume fires a followup on the idle agent',
      sent.length === 1 && sent[0].content[0].text === expected,
    )
    check(
      'resume message mentions the provider and turn',
      sent[0]?.content?.[0]?.text?.includes('zai-coding-cn') === true &&
        sent[0]?.content?.[0]?.text?.includes('turn 7') === true,
    )
    check('record consumed after firing', sp.get('sess-r') === undefined)
    await resumeCtx.effects[0]()()
  }

  {
    const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-r3-')), 'p.json') })
    await sp.load()
    await sp.set({ ...entry, sessionId: 'sess-u', lastSeq: 50, retryAt: Date.now() - 1 })
    const sent = []
    const busyAgent = {
      status: 'idle',
      session: {
        id: 'sess-u',
        header: {},
        ownEvents: () => [{ seq: 55, type: 'user/message', data: { source: { kind: 'user' } } }],
      },
      followup: (m) => sent.push(m),
    }
    const resumeCtx = makeCtx({ agents: { get: () => busyAgent } })
    registerResume(resumeCtx.ctx, { maxWaitMs: 6 * 3600_000 }, sp)
    await settle()
    check(
      'user-moved-on record dropped without firing',
      sent.length === 0 && sp.get('sess-u') === undefined,
    )
    await resumeCtx.effects[0]()()
  }

  {
    const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-r4-')), 'p.json') })
    await sp.load()
    await sp.set({ ...entry, sessionId: 'sess-k', lastSeq: 12, retryAt: Date.now() - 1 })
    const sent = []
    const coldAgent = {
      status: 'idle',
      session: {
        id: 'sess-k',
        header: {},
        ownEvents: () => [{ seq: 12, type: 'llm/retry', data: {} }],
      },
      followup: (m) => sent.push(m),
    }
    const resumeCtx = makeCtx({})
    resumeCtx.ctx.get = (serviceName) =>
      serviceName === 'sessionController'
        ? { resolveAgent: async () => ({ agent: coldAgent }) }
        : undefined
    registerResume(resumeCtx.ctx, { maxWaitMs: 6 * 3600_000 }, sp)
    await settle()
    check(
      'cold-open via sessionController fires the resume',
      sent.length === 1 && sp.get('sess-k') === undefined,
    )
    await resumeCtx.effects[0]()()
  }
}

{
  const noticeEvents = []
  const noticeAgent = {
    status: 'idle',
    session: {
      id: 'sess-n',
      ownEvents: () => [],
      append: (type, data) => {
        noticeEvents.push({ type, data })
        return { seq: 60 }
      },
    },
    followup: () => {},
  }
  const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-n-')), 'p.json') })
  await sp.load()
  await sp.set({ ...entry, sessionId: 'sess-n', lastSeq: 50, retryAt: Date.now() + 3_600_000 })
  const createdListeners = []
  const noticeCtx = {
    logger: { info() {}, warn() {} },
    get: (serviceName) => (serviceName === 'agents' ? { get: () => noticeAgent } : undefined),
    on: (e, l) => {
      createdListeners.push([e, l])
      return () => {}
    },
    effect: () => () => {},
    inject: () => {},
  }
  const handle = registerResume(noticeCtx, { maxWaitMs: 6 * 3600_000 }, sp)
  await settle(120)

  check(
    'adoption appends a collapsed notice row',
    noticeEvents.some(
      (e) =>
        e.type === 'user/message' &&
        e.data?.source?.form === 'notice' &&
        String(e.data?.source?.summary ?? '').includes('auto-continue'),
    ),
  )
  for (const [event, listener] of createdListeners) {
    if (event === 'agent/created') listener({ agent: noticeAgent })
  }
  check(
    'adoption notice appended exactly once',
    noticeEvents.filter((e) => e.type === 'user/message').length === 1,
  )
  check(
    'adoption never appends llm/retry outside a live step',
    noticeEvents.every((e) => e.type !== 'llm/retry'),
  )

  check(
    'cancel drops the pending record',
    (await handle.cancel('sess-n')) === true && sp.get('sess-n') === undefined,
  )
  check('cancel of nothing reports false', (await handle.cancel('sess-n')) === false)

  await settle(50)
  check('cancelled timer never sends a followup', noticeAgent.followupCalls === undefined)
}

{
  const cancelSpool = new WaitSpool({
    path: join(await mkdtemp(join(tmpdir(), 'ac-w-')), 'p.json'),
  })
  await cancelSpool.load()
  const cancelled = new Set()
  const wakeEvents = []
  const cancelSession = {
    id: 'sess-w',
    append: (t, d) => {
      wakeEvents.push({ type: t, data: d })
      return { seq: 9 }
    },
  }
  const wakeCtx = makeCtx({
    planUsage: {
      get: async () => ({
        provider: 'p',
        fetchedAt: Date.now(),
        source: 'limits',
        fiveHour: { percent: 100, resetAt: Date.now() + 150 },
        weekly: { percent: 10, resetAt: Date.now() + 9 * 3600_000 },
      }),
    },
  })
  registerRecovery(wakeCtx.ctx, {
    maxWaitMs: 60_000,
    resetMarginMs: 0,
    spool: cancelSpool,
    cancelled,
  })
  const pendingWake = wakeCtx.listeners.get('agent/request-error')(
    {
      agent: { session: cancelSession },
      turn: 1,
      step: 1,
      provider: 'zai-coding-cn',
      failure: { code: 'QUOTA', message: 'x' },
      signal: new AbortController().signal,
    },
    async () => undefined,
  )
  await new Promise((r) => {
    setTimeout(r, 40)
  })
  check('wait armed before cancel', cancelSpool.get('sess-w') !== undefined)
  cancelled.add('sess-w')
  await cancelSpool.delete('sess-w')
  const action = await pendingWake
  await new Promise((r) => {
    setTimeout(r, 60)
  })
  check('cancelled recovery returns terminal without retry', action === undefined)
  check(
    'cancelled recovery records no retry-started',
    !wakeEvents.some((e) => e.type === 'llm/retry-started'),
  )
}

const mirrorSession = (id) => ({ id, header: {} })
const turnEvent = (type, turn, reason) => ({ type, time: Date.now(), data: { turn, reason } })
const stopped = (kind) => ({ kind: 'aborted', reason: { kind } })

{
  const { registerRestartResume } = await import('./lib/index.js')
  const mirrorPath = join(await mkdtemp(join(tmpdir(), 'ac-rr-')), 'running.json')
  const options = {
    mirrorPath,
    settleMs: 0,
    staggerMs: 0,
    controllerWaitMs: 10,
    controllerPollMs: 2,
  }
  const settings = { resumeOnRestart: true, resumeMaxAgeMs: 12 * 3600_000 }
  const readMirror = async () => JSON.parse(await readFile(mirrorPath, 'utf8')).entries
  const shutdown = makeCtx({})
  registerRestartResume(shutdown.ctx, settings, options)
  const record = shutdown.listeners.get('session/event')
  for (const id of ['graceful', 'manual', 'crash', 'completed', 'archived', 'quota', 'new-input']) {
    record(mirrorSession(id), turnEvent('turn/start', 1))
  }
  record(mirrorSession('graceful'), turnEvent('turn/end', 1, stopped('disposed')))
  record(mirrorSession('manual'), turnEvent('turn/end', 1, stopped('user')))
  record({ id: 'child', header: { origin: 'subagent' } }, turnEvent('turn/start', 1))
  await shutdown.effects[0]()()
  const saved = await readMirror()
  check(
    'graceful shutdown keeps the interrupted turn',
    saved.some((e) => e.sessionId === 'graceful' && e.turn === 1),
  )
  check(
    'mirror excludes explicit cancellation and subagents',
    !saved.some((e) => ['manual', 'child'].includes(e.sessionId)),
  )

  const sp = new WaitSpool({ path: join(mirrorPath, '..', 'pending.json') })
  await sp.load()
  await sp.set({ ...entry, sessionId: 'quota' })
  const sent = []
  const opened = []
  const boot = makeCtx({
    workspaceRegistry: { archivedSessionIds: ['archived'] },
    sessionController: {
      async resolveAgent(id) {
        opened.push(id)
        const reason =
          id === 'graceful'
            ? stopped('disposed')
            : { kind: id === 'completed' ? 'completed' : 'interrupted' }
        const log = [turnEvent('turn/end', 1, reason)]
        if (id === 'new-input')
          log.push({ type: 'user/message', data: { source: { kind: 'user' } } })
        return {
          agent: {
            status: 'idle',
            session: { ...mirrorSession(id), ownEvents: () => log },
            followup(message) {
              sent.push({ id, message })
              boot.listeners.get('session/event')(mirrorSession(id), turnEvent('turn/start', 2))
            },
          },
        }
      },
    },
  })
  registerRestartResume(boot.ctx, settings, { ...options, spool: sp })
  await settle(150)
  await boot.effects[0]()()
  check(
    'public cold resolver recovers graceful and hard shutdown',
    sent.map((item) => item.id).join(',') === 'graceful,crash',
  )
  check(
    'follow-up tells the agent to verify uncertain tool outcomes',
    sent.every(({ message }) => message.content[0].text.includes('marked unknown')),
  )
  check(
    'archived and quota-owned sessions are not cold-opened by the mirror',
    !opened.includes('archived') && !opened.includes('quota'),
  )
  const active = await readMirror()
  check(
    'boot keeps new turns for a second restart',
    active.length === 2 && active.every((e) => e.turn === 2),
  )

  const noController = makeCtx({})
  registerRestartResume(noController.ctx, settings, options)
  await settle(45)
  await noController.effects[0]()()
  check('controller-absent boot keeps the mirror for retry', (await readMirror()).length === 2)

  const disabled = makeCtx({})
  registerRestartResume(disabled.ctx, { ...settings, resumeOnRestart: false }, options)
  check(
    'resumeOnRestart=false does not track or adopt',
    disabled.listeners.size === 0 && disabled.effects.length === 0,
  )
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('smoke OK')

process.exit(0)
