/* Runtime smoke test for dsh-auto-continue: wait planners, cancellable
 * sleep, and the recovery owner's three paths — delegate non-owned failures,
 * probe without the planUsage service, and reset-aligned retry with it. */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { name, inject, Config, apply, planResetWait, planProbeWait, cancellableSleep, registerRecovery, registerResume } from './lib/index.js'
import { WaitSpool, resumeMessage } from './lib/index.js'

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
// (ctx.effect(fn) contract: fn() returns the disposer; invoke that.)
await bare.effects[0]()()
console.log('disposed OK')

// ── spool roundtrip ──────────────────────────────────────────────────────────
const spoolDir = await mkdtemp(join(tmpdir(), 'ac-spool-'))
const spoolPath = join(spoolDir, 'pending.json')
const spool = new WaitSpool({ path: spoolPath })
await spool.load()
const entry = {
  sessionId: 'sess-9', provider: 'zai-coding-cn', code: 'QUOTA', turn: 7, lastSeq: 42,
  firstFailureAt: Date.now() - 1000, attempts: 2, probes: 1, retryAt: Date.now() + 1000,
}
await spool.set(entry)
check('spool persists the record', spool.get('sess-9')?.lastSeq === 42)

const reloaded = new WaitSpool({ path: spoolPath })
await reloaded.load()
check('spool roundtrips through disk', reloaded.get('sess-9')?.provider === 'zai-coding-cn' && reloaded.get('sess-9')?.attempts === 2)

await writeFile(spoolPath, '{not json', 'utf8')
const corrupted = new WaitSpool({ path: spoolPath })
await corrupted.load()
check('corrupt spool starts empty', corrupted.all().length === 0)

const stale = new WaitSpool({ path: join(spoolDir, 'stale.json') })
await stale.load()
await stale.set({ ...entry, sessionId: 'old-1', firstFailureAt: Date.now() - 10 * 3600_000 })
await stale.set({ ...entry, sessionId: 'fresh-1', firstFailureAt: Date.now() })
const dropped = await stale.pruneExpired(6 * 3600_000)
check('pruneExpired drops only stale records', JSON.stringify(dropped) === '["old-1"]' && stale.get('fresh-1') !== undefined)
await rm(spoolDir, { recursive: true, force: true })

// ── recovery × spool: user cancel deletes, plugin disposal keeps ─────────────
{
  // user-cancel path: abort the turn signal → record removed
  const cancelSpool = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-c-')), 'p.json') })
  await cancelSpool.load()
  const cancelCtx = makeCtx({})
  const cancelConfig = Config({})
  registerRecovery(cancelCtx.ctx, { ...cancelConfig, resetMarginMs: 0, spool: cancelSpool })
  const cancelEvents = []
  const cancelSession = { id: 'sess-c', append: (t, d) => { cancelEvents.push({ type: t, data: d }); return { seq: 10 } } }
  const ctrl = new AbortController()
  const pendingCancel = cancelCtx.listeners.get('agent/request-error')(
    { agent: { session: cancelSession }, turn: 1, step: 1, provider: 'unknown-provider', failure: { code: 'QUOTA', message: 'x' }, signal: ctrl.signal },
    async () => undefined,
  )
  await new Promise((r) => setTimeout(r, 60))
  check('wait record persisted before sleeping', cancelSpool.get('sess-c') !== undefined)
  ctrl.abort()
  await pendingCancel
  check('user cancellation deletes the wait record', cancelSpool.get('sess-c') === undefined)

  // disposal path: abort lifetime via the effect → record kept
  const disposeSpool = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-d-')), 'p.json') })
  await disposeSpool.load()
  const disposeCtx = makeCtx({})
  registerRecovery(disposeCtx.ctx, { ...Config({}), resetMarginMs: 0, spool: disposeSpool })
  const disposeSession = { id: 'sess-d', append: () => ({ seq: 3 }) }
  const pendingDispose = disposeCtx.listeners.get('agent/request-error')(
    { agent: { session: disposeSession }, turn: 1, step: 1, provider: 'unknown-provider', failure: { code: 'QUOTA', message: 'x' }, signal: new AbortController().signal },
    async () => undefined,
  )
  await new Promise((r) => setTimeout(r, 60))
  check('record in flight before disposal', disposeSpool.get('sess-d') !== undefined)
  await disposeCtx.effects[0]()()
  await pendingDispose
  check('plugin disposal keeps the wait record for adoption', disposeSpool.get('sess-d') !== undefined)
}

// ── resume adopter ───────────────────────────────────────────────────────────
{
  const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms))

  // expired record is pruned at boot
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

  // live idle agent + no newer user activity → followup fires, record consumed
  {
    const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-r2-')), 'p.json') })
    await sp.load()
    await sp.set({ ...entry, sessionId: 'sess-r', lastSeq: 50, retryAt: Date.now() - 1 })
    const sent = []
    const fakeAgent = {
      status: 'idle',
      session: { id: 'sess-r', ownEvents: () => [
        { seq: 49, type: 'user/message', data: { source: { kind: 'user' } } },
        { seq: 50, type: 'llm/retry', data: {} },
        { seq: 51, type: 'turn/end', data: {} },
      ] },
      followup: (m) => sent.push(m),
    }
    const resumeCtx = makeCtx({ agents: { get: () => fakeAgent } })
    registerResume(resumeCtx.ctx, { maxWaitMs: 6 * 3600_000 }, sp)
    await settle()
    const expected = resumeMessage({ ...entry, sessionId: 'sess-r' })
    check('resume fires a followup on the idle agent', sent.length === 1 && sent[0].content[0].text === expected)
    check('resume message mentions the provider and turn', sent[0]?.content?.[0]?.text?.includes('zai-coding-cn') === true && sent[0]?.content?.[0]?.text?.includes('turn 7') === true)
    check('record consumed after firing', sp.get('sess-r') === undefined)
    await resumeCtx.effects[0]()()
  }

  // newer user activity → stand down without firing
  {
    const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-r3-')), 'p.json') })
    await sp.load()
    await sp.set({ ...entry, sessionId: 'sess-u', lastSeq: 50, retryAt: Date.now() - 1 })
    const sent = []
    const busyAgent = {
      status: 'idle',
      session: { id: 'sess-u', ownEvents: () => [
        { seq: 55, type: 'user/message', data: { source: { kind: 'user' } } },
      ] },
      followup: (m) => sent.push(m),
    }
    const resumeCtx = makeCtx({ agents: { get: () => busyAgent } })
    registerResume(resumeCtx.ctx, { maxWaitMs: 6 * 3600_000 }, sp)
    await settle()
    check('user-moved-on record dropped without firing', sent.length === 0 && sp.get('sess-u') === undefined)
    await resumeCtx.effects[0]()()
  }

  // cold-open through sessionController when no live agent exists
  {
    const sp = new WaitSpool({ path: join(await mkdtemp(join(tmpdir(), 'ac-r4-')), 'p.json') })
    await sp.load()
    await sp.set({ ...entry, sessionId: 'sess-k', lastSeq: 12, retryAt: Date.now() - 1 })
    const sent = []
    const coldAgent = {
      status: 'idle',
      session: { id: 'sess-k', ownEvents: () => [{ seq: 12, type: 'llm/retry', data: {} }] },
      followup: (m) => sent.push(m),
    }
    const resumeCtx = makeCtx({})
    resumeCtx.ctx.get = (name) => name === 'sessionController'
      ? { agents: { resolveAgent: async () => ({ agent: coldAgent }) } }
      : undefined
    registerResume(resumeCtx.ctx, { maxWaitMs: 6 * 3600_000 }, sp)
    await settle()
    check('cold-open via sessionController fires the resume', sent.length === 1 && sp.get('sess-k') === undefined)
    await resumeCtx.effects[0]()()
  }
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('smoke OK')
