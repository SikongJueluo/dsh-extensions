/**
 * dsh-plan-usage — coding-plan quota windows as a host service + Settings
 * section.
 *
 * Reads the GLM coding plan's 5h / weekly / monthly-MCP windows from the
 * z.ai / bigmodel subscription monitor API through one shared TTL cache, and
 * publishes them two ways:
 *
 * - the `planUsage` Cordis service (`ctx.get('planUsage')`) for host
 *   consumers — dsh-auto-continue uses it to sleep until a reported reset;
 * - a Settings section (client/client.js) showing the bars with reset
 *   countdowns, reading through this package's own channel
 *   (`/dsh-plan-usage/quota`).
 *
 * Consumed host services: none injected — the channel soft-injects
 * connection + webServer once those exist.
 *
 * @module dsh-plan-usage
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
import type { ProviderMonitorSettings } from './sources/glm.js'
import { PlanUsageService } from './service.js'
import { registerChannel } from './channel.js'

export { PACKAGE_NAME, PLUGIN_NAME, SERVICE_NAME } from './identity.js'
export { QuotaMonitor, parseQuotaBody, resolveMonitor, monitoredProviders } from './sources/glm.js'
export { OpenAiUsageSource, parseCodexUsage } from './sources/openai.js'
export { MiniMaxSource, parseMiniMaxRemains, consumedFromRemaining } from './sources/minimax.js'
export type { ProviderMonitorSettings, MonitorConfig } from './sources/glm.js'
export type { QuotaSnapshot, QuotaWindow } from './types.js'
export { PlanUsageService } from './service.js'
export type { PlanUsageConfig, PlanUsageGetOptions } from './service.js'

/** Plugin-row configuration. */
export interface Config {
  /** Quota fetch cache TTL (ms). */
  quotaCacheMs: number
  /** Per-provider monitor overrides/additions (monitorBaseUrl / apiKeyEnv). */
  providers: Record<string, ProviderMonitorSettings>
}

export const Config: Schema<Config> = Schema.object({
  quotaCacheMs: Schema.number().step(1).min(5_000)
    .default(60_000)
    .description('Quota API cache TTL shared by every consumer (ms).'),
  providers: Schema.dict(Schema.object({
    monitorBaseUrl: Schema.string()
      .description('Monitor origin for this provider, e.g. https://open.bigmodel.cn (default: the route\'s built-in).'),
    apiKeyEnv: Schema.string()
      .description('Env var holding the API key for the quota endpoint (default: the route\'s built-ins).'),
  })).default({})
    .description('Per-provider quota monitors; keys are provider route ids (built-ins cover the GLM coding-plan routes).'),
})

export const name = PLUGIN_NAME
export const inject: string[] = []

export function apply(ctx: Context, config: Config): void {
  const service = new PlanUsageService(ctx, config)
  registerChannel(ctx, service)
}
