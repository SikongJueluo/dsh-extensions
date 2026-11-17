/**
 * Harness message -> OpenAI Responses API `input` serialization.
 * @module dsh-more-providers/providers/chatgpt/serialize
 */
import {
  LlmError,
  contentHasImage,
  offloadedImageText,
  requestImageHandleText,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccessResolver,
  ImageBlock,
  RequestMessage,
} from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Prepared request-image versions keyed by attachment id. */
export type RequestImages = ReadonlyMap<string, RequestImageAttachment>

/** Join the text blocks of a message's content into one string. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Reject image content the Responses wire path cannot represent (assistant role). */
function assertNoUnrepresentableImage(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      'The OpenAI OAuth (ChatGPT subscription) adapter cannot represent image content in assistant messages.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** Resolve the prepared request-image version for one live occurrence, or throw. */
function requestVersion(
  block: ImageBlock,
  images: RequestImages | undefined,
): RequestImageAttachment {
  const version = images?.get(block.attachment.attachmentId)
  if (version === undefined) {
    throw new LlmError(
      `no request image prepared for attachment ${block.attachment.attachmentId}`,
      'INVALID_REQUEST',
    )
  }
  return version
}

/** Build the wire `input_image` part for one prepared request image. */
function imagePart(version: RequestImageAttachment): InputItem {
  return {
    type: 'input_image',
    image_url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
    detail: 'high',
  }
}

function userContent(
  blocks: readonly ContentBlock[],
  images: RequestImages | undefined,
  access?: ImageAttachmentAccessResolver,
): InputItem[] {
  if (!blocks.some((block) => block.type === 'image')) {
    return [{ type: 'input_text', text: flattenText(blocks) }]
  }
  const content: InputItem[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      if (block.offloaded === true) {
        content.push({
          type: 'input_text',
          text: offloadedImageText(block.attachment, access?.(block.attachment)),
        })
        continue
      }
      const version = requestVersion(block, images)
      content.push(
        {
          type: 'input_text',
          text: requestImageHandleText(block.attachment, version, access?.(block.attachment)),
        },
        imagePart(version),
      )
    }
  }
  return content.length > 0 ? content : [{ type: 'input_text', text: '' }]
}

/** Serialize one tool result's `function_call_output.output` value. Text-only results keep the historical plain-string output; results carrying image blocks switch to the content-item array Codex sends for MCP image results, with offloaded occurrences degrading to placeholder text. */
function toolOutput(
  blocks: readonly ContentBlock[],
  images: RequestImages | undefined,
  access?: ImageAttachmentAccessResolver,
): string | InputItem[] {
  if (!blocks.some((block) => block.type === 'image')) {
    return flattenText(blocks) || '(no output)'
  }
  const items: InputItem[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) items.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      if (block.offloaded === true) {
        items.push({
          type: 'input_text',
          text: offloadedImageText(block.attachment, access?.(block.attachment)),
        })
        continue
      }
      items.push(imagePart(requestVersion(block, images)))
    }
  }
  return items.length > 0 ? items : [{ type: 'input_text', text: '(no output)' }]
}

/** A Responses API input item (loose structural type). */
type InputItem = Record<string, unknown>

/** Serialize the conversation into Responses API input items. System messages are skipped - the harness delivers the system prompt separately as `GenerateOptions.system` -> `instructions`. */
function serializeInput(
  messages: readonly RequestMessage[],
  images?: RequestImages,
  access?: ImageAttachmentAccessResolver,
): InputItem[] {
  const input: InputItem[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue

    if (message.role === 'assistant') {
      assertNoUnrepresentableImage(message.content)
      const text = flattenText(message.content)
      const toolCalls = message.content.filter((block) => block.type === 'tool-call')
      if (text.length > 0) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
      }
      for (const call of toolCalls) {
        if (call.type !== 'tool-call') continue
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
          status: 'completed',
        })
      }
      continue
    }

    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: toolOutput(message.content, images, access),
      })
      continue
    }

    input.push({ role: 'user', content: userContent(message.content, images, access) })
  }
  return input
}

/** Resolve the wire `reasoning` field from the harness reasoning effort. Returns `undefined` (omitted) for the "off" / unset case so the backend applies its own default. */
function resolveReasoning(effort: string | undefined): { effort: string } | undefined {
  if (effort === undefined || effort === 'off') return undefined
  return { effort }
}

const AFFINITY_KEY_MAX_LENGTH = 64

/** Clamp a session id into an OpenAI cache-affinity key (<= 64 chars, by code points). `session-<uuid>` fits as-is; the clamp only guards exotic ids. */
export function clampSessionAffinityKey(sessionId: string): string {
  const chars = Array.from(sessionId)
  return chars.length <= AFFINITY_KEY_MAX_LENGTH
    ? sessionId
    : chars.slice(0, AFFINITY_KEY_MAX_LENGTH).join('')
}

/** Cache-affinity knobs the serializer honors per request. */
export interface SerializeAffinity {
  promptCacheKey: boolean
}

/** Build the full Responses API request body. The backend rejects the standard `max_output_tokens` / `temperature` / `stop` scalars, so they are deliberately omitted. */
export function serializeRequest(
  options: GenerateOptions,
  images?: RequestImages,
  affinity?: SerializeAffinity,
  access?: ImageAttachmentAccessResolver,
): Record<string, unknown> {
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const reasoning = resolveReasoning(options.reasoningEffort)
  const promptCacheKey =
    affinity?.promptCacheKey !== false && options.sessionId !== undefined
      ? clampSessionAffinityKey(String(options.sessionId))
      : undefined
  return {
    model: options.model,
    ...(options.system !== undefined && options.system.length > 0
      ? { instructions: options.system }
      : {}),
    input: serializeInput(options.messages, images, access),
    ...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}),
    ...(tools !== undefined && tools.length > 0
      ? { tools, tool_choice: 'auto', parallel_tool_calls: true }
      : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    stream: true,
    store: false,
  }
}
