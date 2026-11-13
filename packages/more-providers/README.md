# dsh-more-providers

**环境变量驱动的“额外 provider”集合。** 第一个模块是 **Command Code 订阅**：只要进程环境里有
`CMD_API_KEY`（或 `COMMAND_CODE_API_KEY`），插件启动时就会拉取
`https://api.commandcode.ai/provider/v1/models`，注册一个 `command-code` 路由（当前 98 个模型），
不需要在设置页点“添加供应商”。没有 key 时插件行正常加载但**不注册任何路由**，模型选择器不会多出空分组。

与 [dsh-oauth-providers](../oauth-providers/) 的分工：那边是 OAuth 登录型订阅（ChatGPT），
这边是 API-key / 环境变量型订阅。后续要加同类的 env-key provider，往 `src/` 里加一个模块即可。

## 为什么不是纯配置

DSH 内置的 `@deepseek-ai/dsh-llm-pi-ai` 支持手写 gateway，但一条 route 只能一个 `api`，
且 `models` 必须逐个列出。Command Code 的模型按 `supported_endpoints` 分流到三种协议：

| 模型族 | 协议 | URL |
|---|---|---|
| Claude | `anthropic-messages` | `/provider/v1/messages` |
| GPT | `openai-responses` | `/provider/v1/responses` |
| 其余（DeepSeek / Kimi / GLM / Qwen / Gemini / Grok …） | `openai-completions` | `/provider/v1/chat/completions` |

手写配置要拆成 3 条 route + 98 个模型条目；本插件复用 `dsh-llm-pi-ai` 导出的 `PiAiAdapter`，
用**一条 route** 承载混合协议，并把目录拉取自动化。协议规则（adaptive thinking、
`supportsDeveloperRole: false`、`max_tokens`、ZDR 头）与官方
[pi-commandcode-provider](https://github.com/CommandCodeAI/pi-commandcode-provider) 对齐。

## 快速开始

```fish
# 先构建（安装不会替你构建）
pnpm -C packages/more-providers build

# 方式 A：作为 bundle 装进 profile
dsh plugin --profile web add ./packages/more-providers

# 方式 B：开发 overlay（不安装）
dsh --profile web --patch $PWD/packages/more-providers/dev.patch.yml --no-open --port 3180
```

本机的 nix 部署在 `~/.config/nixos/home/ai/dsh/plugins.nix` 里加一行即可：

```nix
"${extensions}/more-providers"
```

`CMD_API_KEY` 已经在 `secrets.nix` 的 `envMap` 里；无需新增 secret。重启 `dsh-web` 后，
模型选择器出现 **Command Code**，模型数等于当前目录条数。

> 用 `dsh plugin add` 安装时，pnpm 可能提示 `@google/genai` / `protobufjs` 的安装脚本；
> 它们是 `@earendil-works/pi-ai` 的传递依赖，只服务本地类型检查，运行时不需要——按 pnpm 提示
> 在 profile 的 `pnpm-workspace.yaml` 里把两者设为 `false` 即可。

## 环境变量

| 变量 | 作用 |
|---|---|
| `CMD_API_KEY` | Command Code API key（首选） |
| `COMMAND_CODE_API_KEY` | 同一把 key 的备用名（与官方 pi 插件一致） |
| `CMD_ZDR=1` | 所有请求带 `x-cmd-zdr: 1`，只走零数据保留上游 |
| `CMD_MODELS_URL` | 覆盖模型目录端点（staging / 代理） |

key 只从环境变量读取；不写 settings、不写凭据库、不落日志。插件在启动时解析一次，
轮换 key 后重启 `dsh-web` 生效。

## 配置（cordis 行）

```yaml
- id: more-providers
  name: dsh-more-providers
  config:
    commandCode:
      enabled: true                 # 默认 true；没有 key 时仍保持休眠
      apiKeyEnv: CMD_API_KEY
      baseURL: https://api.commandcode.ai/provider
      modelsURL: https://api.commandcode.ai/provider/v1/models
      displayName: Command Code
      zdr: false
      timeoutMs: 10000
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 显式关掉即完全不注册 |
| `apiKeyEnv` | `CMD_API_KEY` | key 的环境变量名；仍会回退 `COMMAND_CODE_API_KEY` |
| `baseURL` | `https://api.commandcode.ai/provider` | Anthropic 路用这个根；OpenAI 路自动加 `/v1` |
| `modelsURL` | `.../provider/v1/models` | 目录端点；`CMD_MODELS_URL` 优先 |
| `displayName` | `Command Code` | 模型选择器显示名 |
| `zdr` | `false` | 等价于 `CMD_ZDR=1` |
| `timeoutMs` | `10000` | 目录请求超时 |

## 行为与边界

- **启动时拉目录**：目录请求失败（非 2xx / 超时 / 坏 JSON）只记一条 error，不注册空 provider；
  新模型上线需要重启进程。
- **模型元数据**：目录只给 `id/name/context_length/supported_endpoints`；`cost` 全 0、
  输出上限默认 32768、上下文缺失回退 131072。图片输入按 `claude-*` / `gpt-*` / `google/*`
  保守声明，目录将来返回 `modalities` / `pricing` / `reasoning` 时会自动采用。
- **Claude 自适应思考**：Opus/Sonnet 4.6+ 与 Fable 5+ 自动加 `forceAdaptiveThinking`。
- **Chat Completions**：统一 `supportsDeveloperRole: false` + `max_tokens`，避开
  Qwen / GLM / Kimi 对 `developer` 角色的拒绝。
- **模型 id**：按目录原样保留（包括带 `:free` 的 id）；DSH 的 `prepareCall` 用精确 id。
- **配额**：本插件只管推理。5h / 周 / 月度 credits 显示在
  [dsh-plan-usage](../plan-usage/) 的「Coding 套餐用量」里（`command-code` 路由）。

## 开发 / 验证

```fish
pnpm -C packages/more-providers typecheck
pnpm -C packages/more-providers build
pnpm -C packages/more-providers smoke
```

`smoke.mjs` 覆盖目录解析、三协议映射、compat、env key 解析、真实 `PiAiAdapter` 的
`listModels` / `resolveModel`，以及“无 key 不注册 / 目录失败不注册 / `CMD_MODELS_URL` 覆盖”。
它不访问网络；真 key 的端到端验证需要重启 dsh 后在模型选择器各发一条 Claude / GPT / 非 GPT。

## 已知限制

- 依赖 `@deepseek-ai/dsh-llm-pi-ai` 导出的 `PiAiAdapter`；它随 dsh 版本变化，升级 dsh 后
  先跑 `pnpm typecheck` 与 `smoke`。
- 模型目录是公开端点但**非官方文档承诺**；字段变化时按缺失处理，不会误展示。
- `$1` Go plan 不允许外部工具；Go key 会在推理侧收到 401/403，插件不会伪造可用性。
- Models 页没有可编辑的 provider 卡片：路由存在与否完全由环境变量决定（这是刻意的）；插件行自身的
  `commandCode` Config 仍会出现在设置页，用于 `apiKeyEnv` / `baseURL` / ZDR 等覆盖。

## 卸载

```sh
dsh plugin --profile web remove dsh-more-providers
```
