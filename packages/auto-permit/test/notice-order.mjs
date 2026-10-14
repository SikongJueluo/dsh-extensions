/**
 * Reproduction harness: where does an auto-permit notice land relative to the
 * in-flight tool call?
 *
 * Runs the REAL plugin entry (`apply`) against a REAL `Session`, replaying the
 * exact event order the agent loop produced in the failing session
 * (session-5528dac7: seq 121 assistant(tool-call) -> 123 approval/asked ->
 * 125 user/message notice -> 129 tool/result).
 *
 * No network, no API calls, no writes.
 *
 *   node packages/auto-permit/test/notice-order.mjs
 */
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply } from '../lib/index.js'

const CALL_ID = 'call_00_demo'
const SESSION_ID = 'session-notice-order'
const COMMAND = 'bash /tmp/diag.sh devenv 2>&1 | tail -60'
const TURN = 1
const STEP = 16

/** Walk the surface in model order and report every tool-call that is not
 * immediately followed by the tool result correlating with it. */
function pairingViolations(session) {
  const messages = session.deriveMessages()
  const out = []
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    for (const block of m.content) {
      if (block.type !== 'tool-call') continue
      const next = messages[i + 1]
      if (next === undefined || next.role !== 'tool' || next.toolCallId !== block.id) {
        out.push({
          at: i + 1,
          callId: block.id,
          next: next === undefined ? '<end of history>' : `${next.role}(source=${next.source?.kind ?? '?'})`,
        })
      }
    }
  }
  return out
}

let CALL_SEQ = 0

function seedToolCall(session) {
  session.append('assistant/message', {
    turn: TURN,
    step: STEP,
    message: createAssistantMessage({ content: [{ type: 'tool-call', id: CALL_ID, name: 'bash', arguments: JSON.stringify({ command: COMMAND }) }] }),
    stream: [],
  }, { surfaceOp: 'append' })
  CALL_SEQ = session.append('tool/call', { turn: TURN, step: STEP, callId: CALL_ID, name: 'bash', arguments: JSON.stringify({ command: COMMAND }) }).seq
  session.append('approval/asked', { id: 'apr-1', toolName: 'bash', callId: CALL_ID, reason: 'escalate sandbox to danger-full-access' })
}

/** Minimal host surface the plugin touches: logger, ctx.get, ctx.on. */
function makeContext(sessions) {
  const listeners = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    get: (name) => (name === 'sessions' ? sessions : undefined),
    on: (type, fn) => {
      listeners.set(type, fn)
      return () => listeners.delete(type)
    },
  }
  return { ctx, listeners }
}

/** Volatile row config: the plugin only calls `.get()`. */
function makeConfig() {
  const cell = (v) => ({ get: () => v })
  return {
    enabled: cell(true),
    provider: cell('deepseek-official'),
    model: cell('deepseek-flash'),
    reasoningEffort: cell('high'),
  }
}

async function fireApproval(listeners, session, agent) {
  const listener = listeners.get('approval/request')
  if (listener === undefined) throw new Error('plugin did not register an approval/request answerer')
  const req = {
    agent,
    toolName: 'bash',
    callId: CALL_ID,
    reason: 'escalate sandbox to danger-full-access',
  }
  return listener(req, () => Promise.resolve('unavailable'))
}

async function roundTrip({ deliver }) {
  const session = Session.create(SESSION_ID)
  seedToolCall(session)

  const sessions = { get: (id) => (id === SESSION_ID ? session : undefined) }
  const { ctx, listeners } = makeContext(sessions)

  // Deterministic, judge-free outcome: a cmd-permit allowlist hit settles the
  // request without any model call, so no `llm` service is needed.
  const delivered = []
  const agent = {
    id: SESSION_ID,
    session,
    inject(message) {
      delivered.push(message)
      session.append('agent/inbox/spliced', { target: 'next-step', start: delivered.length - 1, inserted: [message] })
    },
  }
  if (deliver === 'append') {
    // Current plugin behaviour: write the notice onto the surface immediately.
    agent.inject = undefined
  }

  const allowed = { isHighRisk: () => false, claim: () => ({ via: 'demo-allowlist' }) }
  const realGet = ctx.get
  ctx.get = (name) => (name === 'cmdPermit' ? allowed : realGet(name))

  apply(ctx, makeConfig())
  const outcome = await fireApproval(listeners, session, agent)
  if (outcome !== 'allowed-once') throw new Error(`unexpected outcome: ${String(outcome)}`)

  // ...and only NOW does the tool result land, exactly as runGroup does it.
  session.append('tool/result', {
    turn: TURN,
    step: STEP,
    message: createToolResultMessage({ callId: CALL_ID, content: [{ type: 'text', text: '=== mode=devenv ok' }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [CALL_SEQ] })

  if (deliver === 'inject') {
    // The next step boundary claims the inbox batch and only then writes each
    // message onto the surface — ReactLoopAgent.preStep + step()'s
    // `for (const message of decision.messages) this.session.append(...)`.
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: delivered.length, inserted: [] })
    for (const message of delivered) session.append('user/message', message, { surfaceOp: 'append' })
  }

  return { session, outcome, delivered }
}

function eventLine(session) {
  return session.snapshotEvents().map((e) => {
    if (e.type === 'user/message') return `${e.seq}:user/message(${e.data.source.kind}/${e.data.source.form ?? '-'})`
    if (e.type === 'agent/inbox/spliced') return `${e.seq}:inbox/spliced(${e.data.target})`
    return `${e.seq}:${e.type}`
  }).join('  ')
}

async function run(label, deliver) {
  const { session, outcome, delivered } = await roundTrip({ deliver })
  const violations = pairingViolations(session)
  console.log(`--- ${label} ---`)
  console.log('outcome        :', outcome)
  console.log('delivered via  :', deliver === 'append' ? 'session.append (surface)' : `agent.inject (${delivered.length} queued)`)
  console.log('surface nodes  :', session.surface.nodes.join(', '))
  console.log('event log      :', eventLine(session))
  console.log('derived roles  :', session.deriveMessages().map((m) => m.role).join(' -> '))
  console.log('violations     :', violations.length === 0 ? 'none' : JSON.stringify(violations))
  console.log()
  return violations.length === 0
}

console.log('auto-permit notice placement — tool-call/result pairing check')
console.log('(event order replaying session-5528dac7 seq 121..129; no API calls)')
console.log()

// `deliver: 'append'` also strips `Agent.inject`, which is exactly the state a
// host without the deferred channel is in — that is the pre-fix write path.
const okCurrent = await run('PRE-FIX PATH — surface append (no Agent.inject)', 'append')
const okFixed = await run('FIXED PATH — agent.inject()', 'inject')

if (!okCurrent && okFixed) {
  console.log('RESULT: the surface-append path REPRODUCES the violated pairing;')
  console.log('        agent.inject() (what the plugin now uses) restores it.')
  process.exitCode = 0
} else {
  console.log(`RESULT: unexpected — current ok=${String(okCurrent)}, fixed ok=${String(okFixed)}`)
  process.exitCode = 1
}
