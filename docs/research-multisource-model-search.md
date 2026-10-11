# 调研：OpenAI / GLM（智谱·Z.ai）/ DeepSeek 作为多源搜索插件的官方 API 能力

> 结论先行（仅据一手官方文档，2026-10-11 抓取）：
>
> 1. **本节三家（OpenAI / 智谱 GLM / DeepSeek）中，只有智谱 GLM 提供「独立搜索 API」**——本文范围仅这三家，
>    **不是全局结论**（Exa、Tavily、Brave 等独立搜索 API 不在本次调研范围内）。
>    `POST /paas/v4/web_search` 直接返回结构化搜索结果 JSON，不经过模型生成，可当作纯搜索引擎用
>    （`search_result[]` 带 `link`/`content`/`publish_date`）。
> 2. **OpenAI 没有独立搜索端点**：联网是 **Responses API 的 `web_search` 内置工具**，必须经模型生成回答；
>    但同一响应里会显式给出 `web_search_call`（搜索动作）与 `url_citation` 引用、`sources` 全量 URL、
>    `results` 原始结果（**文本形态未核实**，§6），**可以只取这些字段、丢弃模型正文**，
>    还能用 `tool_choice` 强制先搜。
> 3. **DeepSeek 公共 API 完全不含搜索**：官方 2024-12-10 新闻原文即写「**目前，API 暂不支持搜索功能**」，
>    与网页版「联网搜索」明确分离；截至 2026-10-11 的 API Reference 侧栏与 sitemap 中**不存在任何搜索端点**，
>    Chat Completions 的 `tools` 只支持 `function`，Responses API 文档把 `web_search` 等内置工具标注为
>    **Ignored（静默忽略，属兼容层）**。DeepSeek 侧只能走自建 function calling。
> 4. **URL 与引用**：OpenAI 与 GLM **都可取得真实 URL 与可定位引用**；DeepSeek **没有**（响应 schema 无任何
>    citation / url / annotations 字段）。**「原文」不要按字面理解**：两家返回的都是摘要/片段或受预算约束的
>    页面内容（`search_context_size`、`return_token_budget`、`content_size`），**均不等于完整网页正文**；
>    OpenAI 文本结果的全文返回能力本文**未实测、官方亦无承诺**（§6 不确定项 4）。
> 5. **费用**：OpenAI 搜索调用 **$10/1k calls** 起（外加搜索内容 token 按模型价计费；非推理模型的
>    preview 档搜索内容 token 免费）；GLM 按次 **¥0.01 / 0.03 / 0.05**；DeepSeek 无搜索计费项（=只能用
>    自己的 function calling，成本自担）。
>
> 对「多源搜索插件」的直接含义：**本节三家里 GLM 独立 API 最适合做纯检索源**
> （可只取结果、便宜、可指定域名/时间/条数）；
> **OpenAI 只能作为「搜索+生成」一体的源，但可用 `include` 抽出结构化引用/结果**；
> **DeepSeek 必须插件侧自带搜索实现**（它只提供 tool calling 的编排能力）。

- 调研对象：**OpenAI** 官方开发者文档与定价页（`developers.openai.com`，经 `platform.openai.com` 跳转）；
  **智谱国内开放平台** `docs.bigmodel.cn`（**国际线 `https://docs.z.ai` 本次未核实，单列于 §4**，
  不做「国内站=国际站」的等同断言）；**DeepSeek** `api-docs.deepseek.com` + `www.deepseek.com`。
- 方法：逐页抓官方页面（OpenAI 走 `.md` 纯文本端点），只取官方表头/原文摘录。
  `docs.z.ai` 本机对 3 个 URL 全部不可达（`web_fetch` 与 `curl` 均为连接层失败 / `000`）；
  bigmodel OpenAPI spec 的 `info.contact`/`license` 指向 `chat.z.ai` 只能作为**线索**，
  不足以证明两者是同一 API 面（§4 不确定项）。
- **未核实即标注**；不采信第三方博客/聚合站作为结论。

---

## 1. 核心对比表

| 维度 | OpenAI | GLM（智谱国内平台，见 §4） | DeepSeek |
|---|---|---|---|
| 独立搜索 API（只搜不答） | **无**。联网 = Responses 的 `web_search` 工具，必须在 `/v1/responses` 调用中 | **有**。`POST https://open.bigmodel.cn/api/paas/v4/web_search`，直接返回结构化结果 | **无**。API 文档无搜索端点 |
| 模型调用内置联网工具 | **有**（Responses API：`{"type":"web_search"}`；旧版 `web_search_preview`） | **有**（Chat Completions：`tools:[{"type":"web_search","web_search":{...}}]`） | **无**。`tools` 仅 `function`；内置工具被忽略 |
| 是否必须生成回答 | 是（同一响应含回答，但可只解析 `web_search_call`/`annotations`/`sources`） | 独立 API **不生成**；Chat 内嵌模式生成 | 不适用（无搜索） |
| URL 可取得性 | ✅ `url_citation.url`、`web_search_call.action.sources[].url`、`web_search_call.results[]`（**含图片结果**：`image_url`/`thumbnail_url`/`source_website_url`/`caption`） | ✅ `search_result[].link`（独立 API 与 Chat 响应 `web_search[]` 均有） | ❌ 响应 schema 无 URL 字段 |
| 引用标注 | ✅ `message.content[0].annotations[]`（`url_citation`：`url`/`title`/`start_index`/`end_index`） | ✅ 回答内 `[来源：ref_N]`，并与 `web_search[].refer`（`ref_1`）对应 | ❌ |
| 正文/片段（**非完整原文**） | 摘要 + 受预算约束的页面内容（`search_context_size`、`return_token_budget`），**是否/如何返回文本全文未实测、官方无承诺** | `content`「搜索结果网页引用的文本内容」（引用片段），`content_size: medium/high` 控制长短 | ❌ |
| 可否只要结果不要回答 | ⚠️ 无专用模式，回答与搜索结果同响应返回；但可用 `include:["web_search_call.results"]` / `["web_search_call.action.sources"]` 抽结构化结果、忽略 `output_text`（条数/完整性官方无承诺） | ✅ 独立 Web Search API 天生如此 | — |
| 强制搜索 | ✅ `tool_choice:"required"` 或指定工具（`auto` 时搜索可选） | 独立 API `search_intent:false`（跳过意图识别直接搜）；Chat 内 `require_search:true`、`search_query` 强制触发 | — |
| 域名/时间过滤 | ✅ `filters.allowed_domains` / `blocked_domains`（各 ≤100，含子域） | ✅ `search_domain_filter`（白名单单域名）、`search_recency_filter`（oneDay/Week/Month/Year/noLimit） | — |
| 条数控制 | 无显式条数参数（`search_context_size` 仅为上下文量级指引） | ✅ `count` 1–50（默认 10）；`search_pro_sogou` 仅 10/20/30/40/50 | — |
| 计费 | **$10.00 / 1k calls**（所有模型）+ 搜索内容 token 按模型输入价计费；`web_search_preview`+非推理模型为 $25/1k 且搜索内容 token **免费**；`gpt-4o-mini`/`gpt-4.1-mini` 用非 preview 工具时每次固定按 8,000 input tokens 计费 | 按次：`search_std` ¥0.01、`search_pro` ¥0.03、`search_pro_sogou` ¥0.05、`search_pro_quark` ¥0.05；Chat 内嵌模式另计模型 token | 无搜索费用项；只有 token 费（模型自身定价） |
| 图片搜索 | ✅ `search_content_types:["image"]` + `image_settings{max_results,caption}`，`image_result` 含 `image_url`/`thumbnail_url`/`source_website_url`/`caption` | ❌ 文档仅文本结果 | ❌ |
| 其他 | `external_web_access:false` 可切缓存/离线模式；`user_location` 地理定位；`sources` 会标注第三方实时源 `oai-sports`/`oai-weather`/`oai-finance` | 结果自带 `icon`（站点图标）、`media`（站点名）、`publish_date`；官方 MCP：`https://open.bigmodel.cn/api/mcp-broker/proxy/web-search/mcp?Authorization=<Key>`；另有「网页阅读」API | — |

---

## 2. OpenAI（一手：`developers.openai.com`）

### 2.1 集成方式

- 新集成用 **Responses API + `web_search`**；旧 `web_search_preview` 仍可用但**不支持** `filters`、
  `external_web_access`、`return_token_budget`。
- Chat Completions **只支持专用搜索模型**（`gpt-5-search-api`），且「Chat Completions search models
  **always search before responding**; Responses search is a tool」。
- `gpt-4o-search-preview` / `gpt-4o-mini-search-preview` 已弃用，**shutdown 2026-07-23**
  （弃用页亦确认 `gpt-4o-search-preview-2025-03-11`、`gpt-4o-mini-search-preview-2025-03-11` 于
  2026-07-23 关停）。
- 工具类型字面量有两种：`web_search` 或带日期的 `web_search_2025_08_26`。
- 来源：
  [Web search 指南](https://developers.openai.com/api/docs/guides/tools-web-search) ·
  [Responses create 参考](https://developers.openai.com/api/reference/resources/responses/methods/create) ·
  [Deprecations](https://developers.openai.com/api/docs/deprecations)

### 2.2 输出结构与引用（URL 可取得性）

官方原文：

> Model responses that use the web search tool will include two parts: A `web_search_call` output item ...
> The action is one of: `search` ..., `open_page` ..., `find_in_page` ... A `message` output item containing:
> The text result in `message.content[0].text`; Annotations `message.content[0].annotations` for the cited URLs

> To view all URLs retrieved during a web search, use the `sources` field. Unlike inline citations ...
> `sources` returns the complete list of URLs the model consulted ... The number of sources is often greater
> than the number of citations. Real-time third-party feeds are also surfaced here and are labeled as
> `oai-sports`, `oai-weather`, or `oai-finance`.

| 字段 | 位置 / 取法 | 内容 |
|---|---|---|
| `web_search_call.action.type` | 输出 item | `search` / `open_page` / `find_in_page` |
| `web_search_call.action.queries` | 输出 item（"usually (but not always) includes"） | 实际检索词 |
| `web_search_call.action.sources[]` | 需 `include:["web_search_call.action.sources"]` | 本次搜索用到的源 |
| `web_search_call.results[]` | 需 `include:["web_search_call.results"]` | 原始结果；官方文档**明确给出 schema 的是图片结果** `image_result{image_url,thumbnail_url,source_website_url,caption}`，**文本结果的字段与是否含全文官方未给 schema** |
| `message.content[0].annotations[]` | 默认返回 | `url_citation{url,title,start_index,end_index}` |
| `message.content[0].text` | 默认返回 | 回答正文（可丢弃） |

- `include` 取值集合（参考页原文枚举）：`web_search_call.action.sources`、`web_search_call.results`、
  `file_search_call.results`、`message.input_image.image_url`、`computer_call_output.output.image_url`、
  `code_interpreter_call.outputs`、`reasoning.encrypted_content`、`message.output_text.logprobs`。
- 合规约束（官方硬性要求，插件 UI 需遵守）：
  > When displaying web results or information contained in web results to end users, inline citations must
  > be made clearly visible and clickable in your user interface.

### 2.3 参数与限制（`WebSearch` 工具 schema 摘要）

| 字段 | 取值 / 默认 | 说明 |
|---|---|---|
| `type` | `web_search` \| `web_search_2025_08_26` | |
| `search_context_size` | `low`/`medium`/`high`，默认 `medium` | 仅「上下文窗口占用的高层指引」，不保证条数或 token 数 |
| `filters.allowed_domains` | ≤100 条，省略 http(s)://，含子域 | 仅 Responses + `web_search` |
| `filters.blocked_domains` | ≤100 条 | 同上 |
| `external_web_access` | bool，默认 `true` | `false` = 仅缓存/离线，不抓取新外部内容 |
| `user_location` | `{type:"approximate",country,city,region,timezone}` | 省略即默认美国；`{"type":"approximate"}` 可避免该回退；深度研究模型不支持 |
| `return_token_budget` | `default` \| `unlimited` | 只对 GPT-5+ 推理模型的 hosted `web_search` 生效；不适用于非推理搜索、Chat Completions 搜索模型、`web_search_preview` |
| `search_content_types` / `image_settings` | `["image","text"]` / `{max_results,caption}` | 图片搜索 |

已明确的限制原文要点：

- 搜索上下文窗口 **固定 128k**，即使模型上下文更大（如 1M 级模型也被限 128k）。
- `tool_choice:"auto"` 时搜索是**可选**的：「Use `tool_choice: "required"` or a specific web search tool
  choice when search must run.」
- 对推理档位有额外要求（`minimal` / `none` 档位受限或质量下降，具体模型名见附录 A）。
- 速率限制「Same as tiered rate limits for underlying model used with the tool」。
- 可用面：Responses / Chat Completions / Assistants（Assistants 已 2026-08-26 关停）。

### 2.4 计费（[Pricing 页](https://developers.openai.com/api/docs/pricing) Tools 段）

| 项 | 价格 |
|---|---|
| Web search（all models） | **$10.00 / 1k calls + Search content tokens billed at model rates** |
| Image Web search（all models） | $10.00 / 1k calls + 搜索内容 token 按模型价 |
| `web_search_preview`（reasoning 模型，含 `gpt-5`、o 系列） | $10.00 / 1k calls + 搜索内容 token 按模型价 |
| `web_search_preview`（非推理模型） | $25.00 / 1k calls + **搜索内容 token 免费** |
| 细化条款 | 「For gpt-4o-mini and gpt-4.1-mini with the non-preview web search tool, search content tokens are billed as a fixed block of 8,000 input tokens per call.」 |
| 专用搜索模型价 | `gpt-5-search-api`：输入 $1.25 / 缓存输入 $0.125 / 输出 $10.00（每 1M tokens） |

> 注：`openai.com/api/pricing` 本机返回 403，故以 `developers.openai.com/api/docs/pricing` 为准（同源官方）。

---

## 3. GLM / 智谱国内平台（一手：`docs.bigmodel.cn`；国际 Z.ai 见 §4）

### 3.1 两条产品线

官方原文：

> 智谱为开发者提供全系列 AI 搜索工具，覆盖 **基础检索（Web Search API）**、**问答增强（Web Search in Chat）**
> 两大服务，基于统一 API 接口集成自研引擎及第三方服务（搜狗/夸克）……

| | Web Search API（独立） | Web Search in Chat（内嵌） |
|---|---|---|
| 端点 | `POST https://open.bigmodel.cn/api/paas/v4/web_search` | `POST https://open.bigmodel.cn/api/paas/v4/chat/completions` |
| 产出 | **仅结构化结果**，无模型生成 | 模型回答 + `web_search[]` 来源 + `[来源：ref_N]` 角标 |
| 认证 | `Authorization: Bearer <API Key>` | 同 |
| 来源 | [网络搜索 API](https://docs.bigmodel.cn/api-reference/工具-api/网络搜索) · [联网搜索指南](https://docs.bigmodel.cn/cn/guide/tools/web-search) | 同左 |

### 3.2 独立 Web Search API 参数（OpenAPI 原文）

| 参数 | 类型 / 取值 | 默认 | 说明（官方原文要点） |
|---|---|---|---|
| `search_query` | string，建议 ≤70 字符 | 必填 | 搜索内容 |
| `search_engine` | `search_std` \| `search_pro` \| `search_pro_sogou` \| `search_pro_quark` | 必填 | 四个引擎 |
| `search_intent` | bool | `false` | `true` 先做意图识别（无意图不搜）；`false` 跳过识别直接搜 |
| `count` | int 1–50 | `10` | 支持 `search_pro_sogou`/`search_std`/`search_pro`；`search_pro_sogou` 缺省枚举 10/20/30/40/50；**同时指定 `search_domain_filter` 与 `search_recency_filter` 时 `count` 不生效** |
| `search_domain_filter` | string（白名单域名，如 `www.example.com`） | — | 支持 `search_std`/`search_pro`/`search_pro_sogou` |
| `search_recency_filter` | `oneDay`\|`oneWeek`\|`oneMonth`\|`oneYear`\|`noLimit` | `noLimit` | 四个引擎均支持 |
| `content_size` | `medium`\|`high` | — | `medium` 摘要；`high` 最大化上下文、内容更详细；四引擎均支持 |
| `request_id` / `user_id` | string 6–64 / 6–128 | 自动生成 | 幂等标识 / 终端用户标识 |

响应字段（`WebSearchResponse`）：

| 字段 | 说明 |
|---|---|
| `search_intent[].{query,intent,keywords}` | `intent` 枚举 `SEARCH_ALL` / `SEARCH_NONE` / `SEARCH_ALWAYS`；`keywords` 为改写后关键词 |
| `search_result[].{title,content,link,media,icon,refer,publish_date}` | 标题 / 内容摘要 / **结果链接** / 网站名 / 图标 / 角标序号（如 `ref_1`）/ 发布时间 |
| `id` / `created` / `request_id` | 任务与请求标识 |

错误码（该端点声明）：`1701` 并发达上限；`1702` 无可用搜索引擎服务；`1703` 未返回有效数据。
另：`tool_choice` 在 Chat Completions 里「默认 `auto` **且仅支持 `auto`**」——**无法像 OpenAI 那样强制工具**；
GLM 侧强制搜索要靠 `search_intent:false`（独立 API）或 `require_search:true` / `search_query`（内嵌）。

### 3.3 Web Search in Chat（内嵌工具）

```jsonc
"tools": [{
  "type": "web_search",
  "web_search": {
    "enable": true, "search_engine": "search_pro", "search_query": "...",
    "search_intent": "true", "count": 5, "search_domain_filter": "www.sohu.com",
    "search_recency_filter": "noLimit", "content_size": "high",
    "result_sequence": "after", "search_result": true, "require_search": false,
    "search_prompt": "你是一位财经分析师。……{search_result}……"
  }
}]
```

内嵌专属字段（官方 schema 原文）：

| 字段 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `enable` | bool | `false` | 是否启用搜索 |
| `search_query` | string | — | **强制触发搜索** |
| `search_result` | bool | `false` | 是否返回搜索来源详细信息 |
| `result_sequence` | `before`\|`after` | `after` | 搜索结果是排在模型回复之前还是之后 |
| `require_search` | bool | `false` | 是否**强制必须搜到结果才返回回答** |
| `search_prompt` | string | 内置 | 定制搜索结果处理 Prompt，占位符 `{search_result}`、`{{current_date}}` |
| 响应侧 | `choices[].message.tool_calls[].type` 支持 `function`/`web_search`/`retrieval`；顶层 `web_search[]` 与独立 API 同形（含 `refer`） | — | 回答正文用 `[来源：ref_N]` 标注 |

### 3.4 计费与限制

- 计费（[API 定价](https://docs.bigmodel.cn/cn/guide/start/pricing) 搜索工具服务，按**实际调用次数**）：
  | 工具 | 价格（元/次） |
  |---|---|
  | Search-Std（自研基础） | 0.01 |
  | Search-Pro（自研专业，召回率更高） | 0.03 |
  | Search-Pro-Sogou | 0.05 |
  | Search-Pro-Quark | 0.05 |
- 速率限制（[速率限制](https://docs.bigmodel.cn/cn/api/rate-limit)）：平台按**并发数**限制，「不同模型设有独立的并发限制」，
  具体额度查询在控制台（`用户中心 → 速率限制`），**文档不给出公开数值**；错误码 `1302` 触发账户速率限制、`1305` 平台过载。
  提升并发需通过控制台表单申请，「平台将在 10 个工作日内完成审核」。
- 错误码 `1212`「当前模型不支持 `${method}` 调用方式」、`1215`「`${field1}` 与 `${field2}` 不能同时设置」为通用限制。
- 模型侧：`max_tokens` 上限 131072（具体模型清单与输出上限见附录 A）。
- 官方 MCP（便于直接挂进客户端）：
  `https://open.bigmodel.cn/api/mcp-broker/proxy/web-search/mcp?Authorization=<Zhipu API Key>`。

---

## 4. 国际 Z.ai 线：**本次未核实**

- `https://docs.z.ai` 本机**不可达**：`web_fetch` 对 `guides/tools/web-search`、`api-reference/tools/web-search`、
  `llms.txt` 三个 URL 均返回连接层失败；`curl` 复核同样为 `000`（无 HTTP 响应）。因此**本节不作任何能力断言**。
- 唯一可得的**线索**（不构成结论）：智谱国内文档的 OpenAPI spec 里
  `info.license.url = https://chat.z.ai/legal-agreement/terms-of-service`、
  `info.contact.url = https://chat.z.ai/legal-agreement/privacy-policy`、
  `info.contact.email = user_feedback@z.ai`，且文档标题写作「Z.AI 开发者」。
  这**只能说明同一厂商**，**不能推出国内站与国际站端点、参数、价格一致**。
- 需另核的问题：国际线是否有独立域名（如 `api.z.ai`）、`search_engine` 枚举与价格（人民币 vs 美元）、
  以及 Chat 内嵌 `web_search` 字段是否同形。

---

## 5. DeepSeek（一手：`api-docs.deepseek.com` + `deepseek.com`）

### 5.1 公共 API **不含**搜索（与网页版明确分离）

- 官方新闻（[DeepSeek V2 系列收官，联网搜索上线官网](https://api-docs.deepseek.com/zh-cn/news/news1210)，2024-12-10）原文：
  > DeepSeek-V2.5-1210 版本支持了**联网搜索**功能，并已上线**网页端**。登陆 chat.deepseek.com，
  > 在输入框中打开「联网搜索」即可体验。**目前，API 暂不支持搜索功能。**

  即：联网搜索是**消费端（网页/App）功能**，不是 API 能力。`www.deepseek.com` 首页标语亦为
  「深度思考 智能搜索」，但入口指向 `chat.deepseek.com`。
- 截至 2026-10-11，`api-docs.deepseek.com/sitemap.xml` 的全部端点页为：
  `/api/create-chat-completion`、`/api/create-response`、`/api/create-completion`、`/api/list-models`、
  `/api/get-user-balance`、`/api/create-file`、`/api/list-files`、`/api/retrieve-file`、`/api/delete-file`；
  指南页为 vision / thinking_mode / multi_round_chat / chat_prefix_completion / fim_completion /
  json_mode / tool_calls / files_api / kv_cache / responses_api / anthropic_api。**无任何 search / web_search 端点。**
- Chat Completions（[API Reference](https://api-docs.deepseek.com/api/create-chat-completion)）原文：
  > `tools` … **Currently, only functions are supported as a tool.**

  响应 schema 的 `message` 只有 `content` / `reasoning_content` / `tool_calls(function)` / `role`，
  **无 annotations / citations / url 字段**。
- Responses API（[create-response](https://api-docs.deepseek.com/api/create-response) /
  [指南](https://api-docs.deepseek.com/guides/responses_api)）原文：
  > `tools` … **Built-in tool types are ignored.**

  > `web_search` / `file_search` / `code_interpreter` / `computer_use` / `mcp` / other built-in tools |
  > **Ignored**

  > 不支持的参数会被**静默忽略**、不会报错，因此现有的 Responses API 客户端无需修改即可接入。

  输出 item 类型仅 `message` / `reasoning` / `function_call` / `custom_tool_call`；`custom` 工具只放行
  `apply_patch`。
- 一个易误读的点：指南注有
  > `input` 中回传的 `web_search_call` item（例如旧模型此前请求产生的搜索结果）仍会被还原并拼接进上下文。
  这是**兼容 OpenAI 客户端的入参透传/拼接**，不代表 DeepSeek 能发起搜索——发起搜索的 `web_search` 工具仍被忽略。
  对插件的可用姿势：**在插件侧（或别的厂商）拿到搜索结果后，以 `web_search_call`/普通消息形式塞回 DeepSeek 上下文**。

### 5.2 唯一可行路径：自建 function calling

- 官方 [Tool Calls](https://api-docs.deepseek.com/guides/tool_calls) 示例即天气查询：模型输出
  `get_weather({location})` 调用请求，**函数由用户实现**（「模型本身不执行具体函数」）。
- 相关能力与限制（同一文档 / API Reference）：
  - 思考模式自 DeepSeek-V3.2 起支持工具调用。
  - Chat Completion **不支持**在对话中间插入工具调用；Anthropic API 与 Responses API 支持。
  - `strict` 模式（Beta，需 `base_url="https://api.deepseek.com/beta"`）：所有 function 需 `strict:true`；
    仅支持 `object`/`string`/`number`/`integer`/`boolean`/`array`/`enum`/`anyOf`（+`$ref`/`$def`），
    不支持 `minLength`/`maxLength`/`minItems`/`maxItems`；每个 object 的所有属性必须 `required` 且
    `additionalProperties:false`。
  - `tool_choice`：`none`/`auto`/`required`/指定工具；**`required` 与指定工具在思考模式下返回 400**。
- 官方无面向开发者的独立「DeepSeek 搜索」产品；`awesome-deepseek-integration` 是社区集成列表，非 API 能力。

### 5.3 模型、价格、限制（[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing) / [Rate Limit](https://api-docs.deepseek.com/quick_start/rate_limit)）

> 本节只保留与「搜索插件」决策相关的量：**并发上限、上下文/输出上限、计费口径、参数面**。
> 精确模型版本号与逐档价格见附录 C。

| 项 | deepseek-flash | deepseek-v4-pro |
|---|---|---|
| 模型版本 | DeepSeek-V4.1-Flash | DeepSeek-V4-Pro-0813 |
| 上下文 | 1M | 1M |
| 最大输出 | 384K（`max_tokens` 取值 1–393216；未设时非思考默认 8K、思考 64K、`reasoning_effort:max` 时 128K） | 同 |
| 思考模式 | 支持非思考/思考，默认思考 | 同 |
| 并发限制 | 2500 | 500 |
| 输入（缓存命中） | 空闲 $0.003 / 高峰 $0.006（每 1M） | 空闲 $0.022 / 高峰 $0.044 |
| 输入（未命中） | 空闲 $0.15 / 高峰 $0.3 | 空闲 $0.66 / 高峰 $1.32 |
| 输出 | 空闲 $0.6 / 高峰 $1.2 | 空闲 $1.98 / 高峰 $3.96 |
| 图像理解 | 支持 | 不支持 |
| 人民币（中文页） | 0.02/0.04、1/2、4/8 元 | 0.15/0.30、4.5/9.0、13.5/27.0 元 |

- 空闲价为高峰价的一半；高峰 = 北京时间周一至周五 9:00–12:00、14:00–18:00（不含法定节假日），其余含周末全天为
  空闲。响应里另有 `system_fingerprint`、`prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`。
- 其它与搜索插件相关的参数：`response_format: json_object`（需自行在 prompt 里要求 JSON）、
  `stream_options.include_usage`、`frequency_penalty`/`presence_penalty` 已弃用不生效、`logprobs`/`top_logprobs`(≤20)、
  `user_id`（并发/KVCache/内容安全隔离）。**无搜索计费项、无搜索参数。**
- 并发超限返回 429；超出上下文返回 400（Responses `truncation` 不支持）；请求 10 分钟未开始推理会断开连接。

---

## 6. 不确定项 / 未核实（不要当结论用）

1. **国际 Z.ai 线未核实**：见 §4（`docs.z.ai` 三个 URL 本机全不可达，spec 里的 z.ai 元数据只是线索）。
2. **GLM 搜索端点的并发/条数硬上限**：官方只给错误码 `1701`「网络搜索并发已达上限」与 `count ≤ 50`，
   未公布公开的 QPS/并发数值；需登录控制台查看账户实际额度。`search_recency_filter` 与
   `search_domain_filter` 同时使用时 `count` 失效这一条只针对 `search_pro_sogou` 描述，**其它引擎是否同样失效未明说**。
3. **`search_intent` 类型在两条产品线不一致**：独立 API 为 `boolean`（必填），Chat 内嵌 schema 写作 `string`
   （`"true"`/`"false"`）。官方字段类型表述冲突，取用时按各端点 schema 处理，**勿假定统一**。
4. **OpenAI 是否存在「纯搜索」端点**：官方文档未描述任何绕过模型的搜索 API；`/v1/search` 早在 2022-12-03
   关停（deprecations 页）。但 `include:["web_search_call.results"]` 能拿到结构化结果，**官方未承诺该结果的
   完整性/条数**（无条数参数），也未承诺「不产生模型输出 token」。是否可用于「只取结果」的生产用法，官方无背书。
5. **OpenAI 工具调用的计费精度**：官方口径为「$10/1k calls + 搜索内容 token 按模型价」，但
   `web_search_call.action.open_page` / `find_in_page` 是否各计一次 call，文档只说 `search` actions
   「incur a tool call cost」，**其余动作的计费归属未明说**。
6. **DeepSeek FAQ 页未取值**：`static.deepseek.com/faq/index.html` 为纯 JS 应用，抓取仅得标题，
   **无法引用其 FAQ 关于 API 联网的表述**；结论 5.1 完全基于 API Reference、指南、sitemap 与官方新闻，已足够。
   另需注意 5.1 引用的「API 暂不支持搜索功能」是 2024-12-10 的表述，虽然 2026-10-11 的全部 API 文档仍无搜索端点，
   但**官方未就此事发布更新的明确声明**（属「证据为最新文档结构 + 未发现反向声明」）。
7. **`gpt-5-search-api` 的 Chat Completions 具体行为**：本文只核到「always search before responding」与
   200k 上下文、不支持 filters/sources/`external_web_access`/`return_token_budget`；其返回是否含
   `annotations` 于 Chat Completions 形态，官方 Web search 指南未展示响应样例，**未核实**。
8. **OpenAI `results[]` 的文本形态未核实**：官方只在文档中给出 `image_result{image_url,thumbnail_url,
   source_website_url,caption}` 的 schema，**文本结果项的字段清单与是否含全文均无官方定义**；
   「只取结果不要回答」的可用性因此只能算半验证（枚举存在、内容形态未知）。
9. 时间上下文：以上均为 2026-10-11 抓取的当页内容，官方定价与模型清单变动频繁（DeepSeek 价格 2026-08-16 才调整过），
   落地前应重抓对应页面。

---

## 7. 官方 URL 清单

**OpenAI**
- Web search 指南：https://developers.openai.com/api/docs/guides/tools-web-search （`.md` 版可直取纯文本）
- Tools 总览：https://developers.openai.com/api/docs/guides/tools
- Responses create 参考：https://developers.openai.com/api/reference/resources/responses/methods/create
- 定价（含 built-in tools 段）：https://developers.openai.com/api/docs/pricing
- 弃用清单：https://developers.openai.com/api/docs/deprecations

**GLM / 智谱**
- 联网搜索指南：https://docs.bigmodel.cn/cn/guide/tools/web-search
- Web Search API 参考：https://docs.bigmodel.cn/api-reference/工具-api/网络搜索
- 对话补全（web_search 工具 schema）：https://docs.bigmodel.cn/api-reference/模型-api/对话补全
- API 定价（搜索工具服务段）：https://docs.bigmodel.cn/cn/guide/start/pricing
- 速率限制：https://docs.bigmodel.cn/cn/api/rate-limit ／ 错误码：https://docs.bigmodel.cn/cn/faq/api-code
- 文档索引 / OpenAPI：https://docs.bigmodel.cn/llms.txt ／ https://docs.bigmodel.cn/openapi/openapi.json
- （国际 Z.ai 线，**本机不可达/未核实**）https://docs.z.ai/api-reference/tools/web-search

**DeepSeek**
- 首次调用 / 模型与价格：https://api-docs.deepseek.com/ ／ https://api-docs.deepseek.com/quick_start/pricing
- Chat Completions：https://api-docs.deepseek.com/api/create-chat-completion
- Responses API：https://api-docs.deepseek.com/api/create-response ／ 指南：https://api-docs.deepseek.com/guides/responses_api
- Tool Calls：https://api-docs.deepseek.com/guides/tool_calls
- 限速与隔离：https://api-docs.deepseek.com/quick_start/rate_limit
- 「联网搜索上线官网，API 暂不支持搜索」：https://api-docs.deepseek.com/zh-cn/news/news1210
- 站点地图（端点全集）：https://api-docs.deepseek.com/sitemap.xml

---

## 附录 A：具体模型版本 / 档位细节（不影响核心结论）

**OpenAI**（2026-10-11 定价页与 Web search 指南所列）

- Responses 路径推荐 `web_search` 工具；文档示例模型为旗舰档（示例代码用最新模型名）。
- Chat Completions 搜索模型：`gpt-5-search-api`（200k 上下文）；
  `gpt-4o-search-preview`(128k) / `gpt-4o-mini-search-preview`(128k) 已弃用，**2026-07-23 关停**。
- 搜索上下文窗口 128k：`gpt-4.1` / `gpt-4.1-mini`（模型上下文 1M）、`o4-mini`（200k，2026-10-23 关停）均受限。
- 推理档位限制：不支持 `gpt-5` + `minimal` reasoning；`gpt-5.4` + `effort:none` 可能质量偏低。
- 旧工具 `web_search_preview` 不支持 `filters`、`return_token_budget`，且忽略 `external_web_access`。
- 专用搜索模型价：`gpt-5-search-api` 输入 $1.25 / 缓存输入 $0.125 / 输出 $10.00（每 1M tokens）。

**智谱国内平台**

- 文本模型枚举（Chat Completions `model`）：`glm-5.3`、`glm-5.2`、`glm-5.1`、`glm-5-turbo`、`glm-5`、
  `glm-4.7`、`glm-4.7-flash`、`glm-4.7-flashx`、`glm-4.6`、`glm-4.5-air`、`glm-4.5-airx`、
  `glm-4.5-flash`、`glm-4-flash-250414`、`glm-4-flashx-250414`。
- 输出上限：`GLM-5.3`/`5.2`/`5.1`/`5`/`4.7`/`4.6` 系列最大 128K 输出；`max_tokens` schema 上限 131072。
- 视觉模型枚举：`glm-5.3-flashx`、`glm-5.3-flash`、`glm-5v-turbo`、`glm-4.6v`、`autoglm-phone`、
  `glm-4.6v-flash`、`glm-4.6v-flashx`、`glm-4v-flash`、`glm-4.1v-thinking-flashx`、`glm-4.1v-thinking-flash`
  （视觉请求的 `tools` 仅 `FunctionToolSchema`，**不含 web_search**）。

## 附录 B：GLM 与搜索无关的其余参数约束

- `tool_choice`：Chat Completions 中文档明确「默认 `auto` **且仅支持 `auto`**」。
- `stop` 最多 4 条；`response_format.type` 仅 `text` / `json_object`。
- 错误码通用项：`1212`「当前模型不支持 `${method}` 调用方式」、`1215`「`${field1}` 与 `${field2}` 不能同时设置」；
  搜索端点专属：`1701` 并发上限、`1702` 无可用搜索引擎、`1703` 无有效数据。
- 知识库/检索为**另一条产品线**（非 Web Search）：全模态知识库检索、知识库检索等独立端点，按向量化/重排/
  深度解析（0.12 元/页）/存储（0.04 元/GB/小时，1 GB 内免费）计费——与「联网搜索」不是同一能力，勿混用。

## 附录 C：DeepSeek 逐档价格明细（官方表原文转录）

| 项 | deepseek-flash | deepseek-v4-pro |
|---|---|---|
| 模型版本 | DeepSeek-V4.1-Flash | DeepSeek-V4-Pro-0813 |
| 输入（缓存命中） | 空闲 $0.003 / 高峰 $0.006（每 1M） | 空闲 $0.022 / 高峰 $0.044 |
| 输入（未命中） | 空闲 $0.15 / 高峰 $0.3 | 空闲 $0.66 / 高峰 $1.32 |
| 输出 | 空闲 $0.6 / 高峰 $1.2 | 空闲 $1.98 / 高峰 $3.96 |
| 人民币（中文页） | 命中 0.02/0.04 元；未命中 1/2 元；输出 4/8 元 | 命中 0.15/0.30 元；未命中 4.5/9.0 元；输出 13.5/27.0 元 |

- 旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，但对应模型已下线，
  请求由 V4.1-Flash 服务并按 Flash 价计费。
- `max_tokens` 取值 1–393216；未设置时非思考模式默认 8K、思考模式 64K、`reasoning_effort:"max"` 时 128K。
- 并发：flash 2500 / pro 500（账户级，与 API Key 无关；超限 HTTP 429）。
