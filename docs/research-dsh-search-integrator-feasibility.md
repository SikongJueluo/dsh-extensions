# DSH 信息整合搜索插件：API 可行性与实现难度

日期：2026-10-11；运行时：DSH 0.2.0-rc.2。仅调研，未实现/安装，未修改 profile、Nix 配置或运行付费搜索基准。

## 结论

**可实现；完整需求不需要改 DSH 源码，但更适合自有工具处理流程，而不只是换一个搜索 provider。**

用户目标是插件主动筛选、去重、判断适用性并整合材料，主 AI 不必筛选原始结果。建议实现 Host-only bundle：工具接收整个检索任务，内部完成多源请求、材料处理和小模型整合，最后只返回精炼结论、必要引文与未知项。无需浏览器半插件或额外常驻 HTTP 服务。

前一轮「保留 web_search、换聚合 provider 就可满足第一版」的判断需要收窄：它能提供**单 query 的整合**；原工具对多个 query 是分别调用 provider、最后拼接 content，不做跨 query 的总整合。严肃版本应让插件拥有整个工具执行流程。

## 1. 已核实的 API

核实路径：`cordis_inspect_list` → Host `Service.listService` 精确检查 `llm/tools/credentials/agents/attachments/spillStore/settings`；Host `Config.listConfigs` 获取已安装包 `packageDir`，读取 README 与发布 lib。搜索调用链由独立后台调研核实，见 [源码明细](research-dsh-multisource-web-api.md)。

| 能力 | 精确 API / 机制 | 能做什么及边界 |
|---|---|---|
| 现有搜索接缝 | `ctx.web.registerSearchProvider(provider)` | 标准 `{content?,sources,truncated}` 可返回已整理内容，但 request 只有单 query/maxResults。 |
| 自有工具 | `ctx.tools.register(definition)`；`execute(args, exec)` | 一次接收整个问题，掌控多 query 总整合；`exec` 带 agent/callId/signal。 |
| 工具输出 | `output.schema/render/presentationMeta` | 富结构 value 经 schema 校验，render 只暴露精炼信息；直接模型调用的 meta 可保留引用/审计指针。不能假设 value 自动落 session。 |
| 同名入口 | scoped 工具遮蔽全局；同一层重复注册会失败 | 工具名并不绑定宿主 schema；完整替换同名工具时可以定义自己的 output。preset 中已有 scoped 同名工具时需要替换原工具行，不能再叠加同层注册。 |
| 整合模型 | `ctx.llm.stream(options)` | 明确指定已注册 provider/model，可与主模型不同；无需启动子 agent。 |
| 取消 | 工具 `exec.signal` → 网络请求/LLM signal | 需插件逐层传递，自设总 deadline、单源 deadline、有限重试并在卸载时清理。 |
| 密钥 | `ctx.credentials.resolve(ref)` / `readRecord(key)` | Config 仅存引用，按操作重新读取，不能写死或在日志中保存密钥。 |
| 配置 | plugin `Config` schema、volatile 引用 | 模型路线、来源开关、输出上限和预算；已安装 Settings README 只明确保证 volatile 字段表单编辑，UI 投影需实现时验证。 |
| 因果归因 | `ctx.agents.currentInitiator()` | provider 没显式 agent 时可辅助日志归因；不等于授权/存活校验。自有工具优先用 exec.agent。 |
| 保存材料 | `ctx.attachments.saveFile/readFileStream` 或 `ctx.spillStore.saveText` | 可保存完整输入、筛选记录与引文，作为审计附件/产物；需检查当前 backend 可用性与 session 引用，不能只留进程内 map。 |

## 2. 两条实现路径

### A. 只注册聚合 provider

流程：原 `web_search` → `ctx.web.search()` → 聚合 provider → 原工具渲染。

优点：接入薄，原工具卡片/调用入口保留；单 query 下可输出精炼整合文本。

限制：

- 宿主 `web.searchProvider` 明确指定选路；注册新 provider 不会自动切换。修改组合配置由用户落到 flake/patch，本轮不修改。
- 原工具对 `queries[]` 并行调用**多个**单 query provider，再把各 content 拼接；它没有对整个结果集进行统一事实合并的第二阶段。
- `ctx.web.search()` 不支持按 id 调用其他 provider；聚合器不能借此复用既有搜索插件，必须实现自己的外部适配器，避免递归。
- 原输出 schema/presentationMeta 不保留自定义内部审计。可以显式保存材料、把引用放标准文本，但不能指望多返回字段就自动落库。
- 原工具来源 cap 可能丢出处，content 不会同步重写；必须在整合前选定最终来源集合，引用用稳定 sourceId/URL，不依赖临时列表序号。

结论：适合最薄概念验证，不是完整需求的最佳接口。

### B. 自有「搜索整合工具」（推荐）

工具内部流程：问题/queries → 预算与查询规划 → 多源检索 → 去重与适用性筛选 → 重点正文 → Flash 判断/事实合并 → 可选一次补搜 → 全局整合 → 引用验证 → 精炼结果。

可以先用独立工具名（最终命名待定），不与原工具冲突；再在指定 preset 中替换原 `web_search`，保留用户熟悉的名字。**名称不决定 schema，自己的 ToolDefinition 可以定义富结构。**

处理所有 query 后再执行一次统一整合，避免原工具的拼接与来源二次丢弃；自定义 render 输出结论、限制、未知项和紧凑出处，不把所有原始材料喂给主 AI。

不建议通过全局 `tools/post-execute` 改写任意搜索结果来实现：那是共享 waterfall，耦合其他插件且还容易让原始 schema/UI/审计与渲染内容不同步。插件直接拥有自己的执行与输出边界更清楚。

## 3. 实现中不可忽略的限制

### 模型返回不等于成功

`ctx.llm.stream()` 的适配器错误可以通过末尾 `finish.kind=error/aborted` 返回，而不 throw。整合器必须检查终态、输出是否截断、JSON schema 与引用集合，不能只拿已生成文本当成功。

`GenerateOptions` 没有通用 `response_format/tool_choice`；用 prompt 约束 + JSON 校验 + 有限修复起步。`stream()` 本身不是完整 AgentLoop，不自动提供循环规划、会话落库、重试、账单统计。`usage` 可采集，但费用计算要依赖实际供应商定价，不能默认包含在主模型显示账单里。

### 审计不必挤进主 AI 上下文

AgentLoop 发布代码 `appendToolResult` 明确只记录 `result.content` 和 `result.meta`，没有持久保存 `result.value`。整合模型的每次实际输入/输出需自己保存，可用附件/会话归属产物，最终工具结果保存审计引用；这样能追踪插件为何丢弃材料，又不把原文默认塞给主 AI。

`presentationMeta` 在 PTC 子调用下不是完整持久化保证，且不是自动 UI 页面。通用审计方案应独立保存 artifact，并确保 native/PTC 返回都携带可取回指针；落库和崩溃恢复需要测试。避免追加未知自定义 session event type。

### 内容可能在下游被裁剪

已安装标准组合的 tool-result-pruner 配置含 **8192 字符**上限；这不是 web provider 字段限制，也不是所有 profile 的通用固定值。大的工具结果还可能 spill。应主动预算、让摘要及关键限定在前、紧凑出处易定位；不能把整份大 JSON 当模型默认输出，也不能把信息丰富度等同字数。

### 失败时不能悄悄把研究工作退回主 AI

若单源失败，插件可用其他材料继续整合并说明覆盖缺口；若整合模型不可用，允许有限备用路线。若仍无法整理，应明确「未完成整合」/返回受限结果，而不是把几十条原始候选伪装成正常最终信息包。降级语义是产品设计的一部分。

### 长任务

原 web 工具默认 30s，部分默认组合为 60s。自有工具可以声明 `timeoutMs`；内部必须在外层 deadline 前完成或取消。90s 等数值只能作为起始预算，不是已测需求。一次搜索任务的所有供应商与整合调用共享总预算。

## 4. 工程拆分（建议，未创建代码）

```text
packages/search-integrator/
  src/index.ts          Cordis注册、Config、生命周期
  src/tool.ts           整个任务的输入/输出/取消/审计边界
  src/pipeline.ts       限定次数的检索→处理→补搜→总整合
  src/providers/        智谱/Exa或Tavily等适配器
  src/evidence.ts       URL、日期版本、近重复及主张合并
  src/integrate.ts      Flash请求、终态、schema和引用校验
  src/render.ts         主AI看到的精炼结果
  src/audit.ts          原始材料/整合输入输出与引用保存
```

不必一开始启动子 agent：规划/筛选/整合的少量模型调用加确定性流程即可。未来任务确实需要长时间研究、多次自主调用时再考虑 agent/service，不把简单功能先变成完整 agent 编排系统。

## 5. 难度判断

主观工程难度，5 为最难，不是实测工时：

| 部分 | 难度 | 主要原因 |
|---|---:|---|
| Cordis bundle / 工具注册 / Config | 2/5 | 本仓库已有工具与 judge 调用样例，官方接口够用。 |
| 两源适配、并发、超时与限次补搜 | 3/5 | 普通网络编排，但供应商能力、失败与计费口径不同。 |
| 文本整合与严格引用校验 | 3/5 | 模型调用容易，终态/JSON/来源引用正确性需工程校验。 |
| 去重不丢限定、版本与反证 | 4/5 | 语义近似不等于事实相同，转载谱系不总可判定。 |
| 审计、native/PTC、恢复与限流 | 3–4/5 | 不能假设value与辅助模型请求自动记录，需跨场景测试。 |
| 证明主AI真的少工作而不损准确率 | 4–5/5 | 需要标注集、人工引用核验和端到端对照，非改prompt即可保证。 |

**总体：有用 MVP 中等难度；可靠长期使用版中高难度。瓶颈在整合质量与验证，不在 DSH API。**

第一闭环限定为：两个纯检索源、一个整合模型、一次可选补搜、精炼信息与引用、审计产物、取消与失败测试。通过后再增加更多源、复杂转载识别和 UI。调研尚不足以承诺具体日程；开发工作量主要受网页提取覆盖、质量阈值与恢复要求影响。

## 6. 验证清单

- 直接注册自有工具，检查实际 model-facing schema、超时与输出；native/PTC 均测试。
- 多 query 的同一事实跨源只出现一次，引用集合在渲染与持久化后保持一致。
- 旧版本、矛盾数值、否定表述和少数反证不会被相似度错误删掉。
- 单源失败/整合失败/空结果/取消/429/超时可预期，调用与费用有界。
- 小模型报错终态、max-tokens和虚构sourceId全部被拒绝或明确标注未整合。
- 主AI默认不读审计原文；人工或后续工具仍能按artifact引用取回。
- 相同主模型与提示对比普通搜索，统计后续搜索次数、主AI输入token、遗漏/错误事实、引用支持率与P95延迟。

## 7. 本地一手依据

所有安装路径均由 Config Inspect 得出；以下用包相对路径表示（便于不同安装位置复核）：

- `@deepseek-ai/dsh-tool-web/lib/index.js:189–240`：`runSearchQueries/mergeSearchResults`；255–317：工具注册与输出。
- `@deepseek-ai/dsh-tools`：Host `Service.listService(service=tools)` 的实时 ToolDefinition / ToolOutputDefinition 契约，工具作用域与重复注册语义。
- `@deepseek-ai/dsh-llm/README.md:30–74,112–119,157–162`；`lib/index.js:2203–2234,2283–2386`：prepareCall/stream/finish/无自动日志与重试。
- `@deepseek-ai/dsh-agent-loop/lib/index.js:691–706`：appendToolResult 持久字段。
- Host `Service.listService(service=credentials/agents/attachments/spillStore/settings)`：逐项实时契约。
- `@deepseek-ai/dsh-settings/README.md:26–39`：配置/volatile 表单边界。
- 本仓库 `packages/auto-permit/src/judge.ts` 与 `settings.ts`：现有辅助 judge 与 volatile 配置的可参考模式（不是搜索整合的完整实现）。

后续实现仍需类型检查、构建与真实工具链验证；只读 API/源码可行性不等于插件已经运行成功。
