/**
 * Minimal MCP streamable-HTTP client for one tool call per session.
 *
 * Scope: exactly what the Zhipu web-search broker needs — initialize,
 * initialized notification, (cached) tools/list discovery, tools/call. No
 * resources, prompts, sampling, or transports beyond HTTP POST.
 *
 * Protocol hardening from the live broker probe (2026-10-11):
 * - auth failures arrive as a PLAIN JSON body (`{code, msg, success}`), not
 *   a JSON-RPC error, so transport errors are detected before RPC parsing;
 * - responses may be `application/json` OR `text/event-stream` (SSE `data:`
 *   lines); both are accepted;
 * - `mcp-session-id` from the initialize response rides every later request.
 *
 * @module dsh-search-integrator/mcp
 */

/** One raw HTTP POST exchange, injectable for tests. */
export type RawPost = (
  url: string,
  body: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<{
  readonly status: number
  readonly contentType: string
  readonly text: string
  readonly headers: Record<string, string>
}>

/** The settled answer of one MCP tool call. */
export interface McpToolResult {
  readonly text: string
  readonly structured: unknown
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
}

/** Broker-level failure (auth, quota, gateway) surfaced with its own type. */
export class McpTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpTransportError'
  }
}

/** Tool-name cache per endpoint: tools/list once per process per URL. */
const knownTools = new Map<string, string>()

/** Extract the first JSON-RPC message from a JSON or SSE-encoded body. */
export function parseRpcBody(contentType: string, text: string): JsonRpcResponse {
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '') continue
      try {
        return JSON.parse(payload) as JsonRpcResponse
      } catch {
        // Skip malformed SSE frames; a later data line may carry the answer.
      }
    }
    throw new McpTransportError('SSE body carried no parsable JSON-RPC message')
  }
  try {
    return JSON.parse(text) as JsonRpcResponse
  } catch {
    throw new McpTransportError(`non-JSON MCP response: ${text.slice(0, 200)}`)
  }
}

/** True when a plain (non-RPC) body reports a broker-level failure. */
function isPlainError(parsed: unknown): parsed is { code?: number; msg?: string; message?: string } {
  if (typeof parsed !== 'object' || parsed === null) return false
  const record = parsed as Record<string, unknown>
  return record.jsonrpc === undefined && (record.code !== undefined || record.msg !== undefined)
}

interface Exchange {
  parsed: JsonRpcResponse
  headers: Record<string, string>
}

/**
 * Run one MCP tool call over a fresh session.
 *
 * @param post - injectable raw POST.
 * @param url - the broker's streamable-http endpoint.
 * @param apiKey - credential value (sent as `Authorization: Bearer`).
 * @param tool - preferred tool name; discovered via tools/list when unknown.
 * @param args - the tool arguments object.
 * @param signal - cancellation shared with the research budget.
 */
export async function mcpCallTool(
  post: RawPost,
  url: string,
  apiKey: string,
  tool: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<McpToolResult> {
  const baseHeaders: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  let nextId = 1

  const send = async (payload: unknown, session?: string): Promise<Exchange> => {
    const headers = { ...baseHeaders, ...(session === undefined ? {} : { 'mcp-session-id': session }) }
    const response = await post(url, JSON.stringify(payload), headers, signal)
    if (response.text.trim() === '') {
      // Notifications legally settle as 202 with an empty body.
      return { parsed: {}, headers: response.headers }
    }
    const parsed = parseRpcBody(response.contentType, response.text)
    if (isPlainError(parsed)) {
      throw new McpTransportError(
        `MCP broker error ${parsed.code ?? ''}: ${parsed.msg ?? parsed.message ?? 'unknown'}`,
      )
    }
    return { parsed, headers: response.headers }
  }

  const requireResult = (exchange: Exchange, stage: string): unknown => {
    const error = exchange.parsed.error
    if (error !== undefined) {
      throw new McpRpcFailure(stage, error.message ?? `code ${error.code ?? '?'}`)
    }
    return exchange.parsed.result
  }

  // 1. initialize — a fresh session per call; brokers may expire sessions.
  const init = await send({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh-search-integrator', version: '1' } },
  })
  requireResult(init, 'initialize')
  const sessionId = init.headers['mcp-session-id'] ?? init.headers['Mcp-Session-Id']

  // 2. initialized notification — no id, empty response expected.
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId)

  // 3. Resolve the tool name (cached per endpoint).
  let toolName = knownTools.get(url) ?? tool
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // 4. tools/call.
    const call = await send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }, sessionId)
    const error = call.parsed.error
    const unknownTool = error !== undefined
      && (error.code === -32602 || error.code === -32601
        || /unknown.*tool|tool.*not/i.test(error.message ?? ''))
    if (unknownTool && attempt === 1) {
      // Unknown tool: discover the real name once, then retry.
      const listed = await send({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, sessionId)
      const result = requireResult(listed, 'tools/list') as { tools?: { name?: unknown }[] }
      const names = (result?.tools ?? []).map((entry) => entry?.name)
        .filter((name): name is string => typeof name === 'string')
      const found = names.find((name) => name === tool)
        ?? names.find((name) => name.toLowerCase().includes('search'))
      if (found === undefined) {
        throw new McpRpcFailure('tools/list', `no search tool (has: ${names.join(', ') || 'none'})`)
      }
      knownTools.set(url, found)
      toolName = found
      continue
    }
    requireResult(call, 'tools/call')
    const result = call.parsed.result as {
      content?: { type?: unknown; text?: unknown }[]
      structuredContent?: unknown
      isError?: boolean
    }
    if (result?.isError === true) {
      const text = (result.content ?? []).map((block) => (typeof block.text === 'string' ? block.text : '')).join('\n')
      throw new McpRpcFailure('tools/call', text.slice(0, 300) || 'tool reported an error')
    }
    const text = (result?.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
    return { text, structured: result?.structuredContent }
  }
  throw new McpTransportError('tool call retry loop exhausted')
}

/** A JSON-RPC level failure (stage + message) distinct from transport errors. */
export class McpRpcFailure extends Error {
  readonly stage: string
  constructor(stage: string, message: string) {
    super(`${stage}: ${message}`)
    this.name = 'McpRpcFailure'
    this.stage = stage
  }
}

/**
 * The raw-post adapter over the global fetch (used by the real wiring; tests
 * inject their own RawPost).
 */
export function fetchRawPost(): RawPost {
  return async (url, body, headers, signal) => {
    const response = await fetch(url, { method: 'POST', headers, body, signal })
    const flatHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      flatHeaders[key.toLowerCase()] = value
    })
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      text: await response.text(),
      headers: flatHeaders,
    }
  }
}
