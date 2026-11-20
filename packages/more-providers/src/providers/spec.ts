/**
 * The registry's build plans: one discriminated union per provider kind, so the build switches on `kind` instead of on a flat record's optional fields.
 * @module dsh-more-providers/providers/spec
 */
import type { Api } from '@earendil-works/pi-ai'
import type { PiAiCompatProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ModelConfig, ModelDefault, ResolvedConfig } from '../config.js'
import type { ModelFilter } from '../catalog/filter.js'
import type { KeySource } from '../keys.js'
import type { ResolvedChatGptConfig } from './chatgpt/index.js'

/** One pool member in priority order. */
export interface AccountSpec {
  id: string
  displayName: string
  keySource: KeySource
}

interface SpecBase {
  providerId: string
  route: string
  displayName: string
  enabled: boolean
}

interface ApiKeySpecBase extends SpecBase {
  accounts: readonly AccountSpec[]
  filter?: ModelFilter
}

/** A pi-ai catalog route: its models come from the bundled provider data. */
export interface BuiltinProviderSpec extends ApiKeySpecBase {
  kind: 'builtin'
  catalog: string
}

/** A custom endpoint route: its models come from `modelsURL` and/or the static list. */
export interface CustomProviderSpec extends ApiKeySpecBase {
  kind: 'custom'
  api: Api
  baseURL: string
  modelsURL?: string
  models?: readonly ModelConfig[]
  contextWindows?: ReadonlyMap<string, number>
  modelDefaults?: readonly ModelDefault[]
  compat?: PiAiCompatProfile
  headers?: Record<string, string>
}

/** A Command Code route: its models come from that service's catalog. */
export interface CommandCodeProviderSpec extends ApiKeySpecBase {
  kind: 'command-code'
  baseURL?: string
  modelsURL?: string
  zdr?: boolean
}

export type ApiKeyProviderSpec = BuiltinProviderSpec | CustomProviderSpec | CommandCodeProviderSpec

/** The reserved OAuth route: one grant and one fixed route id, so it has no key pool. */
export interface ChatGptProviderSpec extends SpecBase {
  kind: 'chatgpt'
  config: ResolvedChatGptConfig
}

export type ProviderSpec = ApiKeyProviderSpec | ChatGptProviderSpec

/** Every enabled provider that takes part in registration: the API-key routes in configuration order, then the OAuth instance. */
export function toProviderSpecs(config: ResolvedConfig): ProviderSpec[] {
  const specs: ProviderSpec[] = config.providers.filter((provider) => provider.enabled)
  if (config.chatgpt?.enabled === true) specs.push(config.chatgpt)
  return specs
}
