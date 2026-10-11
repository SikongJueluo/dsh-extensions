# 调研：DSH 多源搜索插件的宿主侧 API 事实（ctx.web 接缝 / web_search 工具 / 配置隔离）

> 结论先行（只回答宿主 API 与接线问题，不做供应商选型）：
>
> 1. `ctx.web.registerSearchProvider(provider)` 能注册 provider，返回契约是 `{ content?, sources[], truncated }`；
>    但注册进去的是**宿主唯一的 web 服务实例**，其 `searchProvider` 是**单值**。多注册一个 provider
>    **不改变路由**（只会让「未配置 id」时变成 `WEB_PROVIDER_AMBIGUOUS`），要换必须改 `web` 行。
> 2. **同入口与结构化审计可以兼得。** 工具名不绑定 output schema：只要**自己注册**一个名为 `web_search`
>    的 `ToolDefinition`（scope 遮蔽全局，或禁用原行后注册），`output.schema` / `render` /
>    `presentationMeta` 全部由自己定义。原 schema 的封闭性（`additionalProperties: false` 等）
>    只是 `dsh-tool-web` 自己声明的，不是平台约束；它只在「保留原定义、单换 provider」时才是天花板。
> 3. `content` 会被保留：seam 截断只 `slice` `sources`，`content` 原样透传（`dsh-web/lib/index.js:134`）
>    并被渲染进模型可见文本（`dsh-tool-web/lib/index.js:64`）。但**随包唯一的搜索 provider 恒不返回 content**
>    （`mapAnthropicResponse` 只 `return { sources, truncated: false }`），所以这条路今天拿不到 provider 摘要。
> 4. 截断的引用不匹配风险**在语义层、不在渲染层**：`content` 是 provider 基于它自己完整 sources 生成的，
>    之后 seam/工具丢尾部来源却不重写散文；多查询合并还会二次丢弃来源且不上报被丢的 URL。
> 5. `multi queries` **并行**（`Promise.allSettled`，默认上限 4），已有「合并去重」雏形但**无事实核验**。
>    注意原工具失败语义是**全有或全无**。
> 6. 持久化只写 `result.content` + `result.meta`，**`result.value` 不落库**；`meta` 只来自
>    `output.presentationMeta`，**且只在模型直接调用（`exec.parent === void 0`）时投影**。
>    → PTC / `run_code` 子调用路径的审计信息必须另找落点，且**不能用自定义 session 事件**
>    （官方实践禁止新增 event type，§6）；改用持久产物 + 可回取指针。

- 调研对象：DSH `0.2.0-rc.2`（本机 nix store 安装）。**只做只读调研：未写插件代码、未改 profile /
  `$DSH_HOME`、未做任何 VCS 操作。**
- 方法：`cordis_inspect_list` → Host `Config.listConfigs` 取 `packageDir` → 读该目录
  `README.md` / `lib/types/*.d.ts` / `lib/index.js`，不猜路径。
- 下称 `$DSH = /nix/store/0z3j9r5hc9vq2ifb29kcrbbxf4m2ik5q-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`，
  `$BASE = …/@deepseek-ai/dsh`。行号指各包已发布 `lib/`，以**符号名**为准、行号仅供定位。

## 1. 核心 API 签名

```ts
// $DSH/dsh-web/lib/types/index.d.ts:42-91
class WebRuntime extends Service {
  static Config: z<WebRuntimeConfig>            // { searchProvider?: string; fetchProvider?: string }
  registerSearchProvider(provider: WebSearchProvider): () => void      // 返回 disposer
  registerFetchProvider(provider: WebFetchProvider): () => void
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
}

// $DSH/dsh-web/lib/types/types.d.ts:14-52
interface WebSearchRequest { readonly query: string; readonly maxResults?: number }
interface WebSearchResult {
  readonly content?: string          // provider 生成的答案/摘要，可选（"Exa 与 DeepSeek 不返回"）
  readonly sources: readonly WebSearchSource[]   // 已按 maxResults 截断
  readonly truncated: boolean        // seam 因 maxResults 丢过来源
}
interface WebSearchSource { url: string; title?: string; snippet?: string; publishedAt?: string }
interface WebSearchProvider {
  readonly id: string
  available(): boolean               // 廉价本地检查，禁止网络
  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
}
```

- **无**「按 id 调用某个 provider」的公共方法、**无**枚举方法、**无**变更事件（README 把「无观测面」列为已知限制）。
- id 重复 → `WEB_DUPLICATE_PROVIDER`。选路**每次调用**解析（`dsh-web/lib/index.js:112`）：
  配了 id 就必须已注册且 `available()`，否则 `WEB_PROVIDER_CONFIGURED_MISSING` /
  `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`；没配 id 时恰好一个可用者才跑，多个 → `WEB_PROVIDER_AMBIGUOUS`。
- `maxResults` 是**来源数上界**，不是内容长度上界。截断实现（`dsh-web/lib/index.js:134`）：

```js
function capSources(result, maxResults) {
  if (maxResults === void 0 || result.sources.length <= maxResults) return result
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true }  // content 原样带过
}
```

→ 截断后**没有任何渠道**告知 provider/调用方「哪些 URL 被丢了」。

## 2. 工具层现状（`$DSH/dsh-tool-web`）

| 项 | 值 | 位置 |
|---|---|---|
| 模型可见参数 | `{ queries: string[] }`（`1–${maxQueries}`，"their results are merged"） | `lib/index.js:262-270` |
| output schema | `{ content?, sources[], truncated }`，**`additionalProperties: false`** | `lib/index.js:272-296` |
| render / meta | `formatSearchOutput` / `searchMetaFromValue` → `{ sources, truncated, answer? }` | `lib/index.js:298, 118` |
| 提示段名 | `tool:web_search`（= 可被遮蔽的 key） | `lib/index.js:256` |
| inject | `["tools","web","systemPrompt"]` | `lib/index.js:832` |
| 默认配置 | `searchMaxResults=8`、`searchMaxQueries=4`、`searchTimeoutMs=30000`、`fetchMaxOutputChars=200000` | `lib/index.js:845` |

**关键**：上面这套 schema 与逐字段 `searchMetaFromValue` 都是**该包自己的实现**，
不是平台强加给 `web_search` 这个名字的；自己注册同名工具即完全绕开（§5）。

**content 保留链**：`formatSearchOutput`（`lib/index.js:62`）拼装
`外部内容警示 → content(:64) → Sources: 列表(:74) → 截断脚注 → 引用指令`，函数内**无任何裁剪**；
多查询时按查询加 `### ${query}` 标题（`:232-235`）；`execute` 原样返回三字段（`:307`）。
`presentationMeta` 里字段名是 `answer`，不是 `content`。

**但今天的 provider 不产生 content**：`mapAnthropicResponse`（`dsh-web-search-deepseek/lib/index.js:59-81`）
只 `return { sources, truncated: false }`；seam 类型注释写明「Exa 与 DeepSeek 不返回，Perplexity 返回生成的答案」
（`dsh-web/lib/types/types.d.ts:26-28`）。→ **content 是现成且被完整保留的载体，但只能由新 provider/工具自己填。**

## 3. 截断导致的引用不匹配（语义层，非渲染层）

- **seam 截断**（`dsh-web/lib/index.js:134`）：`content` 已在 provider 内生成完，此时才 slice 尾部 sources
  → content 的散文/编号可能引用**已丢弃的 URL**，模型无法察觉。
- **工具合并**（`dsh-tool-web/lib/index.js:215-241`）：round-robin 取同 rank，`seen` 去重，累计到
  `maxResults` 即 `droppedSource = true` 并 `break merge`(:226) → 被丢的 source 彻底消失，
  `truncated` 只置位、不含「丢了哪个 URL」。
- **渲染层不错位**：`formatSearchOutput` 的列表与脚注都基于**截断后**的 sources，编号不会对错；
  `(Showing the first N sources…)` 仅在 truncated 时出现。

→ 必然要求：**「哪条事实由哪个 URL 支撑」要固化在 `content` 文本或 `meta` 里，不要指望 `sources`
数组表达**（它会经 `maxResults` 与下游 pruner 两次裁剪）。

## 4. multi queries：并行，且失败是全有或全无

`runSearchQueries`（`dsh-tool-web/lib/index.js:189-213`）：`queries.map` 并行 fan-out（`:198`），
共享一个 `AbortSignal.any` 派生信号；`await Promise.allSettled(searches)`（`:210`）后，
若有任一失败则 `throw firstFailure.error`（`:211`）—— **abort 兄弟、丢弃已成功的结果，只报第一个错误**。

- 入口校验 `parseSearchArgs`（`:33`）：非空 → 上限 → 去空白后为空报错 → 末了 `[...new Set]` 去重。
- 每个子查询各自拿满 `maxResults`，候选池是 `queries × maxResults`，最终砍到 `maxResults`
  —— **多源丰富度会被这个 8 条上限吃掉大半**。
- README:251：provider 内部还可能自搜多轮（`maxUses`），`searchMaxQueries × maxUses` 才是原生搜索次数上界。

→ 「总整合」在工具层已有合并骨架，缺的正是**事实核验、冲突标注、按问题的证据编排**。

## 5. 同入口 + 自有 schema：三平面与遮蔽规则

### 5.1 当前接线

- 宿主 bundle `dsh-base/cordis.patch.yml:472-490`：`web` 行 `searchProvider: deepseek-official`、
  `web-search-deepseek` 行、`tool-web` 行（`searchTimeoutMs: 60000`）。
- `dsh-web-app/cordis.patch.yml:555` **禁用宿主的 `tool-web` 行**，注释说明工具改按 agent preset 组合。
- 本机 `~/.dsh/profiles/web`：bundles = `dsh-base` + `dsh-web-app` + `dsh-experimental-schedule-bundle`，
  其 `cordis.patch.yml`（21 行）**完全没碰 web**。本 session `Config.listConfigs`：`include:tool-web` = `inactive`。
- → **`web` 服务与 `searchProvider` 在宿主平面；`web_search` 工具在 preset 平面。**

### 5.2 可见性规则

| 对象 | 归属 | 规则 |
|---|---|---|
| 服务 `ctx.web` | 宿主平面 | 按 isolate 键解析（`cordis/lib/index.js:800-824`）。preset 挂载 `createScope(this.owner, key)`（`dsh-agent-preset-registry/lib/index.js:527`）**继承 owner 的 isolate 映射**，preset 无 `isolate:{web:true}`，故解析到宿主同一实例 |
| 工具 `web_search` | preset 平面 | 注册表按作用域分层：**Scoped tools shadow globals；同层内重复或 `run_code` 保留名报错**（`dsh-tools/lib/types/index.d.ts:634`；实现 `dsh-tools/lib/index.js:2634,2878`）。preset 作用域键是 agent 作用域的父键（`dsh-agent-preset-registry/lib/index.js:677`）→ preset 的工具作为**祖先贡献**对旗下每个 agent 可见 |
| 提示段 `tool:web_search` | 同工具 | `systemPrompt.section` 也是「scoped 遮蔽同名 global；同层重复报错」（`dsh-system-prompt/lib/types/index.d.ts:232-239`，`lib/index.js:190`） |

### 5.3 结论

- **能保持工具入口且不受原 schema 限制**：自己注册
  `ToolDefinition{ name:'web_search', output:{ schema, render, presentationMeta } }`，
  在 preset 里把原 `tool-web` 行 disable（或整行替换），同层只有一份注册即合法。
  提示段也用 `tool:web_search` 这个名字注册以替换文案；只覆盖走 preset 的 agent
  （headless 等宿主平面组合不受影响，全局 `web_search` 仍在）。
- **「按 agent 不能换 provider」限定的是共享 `ctx.web` 的 config，不是你的路由能力。**
  `searchProvider` 是 `WebRuntime` 的单值构造参数（`dsh-web/lib/index.js:57`），服务宿主唯一，
  preset 改不了它。但**自有工具完全可按调用参数 / 自身配置路由上游**
  （`WebSearchRequest` 承载不了模式参数，所以模式走自己的工具参数或行 config）。

## 6. 持久化与审计：`content` + `meta`，且 PTC 路径没有 meta

`appendToolResult`（`dsh-agent-loop/lib/index.js:691-706`）只写
`createToolResultMessage({ callId, content, isError })` + `meta?`；而
`createToolResultMessage`（`dsh-llm/lib/index.js:101-112`）**不吃 `value`** ——
即 **`result.value` 不落库**。事件载荷（`dsh-session/lib/types/types.d.ts:374-388`）
= `{ turn, step, message, error?, meta?: JsonValue }`，所以 **`meta` 是唯一的结构化通道**。

`meta` 只来自 `presentationMeta`，且调用点带条件（`dsh-tools/lib/index.js:3554-3562`）：

```js
if (exec.parent === void 0 && tool.output.presentationMeta !== void 0) {   // 只在顶层 dispatch
  projected = tool.output.presentationMeta(exec.arguments, value)
  meta = snapshotProjection(tool.name, "presentationMeta", projected)
}
```

→ **模型直接调用会持久化 `meta`；PTC `run_code` 子调用（`exec.parent !== void 0`）不投影 → 无 meta。**

**⚠️ 不要用自定义 session 事件补这个缺口。** 官方插件实践明确禁止：
*"Do not append session events with a new `type`. Readers accept an unknown stored event only when its
envelope carries `ignorable: true`, and live `Session.append()` cannot set that marker, so the Session
would refuse to reopen. Derive state from existing events, or keep plugin-owned data in a storage service
found through inspection."*
（`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:21`）
类型增补（`declare module` 扩 `SessionEventMap`）**只让编译通过，不代表旧 reader/runtime 兼容**。
随包 provider 的 `web/deepseek-search-llm-request` 是**宿主自身读写两侧一起发布**的，不构成第三方插件可照抄的先例。

**正确做法**：完整审计落持久产物（attachments / spill 产物 / 经 inspection 找到的 storage service），
结果里返回**可持久取回的指针**（如 spill locator）。
- **模型直接调用**：指针进 `content` 或 `meta`，随 session log 持久化。
- **PTC 路径**：**需实测**该指针是否随父结果一并保存（`meta` 侧已确定不投影，`content` 侧行为未验证）。
  **若不能保证，就必须另找已受支持的日志机制 —— 本文未确认存在这样的机制，不要承诺自动兼容。**

**自注册 schema 的真实约束**（平台级，仍要遵守）：`assertSupportedJsonSchema`
（`dsh-tools/lib/index.js:323,2879`）只接受
`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const` + 注记
（`:200`）；**`$defs` / `$ref` / `anyOf` 都不在子集内**（别想用 `$ref` 复用 seam 类型）。
违反或值不合 schema → `ToolOutputError(..., "INVALID_TOOL_OUTPUT")`（`:2552-2559`）；
值在渲染前被深冻结（`:3544,3561`），「先返回再挂字段」不可行。

## 7. provider 数量的核查边界（自我更正）

- 静态事实：**随包发布的**搜索 provider 只有 `dsh-web-search-deepseek` 一个（`ls $DSH/dsh-web-search-*`）；
  Config 树里在挂的条目也只有 `include:web-search-deepseek`。
- **但这是「已安装 / 已在挂」的证据，不是「live registry 只有一个可用 provider」的结论**：
  任何插件都能在运行期调用 `registerSearchProvider` 注册而不出现在 Config 树里。
- 运行期推断有严格前提：**只有在「未配置 `configuredId`」时**，一次调用正常返回才能推出
  「可用 provider 恰好一个」（多个可用者会 `WEB_PROVIDER_AMBIGUOUS`）。
  **当前组合固定了 `searchProvider: deepseek-official`，此时正常返回只证明该 id 可用，
  完全不能证明没有其他可用 provider。** 本文**未做该实测**。

## 8. 明确建议

1. **做自有工具（preset 平面）。名字二选一，都能带完整审计 meta**：
   用 `web_search` 遮蔽 → 入口体验不变，代价是需在 preset 里禁用原 `tool-web` 行；
   或用新名（如 `web_search_deep`）→ 不动原行、回退简单，代价是模型多一个工具名 + 需写引导。推荐后者先落地。
2. **审计落持久产物 + 回取指针，不要新造 session 事件**：
   模型直接调用把指针放 `content`/`meta`（随 session log 持久化）；PTC 路径需**先实测指针是否随父结果保存**，
   测不出来就另找已受支持的日志机制（本文未确认存在），**不要假设自动兼容**（§6）。
3. **必须在插件内自带 `timeoutMs`**（建议 90–120s，看最慢上游），并真正消费 `exec.signal`。
4. **失败语义不要照抄原工具**：改为「单源失败 → 标注缺失、返回其余材料」。
5. **为下游裁剪预算设计**：`tool-result-pruner` **8192 字符**（保 head 4096 + tail 1024，
   三个 preset 全带：`presets/standard.patch.yml:74-79` 等）；`spill-policy` **12500 tokens**
   （`dsh-base/cordis.patch.yml:407-410`）。结果块按「结论在前 → 分条证据（带 URL）→ 出处集中尾」排布。
6. **不要**靠多注册 provider 做多源（→ `WEB_PROVIDER_AMBIGUOUS`）；**不要**在 provider 内调
   `ctx.web.search()`（递归或打到自己）；聚合器要复用自己的上游就得自带适配器。
7. 真要改宿主 `web` 行，按本仓约定产出计划文档交用户落进 flake；那会**全局替换**所有 agent 的搜索后端。

## 9. 未实测 / 待验证

1. preset 平面 `web_search` 遮蔽宿主全局时的实际遮蔽与提示段合并效果。
2. 运行期 live provider 数量与选路 —— 只在**未配置 `configuredId`** 时才可从「正常返回」推断唯一（§7）。
3. **PTC 路径下审计指针是否随父结果保存**（`meta` 侧已确定不投影；`content` 侧未验证）。
   若不保存，需另找已受支持的日志机制 —— 本文**未确认存在**这样的机制。
4. `tool-result-pruner` 对**多 block** 结果的裁剪粒度（原工具是单 text block，故按字符计）。
5. `registerSearchProvider` 的 disposer 归属 —— 注册 effect 落在**服务自己的** `ctx` 上
   （`dsh-web/lib/index.js:86`），预计随宿主 fiber 生命周期，未实测。
6. 自注册 `meta` 是否有隐藏体积上限（只核实了它是 `JsonValue` 且经深冻结快照）。

## 10. 来源

`$DSH/`：`dsh-web`（README、`lib/types/index.d.ts`、`lib/types/types.d.ts`、`lib/index.js`）、
`dsh-tool-web`（README、`lib/types/{index,search}.d.ts`、`lib/index.js`）、
`dsh-web-search-deepseek`（`lib/types/provider.d.ts`、`lib/index.js`）、
`dsh-tools`（`lib/types/{index,json-schema}.d.ts`、`lib/index.js`）、
`dsh-system-prompt`（`lib/types/index.d.ts`、`lib/index.js`）、
`dsh-scope`（README、`lib/types/index.d.ts`、`lib/index.js`）、`cordis/lib/index.js`、
`dsh-agent-preset`（README、`lib/index.js`，**及
`skills/cordis-plugin-development/references/practices.md:21` 的 session 事件禁令**）、
`dsh-agent-preset-registry/lib/index.js`、
`dsh-agent-loop/lib/index.js`、`dsh-llm/lib/index.js`、`dsh-session/lib/types/{index,types}.d.ts`、
`dsh-spill-policy`、`dsh-spill-local/lib/types/{index,store}.d.ts`、`dsh-tool-call-timeout-policy`。
`$BASE/`：`dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml` 与 `presets/{standard,ptc,cordis,minimal}.patch.yml`。
本机：`~/.dsh/profiles/web/{cordis.yml,cordis.patch.yml,package.json}`。
只读查询：`cordis_inspect_list`；Host `Config.listConfigs`
（`include:web`、`include:tool-web`、`include:web-search-deepseek`、`include:preset-standard`）。
