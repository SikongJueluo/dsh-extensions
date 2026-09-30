/**
 * The judge route configuration (dsh 0.2 settings model).
 *
 * The row's `Config` schema IS the Settings form now: `@deepseek-ai/dsh-settings`
 * projects every live plugin entry's schema automatically (0.1's
 * `settings.installSection` is gone), so the judge route is editable from the
 * Web Settings page by editing this plugin's own row — namespace `auto-permit`,
 * the bundle patch's entry id. Every field is `volatile()`, so a Settings edit
 * commits into the running fiber without a remount; `registerSettings` reads
 * the live values through the `Volatile` references.
 *
 * The judge model is deliberately REQUIRED and has no "follow the session
 * model" fallback: a judge must not be the model it audits.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** Resolved judge configuration (live row config). */
export interface AutoPermitSettings {
  /** Master switch; an unconfigured route is treated as disabled regardless. */
  enabled: boolean
  /** Judge route provider id (an llm adapter route); empty = not configured. */
  provider: string
  /** Judge model id on that provider; empty = not configured. */
  model: string
  /** Optional adapter-owned reasoning effort for the judge model. */
  reasoningEffort?: string
}

/** Plugin-row configuration; the Settings form edits these fields live. */
export interface Config {
  enabled: Volatile<boolean>
  provider: Volatile<string>
  model: Volatile<string>
  reasoningEffort?: Volatile<string | undefined>
}

// No `Schema<Config>` annotation: schemastery ≥ 3.18.4 types volatile modes
// into the schema generics, and an annotation would fight the inference the
// loader validates `Config` against.
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile().description(
    'Master switch. With no judge route configured the plugin never claims an approval.',
  ),
  provider: Schema.string().default('').volatile().description(
    'Judge model provider (llm route id). Configure from the Web Settings page.',
  ),
  model: Schema.string().default('').volatile().description(
    'Judge model id. Configure from the Web Settings page.',
  ),
  reasoningEffort: Schema.string().volatile().description(
    'Optional reasoning effort for the judge model.',
  ),
})

/**
 * Return the live judge-route reader.
 *
 * @param ctx - plugin context.
 * @param config - composition row config (volatile live references).
 * @returns a thunk reading the currently authoritative settings value.
 */
export function registerSettings(_ctx: Context, config: Config): () => AutoPermitSettings {
  return () => ({
    enabled: config.enabled.get(),
    provider: config.provider.get(),
    model: config.model.get(),
    reasoningEffort: config.reasoningEffort?.get(),
  })
}

/** True when the settings resolve to a usable judge route. */
export function routeConfigured(settings: AutoPermitSettings): boolean {
  return settings.enabled && settings.provider !== '' && settings.model !== ''
}
