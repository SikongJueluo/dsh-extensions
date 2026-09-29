# dsh-plan-usage

**Coding 套餐配额查询**：把 GLM / OpenAI（Codex）/ MiniMax 三家的限额窗口发布成 `planUsage` 宿主服务，并在设置页增加「Coding 套餐用量」分区（进度条 + 重置倒计时）。独立可用——不装 dsh-auto-continue 也能随时手动看剩多少限额。

**只显示实际注册的路由**：服务与 `ctx.llm.listProviders()` 求交（随 `llm/adapters-updated` 刷新）——GLM 的别名家族（zai-coding-cn / glm / zai / …）收敛为你实际配置的那一条，一家订阅一张卡。

## 数据源（三源聚合）

| 源 | 路由 | 端点 | 认证 | 实测依据 |
|---|---|---|---|---|
| GLM | `zai-coding-cn`, `zai`, `zai-coding`, `glm`, `glm-cn`, `zhipu-bigmodel-coding` | `{host}/api/monitor/usage/quota/limit` | API key（env） | OpenTokenUsage / opencodex（MIT） |
| OpenAI Codex | `chatgpt` | `https://chatgpt.com/backend-api/wham/usage` | **ChatGPT OAuth**（经 `oauthProviders` 服务，自动刷新轮换） | headroom（MIT） |
| MiniMax | `minimax`, `minimax-cn` | `{host}/v1/token_plan/remains` | API key（`MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY`） | ai-usagebar（MIT） |

各家 wire 语义在源内归一为 `fiveHour`（滚动短窗）+ `weekly`（+ GLM 的 `monthlyMcp`），统一为「已消耗 %」与 **epoch 毫秒** 重置时间：

- GLM：`limits[]` 数组（`TOKENS_LIMIT`/`CREDIT_LIMIT`，`unit/number` 定窗口），兼容 legacy 平铺字段；`TIME_LIMIT` 为月度 MCP。
- OpenAI：`rate_limit.primary_window` / `secondary_window`（`used_percent`、`reset_at` **秒**→毫秒、`limit_window_seconds`→windowMinutes）；`plan_type`→level。
- MiniMax：永远 HTTP 200（错误在 `base_resp.status_code`）；百分比是**剩余**（反转）；时间戳毫秒；`general` 桶即文本/coding；**2049 自动翻区**（key 属于另一区域时切换 minimax.io ↔ minimaxi.com 并记住）。

共享同一端点+key 的路由合并为一次上游调用；服务层再按路由做 TTL 缓存 + 并发去重（等待中的恢复 agent 与设置页共用）。

## 服务契约

```ts
ctx.get('planUsage')  // PlanUsageService | undefined（未挂载即 undefined）

interface PlanUsageService {
  get(provider: string, opts?: { maxAgeMs?: number; force?: boolean }): Promise<QuotaSnapshot | undefined>
  providers(): string[]        // 已知源路由 ∩ 本进程实际注册的 LLM 路由
  monitored(provider: string): boolean
  sourceId(provider: string): string | undefined
}
```

`get` 永不抛错：无源、无凭证、上游失败都返回 `undefined`。`QuotaSnapshot` 含 `fiveHour` / `weekly` / `monthlyMcp`（各带 `percent` / `used` / `total` / `resetAt` / `windowMinutes`）与 `level`。

**OpenAI 依赖说明**：`chatgpt` 路由的 token 经 `oauthProviders` 服务（[dsh-oauth-providers](../oauth-providers/) v0.4+ 提供）获取，未装该插件或未登录时此源优雅降级为 `undefined`。

## 配置（cordis 行）

```yaml
- id: plan-usage
  name: dsh-plan-usage
  config:
    quotaCacheMs: 60000      # 配额 API 缓存 TTL
    providers:               # 可选：覆盖/新增 GLM 系 monitor
      zai-coding-cn:
        monitorBaseUrl: https://open.bigmodel.cn
        apiKeyEnv: ZAI_CODING_CN_API_KEY
```

## 设置页

浏览器半（`client/client.js`）在设置页增加「Coding 套餐用量」分区：每路由一张卡——滚动窗（API 上报窗口大小时按实际显示，如 "5h 窗口"）、周窗（以及月度 MCP，若套餐上报）的消耗进度条、重置倒计时（秒级跳动）、手动刷新，可见时每分钟自动刷新。经本包自有通道 `POST /dsh-plan-usage/quota` 读取（与连接 RPC 同信封、同鉴权）。

## 开发

```fish
pnpm -C packages/plan-usage build
dsh --profile web --patch ./packages/plan-usage/dev.patch.yml --no-open --port 3180
```

验证：`pnpm -C packages/plan-usage smoke`（三源实测向量 + 区域翻转 + 真实 Cordis 上下文的服务注册与路由过滤）。

## 已知限制

- 三个配额 API 均为未公开端点；上游字段变更时解析器返回 `undefined`（消费方自行兜底），不会误展示。
- OpenAI 源依赖 dsh-oauth-providers 的 `oauthProviders` 服务（软依赖）。
- 仅 GLM 系支持 `providers` 配置覆盖；OpenAI/MiniMax 端点固定。
