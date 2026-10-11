# 调研：DSH 多源 web_search 插件（Exa / Tavily / Bing / Google）——仅调研，不实现

> 结论先行（2026-10-11）：
>
> 1. 本节四家候选里，**能买到、第三方能直连、能拿原始 URL + 正文**的只有 **Exa 与 Tavily**。
> 2. **Bing 的旧 Search APIs 已退役**：Bing Search APIs **2025-08-11 退役**（[官方 Lifecycle 通告](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement)，`Last updated 2025-05-16`，2026-10-11 实抓仍在线）。
>    **现行的 `Grounding with Bing` 仍然存在并对外销售**（Azure/Foundry 加购），但它不满足"可拿原始结果"这项，且条款另有复用限制（§4）。
> 3. **Google Custom Search JSON API 已对新客户关闭，2027-01-01 停服**（[官方 Overview](https://developers.google.com/custom-search/v1/overview) 原文 "closed to new customers"、"[pricing applies] until the service discontinuation on January 1, 2027"，页面 `Last updated 2026-02-18`）；
>    Site Restricted 变体更早：**2025-01-08 停止服务**（[官方页](https://developers.google.com/custom-search/v1/site_restricted_api)，`Last updated 2026-09-03`）。
>    替代形态（Gemini `google_search`、Vertex grounding）都是**模型内置工具，只返回模型答案里的引用，不返回原始结果集**（§5）。
> 4. 传闻的 **"2030" 在 Google 官方渠道未见任何对应文句**（反向核实，§5.1）。
> 5. 对"小模型评估证据 + 去重"：本节四家候选里，**只有 Exa / Tavily 提供可用的正文片段**；Google 另受 ToS"不得与非 Google 结果混排"限制（§6）。

- 对象（**本节四家候选，不构成对全部搜索供应商的评审**）：Exa、Tavily、Microsoft Bing（Bing Search APIs → Grounding with Bing）、Google（Custom Search JSON API → Gemini/Vertex grounding）。
  Brave Search API、SerpApi / Serper 等第三方经销类服务不在本次范围内，不参与本节的可得性/价格/许可比较。
- 方法：只采信一手官方来源（厂商文档/定价页、Microsoft Learn Lifecycle、Google Developers 与官方 blog、官方 SDK 仓库）；逐条 URL 均在本会话内实抓，并记录页面自带日期。
  `exa.ai`、`docs.tavily.com`、`tavily.com` 本机直连超时（§7），故用**厂商自己的官方 MCP / 官方仓库**取原文，未引二手转述。
- 时间上下文 **2026-10-11（Asia/Shanghai）**；分级：已核实 / 未确认 / 官方页已失效。

## 1. 横向对比（只列可直接调用的事实）

| 维度 | Exa | Tavily | Bing（现行） | Google（现行） |
|---|---|---|---|---|
| 可购买形态 | REST `api.exa.ai`，PAYG 充值 | REST `api.tavily.com`，免费 + 订阅 + PAYG | 仅 Azure `Grounding with Bing` 加购 | 仅 Gemini `google_search` / Vertex AI Search |
| 第三方直连 | ✅ `x-api-key` 或 `Bearer` | ✅ API key | ❌ "Outputs are not directly accessible…" | ⚠️ 只能经 Gemini/Vertex，拿不回原始结果集 |
| 原始 URL | ✅ `results[].url` | ✅ `results[].url` | 仅模型回复里的 citation | 仅模型答案里的引用（`url_citation` 注解） |
| 正文 | ✅ `text`/`highlights`/`summary`（`/contents` 支持 JS 页、PDF） | ✅ `content`、`include_raw_content`、`/extract` `raw_content` | ❌ 官方：不向开发者返回工具输出 | ❌ |
| 本供应商结果标识 | `results[].id`（≈URL）+ `requestId`（**仅本供应商标识，非跨源键**） | `results[].id` + `request_id`（同上） | ❌ | ❌ |
| 检索层过滤原语 | `includeDomains`/`excludeDomains`/`category`/`startPublishedDate`/`objective` | `include_domains`/`exclude_domains`/`topic`/`time_range`/`exact_match` | — | — |
| 价格 | instant $4/1k；fast,auto $7/1k；deep $12/1k；deep-reasoning $15/1k；`/contents` $1/1k 页·内容类型；`/answer` $5/1k；免费 $10/月 | Free 1,000 credits/月；PAYG $0.008/credit；包月 $0.0075→$0.005；basic 1 credit、advanced 2 credits | $14 / 1,000 transactions | 5,000 搜/月免费，之后 $14 / 1,000 请求 |
| 限速 | `/search` 10 QPS、`/contents` 100 QPS、`/answer` 10 QPS | Dev 100 RPM / Prod 1,000 RPM；crawl 100；research 20；usage 10/10min | 150 TPS、100 万 transactions/天 | Gemini 侧按模型；grounding 100 万查询/天 |
| 官方 SDK / MCP | `exa-py`、`exa-js`；`https://mcp.exa.ai/mcp` | `tavily-python`、`tavily-mcp`（支持 keyless search/extract） | Azure SDK（Foundry） | Google GenAI SDK |
| 状态变更 | 未见退役通告 | 未见退役通告 | 旧 Search APIs **2025-08-11 退役**；现行 Grounding 仍在售 | **新客户关闭；2027-01-01 停服** |

## 2. Exa（已核实）

**端点**（[Search](https://exa.ai/docs/reference/search)、[Contents](https://exa.ai/docs/reference/contents)、[Answer](https://exa.ai/docs/reference/answer)、[Pricing](https://exa.ai/docs/admin/pricing)）
`/search`：`query`、`type`(`instant`/`fast`/`auto`/`deep-lite`/`deep`/`deep-reasoning`，默认 `auto`)、`numResults`(默认 10、公开上限 **100**)、`includeDomains`/`excludeDomains`(各上限 1200)、`startPublishedDate`/`endPublishedDate`、`category`(`company`/`publication`/`news`/`personal site`/`financial report`/`people`)、`contents`(text/highlights/summary/extras/livecrawl)、`outputSchema`(≤10 属性、≤2 层)、`additionalQueries`(仅 deep 系列，1–10)、`objective`(≤4096 字符)、`stream`。
`/contents`：`ids`、`text.maxCharacters`、`highlights{query}`、`summary{query,schema}`。
`/answer`：`query`、`model`(`exa`/`exa-pro`/`exa-research`/`exa-fast`)、`stream`、`outputSchema`。另有 `/monitors`（beta header `agent-monitors-2026-08-04`）与 Agent API（`effort`/`budget.maxCostDollars`）。

**返回**：每条含 `title`/`url`/`publishedDate`/`author`/`id`/`image`/`favicon`/`text`/`highlights[]`/`highlightScores[]`/`summary`/`subpages[]`/`extras`；响应含 `requestId`、`costDollars`（成本拆解）、`searchTime`。
`/answer` 返回 `answer` + `citations[]`；带 `outputSchema` 时给 `output.grounding[].citations[].{url,title,confidence}`。
已弃用勿用：`context`、`includeText`、`excludeText`、`startCrawlDate`/`endCrawlDate`、`resolvedSearchType`。
注：`results[].id` 是**Exa 自己的结果标识**，不能当作跨源去重键（§6.1）。

**价格**（[官方 Pricing，`Last modified 2026-09-25`](https://exa.ai/docs/admin/pricing)）

| 端点 | 基础价（含 10 条结果） | 第 10 条以上 | AI 摘要 |
|---|---|---|---|
| `/search` `instant` | $4 / 1k 请求 | $1 / 1k 结果 | $1 / 1k 页 |
| `/search` `fast`、`auto` | $7 / 1k 请求 | $1 / 1k 结果 | $1 / 1k 页 |
| `/search` `deep-lite`、`deep` | $12 / 1k 请求 | — | — |
| `/search` `deep-reasoning` | $15 / 1k 请求 | — | — |
| `/answer` | $5 / 1k 请求 | — | — |
| `/contents` | $1 / 1k 页，**按内容类型分别计费**（一页 `text`+`highlights` = 2 份） | — | $1 / 1k 页 |
| `/monitors` | $15 / 1k 请求 | $1 / 1k 结果 | $1 / 1k 页 |
| Agent | 固定 effort：$0.012/$0.025/$0.10/$0.50/$1.00（minimal→xhigh）；`auto`/`ultra` 计量：ACU $0.10、search 调用 $0.005 | — | — |

免费额度：注册当日 **$10 credits（≈2,500 次 instant）**，**每月 1 日重置为 $10**；无月费、无最低消费。计费口径：`numResults: 20` = 基础价 + 10 条超额。
限速（[Rate Limits](https://exa.ai/docs/reference/rate-limits)）：`/search` 10 QPS、`/contents` 100 QPS、`/answer` 10 QPS；更高需谈 Enterprise。
接入：`x-api-key: $EXA_API_KEY` 或 `Authorization: Bearer`；`pip install exa-py`、`npm install exa-js`（读 `EXA_API_KEY`）；托管 MCP `https://mcp.exa.ai/mcp`（本会话实测 `tools/list` 给 `web_search_exa`/`web_fetch_exa`，免 key 可用）。
**未确认（文档不一致）**：[Contents 页](https://exa.ai/docs/reference/contents) 称 Search 返回的 URL 附内容"no extra charge up to 10 results per search"，而 Pricing 页把 `summary` 一律按 $1/1k 页计——`text`/`highlights` 是否随 search 免费需实测 `costDollars`。

## 3. Tavily（已核实）

**端点**（[tavily-mcp 源码 `baseURLs`](https://github.com/tavily-ai/tavily-mcp/blob/main/src/index.ts)）：`/search`、`/extract`、`/crawl`、`/map`、`/research`、`/feedback`（均在 `https://api.tavily.com`）。

| 能力 | 关键参数 | 返回 |
|---|---|---|
| Search | `search_depth`(`basic`/`advanced`/`fast`/`ultra-fast`)、`max_results`、`include_raw_content`（"cleaned and parsed HTML content of each search result"）、`include_domains`/`exclude_domains`、`topic`、`time_range`、`start_date`/`end_date`、`country`(仅 `topic=general`，须全称)、`include_images`/`include_image_descriptions`、`include_favicon`、`exact_match` | 标题、URL、内容摘要（+可选 raw content），每条带 `id`，响应带 `request_id` |
| Extract | `urls`（**一次最多 20 个**）、`extract_depth`(`basic`/`advanced`)、`format`(markdown/text)、`include_images`、`query`（按相关性重排 chunk） | `results[].{url, raw_content, images}`；失败进 `failed_results` 且**不计费** |
| Crawl / Map | `max_depth`、`max_breadth`、`limit`、`instructions`、`select_paths`/`select_domains`(regex)、`extract_depth`、`format` | crawl=map+extract 计费 |
| Research | `input`、`model`(`mini`/`pro`/`auto`)、`citation_format`、`stream`；`get_research(request_id, include_usage=True)` 取 credits | 报告正文 + `sources` + 可选 `usage.credits` |
| Feedback | `urls_scores`（逐结果打分）、`used_ids`、`response_delivered` | 回传官方改进排序 |

来源：[tavily-python README](https://github.com/tavily-ai/tavily-python)、[tavily-mcp 源码](https://github.com/tavily-ai/tavily-mcp/blob/main/src/index.ts)。**Keyless 模式**：`TavilyClient()` 无 key 可用 `search()`/`extract()`，其它方法报错，超限抛 `TavilyKeylessLimitError`（携 `code`/`window`/`retry_after_seconds`/`next_actions`）。
注：`results[].id` 是 **Tavily 自己的结果标识**，与 Exa 的 id 不可比，不能当作跨源去重键（§6.1）。

**价格**（[Credits & Pricing](https://docs.tavily.com/documentation/api-credits)、[tavily.com/pricing](https://www.tavily.com/pricing)）

| 计划 | credits/月 | 月费 | 单价/credit |
|---|---|---|---|
| Researcher | 1,000 | 免费 | — |
| Project | 4,000 | $30 | $0.0075 |
| Bootstrap | 15,000 | $100 | $0.0067 |
| Startup | 38,000 | $220 | $0.0058 |
| Growth | 100,000 | $500 | $0.005 |
| Pay as you go | 按用量 | — | $0.008 |
| Enterprise | 定制 | 定制 | 定制 |

逐请求：`basic` search **1 credit**、`advanced` **2 credits**；extract 每 5 次成功抽取 = 1 credit（advanced 2）；map 每 10 页 = 1 credit（带 `instructions` 2）；crawl = map + extract（官方算例：10 页 basic = 3 credits、advanced = 5 credits）；research `pro` 15–250 credits、`mini` 4–110 credits。免费档 1,000 credits/月、**每月 1 日重置**、无需信用卡；额度耗尽即停。
限速（[Rate Limits](https://docs.tavily.com/documentation/rate-limits)）：Dev key 100 RPM、Prod key 1,000 RPM（Prod key 需付费计划或启用 PAYGO）；crawl 100 RPM；research 建任务 20 RPM；usage 10 次/10 分钟；超限 `429` + `Retry-After`。
接入：`TavilyClient(api_key="tvly-…")`、`AsyncTavilyClient`；支持自建 `requests.Session`/`httpx.AsyncClient` 走企业网关；归因 header `X-Project-ID`/`X-Session-Id`/`X-Human-Id`/`X-Client-Name` **均为 opt-in**（默认不发；官方称 `human_id` 服务端哈希、不原样持久化）——启用涉及向第三方回传标识，需隐私评估（§6.6）。
**未确认**：官方 README 标注 Crawl "currently available on an invite-only basis"，与定价页把 Crawl 当正常计费项并列，口径需实测；keyless 正文条款与 tavily.com 各档位数字（JS 渲染）未逐字取到。

## 4. Bing：退役核实 + 两个关键问题

## 4. Bing：旧 Search APIs 退役核实 + 现行 Grounding 的两个关键问题

### 4.1 退役事实链（针对**旧 Search APIs**，不代表 Gemini/Grounding 也消失）

| 事实 | 原文依据 | 来源 |
|---|---|---|
| **2025-08-11 退役** | "Bing Search APIs will be retired on August 11, 2025. Any existing instances … will be decommissioned completely, and the product will no longer be available to be used or new customer signup." | [Lifecycle 通告](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) |
| 官方迁移去向 | 指向 Grounding with Bing Search（Azure AI Agents） | 同上 |
| 文档已归档 | `…/bing/search-apis/bing-web-search/overview` 重定向到 `previous-versions`，页标 `Last updated 2025-05-07` | 本会话实抓 |
| 原定价页已消失 | [microsoft.com/en-us/bing/apis](https://www.microsoft.com/en-us/bing/apis) 正文只剩 Grounding 两档 | 同上 |
| 无展期公告 | Azure Updates 搜索 `bing` 页面为 JS 渲染、未取到条目；Lifecycle 通告未见修订 → 记为**未确认**（既不能确认有延期，也不能据此断言"绝无"） | [azure.com/updates](https://azure.microsoft.com/en-us/updates/?searchTerms=bing) |

### 4.2 现行 Grounding 是否暴露原始搜索结果？—— **不暴露（官方明文）**

- 定价页："This product is designed to function as an add-on feature for select Microsoft products… **Outputs are not directly accessible for use in other applications or programs.**"（[bing/apis](https://www.microsoft.com/en-us/bing/apis)）
- Foundry 文档："**Developers and end users don't have access to raw content returned from Grounding with Bing Search.** The model response, however, includes citations with links…"；"The Grounding with Bing Search and Grounding with Bing Custom Search tools **don't return the tool output** to developers and end users."（[Foundry 文档](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/bing-tools?pivots=python)）
- 定义层面也印证：`Services` = "access to (i) **Bing Services Output after being processed and summarized using an LLM** and (ii) Documentation"（[企业条款](https://www.microsoft.com/en-us/bing/apis/grounding-legal-enterprise)）。
- 能拿到的只有 `annotation` 里的 `url_citation` + Bing 查询链接，且条款要求**原样保留并展示 References**、场景须是 "internet search experience"（同上 Appendix）。
- 计费：$14 / 1,000 transactions；150 transactions/秒；100 万 transactions/天；transaction = "tool calls per run"（[bing/apis](https://www.microsoft.com/en-us/bing/apis)、[Foundry 文档](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/bing-tools?pivots=python)）。Grounding with Bing Custom Search 仍是 **preview**（工具类型 `bing_custom_search_preview`）。

口径边界：**"不暴露原始结果"只适用于现行 Grounding 形态**；已退役的旧 Search APIs（Bing Web Search v7）当年以直接返回原始结果集为常态，但其确切响应字段本次未取归档细则核验，**未确认**，不宜引用。

### 4.3 现行 Grounding 是否允许跨模型输出复用？—— **官方未见"允许"；训练/评估/派生/缓存明文受限；推理期跨模型合成=未确认，需合同审查**

**结论（限定）**：官方条款里**没有任何"允许把 Bing 输出交给其它模型复用/合成"的授权文句**，反而明文限制训练与评估、派生作品、缓存与竞争产品。把 Bing 输出喂给别的模型做推理期合成，属**未确认**区间：不得径行认定合法或非法，**需合同/法务确认**。本节结论仅用于判断本次技术选型，**不是法律意见**。

| 问题 | 官方原文 | 档位 |
|---|---|---|
| 训练/评估 | "**No Training.** … you may not use any Bing Services Output to train any AI Models, including without limitation your proprietary AI Model." | 企业条款 §2(e) |
| 训练/评估（更强） | "Use or facilitate the use of the Bing Services Output to **train, evaluate or improve any AI Model**, including … your proprietary AI Model, **or any new or existing services that Customer or third parties may offer**" 被禁 | 企业条款 Appendix 2(b) |
| 派生 | "**No Derivative Works.** Customer will not modify or create a derivative work based on any Bing Services Output unless expressly permitted" | 企业条款 §2(c) |
| 缓存 | 仅允许"作为自身工作产物的一体化部分"有限复制/缓存，且明确点名不得用于建库、索引链接、**用链接做爬取/抓取**、独立搜索产品 | 企业条款 §3(c) |
| 竞争品 | "Use the Service to create a database or service that competes with Bing Services Output" 被禁 | 企业条款 §3(b)(g) |
| 跨模型切换 | "Circumvent technical or programmatic limitations on **which AI Models are available** to you for use with the Services through the Enterprise Integration" 被禁（= 模型选择由集成限定，不得绕开） | 企业条款 Appendix 2(a) |
| 消费档额外限制（若不经 Foundry） | "Use the Services outside of, or separately from, the Approved Microsoft Application" 被禁；"**Copy, store, cache, archive, or create a database of Output**" 被禁；"Use the Output in combination with any open source software or other data subject to an open source license that may impair the copyright protection of the Output" 被禁 | [消费档条款](https://www.microsoft.com/en-us/bing/apis/grounding-legal) §4(b)a/o/h |

两份条款的适用边界（原文）：企业档 "If you are using the Services through an enterprise integration (such as Azure Foundry), these terms do not apply" —— 即通过 Foundry 接入时适用 [企业条款](https://www.microsoft.com/en-us/bing/apis/grounding-legal-enterprise)（`Last updated: November 2025`），否则适用[消费档条款](https://www.microsoft.com/en-us/bing/apis/grounding-legal)（同样 `Last updated: November 2025`）。
另外：输出不含 Customer Data，**Microsoft DPA 明确不适用**，数据流出 Azure 合规与地理边界（企业条款 §4；[Foundry 文档](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/bing-tools?pivots=python)）。

**对插件的直接后果（本次选型建议，非法律定论）**：要在插件内直连 Bing 只能走 Azure AI Foundry Agent，且（a）拿不到原始结果集与正文，（b）不得缓存输出，（c）跨模型合成合法性**未确认、需合同审查**。因此**建议 MVP 不接 Bing**；若日后确需，先完成条款确认再谈（§8）。

## 5. Google：时间线核实（已核实）

### 5.1 被点名的年份逐个对原文

| 说法 | 官方原文 | 判定 | 来源 |
|---|---|---|---|
| Site Restricted 2025 退役 | "The Custom Search Site Restricted JSON API endpoints will **cease to serve traffic on January 8, 2025**."（迁移至 Google Cloud Agent Search） | ✅ 但只针对 Site Restricted 变体 | [官方页](https://developers.google.com/custom-search/v1/site_restricted_api)（`Last updated 2026-09-03`） |
| Bing 2025-08-11 | 见 §4.1 | ✅ | [Lifecycle](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) |
| "2026 新客户" | "**Note:** The Custom Search JSON API is **closed to new customers**. Vertex AI Search is a favorable alternative for searching up to 50 domains." | ✅ | [Overview](https://developers.google.com/custom-search/v1/overview)（`Last updated 2026-02-18`） |
| "2027" | "The following pricing applies only to existing Custom Search JSON API customers until the **service discontinuation on January 1, 2027**." / "Existing … customers have until January 1, 2027 to transition to an alternative solution." 官方 blog（2026-01-20）重复同一日期，并说明新引擎必须用 "Sites to search"、存量引擎可继续 "Search the entire web" 至 2027-01-01 | ✅ 2027-01-01 = 迁移/停服节点 | [Overview](https://developers.google.com/custom-search/v1/overview)、[官方 blog 2026-01-20](https://programmablesearchengine.googleblog.com/2026/01/updates-to-our-web-search-products.html) |
| "2030" | **在 Overview / Introduction / 额外条款 / 官方 PSE blog（2026-01、2026-02 两篇）中均未出现 2030 或任何 2030 年表述** | ❌ **官方渠道未见**；来源不明，按不可信处理 | 同上四处官方页 |

补充：[额外使用条款](https://developers.google.com/custom-search/terms)页 `Last modified: January 11, 2020`，只讲计费与"Google 会公告停服或破坏性变更"，**无任何结束日期**——2027 出自 Overview 与 blog，不是法律条款。

### 5.2 价格与配额（现行，仅对存量客户）

100 次查询/天免费；超出 $5 / 1,000 次查询；上限 10k 次/天；且原文限定"This pricing applies only to existing Custom Search JSON API customers until the service discontinuation on January 1, 2027"（[Overview](https://developers.google.com/custom-search/v1/overview)）。
数据模型基于 OpenSearch 1.1，单一方法 `GET cse.list`，需 `cx` + `key`（[Introduction](https://developers.google.com/custom-search/v1/introduction)）。

### 5.3 关键合规限制（比价格更致命）

[PSE ToS](https://support.google.com/programmable-search/answer/1714300) 明文禁止：§1.4(a) 不得改动/过滤/重排结果，且明确禁止 "**commingling Results with non-Google provided search results**"；§1.4(i) 不得以自动化等手段生成查询或结果曝光；§1.4(l) 不得以任何非临时方式存储或缓存；§1.3 "may not in any way frame, cache or modify the Results"。
→ **即便用户手里有存量 key，把它接进"多源合并 + 去重"的插件本身就命中 commingling 与自动化查询禁令。**

### 5.4 现行替代形态（只给模型答案+引用，取不到原始结果集）

| 形态 | 计费/限额 | 是否给原始结果 | 来源 |
|---|---|---|---|
| Gemini `google_search` 工具 | 5,000 次搜索请求/月免费（Gemini 3+ 共享），之后 **$14 / 1,000 请求**；脚注：一次用户请求可能触发多次搜索查询，逐次计费 | ❌ 模型自行生成查询→合成→只回带引用的答案 | [Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing)、[Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search) |
| Vertex/Agent Platform grounding | 上限 **100 万查询/天**；必须开启并展示 Google Search Suggestions | ❌ | [Google Cloud 文档](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search) |
| Vertex AI Search | 官方 blog 称其为 ≤50 域场景的替代 | 站点/企业语料检索，非全网 | [blog 2026-01-20](https://programmablesearchengine.googleblog.com/2026/01/updates-to-our-web-search-products.html)、[Overview](https://developers.google.com/custom-search/v1/overview) |
| 全网搜索新客户入口 | 官方只说 "complete this form to register your interest"（报名洽谈，非自助购买） | **未确认** | 同上 |

**引用字段名（已核）**：现行 Gemini 文档（Interactions API）用文本块上的 **`annotations`**（每项 `type: "url_citation"`，含 `url`/`title`/`start_index`/`end_index`），外加 **`steps`** 里的 `google_search_call`（`queries`）与 `google_search_result`（`search_suggestions` HTML）。
本会话在 [Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search) 与 [generateContent REST 参考](https://ai.google.dev/api/generate-content) 中**均未找到 `groundingMetadata` 字样**（后者本次抓取为代码片段密集页，未逐字段核验）。
→ 结论：**引用字段名会随 API 版本变化**（旧版 `generateContent` 时代常见 `groundingMetadata.candidates[].groundingChunks/groundingSupports` 等字段名），实现前须按实际调用的 API 版本核字段，不要照抄本行或记忆。

## 6. 对"小模型评估证据 + 去重"的影响（推论与建议，非文档事实、非法律意见）

| 判据 | Exa | Tavily | Bing 现行 | Google 现行 |
|---|---|---|---|---|
| 评估材料 | `highlights[]`(+`highlightScores`) 或 `text`（`maxCharacters` 限长） | `content` 摘要 + `include_raw_content`/`/extract` 全文 | 无 | 无 |
| 本供应商标识 | `results[].id`（≈URL）+ `requestId` | `results[].id` + `request_id` | 无 | 无 |
| 能否直接当跨源去重键 | ❌ 各自内部标识，跨源不可比 | ❌ 同上 | — | — |
| 合并许可（本次仅核验 ToS/定价页层面的公开限制） | 本次未完整核验其 API 许可/条款，需单独审查 | 同左 | 训练/评估/派生/缓存明文受限；跨模型合成=未确认 | ToS §1.4(a) 禁止与非 Google 结果 commingling |
| 结论（四家候选内） | ✅ 可作主源（附许可核验义务） | ✅ 可作第二源（同上） | ⚠️ 不接（建议，待条款确认） | ❌ 不可合并 |

1. **去重键要自己造**：Exa 的 `results[].id`、Tavily 的 `results[].id` 都是**各自供应商内部标识**，跨源不可直接比较（Exa 的 id 恰为 URL 属其自身形态，仍不应假定跨源通用）。跨源合并须以**自己生成的规范化 URL 键**为主键、供应商 id 作辅助校验。
2. **URL 规范化要保守**：fragment（`#...`）与查询参数**不可盲删**——fragment 可能是区分文档的关键（SPA 路由、页面锚点、`#section`），查询参数可能是内容的一部分（`?id=`、`?page=`、`?v=` 版本）；只能删已被证实为纯跟踪用途的参数（如 `utm_*`），其余整条保留。
3. **标题近似不能可靠去重**：标题相同/相近不蕴含正文相同（同一新闻被多家转载、同一页面多版本）。近重复判定必须回到**正文**，并显式保留差异：**时间（发布日期/更新日期）**、**数值（金额、比例、版本号、统计口径）**、**否定与限定（"不/未/仅/除…外"）** —— 这些差异往往正是"是否同一份证据"的分界。
4. **检索层原语只减少候选、不保证去重**：Exa 的 `excludeDomains` 与 `objective` 是检索偏好/排序提示，Tavily 的 `exclude_domains`、`exact_match` 是检索约束，**都不是去重保证**；模型层的判定不可省。
5. **成本是预算问题，不是固定阈值**：按官方价，Exa `auto` $7/1k 请求 + Tavily `basic` 1 credit（PAYG $0.008）≈ **$0.015/次检索**（2 源 × 10 条）。"每次评多少条候选"取决于**单次预算与每候选 token 成本**，是**可调参数**：候选越多越贵也越慢（延迟/批处理预算），需要按预算调，而非定死某个数字。（此测算只含检索费，不含评估模型自身 token 成本。）
6. **Feedback API 是 opt-in、涉隐私**：Tavily 的 `project_id`/`session_id`/`human_id`/`client_name` 都是可选归因标识（`X-*` header，官方称 `human_id` 服务端哈希、不原样持久化），**默认不发送**；启用前须评估是否把终端用户/项目标识回传给第三方，并在隐私声明中交代。
7. **Bing/Google 条目的处理**：Google 现行形态只给模型答案里的引用，既无候选集也受 ToS 混排限制；Bing 现行 Grounding 不返回原始输出、无候选集。**两者都不进入本插件的检索/去重链路**（Bing 为建议，见 §4.3）。

## 7. 抓取记录与核实分级（2026-10-11 实抓）

| 来源 | 结果 | 页面日期 |
|---|---|---|
| [Bing Lifecycle 退役通告](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement) | ok | Last updated 2025-05-16 |
| [Foundry Bing grounding 文档](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/bing-tools?pivots=python) | ok | 无日期 |
| [Bing Web Search API（previous-versions）](https://learn.microsoft.com/en-us/previous-versions/bing/search-apis/bing-web-search/overview) | ok（重定向而来） | Last updated 2025-05-07 |
| [microsoft.com/en-us/bing/apis](https://www.microsoft.com/en-us/bing/apis) | ok | 无 |
| [Grounding 企业条款](https://www.microsoft.com/en-us/bing/apis/grounding-legal-enterprise) / [消费档条款](https://www.microsoft.com/en-us/bing/apis/grounding-legal) | ok | Last updated: November 2025 |
| [Azure Updates?searchTerms=bing](https://azure.microsoft.com/en-us/updates/?searchTerms=bing) | **JS 渲染、正文空** | — |
| [CSE JSON API Overview](https://developers.google.com/custom-search/v1/overview) | ok | Last updated 2026-02-18 |
| [Introduction](https://developers.google.com/custom-search/v1/introduction) | ok（重定向 `?hl=fr`） | 2026-01-20 |
| [Site Restricted JSON API](https://developers.google.com/custom-search/v1/site_restricted_api) | ok | Last updated 2026-09-03 |
| [额外使用条款](https://developers.google.com/custom-search/terms) | ok（`?hl=de`） | Last modified 2020-01-11 |
| [PSE blog 2026-01-20](https://programmablesearchengine.googleblog.com/2026/01/updates-to-our-web-search-products.html) | ok（正文经 Exa MCP） | Published 2026-01-20 |
| [PSE blog 2026-02-11](https://programmablesearchengine.googleblog.com/2026/02/a-modernized-search-experience-for.html) | 列表页 ok，正文未取到 | Published 2026-02-11（内容**未确认**） |
| [PSE ToS](https://support.google.com/programmable-search/answer/1714300) | ok（尾段截断） | 无 |
| [Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing) / [Google Search 工具](https://ai.google.dev/gemini-api/docs/google-search) | ok（重定向 `?hl=ar`/`?hl=fa`） | 无 |
| [Vertex grounding](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/grounding/grounding-with-google-search) | ok（`?hl=de`） | 无 |
| [Exa Pricing](https://exa.ai/docs/admin/pricing) / [Search](https://exa.ai/docs/reference/search) / [Contents](https://exa.ai/docs/reference/contents) / [Answer](https://exa.ai/docs/reference/answer) / [Rate Limits](https://exa.ai/docs/reference/rate-limits) | ok（经官方 MCP） | Pricing `Last modified 2026-09-25` |
| [exa-py README](https://github.com/exa-labs/exa-py) | ok | — |
| [Tavily 定价](https://docs.tavily.com/documentation/api-credits) / [限速](https://docs.tavily.com/documentation/rate-limits) | **本机直连超时**，经 Exa MCP 读原文成功 | 无 |
| [tavily-python README](https://github.com/tavily-ai/tavily-python) / [tavily-mcp 源码](https://github.com/tavily-ai/tavily-mcp/blob/main/src/index.ts) | ok（经 grep 定点取用） | — |
| [tavily.com/pricing](https://www.tavily.com/pricing) | 经 Exa MCP 读取；数字为 JS 滚动，未取全 | 无 |
| [keyless 文档](https://docs.tavily.com/documentation/keyless) | 仅取到标题 | 无 |

网络说明：本机对 `exa.ai`/`docs.tavily.com`/`tavily.com`/`api.tavily.com` 直连超时（DNS 落 mihomo tun 段 `28.0.0.94`、`2001:480:abcd::5e`，IPv4/IPv6/显式代理皆超时），而 `developers.google.com`、`learn.microsoft.com`、`github.com`、`api.exa.ai`、`mcp.exa.ai` 正常 —— 故 Exa/Tavily 原文走**官方 MCP / 官方仓库**，未用二手转述。

**已核实**：Bing 旧 Search APIs 2025-08-11 退役（现行 Grounding 仍在售）；现行 Grounding 不暴露原始输出、$14/1k、150 TPS、1M/天、训练/评估/派生/缓存/竞争品禁令与两份条款的适用边界；Google CSE 新客户关闭、2027-01-01 停服、$5/1k + 100/天免费 + 10k/天上限、Site Restricted 2025-01-08 停服；PSE ToS 的 commingling/自动化/缓存禁令；Gemini grounding $14/1k 与 5,000 次/月免费、Vertex 100 万/天；Gemini 现行引用字段为 `annotations`+`steps`；Exa 与 Tavily 的端点/价格/限速条目。
**未确认**：Google 是否存在 "2030" 表述（反向核实=未见，非官方否认）；Azure 是否有过 Bing 展期公告（Updates 页 JS 渲染）；Google "full web search solution" 报名后的能力与价格；Tavily Crawl invite-only 与定价页并列的口径差异；Tavily keyless 正文与各档位数字；Exa `/search` 附 `text`/`highlights` 是否免费；PSE blog 2026-02-11 正文；**Bing 推理期"跨模型合成"的合法性（条款未明文，需合同审查）**；**旧 Bing Web Search v7 历史响应字段（未取归档细则）**；**Exa / Tavily 的 API 许可与条款完整性（本次仅核验公开 ToS/定价页层面）**；Gemini `generateContent` 旧版字段名（未逐字段核验）。
**已失效/改版**：`bing/search-apis/bing-web-search/overview`（→ previous-versions）；`microsoft.com/bing/apis`（改版为 Grounding with Bing，原 Bing API 定价消失）。

## 8. 建议（限定在本节四家候选之内；属工程选型建议，非法律结论）

1. **本插件内可直连的候选为 {Exa, Tavily}**：这两家满足"可购买 + 可直连 + 可拿原始 URL/正文"。（不对其它供应商作判断；Brave 等第三方经销类服务不在本节范围。）
   Bing 现行 Grounding 不返回原始输出、Google CSE 对新客户关闭且 2027-01-01 停服，且 Google 另受"不得与非 Google 结果混排"限制 → **建议 MVP 不提供 `bing` / `google_cse` provider 选项**；Bing 的结论待条款确认（§4.3）。
2. **去重与评估建立在自建的规范化 URL 键上**：供应商 id（Exa `results[].id`、Tavily `results[].id`）只作各自内部的辅助校验，**跨源不可比**；URL 规范化保守处理（fragment 与查询参数不可盲删，仅删已证实的跟踪参数）；近重复必须回到正文并保留时间/数值/否定差异。
   检索层用 Exa `excludeDomains`、Tavily `exclude_domains` 减少候选即可，**不要指望它们去重**；每次评估的候选条数按**预算**调（含评估模型 token 成本与延迟），不是固定阈值。
3. **Bing 输出建议暂不复用**：现有条款既未授予复用权，又有训练/评估/派生/缓存限制，跨模型合成合法性未确认；在合同/法务确认前，不建议在插件内消费 Bing 产出（也不建议为此改走插件外的 Foundry 链路）。
4. **`objective` / `outputSchema` / `exact_match` / Feedback 的边界**：前三者是检索偏好与结构化输出的便利手段，不承诺去重；Tavily Feedback 属 opt-in 且会把标识回传第三方，启用前做隐私评估（§6.6）。
