/**
 * The `more-providers.yaml` loader and validator: one provider registers one route backed by an ordered account pool, and the ChatGPT section is a provider instance like any other.
 * @module dsh-more-providers/config
 */
import type { Api } from '@earendil-works/pi-ai'
import type { PiAiCompatProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { isAbsolute, join } from 'node:path'
import { ConfigError, readConfigFile, resolveConfigFile } from '@dsh-extensions/config'
import { isRecord } from './record.js'
import type { KeySource } from './keys.js'
import type { ModelFilter, ModelPattern } from './catalog/filter.js'
import { combineFilters, compileModelFilter } from './catalog/filter.js'
import type { AccountSpec, ApiKeyProviderSpec, ChatGptProviderSpec } from './providers/spec.js'

export { ConfigError }

/** One loaded model descriptor from the YAML file. */
export interface ModelConfig {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
  reasoning?: false | string[]
}

/** Model fields a `modelDefaults` rule can supply. */
export interface ModelMetadata {
  contextWindow?: number
  maxTokens?: number
  reasoning?: false | string[]
}

/** One ordered `modelDefaults` rule; the first rule declaring a field wins for that field. */
export interface ModelDefault extends ModelMetadata {
  pattern: RegExp
}

/** The API-key provider kinds. */
export type ProviderKind = 'builtin' | 'custom' | 'command-code'

/** Validated startup configuration: one spec per configured provider, ChatGPT included only when configured. */
export interface ResolvedConfig {
  providers: ApiKeyProviderSpec[]
  chatgpt?: ChatGptProviderSpec
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const CHATGPT_ROUTE = 'chatgpt'
const PROVIDER_KEYS = new Set([
  'kind',
  'enabled',
  'displayName',
  'routeId',
  'catalog',
  'api',
  'baseURL',
  'modelsURL',
  'models',
  'contextWindows',
  'modelDefaults',
  'filter',
  'compat',
  'headers',
  'apiKeyFile',
  'secretName',
  'apiKeyEnv',
  'accounts',
  'zdr',
  'clientVersion',
  'refreshMarginMs',
  'defaultContextWindow',
  'promptCacheKey',
])
const ACCOUNT_KEYS = new Set(['enabled', 'displayName', 'apiKeyFile', 'secretName', 'apiKeyEnv'])
const ACCOUNT_OVERRIDES = new Map([
  ['routeId', 'one provider registers one route; set routeId on the provider instead'],
  ['api', 'move it to the provider level; the accounts of a pool share the connection'],
  ['baseURL', 'move it to the provider level; the accounts of a pool share the connection'],
  ['modelsURL', 'move it to the provider level; the accounts of a pool share the model catalog'],
  ['models', 'move it to the provider level; the accounts of a pool share the model catalog'],
  ['contextWindows', 'move it to the provider level; the accounts of a pool share the metadata'],
  ['compat', 'move it to the provider level; the accounts of a pool share the wire compatibility'],
  ['headers', 'move it to the provider level; the accounts of a pool share the request headers'],
  ['zdr', 'move it to the provider level; the accounts of a pool share the ZDR setting'],
])
const CHATGPT_REJECTED = new Map([
  ['routeId', 'the chatgpt route id is fixed for credential and session compatibility'],
  ['api', 'the chatgpt provider speaks the Codex protocol; remove api'],
  ['catalog', 'the chatgpt model catalog is discovered live; remove catalog'],
  ['models', 'the chatgpt model catalog is discovered live; remove models'],
  ['modelsURL', 'the chatgpt model catalog is discovered live; remove modelsURL'],
  ['contextWindows', 'the chatgpt catalog carries its own context windows; remove contextWindows'],
  ['modelDefaults', 'the chatgpt catalog carries its own model metadata; remove modelDefaults'],
  ['compat', 'the chatgpt provider owns its wire compatibility; remove compat'],
  ['headers', 'the chatgpt provider owns its request headers; remove headers'],
  ['zdr', 'the chatgpt provider owns its request headers; remove zdr'],
  [
    'accounts',
    'the chatgpt provider holds a single OAuth account; sign in from the providers page',
  ],
  ['apiKeyFile', 'the chatgpt provider signs in through OAuth; remove the API key fields'],
  ['secretName', 'the chatgpt provider signs in through OAuth; remove the API key fields'],
  ['apiKeyEnv', 'the chatgpt provider signs in through OAuth; remove the API key fields'],
])
const CHATGPT_ONLY = ['clientVersion', 'refreshMarginMs', 'defaultContextWindow', 'promptCacheKey']
const MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning'])
const MODEL_DEFAULT_KEYS = new Set(['match', 'flags', 'contextWindow', 'maxTokens', 'reasoning'])
const FILTER_KEYS = new Set(['include', 'exclude'])
const PATTERN_KEYS = new Set(['match', 'flags'])
const API_VALUES = new Set<Api>(['openai-completions', 'openai-responses', 'anthropic-messages'])
const KEY_FIELDS = ['apiKeyFile', 'secretName', 'apiKeyEnv'] as const

function fail(path: string, message: string): never {
  throw new ConfigError(`${path}: ${message}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return fail(path, 'expected an object')
  }
  return value
}

function rejectUnknown(raw: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      fail(path, `forbidden key "${key}"`)
    }
    if (!allowed.has(key)) fail(path, `unknown key "${key}"`)
  }
}

function rejectIfSet(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  message: string,
): void {
  if (raw[key] !== undefined && raw[key] !== null) fail(`${path}.${key}`, message)
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '')
    return fail(`${path}.${key}`, 'expected a non-empty string')
  return value.trim()
}

function requiredString(raw: Record<string, unknown>, key: string, path: string): string {
  const value = optionalString(raw, key, path)
  return value ?? fail(`${path}.${key}`, 'is required')
}

function rawString(raw: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return fail(`${path}.${key}`, 'expected a string')
  return value
}

function optionalBoolean(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') return fail(`${path}.${key}`, 'expected a boolean')
  return value
}

function optionalPositiveInteger(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return fail(`${path}.${key}`, 'expected a positive integer')
  }
  return value
}

function optionalStringArray(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): string[] | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (!isStringArray(value)) return fail(`${path}.${key}`, 'expected an array of strings')
  return value
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function optionalHeaderRecord(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, string> | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  const record = asRecord(value, `${path}.${key}`)
  const headers: Record<string, string> = {}
  for (const [name, header] of Object.entries(record)) {
    if (typeof header !== 'string') fail(`${path}.${key}.${name}`, 'expected a string')
    headers[name] = header
  }
  return headers
}

function optionalCompat(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): PiAiCompatProfile | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  return asRecord(value, `${path}.${key}`)
}

function optionalUrl(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  required: true,
): string
function optionalUrl(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  required: false,
): string | undefined
function optionalUrl(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  required: boolean,
): string | undefined {
  const value = required ? requiredString(raw, key, path) : optionalString(raw, key, path)
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail(`${path}.${key}`, 'expected an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    fail(`${path}.${key}`, 'expected an http(s) URL')
  return value.replace(/\/+$/u, '')
}

function optionalApi(raw: Record<string, unknown>, key: string, path: string): Api | undefined {
  const value = optionalString(raw, key, path)
  if (value === undefined) return undefined
  if (!API_VALUES.has(value)) {
    fail(`${path}.${key}`, `expected one of ${[...API_VALUES].join(', ')}`)
  }
  return value
}

function hasKeyFields(raw: Record<string, unknown>): boolean {
  return KEY_FIELDS.some((field) => raw[field] !== undefined && raw[field] !== null)
}

function keySourceOf(
  raw: Record<string, unknown>,
  path: string,
  secretDir: string,
): KeySource | undefined {
  const apiKeyFile = optionalString(raw, 'apiKeyFile', path)
  if (apiKeyFile !== undefined) {
    if (!isAbsolute(apiKeyFile)) fail(`${path}.apiKeyFile`, 'expected an absolute path')
    return { kind: 'file', path: apiKeyFile }
  }
  const secretName = optionalString(raw, 'secretName', path)
  if (secretName !== undefined) {
    if (!SECRET_NAME.test(secretName)) fail(`${path}.secretName`, 'expected a simple file name')
    return { kind: 'file', path: join(secretDir, secretName) }
  }
  const apiKeyEnv = optionalString(raw, 'apiKeyEnv', path)
  if (apiKeyEnv !== undefined) {
    if (!ENV_NAME.test(apiKeyEnv))
      fail(`${path}.apiKeyEnv`, 'expected an environment variable name')
    return { kind: 'env', name: apiKeyEnv }
  }
  return undefined
}

function optionalReasoning(
  raw: Record<string, unknown>,
  key: string,
  path: string,
): false | string[] | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  const fieldPath = `${path}.${key}`
  if (value === false) return false
  if (!Array.isArray(value) || value.length === 0) {
    fail(fieldPath, 'expected false or a non-empty array of thinking levels')
  }
  const levels: string[] = []
  for (const level of value) {
    if (typeof level !== 'string')
      fail(fieldPath, 'expected false or a non-empty array of thinking levels')
    levels.push(level)
  }
  for (const level of levels) {
    if (!THINKING_LEVELS.has(level)) fail(fieldPath, `unknown thinking level "${level}"`)
  }
  return levels
}

function parseModels(raw: Record<string, unknown>, path: string): ModelConfig[] | undefined {
  const value = raw.models
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0)
    fail(`${path}.models`, 'expected a non-empty array')
  return value.map((entry, index) => {
    const modelPath = `${path}.models[${index}]`
    const record = asRecord(entry, modelPath)
    if (record.filter !== undefined && record.filter !== null) {
      fail(`${modelPath}.filter`, 'is not supported here; set filter on the provider')
    }
    rejectUnknown(record, MODEL_KEYS, modelPath)
    const id = requiredString(record, 'id', modelPath)
    const name = optionalString(record, 'name', modelPath)
    const contextWindow = optionalPositiveInteger(record, 'contextWindow', modelPath)
    const maxTokens = optionalPositiveInteger(record, 'maxTokens', modelPath)
    const inputRaw = optionalStringArray(record, 'input', modelPath)
    const input = inputRaw?.map((mode) => {
      if (mode !== 'text' && mode !== 'image')
        fail(`${modelPath}.input`, 'only "text" and "image" are supported')
      return mode
    })
    const reasoning = optionalReasoning(record, 'reasoning', modelPath)
    const model: ModelConfig = { id }
    if (name !== undefined) model.name = name
    if (contextWindow !== undefined) model.contextWindow = contextWindow
    if (maxTokens !== undefined) model.maxTokens = maxTokens
    if (input !== undefined) model.input = input
    if (reasoning !== undefined) model.reasoning = reasoning
    return model
  })
}

function compilePattern(record: Record<string, unknown>, path: string): RegExp {
  const match = rawString(record, 'match', path) ?? fail(`${path}.match`, 'is required')
  if (match === '') return fail(`${path}.match`, 'expected a non-empty string')
  const flags = rawString(record, 'flags', path)
  try {
    return new RegExp(match, flags)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return fail(`${path}.match`, `invalid regular expression: ${reason}`)
  }
}

function parseModelDefaults(
  raw: Record<string, unknown>,
  path: string,
): ModelDefault[] | undefined {
  const value = raw.modelDefaults
  if (value === undefined || value === null) return undefined
  const listPath = `${path}.modelDefaults`
  if (!Array.isArray(value) || value.length === 0) fail(listPath, 'expected a non-empty array')
  return value.map((entry, index) => {
    const rulePath = `${listPath}[${index}]`
    const record = asRecord(entry, rulePath)
    rejectUnknown(record, MODEL_DEFAULT_KEYS, rulePath)
    const pattern = compilePattern(record, rulePath)
    const contextWindow = optionalPositiveInteger(record, 'contextWindow', rulePath)
    const maxTokens = optionalPositiveInteger(record, 'maxTokens', rulePath)
    const reasoning = optionalReasoning(record, 'reasoning', rulePath)
    if (contextWindow === undefined && maxTokens === undefined && reasoning === undefined) {
      fail(rulePath, 'set at least one of contextWindow, maxTokens, reasoning')
    }
    const rule: ModelDefault = { pattern }
    if (contextWindow !== undefined) rule.contextWindow = contextWindow
    if (maxTokens !== undefined) rule.maxTokens = maxTokens
    if (reasoning !== undefined) rule.reasoning = reasoning
    return rule
  })
}

function parseModelPatterns(
  raw: Record<string, unknown>,
  key: 'include' | 'exclude',
  path: string,
): ModelPattern[] | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  const listPath = `${path}.${key}`
  if (!Array.isArray(value) || value.length === 0) fail(listPath, 'expected a non-empty array')
  return value.map((entry, index) => {
    const entryPath = `${listPath}[${index}]`
    const record = asRecord(entry, entryPath)
    rejectUnknown(record, PATTERN_KEYS, entryPath)
    const match = rawString(record, 'match', entryPath) ?? fail(`${entryPath}.match`, 'is required')
    if (match === '') fail(`${entryPath}.match`, 'expected a non-empty string')
    const flags = rawString(record, 'flags', entryPath)
    return flags === undefined ? { match } : { match, flags }
  })
}

function parseFilter(raw: Record<string, unknown>, path: string): ModelFilter | undefined {
  const value = raw.filter
  if (value === undefined || value === null) return undefined
  const filterPath = `${path}.filter`
  const record = asRecord(value, filterPath)
  rejectUnknown(record, FILTER_KEYS, filterPath)
  const include = parseModelPatterns(record, 'include', filterPath)
  const exclude = parseModelPatterns(record, 'exclude', filterPath)
  if (include === undefined && exclude === undefined) fail(filterPath, 'set include or exclude')
  try {
    return compileModelFilter({
      ...(include === undefined ? {} : { include }),
      ...(exclude === undefined ? {} : { exclude }),
    })
  } catch (error) {
    return fail(filterPath, error instanceof Error ? error.message : String(error))
  }
}

function parseContextWindows(
  raw: Record<string, unknown>,
  path: string,
): ReadonlyMap<string, number> | undefined {
  const value = raw.contextWindows
  if (value === undefined || value === null) return undefined
  const windowPath = `${path}.contextWindows`
  const windows = new Map<string, number>()
  for (const [id, tokens] of Object.entries(asRecord(value, windowPath))) {
    if (id.trim() === '') fail(windowPath, 'expected a non-empty model id')
    if (typeof tokens !== 'number' || !Number.isSafeInteger(tokens) || tokens <= 0) {
      fail(`${windowPath}.${id}`, 'expected a positive integer')
    }
    windows.set(id, tokens)
  }
  return windows
}

/** Parse the pool: an absent `accounts` section means the provider's own key is its only member. */
function parseAccounts(
  raw: Record<string, unknown>,
  path: string,
  secretDir: string,
  providerId: string,
  displayName: string,
  enabled: boolean,
): AccountSpec[] {
  const baseKey = keySourceOf(raw, path, secretDir)
  const accountsRaw = raw.accounts
  if (accountsRaw === undefined || accountsRaw === null) {
    if (baseKey === undefined) {
      if (!enabled) return []
      fail(path, 'no key source (apiKeyFile, secretName, or apiKeyEnv)')
    }
    return [{ id: providerId, displayName, keySource: baseKey }]
  }

  const accounts = asRecord(accountsRaw, `${path}.accounts`)
  const entries = Object.entries(accounts)
  if (entries.length === 0) fail(`${path}.accounts`, 'must not be empty')
  const members: AccountSpec[] = []
  for (const [accountId, accountValue] of entries) {
    const accountPath = `${path}.accounts.${accountId}`
    if (!PROVIDER_ID.test(accountId))
      fail(accountPath, 'account ids must be lowercase letters, digits, or hyphens')
    const account = asRecord(accountValue, accountPath)
    if (account.filter !== undefined && account.filter !== null)
      fail(`${accountPath}.filter`, 'is not supported on an account; set filter on the provider')
    for (const [key, hint] of ACCOUNT_OVERRIDES) {
      rejectIfSet(account, key, accountPath, hint)
    }
    rejectUnknown(account, ACCOUNT_KEYS, accountPath)
    if (optionalBoolean(account, 'enabled', accountPath) === false) continue

    const accountDisplay =
      optionalString(account, 'displayName', accountPath) ?? `${displayName} (${accountId})`
    const keySource = hasKeyFields(account) ? keySourceOf(account, accountPath, secretDir) : baseKey
    if (keySource === undefined) {
      if (!enabled) continue
      fail(accountPath, 'no key source (apiKeyFile, secretName, or apiKeyEnv)')
    }
    members.push({ id: accountId, displayName: accountDisplay, keySource })
  }
  return members
}

function parseKind(
  raw: Record<string, unknown>,
  path: string,
  providerId: string,
): ProviderKind | 'chatgpt' {
  const value = raw.kind
  if (value === undefined || value === null) {
    if (providerId === CHATGPT_ROUTE) {
      fail(
        `${path}.kind`,
        'is required: the ChatGPT section is now a provider instance, so add "kind: chatgpt"',
      )
    }
    fail(`${path}.kind`, 'is required (builtin, custom, command-code, or chatgpt)')
  }
  if (typeof value !== 'string') fail(`${path}.kind`, 'expected a string')
  const kind = value.trim()
  if (kind === CHATGPT_ROUTE) {
    if (providerId !== CHATGPT_ROUTE) {
      fail(
        `${path}.kind`,
        'only the reserved provider id "chatgpt" may use kind chatgpt; its OAuth grant has a fixed address',
      )
    }
    return 'chatgpt'
  }
  if (kind === 'builtin' || kind === 'custom' || kind === 'command-code') {
    if (providerId === CHATGPT_ROUTE) {
      fail(
        `${path}.kind`,
        'the reserved provider id "chatgpt" is the OAuth provider; use kind: chatgpt or rename the provider',
      )
    }
    return kind
  }
  return fail(`${path}.kind`, 'expected builtin, custom, command-code, or chatgpt')
}

/** Parse one API-key provider into its build spec; every kind owns its fields, so the others are rejected. */
function parseApiKeyProvider(
  providerId: string,
  raw: Record<string, unknown>,
  path: string,
  kind: ProviderKind,
  secretDir: string,
  filter: ModelFilter | undefined,
  enabled: boolean,
  defaults: ResolvedDefaults | undefined,
): ApiKeyProviderSpec {
  const routeId = optionalString(raw, 'routeId', path)
  if (routeId !== undefined) {
    if (!PROVIDER_ID.test(routeId))
      fail(`${path}.routeId`, 'expected lowercase letters, digits, or hyphens')
    if (routeId === CHATGPT_ROUTE)
      fail(`${path}.routeId`, 'the route id "chatgpt" is reserved for the OAuth provider')
  }
  const displayName = optionalString(raw, 'displayName', path) ?? providerId
  const accounts = parseAccounts(raw, path, secretDir, providerId, displayName, enabled)
  const common = {
    providerId,
    route: routeId ?? providerId,
    displayName,
    enabled,
    accounts,
    ...(filter === undefined ? {} : { filter }),
  }

  for (const key of CHATGPT_ONLY) {
    rejectIfSet(raw, key, path, 'is only supported on the chatgpt provider')
  }

  switch (kind) {
    case 'builtin': {
      for (const key of [
        'api',
        'baseURL',
        'modelsURL',
        'zdr',
        'models',
        'contextWindows',
        'modelDefaults',
        'compat',
        'headers',
      ]) {
        rejectIfSet(raw, key, path, 'is not supported on a builtin provider')
      }
      const catalog = optionalString(raw, 'catalog', path) ?? providerId
      if (!PROVIDER_ID.test(catalog)) fail(`${path}.catalog`, 'expected a catalog provider id')
      return { ...common, kind: 'builtin', catalog }
    }
    case 'command-code': {
      for (const key of [
        'catalog',
        'api',
        'models',
        'contextWindows',
        'modelDefaults',
        'compat',
        'headers',
      ]) {
        rejectIfSet(raw, key, path, 'is not supported on a command-code provider')
      }
      const baseURL = optionalUrl(raw, 'baseURL', path, false)
      const modelsURL = optionalUrl(raw, 'modelsURL', path, false)
      const zdr = optionalBoolean(raw, 'zdr', path)
      return {
        ...common,
        kind: 'command-code',
        ...(baseURL === undefined ? {} : { baseURL }),
        ...(modelsURL === undefined ? {} : { modelsURL }),
        ...(zdr === undefined ? {} : { zdr }),
      }
    }
    case 'custom': {
      if (raw.catalog !== undefined && raw.catalog !== null)
        fail(`${path}.catalog`, 'is not supported on a custom provider')
      rejectIfSet(raw, 'zdr', path, 'is not supported on a custom provider')
      const api =
        optionalApi(raw, 'api', path) ?? fail(`${path}.api`, 'is required for a custom provider')
      const baseURL = optionalUrl(raw, 'baseURL', path, true)
      const modelsURL = optionalUrl(raw, 'modelsURL', path, false)
      const models = parseModels(raw, path)
      const contextWindows = mergeContextWindows(
        parseContextWindows(raw, path),
        defaults?.contextWindows,
      )
      const modelDefaults = mergeModelDefaults(
        parseModelDefaults(raw, path),
        defaults?.modelDefaults,
      )
      if (modelsURL === undefined && models === undefined) {
        fail(path, 'custom provider needs modelsURL or models')
      }
      const compat = optionalCompat(raw, 'compat', path)
      const headers = optionalHeaderRecord(raw, 'headers', path)
      return {
        ...common,
        kind: 'custom',
        api,
        baseURL,
        ...(modelsURL === undefined ? {} : { modelsURL }),
        ...(models === undefined ? {} : { models }),
        ...(contextWindows === undefined ? {} : { contextWindows }),
        ...(modelDefaults === undefined ? {} : { modelDefaults }),
        ...(compat === undefined ? {} : { compat }),
        ...(headers === undefined ? {} : { headers }),
      }
    }
  }
  return fail(`${path}.kind`, 'expected builtin, custom, or command-code')
}

function parseChatGptProvider(
  raw: Record<string, unknown>,
  path: string,
  filter: ModelFilter | undefined,
  enabled: boolean,
): ChatGptProviderSpec {
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null) fail(`${path}.${key}`, 'null is not a valid provider option')
  }
  for (const [key, hint] of CHATGPT_REJECTED) {
    rejectIfSet(raw, key, path, hint)
  }
  const displayName = optionalString(raw, 'displayName', path) ?? 'ChatGPT (OpenAI)'
  const baseURL = optionalUrl(raw, 'baseURL', path, false)
  const clientVersion = rawString(raw, 'clientVersion', path)
  const refreshMarginMs = optionalPositiveInteger(raw, 'refreshMarginMs', path)
  const defaultContextWindow = optionalPositiveInteger(raw, 'defaultContextWindow', path)
  const promptCacheKey = optionalBoolean(raw, 'promptCacheKey', path)
  return {
    route: CHATGPT_ROUTE,
    providerId: CHATGPT_ROUTE,
    kind: 'chatgpt',
    displayName,
    enabled,
    config: {
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(clientVersion === undefined ? {} : { clientVersion }),
      ...(refreshMarginMs === undefined ? {} : { refreshMarginMs }),
      ...(defaultContextWindow === undefined ? {} : { defaultContextWindow }),
      ...(promptCacheKey === undefined ? {} : { promptCacheKey }),
      ...(filter === undefined ? {} : { filter }),
    },
  }
}

const DEFAULTS_KEYS = new Set(['modelDefaults', 'contextWindows', 'filter'])

/** The root `defaults` section: fallbacks every provider inherits before its own settings. */
interface ResolvedDefaults {
  modelDefaults?: readonly ModelDefault[]
  contextWindows?: ReadonlyMap<string, number>
  filter?: ModelFilter
}

/** Parse the root `defaults` block; its paths must read `defaults.*`, never `providers.defaults.*`. */
function parseDefaults(raw: Record<string, unknown>): ResolvedDefaults | undefined {
  const value = raw.defaults
  if (value === undefined || value === null) return undefined
  const path = 'defaults'
  const record = asRecord(value, path)
  rejectUnknown(record, DEFAULTS_KEYS, path)
  const modelDefaults = parseModelDefaults(record, path)
  const contextWindows = parseContextWindows(record, path)
  const filter = parseFilter(record, path)
  if (modelDefaults === undefined && contextWindows === undefined && filter === undefined) {
    fail(path, 'set at least one of modelDefaults, contextWindows, filter')
  }
  return {
    ...(modelDefaults === undefined ? {} : { modelDefaults }),
    ...(contextWindows === undefined ? {} : { contextWindows }),
    ...(filter === undefined ? {} : { filter }),
  }
}

/** Provider rules first, then the global ones, so first-match-wins still prefers the provider. */
function mergeModelDefaults(
  provider: ModelDefault[] | undefined,
  global: readonly ModelDefault[] | undefined,
): ModelDefault[] | undefined {
  if (global === undefined) return provider
  if (provider === undefined) return [...global]
  return [...provider, ...global]
}

/** Provider entries win for the same model id. */
function mergeContextWindows(
  provider: ReadonlyMap<string, number> | undefined,
  global: ReadonlyMap<string, number> | undefined,
): ReadonlyMap<string, number> | undefined {
  if (global === undefined) return provider
  if (provider === undefined) return global
  return new Map([...global, ...provider])
}

function parseProvider(
  providerId: string,
  value: unknown,
  secretDir: string,
  defaults: ResolvedDefaults | undefined,
): ApiKeyProviderSpec | ChatGptProviderSpec {
  const path = `providers.${providerId}`
  if (!PROVIDER_ID.test(providerId))
    fail(path, 'provider ids must be lowercase letters, digits, or hyphens')
  const raw = asRecord(value, path)
  rejectUnknown(raw, PROVIDER_KEYS, path)
  const kind = parseKind(raw, path, providerId)
  const filter = combineFilters(defaults?.filter, parseFilter(raw, path))
  const enabled = optionalBoolean(raw, 'enabled', path) !== false
  if (kind === 'chatgpt') return parseChatGptProvider(raw, path, filter, enabled)
  return parseApiKeyProvider(providerId, raw, path, kind, secretDir, filter, enabled, defaults)
}

/** Resolve the API-key routes and the configured OAuth provider from one strict document. */
export function resolveConfig(value: unknown): ResolvedConfig {
  const raw = asRecord(value, 'config')
  rejectUnknown(raw, new Set(['secretDir', 'defaults', 'providers']), 'config')
  const secretDir = optionalString(raw, 'secretDir', 'config')
  if (secretDir !== undefined && !isAbsolute(secretDir))
    fail('config.secretDir', 'expected an absolute path')
  const effectiveSecretDir = secretDir ?? defaultSecretDir()
  const providersRaw = raw.providers
  if (providersRaw === undefined || providersRaw === null) fail('config.providers', 'is required')
  const providers = asRecord(providersRaw, 'config.providers')
  const defaults = parseDefaults(raw)
  const routes = new Set<string>()
  const result: ApiKeyProviderSpec[] = []
  let chatgpt: ChatGptProviderSpec | undefined
  for (const [providerId, provider] of Object.entries(providers)) {
    const parsed = parseProvider(providerId, provider, effectiveSecretDir, defaults)
    if (parsed.kind === 'chatgpt') {
      chatgpt = parsed
      continue
    }
    if (routes.has(parsed.route))
      fail(`providers.${providerId}`, `duplicate route id "${parsed.route}"`)
    routes.add(parsed.route)
    result.push(parsed)
  }
  return { providers: result, ...(chatgpt === undefined ? {} : { chatgpt }) }
}

/** The effective `secretDir` (agenix's user runtime directory by default). */
export function defaultSecretDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR?.trim()
  if (runtime !== undefined && runtime !== '') return join(runtime, 'agenix')
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `/run/user/${uid}/agenix`
}

/** The YAML path: an explicit plugin-row value or `$DSH_HOME/more-providers.yaml`. */
export function resolveConfigPath(explicit?: string): string {
  return resolveConfigFile({ filename: 'more-providers.yaml', configFile: explicit })
}

/** Read and validate the YAML file. Throws ConfigError on any problem. */
export async function loadConfig(path: string): Promise<ResolvedConfig> {
  return readConfigFile(path, resolveConfig)
}
