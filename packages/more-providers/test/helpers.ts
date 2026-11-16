/**
 * Shared fixtures for the more-providers contract tests.
 *
 * Every test drives the real plugin seam — `apply(ctx, config)` on a real
 * Cordis context with fixture host services — and observes behavior through
 * what the plugin registers and what the adapters put on the wire. Third-party
 * transports are stubbed; the plugin's own code is never mocked here.
 *
 * @module dsh-more-providers/test/helpers
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.js'

/** YAML `apiKeyEnv` name the fixtures resolve; tests stub it. */
export const TEST_ENV_KEY = 'MORE_PROVIDERS_TEST_KEY'
/** Static fake API key handed to the gateway route. */
export const TEST_API_KEY = 'sk-static-test-key'

/** Fixed valid 1×1 PNG used by both adapters. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64')
/** `data:image/png;base64,…` of {@link PNG_BYTES}, computed from the literal. */
export const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

/** ChatGPT backend the OAuth fixtures point at; the mocked transport answers. */
export const CHATGPT_BASE_URL = 'https://chatgpt.invalid/backend-api/codex'
/** Gateway endpoint the API-key fixtures point at; the stubbed fetch answers. */
const GATEWAY_BASE_URL = 'https://gateway.invalid/v1'

/** One stored OAuth grant for the ChatGPT record (valid, no refresh needed). */
function chatgptGrant(): CredentialRecord {
  return {
    kind: 'grant',
    payload: {
      access: 'test-access-token',
      refresh: 'test-refresh-token',
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
      accountId: 'acct-1',
    },
  }
}

/** Capture-what-the-plugin-registered view of the host `llm` service. */
function fakeLlmService() {
  const adapters: { providers: string[]; adapter: unknown }[] = []
  const configurable: Record<string, unknown>[] = []
  const discoveries = new Map<string, unknown>()
  const service = {
    registerAdapter(providers: string[], adapter: unknown): void {
      adapters.push({ providers, adapter })
    },
    registerConfigurableProviders(list: Record<string, unknown>[]): void {
      configurable.push(...list)
    },
    registerModelDiscovery(ns: string, handler: unknown): void {
      discoveries.set(ns, handler)
    },
  }
  return { adapters, configurable, discoveries, service }
}

/** Capture view of the host `webServer` service (prefix routes and resources). */
function dispose(): void {}

function fakeWebServerService() {
  const routes: { def: Record<string, unknown>; dispose: () => void }[] = []
  const service = {
    register(def: Record<string, unknown>): () => void {
      routes.push({ def, dispose })
      return dispose
    },
  }
  return { routes, service }
}

/** In-memory host `credentials` service that emits the record-update event. */
function fakeCredentialsService(ctx: Context, records: Map<string, CredentialRecord> = new Map()) {
  const service = {
    async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
      return records.get(String(key))
    },
    async describeRecord(key: CredentialKey): Promise<{ configured: boolean; writable: boolean }> {
      return { configured: records.has(String(key)), writable: true }
    },
    async modifyRecord(
      key: CredentialKey,
      mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
    ): Promise<CredentialRecord | undefined> {
      const next = await mutate(records.get(String(key)))
      if (next === undefined) return records.get(String(key))
      records.set(String(key), next)
      ctx.emit('credentials/record-updated', key)
      return next
    },
    async deleteRecord(key: CredentialKey): Promise<void> {
      if (!records.delete(String(key))) return
      ctx.emit('credentials/record-updated', key)
    },
  }
  return { records, service }
}

interface ImageRead {
  ref: ImageAttachmentRef
  target: { width: number; height: number; maxBytes: number }
  signal: AbortSignal | undefined
}

/**
 * The attachment-service members the request pipeline actually calls:
 * `readImageRequest` (with a read log) and `imageHostPath` (absent mapping).
 */
export function fixtureAttachmentStore() {
  const reads: ImageRead[] = []
  const store = {
    imageHostPath(): string | undefined {
      return undefined
    },
    async readImageRequest(
      ref: ImageAttachmentRef,
      target: { width: number; height: number; maxBytes: number },
      signal?: AbortSignal,
    ): Promise<RequestImageAttachment> {
      reads.push({ ref, target, signal })
      return {
        variantId: `variant-${String(ref.attachmentId)}` as RequestImageAttachment['variantId'],
        attachment: ref,
        data: Uint8Array.from(PNG_BYTES),
        mediaType: 'image/png',
        bytes: PNG_BYTES.length,
        width: target.width,
        height: target.height,
        depth: 'uchar',
        space: 'srgb',
        hasAlpha: false,
      }
    },
  }
  return { reads, store: store as unknown as AttachmentStore }
}

/** One durable image reference the fixtures share. */
export function imageRef(id: string): ImageAttachmentRef {
  return {
    attachmentId: id as AttachmentId,
    mediaType: 'image/png',
    bytes: PNG_BYTES.length,
    width: 1,
    height: 1,
    name: 'shot.png',
  }
}

/** Minimal structural type of a registered LLM adapter, as the seam sees it. */
interface AdapterLike {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Parse one captured request's JSON body. */
export function wireBody(call: { init: RequestInit } | undefined): Record<string, unknown> {
  const body = call?.init.body
  if (typeof body !== 'string') throw new TypeError('Expected a captured JSON request body')
  return JSON.parse(body) as Record<string, unknown>
}

/** The adapter registered for one provider route, failing the test if absent. */
export function registeredAdapter(
  llm: { adapters: { providers: string[]; adapter: unknown }[] },
  provider: string,
): AdapterLike {
  const found = adapterFor(llm, provider)
  if (found === undefined) throw new Error(`No adapter registered for ${provider}`)
  return found
}

/** One outbound HTTP request the stubbed transports captured. */
interface CapturedRequest {
  url: string
  init: RequestInit
}

/** A fetch double that records every call and always answers HTTP 400. */
export function capturingFetch() {
  const calls: CapturedRequest[] = []
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal
    // Abort test double: fail immediately when the caller already aborted.
    if (signal?.aborted) throw new Error('aborted before request')
    calls.push({ url: String(url), init: init ?? {} })
    return new Response(JSON.stringify({ error: { message: 'static test 400' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch }
}

/** Collect a whole adapter stream, keeping a thrown error for assertions. */
export async function collectStream(
  stream: AsyncIterable<StreamChunk>,
): Promise<{ chunks: StreamChunk[]; error?: unknown }> {
  const chunks: StreamChunk[] = []
  try {
    for await (const chunk of stream) chunks.push(chunk)
    return { chunks }
  } catch (error) {
    return { chunks, error }
  }
}

/** First chatgpt / gateway adapter registered by the plugin, if any. */
export function adapterFor(
  llm: ReturnType<typeof fakeLlmService>,
  provider: string,
): AdapterLike | undefined {
  const entry = llm.adapters.find((adapter) => adapter.providers.includes(provider))
  return entry === undefined ? undefined : (entry.adapter as AdapterLike)
}

/** The terminal failure `finish` chunk (`error` or `aborted`), if one ended the stream. */
export function errorFinish(
  chunks: StreamChunk[],
): { kind: string; failure?: { code?: string; message?: string } } | undefined {
  const finish = chunks.find((chunk) => chunk.type === 'finish') as
    | { reason?: { kind: string; failure?: { code?: string; message?: string } } }
    | undefined
  const kind = finish?.reason?.kind
  return kind === 'error' || kind === 'aborted' ? finish?.reason : undefined
}

/** A durable assistant message with a model source (no replay state). */
export function assistantMsg(
  provider: string,
  model: string,
  content: RequestMessage['content'],
): RequestMessage {
  return {
    id: 'assistant-1' as never,
    role: 'assistant',
    source: { kind: 'model', provider, model },
    content,
  }
}

/** A durable first-class tool-result message. */
export function toolResultMsg(callId: string, content: RequestMessage['content']): RequestMessage {
  return {
    id: `tool-${callId}` as never,
    role: 'tool',
    source: { kind: 'tool', callId: callId as never },
    toolCallId: callId as never,
    content,
  }
}

/** Live harnesses from this test file, disposed together in afterEach. */
const liveHarnesses: Harness[] = []

export async function disposeTracked(): Promise<void> {
  for (const harness of liveHarnesses.splice(0)) {
    await harness.ctx.fiber.dispose().catch(() => undefined)
  }
}

/** Poll until `ready()` turns true or the wait budget is spent. */
export async function waitFor(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) return
    await new Promise<void>((settle) => {
      setTimeout(settle, 5)
    })
  }
  throw new Error(`timed out waiting for ${what}`)
}

const directories: string[] = []

/** Write a fixture YAML document into a fresh temp directory. */
async function writeYaml(doc: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-more-providers-test-'))
  directories.push(directory)
  const file = join(directory, 'more-providers.yaml')
  await writeFile(file, doc)
  return file
}

/** Remove every temp directory this process created (call in afterEach). */
export async function cleanupYamlFiles(): Promise<void> {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Gateway YAML fragment with the env-backed static key. */
export function gatewayYaml(indent = '  '): string {
  return [
    `${indent}gateway:`,
    `${indent}  kind: custom`,
    `${indent}  api: openai-responses`,
    `${indent}  baseURL: ${GATEWAY_BASE_URL}`,
    `${indent}  apiKeyEnv: ${TEST_ENV_KEY}`,
    `${indent}  models:`,
    `${indent}    - id: gateway-large`,
    `${indent}      input: [text, image]`,
  ].join('\n')
}

/** Harness the tests build: real apply over fixture host services. */
export interface Harness {
  ctx: Context
  llm: ReturnType<typeof fakeLlmService>
  web: ReturnType<typeof fakeWebServerService>
  credentials: ReturnType<typeof fakeCredentialsService>
  attachments: ReturnType<typeof fixtureAttachmentStore> | undefined
  /** The file the plugin row points at. */
  file: string
}

export interface HarnessOptions {
  /** The full YAML document. */
  yaml: string
  /** Provide the attachment service. @default true */
  attachments?: boolean
  /** Seed the `oauth-providers/chatgpt` grant record. @default true */
  chatgptGrant?: boolean
  /** Value for the test env key; empty string leaves it unreadable. */
  envKey?: string
}

/** Build a context with fixture services and run the real plugin apply. */
export async function createHarness(options: HarnessOptions): Promise<Harness> {
  const ctx = new Context()
  const llm = fakeLlmService()
  const web = fakeWebServerService()
  const records = new Map<string, CredentialRecord>()
  if (options.chatgptGrant !== false) {
    records.set(String(credentialKey('oauth-providers', 'chatgpt')), chatgptGrant())
  }
  const credentials = fakeCredentialsService(ctx, records)
  const attachments = options.attachments === false ? undefined : fixtureAttachmentStore()

  ctx.provide('llm', llm.service as never)
  ctx.provide('webServer', web.service as never)
  ctx.provide('credentials', credentials.service as never)
  if (attachments !== undefined) ctx.provide('attachments', attachments.store as never)
  process.env[TEST_ENV_KEY] = options.envKey ?? TEST_API_KEY

  const file = await writeYaml(options.yaml)
  await apply(ctx, { configFile: file })
  const harness: Harness = { ctx, llm, web, credentials, attachments, file }
  liveHarnesses.push(harness)
  return harness
}

/** Serialized conversation for one stream call. */
export function generateOptions(
  provider: string,
  model: string,
  messages: RequestMessage[],
  extra: Partial<GenerateOptions> = {},
): GenerateOptions {
  return {
    provider,
    model,
    messages,
    ...extra,
  }
}
