/**
 * dsh-more-providers — the YAML-driven provider registry for DSH.
 *
 * `$DSH_HOME/more-providers.yaml` declares builtin catalog routes, custom
 * OpenAI/Anthropic-compatible endpoints, and Command Code. Routes register only
 * when their key source is readable; the `providerKeys` service is the shared
 * key reader for dsh-plan-usage. A malformed config registers no providers but
 * never crashes dsh; a runtime catalog failure skips only that route.
 *
 * @module dsh-more-providers
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ConfigError, loadConfig, resolveConfigPath } from './config.js'
import { ProviderKeys } from './keys.js'
import { buildAdapter, buildProviders } from './providers.js'
import { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'

export { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
export { ConfigError, defaultSecretDir, loadConfig, resolveConfig, resolveConfigPath } from './config.js'
export type { ModelConfig, ProviderKind, ResolvedProvider } from './config.js'
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
  configFile: Schema.string()
    .description('YAML provider config path; empty uses $DSH_HOME/more-providers.yaml.'),
})

export const name = PLUGIN_NAME
export const inject = ['llm']

export async function apply(ctx: Context, config: Config): Promise<void> {
  const log = ctx.logger(PACKAGE_NAME)
  const path = resolveConfigPath(config.configFile)
  let profiles = new Map()
  let keys = new Map()
  try {
    const resolved = await loadConfig(path)
    const built = await buildProviders(resolved, log)
    profiles = built.profiles
    keys = built.keys
  } catch (error) {
    const reason = error instanceof ConfigError ? error.message : String(error)
    log.error('more-providers: config %s is unusable: %s', path, reason)
  }

  const keyService = new ProviderKeys(ctx, keys)
  if (profiles.size === 0) {
    log.warn('more-providers: no provider routes registered (see the config error above)')
    return
  }
  const adapter = buildAdapter(profiles, (provider) => keyService.key(provider))
  ctx.llm.registerAdapter([...profiles.keys()], adapter)
  log.info('more-providers: registered %d route(s) from %s', profiles.size, path)
}
