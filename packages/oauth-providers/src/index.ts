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
import type { Context, Volatile } from '@deepseek-ai/cordis'
// Type-only imports: pull the `Context.authorization` /
// `Context.credentials` module augmentations in.
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-credentials'
import Schema from '@deepseek-ai/schemastery'
import { registerAuthChannel } from './channel.js'
import { OAuthProvidersService } from './service.js'
import { ChatGptConfig, registerChatGpt } from './providers/chatgpt/index.js'
import type { ChatGptConfig as ChatGptConfigShape } from './providers/chatgpt/index.js'
import { PACKAGE_NAME, PLUGIN_NAME, RPC_CHANNEL } from './identity.js'

export { PACKAGE_NAME, PLUGIN_NAME, RPC_CHANNEL } from './identity.js'
export { OAuthProvidersService } from './service.js'
export type { OAuthToken, TokenResolver } from './service.js'
export {
  PROVIDER as CHATGPT_PROVIDER,
  SETTINGS_NAMESPACE as CHATGPT_SETTINGS_NAMESPACE,
  DISPLAY_NAME as CHATGPT_DISPLAY_NAME,
} from './providers/chatgpt/index.js'

export const name = PLUGIN_NAME
// `authorization`, `connection`, and `webServer` are soft-injected at runtime
// (the channel and the flows wait for them), so compositions without a web
// server still load the provider routes. `settings` needs no inject in 0.2:
// the row's own Config schema is the settings form.
export const inject = ['llm', 'credentials']

/** Plugin-row config: one sub-object per provider module, live-editable. */
export interface Config {
  /** ChatGPT provider configuration. */
  chatgpt?: Volatile<ChatGptConfigShape>
}

// No `Schema<Config>` annotation: schemastery ≥ 3.18.4 types volatile modes
// into the schema generics, and an annotation would fight the inference the
// loader validates `Config` against.
export const Config = Schema.object({
  chatgpt: ChatGptConfig.volatile().description('ChatGPT provider configuration (the Settings page edits this section live).'),
})

export function apply(ctx: Context, config: Config): void {
  ctx.logger(PACKAGE_NAME).info('loaded')
  const channel = registerAuthChannel(ctx)
  const tokens = new OAuthProvidersService(ctx)
  registerChatGpt(ctx, { channel, tokens, config: () => config.chatgpt?.get() ?? {} })
}
