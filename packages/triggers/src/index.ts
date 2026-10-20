/**
 * dsh-triggers — structured handoff signals between two bound sessions.
 *
 * One execute-review loop in one rule group: the executor ends its round by
 * calling `trigger_signal`, the run advances only when that turn ends
 * normally, and the counterpart receives the next prompt through the session
 * controller's queue (with a persisted, idempotent requestId). Rounds are
 * budgeted; pass / needs_user / budget-edge rework are the stop semantics.
 *
 * Consumed host services: `tools` + `sessionController` + `storageDomain`
 * (hard inject); `connection` + `webServer` (soft, for the browser channel).
 * Publishes the optional `triggerBindings` service for dsh-handoff.
 *
 * @module dsh-triggers
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
import { TriggerService } from './service.js'
import { registerSignalTool } from './tool.js'
import { registerTriggerChannel } from './channel.js'

export { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
export * from './model.js'
export * from './engine.js'
export { BUILTIN_TEMPLATE_BODIES, TEMPLATE_VARIABLES, composeDeliveryPrompt } from './prompts.js'
export { TriggerService, type BindReviewLoopRequest, type TriggerBindingsService, type TriggerConfig, type TriggerSnapshot, type SessionRow } from './service.js'
export { registerSignalTool } from './tool.js'

export const name = PLUGIN_NAME
// The loop is dead without the tool registry, the queue, or durable storage.
export const inject = ['tools', 'sessionController', 'storageDomain']

/** Plugin-row configuration. */
export interface Config {
  /** Budget for one queue-prompt send before the delivery is marked failed (ms). */
  deliverTimeoutMs?: number
}

export const Config = Schema.object({
  deliverTimeoutMs: Schema.number().step(1).min(5_000)
    .default(120_000)
    .description('Budget for one queued prompt send before the delivery is marked failed and the run parked (ms).'),
})

export function apply(ctx: Context, config: Config): void {
  const service = new TriggerService(ctx, config)
  ctx.effect(() => registerSignalTool(ctx, service), 'triggers: signal tool')
  registerTriggerChannel(ctx, service)
  ctx.effect(() => () => {
    void service.shutdown()
  }, 'triggers: domain close')
  ctx.logger(PACKAGE_NAME).info('loaded', { deliverTimeoutMs: config.deliverTimeoutMs ?? 120_000 })
}
