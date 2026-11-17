/**
 * Fresh-session spawn: the same factory chain the Web "New Session" button uses (`ctx.agents.create` with a mounted preset), plus the first prompt.
 * @module dsh-handoff/spawn
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-title'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { debugQuietly, errorTag, warnQuietly } from './diagnostics.js'
import { COMPLETE_MARKER, PACKAGE_NAME } from './identity.js'
import { bootstrapPrompt } from './prompt.js'
import type { HandoffRuntime, PendingHandoff } from './pending.js'
import { markSpawned, metaPathFor, writeReviewBound } from './meta.js'
import { targetBriefDir } from './workspace.js'
import { defaultRoute, sessionRoute, toAgentOptions } from './selection.js'
import { mountedPreset } from './presets.js'

const TITLE_PREFIX = 'Handoff: '
const TITLE_TASK_LIMIT = 40

/** Mint a fresh session identity (the brand is compile-time only). */
function mintSessionId(): SessionId {
  return SessionId(crypto.randomUUID())
}

/** Copy the origin agent's model route into creation options (defined fields only). */
function inheritAgentOptions(ctx: Context, agent: Agent): AgentOptions | undefined {
  const route = sessionRoute(agent)
  const options = toAgentOptions(route)
  if (options === undefined) return undefined
  const maxTokens = agent.options.maxTokens
  return maxTokens === undefined ? options : { ...options, maxTokens }
}

/** Resolve the agent options for the fresh session per the confirmed choice. */
function resolveAgentOptions(
  ctx: Context,
  agent: Agent,
  choice: PendingHandoff['choice'],
): AgentOptions | undefined {
  if (choice.kind === 'model') {
    return toAgentOptions({
      provider: choice.provider,
      model: choice.model,
      ...(choice.reasoningEffort === undefined ? {} : { reasoningEffort: choice.reasoningEffort }),
    })
  }
  if (choice.kind === 'default') {
    return toAgentOptions(defaultRoute(ctx))
  }
  return inheritAgentOptions(ctx, agent)
}

async function rememberModel(rt: HandoffRuntime, pending: PendingHandoff): Promise<void> {
  if (!pending.rememberModel || rt.preferences === undefined) return
  try {
    const stored = await rt.preferences.write(pending.choice)
    if (!stored) {
      rt.ctx.logger(PACKAGE_NAME).info('no storage domain; handoff model preference not remembered')
    }
  } catch (error) {
    rt.ctx
      .logger(PACKAGE_NAME)
      .warn('handoff model preference write failed', { error: String(error) })
    notifyOrigin(
      rt,
      pending,
      '[handoff] 本次选择未记住（偏好写入失败）。下次交接仍使用之前记住的模型。',
    )
  }
}

function titleFor(task: string): string {
  const tail = task.length > TITLE_TASK_LIMIT ? `${task.slice(0, TITLE_TASK_LIMIT)}…` : task
  return TITLE_PREFIX + tail
}

async function attachToWorkspace(
  rt: HandoffRuntime,
  pending: PendingHandoff,
  sessionId: SessionId,
): Promise<void> {
  const registry = rt.ctx.get('workspaceRegistry')
  if (registry === undefined) return
  try {
    let workspace: Awaited<ReturnType<typeof registry.resolveByPath>> = undefined
    if (pending.target.workspaceId !== undefined) {
      workspace = registry.get(WorkspaceId(pending.target.workspaceId))
    } else {
      workspace = await registry.resolveByPath(pending.target.path)
    }
    if (workspace === undefined) return
    await workspace.attachSession(sessionId)
  } catch (error) {
    rt.ctx
      .logger(PACKAGE_NAME)
      .warn('workspace attach failed; session stays ungrouped', { error: String(error) })
  }
}

/** Guard the spawn against a target that vanished between the pick and the brief's completion: `agents.create` itself accepts any absolute cwd, but a session rooted in a missing directory would be unusable. */
async function preflightTarget(rt: HandoffRuntime, pending: PendingHandoff): Promise<void> {
  if (pending.target.workspaceId === undefined) return
  const registry = rt.ctx.get('workspaceRegistry')
  if (registry === undefined) return
  const workspace = registry.get(WorkspaceId(pending.target.workspaceId))
  if (workspace === undefined) {
    throw new Error(`目标工作区已不在注册表中：${pending.target.title} (${pending.target.path})`)
  }
  if ((await workspace.status()) !== 'ok') {
    throw new Error(`目标工作区目录已不存在：${pending.target.title} (${pending.target.path})`)
  }
}

/** Copy the full brief into the target workspace (host-side write, so no sandbox applies) so the successor always has a readable local copy - the origin side may be a per-branch workspace directory that gets cleaned up. Failures degrade to referencing the origin file, which stays readable. */
async function copyBriefToTarget(
  rt: HandoffRuntime,
  pending: PendingHandoff,
  full: string,
): Promise<string | undefined> {
  if (!pending.crossWorkspace) return undefined
  const dir = targetBriefDir(rt.config.dir, pending.target)
  const path = `${dir}/${basename(pending.briefPath)}`
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, `${full}\n`, 'utf8')
    return path
  } catch (error) {
    rt.ctx
      .logger(PACKAGE_NAME)
      .warn('cross-workspace brief copy failed; referencing the origin file', {
        error: String(error),
        path,
      })
    return undefined
  }
}

async function bindReview(
  rt: HandoffRuntime,
  pending: PendingHandoff,
  sessionId: string,
): Promise<{ runId: string; maxRounds: number } | undefined> {
  const triggers = rt.ctx.get('triggerBindings')
  const maxRounds = pending.review?.maxRounds ?? 5
  if (pending.review === undefined) return undefined
  if (triggers === undefined) {
    rt.ctx
      .logger(PACKAGE_NAME)
      .warn('auto-review requested but dsh-triggers is not mounted; spawning a plain handoff')
    notifyOrigin(
      rt,
      pending,
      '[handoff] 已按普通交接执行：请求了自动审核，但未挂载 dsh-triggers 插件。',
    )
    return undefined
  }
  try {
    const bound = await triggers.bindReviewLoop({
      task: pending.task,
      executorSession: sessionId,
      parentSession: String(pending.agent.id),
      maxRounds,
      autoDeliver: true,
    })
    await writeReviewBound(
      metaPathFor(pending.briefPath),
      {
        bindingId: bound.bindingId,
        runId: bound.runId,
        maxRounds,
      },
      rt.ctx.logger(PACKAGE_NAME),
    )
    rt.ctx.logger(PACKAGE_NAME).info('auto-review loop bound', {
      bindingId: bound.bindingId,
      runId: bound.runId,
      executor: sessionId,
      parent: String(pending.agent.id),
      maxRounds,
    })
    return { runId: bound.runId, maxRounds }
  } catch (error) {
    rt.ctx
      .logger(PACKAGE_NAME)
      .warn('auto-review bind failed; spawning a plain handoff', { error: String(error) })
    notifyOrigin(
      rt,
      pending,
      `[handoff] 自动审核绑定失败（${String(error)}），本次按普通交接执行。`,
    )
    return undefined
  }
}

/** Queue one visible notice line on the origin session (best effort). */
function notifyOrigin(rt: HandoffRuntime, pending: PendingHandoff, text: string): void {
  try {
    pending.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
  } catch (error) {
    warnQuietly(
      rt.ctx.logger(PACKAGE_NAME),
      'handoff notice not delivered for %s (%s)',
      pending.briefPath,
      errorTag(error),
    )
  }
}

/**
 * Create the fresh session and hand it the brief as its first turn.
 * @returns the new session id.
 */
export async function spawnHandoff(
  rt: HandoffRuntime,
  pending: PendingHandoff,
  rawBrief: string,
): Promise<SessionId> {
  const { ctx } = rt
  await preflightTarget(rt, pending)
  const stripped = rawBrief.split(COMPLETE_MARKER)[0] ?? rawBrief
  const full = stripped.trimEnd()
  const copiedPath = await copyBriefToTarget(rt, pending, full)
  const briefRef = copiedPath ?? pending.briefPath
  const brief =
    full.length <= rt.maxBriefChars
      ? full
      : `${full.slice(0, rt.maxBriefChars)}\n\n[handoff] 简报超长，已截断至 ${rt.maxBriefChars} 字符；完整内容见 ${briefRef}`

  const sessionId = mintSessionId()
  const agentOptions = resolveAgentOptions(ctx, pending.agent, pending.choice)
  const preset = await mountedPreset(ctx, pending.agent, pending.preset)

  const handle: AgentHandle = await ctx.agents.create({
    sessionId,
    ...(agentOptions !== undefined ? { agentOptions } : {}),
    meta: {
      cwd: pending.target.path,
      ...(preset.id !== undefined ? { agentPreset: preset.id } : {}),
    },
    ...(preset.setup !== undefined ? { setup: preset.setup } : {}),
  })
  await markSpawned(metaPathFor(pending.briefPath))
  await rememberModel(rt, pending)
  await attachToWorkspace(rt, pending, sessionId)
  const review = await bindReview(rt, pending, sessionId)

  handle.agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: bootstrapPrompt(pending, brief, review) }],
      source: { kind: 'user' },
    }),
  )

  try {
    ctx.get('sessionTitle')?.rename(handle.agent.session, titleFor(pending.task))
  } catch (error) {
    debugQuietly(
      ctx.logger(PACKAGE_NAME),
      'handoff session title not set for %s (%s)',
      String(sessionId),
      errorTag(error),
    )
  }

  ctx.logger(PACKAGE_NAME).info('handoff session spawned', {
    origin: String(pending.agent.id),
    session: String(sessionId),
    briefPath: pending.briefPath,
    ...(copiedPath === undefined ? {} : { briefCopy: copiedPath }),
    target: pending.target.path,
    preset: preset.id ?? '(none)',
  })
  return sessionId
}
