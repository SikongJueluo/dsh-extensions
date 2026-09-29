/* Runtime smoke test for dsh-auto-continue: wait planners, cancellable
 * sleep, and the recovery owner's three paths — delegate non-owned failures,
 * probe without the planUsage service, and reset-aligned retry with it. */
import { name, inject, Config, apply, planResetWait, planProbeWait, cancellableSleep } from './lib/index.js'

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
check('maxWaitMs default 6h', config.maxWaitMs === 21_600_000)
check('resetMarginMs default 60s', config.resetMarginMs === 60_000)

// ── reset-wait planning ──────────────────────────────────────────────────────
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
check('exhausted 5h waits until reset + margin', plan5h.kind === 'wait' && plan5h.window === 'fiveHour' && plan5h.delayMs === 3600_000 + 60_000)

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
check('non-exhausted snapshot falls back to probing', planFresh.kind === 'wait' && planFresh.window === 'probe')

const noSnapshot = planResetWait(undefined, now, 0, opts)
check('no snapshot probes', noSnapshot.kind === 'wait' && noSnapshot.window === 'probe')

const overdue = planResetWait({ ...exhaustedSnapshot, fiveHour: { percent: 100, resetAt: now - 1000 } }, now, 0, opts)
check('already-reset window retries immediately', overdue.kind === 'wait' && overdue.delayMs === 0)

const budgetExhausted = planResetWait(exhaustedSnapshot, now, opts.maxWaitMs + 1, opts)
check('no budget left gives up', budgetExhausted.kind === 'give-up')

// ── probe planning ───────────────────────────────────────────────────────────
const p0 = planProbeWait(now, 0, 0, opts)
const p1 = planProbeWait(now, p0.kind === 'wait' ? p0.delayMs : 0, 1, opts)
check('probe schedule staged', p0.kind === 'wait' && p0.delayMs === 120_000 && p1.kind === 'wait' && p1.delayMs === 300_000)
const pTight = planProbeWait(now, 4 * 3600_000 + 1, 0, opts)
check('probes tighten after 4h', pTight.kind === 'wait' && pTight.delayMs === 300_000)
const pClip = planProbeWait(now, opts.maxWaitMs - 60_000, 0, opts)
check('final probe clipped to remaining budget', pClip.kind === 'wait' && pClip.delayMs === 60_000)
const pOver = planProbeWait(now, opts.maxWaitMs, 0, opts)
check('probe beyond budget gives up', pOver.kind === 'give-up')

// ── cancellable sleep ────────────────────────────────────────────────────────
const slept = await cancellableSleep(20, new AbortController().signal)
check('sleep completes', slept === true)
const aborted = new AbortController()
aborted.abort()
check('aborted sleep returns false immediately', (await cancellableSleep(1000, aborted.signal)) === false)
const during = new AbortController()
const sleeping = cancellableSleep(60_000, during.signal)
setTimeout(() => during.abort(), 20)
check('abort mid-sleep interrupts', (await sleeping) === false)

// ── recovery flow with stubbed event payload ─────────────────────────────────
function makeCtx(services) {
  const listeners = new Map()
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (serviceName) => services[serviceName],
    on(event, listener) {
      listeners.set(event, listener)
      return () => listeners.delete(event)
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

const events = []
const session = { id: 'sess-1', append: (type, data) => events.push({ type, data }) }
const deliver = (listener, payload) =>
  listener(payload, async () => 'delegated')

// 1) Non-owned code delegates downstream unchanged.
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

// 2) Owned failure without planUsage → staged probe; aborting the turn
//    signal cancels the sleep and leaves the failure terminal.
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('recovery did not settle')), 5000)),
  ])
  check('cancelled probe wait returns undefined (terminal)', action === undefined)
  check('probe retry event recorded before the wait', events.some((e) => e.type === 'llm/retry' && e.data.provider === 'unknown-provider' && e.data.mode === 'always'))
  check('no retry-started after cancellation', !events.some((e) => e.type === 'llm/retry-started'))
}

// 3) Owned failure with a planUsage stub reporting an exhausted 5h window
//    resetting in 80ms (margin 0) → the full happy path: durable retry event,
//    short sleep, retry-started, and { kind: 'retry' } returned.
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
  const retry = events.filter((e) => e.type === 'llm/retry').at(-1)
  const started = events.filter((e) => e.type === 'llm/retry-started').at(-1)
  check('reset-aligned retry event recorded', retry?.data.provider === 'zai-coding-cn' && retry.data.delayMs > 0 && retry.data.delayMs <= 2000)
  check('retry-started recorded after the wait', started !== undefined && started.data.retryId === retry?.data.retryId)
}

// 4) planUsage present but throwing/snapshot-less still degrades to probing.
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
    new Promise((_, reject) => setTimeout(() => reject(new Error('recovery did not settle')), 5000)),
  ])
  check('snapshot-less service degrades to probe', action === undefined)
}

// 5) Disposal drains: the registered effect aborts the lifetime.
await bare.effects[0]()
console.log('disposed OK')

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('smoke OK')
