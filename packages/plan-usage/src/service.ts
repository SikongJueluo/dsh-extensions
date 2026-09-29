/**
 * The `planUsage` host service: quota windows for coding-plan provider
 * routes, aggregated from per-vendor sources behind one read API.
 *
 * Sources today: the GLM coding-plan monitor (z.ai / bigmodel, API key), the
 * OpenAI Codex usage endpoint (ChatGPT OAuth via the `oauthProviders`
 * service), and the MiniMax Token Plan endpoint (API key, both regions).
 * The provider routes surfaced are intersected with the process's live LLM
 * registry (`ctx.llm.listProviders()`, refreshed on `llm/adapters-updated`)
 * so the Settings page shows one card per route actually in use — the GLM
 * alias family collapses to the route the deployment configured.
 *
 * Registered as a Cordis service by dsh-plan-usage; consumers read it with
 * `ctx.get('planUsage')` and must treat `undefined` (plugin absent) as "no
 * quota data".
 *
 * @module dsh-plan-usage/service
 */
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from './shims.js'
import { SERVICE_NAME } from './identity.js'
import type { QuotaSnapshot } from './types.js'
import { MiniMaxSource } from './sources/minimax.js'
import { OpenAiUsageSource } from './sources/openai.js'
import { QuotaMonitor, monitoredProviders, resolveMonitor } from './sources/glm.js'
import type { ProviderMonitorSettings } from './sources/glm.js'

/** Row configuration consumed by the service. */
export interface PlanUsageConfig {
  /** Quota fetch cache TTL (ms). */
  quotaCacheMs: number
  /** Per-provider monitor overrides/additions keyed by provider route (GLM family). */
  providers: Record<string, ProviderMonitorSettings>
}

/** Read options accepted by {@link PlanUsageService.get}. */
export interface PlanUsageGetOptions {
  /** Serve from cache while younger than this (default: the row's TTL). */
  maxAgeMs?: number
  /** Bypass the cache for this read. */
  force?: boolean
}

/** One vendor quota source behind the service. */
interface QuotaSource {
  id: string
  /** Provider route ids this source serves. */
  readonly routes: readonly string[]
  /** Whether the route's credential is resolvable right now (sync). */
  ready(route: string): boolean
  /** One route's snapshot; `undefined` on any failure. Never throws. */
  get(route: string, options: { force?: boolean }): Promise<QuotaSnapshot | undefined>
}

/** GLM coding-plan monitor wrapped as a source (keeps its shared per-monitor cache). */
class GlmSource implements QuotaSource {
  readonly id = 'glm'
  readonly routes: string[]
  private readonly monitor: QuotaMonitor
  private readonly providersConfig: Record<string, ProviderMonitorSettings>
  private readonly quotaCacheMs: number

  constructor(config: PlanUsageConfig, logger: Context['logger']) {
    this.routes = monitoredProviders(config.providers)
    this.providersConfig = config.providers
    this.quotaCacheMs = config.quotaCacheMs
    this.monitor = new QuotaMonitor({ logger: { warn: (m, ...a) => logger.warn(m, ...a) } })
  }

  ready(route: string): boolean {
    const monitorConfig = resolveMonitor(route, this.providersConfig)
    return monitorConfig !== undefined && this.monitor.apiKeyOf(monitorConfig) !== undefined
  }

  get(route: string, options: { force?: boolean }): Promise<QuotaSnapshot | undefined> {
    const monitorConfig = resolveMonitor(route, this.providersConfig)
    if (monitorConfig === undefined) return Promise.resolve(undefined)
    return this.monitor.get(route, monitorConfig, { maxAgeMs: this.quotaCacheMs, force: options.force })
  }
}

interface CacheEntry {
  snapshot: QuotaSnapshot
  fetchedAt: number
}

export class PlanUsageService extends Service {
  private readonly sources: QuotaSource[]
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<QuotaSnapshot | undefined>>()
  /** Live LLM route ids, or undefined when the llm service is absent (show all). */
  private liveRoutes: string[] | undefined

  constructor(ctx: Context, config: PlanUsageConfig) {
    super(ctx, SERVICE_NAME)
    this.sources = [
      new GlmSource(config, ctx.logger),
      new OpenAiUsageSource({
        getToken: () => ctx.get('oauthProviders')?.token('chatgpt') ?? Promise.resolve(undefined),
        logger: { warn: (m, ...a) => ctx.logger.warn(m, ...a) },
      }),
      new MiniMaxSource({ logger: { warn: (m, ...a) => ctx.logger.warn(m, ...a) } }),
    ]
    this.refreshLiveRoutes()
    ctx.on('llm/adapters-updated', () => this.refreshLiveRoutes())
  }

  /** Re-read the live provider registry (also on every adapter topology change). */
  private refreshLiveRoutes(): void {
    const llm = this.ctx.get('llm')
    this.liveRoutes = llm === undefined ? undefined : llm.listProviders().map((info) => info.id)
  }

  /** The source serving one route, when any. */
  private sourceOf(route: string): QuotaSource | undefined {
    return this.sources.find((source) => source.routes.includes(route))
  }

  /**
   * Provider routes worth surfacing: every known source route, intersected
   * with the live LLM registry when that is available. The GLM alias family
   * (zai-coding-cn / glm / zai / …) collapses to the configured route.
   */
  providers(): string[] {
    const known = new Set(this.sources.flatMap((source) => source.routes))
    const live = this.liveRoutes
    const routes = live === undefined ? [...known] : [...known].filter((route) => live.includes(route))
    return routes.sort()
  }

  /** The id of the source serving one route (for error copy), when any. */
  sourceId(route: string): string | undefined {
    return this.sourceOf(route)?.id
  }

  /** Whether the route has a resolvable credential right now. */
  monitored(route: string): boolean {
    return this.sourceOf(route)?.ready(route) ?? false
  }

  /**
   * One provider's latest quota snapshot, or `undefined` when no source
   * serves the route, its credential is missing, or the upstream fetch
   * failed. Cached per route (shared by waiting recovery agents and the
   * Settings page); `force` bypasses the cache. Never throws.
   */
  async get(provider: string, options: PlanUsageGetOptions = {}): Promise<QuotaSnapshot | undefined> {
    const source = this.sourceOf(provider)
    if (source === undefined) return undefined
    const maxAgeMs = options.maxAgeMs ?? 60_000
    const key = `${source.id}:${provider}`
    const cached = this.cache.get(key)
    if (!options.force && cached !== undefined && Date.now() - cached.fetchedAt < maxAgeMs) {
      return cached.snapshot
    }
    if (!options.force) {
      const pending = this.inflight.get(key)
      if (pending !== undefined) return pending
    }
    const attempt = source.get(provider, { force: options.force })
      .then((snapshot) => {
        if (snapshot !== undefined) this.cache.set(key, { snapshot, fetchedAt: snapshot.fetchedAt })
        return snapshot
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, attempt)
    return attempt
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provided by dsh-plan-usage; absent when that plugin is not mounted. */
    planUsage: PlanUsageService
  }
}
