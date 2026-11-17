import type { Context, Volatile } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const JUDGE_OUTPUT_TOKENS = {
  default: 8192,
  min: 256,
  max: 32768,
} as const

export interface AutoPermitSettings {
  enabled: boolean

  provider: string

  model: string

  reasoningEffort?: string

  maxOutputTokens?: number
}

export interface Config {
  enabled: Volatile<boolean>
  provider: Volatile<string>
  model: Volatile<string>
  reasoningEffort?: Volatile<string | undefined>
  maxOutputTokens: Volatile<number>
}

export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .volatile()
    .description(
      'Master switch. With no judge route configured the plugin never claims an approval.',
    ),
  provider: Schema.string()
    .default('')
    .volatile()
    .description('Judge model provider (llm route id). Configure from the Web Settings page.'),
  model: Schema.string()
    .default('')
    .volatile()
    .description('Judge model id. Configure from the Web Settings page.'),
  reasoningEffort: Schema.string()
    .volatile()
    .description('Optional reasoning effort for the judge model.'),
  maxOutputTokens: Schema.natural()
    .min(JUDGE_OUTPUT_TOKENS.min)
    .max(JUDGE_OUTPUT_TOKENS.max)
    .default(JUDGE_OUTPUT_TOKENS.default)
    .volatile()
    .description(
      'Output-token budget for each judge model request. Reasoning tokens count toward it.',
    ),
})

export function registerSettings(_ctx: Context, config: Config): () => AutoPermitSettings {
  return () => ({
    enabled: config.enabled.get(),
    provider: config.provider.get(),
    model: config.model.get(),
    reasoningEffort: config.reasoningEffort?.get(),
    maxOutputTokens: config.maxOutputTokens.get(),
  })
}

export function routeConfigured(settings: AutoPermitSettings): boolean {
  return settings.enabled && settings.provider !== '' && settings.model !== ''
}
