# dsh-more-providers

**YAML 驱动的 DSH provider registry：API-key 厂商 + 默认启用的 ChatGPT 订阅 OAuth。**

0.2.0 起这里同时提供原来 `dsh-oauth-providers` 的 ChatGPT 登录：共享模块位于包内，
pi-ai 与 ChatGPT 协议都留在本包内部。一份 YAML 管所有 API-key 路由
（provider 定义、模型目录、账号变体、密钥路径），ChatGPT 走宿主凭据 + 设置页登录，
无需 API Key。插件按 key 可用性注册路由，并向其他插件暴露同步的 `providerKeys`
与 OAuth 的 `oauthProviders` 服务。stock `dsh-llm-pi-ai` 由本 bundle 禁用，
`deepseek-official` 仍走内置 `DEEPSEEK_API_KEY`。

| 部分 | 配置位置 | 凭据 |
|---|---|---|
| API-key 路由（`builtin` / `custom` / `command-code`） | YAML `providers.<id>` | `apiKeyFile` / `secretName` / `apiKeyEnv` |
| ChatGPT 订阅（route `chatgpt`） | YAML `providers.chatgpt`，可整节省略 | 设置页「OAuth 登录」写入 `ctx.credentials` 的 `oauth-providers/chatgpt` |

## 快速开始

1. 构建并安装（或把 checkout 路径加进 `programs.dsh.plugins`）：

```fish
pnpm -C packages/more-providers build
dsh plugin --profile web add ./packages/more-providers
```

2. 创建 `$DSH_HOME/more-providers.yaml`（默认 `~/.dsh/more-providers.yaml`）。
   插件行的 `configFile` 可指定别的路径：相对路径以进程 cwd 为基准，支持 `~/` 展开。
   **最小合法内容就是 `providers: {}`**——ChatGPT 默认启用，API-key 厂商按需添加
   （见[示例配置](#示例配置)）。
3. 重启 dsh：

```sh
systemctl --user restart dsh-web
```

4. ChatGPT：打开设置页「OAuth 登录」，点「登录」按提示完成（详见
   [ChatGPT 订阅（OAuth）](#chatgpt-订阅oauth)）。
5. 从旧 `dsh-oauth-providers` 迁过来时，**先把旧 bundle 移出 profile，再部署本包**，
   不能双挂；步骤见 [从 dsh-oauth-providers 迁移](#从-dsh-oauth-providers-迁移)。

## 示例配置

```yaml
# $DSH_HOME/more-providers.yaml
# secretDir 默认 $XDG_RUNTIME_DIR/agenix；通常不用写。
providers:
  # ChatGPT 整节可省；这里列的是内建默认值，只改需要覆盖的项。
  # chatgpt:
  #   baseURL: https://chatgpt.com/backend-api/codex
  #   refreshMarginMs: 86400000
  #   defaultContextWindow: 272000
  #   promptCacheKey: true
  #   # clientVersion: ""        # 省略/留空 = 取 npm 上 @openai/codex 最新版

  # 关闭 ChatGPT：不注册路由、设置页无卡，凭据保留（重新开启无需重登）。
  # chatgpt:
  #   enabled: false

  zai-coding-cn:
    kind: builtin
    secretName: zhipu-coding-api-key

  opencode-go:
    kind: builtin
    secretName: opencode-api-key

  moonshotai:
    kind: builtin
    secretName: moonshot-api-key

  minimax:
    kind: builtin
    secretName: minimax-coding-api-key

  command-code:
    kind: command-code
    displayName: Command Code
    secretName: commandcode-api-key

  mdkj:
    kind: custom
    displayName: MDKJ
    api: openai-responses
    baseURL: https://mdkj.lol/v1
    modelsURL: https://mdkj.lol/v1/models
    models:                       # 目录失败/缺字段时的 fallback 与 metadata
      - id: gpt-6.1-sol
        name: GPT-6.1 Sol
        contextWindow: 524288
        maxTokens: 32768
        input: [text, image]
    modelDefaults:                 # 窗口值须确认适用于该 MDKJ 路由；此处 272000 仅作示例
      - match: '^gpt-6'
        contextWindow: 272000
    accounts:
      stable:
        displayName: MDKJ Stable
        secretName: mdkj-stable-gpt-api-key
      cheap:
        displayName: MDKJ Cheap
        secretName: mdkj-cheap-gpt-api-key
```

生成的路由：`chatgpt`、`zai-coding-cn`、`opencode-go`、`moonshotai`、`minimax`、
`command-code`、`mdkj-stable`、`mdkj-cheap`。`mdkj` 本身是模板，不注册。

## 配置规则

### 顶层

- `providers` **必填**；空对象合法（只跑 ChatGPT）。
- `secretDir` 可选，必须是绝对路径。
- 整份文档只认 `providers` / `providers.<id>` / `providers.chatgpt` 这些键，未知键直接
  判定整份无效（见[校验与运行时](#校验与运行时)）。

### `providers.chatgpt`

ChatGPT 的 LLM 路由固定是 `chatgpt`（保留名：其他 provider / account 不能占用，
即使 ChatGPT 被关闭也保留）。整节省略即启用，全部字段可选：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 关闭。**只停止注册与显示，不删除凭据** |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | Codex Responses 后端地址，绝对 http(s) URL |
| `clientVersion` | 省略/留空 = 取 npm 上 `@openai/codex` 最新版 | 报给后端的 client 版本 |
| `refreshMarginMs` | `86400000`（24h） | 距过期多久开始刷新 OAuth 授权（正整数，毫秒） |
| `defaultContextWindow` | `272000` | 后端没有描述上下文窗口时的兜底（正整数） |
| `promptCacheKey` | `true` | 按会话派生 `prompt_cache_key` + session-affinity 头，让后端提示缓存把同一会话路由到同一节点 |

- 五个连接参数只在这里配置，**没有** `kind` / key / `accounts`；改完 YAML 重启 dsh 生效。
- 该节同样严格校验：出现未知键或非法值（非字符串 `clientVersion`、非 http(s) 的
  `baseURL`、非正整数的毫秒/窗口）会让整份 YAML 无效——**即使 `enabled: false` 也会校验**，
  免得留下一个以后打开才炸的配置。

### `kind`

| kind | 含义 | 必填 |
|---|---|---|
| `builtin` | 使用 pi-ai 内置 catalog（ZAI / OpenCode / Moonshot / MiniMax …） | `catalog` 可省，默认 provider id；**不接受** `api` / `baseURL` / `modelsURL` / `models` / `contextWindows` / `modelDefaults` / `compat` / `headers` / `zdr` |
| `custom` | 手写 OpenAI/Anthropic 兼容 endpoint | `api`、`baseURL`；`modelsURL` 或 `models` 至少一个 |
| `command-code` | Command Code 的混合协议目录 | 只有 key；可选 `baseURL` / `modelsURL` / `zdr` |

`api` 只支持 `openai-completions`、`openai-responses`、`anthropic-messages`。
`chatgpt` 不是 `kind`，它是内建 OAuth provider，不参与这套规则。

### `accounts`

有 `accounts` 时：

- provider 是模板，**不注册**；
- 每个 account 生成路由 `${provider}-${account}`（可用 `routeId` 覆盖）；
- 默认显示名 `${displayName} (${account})`；
- account 继承 provider 的 `api` / `baseURL` / `modelsURL` / `models` / `contextWindows` / `modelDefaults` / `compat` / `headers` / `zdr`；
- account 可覆盖 `displayName` / `routeId` / key；`custom` 还可覆盖 `api` / `baseURL` /
  `modelsURL` / `models` / `contextWindows` / `compat` / `headers`；`command-code` 可覆盖 `baseURL` / `modelsURL` / `zdr`；
  `builtin` 只允许 key/displayName/routeId/enabled。
- 对象深合并（`compat`/`headers`），数组整体替换（`models`）；`enabled: false` 跳过该 account。

### 密钥

每个 provider/account 三选一，优先级从高到低：

```yaml
apiKeyFile: /run/user/1000/agenix/mdkj-stable-gpt-api-key   # 显式绝对路径
secretName: mdkj-stable-gpt-api-key                          # ${secretDir}/<name>
apiKeyEnv: MDKJ_STABLE_GPT_API_KEY                           # 环境变量
```

- `secretDir` 默认 `$XDG_RUNTIME_DIR/agenix`（systemd 用户服务下通常是
  `/run/user/<uid>/agenix`），可显式覆盖。
- key 文件缺失/为空 → 该路由休眠，只 warn；不是配置错误。
- 启动时读一次决定是否注册；`providerKeys.key(route)` 按 mtime 缓存重读，轮换 key 不必重启。
- 只读解密后的路径，**不要**指向仓库里的 `.age` 文件。

### 模型

`custom` 的 model 条目：

| 字段 | 默认 | 说明 |
|---|---|---|
| `id` | 必填 | 请求 id |
| `name` | `id` | 选择器显示名 |
| `contextWindow` | `131072` | 上下文窗口 |
| `maxTokens` | `32768` | 输出上限 |
| `input` | `[text]` | 支持 `text` / `image` |
| `reasoning` | `[low, medium, high]` | `false` 关闭；数组可用 `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |

模型多时用 `modelDefaults` 按正则批量补元数据。它只存在于 `custom` provider 上，account
继承 provider 的规则、不能自定义；规则只作用于 `modelsURL` 返回的模型，目录失败/为空时
它们不生效（此时只有静态 `models` 与 `contextWindows` 生效）：

```yaml
modelDefaults:
  - match: '^gpt-6'          # 标准 JS 正则，不自动加锚点
    contextWindow: 272000
    reasoning: [low, medium, high]
  - match: 'astra$'
    flags: i                 # 可选；默认区分大小写
    maxTokens: 64000
```

规则按顺序排列；每个字段由**第一条命中且设置了该字段**的规则决定，不同字段可以由不同规则
补齐。逐字段取值优先级：目录返回值 > 规则 > `models[].contextWindow` / `contextWindows`
> 插件默认。目录条目里的 `reasoning`（`false` 或档位数组）也按接口值优先采用。规则不会新增
模型；`match` / `flags` 按原样编译（不裁剪空白），无效正则或 flags 让整份配置校验失败；
带 `g` / `y` 也安全，每次匹配前都会重置 `lastIndex`。

需要按精确 ID 覆盖时仍可用 `contextWindows`（provider 级，account 可覆盖 provider 值）：

```yaml
contextWindows:
  gpt-6.2-sol: 272000 # 示例值；请填已确认适用于该路由的窗口
```

目录返回的窗口和 `models` 中显式配置的 `contextWindow` 优先于此映射；账号映射按 ID 覆盖
provider 映射。此配置不添加模型，只为目录或静态列表中已有的模型补窗口；思考强度仍由
各模型的 `reasoning` 字段配置，或用 `modelDefaults` 批量补。

`reasoning` 是字符串数组，内部映射为 pi-ai 的 `reasoningEfforts` 同名 wire 值；默认不暴露
`off`（要关就整个 `reasoning: false`），数组里写 `off` 才会出现该档。

`modelsURL` 拉取成功时优先用目录；目录缺的字段会由同 id 的静态 `models` 补齐。目录失败/为空时
整体回退静态 `models`；两者都没有则跳过该 provider（只影响这一条路由）。

## Command Code

`kind: command-code` 的模型清单与协议仍来自普通 `/models`；启动时还会请求固定的
`https://api.commandcode.ai/provider/v1/models?view=client`，只为同一份清单中 id 完全相同的
模型补上下文窗口与思考档位：

- 两个来源都有值时以普通 `/models` 为准；普通目录明确 `reasoning: false` 时忽略能力目录的
  档位，其余情况采用能力目录的非空 `reasoningEfforts`（不合并默认档位）。
- 能力目录里多出来的模型（隐藏/免费等）不会加入选择器。
- 请求失败、`schemaVersion` 不是 `1`、或单行/单字段格式不对时只丢弃对应字段并回退现有默认
  （上下文 `131072`、思考 `low/medium/high`），不影响该路由的普通模型清单。
- 该能力地址不随 `modelsURL` 覆盖而变化；每次 DSH 启动拉取一次，不做运行期刷新。

## ChatGPT 订阅（OAuth）

- **路由**：`chatgpt`，显示名 `ChatGPT (OpenAI)`；模型目录从 Codex 后端动态拉取，
  后端未描述窗口时用 `defaultContextWindow` 兜底。
- **登录 UI**：设置页「OAuth 登录」分区（slot `dsh-oauth-providers`、locale 命名空间
  `oauth-providers`，沿用旧包标识以兼容）。卡片由宿主**实际注册**的 provider 列表决定：
  `chatgpt` 关闭时该卡不出现，客户端不假设它一定存在。每张卡显示登录状态、
  模型 badge、刷新按钮；已登录时多一个「退出登录」。
- **登录流程**：点「登录」→ 本包自有通道 `/dsh-oauth-providers` 的 `begin` 返回授权链接
  （浏览器打开即走本机回跳）→ 浏览器无法回跳时把重定向 URL 或授权码粘回设置页 `submit`
  → 前端轮询 `poll` 拿通知/提示 → `authorized` 后自动刷新模型目录。随时可「取消登录」；
  登录成功后按需刷新 provider 卡。
- **凭据**：`ctx.credentials` 的 `oauth-providers/chatgpt`。合并前后地址不变，
  **已有 ChatGPT 登录不需要重登**；`enabled: false` 或删掉整节都不动凭据，
  只有「退出登录」才删除。
- **失效边界**：未登录/授权过期只让 `chatgpt` 这一条路由不可用，其他 YAML 路由照常；
  dsh-plan-usage 的 OpenAI 配额卡也因此优雅降级为无卡。
- **手机端**：回环回跳（`localhost:1455`）不在 dsh-mobile 网关的代理范围，登录请在电脑
  浏览器完成；手机端只消费登录状态。
- **出网**：沿用进程网络与系统代理自动探测，本包没有插件级代理配置。
- **token 刷新**：`oauthProviders.token('chatgpt')` 每次给的是刷新轮换后的新 token，
  不会读陈旧副本。

## 校验与运行时

- **配置错误整份 fail-closed**：未知字段、非法 `kind`/`api`、缺 `baseURL`、空 `accounts`、
  没有任何 key source、重复或保留的 route id、`providers.chatgpt` 的未知键/非法值等，
  会让整份 YAML 不生效；插件只 log error、不崩 dsh，并且**不注册任何 provider 行**
  ——包括 ChatGPT：没有 `chatgpt` 路由，也不建立 `oauthProviders` 服务与登录通道。
- **文件缺失同样整份无效**：`$DSH_HOME/more-providers.yaml` 不存在或没有 `providers` 键时
  没有可注册内容；设置页的「OAuth 登录」分区仍在，但没有任何卡片。
- **Web 错误提示**：Host 在 `/dsh-more-providers/config-status` 暴露当前状态（文件、错误、
  revision、恢复方式），浏览器半经 `shell.overlay` 显示 toast（复用共享 `ConfigStatusToast`）。
  多个 preset 实例共享同一条路由并聚合返回 `instances`。页面加载或重连后仍会看到当前错误；
  同一连接内同一错误不会因重复读取反复弹出。
- **运行时目录失败按 provider 隔离**：`modelsURL` 超时/非 2xx/坏 JSON/空列表时用静态 `models`
  fallback；没有 fallback 才跳过该 provider，其他 provider 照常注册。
- **key 缺失**是正常休眠，不算配置错误；**未登录**只影响 `chatgpt` 路由。
- **改完 YAML 需要重启 dsh**：provider 行只在启动时注册，本插件刻意不做文件监听或
  provider 热更新（ChatGPT 的五个参数同属 YAML，也一样要重启）。修好文件后，页面上的
  错误提示仍会保留（并明确写「修好后需重启 dsh」），直到重启后重新读取。

## 服务

两个宿主服务都从本包注册：

```ts
ctx.get('providerKeys')?.key('zai-coding-cn')          // string | undefined
await ctx.get('oauthProviders')?.token('chatgpt')      // { access, accountId? } | undefined
ctx.get('oauthProviders')?.providers()                 // 可发 token 的 provider id
```

- `providerKeys.key(route)`：dsh-plan-usage 的 GLM / OpenCode / MiniMax / CommandCode source
  优先用它，再回退 `process.env`。未装本插件时行为与旧版一致。
- `oauthProviders`：每个 OAuth provider 一个 token 解析器；未登录、刷新失败都返回
  `undefined`，永不抛错。dsh-plan-usage 的 OpenAI 源、search-integrator 的 chatgpt 检索源
  都是软依赖。

## 从 dsh-oauth-providers 迁移

旧 `packages/oauth-providers` 包已删除，其实现已并入本包。**不能双挂**：两个 bundle 同时启用会
撞 route `chatgpt`、`oauthProviders` 服务、`/dsh-oauth-providers` 路由、设置页 slot id
与同一份凭据写入。

- 顺序：先从 Nix flake / profile 移除旧 bundle 并 rebuild/重启，再部署本包；仓库外的
  具体 flake 改动与命令见 [plan-more-providers-oauth-merge.md](../../docs/plan-more-providers-oauth-merge.md)。
- 旧 Cordis 行配置里的 `chatgpt:` 覆盖（若有）需要手工搬进 YAML 的 `providers.chatgpt`；
  用默认值时不用补任何条目。
- 不需要重新登录：凭据记录仍是 `oauth-providers/chatgpt`。
- 关闭 ChatGPT（`enabled: false`）不删除凭据。

## MDKJ

- `kind: custom`，`api: openai-responses`，`baseURL: https://mdkj.lol/v1`，
  `modelsURL: https://mdkj.lol/v1/models`。
- `gpt-6.1-sol` 的 fallback 是 512K 上下文 / 32K 输出、text+image、默认思考
  `low/medium/high`。
- stable / cheap 是两条独立 route，模型选择器会看到两组同名模型；自动切换暂不做（见 TODO）。
- `mdkj-*` 两个 agenix secret 目前需要先加进 `age.secrets` 并解密到
  `/run/user/<uid>/agenix/`，否则路由会休眠。

## TODO（未决）

- **多账号自动切换**：暂不实现，方案未定。候选路径：
  1. 一条 route + key 池，`resolveApiKey` 按优先级取 key，失败由 `dsh-llm-retry` 在 agent
     step 层重跑（需把 `AUTH` / `QUOTA` / `RATE_LIMIT` 纳入 `retryableCodes`，并用
     `session/event` 的 `llm/retry` 做冷却标记）；
  2. 自定义 `Provider` 包装，在首个内容块之前切换 key（真正无缝，但与 pi-ai 事件流耦合，复杂）。
  待定：`accounts` 是独立 route 还是同一 route 的 key 池、并发下如何归属 key、冷却时间、
  全失败策略。当前需要多账号时，先按独立 provider 条目手动选择，不做自动 failover。
- **通用 `extends` / 热重载**：v1 不做；`accounts` 已覆盖当前多账号需求。

## 开发 / 验证

```fish
pnpm -C packages/more-providers typecheck
pnpm -C packages/more-providers build
pnpm -C packages/more-providers smoke
```

`smoke.mjs` 覆盖 YAML 校验/继承、key 优先级、文件 mtime、builtin + custom 构建、目录发现与
fallback、Command Code 三协议映射、`providerKeys` 服务和 `apply` 注册路径；不访问网络。共享
配置库自身的路径、watch、原子替换与状态路由契约由 `packages/config` 的 Vitest 覆盖。合并后的
端到端记录（真实 OAuth 登录、GUI、真实上游推理）见
[plan-more-providers-oauth-merge.md](../../docs/plan-more-providers-oauth-merge.md) 的验证一节。

## 已知限制

- 依赖 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter`；升级 dsh 后先跑 `pnpm check` 与 smoke。
- builtin 的模型完全来自 pi-ai catalog，不能逐 model 覆盖。
- 自定义 model 的 wire-level `reasoningEfforts` 重命名 v1 不暴露；只支持同名映射。
- 多账号自动切换未实现；stable/cheap 需要手动选 route。
- ChatGPT 走的是 Codex 私有后端：模型目录与行为随上游变化，接口变动只会让 `chatgpt`
  路由报错，不影响 YAML 路由。
- ChatGPT 的五个连接参数只能改 YAML 并重启；登录本身在设置页完成。
- 登录需要能访问回环回跳的桌面浏览器，手机端只读状态。
- 配置文件是运行时数据，不在 nix store；home-manager 可以用 `home.file` 管理它。

## 卸载

```sh
dsh plugin --profile web remove dsh-more-providers
```

## 许可

GPL-3.0-or-later。ChatGPT 协议部分派生自 [werifu/dsh-oai-oauth](https://github.com/werifu/dsh-oai-oauth)（MIT），
pi-ai 适配沿用 [@earendil-works/pi-ai](https://github.com/earendil-works/pi)（MIT）；完整许可文本见
[THIRD-PARTY-NOTICE.md](THIRD-PARTY-NOTICE.md)。
