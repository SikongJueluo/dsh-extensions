/**
 * OpenAI OAuth (ChatGPT subscription) LLM adapter.
 * @module dsh-more-providers/providers/chatgpt/adapter
 */
import { Readable } from 'node:stream'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ProviderRequestId,
  ReasoningEffortId,
  ToolCallId,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'
import type {
  BuiltinLlmFailureCode,
  FinishReason,
  GenerateOptions,
  ImageAttachmentAccessResolver,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { longEdgeDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Logger } from '@deepseek-ai/cordis'
import { debugQuietly } from '../../diagnostics.js'
import type { FetchLike } from '../../oauth/transport.js'
import { isRecord } from '../../record.js'
import type { ProviderImageServices } from '../../runtime.js'
import type { ModelCatalog } from './catalog.js'
import { oauthHeaders } from './auth.js'
import type { TokenStore } from './auth.js'
import { REASONING_EFFORT_NAMES } from './catalog.js'
import { PACKAGE_NAME } from '../../identity.js'
import { serializeRequest, clampSessionAffinityKey } from './serialize.js'
import type { RequestImages } from './serialize.js'

/** One request's prepared image content: versions plus their access resolver. */
interface PreparedRequestImages {
  images: RequestImages
  access: ImageAttachmentAccessResolver
}

/** Connection facts resolved from the startup config snapshot. */
export interface AdapterOptions {
  baseURL: string
  defaultReasoningEffort: string
  defaultReasoningEfforts: string[]
  defaultContextWindow: number
  refreshMarginMs: number
  promptCacheKey: boolean
}

const REQUEST_IMAGE_LONG_EDGE = 2048
const REQUEST_IMAGE_MAX_BYTES = 2 ** 30

/** Map the Responses API SSE byte stream into data payload strings. */
async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const stream: AsyncIterable<Uint8Array> = Readable.fromWeb(
    body as Parameters<typeof Readable.fromWeb>[0],
  )
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const data = frameData(frame)
      if (data !== null) yield data
    }
  }
  buffer += decoder.decode()
  const data = frameData(buffer)
  if (data !== null) yield data
}

/** Extract the joined `data:` payload of one SSE frame, or null. */
function frameData(frame: string): string | null {
  const lines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /u, ''))
  }
  const data = lines.join('\n')
  return data === '' || data === '[DONE]' ? null : data
}

/** Map Responses API usage into the harness disjoint TokenUsage. */
function mapUsage(usage: unknown): TokenUsage {
  const record = isRecord(usage) ? usage : {}
  const inputDetails = isRecord(record.input_tokens_details) ? record.input_tokens_details : {}
  const outputDetails = isRecord(record.output_tokens_details) ? record.output_tokens_details : {}
  const cacheRead = inputDetails.cached_tokens
  const cacheWrite = inputDetails.cache_write_tokens
  const reasoning = outputDetails.reasoning_tokens
  return {
    inputTokens:
      (typeof record.input_tokens === 'number' ? record.input_tokens : 0) -
      (typeof cacheRead === 'number' ? cacheRead : 0),
    outputTokens: typeof record.output_tokens === 'number' ? record.output_tokens : 0,
    ...(typeof cacheRead === 'number' ? { cacheReadTokens: cacheRead } : {}),
    ...(typeof cacheWrite === 'number' ? { cacheWriteTokens: cacheWrite } : {}),
    ...(typeof reasoning === 'number' ? { reasoningTokens: reasoning } : {}),
  }
}

/** Map an HTTP status plus parsed error body to a stable LlmError code. */
function httpErrorCode(
  status: number,
  detail: Record<string, unknown> | undefined,
): BuiltinLlmFailureCode {
  if (status === 401 || status === 403) return 'AUTH'
  const text = [detail?.code, detail?.type, detail?.message, detail?.detail]
    .filter(Boolean)
    .join(' ')
  if (isQuotaExceededError(text)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(text)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

interface TrackedBlock {
  key: string
  type: 'text' | 'reasoning' | 'tool-call'
  index: number
  started: boolean
  closed: boolean
  callId: string
  name: string
  text: string
}

/** Assemble the terminal ContentBlock for one tracked block. */
function closeBlock(block: TrackedBlock): StreamChunk {
  if (block.type === 'text') {
    return { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
  }
  if (block.type === 'reasoning') {
    return { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
  }
  return {
    type: 'block-end',
    index: block.index,
    block: {
      type: 'tool-call',
      id: ToolCallId(block.callId),
      name: block.name,
      arguments: block.text,
    },
  }
}

interface TranslateState {
  sawToolCall: boolean
  incompleteReason?: string
  errorFailure?: { message: string; code: string }
  anyBlock: boolean
}

function finishReason(state: TranslateState): FinishReason {
  if (state.errorFailure) return { kind: 'error', failure: state.errorFailure }
  if (state.incompleteReason === 'max_output_tokens') return { kind: 'max-tokens' }
  if (state.sawToolCall) return { kind: 'tool-calls' }
  if (!state.anyBlock) {
    return {
      kind: 'error',
      failure: {
        message: 'model returned a completed response with no content',
        code: EMPTY_RESPONSE_CODE,
      },
    }
  }
  return { kind: 'stop' }
}

/** Consume Responses API SSE payloads and yield harness StreamChunks. */
async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  const blocks = new Map<string, TrackedBlock>()
  const order: string[] = []
  const state: TranslateState = { sawToolCall: false, anyBlock: false }
  let pendingUsage: TokenUsage | undefined

  const open = (key: string, type: TrackedBlock['type']): TrackedBlock => {
    let block = blocks.get(key)
    if (!block) {
      block = {
        key,
        type,
        index: nextIndex++,
        started: false,
        closed: false,
        callId: '',
        name: '',
        text: '',
      }
      blocks.set(key, block)
      order.push(key)
      state.anyBlock = true
    }
    return block
  }
  const start = (block: TrackedBlock): StreamChunk | null => {
    if (!block.started) {
      block.started = true
      return { type: 'block-start', index: block.index, blockType: block.type }
    }
    return null
  }
  const end = (block: TrackedBlock): StreamChunk | null => {
    if (block.closed) return null
    block.closed = true
    return closeBlock(block)
  }

  for await (const payload of payloads) {
    let ev: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(payload)
      if (!isRecord(parsed)) throw new Error('not an object')
      ev = parsed
    } catch {
      throw new LlmError('malformed SSE payload', 'MALFORMED_RESPONSE')
    }
    const type = ev.type
    const outputIndex = typeof ev.output_index === 'number' ? ev.output_index : -1
    const contentIndex = typeof ev.content_index === 'number' ? ev.content_index : -1

    if (type === 'response.output_item.added') {
      const item = isRecord(ev.item) ? ev.item : {}
      if (item.type === 'function_call') {
        const block = open(`f:${outputIndex}`, 'tool-call')
        if (typeof item.call_id === 'string') block.callId = item.call_id
        if (typeof item.name === 'string') block.name = item.name
        state.sawToolCall = true
        const chunk = start(block)
        if (chunk) yield chunk
      }
    } else if (type === 'response.output_text.delta') {
      const block = open(`t:${outputIndex}:${contentIndex}`, 'text')
      const chunk = start(block)
      if (chunk) yield chunk
      const delta = typeof ev.delta === 'string' ? ev.delta : ''
      block.text += delta
      if (delta.length > 0) yield { type: 'text-delta', index: block.index, text: delta }
    } else if (type === 'response.function_call_arguments.delta') {
      const block = open(`f:${outputIndex}`, 'tool-call')
      const chunk = start(block)
      if (chunk) yield chunk
      const delta = typeof ev.delta === 'string' ? ev.delta : ''
      block.text += delta
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: ToolCallId(block.callId),
        ...(block.name ? { name: block.name } : {}),
        argumentsDelta: delta,
      }
    } else if (type === 'response.reasoning_summary_text.delta') {
      const block = open(`r:${outputIndex}:${contentIndex}`, 'reasoning')
      const chunk = start(block)
      if (chunk) yield chunk
      const delta = typeof ev.delta === 'string' ? ev.delta : ''
      block.text += delta
      if (delta.length > 0) yield { type: 'reasoning-delta', index: block.index, text: delta }
    } else if (type === 'response.output_text.done') {
      const block = open(`t:${outputIndex}:${contentIndex}`, 'text')
      const chunk = start(block)
      if (chunk) yield chunk
      if (typeof ev.text === 'string' && block.text.length === 0 && ev.text.length > 0) {
        block.text = ev.text
        yield { type: 'text-delta', index: block.index, text: ev.text }
      }
      const ended = end(block)
      if (ended) yield ended
    } else if (type === 'response.output_item.done') {
      const item = isRecord(ev.item) ? ev.item : {}
      if (item.type === 'function_call') {
        const block = blocks.get(`f:${outputIndex}`)
        if (block) {
          const ended = end(block)
          if (ended) yield ended
        }
      }
    } else if (type === 'response.completed') {
      const resp = isRecord(ev.response) ? ev.response : {}
      if (resp.status === 'incomplete' && isRecord(resp.incomplete_details)) {
        const reason = resp.incomplete_details.reason
        if (typeof reason === 'string' && reason !== '') state.incompleteReason = reason
      }
      if (resp.usage) pendingUsage = mapUsage(resp.usage)
    } else if (type === 'response.failed' || type === 'error') {
      const response = isRecord(ev.response) ? ev.response : undefined
      const fromResponse = isRecord(response) ? response.error : undefined
      const err = isRecord(fromResponse) ? fromResponse : isRecord(ev.error) ? ev.error : undefined
      const message = isRecord(err) && typeof err.message === 'string' ? err.message : undefined
      const code = isRecord(err) && typeof err.code === 'string' ? err.code : undefined
      state.errorFailure = {
        message: message ?? 'model request failed',
        code: code ?? 'PROVIDER_ERROR',
      }
    }
  }

  for (const key of order) {
    const block = blocks.get(key)
    if (!block) continue
    const ended = end(block)
    if (ended) yield ended
  }
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
  yield { type: 'finish', reason: finishReason(state) }
}

export interface OpenAiOauthAdapterDeps {
  options: AdapterOptions
  tokenStore: TokenStore
  catalog: ModelCatalog
  getFetch: () => Promise<FetchLike>
  images: ProviderImageServices
  logger?: Logger
}

export class OpenAiOauthAdapter extends LlmAdapter {
  private readonly options: AdapterOptions
  private readonly tokenStore: TokenStore
  private readonly catalog: ModelCatalog
  private readonly getFetch: () => Promise<FetchLike>
  private readonly images: ProviderImageServices
  private readonly logger: Logger | undefined

  constructor({ options, tokenStore, catalog, getFetch, images, logger }: OpenAiOauthAdapterDeps) {
    super()
    this.options = options
    this.tokenStore = tokenStore
    this.catalog = catalog
    this.getFetch = getFetch
    this.images = images
    this.logger = logger
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ChatGPT (OpenAI)' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const { access, accountId } = await this.tokenStore.resolve(this.options.refreshMarginMs)
    const models = await this.catalog.refresh(oauthHeaders(access, accountId))
    return models.map((model) => this.modelInfo(provider, model))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.catalog.resolve(model)
    const cfg = this.options
    const contextWindow = entry.contextWindow ?? cfg.defaultContextWindow
    const efforts = entry.reasoning.length > 0 ? entry.reasoning : cfg.defaultReasoningEfforts
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.inputModalities,
      context: { contextWindow },
      reasoning: {
        efforts: efforts.map((effort) => ({
          id: ReasoningEffortId(effort),
          name: REASONING_EFFORT_NAMES[effort] ?? effort,
        })),
        defaultEffort: ReasoningEffortId(cfg.defaultReasoningEffort),
      },
    }
  }

  private modelInfo(
    provider: string,
    model: { id: string; name: string; inputModalities: readonly ('text' | 'image')[] },
  ): LlmModelInfo {
    return { provider, id: model.id, name: model.name, inputModalities: model.inputModalities }
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const cfg = this.options
    const fetchFn = await this.getFetch()
    const { access, accountId } = await this.tokenStore.resolve(cfg.refreshMarginMs)
    const controller = new AbortController()
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal])
    const iterator = this.request(options, signal, cfg, fetchFn, access, accountId)[
      Symbol.asyncIterator
    ]()
    try {
      while (true) {
        const result = await iterator.next()
        if (result.done) return
        yield result.value
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError('OpenAI OAuth request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`OpenAI OAuth stream from ${cfg.baseURL} failed`, 'TRANSPORT', {
        cause: error,
      })
    } finally {
      controller.abort('stream consumer stopped')
      if (iterator.return !== undefined) {
        try {
          await iterator.return(undefined)
        } catch (error) {
          debugQuietly(
            this.logger,
            'chatgpt stream: upstream iterator cleanup failed (%s); stream already stopping',
            error,
          )
        }
      }
    }
  }

  private async prepareImages(
    options: GenerateOptions,
    signal: AbortSignal,
  ): Promise<PreparedRequestImages | undefined> {
    if (!options.messages.some((message) => contentHasImage(message.content))) return undefined
    const attachments = this.images.resolveAttachments()
    if (attachments === undefined) {
      throw new LlmError(
        'the attachment service is unavailable; cannot read request images',
        'UNSUPPORTED_CONTENT',
      )
    }
    const refs = new Map<string, ImageAttachmentRef>()
    for (const message of options.messages) {
      for (const block of message.content) {
        if (block.type === 'image' && block.offloaded !== true) {
          refs.set(block.attachment.attachmentId, block.attachment)
        }
      }
    }
    const versions = new Map<string, RequestImageAttachment>()
    await Promise.all(
      [...refs.values()].map(async (ref) => {
        versions.set(
          ref.attachmentId,
          await attachments.readImageRequest(
            ref,
            {
              ...longEdgeDimensions(ref.width, ref.height, REQUEST_IMAGE_LONG_EDGE),
              maxBytes: REQUEST_IMAGE_MAX_BYTES,
            },
            signal,
          ),
        )
      }),
    )
    return {
      images: versions,
      access: (ref) => this.images.resolveImageAccess(attachments, ref),
    }
  }

  private async *request(
    options: GenerateOptions,
    signal: AbortSignal,
    cfg: AdapterOptions,
    fetchFn: FetchLike,
    access: string,
    accountId: string | undefined,
  ): AsyncGenerator<StreamChunk> {
    const prepared = await this.prepareImages(options, signal)
    const body = serializeRequest(
      options,
      prepared?.images,
      { promptCacheKey: cfg.promptCacheKey },
      prepared?.access,
    )
    const affinityKey =
      cfg.promptCacheKey && options.sessionId !== undefined
        ? clampSessionAffinityKey(String(options.sessionId))
        : undefined
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      originator: PACKAGE_NAME,
      ...(affinityKey !== undefined
        ? { 'session-id': affinityKey, 'x-client-request-id': affinityKey }
        : {}),
      ...oauthHeaders(access, accountId),
      ...attributionHeaders(),
    }
    let response: Response
    try {
      response = await fetchFn(`${cfg.baseURL}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new LlmError(`OpenAI OAuth request to ${cfg.baseURL} failed`, 'TRANSPORT', {
        cause: error,
      })
    }
    if (!response.ok) {
      let message = `OpenAI OAuth API error (HTTP ${response.status})`
      let providerError: Record<string, unknown> | undefined
      try {
        const parsed: unknown = await response.json()
        const record = isRecord(parsed) ? parsed : undefined
        const fromError = isRecord(record) ? record.error : undefined
        providerError = isRecord(fromError) ? fromError : record
        if (record !== undefined && typeof record.detail === 'string') message = record.detail
        else if (isRecord(providerError) && providerError.message)
          message =
            typeof providerError.message === 'string'
              ? providerError.message
              : (JSON.stringify(providerError.message) ?? '')
      } catch (error) {
        debugQuietly(
          this.logger,
          'chatgpt response: error body could not be parsed (%s, HTTP %d); keeping the generic message',
          error,
          response.status,
        )
      }
      const rid = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(rid ? { requestId: rid } : {}),
      })
    }
    if (!response.body)
      throw new LlmError('OpenAI OAuth API returned no response body', 'EMPTY_RESPONSE')
    yield* translate(parseSse(response.body))
  }
}

function requestId(headers: Headers): ProviderRequestId | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-openai-request-id')
  return value ? ProviderRequestId(value) : undefined
}
