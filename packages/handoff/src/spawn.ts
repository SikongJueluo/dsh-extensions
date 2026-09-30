/**
 * Fresh-session spawn: the same factory chain the Web "New Session" button
 * uses (`ctx.agents.create` with a mounted preset), plus the first prompt.
 *
 * @module dsh-handoff/spawn
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { COMPLETE_MARKER, PACKAGE_NAME } from './identity.js'
import { bootstrapPrompt, type HandoffRuntime, type PendingHandoff } from './brief.js'
import { defaultRoute, sessionRoute, toAgentOptions } from './selection.js'

/** Sidebar title prefix; the task tail is trimmed to keep it readable. */
const TITLE_PREFIX = 'Handoff: '
const TITLE_TASK_LIMIT = 40

/** Mint a fresh session identity (the brand is compile-time only). */
function mintSessionId(): SessionId {
  return crypto.randomUUID() as SessionId
}

/** Copy the origin agent's model route into creation options (defined fields only). */
function inheritAgentOptions(ctx: Context, agent: Agent): AgentOptions | undefined {
  // The session's durable selection — provider, model, and reasoning effort —
  // is the route it is actually on; `agent.options` is only the creation
  // fallback for a session that has not recorded a selection yet.
  const route = sessionRoute(ctx, agent)
  const options = toAgentOptions(route)
  if (options === undefined) return undefined
  // The origin's own output cap is a per-agent setting rather than part of a
  // route, so it carries over only on an inherited route.
  const maxTokens = agent.options.maxTokens
  return maxTokens === undefined ? options : { ...options, maxTokens }
}

/** Resolve the agent options for the fresh session per the confirmed choice. */
function resolveAgentOptions(ctx: Context, agent: Agent, choice: PendingHandoff['choice']): AgentOptions | undefined {
  if (choice.kind === 'model') {
    // An explicit route switches the brain. The effort is whatever the picker
    // chose; without one the target model's own default applies, and the
    // origin's maxTokens never carries over.
    return toAgentOptions({
      provider: choice.provider,
      model: choice.model,
      ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
    })
  }
  if (choice.kind === 'default') {
    // The deployment default carries its own reasoning effort; dropping it
    // silently downgraded the fresh session to the model default.
    return toAgentOptions(defaultRoute(ctx))
  }
  return inheritAgentOptions(ctx, agent)
}

/**
 * Resolve the preset to mount, mirroring the api-session controller's
 * composeAgent: resolve (current or default) → mount inside unpublished setup.
 * A missing or failing preset service degrades to a preset-less session.
 */
async function resolvePreset(
  ctx: Context,
  agent: Agent,
  choice: PendingHandoff['choice'],
): Promise<{ id?: string; setup?: CreateAgentOptions['setup'] }> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return {}
  try {
    // An explicit model switch keeps the current session's preset (same
    // persona, different brain); only the global-default choice mounts the
    // deployment default preset.
    const from = choice.kind === 'default' ? undefined : presets.composedPreset(agent.ctx)
    const resolved = await presets.resolve(from)
    return {
      id: resolved.id,
      setup: async (agentCtx: Parameters<NonNullable<CreateAgentOptions['setup']>>[0]) => {
        await presets.mount(agentCtx, resolved.id)
      },
    }
  } catch (error) {
    ctx.logger(PACKAGE_NAME).warn('preset resolution failed; spawning without an explicit preset', { error: String(error) })
    return {}
  }
}

function titleFor(task: string): string {
  const tail = task.length > TITLE_TASK_LIMIT ? `${task.slice(0, TITLE_TASK_LIMIT)}…` : task
  return TITLE_PREFIX + tail
}

/**
 * Attach the fresh session to the workspace owning the origin cwd, so it
 * joins the origin's sidebar group — the same `attachSession` the web
 * "New Session" flow performs (prepend into the workspace's session order).
 * A cwd matching no registered workspace stays ungrouped, exactly like its
 * origin; an attach failure only downgrades grouping, never the handoff.
 */
async function attachToWorkspace(rt: HandoffRuntime, pending: PendingHandoff, sessionId: SessionId): Promise<void> {
  const registry = rt.ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    const workspace = await registry.resolveByPath(pending.cwd)
    if (workspace === undefined) return
    await workspace.attachSession(sessionId)
  } catch (error) {
    rt.ctx.logger(PACKAGE_NAME).warn('workspace attach failed; session stays ungrouped', { error: String(error) })
  }
}

/**
 * Create the fresh session and hand it the brief as its first turn.
 *
 * @returns the new session id.
 */
export async function spawnHandoff(rt: HandoffRuntime, pending: PendingHandoff, rawBrief: string): Promise<SessionId> {
  const { ctx } = rt
  const brief = (() => {
    const stripped = rawBrief.split(COMPLETE_MARKER)[0] ?? rawBrief
    const trimmed = stripped.trimEnd()
    if (trimmed.length <= rt.maxBriefChars) return trimmed
    return `${trimmed.slice(0, rt.maxBriefChars)}\n\n[handoff] 简报超长，已截断至 ${rt.maxBriefChars} 字符；完整内容见 ${pending.briefPath}`
  })()

  const sessionId = mintSessionId()
  const agentOptions = resolveAgentOptions(ctx, pending.agent, pending.choice)
  const preset = await resolvePreset(ctx, pending.agent, pending.choice)

  const handle: AgentHandle = await ctx.agents.create({
    sessionId,
    ...(agentOptions !== undefined ? { agentOptions } : {}),
    meta: {
      cwd: pending.cwd,
      ...(preset.id !== undefined ? { agentPreset: preset.id } : {}),
    },
    ...(preset.setup !== undefined ? { setup: preset.setup } : {}),
  })
  await attachToWorkspace(rt, pending, sessionId)

  handle.agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: bootstrapPrompt(pending, brief) }],
      source: { kind: 'user' },
    }),
  )

  try {
    ctx.get('sessionTitle')?.rename(handle.agent.session, titleFor(pending.task))
  } catch {
    // Title is cosmetic; the session itself is already running.
  }

  ctx.logger(PACKAGE_NAME).info('handoff session spawned', {
    origin: String(pending.agent.id),
    session: String(sessionId),
    briefPath: pending.briefPath,
    preset: preset.id ?? '(none)',
  })
  return sessionId
}
