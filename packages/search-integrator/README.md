# dsh-search-integrator

A host-only DSH bundle that registers one research tool (`web_research` by
default). The tool takes a **whole question**, fans it out to the configured
search providers, deterministically deduplicates and ranks the evidence, and
has a configured integrator model return **one citation-checked synthesis**
with explicit unknowns and coverage notes. The main model never filters raw
hit lists; the full audit trail lives in a spill artifact the result points
to.

## Pipeline

```
question (+optional queries)
  → query planning (integrator model, falls back to the raw question)
  → multi-source retrieval (shared deadline, per-source retry, per-request timeout)
  → deterministic dedup + ranking (URL key; verbatim syndication only; dissent protection)
  → page-body fetch for thin top sources (fetchTopN)
  → integrator synthesis (prompt v3: retrieval-context header, summary answers
    directly, cited-content-supported statuses, attributed conflict sides,
    follow-up only with a concrete target — preferring primary sources)
  → optional follow-up round (fast SERP sources only; generative sources
    are excluded so the remaining budget can fund it)
  → citation validation → compact render + audit artifact
```

Failure semantics:

- one source failing → the rest continue, gap recorded in `coverage.failed`;
- no usable source / no results → explicit `failed` result;
- integrator unavailable or failing → `degraded`: a clearly labeled
  *unintegrated* digest, never an unmarked raw dump;
- fabricated citation ids are stripped; points left without valid citations
  carry a `citationFailed` marker into the render.

## Configure

Edit the plugin row (Web Settings → namespace `search-integrator`, or the row
config in a patch layer). Secrets live in `ctx.credentials` **references**
(environment-variable names), never in the config itself:

| Field | Default | Notes |
|---|---|---|
| `enabled` / `toolName` / `timeoutMs` | `true` / `web_research` / `120000` | registration-time (edit remounts the row) |
| `zhipuEnabled` + `zhipuApiKeyRef` | `true` + `ZHIPU_API_KEY` | **default transport `mcp`**: official MCP broker, covered by GLM Coding-Plan MCP quota (the key is the Coding-Plan key) |
| `zhipuTransport` / `zhipuMcpUrl` | `mcp` / broker URL | `rest` switches to the open-platform per-call `POST /api/paas/v4/web_search` (needs an open-platform key) |
| `tavilyEnabled` + `tavilyApiKeyRef` | `true` + `TAVILY_API_KEY` | `search_depth` configurable; raw content optional |
| `exaEnabled` + `exaApiKeyRef` | `true` + `EXA_API_KEY` | text contents capped |
| `braveEnabled` + `braveApiKeyRef` | `false` + `BRAVE_API_KEY` | Brave Search API (independent index, ~$5/1k; GET, extra snippets as content) |
| `openaiEnabled` + `openaiApiKeyRef` | `false` + `OPENAI_API_KEY` | platform Responses `web_search` tool ($10/1k calls + model tokens — priciest); only consulted/cited URLs are kept, generated prose is discarded |
| `chatgptEnabled` + `chatgptModel` | `false` / `gpt-5.5` | **ChatGPT 订阅源**：Codex 后端 `web_search`，认证走 oauth-providers 的 `ctx.oauthProviders.token('chatgpt')`（自动刷新，无需 API key）；消耗订阅额度，故默认关；同样只取 URL |
| `integratorProvider` / `integratorModel` | `deepseek-official` / `deepseek-flash` | llm route for planning + synthesis; needs `DEEPSEEK_API_KEY`; empty ⇒ degraded mode |
| `followupRounds` | `1` | max follow-up search rounds |
| `maxEvidence` / `perSourceResults` / `excerptChars` | `14` / `8` / `1600` | evidence budgets; the cap re-admits one dropped dissenting-domain source |
| `fetchTopN` | `2` | top sources with thin content get one best-effort page-body fetch (HTML→text) for the digest; 0 disables |
| `totalBudgetMs` / `perRequestTimeoutMs` | `125000` / `12000` | shared run budget; per-request deadline for every source call and page fetch |
| `maxRenderChars` | `7000` | wall-clock budget; render stays under the ~8k pruner |
| `auditEnabled` | `true` | spill artifact with queries, hits, digest, model I/O |

DeepSeek is NOT available as a search source: its public API has no search
endpoint (the Responses-compat `web_search` parameter is documented as
silently ignored) — see `docs/research-multisource-model-search.md`. Every
enabled source sees only the search queries — never the conversation, code,
or secrets. A hung source is cut off by `perRequestTimeoutMs` and recorded in
`coverage.failed` without sinking the run.

## Develop

```sh
pnpm --filter dsh-search-integrator test     # vitest, fake providers + fake llm
pnpm build                                    # tsdown → lib/index.js
dsh --profile web --patch $PWD/packages/search-integrator/dev.patch.yml --no-open --port <port>
```

Install as a bundle:

```sh
pnpm build
dsh plugin --profile <profile> add ./packages/search-integrator
```

## Boundaries

- No browser half-plugin, no webServer, no custom session events.
- `presentationMeta` is only projected on model-direct calls; under PTC the
  audit pointer still rides the rendered `content`, but PTC pointer recovery
  is **not yet validated end-to-end** (see the repo-level research docs).
- Tool registration uses the stock `tools` service; it does not touch the
  host `web` provider routing.
