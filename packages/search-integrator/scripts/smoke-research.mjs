/**
 * Real-endpoint smoke test for dsh-search-integrator (NOT part of vitest).
 *
 * Usage:
 *   node scripts/smoke-research.mjs --providers   # one query per enabled source
 *   node scripts/smoke-research.mjs --full        # whole pipeline incl. deepseek-flash integration
 *
 * Credentials come from the environment (ZHIPU_API_KEY / EXA_API_KEY /
 * TAVILY_API_KEY / BRAVE_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY); values
 * are never printed. The ChatGPT subscription source is enabled with
 * CHATGPT_OAUTH=1: the smoke reads the live oauth-providers grant record
 * directly (access token only, never printed, never refreshed — refresh stays
 * with the host). The deepseek leg talks to the public API directly; the
 * llm-service wrapper is covered by unit tests.
 */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'
import {
  buildAdapters, createNullAuditPort, fetchRawPost, getJson, postJson, runResearch,
} from '../lib/index.js'

const mode = process.argv[2] ?? '--providers'

/** Live grant from the dsh credential record (access token only; never printed). */
function chatgptToken() {
  if (!process.env.CHATGPT_OAUTH) return undefined
  try {
    const doc = yaml.load(readFileSync(`${process.env.HOME}/.dsh/.credentials.yaml`, 'utf8'))
    const payload = doc?.records?.['oauth-providers/chatgpt']?.payload
    if (typeof payload?.access !== 'string') return undefined
    if (typeof payload?.expires === 'number' && Date.now() > payload.expires) {
      console.log('[chatgpt] stored access token expired — run this through the host instead')
      return undefined
    }
    return {
      access: payload.access,
      ...(typeof payload.accountId === 'string' ? { accountId: payload.accountId } : {}),
    }
  } catch {
    return undefined
  }
}

const settings = {
  zhipuEnabled: Boolean(process.env.ZHIPU_API_KEY),
  zhipuApiKeyRef: 'ZHIPU_API_KEY',
  zhipuTransport: 'mcp',
  zhipuMcpUrl: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp',
  zhipuMcpTool: 'webSearchPrime',
  zhipuApiBase: 'https://open.bigmodel.cn/api/paas/v4',
  zhipuEngine: 'search_std',
  tavilyEnabled: Boolean(process.env.TAVILY_API_KEY),
  tavilyApiKeyRef: 'TAVILY_API_KEY',
  tavilyApiBase: 'https://api.tavily.com',
  tavilySearchDepth: 'basic',
  tavilyIncludeRaw: false,
  braveEnabled: Boolean(process.env.BRAVE_API_KEY),
  braveApiKeyRef: 'BRAVE_API_KEY',
  braveApiBase: 'https://api.search.brave.com/res/v1',
  openaiEnabled: Boolean(process.env.OPENAI_API_KEY),
  openaiApiKeyRef: 'OPENAI_API_KEY',
  openaiApiBase: 'https://api.openai.com/v1',
  openaiModel: 'gpt-5.5',
  openaiSearchContextSize: 'low',
  openaiReasoningEffort: 'low',
  chatgptEnabled: chatgptToken() !== undefined,
  chatgptModel: 'gpt-5.5',
  chatgptApiBase: 'https://chatgpt.com/backend-api/codex',
  exaEnabled: Boolean(process.env.EXA_API_KEY),
  exaApiKeyRef: 'EXA_API_KEY',
  exaApiBase: 'https://api.exa.ai',
  integratorProvider: 'deepseek-official',
  integratorModel: 'deepseek-flash',
  integratorMaxTokens: 8192,
  followupRounds: 1,
  maxEvidence: 14,
  fetchTopN: Number(process.env.SMOKE_FETCH_TOP ?? 2),
  perSourceResults: 5,
  excerptChars: 1200,
  totalBudgetMs: 120_000,
  perRequestTimeoutMs: 15_000,
  maxRenderChars: 7000,
  auditEnabled: false,
}

const keys = {
  ...(process.env.ZHIPU_API_KEY ? { zhipu: process.env.ZHIPU_API_KEY } : {}),
  ...(process.env.EXA_API_KEY ? { exa: process.env.EXA_API_KEY } : {}),
  ...(process.env.TAVILY_API_KEY ? { tavily: process.env.TAVILY_API_KEY } : {}),
  ...(process.env.BRAVE_API_KEY ? { brave: process.env.BRAVE_API_KEY } : {}),
  ...(process.env.OPENAI_API_KEY ? { openai: process.env.OPENAI_API_KEY } : {}),
}

const liveToken = chatgptToken()
const io = {
  postJson,
  getJson,
  rawPost: fetchRawPost(),
  ...(liveToken ? { chatgptToken: async () => liveToken } : {}),
}

function trunc(text, n = 90) {
  return typeof text === 'string' ? text.slice(0, n) : text
}

async function providers() {
  const { adapters, failures } = buildAdapters(settings, keys, io)
  if (failures.length > 0) console.log('config failures:', failures)
  for (const adapter of adapters) {
    const started = Date.now()
    try {
      const hits = await adapter.search('智谱 GLM 最新模型 发布', new AbortController().signal)
      console.log(`\n[${adapter.id}] ok in ${Date.now() - started}ms — ${hits.length} hits`)
      for (const hit of hits.slice(0, 3)) {
        console.log(`  - ${trunc(hit.title)} | ${trunc(hit.url, 70)} | date=${trunc(hit.publishedAt, 20)} | snippet=${trunc(hit.snippet, 60)}`)
      }
    } catch (error) {
      console.log(`\n[${adapter.id}] FAILED in ${Date.now() - started}ms: ${String(error).slice(0, 300)}`)
    }
  }
}

/** A minimal LlmPort straight to the DeepSeek public API (finish_reason mapped). */
function deepseekPort() {
  return {
    async call(req, signal) {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${process.env.DEEPSEEK_API_KEY ?? ''}`,
        },
        body: JSON.stringify({
          model: settings.integratorModel,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens,
          stream: false,
        }),
        signal,
      })
      const body = await response.json()
      if (!response.ok) {
        return { ok: false, text: '', finishKind: 'error', error: `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}` }
      }
      const choice = body.choices?.[0]
      const text = choice?.message?.content ?? ''
      const finishKind = choice?.finish_reason === 'length' ? 'max-tokens'
        : choice?.finish_reason === 'stop' ? 'stop'
          : 'error'
      return {
        ok: finishKind === 'stop',
        text,
        finishKind,
        ...(body.usage ? { usage: { inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens } } : {}),
        ...(finishKind !== 'stop' ? { error: `finish_reason=${choice?.finish_reason}` } : {}),
      }
    },
  }
}

async function full() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log('DEEPSEEK_API_KEY missing — cannot run the integration leg')
    process.exit(1)
  }
  const { adapters } = buildAdapters(settings, keys, io)
  const started = Date.now()
  const result = await runResearch(
    {
      adapters,
      configFailures: [],
      llm: deepseekPort(),
      audit: createNullAuditPort(),
      settings,
    },
    { question: '智谱 GLM 最新模型和 DeepSeek 最新模型分别是什么？各自的发布时间和主要特点？' },
    new AbortController().signal,
  ).catch((error) => {
    console.log('full pipeline aborted/failed:', String(error).slice(0, 300))
    process.exit(0)
  })
  console.log(`\n=== full pipeline in ${Date.now() - started}ms ===`)
  console.log('status:', result.status)
  if (result.degradedReason) console.log('degradedReason:', trunc(result.degradedReason, 200))
  console.log('summary:', trunc(result.summary, 400))
  console.log('points:')
  for (const point of result.points) {
    console.log(`  [${point.status}] ${trunc(point.text, 140)} <- [${point.sources.join(',')}]${point.citationFailed ? ' (citationFailed)' : ''}`)
  }
  console.log('unknowns:', result.unknowns.map((text) => trunc(text, 100)))
  console.log('coverage:', JSON.stringify(result.coverage, null, 0).slice(0, 400))
  console.log('sources (first 4):')
  for (const source of result.sources.slice(0, 4)) {
    console.log(`  [${source.id}] ${trunc(source.url, 70)} | ${trunc(source.title, 50)} | ${source.providers.join('+')}`)
  }
}

if (mode === '--providers') {
  await providers()
} else if (mode === '--full') {
  await full()
} else {
  console.log('usage: node scripts/smoke-research.mjs --providers|--full')
  process.exit(2)
}
