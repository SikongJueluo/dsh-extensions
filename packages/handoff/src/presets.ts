/**
 * Agent-preset selection for the fresh session.
 *
 * A preset is a declared composition (tools, prompts, behavior), independent
 * of the model route. Every handoff therefore carries two separate intents:
 * which model to run on, and which preset to mount. The default preset is the
 * one the ORIGIN session actually runs live — not the deployment default, and
 * not the preset a previous handoff used.
 *
 * A preset-free origin stays preset-free: `resolve(undefined)` means the
 * deployment default, so passing the inherited value through untouched would
 * silently compose a preset the origin never had.
 *
 * @module dsh-handoff/presets
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import type { PresetChoice } from './brief.js'
import { PACKAGE_NAME } from './identity.js'

/** One registered preset as a picker shows it. */
export interface PresetOption {
  readonly id: string
  readonly name?: string
  readonly description?: string
  /** Non-empty when the preset cannot compose a session right now. */
  readonly broken?: string
}

/** The preset roster relevant to one origin session. */
export interface PresetRoster {
  /** The preset the origin session runs live; absent when it runs none. */
  readonly inherited?: string
  readonly options: readonly PresetOption[]
}

/** What the spawn path mounts into the fresh session. */
export interface MountedPreset {
  readonly id?: string
  readonly setup?: CreateAgentOptions['setup']
}

/** Human name of one roster row, falling back to its id. */
export function presetName(roster: PresetRoster | undefined, id: string): string {
  const row = roster?.options.find((option) => option.id === id)
  return row?.name ?? id
}

/**
 * Snapshot the registry for the picker. A missing or failing registry is not
 * an error: the handoff then has no preset choice, exactly like a composition
 * without presets.
 */
export async function snapshotPresets(ctx: Context, agent: Agent): Promise<PresetRoster | undefined> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) return undefined
  try {
    const inherited = presets.composedPreset(agent.ctx)
    const rows = (await presets.list()).slice().sort((left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id))
    const options = rows
      .map((row): PresetOption => ({
        id: row.id,
        ...(row.name === undefined ? {} : { name: row.name }),
        ...(row.description === undefined ? {} : { description: row.description }),
        ...(row.broken === undefined ? {} : { broken: row.broken }),
      }))
    return {
      ...(inherited === undefined ? {} : { inherited }),
      options,
    }
  } catch (error) {
    ctx.logger(PACKAGE_NAME).warn('preset roster unavailable; handoff falls back to no preset choice', {
      error: String(error),
    })
    return undefined
  }
}

/**
 * Why a preset intent cannot be mounted as-is, or `undefined` when it can.
 * Used before any briefing turn so a deleted or broken preset never waits for
 * a completed brief before failing, and by the picker to demand a reselect.
 */
export function presetProblem(roster: PresetRoster, choice: PresetChoice): string | undefined {
  if (choice.kind === 'inherit') {
    if (roster.inherited === undefined) return undefined
    const row = roster.options.find((option) => option.id === roster.inherited)
    if (row === undefined) return `当前会话的预设已不在注册表中：${roster.inherited}`
    if (row.broken !== undefined) return `当前会话的预设当前不可用：${row.name ?? row.id}（${row.broken}）`
    return undefined
  }
  const row = roster.options.find((option) => option.id === choice.id)
  if (row === undefined) return `所选预设已不在注册表中：${choice.id}`
  if (row.broken !== undefined) return `所选预设当前不可用：${row.name ?? row.id}（${row.broken}）`
  return undefined
}

/**
 * Resolve and mount the preset inside the unpublished agent setup, mirroring
 * the session controller's own create flow. Unlike that flow, an undefined
 * inherited id stays undefined (no preset) instead of resolving the
 * deployment default, and a rejected preset is an error rather than a silent
 * preset-less session.
 */
export async function mountedPreset(
  ctx: Context,
  agent: Agent,
  choice: PresetChoice,
): Promise<MountedPreset> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    if (choice.kind === 'preset') throw new Error(`当前组合没有预设注册表，无法挂载预设 ${choice.id}`)
    // Inherit cannot be resolved without the registry; a preset-less session
    // is the only available degradation, and this line makes it diagnosable.
    ctx.logger(PACKAGE_NAME).warn('no preset registry; spawning a preset-less session')
    return {}
  }
  const target = choice.kind === 'preset' ? choice.id : presets.composedPreset(agent.ctx)
  if (target === undefined) return {}
  let resolved: { id: string; name?: string; broken?: string }
  try {
    resolved = await presets.resolve(target)
  } catch (error) {
    throw new Error(`无法解析预设 ${target}：${error instanceof Error ? error.message : String(error)}`)
  }
  if (resolved.broken !== undefined) {
    throw new Error(`预设 ${resolved.name ?? resolved.id} 当前不可用：${resolved.broken}`)
  }
  const id = resolved.id
  return {
    id,
    setup: async (agentCtx: Parameters<NonNullable<CreateAgentOptions['setup']>>[0]) => {
      await presets.mount(agentCtx, id)
    },
  }
}
