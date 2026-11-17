/**
 * dsh-plan-usage - coding-plan quota windows as a host service + Settings section.
 * @module dsh-plan-usage
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { PLUGIN_NAME } from './identity.js'
import type { ProviderMonitorSettings } from './sources/glm.js'
import type { CommandCodeMonitorSettings } from './sources/commandcode.js'
import { PlanUsageService } from './service.js'
import { registerChannel } from './channel.js'

export { PACKAGE_NAME, PLUGIN_NAME, SERVICE_NAME } from './identity.js'
export { QuotaMonitor, parseQuotaBody, resolveMonitor, monitoredProviders } from './sources/glm.js'
export { OpenAiUsageSource, parseCodexUsage } from './sources/openai.js'
export { MiniMaxSource, parseMiniMaxRemains, consumedFromRemaining } from './sources/minimax.js'
export { OpenCodeGoSource, parseOpenCodeGoUsage } from './sources/opencode.js'
export {
  CommandCodeSource,
  parseCommandCodeCredits,
  COMMAND_CODE_API_BASE,
} from './sources/commandcode.js'
export type { OpenCodeGoWindows, OpenCodeGoError } from './sources/opencode.js'
export type {
  CommandCodeWindows,
  CommandCodeError,
  CommandCodeMonitorSettings,
} from './sources/commandcode.js'
export type { ProviderMonitorSettings, MonitorConfig } from './sources/glm.js'
export type { QuotaSnapshot, QuotaWindow } from './types.js'
export { PlanUsageService } from './service.js'
export type { PlanUsageConfig, PlanUsageGetOptions } from './service.js'

/** Plugin-row configuration. */
export interface Config {
  quotaCacheMs: number
  providers: Record<string, ProviderMonitorSettings>
  commandCode?: CommandCodeMonitorSettings
}

export const Config: Schema<Config> = Schema.object({
  quotaCacheMs: Schema.number()
    .step(1)
    .min(5_000)
    .default(60_000)
    .description('Quota API cache TTL shared by every consumer (ms).'),
  providers: Schema.dict(
    Schema.object({
      monitorBaseUrl: Schema.string().description(
        "Monitor origin for this provider, e.g. https://open.bigmodel.cn (default: the route's built-in).",
      ),
      apiKeyEnv: Schema.string().description(
        "Env var holding the API key for the quota endpoint (default: the route's built-ins).",
      ),
    }),
  )
    .default({})
    .description(
      'Per-provider quota monitors; keys are provider route ids (built-ins cover the GLM coding-plan routes).',
    ),
  commandCode: Schema.object({
    apiKeyEnv: Schema.string().description(
      'Env var holding the Command Code API key; CMD_API_KEY / COMMAND_CODE_API_KEY are still tried after it.',
    ),
    baseURL: Schema.string().description(
      'Command Code API origin override (default: https://api.commandcode.ai).',
    ),
  })
    .default({})
    .description('Command Code quota monitor overrides.'),
})

export const name = PLUGIN_NAME
export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  const service = new PlanUsageService(ctx, config)
  registerChannel(ctx, service)
}
