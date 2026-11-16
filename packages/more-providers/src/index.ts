/**
 * YAML-configured API-key routes and default-on OAuth providers.
 * Both adapter families receive the same request-time host image services.
 * Invalid startup configuration registers no provider routes.
 * @module dsh-more-providers
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { registerConfig, registerConfigStatusRoute } from '@dsh-extensions/config'
import { ConfigError, resolveConfig } from './config.js'
import { ProviderKeys } from './keys.js'
import { buildAdapter, buildProviders } from './providers.js'
import { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
import { createProviderImageServices } from './runtime.js'
import { registerAuthChannel } from './oauth/channel.js'
import { OAuthProvidersService } from './oauth/service.js'
import { registerChatGpt } from './providers/chatgpt/index.js'

export { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
export { OAuthProvidersService } from './oauth/service.js'
export type { OAuthToken, TokenResolver } from './oauth/service.js'
export {
  ConfigError,
  defaultSecretDir,
  loadConfig,
  resolveConfig,
  resolveConfigPath,
} from './config.js'
export type { ModelConfig, ProviderKind, ResolvedConfig, ResolvedProvider } from './config.js'
export { ProviderKeys, readKey } from './keys.js'
export type { KeySource } from './keys.js'
export { buildAdapter, buildProviders } from './providers.js'
export {
  DEFAULT_BASE_URL,
  DEFAULT_MODELS_URL,
  buildCommandCodeProvider,
  fetchCatalog,
  parseCatalog,
  toPiModels,
} from './commandcode.js'

/** Plugin-row configuration: only the YAML path is configured here. */
export interface Config {
  /** YAML path; empty uses `$DSH_HOME/more-providers.yaml`. */
  configFile?: string
}

export const Config = Schema.object({
  configFile: Schema.string().description(
    'YAML provider config path; empty uses $DSH_HOME/more-providers.yaml.',
  ),
})

export const name = PLUGIN_NAME
export const inject = ['llm']

export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = ctx.logger(PACKAGE_NAME)
  const store = registerConfig(ctx, {
    filename: 'more-providers.yaml',
    configFile: config.configFile,
    validate: resolveConfig,
    logger: log,
  })
  // Provider rows are registered once at startup, so a fixed file still needs
  // a restart; the status route says so and keeps the error visible to the UI.
  registerConfigStatusRoute(ctx, {
    prefix: '/dsh-more-providers',
    title: 'more-providers',
    recovery: 'restart',
    store,
  })
  const state = await store.ready
  if (state.value === undefined) {
    log.error(
      'more-providers: config %s is unusable: %s — fix it and restart dsh',
      state.file,
      state.error ?? 'unknown error',
    )
    return
  }

  let built
  try {
    built = await buildProviders(state.value.providers, log)
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : String(error)
    // The document validated, but provider construction rejected it (an
    // unknown builtin catalog, for example). Surface that failure through the
    // same status the browser half reads instead of leaving it "valid".
    store.reportFailure(reason)
    log.error(
      'more-providers: config %s is unusable: %s — fix it and restart dsh',
      state.file,
      reason,
    )
    return
  }
  const { profiles, keys } = built
  const keyService = new ProviderKeys(ctx, keys)
  const images = createProviderImageServices(ctx)
  const tokens = new OAuthProvidersService(ctx)
  const channel = registerAuthChannel(ctx)
  if (profiles.size > 0) {
    const adapter = buildAdapter(profiles, (provider) => keyService.key(provider), images)
    ctx.llm.registerAdapter([...profiles.keys()], adapter)
  }
  const chatgpt = state.value.chatgpt
  if (chatgpt !== undefined) {
    ctx.inject(['credentials'], (oauthCtx) => {
      registerChatGpt(oauthCtx, { channel, tokens, config: chatgpt, images })
    })
  }
  log.info(
    'more-providers: registered %d API-key route(s); ChatGPT OAuth %s; config %s',
    profiles.size,
    chatgpt === undefined ? 'disabled' : 'enabled',
    state.file,
  )
}
