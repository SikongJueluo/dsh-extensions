/**
 * The `create_worktree` model tool, adapted to the VCS at the Session's
 * directory: jj workspace + task bookmark in a jj repository, the stock Git
 * branch + worktree elsewhere. The tool keeps its name, arguments, and result
 * fields so existing callers and skills keep working.
 *
 * @module dsh-jj-workspace/tool
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CreatedWorkspace, CreateWorkspaceRequest } from './service.js'

/** Cordis plugin name. */
export const name = 'jj-tool-worktree'

/** Services required to register and execute the tool. */
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
        return (await ctx.worktrees.create(exec.agent, request, exec.signal)) as CreatedWorkspace
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'create_worktree',
        rawInput: args,
      }),
    }),
  )
}
