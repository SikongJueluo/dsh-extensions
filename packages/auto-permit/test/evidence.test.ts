import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { collectEvidence, foldPrompt, MAX_COMMAND_CHARS, MAX_PATH_CHARS } from '../src/evidence.js'

interface Fixture {
  type: string
  seq?: number
  data: unknown
}

function sessionOf(events: Fixture[], header?: { cwd?: string }): Session {
  return {
    snapshotEvents: () => [...events],
    ...(header === undefined ? {} : { header }),
  } as unknown as Session
}

function directCall(seq: number, callId: string, name: string, args: unknown): Fixture {
  return { type: 'tool/call', seq, data: { callId, name, arguments: JSON.stringify(args) } }
}

function ptcStart(
  seq: number,
  subCallId: string,
  args: unknown,
  extra: Record<string, unknown> = {},
): Fixture {
  return {
    type: 'tool/ptc-dispatch-start',
    seq,
    data: {
      rootCallId: 'root',
      parentCallId: 'root',
      subCallId,
      name: 'bash',
      arguments: args,
      ...extra,
    },
  }
}

function asked(seq: number, id: string, callId: string): Fixture {
  return { type: 'approval/asked', seq, data: { id, toolName: 'bash', callId } }
}

function decided(seq: number, id: string, outcome: string): Fixture {
  return { type: 'approval/decided', seq, data: { id, outcome } }
}

function userPrompt(seq: number, text: string): Fixture {
  return {
    type: 'user/message',
    seq,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function changeCwd(seq: number, cwd: string): Fixture {
  return { type: 'working-directory/change', seq, data: { cwd } }
}

const UV_ARGS = {
  command: 'uv sync',
  description: 'Install project dependencies',
  sandbox_permissions: 'workspace-write',
  justification: 'uv needs its cache outside the workspace',
}

describe('pending-call recovery', () => {
  it('still recovers a direct top-level bash call with full arguments', () => {
    const evidence = collectEvidence(sessionOf([directCall(1, 'c1', 'bash', UV_ARGS)]), 'c1')
    expect(evidence.call).toEqual({
      command: 'uv sync',
      description: 'Install project dependencies',
      sandboxPermissions: 'workspace-write',
      justification: 'uv needs its cache outside the workspace',
    })
  })

  it('recovers a pending PTC bash sub-call from its start event alone (no completion yet)', () => {
    const evidence = collectEvidence(
      sessionOf([
        directCall(1, 'root', 'run_code', { code: 'bash("uv sync")' }),
        ptcStart(2, 'root:ptc:1', UV_ARGS),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toEqual({
      command: 'uv sync',
      description: 'Install project dependencies',
      sandboxPermissions: 'workspace-write',
      justification: 'uv needs its cache outside the workspace',
    })
  })

  it('direct and PTC forms of the same command produce identical evidence', () => {
    const direct = collectEvidence(sessionOf([directCall(1, 'c1', 'bash', UV_ARGS)]), 'c1')
    const ptc = collectEvidence(sessionOf([ptcStart(1, 'root:ptc:1', UV_ARGS)]), 'root:ptc:1')
    expect(ptc.call).toEqual(direct.call)
  })

  it('leaves a call unrecoverable when its id appears twice with different content', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 'uv sync' }),
        ptcStart(2, 'root:ptc:1', { command: 'rm -rf /' }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toBeUndefined()
  })

  it('invalidates evidence when the second record under an id is a malformed bash payload', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        ptcStart(2, 'root:ptc:1', { command: 42 }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toBeUndefined()
  })

  it('invalidates evidence when the second record under an id names another tool', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        ptcStart(2, 'root:ptc:1', { file_path: 'a.txt' }, { name: 'read' }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toBeUndefined()
  })

  it('invalidates evidence when a malformed record claimed the id first', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 42 }),
        ptcStart(2, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toBeUndefined()
  })

  it('invalidates evidence when another tool claimed the id first', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { file_path: 'a.txt' }, { name: 'read' }),
        ptcStart(2, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toBeUndefined()
  })

  it('keeps an idempotent replay of the identical record recoverable', () => {
    const args = { command: 'uv sync', sandbox_permissions: 'workspace-write' }
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', args),
        ptcStart(2, 'root:ptc:1', { ...args }),
        directCall(3, 'root:ptc:1', 'bash', args),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call?.command).toBe('uv sync')
  })

  it('keeps unrelated non-bash calls from tainting their own ids only', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { file_path: 'a.txt' }, { name: 'read' }),
        ptcStart(2, 'root:ptc:2', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      ]),
      'root:ptc:2',
    )
    expect(evidence.call?.command).toBe('uv sync')
  })

  it('leaves malformed PTC arguments unrecoverable, never guessed', () => {
    for (const bad of [{}, { command: 42 }, [], null, 'uv sync', 7]) {
      const evidence = collectEvidence(sessionOf([ptcStart(1, 'root:ptc:1', bad)]), 'root:ptc:1')
      expect(evidence.call).toBeUndefined()
    }
  })

  it('ignores PTC start events for other tools', () => {
    const evidence = collectEvidence(
      sessionOf([
        {
          type: 'tool/ptc-dispatch-start',
          seq: 1,
          data: {
            rootCallId: 'root',
            parentCallId: 'root',
            subCallId: 'root:ptc:1',
            name: 'read',
            arguments: { file_path: 'a' },
          },
        },
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toBeUndefined()
  })

  it('never recovers evidence from a bare tool/ptc-dispatch completion (old hosts)', () => {
    const evidence = collectEvidence(
      sessionOf([
        {
          type: 'tool/ptc-dispatch',
          seq: 1,
          data: { rootCallId: 'root', subCallId: 'root:ptc:1', name: 'bash', arguments: UV_ARGS },
        },
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toBeUndefined()
  })

  it('still rejects malformed direct JSON arguments', () => {
    const evidence = collectEvidence(
      sessionOf([
        {
          type: 'tool/call',
          seq: 1,
          data: { callId: 'c1', name: 'bash', arguments: '{"command": "x"' },
        },
      ]),
      'c1',
    )
    expect(evidence.call).toBeUndefined()
  })
})

describe('sub-call isolation', () => {
  it('keeps sibling sub-calls under one root distinct', () => {
    const session = sessionOf([
      ptcStart(1, 'root:ptc:1', { command: 'cargo build', sandbox_permissions: 'workspace-write' }),
      ptcStart(2, 'root:ptc:2', { command: 'cargo test', sandbox_permissions: 'workspace-write' }),
    ])
    expect(collectEvidence(session, 'root:ptc:1').call?.command).toBe('cargo build')
    expect(collectEvidence(session, 'root:ptc:2').call?.command).toBe('cargo test')
  })

  it('keeps interleaved sub-calls from different roots distinct', () => {
    const session = sessionOf([
      ptcStart(1, 'a:ptc:1', { command: 'echo a1' }),
      ptcStart(2, 'b:ptc:1', { command: 'echo b1' }),
      ptcStart(3, 'a:ptc:2', { command: 'echo a2' }),
      ptcStart(4, 'b:ptc:2', { command: 'echo b2' }),
    ])
    expect(collectEvidence(session, 'a:ptc:2').call?.command).toBe('echo a2')
    expect(collectEvidence(session, 'b:ptc:1').call?.command).toBe('echo b1')
  })

  it('resolves nested PTC sub-call ids (run_code inside run_code)', () => {
    const session = sessionOf([
      {
        type: 'tool/ptc-dispatch-start',
        seq: 1,
        data: {
          rootCallId: 'root',
          parentCallId: 'root',
          subCallId: 'root:ptc:1',
          name: 'run_code',
          arguments: { code: '…' },
        },
      },
      ptcStart(2, 'root:ptc:1:ptc:1', UV_ARGS, { rootCallId: 'root', parentCallId: 'root:ptc:1' }),
    ])
    expect(collectEvidence(session, 'root:ptc:1:ptc:1').call?.command).toBe('uv sync')
  })
})

describe('approval history across both paths', () => {
  it('counts a prior PTC approval in the approved history for a pending direct call', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        asked(2, 'a1', 'root:ptc:1'),
        decided(3, 'a1', 'allowed-once'),
        directCall(4, 'd1', 'bash', { command: 'uv lock', sandbox_permissions: 'workspace-write' }),
      ]),
      'd1',
    )
    expect(evidence.approved).toEqual(['uv sync'])
  })

  it('counts a prior direct approval in the approved history for a pending PTC call', () => {
    const evidence = collectEvidence(
      sessionOf([
        directCall(1, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        asked(2, 'a1', 'd1'),
        decided(3, 'a1', 'allowed-once'),
        ptcStart(4, 'root:ptc:1', { command: 'uv lock', sandbox_permissions: 'workspace-write' }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.approved).toEqual(['uv sync'])
  })

  it('approving one sibling does not make the other an exact repeat', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        ptcStart(2, 'root:ptc:2', {
          command: 'cargo build',
          sandbox_permissions: 'workspace-write',
        }),
        asked(3, 'a1', 'root:ptc:1'),
        decided(4, 'a1', 'allowed-once'),
      ]),
      'root:ptc:2',
    )

    expect(evidence.approved).toEqual(['uv sync'])
    expect(evidence.exactRepeat).toBe(false)
  })
})

describe('exact-repeat memory across both paths', () => {
  it('approved PTC sub-call makes a direct repeat exact', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        asked(2, 'a1', 'root:ptc:1'),
        decided(3, 'a1', 'allowed-once'),
        directCall(4, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      ]),
      'd1',
    )
    expect(evidence.exactRepeat).toBe(true)
  })

  it('approved direct call makes a PTC repeat exact', () => {
    const evidence = collectEvidence(
      sessionOf([
        directCall(1, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        asked(2, 'a1', 'd1'),
        decided(3, 'a1', 'allowed-once'),
        ptcStart(4, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.exactRepeat).toBe(true)
  })

  it('a different escalation mode is not an exact repeat', () => {
    const evidence = collectEvidence(
      sessionOf([
        directCall(1, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        asked(2, 'a1', 'd1'),
        decided(3, 'a1', 'allowed-once'),
        ptcStart(4, 'root:ptc:1', {
          command: 'uv sync',
          sandbox_permissions: 'danger-full-access',
        }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.exactRepeat).toBe(false)
  })

  it('rejected, cancelled, and undecided approvals never form memory', () => {
    for (const outcome of ['rejected', 'cancelled', undefined]) {
      const events: Fixture[] = [
        directCall(1, 'd1', 'bash', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        asked(2, 'a1', 'd1'),
      ]
      if (outcome !== undefined) events.push(decided(3, 'a1', outcome))
      events.push(
        ptcStart(4, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
      )
      const evidence = collectEvidence(sessionOf(events), 'root:ptc:1')
      expect(evidence.approved).toEqual([])
      expect(evidence.exactRepeat).toBe(false)
    }
  })

  it('the pending ask itself is excluded from the repeat check', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 'uv sync', sandbox_permissions: 'workspace-write' }),
        asked(2, 'a1', 'root:ptc:1'),
      ]),
      'root:ptc:1',
    )

    expect(evidence.approved).toEqual([])
    expect(evidence.exactRepeat).toBe(false)
  })
})

describe('execution context: workdir, effective cwd, and session workspace', () => {
  it('recovers the call workdir from direct and PTC records identically', () => {
    const args = {
      command: 'podman build -t app .',
      workdir: '/home/u/Projects/app',
      sandbox_permissions: 'danger-full-access',
    }
    const direct = collectEvidence(sessionOf([directCall(1, 'c1', 'bash', args)]), 'c1')
    const ptc = collectEvidence(sessionOf([ptcStart(1, 'root:ptc:1', args)]), 'root:ptc:1')
    expect(direct.call?.workdir).toBe('/home/u/Projects/app')
    expect(ptc.call).toEqual(direct.call)
  })

  it('taints an id whose workdir disagrees between records', () => {
    const evidence = collectEvidence(
      sessionOf([
        ptcStart(1, 'root:ptc:1', { command: 'podman build .', workdir: '/home/u/app' }),
        ptcStart(2, 'root:ptc:1', { command: 'podman build .', workdir: '/etc' }),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call).toBeUndefined()
  })

  it('keeps the immutable workspace and the recorded effective cwd distinct', () => {
    const evidence = collectEvidence(
      sessionOf(
        [
          changeCwd(1, '/home/u/other-project'),
          ptcStart(2, 'root:ptc:1', { command: 'podman build .' }),
        ],
        { cwd: '/home/u/project' },
      ),
      'root:ptc:1',
    )
    expect(evidence.workspace).toBe('/home/u/project')
    expect(evidence.effectiveCwd).toBe('/home/u/other-project')
  })

  it('resolves an omitted workdir to the effective cwd, not the header', () => {
    const evidence = collectEvidence(
      sessionOf(
        [
          changeCwd(1, '/home/u/other-project'),
          ptcStart(2, 'root:ptc:1', { command: 'podman run --rm alpine true' }),
        ],
        { cwd: '/home/u/project' },
      ),
      'root:ptc:1',
    )
    expect(evidence.resolvedWorkdir).toBe('/home/u/other-project')
  })

  it('resolves a relative workdir against the effective cwd like the host', () => {
    const evidence = collectEvidence(
      sessionOf(
        [
          changeCwd(1, '/home/u/other-project'),
          ptcStart(2, 'root:ptc:1', { command: 'podman build .', workdir: 'src' }),
        ],
        { cwd: '/home/u/project' },
      ),
      'root:ptc:1',
    )
    expect(evidence.resolvedWorkdir).toBe('/home/u/other-project/src')
  })

  it('uses an absolute workdir as-is', () => {
    const evidence = collectEvidence(
      sessionOf(
        [
          changeCwd(1, '/home/u/other-project'),
          ptcStart(2, 'root:ptc:1', { command: 'podman build .', workdir: '/tmp/build' }),
        ],
        { cwd: '/home/u/project' },
      ),
      'root:ptc:1',
    )
    expect(evidence.resolvedWorkdir).toBe('/tmp/build')
  })

  it('prefers the host service value over the log and the header', () => {
    const evidence = collectEvidence(
      sessionOf(
        [changeCwd(1, '/stale/from-log'), ptcStart(2, 'root:ptc:1', { command: 'podman build .' })],
        { cwd: '/home/u/project' },
      ),
      'root:ptc:1',
      '/live/from-service',
    )
    expect(evidence.effectiveCwd).toBe('/live/from-service')
    expect(evidence.resolvedWorkdir).toBe('/live/from-service')
  })

  it('falls back to the header when no change and no service value exist', () => {
    const evidence = collectEvidence(
      sessionOf([ptcStart(1, 'root:ptc:1', { command: 'podman build .' })], {
        cwd: '/home/u/Projects/app',
      }),
      'root:ptc:1',
    )
    expect(evidence.workspace).toBe('/home/u/Projects/app')
    expect(evidence.effectiveCwd).toBe('/home/u/Projects/app')
    expect(evidence.resolvedWorkdir).toBe('/home/u/Projects/app')
  })

  it('reports no workspace and no resolved directory when nothing records one', () => {
    const evidence = collectEvidence(
      sessionOf([ptcStart(1, 'root:ptc:1', { command: 'podman build .' })]),
      'root:ptc:1',
    )
    expect(evidence.workspace).toBeUndefined()
    expect(evidence.effectiveCwd).toBeUndefined()
    expect(evidence.resolvedWorkdir).toBeUndefined()
  })

  it('treats an over-long workdir as unresolved and clips it for display', () => {
    const workdir = `/${'x'.repeat(MAX_PATH_CHARS * 2)}`
    const evidence = collectEvidence(
      sessionOf([ptcStart(1, 'root:ptc:1', { command: 'podman build .', workdir })], {
        cwd: '/home/u/app',
      }),
      'root:ptc:1',
    )
    expect(evidence.call?.workdir?.endsWith('…[truncated]')).toBe(true)
    expect(evidence.resolvedWorkdir).toBeUndefined()
  })
})

describe('unchanged policy around the fold', () => {
  it('gathers prompts only from human user messages', () => {
    const evidence = collectEvidence(
      sessionOf([
        userPrompt(1, 'please run the suite'),
        {
          type: 'user/message',
          seq: 2,
          data: { source: { kind: 'tool' }, content: [{ type: 'text', text: 'tool output' }] },
        },
        ptcStart(3, 'root:ptc:1', UV_ARGS),
      ]),
      'root:ptc:1',
    )
    expect(evidence.prompts).toEqual(['please run the suite'])
  })

  it('ignores unknown event types', () => {
    const evidence = collectEvidence(
      sessionOf([
        {
          type: 'mystery/event',
          seq: 1,
          data: { subCallId: 'root:ptc:1', name: 'bash', arguments: UV_ARGS },
        },
        ptcStart(2, 'root:ptc:1', UV_ARGS),
      ]),
      'root:ptc:1',
    )
    expect(evidence.call?.command).toBe('uv sync')
  })

  it('never clips the complete command: hard rules and the allowlist must see all of it', () => {
    const long = `uv sync ${'x'.repeat(MAX_COMMAND_CHARS)}`
    const evidence = collectEvidence(
      sessionOf([ptcStart(1, 'root:ptc:1', { command: long })]),
      'root:ptc:1',
    )
    expect(evidence.call?.command).toBe(long)
    expect(evidence.call?.command.endsWith('…[truncated]')).toBe(false)
  })
})

describe('long human prompts', () => {
  it('keeps both ends and the formal Task in a handoff longer than the budget', () => {
    const head = `HEAD-INTENT ${'a'.repeat(12790)}`
    const task = '## Task\nImplement the container build with the read-only judge.\n'
    const tail = `${'t'.repeat(200)} TAIL-AUTHORIZATION`
    const folded = foldPrompt(head + task + tail, 12000)
    expect(folded.length).toBeLessThanOrEqual(12000)
    expect(folded).toContain('HEAD-INTENT')
    expect(folded).toContain('## Task')
    expect(folded).toContain('read-only judge')
    expect(folded).toContain('TAIL-AUTHORIZATION')
    expect(folded).toContain('characters omitted')
  })

  it('extracts a Task section that would otherwise sit in the omitted middle', () => {
    const text = `${'a'.repeat(7000)}\n## Task\nMIDDLE-TASK-DETAIL ${'m'.repeat(500)}\n${'z'.repeat(6000)}`
    const folded = foldPrompt(text, 12000)
    expect(folded).toContain('## Task (extracted)')
    expect(folded).toContain('MIDDLE-TASK-DETAIL')
    expect(folded.length).toBeLessThanOrEqual(12000)
  })

  it('feeds the bounded prompt through collectEvidence without losing the Task', () => {
    const task = '## Task\nRun the RealSense wire test with podman.\n'
    const text = `${'a'.repeat(12800)}${task}${'z'.repeat(300)}`
    const evidence = collectEvidence(
      sessionOf([
        userPrompt(1, text),
        userPrompt(2, 'newest authorization: only build, do not install'),
        ptcStart(3, 'root:ptc:1', UV_ARGS),
      ]),
      'root:ptc:1',
    )
    const joined = evidence.prompts.join('\n')
    expect(joined).toContain('Run the RealSense wire test')
    expect(joined).toContain('newest authorization')
    expect(joined.length).toBeLessThanOrEqual(12000)
    expect(evidence.prompts.at(-1)).toContain('newest authorization')
  })
})
