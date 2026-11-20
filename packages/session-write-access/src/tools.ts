/** @module dsh-session-write-access/tools */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionWriteAccessPolicy } from './service.js'

/** Register both tools in the scope that owns the tool registry. */
export function registerWriteAccessTools(ctx: Context, policy: SessionWriteAccessPolicy): void {
  ctx.tools.register(
    defineTool({
      name: 'write_access_status',
      description:
        "Show this session's persistent write scope: the workspace, deployment-level extra directories, user-granted extra directories shared with local subagents, and pending directory requests. Directory grants persist across restarts and apply to filesystem tools and confined shell alike. Only the user can add, approve, or revoke them.",
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', required: true },
            workspaceRoot: { type: 'string', required: true },
            deploymentRoots: { type: 'array', items: { type: 'string' }, required: true },
            grantedDirectories: { type: 'array', items: { type: 'string' }, required: true },
            pendingRequests: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  requestId: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                  createdAt: { type: 'number', required: true },
                },
              },
            },
            note: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(_args, exec) {
        const session = exec.agent?.session
        if (session === undefined)
          throw new Error('write_access_status requires a calling agent session')
        await policy.ensureSession(session.id)
        const view = policy.view(session.id)
        return {
          mode: policy.resolve({ session }).mode,
          workspaceRoot: view.workspaceRoot,
          deploymentRoots: [...view.deploymentRoots],
          grantedDirectories: view.grants.map((grant) => grant.path),
          pendingRequests: view.pending.map((request) => ({
            requestId: request.requestId,
            path: request.path,
            reason: request.reason,
            createdAt: request.createdAt,
          })),
          note: 'A request blocks in write_access_request until the user answers; entries listed here are requests no interactive approval channel could ask (or ones a cancelled turn left pending).',
        }
      },
      presentCall: () => ({ card: 'generic', title: 'write_access_status', rawInput: {} }),
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'write_access_request',
      description:
        "Ask the user to add one exact existing absolute directory to this session's persistent write scope, shared with its local subagents. Use this after a write outside the workspace is denied (or before a known cross-project edit). The directory and its subdirectories become writable for filesystem tools and confined shell until the user revokes them. This call blocks while the approval question is open and returns the user's decision, so do not continue other work first; without an interactive approval channel it returns pending and the request waits in the write-scope panel instead. Do not retry the failed command automatically: a failed command may have left partial effects, and approval does not replay it. Granting one directory does not grant its parent, HOME, or unrelated siblings.",
      parameters: {
        path: {
          type: 'string',
          required: true,
          description:
            'Exact absolute path of an existing physical directory to make writable (symlinks are refused).',
        },
        reason: {
          type: 'string',
          required: true,
          description: 'Short reason the user will see in the approval panel.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            outcome: {
              type: 'string',
              required: true,
              enum: ['granted', 'denied', 'cancelled', 'pending'],
            },
            path: { type: 'string', required: true },
            requestId: { type: 'string' },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const session = exec.agent?.session
        if (session === undefined)
          throw new Error('write_access_request requires a calling agent session')
        await policy.ensureSession(session.id)
        const result = await policy.requestDirectory(session.id, args.path, args.reason)
        if (result.kind === 'granted') {
          return {
            outcome: 'granted' as const,
            path: args.path,
            message:
              'The directory is already writable. Re-check the previous failure before retrying; the failed command was not replayed.',
          }
        }
        const decision = await policy.awaitApproval(result.request, {
          toolName: 'write_access_request',
          agent: exec.agent,
          callId: exec.callId,
          signal: exec.signal,
        })
        if (decision === 'allow') {
          return {
            outcome: 'granted' as const,
            path: result.request.path,
            message:
              'The user granted the directory. It is writable now for this session and its local subagents; the failed command was not replayed, so re-check the previous failure before retrying.',
          }
        }
        if (decision === 'deny') {
          return {
            outcome: 'denied' as const,
            path: result.request.path,
            message:
              'The user refused write access to this directory. Do not request it again in this session; report the limitation and continue within the current write scope.',
          }
        }
        if (decision === 'cancelled') {
          return {
            outcome: 'cancelled' as const,
            path: result.request.path,
            message:
              'The approval question was withdrawn before it was answered (the turn was cancelled). The request stays recorded as pending in the write-scope panel.',
          }
        }
        return {
          outcome: 'pending' as const,
          path: result.request.path,
          requestId: result.request.requestId,
          message:
            "No interactive approval channel answered, so the request is pending in the user's write-scope panel. It survives restarts. Continue other work and re-check later; do not resubmit the same directory.",
        }
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `write_access_request: ${args.path}`,
        rawInput: args,
      }),
    }),
  )
}
