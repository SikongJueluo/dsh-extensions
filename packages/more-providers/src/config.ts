/**
 * The `more-providers.yaml` loader and validator.
 *
 * Configuration is deliberately strict: one bad provider rejects the whole
 * file so a typo cannot silently leave a half-migrated provider set. A missing
 * key file is not a config error; it keeps that one provider dormant. YAML
 * stays data-only — no code, no env expansion, no secret values.
 *
 * @module dsh-more-providers/config
 */
import type { Api } from '@earendil-works/pi-ai'
import type { PiAiCompatProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { KeySource } from './keys.js'

/** One loaded model descriptor from the YAML file. */
export interface ModelConfig {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: Array<'text' | 'image'>
  reasoning?: false | string[]
}

export type ProviderKind = 'builtin' | 'custom' | 'command-code'

/** One enabled route after inheritance and key-source resolution. */
export interface ResolvedProvider {
  route: string
  providerId: string
  kind: ProviderKind
  displayName: string
  catalog?: string
  api?: Api
  baseURL?: string
  modelsURL?: string
  models?: ModelConfig[]
  compat?: PiAiCompatProfile
  headers?: Record<string, string>
  zdr?: boolean
  keySource: KeySource
}

export class ConfigError extends Error {}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const PROVIDER_KEYS = new Set([
  'kind', 'enabled', 'displayName', 'catalog', 'api', 'baseURL', 'modelsURL',
  'models', 'compat', 'headers', 'apiKeyFile', 'secretName', 'apiKeyEnv',
  'accounts', 'zdr',
])
const ACCOUNT_KEYS = new Set([
  'enabled', 'displayName', 'routeId', 'api', 'baseURL', 'modelsURL', 'models',
  'compat', 'headers', 'apiKeyFile', 'secretName', 'apiKeyEnv', 'zdr',
])
const MODEL_KEYS = new Set(['id', 'name', 'contextWindow', 'maxTokens', 'input', 'reasoning'])
const API_VALUES = new Set<Api>(['openai-completions', 'openai-responses', 'anthropic-messages'])
const KEY_FIELDS = ['apiKeyFile', 'secretName', 'apiKeyEnv'] as const

function fail(path: string, message: string): never {
  throw new ConfigError(`${path}: ${message}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(path, 'expected an object')
  }
  return value as Record<string, unknown>
}

function rejectUnknown(raw: Record<string, unknown>, allowed: Set<string>, path: string): void {
  for (const key of Object.keys(raw)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      fail(path, `forbidden key "${key}"`)
    }
    if (!allowed.has(key)) fail(path, `unknown key "${key}"`)
  }
}

function optionalString(raw: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') return fail(`${path}.${key}`, 'expected a non-empty string')
  return value.trim()
}

function requiredString(raw: Record<string, unknown>, key: string, path: string): string {
  const value = optionalString(raw, key, path)
  return value ?? fail(`${path}.${key}`, 'is required')
}

function optionalBoolean(raw: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') return fail(`${path}.${key}`, 'expected a boolean')
  return value
}

function optionalPositiveInteger(raw: Record<string, unknown>, key: string, path: string): number | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return fail(`${path}.${key}`, 'expected a positive integer')
  }
  return value
}

function optionalStringArray(raw: Record<string, unknown>, key: string, path: string): string[] | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return fail(`${path}.${key}`, 'expected an array of strings')
  }
  return value as string[]
}

function optionalHeaderRecord(raw: Record<string, unknown>, key: string, path: string): Record<string, string> | undefined {
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

function optionalCompat(raw: Record<string, unknown>, key: string, path: string): PiAiCompatProfile | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  return asRecord(value, `${path}.${key}`) as PiAiCompatProfile
}

function optionalUrl(raw: Record<string, unknown>, key: string, path: string, required: boolean): string | undefined {
  const value = required ? requiredString(raw, key, path) : optionalString(raw, key, path)
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return fail(`${path}.${key}`, 'expected an absolute http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(`${path}.${key}`, 'expected an http(s) URL')
  return value.replace(/\/+$/, '')
}

function optionalApi(raw: Record<string, unknown>, key: string, path: string): Api | undefined {
  const value = optionalString(raw, key, path)
  if (value === undefined) return undefined
  if (!API_VALUES.has(value as Api)) {
    fail(`${path}.${key}`, `expected one of ${[...API_VALUES].join(', ')}`)
  }
  return value as Api
}

function hasKeyFields(raw: Record<string, unknown>): boolean {
  return KEY_FIELDS.some((field) => raw[field] !== undefined && raw[field] !== null)
}

function keySourceOf(raw: Record<string, unknown>, path: string, secretDir: string): KeySource | undefined {
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
    if (!ENV_NAME.test(apiKeyEnv)) fail(`${path}.apiKeyEnv`, 'expected an environment variable name')
    return { kind: 'env', name: apiKeyEnv }
  }
  return undefined
}

function parseModels(raw: Record<string, unknown>, path: string): ModelConfig[] | undefined {
  const value = raw.models
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0) fail(`${path}.models`, 'expected a non-empty array')
  return value.map((entry, index) => {
    const modelPath = `${path}.models[${index}]`
    const record = asRecord(entry, modelPath)
    rejectUnknown(record, MODEL_KEYS, modelPath)
    const id = requiredString(record, 'id', modelPath)
    const name = optionalString(record, 'name', modelPath)
    const contextWindow = optionalPositiveInteger(record, 'contextWindow', modelPath)
    const maxTokens = optionalPositiveInteger(record, 'maxTokens', modelPath)
    const inputRaw = optionalStringArray(record, 'input', modelPath)
    const input = inputRaw?.map((value) => {
      if (value !== 'text' && value !== 'image') fail(`${modelPath}.input`, 'only "text" and "image" are supported')
      return value
    })
    const reasoningRaw = record.reasoning
    let reasoning: false | string[] | undefined
    if (reasoningRaw === false) {
      reasoning = false
    } else if (reasoningRaw !== undefined && reasoningRaw !== null) {
      if (!Array.isArray(reasoningRaw) || reasoningRaw.length === 0 || reasoningRaw.some((v) => typeof v !== 'string')) {
        fail(`${modelPath}.reasoning`, 'expected false or a non-empty array of thinking levels')
      }
      for (const level of reasoningRaw as string[]) {
        if (!THINKING_LEVELS.has(level)) fail(`${modelPath}.reasoning`, `unknown thinking level "${level}"`)
      }
      reasoning = [...(reasoningRaw as string[])]
    }
    return {
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(input === undefined ? {} : { input }),
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  })
}

interface BaseFields {
  providerId: string
  kind: ProviderKind
  catalog?: string
  api?: Api
  baseURL?: string
  modelsURL?: string
  models?: ModelConfig[]
  compat?: PiAiCompatProfile
  headers?: Record<string, string>
  zdr?: boolean
}

function parseBaseFields(
  raw: Record<string, unknown>,
  path: string,
  providerId: string,
  kind: ProviderKind,
): BaseFields {
  if (kind === 'builtin') {
    for (const key of ['api', 'baseURL', 'modelsURL', 'models', 'compat', 'headers', 'zdr']) {
      if (raw[key] !== undefined && raw[key] !== null) fail(`${path}.${key}`, 'is not supported on a builtin provider')
    }
    const catalog = optionalString(raw, 'catalog', path) ?? providerId
    if (!PROVIDER_ID.test(catalog)) fail(`${path}.catalog`, 'expected a catalog provider id')
    return { providerId, kind, catalog }
  }

  if (kind === 'command-code') {
    for (const key of ['catalog', 'api', 'models', 'compat', 'headers']) {
      if (raw[key] !== undefined && raw[key] !== null) fail(`${path}.${key}`, 'is not supported on a command-code provider')
    }
    const baseURL = optionalUrl(raw, 'baseURL', path, false)
    const modelsURL = optionalUrl(raw, 'modelsURL', path, false)
    const zdr = optionalBoolean(raw, 'zdr', path)
    return {
      providerId,
      kind,
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(modelsURL === undefined ? {} : { modelsURL }),
      ...(zdr === undefined ? {} : { zdr }),
    }
  }

  if (raw.catalog !== undefined && raw.catalog !== null) fail(`${path}.catalog`, 'is not supported on a custom provider')
  const api = optionalApi(raw, 'api', path) ?? fail(`${path}.api`, 'is required for a custom provider')
  const baseURL = optionalUrl(raw, 'baseURL', path, true) as string
  const modelsURL = optionalUrl(raw, 'modelsURL', path, false)
  const models = parseModels(raw, path)
  if (modelsURL === undefined && models === undefined) {
    fail(path, 'custom provider needs modelsURL or models')
  }
  const compat = optionalCompat(raw, 'compat', path)
  const headers = optionalHeaderRecord(raw, 'headers', path)
  return {
    providerId,
    kind,
    api,
    baseURL,
    ...(modelsURL === undefined ? {} : { modelsURL }),
    ...(models === undefined ? {} : { models }),
    ...(compat === undefined ? {} : { compat }),
    ...(headers === undefined ? {} : { headers }),
  }
}

function parseProvider(
  providerId: string,
  value: unknown,
  secretDir: string,
): ResolvedProvider[] {
  const path = `providers.${providerId}`
  if (!PROVIDER_ID.test(providerId)) fail(path, 'provider ids must be lowercase letters, digits, or hyphens')
  const raw = asRecord(value, path)
  rejectUnknown(raw, PROVIDER_KEYS, path)
  const kindRaw = requiredString(raw, 'kind', path)
  if (kindRaw !== 'builtin' && kindRaw !== 'custom' && kindRaw !== 'command-code') {
    fail(`${path}.kind`, 'expected builtin, custom, or command-code')
  }
  const kind = kindRaw as ProviderKind
  if (optionalBoolean(raw, 'enabled', path) === false) return []
  const displayName = optionalString(raw, 'displayName', path) ?? providerId
  const base = parseBaseFields(raw, path, providerId, kind)

  const accountsRaw = raw.accounts
  if (accountsRaw === undefined || accountsRaw === null) {
    const keySource = keySourceOf(raw, path, secretDir) ?? fail(path, 'no key source (apiKeyFile, secretName, or apiKeyEnv)')
    return [{ ...base, route: providerId, displayName, keySource }]
  }

  const accounts = asRecord(accountsRaw, `${path}.accounts`)
  const entries = Object.entries(accounts)
  if (entries.length === 0) fail(`${path}.accounts`, 'must not be empty')
  const baseKey = keySourceOf(raw, path, secretDir)
  const result: ResolvedProvider[] = []
  for (const [accountId, accountValue] of entries) {
    const accountPath = `${path}.accounts.${accountId}`
    if (!PROVIDER_ID.test(accountId)) fail(accountPath, 'account ids must be lowercase letters, digits, or hyphens')
    const account = asRecord(accountValue, accountPath)
    rejectUnknown(account, ACCOUNT_KEYS, accountPath)
    if (optionalBoolean(account, 'enabled', accountPath) === false) continue

    const routeId = optionalString(account, 'routeId', accountPath) ?? `${providerId}-${accountId}`
    if (!PROVIDER_ID.test(routeId)) fail(`${accountPath}.routeId`, 'expected lowercase letters, digits, or hyphens')
    const accountDisplay = optionalString(account, 'displayName', accountPath) ?? `${displayName} (${accountId})`
    const keySource = hasKeyFields(account)
      ? keySourceOf(account, accountPath, secretDir)
      : baseKey
    if (keySource === undefined) fail(accountPath, 'no key source (apiKeyFile, secretName, or apiKeyEnv)')

    if (kind === 'builtin') {
      for (const key of ['api', 'baseURL', 'modelsURL', 'models', 'compat', 'headers', 'zdr']) {
        if (account[key] !== undefined && account[key] !== null) fail(`${accountPath}.${key}`, 'is not supported on a builtin account')
      }
      result.push({ ...base, route: routeId, displayName: accountDisplay, keySource })
      continue
    }

    if (kind === 'command-code') {
      for (const key of ['catalog', 'api', 'models', 'compat', 'headers']) {
        if (account[key] !== undefined && account[key] !== null) fail(`${accountPath}.${key}`, 'is not supported on a command-code account')
      }
      const baseURL = optionalUrl(account, 'baseURL', accountPath, false)
      const modelsURL = optionalUrl(account, 'modelsURL', accountPath, false)
      const zdr = optionalBoolean(account, 'zdr', accountPath)
      result.push({
        ...base,
        ...(baseURL === undefined ? {} : { baseURL }),
        ...(modelsURL === undefined ? {} : { modelsURL }),
        ...(zdr === undefined ? {} : { zdr }),
        route: routeId,
        displayName: accountDisplay,
        keySource,
      })
      continue
    }

    if (account.catalog !== undefined && account.catalog !== null) fail(`${accountPath}.catalog`, 'is not supported')
    if (account.zdr !== undefined && account.zdr !== null) fail(`${accountPath}.zdr`, 'is not supported on a custom account')
    const api = optionalApi(account, 'api', accountPath) ?? base.api
    const baseURL = optionalUrl(account, 'baseURL', accountPath, false) ?? base.baseURL
    const modelsURL = optionalUrl(account, 'modelsURL', accountPath, false) ?? base.modelsURL
    const models = parseModels(account, accountPath) ?? base.models
    if (modelsURL === undefined && models === undefined) fail(accountPath, 'needs modelsURL or models')
    const compat = optionalCompat(account, 'compat', accountPath)
    const headers = optionalHeaderRecord(account, 'headers', accountPath)
    result.push({
      ...base,
      ...(api === undefined ? {} : { api }),
      ...(baseURL === undefined ? {} : { baseURL }),
      ...(modelsURL === undefined ? {} : { modelsURL }),
      ...(models === undefined ? {} : { models }),
      ...(compat === undefined ? {} : { compat: { ...(base.compat ?? {}), ...compat } }),
      ...(headers === undefined ? {} : { headers: { ...(base.headers ?? {}), ...headers } }),
      route: routeId,
      displayName: accountDisplay,
      keySource,
    })
  }
  return result
}

/** Resolve one parsed YAML document into enabled routes. */
export function resolveConfig(value: unknown): ResolvedProvider[] {
  const raw = asRecord(value, 'config')
  rejectUnknown(raw, new Set(['secretDir', 'providers']), 'config')
  const secretDir = optionalString(raw, 'secretDir', 'config')
  if (secretDir !== undefined && !isAbsolute(secretDir)) fail('config.secretDir', 'expected an absolute path')
  const effectiveSecretDir = secretDir ?? defaultSecretDir()
  const providersRaw = raw.providers
  if (providersRaw === undefined || providersRaw === null) fail('config.providers', 'is required')
  const providers = asRecord(providersRaw, 'config.providers')
  const routes = new Set<string>()
  const result: ResolvedProvider[] = []
  for (const [providerId, provider] of Object.entries(providers)) {
    for (const resolved of parseProvider(providerId, provider, effectiveSecretDir)) {
      if (routes.has(resolved.route)) fail(`providers.${providerId}`, `duplicate route id "${resolved.route}"`)
      routes.add(resolved.route)
      result.push(resolved)
    }
  }
  return result
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
  const configured = explicit?.trim()
  if (configured !== undefined && configured !== '') {
    return isAbsolute(configured) ? configured : resolve(configured)
  }
  const home = process.env.DSH_HOME?.trim()
  return join(home !== undefined && home !== '' ? home : join(homedir(), '.dsh'), 'more-providers.yaml')
}

/** Read and validate the YAML file. Throws ConfigError on any problem. */
export async function loadConfig(path: string): Promise<ResolvedProvider[]> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${(error as Error).message}`)
  }
  let value: unknown
  try {
    value = parse(text)
  } catch (error) {
    throw new ConfigError(`invalid YAML in ${path}: ${(error as Error).message}`)
  }
  return resolveConfig(value)
}
