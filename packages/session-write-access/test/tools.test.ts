import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type { GroupRecord, RequestRecord } from '../src/domain.js'
import type { SessionWriteAccessPolicy } from '../src/service.js'
import { registerWriteAccessTools } from '../src/tools.js'

const group: GroupRecord = {
  version: 1,
  groupId: 'root',
  workspaceRoot: '/workspace',
  grants: [],
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
}

const request: RequestRecord = {
  version: 1,
  requestId: 'request-1',
  groupId: 'root',
  sessionId: 'root',
  path: '/tmp/extra',
  reason: 'read generated fixtures',
  status: 'pending',
  createdAt: 0,
}

/** Capture the two tool definitions with a service stub. */
function definitions(policy: Partial<SessionWriteAccessPolicy>): Map<string, ToolDefinition> {
  const captured = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (definition: ToolDefinition) => captured.set(definition.name, definition) },
  }
  registerWriteAccessTools(ctx as unknown as Context, policy as unknown as SessionWriteAccessPolicy)
  return captured
}

/** The execution identity the tool reads: the calling session and its signal. */
function call() {
  return {
    agent: { session: { id: 'root' } },
    callId: 'call-1',
    signal: new AbortController().signal,
  } as never
}

type ApprovalAnswer = 'allow' | 'deny' | 'cancelled' | 'unavailable'

function toolRunning(answer: ApprovalAnswer): ToolDefinition {
  const policy = {
    ensureSession: async () => {},
    view: () => ({
      sessionId: 'root',
      groupId: 'root',
      workspaceRoot: '/workspace',
      revision: 1,
      grants: [],
      pending: [],
      recent: [],
      deploymentRoots: [],
      defaultMode: 'workspace-write' as const,
      effectiveMode: 'workspace-write' as const,
      forks: [],
    }),
    requestDirectory: async () => ({ kind: 'pending' as const, request }),
    awaitApproval: async () => answer,
  } satisfies Partial<SessionWriteAccessPolicy>
  const definition = definitions(policy).get('write_access_request')
  if (definition === undefined) throw new Error('write_access_request was not registered')
  return definition
}

describe('write_access_request outcome mapping', () => {
  it('reports granted after the user allows, and reports the refusal', async () => {
    const allowed = await toolRunning('allow').execute(
      { path: '/tmp/extra', reason: 'read generated fixtures' },
      call(),
    )
    expect(allowed).toMatchObject({ outcome: 'granted', path: '/tmp/extra' })

    const denied = await toolRunning('deny').execute(
      { path: '/tmp/extra', reason: 'read generated fixtures' },
      call(),
    )
    expect(denied).toMatchObject({ outcome: 'denied' })
  })

  it('keeps the pending flow when the question is withdrawn or unanswered', async () => {
    const cancelled = await toolRunning('cancelled').execute(
      { path: '/tmp/extra', reason: 'read generated fixtures' },
      call(),
    )
    expect(cancelled).toMatchObject({ outcome: 'cancelled' })

    const pending = await toolRunning('unavailable').execute(
      { path: '/tmp/extra', reason: 'read generated fixtures' },
      call(),
    )
    expect(pending).toMatchObject({ outcome: 'pending', requestId: 'request-1' })
  })

  it('never asks when the directory is already writable', async () => {
    const policy = {
      ensureSession: async () => {},
      requestDirectory: async () => ({ kind: 'granted' as const, group }),
      awaitApproval: async () => {
        throw new Error('already-granted requests must not ask')
      },
    } satisfies Partial<SessionWriteAccessPolicy>
    const definition = definitions(policy).get('write_access_request')
    if (definition === undefined) throw new Error('write_access_request was not registered')
    await expect(
      definition.execute({ path: '/tmp/extra', reason: 'read generated fixtures' }, call()),
    ).resolves.toMatchObject({ outcome: 'granted' })
  })
})
