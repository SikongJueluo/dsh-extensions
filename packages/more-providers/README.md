# dsh-more-providers

**YAML 驱动的 DSH provider registry：API-key 厂商与 ChatGPT 订阅 OAuth 共用一套 provider 形状。**

0.2.0 起这里同时提供原来 `dsh-oauth-providers` 的 ChatGPT 登录：共享模块位于包内，
pi-ai 与 ChatGPT 协议都留在本包内部。**0.3.0 是破坏性变更**：`accounts` 变成账号池、
`providers.chatgpt` 必须显式声明 `kind: chatgpt`（省略即不注册）、新增 `filter`；
迁移见 [配置迁移](#配置迁移自-020)。
一份 YAML 管所有路由（provider 定义、模型目录、
账号池、密钥路径、模型过滤），ChatGPT 走宿主凭据 + 设置页登录，无需 API Key。插件按 key
可用性注册路由，并向其他插件暴露同步的 `providerKeys` 与 OAuth 的 `oauthProviders` 服务。
stock `dsh-llm-pi-ai` 由本 bundle 禁用，`deepseek-official` 仍走内置 `DEEPSEEK_API_KEY`。

| 部分 | 配置位置 | 凭据 |
|---|---|---|
| API-key 路由（`builtin` / `custom` / `command-code`） | YAML `providers.<id>` | `apiKeyFile` / `secretName` / `apiKeyEnv` |
| ChatGPT 订阅（route `chatgpt`） | YAML `providers.chatgpt`（`kind: chatgpt`） | 设置页「Providers」写入 `ctx.credentials` 的 `oauth-providers/chatgpt` |

## 快速开始

1. 构建并安装（或把 checkout 路径加进 `programs.dsh.plugins`）：

```fish
pnpm -C packages/more-providers build
dsh plugin --profile web add ./packages/more-providers
```

2. 创建 `$DSH_HOME/more-providers.yaml`（默认 `~/.dsh/more-providers.yaml`）。
   插件行的 `configFile` 可指定别的路径：相对路径以进程 cwd 为基准，支持 `~/` 展开。
   **最小合法内容就是 `providers: {}`**，此时什么都不注册——provider 与 ChatGPT 都要显式写
   （见[示例配置](#示例配置)）。
3. 重启 dsh（只在**首次安装/升级插件**时需要；之后改 YAML 会自动生效，见
   [校验与运行时](#校验与运行时)）：

```sh
systemctl --user restart dsh-web
```

4. ChatGPT：在 YAML 里写 `providers.chatgpt.kind: chatgpt`，再打开设置页「Providers」点「登录」
   按提示完成（详见 [ChatGPT 订阅（OAuth）](#chatgpt-订阅oauth)）。
5. 从旧 `dsh-oauth-providers` 迁过来时，**先把旧 bundle 移出 profile，再部署本包**，
   不能双挂；步骤见 [从 dsh-oauth-providers 迁移](#从-dsh-oauth-providers-迁移)。

## 示例配置

```yaml
# $DSH_HOME/more-providers.yaml
# secretDir 默认 $XDG_RUNTIME_DIR/agenix；通常不用写。
providers:
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
        contextWindow: 500000
        maxTokens: 32768
        input: [text, image]
    modelDefaults:                # 窗口值须确认适用于该 MDKJ 路由
      - match: '-sol$'
        contextWindow: 500000
    filter:                       # 可选：模型太多时用白/黑名单收窄
      include:
        - { match: '-(astra|sol|terra)$' }
      exclude:
        - { match: '-terra$' }
    accounts:                     # 账号池：书写顺序 = 兜底优先级
      stable:
        displayName: MDKJ Stable
        secretName: mdkj-stable-gpt-api-key
      cheap:
        displayName: MDKJ Cheap
        secretName: mdkj-cheap-gpt-api-key

  # ChatGPT 订阅：必须显式写；省略整节 = 不注册（凭据保留，写回来即恢复）。
  chatgpt:
    kind: chatgpt
    # 以下均可省，用内建默认值。
    # baseURL: https://chatgpt.com/backend-api/codex
    # refreshMarginMs: 86400000
    # defaultContextWindow: 272000
    # promptCacheKey: true
    # clientVersion: ""           # 省略/留空 = 取 npm 上 @openai/codex 最新版
```

生成的路由：`zai-coding-cn`、`opencode-go`、`moonshotai`、`minimax`、`command-code`、`mdkj`、
`chatgpt`——**一个 provider 一条路由**。`mdkj` 的 `stable` / `cheap` 两个账号合并成同一条
`mdkj` 路由的模型列表（union），账号按书写顺序做失败兜底，不各自单独成为路由。

## 配置规则

### 顶层

- `providers` **必填**；空对象合法（此时什么都不注册，包括 ChatGPT）。
- `secretDir` 可选，必须是绝对路径。
- 整份文档只认 `providers` / `providers.<id>` 这些键，未知键直接判定整份无效
  （见[校验与运行时](#校验与运行时)）。

### `providers.chatgpt`

ChatGPT 订阅走统一的 provider 形状：`kind: chatgpt`，LLM 路由固定是 `chatgpt`（保留名：
其他 provider / account 不能占用）。**省略整节 = 不注册**（凭据保留，写回来即恢复），
这与旧版本"省略即默认启用"相反。

| 字段 | 默认 | 说明 |
|---|---|---|
| `kind` | 必填 | 必须是 `chatgpt` |
| `enabled` | `true` | `false` 关闭。**只停止注册与显示，不删除凭据** |
| `displayName` | `ChatGPT (OpenAI)` | 选择器显示名 |
| `filter` | 无 | 与其它 provider 同款的模型白/黑名单 |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | Codex Responses 后端地址，绝对 http(s) URL |
| `clientVersion` | 省略/留空 = 取 npm 上 `@openai/codex` 最新版 | 报给后端的 client 版本 |
| `refreshMarginMs` | `86400000`（24h） | 距过期多久开始刷新 OAuth 授权（正整数，毫秒） |
| `defaultContextWindow` | `272000` | 后端没有描述上下文窗口时的兜底（正整数） |
| `promptCacheKey` | `true` | 按会话派生 `prompt_cache_key` + session-affinity 头，让后端提示缓存把同一会话路由到同一节点 |

- **不接受** key / `api` / `catalog` / `accounts` / `routeId`（登录凭据走设置页 OAuth，
  不是 API key）；违反会指向正确写法报错。
- 该节同样严格校验：出现未知键或非法值（非字符串 `clientVersion`、非 http(s) 的
  `baseURL`、非正整数的毫秒/窗口）会让整份 YAML 无效——**即使 `enabled: false` 也会校验**，
  免得留下一个以后打开才炸的配置。

### `kind`

| kind | 含义 | 必填 |
|---|---|---|
| `builtin` | 使用 pi-ai 内置 catalog（ZAI / OpenCode / Moonshot / MiniMax …） | `catalog` 可省，默认 provider id；**不接受** `api` / `baseURL` / `modelsURL` / `models` / `contextWindows` / `modelDefaults` / `compat` / `headers` / `zdr` |
| `custom` | 手写 OpenAI/Anthropic 兼容 endpoint | `api`、`baseURL`；`modelsURL` 或 `models` 至少一个 |
| `command-code` | Command Code 的混合协议目录 | 只有 key；可选 `baseURL` / `modelsURL` / `zdr` |
| `chatgpt` | ChatGPT 订阅（OAuth，见上） | 只有 `kind` 必填 |

`api` 只支持 `openai-completions`、`openai-responses`、`anthropic-messages`。

所有 provider 都接受 `enabled`（默认 `true`）与 `routeId`（默认 = YAML 键名，不能占用保留名
`chatgpt`）。`enabled: false` 的 provider 仍会被完整校验、仍出现在设置页状态里（标「未启用」），
但不注册路由。

### `accounts`（账号池）

写 `accounts` 时，这些账号**合成一条路由**（路由名 = provider 键名或 `routeId`），不再是
"一账号一路由"：

- 每个 account 只需 `displayName`、`enabled` 与 key 三选一；**书写顺序 = 兜底优先级**
  （第一个是首选）。顺序会影响**每次请求先用哪个账号**、以及 fallback 的顺序。
- 账号共享 provider 的 `api` / `baseURL` / `modelsURL` / `models` / `contextWindows` /
  `modelDefaults` / `compat` / `headers` / `zdr`：**在 account 上写这些字段会直接判配置错误**
  并给出迁移提示（池内账号必须是同一个上游的不同凭据）。
- `enabled: false` 跳过该 account；显式 `displayName` 只影响设置页显示。
- 池的模型列表是所有账号目录的 **union**：同 id 合并（元数据按账号顺序先到先得），不同 id
  各自保留。某个模型只在一个账号上存在时，那个账号不可用就没有兜底。
- 失败切换只在**首个内容块之前**发生：请求还没吐出任何内容时按优先级换下一个账号重发；
  已经产出内容的请求不会中途换账号。
- `accounts` 可以只有一个成员（等价于单账号 provider）。

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

需要按精确 ID 覆盖时仍可用 `contextWindows`（**只在 provider 级**；account 上写会判配置错误）：

```yaml
contextWindows:
  gpt-6.2-sol: 272000 # 示例值；请填已确认适用于该路由的窗口
```

目录返回的窗口和 `models` 中显式配置的 `contextWindow` 优先于此映射。此配置不添加模型，
只为目录或静态列表中已有的模型补窗口；思考强度仍由各模型的 `reasoning` 字段配置，或用
`modelDefaults` 批量补。

`reasoning` 是字符串数组，内部映射为 pi-ai 的 `reasoningEfforts` 同名 wire 值；默认不暴露
`off`（要关就整个 `reasoning: false`），数组里写 `off` 才会出现该档。

`modelsURL` 拉取成功时优先用目录；目录缺的字段会由同 id 的静态 `models` 补齐。目录失败/为空时
整体回退静态 `models`；两者都没有则跳过该 provider（只影响这一条路由）。

### 过滤（`filter`）

模型太多时用 `filter` 把不用的挡在选择器之外：白名单 `include` + 黑名单 `exclude`，条目是
`{ match, flags? }`（标准 JS 正则、不自动加锚点、`flags` 可选），**只匹配模型 id**，不匹配显示名：

```yaml
providers:
  zai-coding-cn:
    kind: builtin
    secretName: zhipu-coding-api-key
    filter:
      include:
        - { match: '^glm-' }          # 白名单：只放出 glm 系列
      exclude:
        - { match: '-thinking$' }     # 黑名单：再从其中剔掉思考版
        - { match: '-free$', flags: 'i' }
```

- `exclude` **永远优先**：同时命中白名单与黑名单的 id 会被滤掉。
- `include` 缺省或空数组合法 = 全放行；`filter` 至少要有 `include` / `exclude` 之一。
- 只在 provider 级配置（作用于整个账号池的 union 列表）；写成 account 级或 model 条目里
  直接判配置错误。
- **无效正则会作废整份 YAML**（报错带 `providers.<id>.filter...` 路径，指出是哪一条）；写成
  `enabled: false` 的 provider 也照样校验，免得留下一个以后再打开才炸的配置。
- 过滤是**硬删**：该模型在选择器、`resolveModel`、默认模型三处一致地不存在；引用被滤掉模型的
  老会话下次请求会拿到 `UNKNOWN_MODEL`，手动换模型即可。
- 某个 provider 被滤到 0 个模型时**整条 route 不注册**（log warn，状态页记原因）。
- ChatGPT 的动态目录同样会被过滤；但它的路由不会因滤空而被撤销（动态撤销会切断在途会话）。
- 被滤掉的 id 与被滤原因会显示在设置页「Providers」分区的对应卡片上。

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
- **登录 UI**：设置页「Providers」分区（slot `dsh-oauth-providers`、locale 命名空间
  `oauth-providers`，沿用旧包标识以兼容）。卡片由宿主**实际注册**的 provider 列表决定：
  没配 `providers.chatgpt` 时该卡不出现，客户端不假设它一定存在。一张卡同时承载登录管理
  （登录状态、刷新、已登录时多一个「退出登录」）与模型统计（目录 N → 生效 M、被过滤 id、
  目录失败告警）。分区挂载期间每 10s 重新拉取一次快照（页面不可见时跳过），登录/刷新/退出
  完成后再立即刷新，所以懒加载的目录统计最多一个轮询周期后就会出现。列表读取失败（路由未挂载、
  鉴权拒绝、网络错误）时分区显示本地化错误与「重试」。
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
  没有任何 key source、重复或保留的 route id、account 上写了池化后归 provider 的字段、
  非法 `filter` 正则、`providers.chatgpt` 的未知键/非法值等，会让整份 YAML 不生效；插件只
  log error、不崩 dsh，并且**不注册任何 provider 行**。**写成 `enabled: false` 的 provider
  同样会被完整校验**，免得留下一个以后打开才炸的配置。
- **文件缺失同样整份无效**：`$DSH_HOME/more-providers.yaml` 不存在或没有 `providers` 键时
  没有可注册内容。
- **Web 错误提示**：Host 在 `/dsh-more-providers/config-status` 暴露配置状态（文件、错误、
  revision、恢复方式），浏览器半经 `shell.overlay` 显示 toast（复用共享 `ConfigStatusToast`）。
  多个 preset 实例共享同一条路由并聚合返回 `instances`。
- **Providers 只读状态页**：Host 在 `/dsh-more-providers/providers` 暴露每个 provider 的
  运行快照（route、kind、auth、是否启用/注册、账号与健康态、模型计数「目录 N → 生效 M」、
  被过滤的 id、目录失败原因）。设置页「Providers」分区把它渲染成只读卡片；数据只读，不在这里
  编辑配置。
- **运行时目录失败按 provider 隔离**：`modelsURL` 超时/非 2xx/坏 JSON/空列表时用静态 `models`
  fallback（状态页记 `catalogError`）；没有 fallback 才不注册该 provider，其他 provider 照常。
- **被 `filter` 滤空**：该 provider 整条路由不注册并 log warn，状态页给出原因。
- **key 缺失**是正常休眠，不算配置错误；**未登录**只影响 `chatgpt` 路由。
- **改完 YAML 自动生效**：插件监听 `$DSH_HOME` 里那份文件（目录级监听，原子替换与 Nix
  symlink 交换都能捕获），校验通过就重建 provider 行并原子替换注册，不需要重启 dsh。
  连续多次保存只应用最后一次；**校验失败时保留上一版可用配置**（页面明确写"上一版仍在生效"），
  修好保存后自动恢复。设置页顶部的「配置第 N 版」在应用成功时递增。
- **启动期与重载期的失效处理不同**：启动时读到无效配置 → 什么都不注册（fail-closed）；
  运行期文件变坏 → 旧注册继续服务，只报状态。这是刻意的：重启是冷启动，重载不能把正在用的
  路由抽走。

## 服务

两个宿主服务都从本包注册：

```ts
ctx.get('providerKeys')?.key('zai-coding-cn')          // string | undefined
ctx.get('providerKeys')?.accounts('mdkj')              // 账号池快照（id / displayName / 健康态）
await ctx.get('oauthProviders')?.token('chatgpt')      // { access, accountId? } | undefined
ctx.get('oauthProviders')?.providers()                 // 可发 token 的 provider id
```

- `providerKeys.key(route)`：返回该路由**当前优先级最高且不在冷却中**的 key；全部冷却时退回
  最高优先级那个（避免下游把"正好在冷却"误判成"没配 key"）。dsh-plan-usage 的 GLM / OpenCode /
  MiniMax / CommandCode source 优先用它，再回退 `process.env`。
- `providerKeys.accounts(route)`：只读账号列表，`{ id, displayName, keyPresent, healthy?,
  cooldownUntil? }[]`，顺序即优先级。**不返回 key 值**（key 只经 `key(route)` 这一个出口）。
- `oauthProviders`：每个 OAuth provider 一个 token 解析器；未登录、刷新失败都返回
  `undefined`，永不抛错。dsh-plan-usage 的 OpenAI 源、search-integrator 的 chatgpt 检索源
  都是软依赖。未配置 `providers.chatgpt` 时该服务不存在。

## 配置迁移（自 0.2.0）

0.3.0 有三条破坏性变化，旧 YAML 会被**整份拒绝并给出指向新写法的报错**：

| 旧写法 | 新写法 |
|---|---|
| `accounts` 下每项生成 `${provider}-${account}` 独立路由 | `accounts` 是同一路由下的**账号池**，书写顺序 = 兜底优先级 |
| account 上写 `routeId` / `api` / `baseURL` / `modelsURL` / `models` / `contextWindows` / `compat` / `headers` / `zdr` | 全部提到 provider 级；池内账号必须共享上游 |
| 省略 `providers.chatgpt` = 默认启用 | **省略 = 不注册**；要启用就写 `chatgpt: { kind: chatgpt }` |
| `providers.chatgpt` 特殊节（无 `kind`） | `kind: chatgpt` |
| `filter` 写在 account 或 model 条目里 | 只在 provider 级 |

`agent-default-model` 之类引用旧 route id 的地方也要跟着改（`provider: mdkj-stable` →
`provider: mdkj`），老会话里已选中的 `mdkj-stable/*` 模型需要重新选一次。

`providerKeys.key(route)` 的签名不变，但语义变成"该路由当前优先级最高且不在冷却中的账号 key"。

## 从 dsh-oauth-providers 迁移

旧 `packages/oauth-providers` 包已删除，其实现已并入本包。**不能双挂**：两个 bundle 同时启用会
撞 route `chatgpt`、`oauthProviders` 服务、`/dsh-oauth-providers` 路由、设置页 slot id
与同一份凭据写入。

- 顺序：先从 Nix flake / profile 移除旧 bundle 并 rebuild/重启，再部署本包；仓库外的
  具体 flake 改动与命令见 [plan-more-providers-oauth-merge.md](../../docs/plan-more-providers-oauth-merge.md)。
- 旧 Cordis 行配置里的 `chatgpt:` 覆盖（若有）需要手工搬进 YAML 的 `providers.chatgpt`，
  并补上 `kind: chatgpt`；用默认值时也要写这行（省略即不注册）。
- 不需要重新登录：凭据记录仍是 `oauth-providers/chatgpt`。
- 关闭 ChatGPT（`enabled: false` 或整节省略）不删除凭据。

## MDKJ

- `kind: custom`，`api: openai-responses`，`baseURL: https://mdkj.lol/v1`，
  `modelsURL: https://mdkj.lol/v1/models`。
- `gpt-6.1-sol` 的 fallback 是 500K 上下文 / 32K 输出、text+image、默认思考
  `low/medium/high`。
- `stable` / `cheap` 是同一个 `mdkj` 路由下的**账号池**：选择器里只有一组模型（两账号目录的
  union），请求默认走 `stable`，它不可用时自动落到 `cheap`；设置页能看到两个账号各自的健康态。
- `mdkj-*` 两个 agenix secret 目前需要先加进 `age.secrets` 并解密到
  `/run/user/<uid>/agenix/`，否则该账号不参与池。

## TODO

- **通用 `extends`**：v1 不做；`accounts` 已覆盖当前多账号需求。
- **跨 provider 兜底**：不做。同名模型在不同 provider 上语义/参数/计费都不同，真要做只能是
  显式的"模型别名组"，属另一个特性。
- **主动探活**：不做。账号健康态只来自真实请求失败，不额外发探测请求。

## 开发 / 验证

```fish
pnpm -C packages/more-providers typecheck
pnpm -C packages/more-providers build
pnpm -C packages/more-providers smoke
```

`smoke.mjs` 覆盖 YAML 校验/迁移拒绝、key 优先级与池、文件 mtime、builtin + custom 构建、
目录发现与 fallback、`filter`、Command Code 三协议映射、`providerKeys` 服务和 `apply`
注册路径；不访问网络。共享配置库自身的路径、watch、原子替换与状态路由契约由
`packages/config` 的 Vitest 覆盖。阶段化实施记录见
[plan-more-providers-unified-providers.md](../../docs/plan-more-providers-unified-providers.md)。

## 已知限制

- 依赖 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter`；升级 dsh 后先跑 `pnpm check` 与 smoke。
- builtin 的模型完全来自 pi-ai catalog，不能逐 model 覆盖。
- 自定义 model 的 wire-level `reasoningEfforts` 重命名 v1 不暴露；只支持同名映射。
- **账号切换只发生在首个内容块之前**：已经产出内容的请求不会中途换账号（那需要重放历史，
  由 `dsh-llm-retry` 的 step 重放负责，本插件不重复造）。
- **独占模型没有兜底**：某个模型只在一个账号的目录里时，那个账号不可用就直接失败。
- **ChatGPT 的模型硬拒有个启动期例外**：进程刚启动、目录还没成功加载过一次时（内部
  `view === null`），用任意模型 id 发起的请求不会被本地拒绝，而是照常打到上游由后端判定；
  目录成功加载之后，被 `filter` 滤掉或上游已删除的模型会在 `resolveModel` 与 `stream`
  两处直接返回 `UNKNOWN_MODEL`（不发网络请求）。
- **ChatGPT 不因滤空而撤销路由**：`registered` 是"适配器已挂载"的意思；目录被 filter 全滤掉时
  选择器里该组自然消失并 log warn，但路由保留（动态撤销会切断在途会话）。
- ChatGPT 走的是 Codex 私有后端：模型目录与行为随上游变化，接口变动只会让 `chatgpt`
  路由报错，不影响 YAML 路由。
- ChatGPT 的连接参数改 YAML 后自动生效；登录本身在设置页完成。
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
