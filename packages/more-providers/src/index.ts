/**
 * dsh-more-providers — env-driven extra LLM providers for DSH.
 *
 * Command Code is the first module: `CMD_API_KEY` (or
 * `COMMAND_CODE_API_KEY`) turns into a `command-code` route whose live model
 * catalog spans three pi-ai protocols. No settings-page step is involved; with
 * no key the row loads and registers nothing.
 *
 * @module dsh-more-providers
 */
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { CommandCodeConfig, registerCommandCode } from './commandcode.js'
import type { CommandCodeSettings } from './commandcode.js'
import { PLUGIN_NAME } from './identity.js'

export { PACKAGE_NAME, PLUGIN_NAME } from './identity.js'
export {
  COMMAND_CODE_ROUTE,
  DEFAULT_BASE_URL,
  DEFAULT_MODELS_URL,
  CommandCodeConfig,
  createCommandCodeAdapter,
  fetchCatalog,
  parseCatalog,
  registerCommandCode,
  resolveApiKey,
  toPiModels,
} from './commandcode.js'
export type {
  CommandCodeCatalogItem,
  CommandCodeDeps,
  CommandCodeRegistration,
  CommandCodeSettings,
  FetchLike,
} from './commandcode.js'

/** Plugin-row configuration: one sub-object per provider module. */
export interface Config {
  /** Command Code subscription provider. */
  commandCode?: CommandCodeSettings
}

const DEFAULT_COMMAND_CODE = CommandCodeConfig(undefined)

export const Config = Schema.object({
  commandCode: CommandCodeConfig.default(DEFAULT_COMMAND_CODE)
    .description('Command Code subscription provider (env API key).'),
})

export const name = PLUGIN_NAME
export const inject = ['llm']

export async function apply(ctx: Context, config: Config): Promise<void> {
  const settings = config.commandCode ?? DEFAULT_COMMAND_CODE
  if (!settings.enabled) return
  await registerCommandCode(ctx, settings)
}
