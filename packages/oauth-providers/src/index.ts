/**
 * dsh-oauth-providers — the home for OAuth-authenticated LLM providers.
 *
 * Each provider module under `src/providers/` registers its own LLM route,
 * settings namespace, and credential record, and shares this package's
 * browser sign-in channel (the pi-style "open this link, paste the code if
 * the redirect fails" login). Today that is the ChatGPT subscription
 * (`chatgpt`); adding a vendor is adding a provider module.
 *
 * The authorization seam this package's flows register on is not part of
 * every composition (the stock `web` profile ships without it), so this
 * bundle's `cordis.patch.yml` inserts a row mounting it; the plugin itself
 * soft-injects the seam and still loads without it.
 *
 * @module dsh-oauth-providers
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only imports: pull the `Context.settings` / `Context.authorization` /
// `Context.credentials` module augmentations in.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { registerAuthChannel } from './channel.js'
import { ChatGptConfig, registerChatGpt } from './providers/chatgpt/index.js'
import type { ChatGptConfig as ChatGptConfigShape } from './providers/chatgpt/index.js'
import { PACKAGE_NAME, PLUGIN_NAME, RPC_CHANNEL } from './identity.js'

export { PACKAGE_NAME, PLUGIN_NAME, RPC_CHANNEL } from './identity.js'
export {
  PROVIDER as CHATGPT_PROVIDER,
  SETTINGS_NAMESPACE as CHATGPT_SETTINGS_NAMESPACE,
  DISPLAY_NAME as CHATGPT_DISPLAY_NAME,
} from './providers/chatgpt/index.js'

export const name = PLUGIN_NAME
// `authorization`, `connection`, and `webServer` are soft-injected at runtime
// (the channel and the flows wait for them), so compositions without a web
// server still load the provider routes.
export const inject = ['llm', 'settings', 'credentials']

/** Plugin-row config: one sub-object per provider module. */
export interface Config {
  /** ChatGPT provider configuration. */
  chatgpt?: ChatGptConfigShape
}

export const Config: Schema<Config> = Schema.object({
  chatgpt: ChatGptConfig.description('ChatGPT provider configuration (base layer for its settings section).'),
})

export function apply(ctx: Context, config: Config): void {
  ctx.logger(PACKAGE_NAME).info('loaded')
  const channel = registerAuthChannel(ctx)
  registerChatGpt(ctx, { channel, base: config.chatgpt ?? {} })
}
