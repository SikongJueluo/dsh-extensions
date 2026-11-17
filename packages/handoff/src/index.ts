/**
 * dsh-handoff - one-command session handoff.
 * @module dsh-handoff
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_BRIEF_DIR, PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
import { handoffCommandDefinition } from './command.js'
import { registerHandoffChannel } from './channel.js'
import { createPreferenceStore } from './preferences.js'
import type { HandoffRuntime } from './pending.js'

export { PACKAGE_NAME, PLUGIN_NAME, COMMAND_NAME } from './identity.js'

export const name = PLUGIN_NAME
export const inject = ['commands', 'agents']

/** Plugin-row configuration. */
export interface Config {
  dir?: string
  timeoutMs?: number
  pollMs?: number
  confirm?: boolean
  modelMenu?: boolean
  pickTimeoutMs?: number
  notifyFailure?: boolean
  maxBriefChars?: number
}

export const Config: Schema<Config> = Schema.object({
  dir: Schema.string()
    .default(DEFAULT_BRIEF_DIR)
    .description('Brief directory; relative paths resolve against the session workspace cwd.'),
  timeoutMs: Schema.number()
    .step(1)
    .min(1000)
    .default(600_000)
    .description('How long to wait for the completion marker before failing the handoff (ms).'),
  pollMs: Schema.number()
    .step(1)
    .min(100)
    .default(1000)
    .description('Brief file poll interval (ms).'),
  confirm: Schema.boolean()
    .default(true)
    .description('Ask the model question (and allow cancelling) before starting the handoff.'),
  modelMenu: Schema.boolean()
    .default(true)
    .description(
      'Enumerate every provider/model route in the dialog; slow providers degrade to base options + custom input.',
    ),
  pickTimeoutMs: Schema.number()
    .step(1)
    .min(5000)
    .default(120_000)
    .description(
      'How long the browser model picker may stay open before the command gives up (ms).',
    ),
  notifyFailure: Schema.boolean()
    .default(true)
    .description('On failure, queue a visible notice turn on the origin session.'),
  maxBriefChars: Schema.number()
    .step(1)
    .min(1024)
    .default(65_536)
    .description('Brief truncation guard for the first prompt (chars).'),
})

export function apply(ctx: Context, config: Config): void {
  const preferences = createPreferenceStore(ctx)
  ctx.effect(() => () => {
    void preferences.close().catch(() => {})
  })
  const rt: HandoffRuntime = {
    ctx,
    config,
    maxBriefChars: config.maxBriefChars ?? 65_536,
    timeoutMs: config.timeoutMs ?? 600_000,
    pollMs: config.pollMs ?? 1000,
    pickTimeoutMs: config.pickTimeoutMs ?? 120_000,
    notifyFailure: config.notifyFailure !== false,
    pending: new Map(),
    channel: registerHandoffChannel(ctx),
    preferences,
  }
  ctx.commands.register(handoffCommandDefinition(rt))
  ctx.logger(PACKAGE_NAME).info('loaded', { dir: rt.config.dir })
}
