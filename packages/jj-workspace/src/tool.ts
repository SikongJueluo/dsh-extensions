/** @module dsh-jj-workspace/tool */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CreatedWorktree } from '@deepseek-ai/dsh-experimental-worktree'
import type { CreateWorkspaceRequest, JjCreatedFields } from './service.js'

/** Whether one creation result carries the jj arm's fields. The worktrees service is declared by the stock Git SDK, so the jj fields are visible only through runtime evidence; the jj fields are always written together. */
function isJjCreation(
  value: CreatedWorktree & Partial<JjCreatedFields>,
): value is CreatedWorktree & JjCreatedFields {
  return (
    value.vcs === 'jj' &&
    typeof value.workspace === 'string' &&
    typeof value.bookmark === 'string' &&
    typeof value.baseChange === 'string' &&
    typeof value.changeId === 'string'
  )
}

export const name = 'jj-tool-worktree'

export const inject = ['tools', 'worktrees']

/**
 * Register create_worktree for model and PTC callers.
 * @param ctx - tool registry and worktree runtime.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'create_worktree',
      description:
        'Create and enter an isolated workspace for this session, then change the session working directory to it. In a Jujutsu repository this creates a jj workspace with a same-name task bookmark at its initial working-copy commit, starting from the current change (@) or the given change/bookmark; the bookmark is not advanced automatically. In a Git-only repository it creates a Git branch and worktree. In the result, branch names the task bookmark in a jj repository and the Git branch otherwise. Existing names or paths fail. A failed jj attempt keeps whatever it already created and reports it. Use working_directory with cd to leave; the workspace and bookmark remain.',
      parameters: {
        name: {
          type: 'string',
          description:
            'New task name, also the workspace directory and bookmark or branch name: a few lowercase words joined by hyphens that describe the task, such as fix-login-retry. Omit to generate a unique name.',
        },
        from: {
          type: 'string',
          description:
            'Change id or bookmark to start from in a jj repository, or a local commit, branch, or tag in a Git repository. Defaults to the current change (@) or HEAD; no fetch is performed.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            branch: { type: 'string', required: true },
            baseCommit: { type: 'string', required: true },
            repositoryRoot: { type: 'string', required: true },
            vcs: { type: 'string', required: true, enum: ['git', 'jj'] },
            workspace: { type: 'string' },
            bookmark: { type: 'string' },
            baseChange: { type: 'string' },
            changeId: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error('create_worktree requires a calling agent')
        const request: CreateWorkspaceRequest = { ...args, origin: 'tool' }
        const created = await ctx.worktrees.create(exec.agent, request, exec.signal)
        const result: CreatedWorktree & { vcs: 'git' | 'jj' } = isJjCreation(created)
          ? created
          : { ...created, vcs: 'git' }
        return result
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'create_worktree',
        rawInput: args,
      }),
    }),
  )
}
