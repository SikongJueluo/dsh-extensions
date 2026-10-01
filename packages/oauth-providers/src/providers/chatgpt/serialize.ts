/**
 * Harness message → OpenAI Responses API `input` serialization.
 *
 * The ChatGPT subscription backend only accepts the Responses wire shape:
 * user/assistant messages plus top-level `function_call` / `function_call_output`
 * items. Assistant reasoning is dropped (the backend does not surface raw
 * reasoning without an opt-in summary). User-role image blocks map to
 * `input_image` parts with inline base64 data URLs — the exact shape Codex
 * sends to the same endpoint; images in other roles are rejected because the
 * wire path cannot represent them.
 *
 * Tool results are first-class `role: 'tool'` messages in the 0.2 message
 * model; developer-role tool addition/removal notices are skipped — the
 * harness projects active declarations through `GenerateOptions.tools` /
 * `toolHistory` instead.
 *
 * Derived from werifu/dsh-oai-oauth (MIT) — see THIRD-PARTY-NOTICE.md.
 *
 * @module dsh-openai-oauth/serialize
 */
import { LlmError, contentHasImage, offloadedImageText, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Prepared request-image versions keyed by attachment id. */
export type RequestImages = ReadonlyMap<string, RequestImageAttachment>

/** Join the text blocks of a message's content into one string. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** Reject image content the Responses wire path cannot represent (non-user roles). */
function assertNoUnrepresentableImage(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      'The OpenAI OAuth (ChatGPT subscription) adapter only carries image content in user messages.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/**
 * Serialize one user message's blocks into Responses content parts. Text-only
 * messages keep the historical single joined `input_text` part; messages with
 * live image blocks map block-by-block (`input_text` / `input_image`), while
 * offloaded image occurrences degrade to their placeholder text.
 */
function userContent(blocks: readonly ContentBlock[], images: RequestImages | undefined): InputItem[] {
  if (!blocks.some((block) => block.type === 'image')) {
    return [{ type: 'input_text', text: flattenText(blocks) }]
  }
  const content: InputItem[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      if (block.offloaded === true) {
        content.push({ type: 'input_text', text: offloadedImageText(block.attachment) })
        continue
      }
      const version = images?.get(block.attachment.attachmentId)
      if (version === undefined) {
        throw new LlmError(
          `no request image prepared for attachment ${block.attachment.attachmentId}`,
          'INVALID_REQUEST',
        )
      }
      // Label the occurrence the way Codex does, so the model can name it.
      content.push({ type: 'input_text', text: requestImageHandleText(block.attachment, version) })
      content.push({
        type: 'input_image',
        image_url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
        detail: 'high',
      })
    }
  }
  return content.length > 0 ? content : [{ type: 'input_text', text: '' }]
}

/** A Responses API input item (loose structural type). */
type InputItem = Record<string, unknown>

/**
 * Serialize the conversation into Responses API input items.
 * System messages are skipped — the harness delivers the system prompt
 * separately as `GenerateOptions.system` → `instructions`.
 */
export function serializeInput(messages: readonly RequestMessage[], images?: RequestImages): InputItem[] {
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
      assertNoUnrepresentableImage(message.content)
      // 0.2 message model: one first-class tool-role message per result.
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: flattenText(message.content) || '(no output)',
      })
      continue
    }

    // User-role messages (persisted or one-shot identity-free inputs).
    input.push({ role: 'user', content: userContent(message.content, images) })
  }
  return input
}

/**
 * Resolve the wire `reasoning` field from the harness reasoning effort.
 * Returns `undefined` (omitted) for the "off" / unset case so the backend
 * applies its own default.
 */
export function resolveReasoning(effort: string | undefined): { effort: string } | undefined {
  if (effort === undefined || effort === 'off') return undefined
  return { effort }
}

/**
 * Build the full Responses API request body. The backend rejects the standard
 * `max_output_tokens` / `temperature` / `stop` scalars, so they are
 * deliberately omitted.
 */
export function serializeRequest(options: GenerateOptions, images?: RequestImages): Record<string, unknown> {
  const tools = options.tools?.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const reasoning = resolveReasoning(options.reasoningEffort)
  return {
    model: options.model,
    ...(options.system !== undefined && options.system.length > 0
      ? { instructions: options.system }
      : {}),
    input: serializeInput(options.messages, images),
    ...(tools !== undefined && tools.length > 0
      ? { tools, tool_choice: 'auto', parallel_tool_calls: true }
      : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    stream: true,
    store: false,
  }
}
