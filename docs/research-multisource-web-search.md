# 调研：多源 Web Search 与证据筛选插件

调研日期：2026-10-11。范围：官方 API 文档、当前 DSH 0.2.0-rc.2 的只读运行时接口，以及相关原始研究论文。**本轮只调研，没有实现或安装插件，没有调用付费 API 做基准测试。**

## 1. 结论

**可行，值得做；建议定位为「自适应多源检索 + 可追溯证据筛选」，而不是「多个模型回答的投票器」。**

- 优势来自搜索覆盖互补、找到一手材料、保留冲突，以及在有限上下文中提高独特证据密度。
- 供应商数量不等于独立证据数量。同一篇公告被五个引擎找到、被十家媒体转载，仍可能只是一条事实来源。
- Flash/小模型适合相关性判定、问题覆盖分析、事实抽取和冲突标记；不能仅凭文本风格证明事实正确。
- 不应第一版就每次调用全部供应商。先证明两家搜索源加正文核验能优于最强单源，再增加第三家。
- DeepSeek 适合担当筛选/回答模型，而不是独立搜索源。OpenAI 是带联网工具的模型调用，不应与 Exa/Tavily 的纯检索接口混为一谈。[1][2]

上述架构与选型是本次设计建议，不是已实测的质量提升承诺。

## 2. 供应商选型：并非同一种 API

| 来源 | 可接入形态 | 对本方案的意义 |
|---|---|---|
| Exa | 独立 Search、Contents 等接口 | 候选检索与网页内容获取；可作为英文技术/研究类任务的候选源，但优劣需本地评测。[3] |
| Tavily | 独立 Search、Extract 等接口 | 可取 URL、相关片段及提取内容；方便快速原型，生成 answer 默认不作为事实依据。[4] |
| 智谱 GLM 国内平台 | 独立 `web_search` API，以及 Chat 内置联网 | 独立 API 返回标题、URL、摘要、日期，支持自研/搜狗/夸克引擎；适合作为中文候选源。不是「调用 GLM 模型才能搜」。[5] |
| OpenAI | Responses API 的 `web_search` 工具 | 可拿 URL citations 和 consulted sources，但仍是模型调用；无本次查到的独立纯搜索端点，不保证返回完整文本正文。适合可选的复杂检索升级。[1] |
| DeepSeek 公共 API | 模型与 function calling | 当前 Responses 兼容文档将内置 `web_search` 标为 Ignored；网页/App 联网不能推导为公共 API 搜索能力。用作 judge/最终回答。[2] |
| Bing | 旧 Bing Search APIs 已于 2025-08-11 退役；替代是 Azure Agent 的 Bing Grounding | 不能沿用旧 REST 搜索教程。Grounding 不向开发者返回原始工具内容；跨模型合成与缓存还需合同审查，MVP 暂不接入，不是旧 API 的等价替换。[6][15] |
| Google | Custom Search JSON API 已关闭新客户，现有客户须在 2027-01-01 前迁移 | 新插件不建议依赖它。Vertex AI Search 的站点搜索不等于任意全网 SERP；官方全网方案需联系 Google。[7] |
| Brave（建议补充） | 独立 Search API | 官方声明使用独立索引，返回 URL/snippet/额外上下文；可替代传统搜索层的候选之一。独立索引不是事实正确性的保证。[8] |

Google/Bing 的网页搜索并未因此消失；退役/关闭指上述开发者 API 产品。Google JSON API 的附加条款还引用了 PSE ToS，其中存在禁止与非 Google 结果混排的限制；即使有存量 key 也不应默认可用来做本方案。[16] 第三方 SERP API 或 SearXNG 是另外一条接入路径，不能称为官方 Google/Bing API，许可需另核。

国际 Z.ai 与国内智谱平台的接口、账户和价格是否同形，本次未核实，不能直接互换。模型联网能力详见 [辅助调研](research-multisource-model-search.md)。

### 价格与预算

价格是本次读取官方页面的快照，不代表账户最终报价；币种不能直接相加。搜索调用、正文提取、judge、最终回答分别计费。

- 智谱：`search_std` ¥0.01/次，`search_pro` ¥0.03/次，搜狗/夸克各 ¥0.05/次。[5]
- Brave Search：$5/1,000 requests，每月 $5 免费额度；页面列出 50 QPS。[8]
- OpenAI `web_search`：标准工具调用 $10/1,000 calls，另有模型及搜索内容 token 费用；一个任务可能发生多次搜索，不可按一次用户问题只计一次。旧 preview 定价单独列出，不能混用。[9]
- Exa：官方定价经辅助调研读取，instant $4/1,000 请求、fast/auto $7/1,000 请求、deep $12/1,000 请求、deep-reasoning $15/1,000 请求；超额结果/摘要/Contents 可额外计费，search 附正文的免费口径存在文档差异，待用 `costDollars` 实测。[3]
- Tavily：每月 1,000 免费 credits；PAYG $0.008/credit；basic search 1 credit、advanced 2 credits；正文提取另计。额度、账单和实际 API 返回需账户验证。[4]
- 两家细节及抓取限制在 [搜索供应商辅助调研](research-multisource-search-providers.md) 记录；本机直读失败，部分官方正文经 Exa 托管 MCP 获取，故定价适合作预算假设，采购前需直接复核。

成本公式：`总成本 = 各检索调用 + 各正文提取调用 + judge 输入/输出 token + 可选升级模型 + 最终回答 token`。

例如 Brave 一次搜索是 $0.005、OpenAI 标准一次搜索工具调用是 $0.01（均未计其他部分）；智谱基础一次是 ¥0.01。这个量级通常可用于个人插件，但七源全开、多查询、多页提取会乘上调用数。

## 3. 推荐流水线

```text
query
  → 查询规划 / 预算与语言路由
  → 选定 1–3 个来源并行检索
  → URL 规范化 + 精确去重
  → 排名融合 / 轻量相关性筛选
  → 对候选页面获取正文或可引用片段
  → 正文近重复 / 转载来源聚类
  → Flash judge：相关性、证据支持、覆盖缺口、冲突
  → 保留有增量的信息 + 必要反证
  → 带引用的证据包
  → 主 AI 生成最终回答，必要时继续检索
```

### 3.1 自适应路由，而不是七源常开

- 简单定义/单一官方事实：一个默认检索源，优先官方文档，必要时读取原页面。
- 比较/调研：两源起步，查询分解为少量子问题；材料不足才补第三源。
- 中文本地信息：优先试智谱；英文技术资料：试 Exa/Tavily/Brave。**这些是路由假设，不是已验证的供应商排名。**
- 时效问题：记录发布时间、抓取时间、适用版本/地区；新资料并非自动更可靠。
- 复杂冲突：针对争议补查一手文档，之后才考虑更强 judge/OpenAI agentic search。

每个适配器应声明：`supportsText`、`supportsContents`、`supportsDateFilter`、`supportsDomainFilter`、`isAnswerGenerated` 等能力。URL 列表、摘录和模型生成回答不能伪装成同一证据类型。

### 3.2 融合与去重顺序

用户提出「评分后再筛一遍重复」合理，但**应先做一遍廉价去重，再在评分后做信息增量筛选**，否则会为重复材料支付 judge 成本。

1. **URL 级**：移除明确的 tracking 参数、解析重定向；保留有语义的 query 参数、语言/版本与正文中必要的 fragment。不要盲目删除所有参数。
2. **正文级**：正规化文本 hash 去掉完全重复；SimHash/MinHash 或 embedding 只用于提出近重复候选。
3. **来源谱系**：识别「原始公告 → 媒体转载 → 博客引用」；记录猜测及依据，无法确定时标为 unknown。相同域名不必然同一来源，不同域名也不必然独立。
4. **事实级**：合并同一主张的表达，但保留支持证据列表；数值、时间、版本、限定条件不同的主张不得自动合并。否定句与肯定句的 embedding 可能很接近。
5. **最终选集**：按覆盖增益选择，限制同一转载簇挤占上下文，但允许相关官方域名承载多个不同事实；保留高质量冲突来源。

排名融合可采用 RRF：`rrf(d) = Σ 1 / (k + rank_i(d))`，`k` 为平滑参数；这是相关性排序起点，**不是可靠性概率**。其意义是不用比较不同 API 的原始分数。重复抓到同一网页不应增加「独立支持数」。[10]

## 4. 如何让 Flash 模型评价材料

不要只要求「给可靠性、准确性、丰富性各打 100 分」。输出无校准的精细分数会制造假精确，也容易偏爱长文本。

建议拆成以下维度，保存理由与原文定位：

| 维度 | 依据 | 不能混淆的概念 |
|---|---|---|
| 相关性 | 是否回答 query 或某个子问题 | 与可信度不同 |
| 来源权威性/直接性 | 是否一手文档、责任主体、研究方法是否清楚 | 官方资料也可能有营销立场或范围限制 |
| 证据支持程度 | 主张能否由给定引文推出 | 文中说了不等于世界中必然为真 |
| 时效和适用性 | 版本、日期、地点、对象是否匹配 | 最新并非永远最优 |
| 独立佐证/冲突 | 不同来源谱系是否支持/反对同一主张 | 搜索引擎品牌数量不是独立佐证数 |
| 增量覆盖 | 新增加了哪个子问题、事实或限定条件 | 字数不等于丰富度 |

Judge 做两类工作：对「片段 → 子问题」做相关性判定；对「主张 → 给定证据」做 `supported / contradicted / insufficient` 判定。保留 `sourceId`、可核对的短引文、版本/日期条件与理由。引用必须能在存档片段中定位；定位不到不能当作已验证。

[FActScore](https://arxiv.org/abs/2305.14251) 提供了将生成文本拆为原子事实、检查可靠知识源支持比例的方法。但其论文实验主要是人物传记，不应直接宣称能验证任意实时网页。[11]

[LLM-as-a-judge 研究](https://arxiv.org/abs/2306.05685) 明确指出位置、冗长、自我偏好和推理能力限制；与人类偏好的高一致性**不等于事实核验准确率**。[12]

因此：

- 默认 judge 不联网、不带可执行工具、输入长度有上限；只评估提供的材料。
- 对生成回答隐藏模型品牌，对网页保留判断来源所需的真实出版信息；抽样随机化顺序，检查位置偏差。
- 用离散标签/排序加证据理由起步；没有标注集校准前，不展示「92% 真实」一类概率。
- judge 超时/格式错误时降级为确定性排名，显式 `judge_status: unavailable`，不伪装已核验。
- 对高风险结论或无法解决的矛盾，补查更直接的材料/升级审核，不默认少数意见错误。

## 5. 给主 AI 的应是证据包，不是第二份最终答案

建议输出：

- 检索范围：query/子问题、语言、时间约束、供应商成功/失败情况。
- 最佳片段：每条携带 `sourceId`、标题、URL、出版/获取时间、适用版本、短引文与 content 类型。
- 主张映射：每条关键主张的支持来源、反对来源与未知项；单源支持明确标注。
- 覆盖缺口：未找到的子问题，不拿模型常识填成「已检索事实」。
- 预算/截断：总结果数、选中数、正文是否截断、judge 状态、费用/耗时。
- 后续读取入口：优先允许继续通过 `web_fetch` 读取 URL；扩展 `resultId/sourceId` 时必须有持久且可重新获取的内容，不依赖插件进程内缓存。

最小输出仍需有足够原文片段，以便主 AI自行核对。只输出 judge 摘要会发生二次摘要损失。

设定 token 上限并保留反证，比把所有正文堆进主模型更合理；[Lost in the Middle](https://arxiv.org/abs/2307.03172) 在其测试模型/任务中展示了长上下文的信息位置效应，不代表所有 2026 模型的固定表现，但足以提示需要对当前目标模型实测。[13]

## 6. 在本仓库的 DSH 接入路径

2026-10-11 经 `cordis_inspect_list` → Host `Service.listService` 定向检查 `web` 与 `llm`：

- 现有 `ctx.web.registerSearchProvider(provider)` 可注册一个**聚合 provider**。
- Provider 契约：`id`、`available(): boolean`、`search(request, signal)`；request 只有 `query` 与可选 `maxResults`。
- 现有返回：`WebSearchResult { content?, sources[], truncated }`；source 只有 `url/title?/snippet?/publishedAt?`。
- 可保持既有 `web_search` 工具入口，将整理后的证据包放 `content`，URL/引文摘要放 `sources`；内部富结构无需在第一版修改宿主类型。
- Web service 在多个可用 provider 且没有明确选择时会报 `WEB_PROVIDER_AMBIGUOUS`；聚合不是多注册几个 provider 就会自动发生，需要显式选择聚合 provider。
- 不要在聚合 provider 内调用已选择自身的 `ctx.web.search()`，会递归；适配器直接请求外部端点。当前检查没有看到按 id 调用其他已注册搜索 provider 的公共方法，不能假设存在。
- `ctx.llm.stream()` 可调用已挂载的 judge 模型路线。其当前 `GenerateOptions` 没有 `response_format` 或强制 tool-choice 参数；第一版要验证普通文本 JSON、限制重试并提供降级，而非假设所有 provider 支持相同结构化输出。
- 配置存模型路线、来源开关与预算；密钥只通过 `ctx.credentials` 引用。工具结果走宿主正常记录链路，避免把网页资料直接注入 system prompt 或绕过 session log。
- 若需要每次调用的 `fast/balanced/deep` 参数，当前 `WebSearchRequest` 承载不了它：第一版使用 Config 默认模式；后续才决定额外工具是否值得增加入口。

这是只读能力确认，不是已经运行过的插件验证。未来实现可以从 `packages/multi-search` 的 Host-only bundle 起步，不需要先做浏览器 UI，也不修改 `$DSH_HOME` 或 profile；宿主配置变更由用户按本仓库约定执行。

## 7. 安全、隐私和运行质量

以下是工程要求，而非声称已完成：

- 网页/模型输出均为不可信数据；不能执行页面里的指令，不把 judge 当作安全边界。
- 自行抓取 URL 必须防 SSRF：限制协议、私网/回环/metadata IP、重定向及 DNS 解析，控制大小、类型和超时。
- 只发送 query/必要子问题，**不把完整对话、秘密或本地代码发送给所有搜索商**；提示用户多源模式增加数据接收方。
- 核查搜索结果缓存、正文保留和下游模型复用许可；第三方 Google/Bing SERP 返回数据不自动意味着得到原站授权。
- 设总 deadline、单源 timeout、并发上限、按状态码限制重试和费用上限；单源失败要返回剩余材料并注明缺失。不得因 judge/供应商失败无界重试。
- 一手材料读不到时保留 URL/摘要，但标注 `snippet_only`，不能冒充全文已核验。

SearXNG 已证明多引擎聚合本身并不新颖，且官方管理文档存在搜索引擎 CAPTCHA 阻断处理。这条路径适合自托管探索，但不是「免费且稳定且天然获授权的 Google/Bing API」。本插件的差异应是证据谱系、冲突与上下文预算管理。[14]

## 8. MVP 与证明它真的有用

### 第一版建议

1. 两个检索适配器：**智谱独立搜索 + Tavily 或 Exa 二选一**；若主要是英文技术检索，也可用 Brave + Exa/Tavily。
2. 默认不接模型生成答案源，不依赖已关闭/退役的 Google/Bing API。
3. URL 去重、结果融合、少量正文核验、单次 Flash judge、引文与冲突输出。
4. 每源最多取约 5–8 个候选，正文获取约 4–8 页，返回约 6–10 个有增量片段；这些是初始预算建议，**不是测量结果**。
5. 聚合 provider 与配置；单源故障/取消/judge 失败回归测试。

第二阶段再加 Brave/第三源、转载聚类、条件触发的 OpenAI search；不建议一开始训练专用「决策模型」。

### 评测

建立 50–100 个具有人工标注关键事实/参考一手来源的问题：中文、英文、最新价格/API、版本差异、比较问题、冲突、无答案和恶意页面。固定最终回答模型、提示与输出预算。

比较：

- 最佳单源；
- 单源 + 正文核验；
- 两源 + 确定性去重/排名；
- 两源 + Flash judge；
- 后续三源/自适应路由。

记录：证据召回、引用真正支持主张的比例、无依据事实比例、覆盖度、冲突保留、重复 token、下游回答质量、成本、P50/P95 延迟、供应商失败率。另对高排名引用做人工复核，不只用同一 judge 给自己的结果打分。

成功条件是「单位成本/延迟下更好的有据回答」，不是「返回更多链接」；如果主要收益来自单源正文核验而不是多源，就应保留更简单方案。

## 9. 一手来源

1. OpenAI Web search：<https://developers.openai.com/api/docs/guides/tools-web-search>；Markdown 端点本次直接读取成功：<https://developers.openai.com/api/docs/guides/tools-web-search.md>。
2. DeepSeek Responses compatibility（Tools 表明确 web_search Ignored）：<https://api-docs.deepseek.com/guides/responses_api>。
3. Exa 定价与 API：<https://exa.ai/docs/admin/pricing>、<https://exa.ai/docs/reference/search>、<https://exa.ai/docs/reference/contents>。详细字段核实见供应商辅助调研。
4. Tavily Search/Extract/credits：<https://docs.tavily.com/documentation/api-reference/endpoint/search>、<https://docs.tavily.com/documentation/api-reference/endpoint/extract>、<https://docs.tavily.com/documentation/api-credits>。详细字段核实见供应商辅助调研。
5. 智谱官方联网搜索（结构化结果与引擎价格）：<https://docs.bigmodel.cn/cn/guide/tools/web-search.md>。
6. Microsoft Bing API 退役公告：<https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement>，本次直接读取成功，页面更新 2025-05-16。
7. Google 官方 overview：<https://developers.google.com/custom-search/v1/overview>，本次直接读取成功，页面更新 2026-02-18。
8. Brave 官方产品/定价：<https://brave.com/search/api/>，本次直接读取成功。
9. OpenAI API pricing：<https://developers.openai.com/api/docs/pricing>，由辅助调研读取核实。
10. RRF 原论文：Cormack, Clarke, Buettcher, SIGIR 2009，<https://doi.org/10.1145/1571941.1572114>（本次正文被 403 拦截）；Elastic 官方公式文档：<https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion>（搜索索引可发现，直读连接失败）。本报告将 RRF 作为既有算法建议，不援引本次未读的实验收益数值。
11. FActScore 原论文：<https://arxiv.org/abs/2305.14251>，直接读取成功。
12. Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena：<https://arxiv.org/abs/2306.05685>，直接读取成功。
13. Lost in the Middle：<https://arxiv.org/abs/2307.03172>，直接读取成功。
14. SearXNG 官方项目文档及 CAPTCHA 管理说明：<https://docs.searxng.org/>、<https://docs.searxng.org/admin/answer-captcha.html>，直接读取成功。
15. Bing Grounding 官方内容可访问限制及企业条款：<https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/bing-tools?pivots=python>、<https://www.microsoft.com/en-us/bing/apis/grounding-legal-enterprise>。辅助调研核实原文，跨模型推理用途的法律适用未作确定结论。
16. Google JSON API additional terms（明确引用 PSE ToS）：<https://developers.google.com/custom-search/terms>；PSE ToS <https://support.google.com/programmable-search/answer/1714300> 含禁止与非 Google 结果混排等限制。前者主调研直接读取，后者辅助调研读取；仍需以实际协议/特别授权为准。

限制：没有账户侧资格/实际限额验证、没有付费 API 测试、没有端到端质量/延迟测量；国际 Z.ai 未核实；部分站点抓取失败保留明确说明，不以第三方博客补齐为既定事实。
