# dsh-plan-usage

GLM Coding Plan **配额查询**：把套餐的 5 小时 / 周 / 月度 MCP 窗口发布成 `planUsage` 宿主服务，并在设置页增加「Coding 套餐用量」分区（进度条 + 重置倒计时）。独立可用——不装 dsh-auto-continue 也能随时手动看剩多少限额。

## 数据源

订阅控制台自用的（未公开但稳定）监控端点，`GET {host}/api/monitor/usage/quota/limit`，`Bearer` 同一 API key。响应的 `limits[]`：`TOKENS_LIMIT`/`CREDIT_LIMIT` 且 `unit:3,number:5` 为 5 小时窗口、`unit:6,number:1` 为周窗口，各带已消耗 `percentage`（0-100）与 `nextResetTime`（epoch ms）；`TIME_LIMIT` 行为月度 MCP 工具额度。字段语义经 OpenTokenUsage / opencodex（均 MIT）的实测响应验证。

内置 monitor（按 provider 路由，key 从环境变量解析）：

| provider 路由 | monitor 端点 | env（按序尝试） |
|---|---|---|
| `zai-coding-cn` | `https://open.bigmodel.cn` | `ZAI_CODING_CN_API_KEY`, `GLM_API_KEY`, `ZAI_API_KEY` |
| `zai`, `zai-coding` | `https://api.z.ai` | `ZAI_API_KEY`, `GLM_API_KEY` |
| `glm`, `glm-cn`, `zhipu-bigmodel-coding` | `https://open.bigmodel.cn` | `GLM_API_KEY`, `ZAI_CODING_CN_API_KEY`, `ZAI_API_KEY` |

共享同一端点+key 的路由合并为一次上游调用（TTL 缓存，所有消费方共用）。

## 服务契约

```ts
ctx.get('planUsage')  // PlanUsageService | undefined（未挂载即 undefined）

interface PlanUsageService {
  get(provider: string, opts?: { maxAgeMs?: number; force?: boolean }): Promise<QuotaSnapshot | undefined>
  monitorOf(provider: string): MonitorConfig | undefined
  monitored(provider: string): boolean
  providers(): string[]
}
```

`get` 永不抛错：路由无 monitor、key 未解析、上游失败都返回 `undefined`。`QuotaSnapshot` 含 `fiveHour` / `weekly` / `monthlyMcp`（各带 `percent` / `used` / `total` / `resetAt`）与 `level`。

## 配置（cordis 行）

```yaml
- id: plan-usage
  name: dsh-plan-usage
  config:
    quotaCacheMs: 60000      # 配额 API 缓存 TTL
    providers:               # 可选：覆盖/新增 monitor
      zai-coding-cn:
        monitorBaseUrl: https://open.bigmodel.cn
        apiKeyEnv: ZAI_CODING_CN_API_KEY
```

## 设置页

浏览器半（`client/client.js`）在设置页增加「Coding 套餐用量」分区：5 小时 / 周（以及月度 MCP，若套餐上报）窗口的消耗进度条、重置倒计时（秒级跳动）、手动刷新，可见时每分钟自动刷新。经本包自有通道 `POST /dsh-plan-usage/quota` 读取（与连接 RPC 同信封、同鉴权）。

## 开发

```fish
pnpm -C packages/plan-usage build
dsh --profile web --patch ./packages/plan-usage/dev.patch.yml --no-open --port 3180
```

验证：`pnpm -C packages/plan-usage smoke`（实测响应向量 + monitor 去重 + 真实 Cordis 上下文上的服务注册）。

## 已知限制

- 配额 API 是未公开端点，上游变更字段时解析器返回 `undefined`（消费方自行兜底）。
- 仅 GLM coding plan 系（z.ai / bigmodel.cn）内置；其他 provider 可经 `providers` 配置接入。
