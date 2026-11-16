# dsh-more-providers

**YAML 驱动的 DSH provider registry。** 它取代 `programs.dsh.piAiProviders` 那一层静态 allowlist：
provider 定义、模型目录、账号变体、密钥路径都写在一个 YAML 文件里；插件按 key 可用性注册路由，
并向 dsh-plan-usage 暴露同步的 `providerKeys` 服务。stock `dsh-llm-pi-ai` 由本 bundle 禁用，
ChatGPT OAuth 仍归 [dsh-oauth-providers](../oauth-providers/)，`deepseek-official` 仍走内置
`DEEPSEEK_API_KEY`。

## 快速开始

1. 构建并安装（或把 checkout 路径加进 `programs.dsh.plugins`）：

```fish
pnpm -C packages/more-providers build
dsh plugin --profile web add ./packages/more-providers
```

2. 创建 `$DSH_HOME/more-providers.yaml`（默认 `~/.dsh/more-providers.yaml`）。
   插件行的 `configFile` 可指定别的路径：相对路径以进程 cwd 为基准，支持 `~/` 展开。
3. 删除/清空 `~/.config/nixos/home/ai/dsh/providers.nix` 里的 `programs.dsh.piAiProviders`；
   否则 stock row 虽然被禁用，配置仍会留在组合里。
4. `home-manager switch` / `nixos-rebuild` 后重启：

```sh
systemctl --user restart dsh-web
```

### 迁移清单（重要）

1. **先** `cp packages/more-providers/example.yaml ~/.dsh/more-providers.yaml` 并确认 secret 名；
   在 YAML 存在之前重启会让 stock `llm-pi-ai` 已禁用、插件无 provider，默认模型会失败。
2. 确认 `/run/user/<uid>/agenix/` 下有 `zhipu-coding-api-key`、`opencode-api-key`、
   `moonshot-api-key`、`minimax-coding-api-key`、`commandcode-api-key`；MDKJ 两个 key 需要先加
   `age.secrets` 并解密。
3. 删除/清空 `~/.config/nixos/home/ai/dsh/providers.nix` 的 `programs.dsh.piAiProviders`；
   `secrets.nix` 里给 MCP/工具的 env 可保留，provider 的 env 映射不再需要。
4. `agent-default-model` 仍是 `zai-coding-cn / glm-5.3`，所以
   `zai-coding-cn` 的 key 必须先可用。
5. 重启后看日志应出现 `more-providers: registered N route(s)`；模型选择器出现各 provider。

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
        contextWindow: 524288
        maxTokens: 32768
        input: [text, image]
    accounts:
      stable:
        displayName: MDKJ Stable
        secretName: mdkj-stable-gpt-api-key
      cheap:
        displayName: MDKJ Cheap
        secretName: mdkj-cheap-gpt-api-key
```

生成的路由：`zai-coding-cn`、`opencode-go`、`moonshotai`、`minimax`、`command-code`、
`mdkj-stable`、`mdkj-cheap`。`mdkj` 本身是模板，不注册。

## 配置规则

### `kind`

| kind | 含义 | 必填 |
|---|---|---|
| `builtin` | 使用 pi-ai 内置 catalog（ZAI / OpenCode / Moonshot / MiniMax …） | `catalog` 可省，默认 provider id；**不接受** `api` / `baseURL` / `modelsURL` / `models` / `compat` / `headers` / `zdr` |
| `custom` | 手写 OpenAI/Anthropic 兼容 endpoint | `api`、`baseURL`；`modelsURL` 或 `models` 至少一个 |
| `command-code` | Command Code 的混合协议目录 | 只有 key；可选 `baseURL` / `modelsURL` / `zdr` |

`api` 只支持 `openai-completions`、`openai-responses`、`anthropic-messages`。

### `accounts`

有 `accounts` 时：

- provider 是模板，**不注册**；
- 每个 account 生成路由 `${provider}-${account}`（可用 `routeId` 覆盖）；
- 默认显示名 `${displayName} (${account})`；
- account 继承 provider 的 `api` / `baseURL` / `modelsURL` / `models` / `compat` / `headers` / `zdr`；
- account 可覆盖 `displayName` / `routeId` / key；`custom` 还可覆盖 `api` / `baseURL` /
  `modelsURL` / `models` / `compat` / `headers`；`command-code` 可覆盖 `baseURL` / `modelsURL` / `zdr`；
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

`reasoning` 是字符串数组，内部映射为 pi-ai 的 `reasoningEfforts` 同名 wire 值；默认不暴露
`off`（要关就整个 `reasoning: false`），数组里写 `off` 才会出现该档。

`modelsURL` 拉取成功时优先用目录；目录缺的字段会由同 id 的静态 `models` 补齐。目录失败/为空时
整体回退静态 `models`；两者都没有则跳过该 provider（只影响这一条路由）。

### 校验与运行时

- **配置错误整份 fail-closed**：未知字段、非法 `kind`/`api`、缺 `baseURL`、空 `accounts`、
  没有任何 key source、重复 route id 等，会让整份 YAML 不生效；插件只 log error、不崩 dsh，
  并且不注册任何 provider 行。
- **Web 错误提示**：Host 在 `/dsh-more-providers/config-status` 暴露当前状态（文件、错误、
  revision、恢复方式），浏览器半插件经 `shell.overlay` 显示 toast。多个 preset 实例共享同一
  条路由并聚合返回 `instances`，不会因宿主拒绝重复路由而丢失通知。页面加载或重连后仍会看到
  当前错误；同一连接内同一错误不会因重复读取反复弹出。
- **运行时目录失败按 provider 隔离**：`modelsURL` 超时/非 2xx/坏 JSON/空列表时用静态 `models`
  fallback；没有 fallback 才跳过该 provider，其他 provider 照常注册。
- **key 缺失**是正常休眠，不算配置错误。
- **改完 YAML 需要重启 dsh**：provider 行只在启动时注册，本插件刻意不做文件监听或
  provider 热更新。修好文件后，页面上的错误提示仍会保留（并明确写「修好后需重启 dsh」），
  直到重启后重新读取。

## `providerKeys` 服务

插件注册同步服务：

```ts
ctx.get('providerKeys')?.key('zai-coding-cn') // string | undefined
```

dsh-plan-usage 的 GLM / OpenCode / MiniMax / CommandCode source 优先用它，再回退
`process.env`。未装本插件时行为与旧版一致。

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
配置库自身的路径、watch、原子替换与状态路由契约由 `packages/config` 的 Vitest 覆盖。

## 已知限制

- 依赖 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter`；升级 dsh 后先跑 `pnpm check` 与 smoke。
- builtin 的模型完全来自 pi-ai catalog，不能逐 model 覆盖。
- 自定义 model 的 wire-level `reasoningEfforts` 重命名 v1 不暴露；只支持同名映射。
- 多账号自动切换未实现；stable/cheap 需要手动选 route。
- 配置文件是运行时数据，不在 nix store；home-manager 可以用 `home.file` 管理它。

## 卸载

```sh
dsh plugin --profile web remove dsh-more-providers
```
