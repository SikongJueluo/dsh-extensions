# 调研：Command Code 订阅接入 DSH（env 驱动 provider + plan-usage 配额）

> 结论先行：**好实现，但 provider 侧需要写一个新 bundle，不是纯配置。**
> 参考 [CommandCodeAI/pi-commandcode-provider](https://github.com/CommandCodeAI/pi-commandcode-provider) 的协议后，
> 在 DSH 里可以用一个约 400 行的 host-only 插件，把 `CMD_API_KEY` 环境变量自动变成一个
> `command-code` 路由（98 个模型，跨 anthropic-messages / openai-responses / openai-completions 三种协议），
> 不需要在设置页点“添加供应商”。plan-usage 侧再加一个 source（约 250 行）就能显示 5h / 周 / 月度
> credits 三条窗口——两件事都独立，先做哪个都行。

- 调研日期：2026-11-14。方法：读参考实现源码 + 实拉 `GET /provider/v1/models` + 本机 dsh 0.2.2-rc.1
  的类型/源码逐文件核对 + 用 `PiAiAdapter` 做了一次真实适配器探针（见 §3.5）+ 第三方配额实现交叉比对（§5）。
- 参考实现 pin：[CommandCodeAI/pi-commandcode-provider](https://github.com/CommandCodeAI/pi-commandcode-provider)
  （`index.ts` / `README.md`，2026-11 的 HEAD）。
- 本机 dsh：`0.2.2-rc.1`，`@deepseek-ai/dsh-llm-pi-ai` 同为 `0.2.2-rc.1`，内置 `@earendil-works/pi-ai` `1.5.0`。
- 用户已有的接入点：`~/.config/nixos/home/ai/dsh/providers.nix` 的 `programs.dsh.piAiProviders`（静态 allowlist，
  `apiKeyEnv` 按请求解析）；`secrets.nix` 里已经有 `CMD_API_KEY`。所以“env 驱动”与现有部署方式同构。

> **落地状态（2026-11-15）**：`packages/more-providers` 已从 CommandCode 专用插件扩展为
> YAML 驱动的全量 provider registry（`$DSH_HOME/more-providers.yaml`，stock `llm-pi-ai`
> 被禁用），plan-usage 通过其 `providerKeys` 服务读取文件 key；自动多账号切换仍是 TODO。
> 当前实现细节以 [more-providers README](../packages/more-providers/README.md) 为准。

---

## 1. 参考实现到底做了什么

### 1.1 一个 provider，三条 wire 路径

Command Code 的 Provider API 只有**一个 base**：`https://api.commandcode.ai/provider`。
但模型按 `supported_endpoints` 分流到三个协议，走错路会 400：

| 模型族 | `supported_endpoints` | pi-ai 协议 | 实际 URL |
|---|---|---|---|
| Claude | `["/messages"]` | `anthropic-messages` | `POST /provider/v1/messages?beta=true` |
| GPT | `["/chat/completions","/responses"]` 且 id 以 `gpt-` 开头 | `openai-responses` | `POST /provider/v1/responses` |
| 其余（DeepSeek / Kimi / GLM / Qwen / Gemini / Grok …） | 含 `/chat/completions` | `openai-completions` | `POST /provider/v1/chat/completions` |

参考实现的关键逻辑（`index.ts`）：

- Claude 的 `baseUrl` 是 `.../provider`（Anthropic SDK 自己补 `/v1/messages`），
  OpenAI 两路是 `.../provider/v1`。
- `openai-completions` 一律带
  `compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" }`——
  Qwen / GLM / Kimi 等上游拒 `developer` 角色，统一改 `system`。
- Claude 4.6+/5 家族带 `compat: { forceAdaptiveThinking: true }`，否则旧的
  `thinking: {type:"enabled"}` 会被网关 400。
- `CMD_ZDR=1` 时给每个模型加 `headers: { "x-cmd-zdr": "1" }`，网关只走零保留上游。
- 模型目录**完全来自** `GET /provider/v1/models`，没有硬编码；`CMD_MODELS_URL` 可覆盖。
- 认证：`CMD_API_KEY` 或 `COMMAND_CODE_API_KEY`（`envApiKeyAuth`），也支持 `/login` 存 key。
- 价格端点不返回，`cost` 全 0；`max_output_tokens` 缺省时 32K，`context_length` 缺省 128K。

> 这里说的“订阅支持”是**用 GOAT+ 订阅签发的 API key**，不是 ChatGPT 那种 OAuth 授权码流程。
> Command Code 的 `cmd login` 也只是把同一个 key 存进 `~/.commandcode/auth.json`（CodexBar 文档原话：
> “cmd login stores the key in ~/.commandcode/auth.json”）。所以 env 注入是主路径，不需要再写登录 UI。

### 1.2 2026-11-14 实拉目录

`GET https://api.commandcode.ai/provider/v1/models` 无需认证，200，`data` 数组 98 条：

```json
{"id":"claude-sonnet-5-5","object":"model","created":1794589153,
 "owned_by":"command-code","name":"Claude Sonnet 5.5",
 "context_length":1000000,"supported_endpoints":["/messages"]}
```

分布：

| `supported_endpoints` | 数量 | 路由 |
|---|---:|---|
| `["/messages"]` | 12 | anthropic-messages |
| `["/chat/completions","/responses"]` | 74 | 其中 12 个 `gpt-*` 走 responses，其余 62 个走 completions |
| `["/chat/completions"]` | 12 | openai-completions |

`context_length` 有 10 种取值（200K / 256K / 262K / 400K / 500K / 524K / 1M / 1.05M / 1.048M / 262000），
字段只有 `id/object/created/owned_by/name/context_length/supported_endpoints`——
没有 `pricing`、`max_output_tokens`、`modalities`、`reasoning`。这与参考实现的 fallback 一致。

---

## 2. DSH 侧现状：env 驱动的 provider 能走到哪一步

### 2.1 纯配置方案（零代码，但不推荐）

DSH 内置的 `@deepseek-ai/dsh-llm-pi-ai` 已经支持“手写 gateway”：

```yaml
- id: llm-pi-ai
  config:
    providers:
      command-code-chat:
        apiKeyEnv: CMD_API_KEY
        api: openai-completions
        baseURL: https://api.commandcode.ai/provider/v1
        compat: { supportsDeveloperRole: false, maxTokensField: max_tokens }
        models: [{ id: deepseek/deepseek-v4-pro, contextWindow: 1000000, maxTokens: 32768 }]
```

`apiKeyEnv` 是按请求解析的 credential reference，secret 不进配置——这正是用户已有的
`programs.dsh.piAiProviders` 模式。但它有三个硬限制：

1. **一条 route 只能一个 `api`**（`PiAiProviderProfile.api` 是 route 级），Command Code 的三协议必须拆成
   3 条 route（`command-code` / `-openai` / `-chat`），模型选择器里会出现三个供应商分组。
2. **`models` 必须逐个列出**。manifest 只给“模型清单替换”语义，没有“从 endpoint 自动发现并落盘”的路径；
   `registerModelDiscovery` 只服务设置页的“添加供应商”草稿，不回写运行中的 route。
3. 98 个模型 + 每月新增 = 手写 YAML 不可维护。

所以纯配置能“先跑起来”，但不满足“像环境变量一样管理”的目标。

### 2.2 DSH 的扩展缝

- `ctx.llm.registerAdapter(providers, adapter)`：一个 adapter 可以拥有多条 route；route 冲突
  `DUPLICATE_ADAPTER`，注册/替换是原子的（`dsh-llm/lib/types/index.d.ts` 的 `AdapterRegistrationHandle`）。
- `LlmAdapter` 是抽象类：`providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` /
  `prepareCall` / `stream`。自己实现要重写整套 DSH↔pi-ai 的消息/图片/工具/推理转换，约 1500 行——不值。
- `@deepseek-ai/dsh-llm-pi-ai` **导出 `PiAiAdapter`**（`lib/types/index.d.ts` 的
  `export { PiAiAdapter } from './adapter.ts'`），构造参数是
  `{ profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>, resolveApiKey, auth, ... }`。
  它内部用 pi-ai 的 `createModels()`，按 `model.api` 分派——**天然支持一条 route 混合三协议**。
- pi-ai 1.5.0 的 `createProvider({ id, name, auth, models, api })` 支持 `api` 传
  `Partial<Record<Api, ProviderStreams>>`（`models.d.ts` 的 `CreateProviderOptions.api`），
  每个 `Model` 自带 `api` 和 `baseUrl`。参考实现的 `commandCodeProvider()` 正是这个形状。

### 2.3 结论

**复用 `PiAiAdapter` + 自己构造一份 `ResolvedPiAiProviderProfile`**，是代码量最小、行为最接近参考实现的路径。
`PiAiAdapter` 虽然不在 README 的“用户 API”里，但它是显式导出、带完整 `.d.ts` 的类型化入口；
`dsh-llm` 的 `normalizeLlmFailure` 还专门处理了“跨包 copies 的 Error 类身份不保留”问题
（`dsh-llm/lib/types/adapter-failure.js` 注释 “Cross-package copies preserve own data but not class identity”），
说明跨包复用是预期内的。

---

## 3. 推荐方案：`packages/more-providers`

### 3.1 形态

Host-only bundle，一个插件行 `more-providers`，无浏览器半：

```yaml
# cordis.patch.yml
- insert:
    - id: more-providers
      name: dsh-more-providers
```

`inject: ['llm']`；`apply` 是 `async`（先拉目录再注册）。安装方式与现有包一致：
`plugins.nix` 里加一行 `"${extensions}/more-providers"`，或 `dsh plugin add`。
刻意**不**注册 `registerConfigurableProviders`——这个插件没有“设置页编辑”的需求，route 的有无完全由
`CMD_API_KEY` 决定；模型选择器仍然会看到它，只是 Models 设置页不会多一张可编辑卡片。

### 3.2 启动流程

```
apply(ctx, config)
  ├─ key = process.env[config.apiKeyEnv] || process.env[config.fallbackApiKeyEnv]
  │   └─ 没有 key → logger.info 一行，直接 return（路由保持休眠，不污染模型选择器）
  ├─ GET {modelsURL}（默认 https://api.commandcode.ai/provider/v1/models）
  │   └─ 非 2xx / 超时 / 坏 JSON → logger.error，return（不退化成空 provider）
  ├─ items → pi-ai Model[]（§3.3 的映射表）
  ├─ createProvider({ id:'command-code', name:'Command Code', auth, models,
  │                   api: { anthropicMessagesApi(), openAIResponsesApi(), openAICompletionsApi() } })
  ├─ 手工构造 ResolvedPiAiProviderProfile（§3.4）
  ├─ new PiAiAdapter({ profiles: () => map, resolveApiKey: async () => key, auth: stub })
  └─ ctx.llm.registerAdapter(['command-code'], adapter)
```

`apply` 里 await 目录拉取；最坏 10s 超时。正常 ~200ms。比“先注册空 route 再异步补”简单，
代价是启动多等一次 HTTP；参考实现也是启动时拉。

### 3.3 模型映射（与参考实现逐条对齐）

| 字段 | 取值 |
|---|---|
| `id` / `name` | `item.id` / `item.name ?? item.id` |
| `api` | `/messages` → `anthropic-messages`；`gpt-*` 且有 `/responses` → `openai-responses`；有 `/chat/completions` → `openai-completions`；否则有 `/responses` → `openai-responses`；都没有则跳过该模型 |
| `baseUrl` | anthropic → `https://api.commandcode.ai/provider`；其余 → `.../provider/v1` |
| `reasoning` | `item.reasoning ?? true`（端点暂不返回，按参考实现默认 `true`） |
| `input` | `item.modalities?.input` 优先；否则 `claude-*` / `gpt-*` / `google/*` → `["text","image"]`，其余 `["text"]` |
| `cost` | `item.pricing` 有则映射 `input/output/cache_read/cache_write`，否则全 0 |
| `contextWindow` | `item.context_length \|\| 131072` |
| `maxTokens` | `item.max_output_tokens \|\| 32768` |
| `compat` | completions：`{supportsDeveloperRole:false, maxTokensField:'max_tokens'}`；anthropic 且命中 `ADAPTIVE_THINKING` 正则：`{forceAdaptiveThinking:true}` |
| `headers` | 不放在 model 上；ZDR 放 profile 级（见 §3.4），这样所有模型统一 |

### 3.4 `ResolvedPiAiProviderProfile` 手工构造

`PiAiAdapter` 真正读取的字段（按 `lib/index.js` 的 `current()` / `streamWithSnapshot` / `listModels`）：

```ts
const profile: ResolvedPiAiProviderProfile = {
  provider: 'command-code',
  displayName: 'Command Code',
  apiKeyEnv: 'CMD_API_KEY',            // 仅用于目录/诊断，鉴权走 resolveApiKey
  streamIdleTimeoutMs: 300_000,
  maxRequestImageBytes: 20_971_520,
  maxRequestImages: 50,
  imageOffloadCountQuantum: 10,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  retryPolicy: {                       // dsh-llm 的 default 常量
    mode: 'normal', maxRetries: 5,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 500, maxDelayMs: 10_000, jitterRatio: 0.1,
  },
  piProvider,                          // createProvider(...) 的返回值
  modelErrors: new Map(),
  configuredMaxTokens: new Map(),
  ...(zdr ? { headers: { 'x-cmd-zdr': '1' } } : {}),
}
const profiles = new Map([['command-code', profile]])
```

`auth` 传最小桩即可：每个请求都由 `resolveApiKey` 直接给 `apiKey`，
`PiAiAdapter` 的 `profileOptions()` 会把它放进 pi-ai 的 `apiKey` 选项；
`createModels(auth)` 只在这条路径之外才查 credential store。桩：

```ts
auth: {
  credentials: { read: async () => undefined, list: async () => [],
                 modify: async () => undefined, delete: async () => {} },
  authContext: { env: async (name) => process.env[name], fileExists: async () => false },
}
```

### 3.5 已验证的探针结果

在本机用 dsh 0.2.2-rc.1 的 `PiAiAdapter` + pi-ai 1.5.0 做了三步实测（脚本不落库，仅调研）：

1. **目录适配**：98 个模型 → `listModels('command-code')` 返回 98 条；
   `resolveModel` 对 `claude-sonnet-5` / `gpt-6-astra` / `deepseek/deepseek-v4-pro`
   分别给出 1M / 1.05M / 1M 上下文与 off/minimal/low/medium/high 推理档。
2. **真实分派**：把 `globalThis.fetch` 换成记录器后逐模型 `stream()`，实际请求为：
   - `POST https://api.commandcode.ai/provider/v1/messages?beta=true`，头 `x-api-key: ...`
   - `POST https://api.commandcode.ai/provider/v1/responses`，头 `Authorization: Bearer ...`
   - `POST https://api.commandcode.ai/provider/v1/chat/completions`，头 `Authorization: Bearer ...`
   - 三者都带 `x-cmd-zdr: 1` 与 DSH 的 attribution `User-Agent`；
   - 401 时 `PiAiAdapter` 正常产出 `usage` + 终态 `finish`（错误被收敛成 finish failure），没有卡死。
3. **真实 `LlmRuntime` 注册**：在裸 `Context` 上 `new LlmRuntime(ctx)` → `registerAdapter(['command-code'], adapter)` →
   `listProviders()` 返回 `[{id:'command-code',name:'Command Code'}]`；98 个模型全部
   `listModels` / `resolveModelInfo` / `prepareCall` 通过（98/98，0 失败）；disposer 后 `listProviders()` 为空。
   跨包 `LlmAdapter` / `LlmError` 没有 `instanceof` 问题（`dsh-llm` 的失败归一化按 own `code` 字段读，见
   `dsh-llm/lib/types/adapter-failure.js`）。

这证明“一条 route、混合三协议、profile 级 ZDR 头”在 DSH 0.2.2 的运行时里是通的，不只是类型上通。

---

## 4. 备选方案对比

| 方案 | 机制 | 代码量 | 优点 | 缺点 / 结论 |
|---|---|---:|---|---|
| **A. 纯 nix 配置** | `piAiProviders` 写 3 条 route + 静态 models | 0 | 今天就能跑，secret 仍走 env | 98 个模型手写；三供应商分组；新模型要改 nix；不推荐长期 |
| **B. 新插件复用 `PiAiAdapter`（推荐）** | 本文 §3 | ~400 行 + smoke | 一条 route；目录自动拉；env 一行生效；与参考实现同协议规则 | 依赖 `PiAiAdapter` 这个“导出了但非 README 承诺”的入口；需跟 dsh 版本钉版 |
| **C. 给 `dsh-llm-pi-ai` 加 `modelsUrl`** | 改官方包，让手写 gateway 也能在启动时拉目录 | ~50 行（上游） | 最干净，所有自定义 gateway 受益 | dsh 由 nix 管，改上游要进 dsh 仓库/等版本；不适合本仓 out-of-tree |
| **D. 外部脚本生成 YAML** | 定时拉目录，写 profile patch | ~100 行 shell/node | 不改 dsh | 引入状态文件、重启才生效、容易与手写配置打架；不推荐 |

**建议 B**；如果用户坚持“零插件”，A 是唯一可接受的临时方案，但只建议先列 3–5 个模型试用。

---

## 5. plan-usage 接入

### 5.1 端点（alpha，未公开）

参考实现只覆盖推理，不带配额。配额来自 Command Code CLI 自己在用的 alpha billing 路由：

```
GET https://api.commandcode.ai/alpha/whoami?limits=1
GET https://api.commandcode.ai/alpha/billing/credits?orgId=<org>
GET https://api.commandcode.ai/alpha/billing/subscriptions?orgId=<org>
Authorization: Bearer <CMD_API_KEY>
Accept: application/json
```

2026-11 的三份独立实现（[hermes-quota-plugin](https://github.com/rarf/hermes-quota-plugin/blob/v2.8.2/quota_providers/commandcode.py)、
[opencodex 2d5f374](https://github.com/lidge-jun/opencodex/commit/2d5f374fbedc924998fa0dd4f2f78206d155bcbb)、
[CodexBar](https://github.com/steipete/codexbar/blob/7447bc77c2497323d9c41e40164ce705533493c8/docs/command-code.md)）
对同一组路由的字段描述一致。三个路由都真实存在：无 token 实测均为 `401`
`{"success":false,"error":{"code":"UNAUTHORIZED","status":401,"message":...}}`（不是 404）。
成功响应的字段如下：

```jsonc
// /alpha/billing/credits（可能在 data 信封里；windowLimits 也可能嵌在 credits 下）
{
  "credits": {
    "monthlyCredits": 57.6,          // 剩余“包含额度”
    "monthlyCreditsGranted": 70,     // 本期总额（CodexBar 说新响应带；旧实现按 planId 查表）
    "purchasedCredits": 0,           // 额外购买，不封顶
    "freeCredits": 0
  },
  "windowLimits": {
    "fiveHour": { "cap": 100, "used": 40, "resetAt": "2026-11-14T20:00:00.000Z", "exceeded": false },
    "weekly":   { "cap": 500, "used": 25, "resetAt": "2026-11-18T00:00:00.000Z", "exceeded": false },
    "limited": false,                // false = 按量付费，没有滚动窗口
    "exceeded": null
  }
}
```

```jsonc
// /alpha/billing/subscriptions（data 信封）
{ "planId": "individual-goat", "currentPeriodStart": "2026-11-01T...", "currentPeriodEnd": "2026-12-01T..." }
```

`/alpha/whoami?limits=1` 只用来拿 `org.id` 做团队作用域；拿不到就不带 `orgId` 继续（CLI 同款降级）。
`/alpha/usage/summary?orgId=...&since=...` 可拿周期 `totalCost`，但月度百分比用
`grant - monthlyCredits` 就够，**不必**打这个请求；少一次失败点。

### 5.2 映射到 `QuotaSnapshot`

| Command Code | `QuotaWindow` | 说明 |
|---|---|---|
| `windowLimits.fiveHour.used / cap` | `fiveHour.percent = used/cap*100` | `exceeded: true` → 100；`limited: false` → 不出窗 |
| `fiveHour.resetAt` | `fiveHour.resetAt` | 支持 epoch ms 与 ISO-8601 两种（CLI 不同版本都出现过） |
| `windowLimits.weekly` | `weekly` | 同上；`windowMinutes` 留空（否则客户端会显示 "168h window"，不如静态 "Weekly window"） |
| `monthlyCreditsGranted - monthlyCredits` | `monthly.percent` | 总/已用用 USD 填 `total` / `used`；grant 缺失时用 plan 表兜底（见下） |
| `currentPeriodEnd` | `monthly.resetAt` | ISO → epoch ms |
| `planId` | `snapshot.level` | `individual-goat` → `GOAT` 等；未知 plan 原样显示 |
| `credits.monthlyCredits` | `monthly.remaining`（需扩展类型，见 §5.4） | 用户要的“剩余额度” |

plan 表兜底（`monthlyCreditsGranted` 缺失时）：

```ts
const PLANS = {
  'individual-go': ['Go', 10], 'individual-go-v1': ['Go', 10],
  'individual-goat': ['GOAT', 70], 'individual-pro': ['Pro', 30],
  'individual-pro-v1': ['Pro', 80], 'individual-provider': ['Provider', 15],
  'individual-max': ['Max', 150], 'individual-ultra': ['Ultra', 300],
  'teams-pro': ['Teams Pro', 40],
}
```

> 注意：`$1` 的 Go plan **不允许外部工具**（官方 README 明确写 “Go plan credentials are not authorized
> for use with this provider”）；配额端点对 Go 也可能只回 `limited`/没有 5h/周窗口。卡片应优雅降级，
> 不要伪造百分比。

### 5.3 source 实现

新增 `packages/plan-usage/src/sources/commandcode.ts`，形状与 `opencode.ts` 一致：

```ts
export class CommandCodeSource {
  readonly id = 'command-code'
  readonly routes = ['command-code'] as const

  ready(route: string): boolean {
    // apiKey() = CMD_API_KEY || COMMAND_CODE_API_KEY
    return route === 'command-code' && apiKey() !== undefined
  }

  async get(route: string): Promise<QuotaSnapshot | undefined> {
    // 1) whoami（可选，5s）→ orgId
    // 2) Promise.all([credits, subscriptions])（orgId 可空）
    // 3) 解析 → { provider: route, fetchedAt, source: 'command-code:credits', ... }
    // 任何失败 return undefined，只 warn 一行，不抛
  }
}
```

接入点：

- `service.ts` 构造器：`new CommandCodeSource({ logger: ... })` 加进 `sources`。
- 设置页只展示 `monitored()` 为真的路由；没有 key 的 source 不出空卡（删 key 即可隐藏）。
- `index.ts`：导出 `CommandCodeSource` / `parseCommandCodeCredits`，供 smoke 用。
- `README.md`：表格加一行；「四源聚合」→「五源聚合」。
- `smoke.mjs`：加解析向量（200 正常、`data` 信封、`windowLimits` 嵌套、`limited:false`、401、坏 JSON、无 key），
  并把 `service.providers()` 的 unfiltered 断言补上 `command-code`。

### 5.4 客户端“剩余额度”显示（可选但建议）

现有 `QuotaWindow` 只有 `percent/used/total/resetAt/windowMinutes`，客户端对 USD 会走
`fmtCount()`（`Math.round`，没有 `$`），显示成 “58 / 70 used”。建议最小扩展：

```ts
// types.ts
export interface QuotaWindow {
  // ...
  /** Remaining amount when the source reports it (USD for Command Code credits). */
  remaining?: number
  /** Display unit for used/total/remaining. */
  unit?: 'usd'
}
```

`client/client.js` 的 `WindowBar` 在 `unit === 'usd'` 时：

- 进度条仍按 `percent`（已用）画；
- meta 改为 `已用 36% · 剩余 $57.60 · 12d 3h后重置`；
- 英文 `36% used · $57.60 left · resets in 12d 3h`。

只影响 Command Code（其他 source 不填 `unit`），约 20 行。

---

## 6. 工作量与风险

| 工作项 | 估计 | 说明 |
|---|---|---|
| `packages/more-providers` 骨架（package/tsconfig/tsdown/patch/dev.patch） | 0.5h | 抄 `plan-usage` 的 host-only 形态 |
| `catalog.ts`（拉取 + 映射） | 2h | 规则按 §3.3，纯函数可测 |
| `index.ts`（env/key、profile、adapter 注册） | 2h | 关键在 profile 字段与错误路径 |
| `smoke.mjs`（映射向量 + 假 fetch 的 401/坏 JSON + `listModels`） | 2h | 探针已验证可行 |
| README + 安装说明 | 1h | |
| plan-usage source + 解析 | 3h | 端点/字段已确认 |
| plan-usage 类型/客户端“剩余” | 1h | 可选 |
| 联调（真 key、模型选择器、设置页卡片、401/无订阅） | 2h | 需要重启 dsh-web |
| **合计** | **~1 人日** | provider 与 plan-usage 可并行 |

### 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `PiAiAdapter` 是导出但非 README 承诺的入口 | dsh 升级可能改构造/字段 | 钉 `0.2.2-rc.1`，`pnpm typecheck` 会在升级时暴露；smoke 覆盖 `listModels` |
| `ResolvedPiAiProviderProfile` 手工构造漏字段 | 运行时某路径 undefined | 本文 §3.4 已列出实际读取字段；探针跑通 list/resolve/stream 三条路径 |
| 两个 pi-ai copy（插件依赖 vs dsh 内置） | Provider/Model 结构跨 copy | pnpm `nodeLinker: hoisted` 收敛；均为纯对象；`dsh-llm` 已有跨 copy 错误归一化 |
| 模型目录端点变更 | 启动失败、无模型 | 超时 + 非 2xx 明确日志；`modelsURL` 可配；失败不注册空 provider |
| 配额 alpha 端点变更 | 卡片消失 | 防御式解码，坏窗跳过；source 永不抛；每次失败只 warn |
| 无 GOAT+ 订阅 / Go plan | 401/403 或没有窗口 | `ready()` 只查 key；`get()` 对 401/403 返回 undefined；卡片显示“暂不可用”，不伪造 |
| 模型 id 带 `:free` | 某些 surface 可能把 `:` 当推理档分隔符 | 目前仅 2 个 `:free` 模型；上线前在模型选择器实测，必要时按 id 原样传递（DSH 的 `prepareCall` 用精确 id） |
| 98 个模型让选择器很长 | UX | 后续可加 allowlist/denylist 配置；v1 先全量 |

---

## 7. 建议落地顺序

1. **先做 plan-usage source**（不依赖 provider 插件；`smoke` 用假 fetch 就能验；
   真 key 下 `CommandCodeSource.get()` 可独立跑）。
2. **再做 provider 插件**：先 `catalog.ts` + 映射单测，再 `PiAiAdapter` 注册，最后真 key 联调。
3. **nix 接线**：`plugins.nix` 加 `"${extensions}/more-providers"`；
   `secrets.nix` 已有 `CMD_API_KEY`，无需改；`systemctl --user restart dsh-web`。
4. **验证**：
   - 模型选择器出现 `Command Code`，模型数 98（或当前目录数）；
   - 选 Claude / GPT / 非 GPT 各一条，各发一句，确认三条 wire 路径；
   - `CMD_ZDR=1` 时抓包/日志确认 `x-cmd-zdr: 1`；
   - 设置 → Coding 套餐用量出现 `command-code` 卡片，5h/周/月三条与 CLI 面板一致；
   - 临时 unset `CMD_API_KEY` 重启，确认路由不注册、卡片不出现（而不是报错）。

---

## 8. 未确认 / 开放问题

- **配额端点的官方稳定性**：`/alpha/*` 是 CLI 内部路由，三份第三方实现都是逆向；无版本承诺。
  解码必须逐窗防御，端点变更时返回 `undefined` 而不是错误百分比。
- **`monthlyCreditsGranted` 是否稳定在 credits 响应里**：CodexBar 说新响应有；hermes 仍按 `planId` 查表。
  两者都兼容即可。
- **`windowLimits.resetAt` 的单位**：hermes 按 epoch ms，opencodex 测试向量用 ISO；两者都支持。
- **`CMD_ZDR` 与 DSH attribution**：参考实现只验证过 pi 的 UA；DSH 的 `User-Agent` 是
  `deepseek-harness/...`，实测请求能到网关（401 是 key 无效，不是 UA 拒绝）。真 key 下需再确认。
- **`PiAiAdapter` 的公开承诺**：目前是显式导出；若上游未来移除，需要退回方案 A 或 C。
- **Go plan**：`$1` Go 明确不允许外部工具；如果用户的 `CMD_API_KEY` 是 Go，provider 会 401/403，
  plan-usage 也不该显示窗口。需要真 key 验证一次。
- **图片输入**：目录不返回 modalities；按参考实现只对 `claude-*`/`gpt-*`/`google/*` 声明 image。
  `deepseek-v4-flash-vision-exp`、`Qwen3.8-Omni-Flash`、`nemotron-3.5-super-vl` 等会被当成 text-only——
  这是保守选择，避免“声明了图片但上游拒绝”的中途失败。

---

## 9. 参考

- [CommandCodeAI/pi-commandcode-provider](https://github.com/CommandCodeAI/pi-commandcode-provider)——provider 协议、三路分流、env、ZDR、compat 的第一手实现。
- [Command Code Provider API 文档](https://commandcode.ai/docs/provider)、[Pricing & Limits](https://commandcode.ai/docs/resources/pricing-limits)、[Usage Limits](https://commandcode.ai/docs/resources/usage-limits)——套餐与限额口径。
- [hermes-quota-plugin commandcode.py](https://github.com/rarf/hermes-quota-plugin/blob/v2.8.2/quota_providers/commandcode.py)——CLI 1.53.0 的 `/alpha/whoami?limits=1`、credits/subscriptions/summary 请求形状与 plan 表。
- [opencodex 配额 commit](https://github.com/lidge-jun/opencodex/commit/2d5f374fbedc924998fa0dd4f2f78206d155bcbb)——`windowLimits`、USD credits、org 作用域与测试向量。
- [CodexBar Command Code notes](https://github.com/steipete/codexbar/blob/7447bc77c2497323d9c41e40164ce705533493c8/docs/command-code.md)——5h/周/月与 `monthlyCreditsGranted`、Cookie/API key 两种来源。
- 本机 dsh：`@deepseek-ai/dsh-llm` / `dsh-llm-pi-ai` / `@earendil-works/pi-ai` 的 `lib/types/*.d.ts` 与 `lib/index.js`（0.2.2-rc.1）。
- 同仓参考：[`packages/more-providers`](../packages/more-providers/)（内含 ChatGPT OAuth 的自定义 `ctx.llm` 路由范式，原 oauth-providers 已并入）、
  [`packages/plan-usage`](../packages/plan-usage/)（source 聚合与设置页卡片）。
