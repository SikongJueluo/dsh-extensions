/**
 * dsh-handoff — one-command session handoff.
 *
 * `/handoff <task>` asks the CURRENT session to write a self-contained brief
 * to `<cwd>/.dsh/handoff/<timestamp>-handoff.md` (completion-marked), then
 * spawns a FRESH session in the same workspace via `ctx.agents.create` —
 * the same factory chain the Web "New Session" button uses — with the brief
 * as its first prompt. No skill, no manual context hauling.
 *
 * Consumed host services: `commands` + `agents` (hard inject), and optionally
 * `userQuestions` (confirmation card), `agentPresets`, `agentDefaultModel`,
 * and `sessionTitle` via `ctx.get()`.
 *
 * @module dsh-handoff
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'
import { COMMAND_NAME, DEFAULT_BRIEF_DIR, PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
import { handoffCommandDefinition } from './command.js'
import type { HandoffRuntime } from './brief.js'

export { PACKAGE_NAME, PLUGIN_NAME, COMMAND_NAME } from './identity.js'

export const name = PLUGIN_NAME
// The command registry and the agent factory are both host-core; the plugin
// is useless without either, so it waits for them.
export const inject = ['commands', 'agents']

/** Plugin-row configuration. */
export interface Config {
  /** Brief directory; relative paths resolve against the session's workspace cwd. */
  dir?: string
  /** How long to wait for the completion marker before failing the handoff. */
  timeoutMs?: number
  /** Brief file poll interval. */
  pollMs?: number
  /** Ask the preset/model question before starting the handoff. */
  confirm?: boolean
  /** On failure, queue a visible notice turn on the origin session. */
  notifyFailure?: boolean
  /** Brief truncation guard for the first prompt (chars). */
  maxBriefChars?: number
}

export const Config: Schema<Config> = Schema.object({
  dir: Schema.string()
    .default(DEFAULT_BRIEF_DIR)
    .description('Brief directory; relative paths resolve against the session workspace cwd.'),
  timeoutMs: Schema.number().step(1).min(1000)
    .default(300_000)
    .description('How long to wait for the completion marker before failing the handoff (ms).'),
  pollMs: Schema.number().step(1).min(100)
    .default(1000)
    .description('Brief file poll interval (ms).'),
  confirm: Schema.boolean()
    .default(true)
    .description('Ask the preset/model question (and allow cancelling) before starting the handoff.'),
  notifyFailure: Schema.boolean()
    .default(true)
    .description('On failure, queue a visible notice turn on the origin session.'),
  maxBriefChars: Schema.number().step(1).min(1024)
    .default(65_536)
    .description('Brief truncation guard for the first prompt (chars).'),
})

export function apply(ctx: Context, config: Config): void {
  const rt: HandoffRuntime = {
    ctx,
    config,
    maxBriefChars: config.maxBriefChars ?? 65_536,
    timeoutMs: config.timeoutMs ?? 300_000,
    pollMs: config.pollMs ?? 1000,
    notifyFailure: config.notifyFailure !== false,
    pending: new Map(),
  }
  ctx.commands.register(handoffCommandDefinition(rt))
  ctx.logger(PACKAGE_NAME).info('loaded', { dir: rt.config.dir })
}
