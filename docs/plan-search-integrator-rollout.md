# 搜索聚合插件（dsh-search-integrator）接线与验证计划

日期：2026-10-11。实现已完成并全部通过单测（50 项 fake provider + fake LLM）与
`pnpm check`；尚未做真实供应商调用与 profile 安装验证。已定：**源 = 智谱 + Exa，
整合 = DeepSeek 公共 API（deepseek-official / deepseek-chat），先走 dev overlay**。
本文给出接线步骤与待验证清单，按仓库宿主边界：**`dsh plugin add`、flake 修改、
密钥配置由用户执行**。

## 0. 交付物

- `packages/search-integrator/`：host-only bundle，无浏览器半插件。
  - 工具 `web_research`（行配置 `toolName` 可改，非 volatile）：
    输入整个 `question`（可选 `queries` 1–4），返回
    `{status, summary, points[{text,status,sources}], unknowns, sources, coverage, audit?}`。
  - `status`：`ok`（整合成功；单源缺口记入 coverage.failed）／`degraded`
    （整合模型不可用或失败，返回**显式标注**“未整合”的去重摘要，绝不当正常结果）／
    `failed`（无可用源/无结果/预算耗尽等，summary 说明原因）。
  - 检索源适配器：智谱（独立 web_search API）、Tavily、Exa；均 volatile 开关 + 凭据引用。
  - 整合模型：`ctx.llm.stream`（规划 + 整合两次小调用），严格终态检查
    （`stop` 才算成功；`max-tokens`/`aborted` 立即失败；`error` 允许一次重试；
    JSON 解析失败允许一次修复回灌）。虚构引用编号被剥离并在渲染中标注
    `citation check failed`。
  - 预算：`timeoutMs`（默认 120s，注册期）/ `totalBudgetMs`（默认 110s，运行期）共享
    deadline，全部网络与模型调用消费 `exec.signal`；补搜轮只在剩余预算 >25s 时运行。
  - 审计：完整轮次记录（queries、原始 hits、digest、模型原始输出、usage、settings 快照）
    经 `ctx.spillStore.saveText` 落 session 归属产物，结果只带回 locator + retrievalHint。
    spill 后端缺失/无 session/写入失败均降级为无审计，不影响研究结果。
  - 渲染：结论 → 要点（带 `[n]` 引用与证据标签）→ 未知项 → 来源 → coverage/审计脚注，
    预算默认 7000 字符（下游 tool-result-pruner ~8k）。

## 1. 开发 overlay 验证（不安装）

```sh
pnpm build
dsh --profile web --patch $PWD/packages/search-integrator/dev.patch.yml --no-open --port <端口>
```

Web 端检查项：

1. 设置页出现 `search-integrator` 分区（namespace = 行 id），volatile 字段可热编辑。
2. 未配置任何源时，模型调用 `web_research` 得到 `status:"failed"`、summary 含
   `no search sources available`（而不是工具崩溃）。
3. 打开任一源（见 §2）+ §3 整合路线后，真实问题走通 ok 路径。

## 2. 检索源与凭据（已定：智谱 + Exa）

默认即 `zhipuEnabled: true` + `exaEnabled: true`（tavily 关闭，随时可开）。每个源一个
**凭据引用**（环境变量名，`ctx.credentials` 分层解析：进程 env → provider store → `.env`）：

| 源 | 默认引用 | 说明 |
|---|---|---|
| zhipu | `ZHIPU_API_KEY` | **默认 transport `mcp`**：官方 MCP broker（`open.bigmodel.cn/api/mcp-broker/proxy/web-search/mcp`），走 GLM Coding Plan 的 MCP 额度，key 就是 Coding Plan key |
| zhipu（rest 可选） | 同上 | `zhipuTransport: 'rest'` 切开放平台按次计费 `POST /api/paas/v4/web_search`（0.01 元/次起，需开放平台 key） |
| exa | `EXA_API_KEY` | contents text 上限 = 2×excerptChars |
| tavily | `TAVILY_API_KEY` | 默认开启；`search_depth` 可选；本机偶发直连抖动会被 per-request timeout 截断记入 coverage.failed |
| brave（可选） | `BRAVE_API_KEY` | 独立索引 SERP（GET /res/v1/web/search，X-Subscription-Token，~$5/1k）；需办 key |
| openai（可选，platform） | `OPENAI_API_KEY` | Responses `web_search` 工具（$10/1k 搜索调用 + 模型 token，最贵）；**只取被引用/被检索的 URL，丢弃生成正文**；需办 key |
| chatgpt（可选，订阅） | 无需 key | **复用 oauth-providers 的 ChatGPT 订阅 OAuth**（`ctx.oauthProviders.token('chatgpt')`，自动刷新）打 Codex 后端 `web_search`（实测支持：open_page action + url_citation）；消耗订阅额度，默认关，Settings 开 `chatgptEnabled` 即用；生成型源较慢（~20s），per-request 截止自动放大 4 倍 |
| ~~deepseek~~ | — | **不可行**：DeepSeek 公共 API 无搜索端点（Responses 兼容层 `web_search` 官方标注 Ignored），无 citation/URL 字段；详见 docs/research-multisource-model-search.md |

**本机 nix 现状**（`~/.config/nixos/home/ai/dsh/secrets.nix` 的 envMap，经
agenix → `dsh-secrets.service` → `dsh-web.service` EnvironmentFile 注入）：
`ZHIPU_API_KEY`（Coding Plan）、`EXA_API_KEY`、`TAVILY_API_KEY`、
`DEEPSEEK_API_KEY` 全部已配好——**nix 零改动**。

**2026-10-12 已做真实验证**（`scripts/smoke-research.mjs`，key 从 agenix 注入
进程 env，值不落日志）：

- 智谱 MCP：Coding Plan 专属端点 `https://open.bigmodel.cn/api/mcp/web_search_prime/mcp`、
  工具 `webSearchPrime`（1.2 积分/次，套餐额度）。注意 **不是**
  `mcp-broker/proxy/web-search/mcp`——那是开放平台按量余额入口，Coding Plan key
  调它报"账户已欠费"。webSearchPrime 的 text 为**双重 JSON 编码的裸数组**
  （无 publish_date），解析已兼容并固化单测。
- Exa：正常，5 hits，带日期。
- 整合 deepseek-flash：**思考型模型**，max_tokens 2048 会被思考吃光
  （finish_reason=length）——默认已调 8192。
- 全链路（zhipu+exa+整合+补搜）：status ok，双源 57 hits → 14 证据，
  planner 3 queries + followup 2 queries（rounds=2），conflict/insufficient
  标签与 unknowns 质量达标，耗时 ~47s（预算 110s 内）。

隐私边界：供应商只收到 query 文本，不含会话、代码与秘密。

## 3. 整合模型路线（已定：DeepSeek 公共 API）

默认 `integratorProvider: 'deepseek-official'` + `integratorModel: 'deepseek-flash'`
（对齐本机 auto-permit 的廉价模型搭配；route id 与模型 id 均经本机配置核实）。
前提：`DEEPSEEK_API_KEY` 已在 nix envMap 配好。两字段均 volatile，改模型不重挂。

## 4. 固化接线（本机模式：nix plugins 行，不用 `dsh plugin add`）

本机 dsh 由 `modules/home/dsh.nix` 声明式组合（systemd `dsh-web` 服务，3080）。
固化即往 `~/.config/nixos/home/ai/dsh/plugins.nix` 的 `programs.dsh.plugins` 加一行
（与其余 dsh-extensions 插件同模式，先 `pnpm build`）：

```nix
{
  id = "search-integrator";
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/search-integrator/lib/index.js";
  # 全部走默认：zhipu(mcp)+exa 开、tavily 关、deepseek-official/deepseek-flash

}
```

rebuild + switch 后 `dsh-web` 服务自动带新层重启，直接在 3080 GUI 验证。
注意：`dsh-secrets.service` 是 oneshot（Requires=agenix），新 envMap 条目在
switch 后需确认 `systemctl --user restart dsh-secrets dsh-web` 生效。
行 id `search-integrator` 与本包 dev.patch.yml 相同——固化后不要再叠加
dev overlay（同 id insert 会冲突），验证期二选一。

## 4.5 2026-10-12 质量迭代（prompt v2 + 正文抓取 + 反证保护）

基于宿主真实运行的实证改进：

- **prompt v2**（dsh-search-integrator-v2）：summary ≤80 词且首句给证据截止日
  （消 summary/points 冗余）；conflict 点必须按口径分组引用
  （"[8]称6710亿；[9]称284B"式，不再平铺）；followup 纪律——目标物可能不存在
  或需官方一手材料时不补搜、进 unknowns（Svelte 6 案例曾浪费一轮）。
- **正文抓取**（fetchTopN=2）：top 排名且 provider 内容 <600 字符的源做一次
  best-effort 页面抓取（HTML→文本，512KB 上限，失败静默保留 snippet）。
- **反证保护**：evidence cap 后重纳最多一条"已选集合未覆盖域名"的被截断源
  （实测 evidenceCount 14+1=15 生效）。
- **digest 公平份额**：每源摘录先按 budget/count 保底，防单一长摘录把后续
  源挤成 URL-only。

## 4.6 2026-10-12 v3：外部审查驱动的规则修正

按"规则修正 → 输入补齐 → 校验补强"顺序落地（非单纯 prompt 加长）：

- **取消总括 cutoff**：不再让模型生成"证据截止日期"；digest 头部程序化提供
  *Retrieval context*（检索时间/本轮查询/失败源/摘录类型与截断状态），明确标注
  检索时间≠内容新鲜度；每源日期缺失标 `date unknown`；summary 首句直接回答。
- **补搜规则反转**：不再禁止"目标可能不存在"的补搜；改为"有明确目标且可能
  改变答案才补搜，优先可识别一手来源（release notes/模型目录），不重复查询"；
  并明确"没搜到≠不存在，除非明确否认或穷尽性一手目录"。实测 round2 查询即
  "DeepSeek 官方 release notes api-docs.deepseek.com"式一手来源定向。
- **supported 重定义**：引文内容明确支持（含版本/日期/地区/单位限定），
  一个直接适用的官方文档可足够，十篇转载仍是一个来源；digest `via` 双入口
  在 prompt 中明确非独立佐证。insufficient=仅标题/URL/模糊片段。
- **校验补强（代码非 prompt）**：无有效引用的点不再保留——转入 unknowns
  （"Unverified claim dropped…"可见）；point 文本与 summary 中的 `[n]` 伪引用
  程序化清除；conflict 点支持结构化 `sides[]`（每侧独立编号、程序校验）；
  关键数字/日期可附 `quote`（≤120 字符原文，仅入审计不上屏）。
- **证据层失真修正**：syndication 合并从"标题+前 160 字符"收紧为完整
  title+snippet 相等；URL 去重键**保留 fragment**（SPA 路由不同页）；
  "反证保护"更名为域名多样性启发式（不再宣称已保护反证）。
- **预算架构**：正文抓取获得独立 per-request 截止；**补搜轮排除生成型源**
  （chatgpt/openai——单次可合法耗时数十秒，剩余预算养不起第二轮）；默认
  totalBudgetMs 125s / timeoutMs 140s（实测最坏 ~117s）。
- **测试**：89 项（新增空引用转 unknowns、伪引用清理、sides 校验、
  完整 snippet 反例合并、fragment 区分、URL-only、检索上下文注入等结构用例）。
  审查清单中的语义场景（假冲突、有效编号引用不支持内容、summary 比 points
  更肯定）**无法程序判定**，依赖 prompt v3 规则与真实使用观察。

## 5. 尚未验证（诚实清单）

1. **真实供应商**：三家适配器均未用真实 key 调过；响应字段防御性解析已测，
   但字段语义/计费口径需首跑核对（每次最小请求并记录费用/延迟）。
2. **settings 表单投影**：volatile 表单编辑按 dsh-settings 0.2 模型应当可用，
   未在真实 Web UI 里逐字段验证。
3. **PTC（run_code 子调用）**：`presentationMeta` 在 PTC 下不投影（已知平台行为）；
   审计 pointer 走渲染文本，但其是否随父结果持久化**未实测**——需要一次 PTC 场景验证，
   不行则需另找受支持的落点。
4. **preset 替换 `web_search`**：当前为独立工具名，不动原工具。若后续要在目标
   agent preset 里替换 `web_search`，须禁用/替换原 `tool-web` 行（同层同名会失败），
   并保留 preset 其他贡献；这是独立变更，不在本层。
5. **质量对照**：固定主模型与提示，对比普通 `web_search`，统计后续搜索次数、
   输入 token、重要信息遗漏、无依据事实、引用支持率、成本与 P95 延迟。
   （首跑基线：全链路 ~47s，其中整合思考占大头；zhipu 源 ~2s/查询、exa ~0.5-2s/查询。）
6. **模型路由层**：smoke 的整合腿直连 DeepSeek 公共 API；宿主 `ctx.llm.stream`
   封装（BlockAssembler/finish 检查）已有单测，但经 dsh-web 真实工具调用的
   render/output-schema/assertSupportedJsonSchema 全链路还需在 Web UI 里点一次。

## 6. 回退

- overlay：重启不带 `--patch` 即消失。
- bundle：`dsh plugin --profile <profile> remove dsh-search-integrator`（用户执行）。
- 行配置 `enabled: false`（Settings 编辑即重挂）可直接下线工具。
