# more-providers：模型过滤 + 统一 provider 框架 + 账号池（实施计划）

日期：2026-11-20。状态：**已实现并验证**（三个阶段全部落地，见 §14 验证记录）。
本文是实施契约；实现中任何偏离都要先回来改这份文档，再改代码。

宿主边界照旧：`~/.dsh`、flake、`dsh plugin` 与重启 dsh-web 都由用户执行。本计划只产出仓库
内的代码、测试、文档与一份供用户落 flake 的 YAML 片段。

## 0. 一句话

把 `dsh-more-providers` 从"两套互不相干的 provider 家族"（pi-ai API-key 路由 / ChatGPT OAuth
路由）整理成一条流水线——`ProviderSpec → 目录定型（合并 / 元数据默认值 / **过滤**）→ 适配器注册`
——在它上面做两件事：**模型过滤（白名单 + 黑名单）** 和 **账号池 + 首个 chunk 前的自动切换**；
同时把配置面统一到 `providers.<id>`，`accounts` 直接变成池（**不保留旧语义**）。

## 1. 已定决策

| # | 决策 | 影响 |
|---|---|---|
| 1 | 过滤配置放 `more-providers.yaml`，改完重启生效 | 不碰插件行 `Config`；设置页只读 |
| 2 | 过滤覆盖 `builtin` / `custom` / `command-code`（含 accounts）与 `chatgpt`；**不做**顶层全局 filter | 每个 provider 一段 `filter` |
| 3 | 匹配用正则：条目 `{ match, flags? }`，与 `modelDefaults` 同款（标准 JS 正则、不自动加锚点、无效正则让整份 YAML 失效）；**只匹配模型 id**，不匹配 `name`；`include` 白名单（缺省=全放行）+ `exclude` 黑名单，**exclude 优先** | `config.ts` 校验 + 独立 filter 模块 |
| 4 | **硬删**：过滤后的模型在注册时就不存在（选择器 / `resolveModel` / 默认模型三处一致）；被滤到 0 个模型的 provider **整条 route 不注册 + warn** | 引用被滤掉模型的老会话下次请求报 `UNKNOWN_MODEL`，需换模型 |
| 5 | 一个 provider = 一条 route（默认 = YAML key，可选 `routeId` 覆盖）+ 一份合并模型列表 + 账号池；池内账号必须共享 `api` / `baseURL` / `modelsURL`；**不保留** `${provider}-${account}` 旧 route 语义 | breaking：`mdkj-stable` / `mdkj-cheap` 消失 |
| 6 | 目录合并 = **union**：同 id 合并（元数据按账号顺序先到先得），不同 id 各自保留；每个模型记录"哪些账号有它"，切换只在有该模型的账号间进行；独占模型无兜底 | 启动期按账号各拉一次目录（并发），零新增请求 |
| 7 | 切换只在 **adapter 层**、只在**首个 chunk 之前**；已产出内容后不切（那只能靠 `dsh-llm-retry` 的 step 重放，不复用不重造） | `FailoverPiAiAdapter extends PiAiAdapter` |
| 8 | 阶段按**流水线**切：阶段一 = 目录定型 + 过滤 + 设置页只读；阶段二 = 注册编排 + 配置面统一 + 账号池 + 切换 | 每阶段独立可合并、门禁全绿 |
| 9 | 共享层只抽"目录定型"与"注册编排"；**不为 auth / transport 造多态接口**；`ProviderSpec` 用判别式联合 + `switch` | 避免无第二消费者的抽象（本仓 fallow / code-craft 门禁） |
| 10 | 配置面统一但 `kind` 仍是用户可见判别式（`builtin` / `custom` / `command-code` / `chatgpt`）；不暴露新 host 注册服务；OAuth 多账号只留接口 | `providers.chatgpt` 变成 `kind: chatgpt` 的一个实例 |
| 11 | 设置页合并成单个 Providers 分区（slot id 仍 `dsh-oauth-providers`），**只读**，无编辑/保存/重置按钮 | 复用 `@dsh-extensions/ui` + 宿主 primitives |
| 12 | 三档失败分类（见 §6.2）+ 账号级指数冷却 5min→1h、成功清零、尊重 `providerRetryAfterMs`、仅内存 | 单请求最多尝试 `min(池内可用账号数, 3)` 次 |
| 13 | 会话粘性：同 session 固定同一账号（`options.sessionId`）；`accounts` 书写顺序即优先级；并发不排队不限流 | 吃 prefix cache、行为稳定 |
| 14 | 不做跨 provider 兜底 | 同名模型跨 provider 不合并 |
| 15 | 启动期账号目录失败：有静态 `models` → 按静态定型（覆盖 = 静态列表）；无静态 → 该账号不纳入池 + warn；池空 → route 不注册；各账号目录**并发**拉取 | 粒度从 route 降到 account |
| 16 | `providerKeys.key(route)` = 最高优先级且不在冷却中的账号 key（全冷却时仍返回最高优先级）；新增只读 `accounts(route)` | 下游 `dsh-plan-usage` 契约不变 |
| 17 | 先本文档后代码；验证口径见 §8 | — |
| 18 | **YAML 热加载纳入本次**（阶段三，在阶段二之后）：`watch: true` → 校验通过就重建并原子替换注册，校验失败保留上一份注册并在状态里报 invalid；账号健康态按 id 跨重建保留 | 不再需要"改完重启 dsh"；`recovery` 从 `restart` 改 `auto` |

## 2. 新 YAML 契约

### 2.1 形状

```yaml
providers:
  zai-coding-cn:                     # builtin：只需 key，可选 filter
    kind: builtin
    secretName: zhipu-coding-api-key
    filter:
      exclude:
        - { match: '.*-thinking$' }
        - { match: '.*-free$', flags: 'i' }

  mdkj:                              # custom + 账号池：route 就叫 mdkj
    kind: custom
    displayName: MDKJ
    api: openai-responses
    baseURL: https://mdkj.lol/v1
    modelsURL: https://mdkj.lol/v1/models
    models: [...]                    # 目录失败 / 缺字段时的 fallback 与 metadata（语义不变）
    modelDefaults: [...]
    filter:
      include:
        - { match: '-(astra|sol|terra)$' }
      exclude:
        - { match: '-terra$' }
    accounts:                        # 池：书写顺序 = 优先级
      stable: { displayName: MDKJ Stable, secretName: mdkj-stable-gpt-api-key }
      cheap:  { displayName: MDKJ Cheap,  secretName: mdkj-cheap-gpt-api-key }

  command-code:
    kind: command-code
    displayName: Command Code
    secretName: commandcode-api-key
    filter: { exclude: [{ match: '.*-preview$' }] }

  chatgpt:                           # 从特殊节变成普通 provider 实例；route id 仍保留
    kind: chatgpt
    enabled: true
    baseURL: https://chatgpt.com/backend-api/codex
    refreshMarginMs: 86400000
    defaultContextWindow: 272000
    promptCacheKey: true
    filter: { exclude: [{ match: '-mini$' }] }
```

### 2.2 字段

| 字段 | 适用 kind | 语义 |
|---|---|---|
| `kind` | 全部 | 判别式：`builtin` / `custom` / `command-code` / `chatgpt` |
| `enabled` | 全部（**新增**） | `false` 不注册该 route（凭据不动） |
| `displayName` | 全部 | 选择器里的 provider 名；默认 = route id |
| `routeId` | 全部（可选） | 覆盖注册的 route id；默认 = YAML key |
| `filter.include` / `filter.exclude` | 全部 | 见 §1 决策 3；条目 `{ match: string, flags?: string }`，非空数组；两段都可省 |
| `accounts.<id>` | `builtin` / `custom` / `command-code` | 池成员：`displayName` / `enabled` / key 三选一。**不再接受** `routeId`、`api`、`baseURL`、`modelsURL`、`models`、`contextWindows`、`compat`、`headers`、`zdr`（池内必须一致，违反 → 配置错误 + 迁移提示） |
| 连接参数 | `chatgpt` | 现有五个（`baseURL` / `clientVersion` / `refreshMarginMs` / `defaultContextWindow` / `promptCacheKey`）原样搬入；**不接受** key / `accounts` / `api` |

保留名 `chatgpt` 不变；凭据地址 `oauth-providers/chatgpt` 不变（升级无需重登）。

### 2.3 会被 fail-closed 拒绝的旧写法（报错必须带迁移提示）

| 旧写法 | 新写法 |
|---|---|
| `providers.chatgpt` 作为特殊节（无 `kind`） | `providers.chatgpt.kind: chatgpt` |
| account 写 `routeId` / `api` / `baseURL` / `modelsURL` / `models` / `contextWindows` / `compat` / `headers` / `zdr` | 提到 provider 级；池内账号必须共享 |
| 期望 `${provider}-${account}` 两条 route | 只有 `${provider}` 一条 route |
| `filter` 写在 `models:` 里或 account 上 | 只在 provider 级 |

## 3. 代码结构

### 3.1 阶段一（目录定型 + 过滤 + 设置页只读）

| 文件 | 性质 | 改动 |
|---|---|---|
| `src/catalog/filter.ts` | 新 | `compileModelFilter({include, exclude})` → `ModelFilter`；`applyFilter(models)`；正则编译/校验错误沿用 `modelDefaults` 的风格 |
| `src/catalog/finalize.ts` | 新 | 从 `providers.ts:249-295` 移出 `matches` / `modelMetadata` / `mergeModels`，产出统一的 `NormalizedModel[]`，末尾过 filter |
| `src/providers.ts` | 改 | `builtinProvider` / `customProvider` / `commandCodeProvider` 改调 `finalizeCatalog`；删除搬走的函数；`MODELS_TIMEOUT_MS` 保持 |
| `src/providers/chatgpt/catalog.ts` | 改 | 目录输出过同一 `finalizeCatalog`（chatgpt 没有 `modelDefaults`/`contextWindows`，只走 filter + 默认元数据），使 `listModels` / `discovery` / `refresh` 三处口径一致 |
| `src/config.ts` | 改 | `filter` 解析与校验（provider 级 + `chatgpt` 节）；解析结果带上编译后的 `ModelFilter`（阶段一实现时字段挂在当时的 `ResolvedProvider`/`ResolvedChatGptConfig` 上，阶段二已改为 `ProviderSpec` 家族） |
| `src/status.ts` | 新 | 只读快照路由 `/dsh-more-providers/providers`：route、kind、auth、账号列表、模型计数（目录 N → 生效 M）、被过滤 id、目录失败原因 |
| `src/client/oauth.tsx` → `src/client/providers.tsx` | 改 | 分区 label 改「Providers」；保留 OAuth 卡片；新增 provider 只读卡片 |
| `test/filter.test.ts` | 新 | 白/黑名单、优先级、空组、非法正则、flags |
| `test/chatgpt-filter.test.ts` | 新 | 动态目录过滤（listModels / discovery 一致） |
| `test/config.test.ts` | 改 | `filter` 校验、account 不得覆盖 filter |
| `test/apply.test.ts` | 改 | 注册后的 `listModels` 只含生效模型；滤空 route 不注册 |
| `smoke.mjs` | 改 | 过滤用例 + 定型输出 |

### 3.2 阶段二（注册编排 + 配置面统一 + 账号池 + 切换）

| 文件 | 性质 | 改动 |
|---|---|---|
| `src/providers/spec.ts` | 新 | `ProviderSpec` 判别式联合 + `ResolvedConfig → spec` 映射（auth / catalog 计划 / adapter 计划） |
| `src/providers/registry.ts` | 新 | 统一 build + 注册编排：把 `providers.ts` 的目录构建器与 `chatgpt/index.ts` 的注册段收敛成 `buildRoutes(specs, log)` / `registerRoutes(ctx, built, deps)` 一条路径 |
| `src/providers/pool.ts` | 新 | 优先级、per-model 覆盖映射、会话粘性、冷却（指数 5min→1h、`providerRetryAfterMs`、成功清零） |
| `src/providers/failover.ts` | 新 | `FailoverPiAiAdapter extends PiAiAdapter`：重写 `stream()`；两种失败形态（抛 `LlmError` / in-band `finish{kind:'error'}`）；抑制失败尝试的 `usage` chunk；尝试上限 `min(可用,3)` |
| `src/config.ts` | 改 | `accounts` → 池；拒绝池内覆盖字段（带迁移提示）；`kind: chatgpt`；全 provider `enabled` |
| `src/keys.ts` | 改 | `ProviderKeys.key(route)` 池语义；新增 `accounts(route)` |
| `src/index.ts` | 改 | 单条注册路径；chatgpt 也走 registry；`enable`/routeId 生效 |
| `src/client/providers.tsx` | 改 | 账号优先级、健康态（正常/冷却中）、模型数展示 |
| `src/status.ts` | 改 | 增加池运行期状态（健康态、冷却截止、当前粘性账号统计） |
| `test/pool.test.ts`、`test/failover.test.ts`、`test/config-migration.test.ts` | 新 | 优先级/粘性/冷却/覆盖映射；首 chunk 前切换、chunk 后不切、usage 抑制、错误后保留原码；旧写法拒绝 + 提示 |
| `test/api-key-images.test.ts`、`test/image-contract.ts` | 改 | 池化后仍逐请求注入 key，图片契约不回归 |

`src/runtime.ts`（宿主图片服务）、`src/oauth/*`（登录通道 / token 服务）不动。

## 4. 阶段一验收

1. `pnpm -C packages/more-providers typecheck`
2. `pnpm -C packages/more-providers build`
3. `pnpm -C packages/more-providers test`
4. `node packages/more-providers/smoke.mjs`
5. `pnpm check:quality`（全部门禁，见 [AGENTS.md](../AGENTS.md)；格式/注释/lint/fallow/typecheck/build/test/smoke/client 产物缺一不可）
6. 独立端口手验：模型选择器里过滤前/后的组内模型变化；滤空 provider 消失；设置页 Providers 分区显示「目录 N → 生效 M」与被过滤 id

## 5. 阶段二验收

1. 上述 1–5 全绿
2. 手验：`accounts` 两条 route 变一条、选择器只有一个 MDKJ 组、模型是 union
3. 手验：把 `stable` 的 secret 换成无效值 → 请求自动落到 `cheap`，设置页显示 `stable` 冷却中
4. 手验：删除某账号的 secret 文件 → 该账号不纳入池，route 仍注册
5. `dsh-llm-retry` 交互：三个账号全挂时错误码原样上抛（不被 wrapper 改写）

## 6. 行为边界

### 6.1 池与覆盖

- `route` 一条；模型列表 = union；`coverage: modelId → 账号 id 列表`（按 priority 排序）。
- 粘性键 = `options.sessionId`；无 `sessionId`（一次性调用）→ 每次取最高优先级健康账号。
- 独占模型：只有该账号挂了才失败，**不**换成别的账号的同名/相似模型。
- **coverage 是权威**：不在 coverage 里的模型没有任何候选账号，`acquire()` 返回 undefined，
  `stream()` 明确抛 `UNKNOWN_MODEL`（零 chunk、零上游调用）。不做"未列出的模型走全池兜底"——
  pi-ai 路线在 `resolveModel` 层已经拒绝非目录模型，走到这里就说明是我们自己的内部不一致，
  本地大声失败比让上游去猜好。**不变量**：每个 route 注册的模型 id ⊆ coverage 的键集，
  由测试钉住（构建期抓漏，而不是请求期）。
- 池空 / 全部冷却：`resolveApiKey` 仍给最高优先级账号的 key（让请求去撞一次真实错误，而不是在本地静默失败）。

### 6.2 失败分类

| 档 | 码 | 动作 |
|---|---|---|
| 账号级 | `AUTH`（含 401/403）、`QUOTA`、`INVALID_CREDENTIAL`、`ACCOUNT_QUOTA`、`ACCOUNT_TOKEN_INVALID`、`ACCOUNT_SIGN_IN_REQUIRED` | 切下一个 + 账号冷却（指数 5min→1h、成功清零；有 `providerRetryAfterMs` 用该值） |
| 抖动级 | `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`STREAM_CLOSED`、`EMPTY_RESPONSE`、`MALFORMED_RESPONSE`、`PI_AI_ERROR` | 切下一个，**不**标记账号坏 |
| 不切 | `ABORTED`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`UNKNOWN_MODEL`、`MODEL_UNSUPPORTED`、`UNSUPPORTED_*` | 原样抛 |

全失败 → 抛最后一个失败（code 原样），交给 `dsh-llm-retry` 按 provider `retryPolicy` 处理；
叠加关系固定为「先切账号、后 step 重放」，两层不互相抢。

### 6.3 明确不做

- 已产出内容后的切换（唯一干净路径是 `dsh-llm-retry` 的 step 重放）
- 跨 provider 兜底 / 模型别名组
- 主动探活（不跑额外探测请求）
- 健康态落盘（重启清零是特性：让坏账号有机会被重新试探）
- `chatgpt` 参与池（单 OAuth 账号；接口留位置）
- per-model 优先级覆盖 / per-account filter
- 过滤的运行期热更新（见 §9）

## 7. 迁移与破坏面

1. **用户 YAML**（`~/.dsh/more-providers.yaml`，home-manager 软链）：
   `mdkj.accounts` 保留但 `mdkj-stable` / `mdkj-cheap` 两条 route 消失；新增 `filter`；
   `chatgpt` 节补 `kind: chatgpt`。片段由本计划提供，用户落 flake。
2. **引用旧 route 的地方**：`agent-default-model`、会话里已选中的模型、任何写死
   `mdkj-stable` / `mdkj-cheap` 的配置都要改成 `mdkj` + 具体模型。
3. **README**（368 行，事实上的规范文档）要改的章节：`accounts`、`providers.chatgpt`、`模型`、
   `校验与运行时`、`服务`、`MDKJ`、`TODO`、`已知限制`，并新增 `filter` 一节。
4. `example.yaml`、`smoke.mjs`、`test/config.test.ts`、`test/apply.test.ts`、
   `test/model-defaults.test.ts` 同步更新。
5. **下游契约不变**：`providerKeys.key(route)`、`oauthProviders.token('chatgpt')`、
   route `chatgpt`、凭据地址、RPC 前缀 `/dsh-oauth-providers`、设置分区 slot id。

### 7.1 用户 YAML 迁移片段（`~/.dsh/more-providers.yaml`，落 flake）

**注意两条超出 `accounts` 的破坏性变化**：

1. **`providers.chatgpt` 省略 = 不注册**（以前省略整节即"默认启用 + 内建默认值"）。统一成
   `kind: chatgpt` 的普通 provider 实例后，"YAML key 存在才有实例"是唯一规则；要保留 ChatGPT
   就必须显式写 `chatgpt: { kind: chatgpt }`。`providers: {}` 仍合法，但什么都不注册。
2. account 不再生成 route：`mdkj-stable` / `mdkj-cheap` 消失，只剩 `mdkj`（模型列表为两账号的
   union，账号按书写顺序做兜底）。

```yaml
providers:
  zai-coding-cn: { kind: builtin, secretName: zhipu-coding-api-key }
  opencode-go: { kind: builtin, secretName: opencode-api-key }
  moonshotai: { kind: builtin, secretName: moonshot-api-key }
  minimax: { kind: builtin, secretName: minimax-coding-api-key }

  command-code:
    kind: command-code
    displayName: Command Code
    secretName: commandcode-api-key

  mdkj:                       # route 就是 mdkj
    kind: custom
    displayName: MDKJ
    api: openai-responses
    baseURL: https://mdkj.lol/v1
    modelsURL: https://mdkj.lol/v1/models
    models:
      - { id: gpt-6.1-sol, name: GPT-6.1 Sol, contextWindow: 500000, maxTokens: 32768, input: [text, image] }
    modelDefaults:
      - { match: '-astra$', contextWindow: 272000 }
      - { match: '-sol$', contextWindow: 500000 }
      - { match: '-terra$', contextWindow: 272000 }
      - { match: '-(astra|sol|terra)$', reasoning: [low, medium, high, xhigh, max] }
    # filter:                 # 模型太多时在这里加白/黑名单
    #   exclude: [{ match: '-terra$' }]
    accounts:                 # 书写顺序 = 兜底优先级
      stable: { displayName: MDKJ Stable, secretName: mdkj-stable-gpt-api-key }
      cheap:  { displayName: MDKJ Cheap,  secretName: mdkj-cheap-gpt-api-key }

  mdkj-deepseek:
    kind: custom
    displayName: MDKJ DeepSeek
    api: openai-completions
    baseURL: https://mdkj.lol/v1
    modelsURL: https://mdkj.lol/v1/models
    compat:
      thinkingFormat: deepseek
      supportsReasoningEffort: true
      requiresReasoningContentOnAssistantMessages: true
    models:
      - { id: deepseek-v4-pro, contextWindow: 1000000, maxTokens: 393216, reasoning: [off, low, medium, high, max] }
      - { id: deepseek-v4.1-flash, contextWindow: 1000000, maxTokens: 393216, reasoning: [off, low, medium, high, max] }
      - { id: deepseek-v4.1-flash-1017, contextWindow: 1000000, maxTokens: 393216, reasoning: [off, low, medium, high, max] }
      - { id: qwen4-max, contextWindow: 983616, maxTokens: 131072, reasoning: [low, high, xhigh] }
    accounts:
      stable: { displayName: MDKJ DeepSeek Stable, secretName: mdkj-stable-deepseek-api-key }
      cheap:  { displayName: MDKJ DeepSeek Cheap,  secretName: mdkj-cheap-deepseek-api-key }

  # 你要保留 ChatGPT 订阅时才有这一段；省略 = 不注册（凭据保留，重新写回来即恢复）
  # chatgpt:
  #   kind: chatgpt
```

引用旧 route 的地方要一起改：`agent-default-model` 之类的 `provider: mdkj-stable` → `provider: mdkj`，
以及老会话里已选中的 `mdkj-stable/*` 模型选择。

## 8. 验证口径

- 每阶段：§4 的 1–5 全部跑通（`pnpm check:quality` 是合并门槛）。
- UI 验证：本会话对 `~/.dsh` 不可写（systemd / nix 管理），所以
  1. 我起一个**独立 DSH_HOME 的临时 profile**（workspace 内或 `/tmp`），
     `--patch packages/more-providers/dev.patch.yml --no-open --port 3081`（9090 属于 mihomo），
     在真实 Web 里点选择器与设置页；构建产物变化需重启该进程。
  2. 你在 `dsh-web` 上验证：flake 更新 YAML → `systemctl --user restart dsh-web` → 3080。
- 需要用户执行的步骤在交付时单独列出（flake 片段、重启、真机点验）。

## 9. 阶段三：YAML 热加载（纳入本次）

共享库 `@dsh-extensions/config` 已提供所需机制：`watch: true`（目录级监听、80ms 去抖、
generation guard、原子替换 / **Nix symlink 交换** / 删除重建都能重载）、`store.subscribe`、
`store.state().revision`；宿主侧 `registerAdapter` 返回的 handle 有原子 `replace()`；
`registerConfigStatusRoute` 支持 `recovery: 'auto'`。

| 文件 | 性质 | 改动 |
|---|---|---|
| `src/index.ts` | 改 | `registerConfig({ ..., watch: true })`；`store.subscribe` → 串行化重建（同刻只跑一次，最新状态覆盖排队）；重建失败保留上一份注册 |
| `src/providers/registry.ts` | 改 | 重建产物收敛成 `{ adapter, routes, pools, status }`；暴露 `rebuild(state)` |
| `src/oauth/service.ts` | 改 | `oauthProviders` 的 resolver 需可替换（先读现有 `register` 是否幂等，不幂等就加 `replace(id, resolver)`，不破坏现有签名） |
| `src/status.ts` | 改 | `recovery: 'auto'`；状态里带 `revision` 与"已自动重载到第 N 版" |
| `src/client/providers.tsx` | 改 | 文案去掉"修好后需重启 dsh"，改为"已自动重载" |
| `test/hot-reload.test.ts` | 新 | 有效改动 → 重建 + `replace` 被调用 + `llm/adapters-updated` 触发；无效改动 → 旧注册仍在 + status invalid；健康态跨重建保留；连续抖动只重建一次 |
| `test/apply.test.ts` | 改 | `watch` 路径不影响首次启动语义 |

边界：
- **启动期**仍然 fail-closed（整份无效则不注册任何东西），**重载期**保留上一份可用注册。
- 健康态按 `route + accountId` 保留（改 filter 不该清空冷却）。
- chatgpt 目录的 2h TTL 缓存**跟着实例走**，重建即重建（避免旧目录套新 filter）。
- 重建瞬间在跑的请求继续用旧 adapter 跑完（快照语义），新请求用新 adapter。
- 连续多次文件变更只在最后一次校验通过时应用一次。

验收：改 `filter` 一行 → 选择器模型数变化且无需重启；写坏 YAML → 页面提示错误但现有模型仍可用；恢复 YAML → 自动回到可用。


## 10. 风险

1. **两套失败形态**：pi-ai 既可能抛 `LlmError`，也可能 in-band 发 `finish{kind:'error'}`；
   wrapper 必须都处理，且重试时抑制失败尝试的 `usage` chunk（否则 UI 重复计数）。
2. **宿主类依赖**：`FailoverPiAiAdapter` 依赖 `PiAiAdapter.stream()` 是 public、且
   `resolveApiKey` 每次 stream 调一次（`dsh-llm-pi-ai/src/adapter.ts:435`）。升级 dsh 后要复核；
   本包已有同类先例（`PiAiAdapter` 直接复用）。
3. **chatgpt 目录的过滤口径**：目录是 2h TTL 动态拉取的，filter 必须在 `listModels` /
   `discovery` / `refresh` 三个出口都生效，否则选择器与 Models 页会给出两套真话。
4. **启动期并发**：目录拉取从串行变并发（N 个账号），沿用 `MODELS_TIMEOUT_MS = 10s`，
   避免触发上游限流。
5. **抽象克制**：阶段一只抽"目录定型"，阶段二只抽"注册编排"；不做 `AuthStrategy` /
   `Transport` 接口族（没有第二消费者），否则与 fallow 死代码门禁冲突。
6. **分支分层**：阶段二建议拆 3 层（配置面统一 → 池 → 切换），每层单独 `jj desc` +
   门禁全绿，避免一个不可回滚的大 diff。

## 11. 交付顺序

1. 本文档 review（当前步骤）
2. 阶段一：`filter` + 目录定型（含 chatgpt 目录）+ 设置页只读 + 测试/README，门禁全绿
3. 阶段二：配置面统一 → 账号池 → 首 chunk 前切换，分三层提交
4. 阶段三：热加载（重建 + 原子替换 + 状态归零语义）
5. 交付给用户：新 YAML 片段 + 迁移/验证清单

## 12. 内部契约（并行实现的对齐面）

改动这些签名要回来改本节，否则并行工作会各写一套。

### 12.1 目录定型（阶段一，`src/catalog/`）

```ts
export interface ModelPattern { match: string; flags?: string }
export interface ModelFilterConfig { include?: readonly ModelPattern[]; exclude?: readonly ModelPattern[] }

export interface ModelFilter {
  keeps(id: string): boolean
  reason(id: string): 'include-miss' | 'exclude-hit' | undefined
}
export function compileModelFilter(config: ModelFilterConfig | undefined): ModelFilter

export interface FinalizeInput {
  catalog: readonly ModelConfig[]          // 目录结果；空数组 = 目录不可用（沿用现状语义）
  staticModels?: readonly ModelConfig[]    // 静态 fallback + metadata
  defaults?: readonly ModelDefault[]       // modelDefaults，仅目录可用时生效（现状语义）
  contextWindows?: ReadonlyMap<string, number>
  filter?: ModelFilter                     // 最后一步
}
export interface FinalizeResult {
  models: ModelConfig[]                    // 生效模型（硬删后的结果）
  excluded: string[]                       // 被 exclude 命中
  notIncluded: string[]                    // 因白名单未命中
}
export function finalizeCatalog(input: FinalizeInput): FinalizeResult
```

约束：filter 永远最后一步；`exclude` 优先；只匹配 `id`；空 `include` = 全放行；
被滤掉的模型**不出现**在 `models` 里（硬删）；`excluded`/`notIncluded` 只供诊断与状态页。

### 12.1b 构建报告（状态页的输入，阶段一）

```ts
export interface RouteBuildReport {
  route: string
  registered: boolean
  /** 定型结果计数；finalizeCatalog 跑过就有，没跑过（典型：无 key 直接跳过）为 undefined */
  models?: { discovered: number; effective: number; excluded: string[]; notIncluded: string[] }
  /** 目录拉取失败原因（静态兜底成功也照记） */
  catalogError?: string
  /** 该 route 没注册的原因：无 key / 滤空 / 目录失败且无静态兜底 / 构建异常 */
  error?: string
}

// src/providers.ts 的 BuildResult 增补
readonly reports: ReadonlyMap<string, RouteBuildReport>   // 每个已配置 route 一条
```

`discovered = effective + excluded.length + notIncluded.length`（三组互斥，直接相加）。
`reports` 只放"构建事实"；`kind` / `auth` / `displayName` / `enabled` / `accounts` 这些配置事实
由 `src/index.ts` 从 `ResolvedConfig` 侧组装。

### 12.2 chatgpt 目录的过滤出口（阶段一）

`ModelCatalog` 接受 `filter: ModelFilter`，在**目录输出**处过滤一次；`listModels`、
`registerModelDiscovery` 的 handler、内部缓存共用这个出口。禁止在 `adapter.ts` 再滤一次。

**`registered` 的语义例外（已批准的契约）**：chatgpt 的 `registered` = "适配器已挂载"，**不**随
动态目录变空或滤空而撤销路由。决策 4 的"滤空不注册"只适用于启动期就能确定模型集的静态来源
（`builtin` / `custom` / `command-code`）；chatgpt 的模型集要等首次目录拉取（懒加载、2h TTL）才
知道，若按目录结果动态撤销路由，一次上游抖动吐出空目录就会把路由拔掉、并切断在途会话。
chatgpt 上决策 4 的等价落地是两条：

1. 选择器里该组自然消失（`buildModelCatalog` 丢弃 0 模型的组，宿主既有行为，无需我们做）；
2. 目录**加载成功**且 `effective === 0`（`discovered > 0`，即全被过滤）时 `log.warn` 一次，
   并让状态页能表达"已挂载但当前 0 个生效模型"（`registered: true` + `models.effective === 0`）。

状态页对 chatgpt 必须展示与 API-key 路由同口径的统计（`discovered` / `effective` / 被滤 id /
`catalogError`），不能只靠 OAuth 卡片的"当前模型"徽章。

**已接受的局部适配**：chatgpt 的目录输出用 `ModelCatalog` 内的 `viewOf()` 归桶，而不是调用
`finalizeCatalog`。原因是 `ModelEntry` 携带 `finalizeCatalog` 的输入形状之外的信息
（思考档位数组、`inputModalities`），强行复用会把它们丢掉。保证等价的两条是：**同一个编译后的
`ModelFilter` 实例**（`compileModelFilter` 的唯一实现）与**相同的 `include-miss` / `exclude-hit`
归桶语义**。

**快照刷新时序（client 半的契约）**：状态接口是"当前真值"，不是一次性快照。chatgpt 的目录是
懒加载的（首次请求目录通常发生在选择器或设置页首次打开时），因此客户端必须：进入分区取一次、
分区挂载期间有界轮询（10s）、OAuth 卡片任何动作完成后立即重取；定时器在卸载时清理。

### 12.3 状态快照（阶段一 host 半 ↔ client 半）

`GET /dsh-more-providers/providers` →

```ts
interface ProvidersStatus {
  instances: Array<{
    id: string
    file: string
    state: 'ok' | 'invalid' | 'missing'
    error?: string
    revision: number
    appliedRevision?: number
    providers: Array<{
      route: string
      kind: 'builtin' | 'custom' | 'command-code' | 'chatgpt'
      auth: 'api-key' | 'oauth'
      displayName: string
      enabled: boolean
      registered: boolean
      accounts: Array<{ id: string; displayName: string; ready: boolean; healthy?: boolean; cooldownUntil?: number }>
      models: { discovered: number; effective: number; excluded: string[]; notIncluded: string[] }
      catalogError?: string
    }>
  }>
}
```

`instances` 聚合沿用 `registerConfigStatusRoute` 的做法（多 preset 实例共享一条路由）。

数据注入方式（避免 `status.ts` 反向依赖各 provider 模块，阶段二/三换实现时不用改它）：

```ts
type RouteStatus = ProvidersStatus['instances'][number]['providers'][number]
type RouteStatusSource = () => readonly RouteStatus[]
// src/status.ts 只接受 { source: RouteStatusSource }，由 src/index.ts 组装
```

字段来源：`kind` / `auth` / `displayName` / `enabled` / `accounts` 由 `src/index.ts` 从
`ResolvedConfig` 组装；`models` / `catalogError` / `error` 来自 §12.1b 的 `RouteBuildReport`
（chatgpt 那条来自其 `ModelCatalog.stats()`）；`models` 与 `error` 都是可选的（没跑过定型就
没有 `models`）。阶段一 `accounts[].ready` = key 是否可读，`healthy` / `cooldownUntil` 阶段二
才填；阶段二的 `discovered` 改为 union 后的目录数。

`instances[].state` 的分类必须来自共享库的 `ConfigState.reason`：`missing` → `'missing'`，
`unreadable` / `invalid` → `'invalid'`。**禁止**用 `error` 文本匹配——`unknown key "ENOENT"` 这类配置错误会被误报成"文件不存在"，把用户带向错误方向。

**两个版本号的分工（阶段三加入）**：
- `revision` = 文件状态被受理的版本号（来自 `ConfigState.revision`，**坏文件也会 +1**）。客户端顶部的
  「配置第 N 版」用它。
- `appliedRevision` = **当前真正在服务的注册版本**（只在重建成功时推进；重建失败/文件无效时保持
  上一次成功的值）。`state: invalid` 时客户端说"**仍在使用第 M 版**"，只能用这个字段——拿
  `revision` 冒充"上一个可用版本"会撒谎。
- `appliedRevision` 缺失（例如从未成功应用过）时客户端退回不带数字的措辞，不许猜。

### 12.4 账号池与切换（阶段二，`src/providers/pool.ts` / `failover.ts`）

```ts
export interface PoolAccount { id: string; displayName: string; keySource: KeySource }

export interface PoolScope {
  sessionId?: string
  model: string
  /** 本次请求已试过的账号；抖动级换账号时排除它们，否则会原地打转 */
  exclude?: readonly string[]
}

export class AccountPool {
  constructor(input: {
    route: string
    accounts: readonly PoolAccount[]                    // 书写顺序 = 优先级
    coverage: ReadonlyMap<string, readonly string[]>    // modelId → 有该模型的账号 id（按优先级）
  })
  get providerRoute(): string
  /** 最高优先级非冷却成员；全池冷却时仍返回最高优先级那个（key(route) 没有 model/session 上下文） */
  preferred(): PoolAccount | undefined
  acquire(scope: PoolScope): PoolAccount | undefined
  markSuccess(accountId: string): void
  markFailure(accountId: string, failure: LlmFailure): void
  snapshot(): { route: string; accounts: PoolSnapshotAccount[] }
}

export function classifyFailure(failure: LlmFailure): 'account' | 'transient' | 'terminal'
export class FailoverPiAiAdapter extends PiAiAdapter { /* 只重写 stream() */ }
```

已批准的契约增量（阶段二第二层落地时确认）：
1. **`PoolScope.exclude?: readonly string[]`**：第三层处理抖动级失败时要在同一请求内换账号，
   必须把已试过的账号排除，否则会在两个账号之间来回打转。
2. **新增 `preferred()`**：`providerKeys.key(route)` 的上下文里没有 model/session，
   不能复用 `acquire()`；`preferred()` 是它专用的入口，全池冷却时仍返回最高优先级成员。
3. **`ProviderKeys` 构造签名变化**（内部接线，`key(route)` 对外契约不变）：`key()` 先读
   `AsyncLocalStorage` 里的本次尝试账号，再退回 `pool.preferred()`。
4. **必须同时重写 `prepareCall()`，不能只重写 `stream()`**（阶段二第三层实测）：
   `PiAiAdapter.prepareCall()` 把 `stream` 绑成 `streamWithSnapshot(options, snapshot)`
   **而不是** `this.stream(options)`，宿主的真实派发走 `prepareCall → adapterCall.stream`
   （`dsh-llm/src/index.ts:1095`）。因此只重写 `stream()` 的包装在线上**完全不生效**，
   只在直接调 `adapter.stream()` 的测试里"看起来生效"——这是本任务最容易写出的假绿。
   `prepareCall()` 里用 `this.resolveModel(...)` 取模型信息即可（与基类默认语义一致），
   派发仍然交回自己的 `stream()`。

约束：
- 本次尝试的账号经 `AsyncLocalStorage` 传给 `resolveApiKey`；**禁止**用实例字段做 per-call 状态（并发会串）。
- 池状态的唯一可变字段按**账号 id / session id 索引**（`Map<accountId, {failures, cooldownUntil}>`
  + `Map<sessionId, accountId>`，粘性表要 FIFO 淘汰），不按调用索引。
- `stream()`：首个 chunk 之前可换账号重试；已产出 chunk 立即原样抛；失败尝试的 `usage` chunk
  不得转发；抛异常与 in-band `finish{kind:'error'}` 两种形态都要捕获；`ABORTED` 直接抛。
- 尝试上限 `min(池内可用账号数, 3)`；全失败抛最后一个失败（`code` 原样，不改写）。
- 冷却只在内存，`markSuccess` 清零；账号级冷却指数 5min→1h（`5/10/20/40/60min` 封顶），
  尊重 `providerRetryAfterMs`；只有**账号档**失败才冷却，抖动级只换账号。

### 12.5 热加载（阶段三）

- `registerConfig({ ..., watch: true })` + `store.subscribe`；同一时刻只跑一次重建，最新状态覆盖排队。
- **`AdapterRegistrationHandle.replace()` 只换路由，不能换 adapter 实例**（0.2.2-rc.5 实测）：
  `registerAdapter` 的闭包里 `adapter` 是常量，`replace(next: string[])` 走的是
  `prepareRoutes(next, adapter, owned)`。所以换一代 adapter 的正确做法是：
  **新建实例 → 同步段内先释放旧 handle → 立刻 `registerAdapter(newAdapter, routes)`**，
  中间不得有 `await`（同一条同步段里没有任务能观察到"路由空窗"）。
  真正要守住的不变量是：**同一 adapter 实例的 `profiles` / `pools` 永不变**，因此
  `prepareCall` 解析出的模型元数据与后续 `stream` 读到的 profiles 必属同一代——这正是
  基类用 `streamWithSnapshot` 冻结快照想保证的事（我们的 `prepareCall` override 没有沿用冻结）。
  旧实例上仍跑着的请求继续用旧代跑完，属预期。
- 旧 `registerModelDiscovery` 的 disposer 先 dispose 再注册新的；`oauthProviders` 的 resolver
  重新登记（`src/oauth/service.ts` 的 `register` 若不幂等需加 `replace`，不破坏现有签名）。
- 重建失败 → **保留上一份注册**，只在状态里报 invalid（启动期仍然 fail-closed）。
- 健康态按 `route + accountId` 保留；chatgpt 目录缓存随实例重建。
- 重建成功后 `ctx.emit('llm/adapters-updated')`。
- **依赖的宿主行为**：`ctx.effect` 的 disposer 必须是同步执行完 cleanup 的（否则"释放后立刻重注册"
  会撞 `DUPLICATE_ADAPTER`）。升级 dsh 后要复核这一条，现有测试断言了
  `llm.registrations` 数量与新旧实例不同一，可当回归网。

## 13. 并行分工（Agent Teams）

| 波次 | 任务 | owner | write scope |
|---|---|---|---|
| 1 | 阶段一/A：`filter` + 目录定型 + pi-ai 三来源接线 + 测试 | `providers-core` | `src/catalog/`、`src/config.ts`、`src/providers.ts`、`test/`、`smoke.mjs` |
| 1 | 阶段一/C：设置页只读 + `/dsh-more-providers/providers` 快照路由 | `providers-ui` | `src/status.ts`、`src/client/`、`src/index.ts` |
| 2 | 阶段一/B：chatgpt 目录过滤出口 + 测试 | `providers-core` | `src/providers/chatgpt/`、`test/chatgpt-filter.test.ts` |
| 2 | 阶段二：配置面统一 → 池 → 首 chunk 前切换（三层提交） | `providers-pool` | `src/config.ts`、`src/providers/{spec,registry,pool,failover}.ts`、`src/keys.ts`、`src/index.ts`、`src/status.ts`、`src/client/` 健康态、`test/` |
| 3 | 阶段三：热加载 | `providers-pool` | `src/index.ts`、`src/providers/registry.ts`、`src/oauth/service.ts`、`src/status.ts`、`src/client/` 文案、`test/hot-reload.test.ts` |
| 全程 | 审查 + 门禁 + README/迁移片段 | `provider-reviewer` / lead | `docs/`、`README.md`、`example.yaml` |

并行规则（每个 agent 都必须遵守）：
1. 只编辑自己 write scope 内的文件；跨 scope 的契约需求 → 找 lead 改 §12，不要自己扩面。
2. **禁止**任何 `jj` 状态变更命令（`new` / `commit` / `describe` / `abandon` / `restore` / `squash`）
   与任何 `git` 写操作——多人共用一个工作副本，改动留给 lead 分层描述。
3. **禁止**仓库级 `pnpm format` / `pnpm lint:fix`（会改写别人正在编辑的文件）；允许
   `pnpm -C packages/more-providers typecheck`、`pnpm -C packages/more-providers test -- <file>`、
   `node packages/more-providers/smoke.mjs`、`pnpm check:comments`。
4. 不新增依赖；不改 `packages/config` / `packages/ui` / 宿主包；不碰 `~/.dsh`、不重启 dsh。
5. 完成后在共享任务里写：改了哪些文件、跑了哪些命令与结果、发现的契约冲突、未做的事。


## 14. 实现与验证记录（2026-11-20）

三个阶段全部落地为**一个提交**（`zskxtkoutvmv`，48 个文件），`packages/more-providers`
升到 `0.3.0`。

### 14.1 自动化门禁

`node scripts/check-quality.mjs`：**13/13 步全绿**（format / comments / comment-tests /
lint / suppressions / dead-code / types / build / tests / smoke / client / pack /
storybook）。

`fallow dead-code` 退出 0：剩余 36 条全是警告级（31 条未使用的 dev 依赖 + 5 条重复导出别名），
且全部位于本次没有改动的包；`packages/more-providers` 与 `packages/config` 本次新增 **0 条**
（`docs/quality-scan-baseline.md:220` 记的"98 条 error 级"是旧基线，不要引用）。

包内测试：`20 files / 247 tests`。`smoke.mjs` 全 ok。

### 14.2 真机端到端（临时 `DSH_HOME` + 3081 端口 + `--patch dev.patch.yml`）

**状态快照**（迁移后 YAML：builtin + 双账号池 + chatgpt）：

```
zai-coding-cn  builtin  registered:true  models {discovered:4, effective:4}
mdkj           custom   registered:true  accounts:[stable(healthy), cheap(healthy)]
                        models {discovered:6, effective:5, excluded:["gpt-6.1-terra"]}
chatgpt        oauth    registered:true  (无 models —— 目录未加载)
```

两条账号的目录确实不同，union 后 `discovered:6` —— per-model coverage 的必要性由此实证。

**热加载四步**（同一份 YAML 连续改写后探测快照）：

```
1) 初始                       state=ok      rev=1 applied=1 | 两条 route 均 registered
2) 改 displayName，4s 后      state=ok      rev=2 applied=2 | 新名字生效
3) 写坏 kind，4s 后           state=invalid rev=3 applied=2 | 旧注册仍在服务、applied 停住、
                                                            error 指向 providers.<id>.kind
4) 修好 + filter 全排掉，5s   state=ok      rev=4 applied=4 | 滤空 route 不注册、另一条恢复
```

**迁移报错**（`resolveConfig` 实测，均可行动）：

| 旧写法 | 报错 |
|---|---|
| `providers.chatgpt` 无 `kind` | `providers.chatgpt.kind: is required: ... add "kind: chatgpt"` |
| account 写 `routeId` | `one provider registers one route; set routeId on the provider instead` |
| account 写 `baseURL` | `move it to the provider level; the accounts of a pool share the connection` |
| account 写 `filter` | `is not supported on an account; set filter on the provider` |

### 14.3 重建失败必须回滚（收口期修掉的最后一个 bug）

第一版 `registry.apply` 是"先释放旧 handle → 再 `registerAdapter`"，而后者抛错时没有回滚。
触发面是真会发生的用户错误：`routeId` 写成别的插件或宿主占用的路由（config 只保留了
`chatgpt` 这一个名字）→ `DUPLICATE_ADAPTER` → **本包所有路由从 `listProviders()` 消失**，
但状态报 invalid、`appliedRevision` 停在旧值，客户端仍显示"生效中：第 M 版"。

现在的实现保留上一份 `Generation = { routes, adapter, handle, chatgpt? }`，注册失败时用旧
adapter 与旧路由**重新注册**；回滚成功 → 报错文案带 `the previous registration was restored`，
回滚自身失败 → `the previous registration could not be restored: <原因>`（不静默吞）。
`live` 状态（accounts / current / generation / chatgpt mount）只在**全部成功之后**提交，
所以 `appliedRevision` 天然停在旧值。回归用例见 `test/hot-reload.test.ts` 的
`a refused route set rolls back` 与 `a failed rollback is reported, not hidden`。

已知取舍：chatgpt 的 mount 在 adapter 注册成功之后才切换，若 `mount()` 自身抛错（代码缺陷级）
旧 chatgpt 不回滚——风险被限制在"成功之后"，未再扩面。

### 14.4 实现中确认的三条宿主事实

1. **必须重写 `prepareCall()`**：`PiAiAdapter.prepareCall()` 绑的是
   `streamWithSnapshot(options, snapshot)` 而不是 `this.stream(options)`，真实派发走
   `adapter.prepareCall → adapterCall.stream`。只重写 `stream()` 的包装**在线上完全不生效**，
   只在直调 `adapter.stream()` 的测试里假绿（审查线用"naive 子类 `streamCalls === 0`"证伪过）。
2. **`AdapterRegistrationHandle.replace()` 只换路由**：`registerAdapter` 闭包里 `adapter`
   是常量。换一代 adapter 只能是"新建实例 → 同步段释放旧 handle → 立刻 re-register"，
   依赖 `ctx.effect` disposer 同步跑完 cleanup。
3. **错误有两种送达形态**：pi-ai 可能抛 `LlmError`，也可能 in-band 发
   `finish{reason:{kind:'error'}}`；切换账号时必须吞掉失败尝试的 finish 与其前导 `usage`。

### 14.5 留给用户执行

1. 按 §7.1 改 `$DSH_HOME/more-providers.yaml`（flake 里的那份）。
2. **重启一次 dsh-web**（升级 bundle 需要；之后再改 YAML 就自动生效了）。
3. 在 3080 上照验收清单点一遍：选择器里 `mdkj` 只出现一组、Providers 分区显示账号健康态与
   「目录 N → 生效 M」、改 YAML 后 10s 内自动更新、写坏 YAML 时提示"仍在使用第 N 版"且旧配置
   继续服务。
4. 真机会话验一次 failover：把某个账号的 secret 换成无效值 → 请求自动落到下一个账号、
   设置页该账号显示"冷却中 · 剩余 X 分 Y 秒"。
