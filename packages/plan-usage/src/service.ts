/**
 * The `planUsage` host service: quota windows for coding-plan provider
 * routes, read through one shared monitor (TTL cache keyed by endpoint+key so
 * every consumer — a waiting recovery owner, the Settings page — shares a
 * single upstream request per monitor).
 *
 * Registered as a Cordis service by dsh-plan-usage; consumers read it with
 * `ctx.get('planUsage')` and must treat `undefined` (plugin absent) as "no
 * quota data".
 *
 * @module dsh-plan-usage/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { SERVICE_NAME } from './identity.js'
import { QuotaMonitor } from './quota.js'
import type { MonitorConfig, ProviderMonitorSettings, QuotaSnapshot } from './quota.js'
import { monitoredProviders, resolveMonitor } from './quota.js'

/** Row configuration consumed by the service. */
export interface PlanUsageConfig {
  /** Quota fetch cache TTL (ms). */
  quotaCacheMs: number
  /** Per-provider monitor overrides/additions keyed by provider route. */
  providers: Record<string, ProviderMonitorSettings>
}

/** Read options accepted by {@link PlanUsageService.get}. */
export interface PlanUsageGetOptions {
  /** Serve from cache while younger than this (default: the row's TTL). */
  maxAgeMs?: number
  /** Bypass the cache for this read. */
  force?: boolean
}

export class PlanUsageService extends Service {
  private readonly config: PlanUsageConfig
  private readonly monitor: QuotaMonitor

  constructor(ctx: Context, config: PlanUsageConfig) {
    super(ctx, SERVICE_NAME)
    this.config = config
    this.monitor = new QuotaMonitor({ logger: ctx.logger })
  }

  /**
   * One provider's latest quota snapshot, or `undefined` when the route has
   * no resolvable monitor (unknown provider, or no API key in the env) or the
   * upstream fetch failed. Never throws.
   */
  async get(provider: string, options: PlanUsageGetOptions = {}): Promise<QuotaSnapshot | undefined> {
    const monitorConfig = this.monitorOf(provider)
    if (monitorConfig === undefined) return undefined
    return this.monitor.get(provider, monitorConfig, {
      maxAgeMs: options.maxAgeMs ?? this.config.quotaCacheMs,
      force: options.force,
    })
  }

  /** The monitor config a provider resolves to, when any. */
  monitorOf(provider: string): MonitorConfig | undefined {
    return resolveMonitor(provider, this.config.providers)
  }

  /** Whether the provider's monitor has a resolvable API key right now. */
  monitored(provider: string): boolean {
    const monitorConfig = this.monitorOf(provider)
    return monitorConfig !== undefined && this.monitor.apiKeyOf(monitorConfig) !== undefined
  }

  /** Every provider route this deployment monitors (built-ins + user config). */
  providers(): string[] {
    return monitoredProviders(this.config.providers)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by dsh-plan-usage; absent when that plugin is not mounted. */
    planUsage: PlanUsageService
  }
}
