/**
 * Harness message → OpenAI Responses API `input` serialization.
 *
 * The ChatGPT subscription backend only accepts the Responses wire shape:
 * user/assistant messages plus top-level `function_call` / `function_call_output`
 * items. Assistant reasoning is dropped (the backend does not surface raw
 * reasoning without an opt-in summary), and image blocks are rejected because
 * this plugin's wire path is text-only.
 *
 * Derived from werifu/dsh-oai-oauth (MIT) — see THIRD-PARTY-NOTICE.md.
 *
 * @module dsh-openai-oauth/serialize
 */
import { LlmError, contentHasImage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

/** Join the text blocks of a message's content into one string. */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** Reject image content before text-flattening can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      'The OpenAI OAuth (ChatGPT subscription) adapter does not support image content.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

/** A Responses API input item (loose structural type). */
type InputItem = Record<string, unknown>

/**
 * Serialize the conversation into Responses API input items.
 * System messages are skipped — the harness delivers the system prompt
 * separately as `GenerateOptions.system` → `instructions`.
 */
export function serializeInput(messages: readonly Message[]): InputItem[] {
  const input: InputItem[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') continue

    if (message.role === 'assistant') {
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

    // User-role messages: visible text first, then tool results as
    // top-level function_call_output items.
    const text = flattenText(message.content)
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    if (text.length > 0 || toolResults.length === 0) {
      input.push({ role: 'user', content: [{ type: 'input_text', text }] })
    }
    for (const result of toolResults) {
      if (result.type !== 'tool-result') continue
      input.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: flattenText(result.content) || '(no output)',
      })
    }
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
export function serializeRequest(options: GenerateOptions): Record<string, unknown> {
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
    input: serializeInput(options.messages),
    ...(tools !== undefined && tools.length > 0
      ? { tools, tool_choice: 'auto', parallel_tool_calls: true }
      : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    stream: true,
    store: false,
  }
}
