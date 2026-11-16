/**
 * Approval-listener integration tests: drive the REAL `approval/request`
 * listener `apply()` registers (fake host surface, fake judge route) and
 * assert the full decision order — high-risk → allowlist → memory → judge —
 * works for a bash sub-call dispatched through PTC, whose only audit trail
 * at approval time is `tool/ptc-dispatch-start`.
 *
 * @module dsh-auto-permit/approval.test
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context, Volatile, VolatileSnapshot } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { apply } from '../src/index.js'
import type { Config } from '../src/index.js'
import { MAX_COMMAND_CHARS } from '../src/evidence.js'

const vol = <T>(value: T): Volatile<T> => ({ get: () => value as VolatileSnapshot<T> })

/** A real directory: mutable-file commands need a readable inspector. */
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsh-auto-permit-approval-'))

afterAll(() => {
  rmSync(WORKSPACE, { recursive: true, force: true })
})

interface Fixture {
  events: { type: string; data: unknown }[]
  injected: {
    source?: { kind?: string; summary?: string }
    content?: { type: string; text?: string }[]
  }[]
  appended: unknown[]
  llmCalls: { messages: { content: { type: string; text?: string }[] }[] }[]
  answer(
    callId: string,
    toolName?: string,
    chainOutcome?: ApprovalOutcome,
  ): Promise<{ outcome: ApprovalOutcome; fellThrough: boolean }>
  /** Queue the fake judge's next verdict texts (consumed one per call). */
  judgeVerdicts(verdicts: string[]): void
}

function makeFixture(
  cmdPermit?: unknown,
  options: { verdicts?: string[]; workspace?: string; workingDirectory?: string } = {},
): Fixture {
  const listeners: {
    type: string
    fn: (...args: unknown[]) => Promise<ApprovalOutcome>
    prepend: boolean
  }[] = []
  const events: { type: string; data: unknown }[] = []
  const injected: unknown[] = []
  const appended: unknown[] = []
  const llmCalls: unknown[] = []
  const verdictQueue: string[] = [...(options.verdicts ?? [])]
  const session = {
    id: 'sess-1',
    snapshotEvents: () => [...events],
    ...(options.workspace === undefined ? {} : { header: { cwd: options.workspace } }),
    append: (type: string, data: unknown, opts: unknown) => {
      appended.push({ type, data, opts })
    },
  }
  const agent = { id: 'agent-1', session, inject: (message: unknown) => injected.push(message) }
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (name: string) => {
      if (name === 'cmdPermit') return cmdPermit
      if (name === 'workingDirectory' && options.workingDirectory !== undefined) {
        return { get: () => options.workingDirectory }
      }
      return undefined
    },
    on: (type: string, fn: (...args: unknown[]) => Promise<ApprovalOutcome>, prepend = false) => {
      listeners.push({ type, fn, prepend })
      return () => {}
    },
    llm: {
      stream: (request: unknown) => {
        llmCalls.push(request)
        const verdict = verdictQueue.shift()
        return (async function* () {
          if (verdict !== undefined) yield { type: 'text-delta', index: 0, text: verdict }
        })()
      },
    },
  }
  apply(
    ctx as unknown as Context,
    {
      enabled: vol(true),
      provider: vol('test-provider'),
      model: vol('test-model'),
    } as Config,
  )
  const answer = (
    callId: string,
    toolName = 'bash',
    chainOutcome: ApprovalOutcome = 'rejected',
  ) => {
    const entry = listeners.find((item) => item.type === 'approval/request')
    if (entry === undefined) throw new Error('no approval/request listener registered')
    let fellThrough = false
    const outcome = entry.fn({ agent, toolName, callId, signal: undefined }, async () => {
      fellThrough = true
      return chainOutcome
    })
    return outcome.then((value) => ({ outcome: value, fellThrough }))
  }
  return {
    events,
    injected: injected as Fixture['injected'],
    appended,
    llmCalls: llmCalls as Fixture['llmCalls'],
    answer,
    judgeVerdicts: (verdicts: string[]) => {
      verdictQueue.push(...verdicts)
    },
  }
}

/** A PTC sub bash call exactly as the host logs it before scheduling. */
function ptcBash(fixture: Fixture, subCallId: string, args: Record<string, unknown>): void {
  fixture.events.push({
    type: 'tool/ptc-dispatch-start',
    data: { rootCallId: 'root', parentCallId: 'root', subCallId, name: 'bash', arguments: args },
  })
}

/** A direct top-level bash call, arguments as the JSON string the host logs. */
function directBash(fixture: Fixture, callId: string, args: Record<string, unknown>): void {
  fixture.events.push({
    type: 'tool/call',
    data: { callId, name: 'bash', arguments: JSON.stringify(args) },
  })
}

/** A prior settled direct approval (asked + allowed-once pair). */
function priorDirectAllowed(
  fixture: Fixture,
  callId: string,
  args: Record<string, unknown>,
  id: string,
): void {
  fixture.events.push(
    { type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify(args) } },
    { type: 'approval/asked', data: { id, toolName: 'bash', callId } },
    { type: 'approval/decided', data: { id, outcome: 'allowed-once' } },
  )
}

describe('auto-permit answerer over PTC evidence', () => {
  it('claims an allowlisted PTC sub-call before the judge, with a notice and no model call', async () => {
    const fixture = makeFixture({ isHighRisk: () => false, claim: () => ({ via: 'rtk' }) })
    ptcBash(fixture, 'root:ptc:1', { command: 'rtk sync', sandbox_permissions: 'workspace-write' })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(outcome).toBe('allowed-once')
    expect(fellThrough).toBe(false)
    expect(fixture.llmCalls).toHaveLength(0)
    expect(fixture.injected).toHaveLength(1)
    expect(fixture.injected[0]?.source?.summary).toContain('cmd-permit')
    // The order-safe channel: never a bare surface append mid-batch.
    expect(fixture.appended).toEqual([])
  })

  it('sends a disposable podman probe to the judge instead of the rm hard rule', async () => {
    const fixture = makeFixture(undefined, {
      verdicts: ['VERDICT: defer\nREASON: needs the script'],
      workspace: WORKSPACE,
      workingDirectory: WORKSPACE,
    })
    const command =
      'podman run --rm --network none -v "$PWD/out:/app:ro" ' +
      'localhost/realsense-official:2.59.1 ldd /app/bin/camera'
    directBash(fixture, 'probe', { command, sandbox_permissions: 'danger-full-access' })
    const { outcome, fellThrough } = await fixture.answer('probe')
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected')
    expect(fixture.llmCalls).toHaveLength(1)
    const notices = fixture.injected.map((message) => message.source?.summary ?? '')
    expect(notices.some((summary) => summary.includes('irreversible'))).toBe(false)
    expect(notices.some((summary) => summary.includes('deferred'))).toBe(true)
  })

  it('renders the judge category and evidence references in the deferred notice', async () => {
    const fixture = makeFixture(undefined, {
      verdicts: [
        'VERDICT: defer\nREASON: script calls an unread helper\nEVIDENCE: scripts/build.sh:10-20',
      ],
      workspace: WORKSPACE,
      workingDirectory: WORKSPACE,
    })
    directBash(fixture, 'evidence-note', {
      command: 'bash scripts/build.sh',
      sandbox_permissions: 'danger-full-access',
    })
    await fixture.answer('evidence-note')
    const body = fixture.injected[0]?.content?.map((block) => block.text ?? '').join('\n') ?? ''
    expect(body).toContain('judge (policy): script calls an unread helper')
    expect(body).toContain('evidence: scripts/build.sh:10-20')
  })

  it('defers a high-risk PTC sub-call to the human with a high-risk notice', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', {
      command: 'sudo rm -rf /tmp/x',
      sandbox_permissions: 'danger-full-access',
    })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected') // the next() sentinel, i.e. the human dialog
    expect(fixture.llmCalls).toHaveLength(0)
    expect(
      fixture.injected.some((message) => message.source?.summary?.includes('irreversible')),
    ).toBe(true)
  })

  it('does NOT replay a log-only prior approval: the judge must see it (v3 migration)', async () => {
    // The audit trail cannot prove WHO allowed the prior call. A pre-v3
    // cache-rule allowance looks identical to a human approval in the log,
    // so a log-derived exact repeat is no longer auto-allowed — the judge
    // (under the current rules) or the human decides again.
    const fixture = makeFixture()
    priorDirectAllowed(
      fixture,
      'd1',
      { command: 'uv sync', sandbox_permissions: 'workspace-write' },
      'a1',
    )
    ptcBash(fixture, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(fixture.llmCalls).toHaveLength(1)
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected') // the next() sentinel, i.e. the human dialog
    expect(
      fixture.injected.some((message) => message.source?.summary?.includes('seen this session')),
    ).toBe(false)
  })

  it('replays an exact repeat that this process saw the CHAIN approve', async () => {
    // First ask: the judge defers and the human (next()) allows. The repeat
    // of a human-approved command is a genuine standing authorization.
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' })
    const first = await fixture.answer('root:ptc:1', 'bash', 'allowed-once')
    expect(first.outcome).toBe('allowed-once')
    expect(first.fellThrough).toBe(true)
    // The approved pair is now in the log (as the host would write it).
    fixture.events.push(
      { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'root:ptc:1' } },
      { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } },
    )
    ptcBash(fixture, 'root:ptc:2', { command: 'uv sync', sandbox_permissions: 'workspace-write' })
    const second = await fixture.answer('root:ptc:2')
    expect(second.outcome).toBe('allowed-once')
    expect(second.fellThrough).toBe(false)
    expect(fixture.llmCalls).toHaveLength(1) // only the first ask reached the judge
    expect(
      fixture.injected.some((message) => message.source?.summary?.includes('seen this session')),
    ).toBe(true)
  })

  it('does NOT replay its own judge allowance: each ask stands on its own', async () => {
    // First ask: the judge allows. The identical repeat must go back to the
    // judge (which may now defer) instead of the old allowance compounding
    // into a standing grant.
    const fixture = makeFixture(undefined, { verdicts: ['VERDICT: allow', 'VERDICT: defer'] })
    ptcBash(fixture, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' })
    const first = await fixture.answer('root:ptc:1')
    expect(first.outcome).toBe('allowed-once')
    expect(first.fellThrough).toBe(false)
    fixture.events.push(
      { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', callId: 'root:ptc:1' } },
      { type: 'approval/decided', data: { id: 'a1', outcome: 'allowed-once' } },
    )
    ptcBash(fixture, 'root:ptc:2', { command: 'uv sync', sandbox_permissions: 'workspace-write' })
    const second = await fixture.answer('root:ptc:2')
    expect(fixture.llmCalls).toHaveLength(2)
    expect(second.fellThrough).toBe(true)
    expect(second.outcome).toBe('rejected')
    expect(
      fixture.injected.filter((message) => message.source?.summary?.includes('seen this session')),
    ).toHaveLength(0)
  })

  it('hands the judge the full PTC evidence and defers when it defers', async () => {
    const fixture = makeFixture()
    fixture.events.push({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'please run the suite' }] },
    })
    ptcBash(fixture, 'root:ptc:1', {
      command: 'uv sync',
      description: 'Install project dependencies',
      sandbox_permissions: 'workspace-write',
      justification: 'uv needs its cache outside the workspace',
    })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    // The fake judge model yields nothing → defer → next().
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected')
    expect(fixture.llmCalls).toHaveLength(1)
    const text =
      fixture.llmCalls[0]?.messages[0]?.content?.map((block) => block.text ?? '').join('\n') ?? ''
    expect(text).toContain('"uv sync"')
    expect(text).toContain('"workspace-write"')
    expect(text).toContain('Install project dependencies')
    expect(text).toContain('uv needs its cache outside the workspace')
    expect(text).toContain('please run the suite')
  })

  it('falls back to the chain untouched on hosts without a start event (old hosts)', async () => {
    const fixture = makeFixture()
    fixture.events.push({
      type: 'tool/ptc-dispatch',
      data: {
        rootCallId: 'root',
        subCallId: 'root:ptc:1',
        name: 'bash',
        arguments: { command: 'rtk sync', sandbox_permissions: 'workspace-write' },
      },
    })
    const { fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
    expect(fixture.llmCalls).toHaveLength(0)
  })

  it('hands the call workdir, effective cwd, and immutable workspace to the judge', async () => {
    const fixture = makeFixture(undefined, {
      workspace: WORKSPACE,
      workingDirectory: WORKSPACE,
    })
    ptcBash(fixture, 'root:ptc:1', {
      command: 'podman build -t local/app:test .',
      workdir: WORKSPACE,
      sandbox_permissions: 'danger-full-access',
    })
    await fixture.answer('root:ptc:1')
    const text =
      fixture.llmCalls[0]?.messages[0]?.content?.map((block) => block.text ?? '').join('\n') ?? ''
    expect(text).toContain(`call_workdir: "${WORKSPACE}"`)
    expect(text).toContain(`effective_cwd (recorded current working directory): "${WORKSPACE}"`)
    expect(text).toContain(`resolved_working_directory (host resolution): "${WORKSPACE}"`)
    expect(text).toContain(`session_workspace (immutable original project): "${WORKSPACE}"`)
  })

  it('falls back without a notice on malformed PTC evidence', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { description: 'no command here' })
    const { fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
    expect(fixture.llmCalls).toHaveLength(0)
  })

  it('leaves non-bash approval requests to the chain', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', { command: 'uv sync' })
    const { fellThrough } = await fixture.answer('root:ptc:1', 'read')
    expect(fellThrough).toBe(true)
    expect(fixture.injected).toEqual([])
    expect(fixture.llmCalls).toHaveLength(0)
  })
})

describe('container boundary', () => {
  /** First ask: judge defers (no queued verdict), the chain allows once. */
  async function chainApprove(fixture: Fixture, callId: string, command: string): Promise<void> {
    ptcBash(fixture, callId, { command, sandbox_permissions: 'danger-full-access' })
    const first = await fixture.answer(callId, 'bash', 'allowed-once')
    expect(first.fellThrough).toBe(true)
    fixture.events.push(
      { type: 'approval/asked', data: { id: `ask-${callId}`, toolName: 'bash', callId } },
      { type: 'approval/decided', data: { id: `ask-${callId}`, outcome: 'allowed-once' } },
    )
  }

  it('never replays a chain-approved container command: the identical string is re-judged', async () => {
    const fixture = makeFixture(undefined, { workspace: WORKSPACE, workingDirectory: WORKSPACE })
    await chainApprove(fixture, 'root:ptc:1', 'podman build -t local/app:test .')
    ptcBash(fixture, 'root:ptc:2', {
      command: 'podman build -t local/app:test .',
      sandbox_permissions: 'danger-full-access',
    })
    const second = await fixture.answer('root:ptc:2')
    expect(second.fellThrough).toBe(true)
    expect(fixture.llmCalls).toHaveLength(2)
    expect(
      fixture.injected.some((message) => message.source?.summary?.includes('seen this session')),
    ).toBe(false)
  })

  it('never replays a chain-approved script invocation: the script file can change', async () => {
    const fixture = makeFixture(undefined, { workspace: WORKSPACE, workingDirectory: WORKSPACE })
    await chainApprove(fixture, 'root:ptc:1', './scripts/test-container.sh --fast')
    ptcBash(fixture, 'root:ptc:2', {
      command: './scripts/test-container.sh --fast',
      sandbox_permissions: 'danger-full-access',
    })
    const second = await fixture.answer('root:ptc:2')
    expect(second.fellThrough).toBe(true)
    expect(fixture.llmCalls).toHaveLength(2)
  })

  it('routes a container boundary shape to the human without a model call', async () => {
    const fixture = makeFixture()
    ptcBash(fixture, 'root:ptc:1', {
      command: 'podman run --privileged -v /:/host alpine',
      sandbox_permissions: 'danger-full-access',
    })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected') // the next() sentinel, i.e. the human dialog
    expect(fixture.llmCalls).toHaveLength(0)
    expect(fixture.injected).toHaveLength(1)
    expect(fixture.injected[0]?.source?.summary).toContain('container boundary')
    expect(fixture.injected[0]?.source?.summary).toContain('podman run --privileged')
  })

  it('keeps the local boundary when a mounted cmd-permit oracle would claim the shape', async () => {
    // A stale/looser peer allowlist must not override this plugin's own
    // container boundary; the union is deliberate.
    const fixture = makeFixture({ isHighRisk: () => false, claim: () => ({ via: 'podman' }) })
    ptcBash(fixture, 'root:ptc:1', {
      command: 'podman run --privileged alpine',
      sandbox_permissions: 'danger-full-access',
    })
    const { outcome, fellThrough } = await fixture.answer('root:ptc:1')
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected')
    expect(fixture.llmCalls).toHaveLength(0)
  })

  it('routes grouped lifecycle/push forms to the human before a claiming allowlist', async () => {
    const commands = [
      'podman container exec production-db sh -c id',
      'podman container stop production-db',
      'podman image push app registry.example/app',
    ]
    for (const [index, command] of commands.entries()) {
      let claims = 0
      const fixture = makeFixture({
        isHighRisk: () => false, // simulate a peer table older than this build
        claim: () => {
          claims += 1
          return { via: 'podman' }
        },
      })
      const callId = `c${index}`
      directBash(fixture, callId, { command, sandbox_permissions: 'danger-full-access' })
      const { outcome, fellThrough } = await fixture.answer(callId)
      expect(fellThrough, command).toBe(true)
      expect(outcome, command).toBe('rejected') // the next() sentinel, i.e. the human
      expect(fixture.llmCalls, command).toHaveLength(0)
      expect(claims, command).toBe(0)
      expect(fixture.injected[0]?.source?.summary, command).toContain('container boundary')
    }
  })

  it('routes attached short-option mount forms to the human before a claiming allowlist', async () => {
    // pflag accepts `-vSOURCE:DEST`; it names the same mount as `-v SOURCE:DEST`.
    const commands = [
      'podman run --rm -v/:/host alpine true',
      'podman run --rm -v/home/u/.ssh:/keys alpine true',
      'podman run --rm --volume=/home/u/:/host alpine true',
    ]
    for (const [index, command] of commands.entries()) {
      let claims = 0
      const fixture = makeFixture({
        isHighRisk: () => false,
        claim: () => {
          claims += 1
          return { via: 'podman' }
        },
      })
      const callId = `mount-${index}`
      directBash(fixture, callId, { command, sandbox_permissions: 'danger-full-access' })
      const { outcome, fellThrough } = await fixture.answer(callId)
      expect(fellThrough, command).toBe(true)
      expect(outcome, command).toBe('rejected')
      expect(fixture.llmCalls, command).toHaveLength(0)
      expect(claims, command).toBe(0)
      expect(fixture.injected[0]?.source?.summary, command).toContain('container boundary')
    }
  })

  it('applies hard rules to the complete command even beyond the judge budget', async () => {
    const command = `podman run --rm --label note=${'x'.repeat(MAX_COMMAND_CHARS + 100)} --privileged alpine true`
    for (const form of ['direct', 'ptc']) {
      const fixture = makeFixture()
      const callId = `bulk-${form}`
      if (form === 'direct') {
        directBash(fixture, callId, { command, sandbox_permissions: 'danger-full-access' })
      } else {
        ptcBash(fixture, callId, { command, sandbox_permissions: 'danger-full-access' })
      }
      const { outcome, fellThrough } = await fixture.answer(callId)
      expect(fellThrough, form).toBe(true)
      expect(outcome, form).toBe('rejected')
      expect(fixture.llmCalls, form).toHaveLength(0)
      expect(fixture.injected[0]?.source?.summary, form).toContain('container boundary')
    }
  })

  it('defers an over-budget command instead of judging a truncated prefix', async () => {
    const fixture = makeFixture()
    const command = `echo ${'x'.repeat(MAX_COMMAND_CHARS + 1)}`
    directBash(fixture, 'huge', { command, sandbox_permissions: 'danger-full-access' })
    const { outcome, fellThrough } = await fixture.answer('huge')
    expect(fellThrough).toBe(true)
    expect(outcome).toBe('rejected')
    expect(fixture.llmCalls).toHaveLength(0)
    expect(fixture.injected.some((message) => message.source?.summary?.includes('deferred'))).toBe(
      true,
    )
  })

  it('resolves an omitted workdir against the host effective cwd, not the header', async () => {
    const fixture = makeFixture(undefined, {
      workspace: WORKSPACE,
      workingDirectory: '/home/u/other-project',
    })
    directBash(fixture, 'cwd-1', {
      command: 'podman run --rm -v "$PWD":/src alpine true',
      sandbox_permissions: 'danger-full-access',
    })
    await fixture.answer('cwd-1')
    const text =
      fixture.llmCalls[0]?.messages[0]?.content?.map((block) => block.text ?? '').join('\n') ?? ''
    expect(text).toContain(
      'effective_cwd (recorded current working directory): "/home/u/other-project"',
    )
    expect(text).toContain('resolved_working_directory (host resolution): "/home/u/other-project"')
    expect(text).toContain(`session_workspace (immutable original project): "${WORKSPACE}"`)
  })

  it('joins a PTC relative workdir to the effective cwd like the host', async () => {
    const fixture = makeFixture(undefined, {
      workspace: WORKSPACE,
      workingDirectory: '/home/u/other-project',
    })
    ptcBash(fixture, 'root:ptc:1', {
      command: 'podman build .',
      workdir: 'src',
      sandbox_permissions: 'danger-full-access',
    })
    await fixture.answer('root:ptc:1')
    const text =
      fixture.llmCalls[0]?.messages[0]?.content?.map((block) => block.text ?? '').join('\n') ?? ''
    expect(text).toContain(
      'resolved_working_directory (host resolution): "/home/u/other-project/src"',
    )
  })

  it('falls back to the logged working-directory change when the service is absent', async () => {
    const fixture = makeFixture(undefined, { workspace: WORKSPACE })
    fixture.events.push({
      type: 'working-directory/change',
      data: { cwd: '/home/u/other-project' },
    })
    directBash(fixture, 'cwd-2', {
      command: 'podman build .',
      sandbox_permissions: 'danger-full-access',
    })
    await fixture.answer('cwd-2')
    const text =
      fixture.llmCalls[0]?.messages[0]?.content?.map((block) => block.text ?? '').join('\n') ?? ''
    expect(text).toContain(
      'effective_cwd (recorded current working directory): "/home/u/other-project"',
    )
    expect(text).toContain('resolved_working_directory (host resolution): "/home/u/other-project"')
  })
})
