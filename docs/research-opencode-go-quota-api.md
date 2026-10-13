# 调研：OpenCode Go 剩余配额 API（`GET /zen/go/v1/usage`）

> 结论先行：**有。`GET https://opencode.ai/zen/go/v1/usage`，`Authorization: Bearer $OPENCODE_API_KEY`，200 返回
> `{"usage":{"rolling|weekly|monthly":{"status":"ok"|"rate-limited","percent":<已用整数百分比>,"resetsAt":<ISO>}}}`。**
> 这是第一方但**完全未文档化**的路由（官方文档只让你去 console 看），且历史上有过一次当天改形态、一次整段代理化，随时可能再变——解码必须防御式。对
> dsh-plan-usage 而言它仍是当下最干净的数据源：一个 API key、无浏览器 cookie、无 HTML 解析。

- 调研日期：2026-10-13。方法：上游源码逐文件核对（raw.githubusercontent 按 commit 钉版）+ grep.app 全网交叉搜索 + 本机
  `@slkiser/opencode-quota` v3.7.1 dist 读码 + 本机 live capture（见 §3 第一行）。
- 上游 pin：[anomalyco/opencode](https://github.com/anomalyco/opencode)（原 `sst/opencode`，[旧地址仍 301](https://github.com/sst/opencode)）`dev` 分支
  HEAD = [b9ca4d21](https://github.com/anomalyco/opencode/commit/b9ca4d21b4f241154081143a6f5bef648f5ccfd0)（2026-10-12）。注意
  2026-10-10 [v2 树并入 dev](https://github.com/anomalyco/opencode/commit/5caf1f9f6f5f30e13fc50a788ad953d97ae3748f) 后大量路径搬迁，本文历史引文均钉在具体 commit。
- 需求来源：dsh-plan-usage 新增 OpenCode Go 配额 source，已落地在同仓 `packages/plan-usage/src/sources/opencode.ts`（见 §6）。

## 1. 端点契约（已确认）

**请求**：

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_API_KEY>
Accept: application/json
```

**成功响应**（本机 2026-10-13 live capture，HTTP 200）：

```json
{"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"2026-10-13T11:32:35.000Z"},
          "weekly":{"status":"ok","percent":0,"resetsAt":"2026-10-19T00:00:00.000Z"},
          "monthly":{"status":"ok","percent":0,"resetsAt":"2026-11-13T06:06:43.000Z"}}}
```

字段语义（由 [subscription.ts 的 `analyzeRollingUsage/Weekly/Monthly` 源码](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/console/core/src/subscription.ts)逐行核对，非猜测）：

| 字段 | 语义 |
|---|---|
| `percent` | **已用**（非剩余）百分比；整数，`Math.floor(Math.min(100, usage/limit*100))`——floor 且 clamp ≤100；超限恒 100；窗口过期（上次计费更新落在窗外）则 0 |
| `status` | 仅 `"ok" \| "rate-limited"` 两个值（服务端字面量类型）；`rate-limited` ⇔ usage ≥ limit |
| `resetsAt` | 服务端 `new Date(Date.now()+resetInSec*1000).toISOString()` 算出的 ISO 时间戳，毫秒位恒 `.000Z` |
| 窗口 | `rolling` = 5h 滑窗（reset 锚定最后一次计费更新时刻 + 5h）；`weekly` = 日历周；`monthly` = **锚定订阅周年的月窗**（非 30 天滚动） |

**错误行为**（[usage.ts 历史实现](https://github.com/anomalyco/opencode/blob/d4704347465c1ee63d0c213ed00e648e7f0231c5/packages/console/app/src/routes/zen/go/v1/usage.ts)亲证）：

- 缺头 / 坏 key → **401** `{"type":"error","error":{"type":"AuthError",…}}`；
- key 有效但 workspace 无 Go 订阅 → **403** `{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}`（Go 在上游内部代号 "lite"）；
- usage 端点本身不回 429。**限流是推理侧概念**：`/zen/go/v1/messages` 等推理路径超窗时抛
  [`GoUsageLimitError`](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/console/app/src/routes/zen/util/error.ts)（`limitName` ∈ `"5 hour"|"weekly"|"monthly"`），[handler.ts](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/console/app/src/routes/zen/util/handler.ts) 以 **HTTP 429 + `retry-after`（秒）+ `metadata.{workspace,limitName}`** 返回，[retry.ts](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/opencode/src/session/retry.ts) 客户端侧解析同一份 header/body 显示倒计时。

**auth 头惯例分裂**（[inference-proxy.ts 现行源码](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/lib/inference-proxy.ts)亲证）：同一 `zen/go` base 下，`…/v1/messages`（anthropic 形状推理）只认 `x-api-key`，而 **usage 等其余路径取 `authorization` 头按 `Bearer <key>` 切分**——两种头不能互换（[cc-switch 注释](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/coding_plan.rs)独立同款结论）。

## 2. 上游脉络与形态变更史（commit 级）

| 时间 (UTC) | commit | 事实 |
|---|---|---|
| 2026-08-11 20:25 | [`2b8a5969`](https://github.com/anomalyco/opencode/commit/2b8a5969e932c15083e599c82d34ce0268f81b9e) (#16513) | 端点诞生。初始形态**扁平**：`{useBalance, rollingUsage:{status,resetInSec,usagePercent}, weeklyUsage, monthlyUsage}` |
| 2026-08-11 21:18 | [`d4704347`](https://github.com/anomalyco/opencode/commit/d4704347465c1ee63d0c213ed00e648e7f0231c5) | 「simplify go usage response」：**上线 53 分钟后改形态**为现行 `{"usage":{"rolling":{status,percent,resetsAt},…}}`。社区「上线当天改过一次」的说法精确为这两笔 |
| 2026-09-09 | [`9f8db119`](https://github.com/anomalyco/opencode/commit/9f8db119fcbd4999379129ac7734375ac23460fb) | Go 推理迁移，usage 路由未动 |
| 2026-10-11 | [`83f2b6f6`](https://github.com/anomalyco/opencode/commit/83f2b6f67a5245214f4bb365ff55f7dcba9ce7fa) (#54563) | `zen/*` 全部改薄代理：[dev HEAD 的 usage.ts](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/usage.ts) 现在只剩 3 行，`GET /zen/go/v1/usage` 被转发到新 inference 服务的 `/go/v1/usage`（URL 不变；本机 capture 在代理化之后仍 200） |
| 2026-10-12 | [`b9ca4d21`](https://github.com/anomalyco/opencode/commit/b9ca4d21b4f241154081143a6f5bef648f5ccfd0) (#54585) | 移除 console 遗留数据库；`zen/util/handler.ts`、`workspace/[id]/go/lite-section.tsx`、`opencode/src/session/retry.ts`、`console/core/*` 在 dev HEAD 均已 404（本文引文钉历史 commit） |

新 inference 服务的实现不在公开仓库；**现行响应形态的第一手证据是 live capture，上游源码只能证到 2026-10-11 之前**。

## 3. 证据表

| 来源 | 证实内容 |
|---|---|
| **live capture**（本机，2026-10-13） | 端点 + Bearer + Accept → 200，三窗口 `{status,percent,resetsAt}`，与 §1 契约逐字一致 |
| [上游 usage.ts @d4704347](https://github.com/anomalyco/opencode/blob/d4704347465c1ee63d0c213ed00e648e7f0231c5/packages/console/app/src/routes/zen/go/v1/usage.ts) | Bearer 正则、401/403 路径、`formatUsage`（resetsAt 生成式）、限额读 `LiteData.getLimits()` |
| [上游 subscription.ts @055d95bb](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/console/core/src/subscription.ts) | percent floor/clamp、status 枚举、三窗 reset 锚点（滑窗/日历周/订阅周年） |
| [上游 inference-proxy.ts @dev](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/lib/inference-proxy.ts) | 路由表（`zen/go/v1/usage → /go/v1/usage`）、auth 头分裂、**`/zen/v1` 侧没有任何 usage 路由** |
| [上游 handler.ts / error.ts / retry.ts @055d95bb](https://github.com/anomalyco/opencode/blob/055d95bb7e278c94baf06235a52cac79dd13ba67/packages/console/app/src/routes/zen/util/handler.ts) | GoUsageLimitError 429 + retry-after + limitName；`useBalance` 回退可吞掉超限 |
| [上游 lite-section.tsx @46172108](https://github.com/anomalyco/opencode/blob/4617210822bdbb31e5749751afbfb4584ccedac8/packages/console/app/src/routes/workspace/%5Bid%5D/go/lite-section.tsx) | 仪表盘 SSR 与 API 共用同一组 `analyzeXxxUsage`，hydration 对象就是旧字段名 `{usagePercent,resetInSec}`——解释了爬虫正则的字段名来源 |
| [oh-my-pi opencode-go.ts](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/usage/opencode-go.ts)（全文读码） | 401=坏 key、403=无订阅的分类；逐窗防御校验、all-or-nothing；「第一方但未文档化 + merge 当天改形态」的原注释；monthly 无固定时长（订阅周年） |
| [OmniRoute opencodeQuotaFetcher.ts](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/services/opencodeQuotaFetcher.ts) | 同端点同 Bearer；60s 缓存、fail-open；`OMNIROUTE_OPENCODE_QUOTA_URL` 可覆写（注意：环境变量名**不带** `GO`） |
| [axonhub opencode_go_checker.go](https://github.com/looplj/axonhub/blob/unstable/internal/server/biz/provider_quota/opencode_go_checker.go) | Go 结构体镜像 `{"usage":{…}}` 形态 |
| [synara opencode.ts](https://github.com/Emanuele-web04/synara/blob/main/apps/server/src/providerUsage/providers/opencode.ts) | 从 `~/.local/share/opencode/auth.json` 读 `opencode-go` key；rolling→5h(300min) 映射 |
| [ai-usagebar fetch.rs](https://github.com/akitaonrails/ai-usagebar/blob/main/src/opencode_go/fetch.rs) | mockito 测试断言 `authorization: Bearer …` + `accept: application/json` 两头 |
| [waku usage.rs](https://github.com/egoist/waku/blob/main/crates/waku-core/src/usage.rs) | 同端点；「payload 按实测/官方 schema 校验，非猜」的声明 |
| [cc-switch coding_plan.rs](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/services/coding_plan.rs) + [codingPlanProviders.ts](https://github.com/farion1231/cc-switch/blob/main/src/config/codingPlanProviders.ts) | 注释完整复述：Bearer vs x-api-key 分裂、当天改形态、$12/5h·$30/周·$60/月口径、`/zen/v1` 无用量 API 刻意不命中 |
| [token-monitor goApi.js](https://github.com/Javis603/token-monitor/blob/main/src/shared/providers/opencode/goApi.js) | Go key 的 provider id 是 `opencode-go`（Zen key 另存 `opencode`）；无订阅 403；Zen 余额无 API、走 web 抓取 |
| [tokscale opencode_go.rs](https://github.com/junhoyeo/tokscale/blob/main/crates/tokscale-cli/src/commands/usage/opencode_go.rs) | 30s 超时 + 响应体字节上限 + 错误抽取的防御式范本 |
| [官方 Go 文档](https://opencode.ai/docs/go/) | Go $10/月、Go Plus $40/月；限额口径为**按模型**（5h=月额 20%、周=50%、月=100%）；「去 console 看用量」——API 未文档化；`Use balance` 回退 |
| `@slkiser/opencode-quota` v3.7.1（本机 `~/.cache/opencode/packages/…/dist/lib/opencode-go.js` 读码） | 社区兜底方案 = 仪表盘爬虫（§4） |

## 4. 备选方案与否决

| 方案 | 机制 | 否决理由 |
|---|---|---|
| **A. Bearer API**（采纳） | 见 §1 | 一个 API key（DSH 路由本就有 `OPENCODE_API_KEY`），JSON、稳定字段名 |
| B. 仪表盘爬虫（`@slkiser/opencode-quota` 路线） | `GET https://opencode.ai/workspace/<workspaceId>/go` 带 `Cookie: auth=<cookie>`，伪造浏览器 UA，正则匹配 SolidJS SSR hydration 里的 `rollingUsage/weeklyUsage/monthlyUsage`（`{usagePercent, resetInSec}`），本地换算 `percentRemaining`/`resetTimeIso`；需 `OPENCODE_GO_WORKSPACE_ID` + `OPENCODE_GO_AUTH_COOKIE` 两个环境变量（v3.7.1 dist/lib/opencode-go-config.js 亲证） | 要浏览器会话 cookie（过期快、敏感域凭据）、要 workspace id、要解析 HTML——上游改 SSR 结构即碎；字段名恰是 API 旧形态，等于绕远路拿同一份数据 |
| C. Zen 按量余额 | — | **不存在**：[inference-proxy 路由表](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/lib/inference-proxy.ts)里 `/zen/v1` 下无任何 usage 路由，[cc-switch](https://github.com/farion1231/cc-switch/blob/main/src/config/codingPlanProviders.ts) 与 [token-monitor](https://github.com/Javis603/token-monitor/blob/main/src/shared/providers/opencode/goApi.js) 注释独立同款结论。插件只能报 Go 三窗口，Zen 余额不覆盖 |

## 5. 注意事项 / 未确认

- **未文档化 = 无稳定性承诺**。#54563（2026-10-11）已把整段 `zen/*` 换成代理实现而 URL 未变；下次变更未必保 URL。解码按「坏窗即弃」写。
- 现行响应形态的上游实现（新 inference 服务）**闭源**，§1 字段语义的源码证据截至 2026-10-11；此后只有 live capture 佐证。
- 限额金额不在仓库（`Resource.ZEN_LIMITS` 部署配置）：旧口径 $12/5h、$30/周、$60/月（恰为 $60 月额的 20%/50%/100%）与[现行 v2 文档](https://opencode.ai/docs/go/)按模型口径（$15–$80/模型/月 + 20%/50%/100% 比例）并存。端点只回百分比，两种口径下插件都无需金额。
- `x-opencode-session` 头：[oh-my-pi](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/usage/opencode-go.ts) 后台轮询也带上；本机 capture 未带仍 200，说明 usage 端点不强制。上游是否按 UA/session 做差异化限流：**未确认**。
- usage 端点自身的速率限制：未观测到（社区实现普遍 60s 级缓存自保：OmniRoute `CACHE_TTL_MS = 60_000`）。
- 官方文档给的新推理 base 是 `https://opencode.ai/inference/go/v1/*`；**`/inference/go/v1/usage` 已实测同样应答**——2026-10-13 同一把 key 对两处各发一次 GET，皆 200 且 body 逐字相同（rolling/weekly/monthly 的 `percent`、`resetsAt` 完全一致）。本仓 source 仍用 `/zen/go/v1`（与 pi-ai provider catalog 的 `baseUrl` 同源，两个 base 是别名关系，未观察到差异）。
- 遗留：官方「Known problematic clients」表把 DeepSeek Harness 列为 session header 不全的客户端（推理侧问题，与本端点无关，见[文档](https://opencode.ai/docs/go/)）。

## 6. 对 dsh-plan-usage 的落地（已实现）

- 新 source [`packages/plan-usage/src/sources/opencode.ts`](../packages/plan-usage/src/sources/opencode.ts)：`OpenCodeGoSource`（`id`/`routes` = `opencode-go`），以路由的 `OPENCODE_API_KEY` 走 §1 发 Bearer GET，凭据解析与 GLM/MiniMax source 同模式（`ready()` 仅看该 env 是否非空）。
- 窗口映射到 [`QuotaSnapshot`](../packages/plan-usage/src/types.ts)：`usage.rolling → fiveHour`、`weekly → weekly`、`monthly → monthly`——`monthly` 是为本次新增的**通用月度窗**字段（GLM 原有的月度 MCP 预算仍是 `monthlyMcp`，两者并存）；`percent` 直填 `QuotaWindow.percent`（两侧语义同为「已用百分比」，clamp 0–100），`resetsAt` 经 `Date.parse` 填 `resetAt`（epoch ms，越界即丢）。`used`/`total`/`windowMinutes` 一律留空：端点不回金额，且只报"rolling ≈ 5h"——不编造窗口长度，客户端回退到静态标签（"5-hour window"）。
- **解码防御式**：逐窗独立校验（`percent` 为有限数、`resetsAt` 可解析），坏窗跳过而非整次放弃；三窗全不可用才返回 in-band `{ error }`（稳定短串，不含上游自由文本）。`status: "rate-limited"` 一律记 100，即使数字滞后。
- 非 2xx（含 401 坏 key / 403 无 Go 订阅）与网络、JSON 解析失败一律返回 `undefined` + 宿主日志一条；服务层只缓存成功快照（插件行 `quotaCacheMs`，默认 60s，社区先例同量级），失败不写缓存。
- 客户端（`client/client.js`）在原有 5h / 周条之后加了一条月度条；`crew` 插件把它当降级信号：quick 档任一窗口 `percent >= 100` 且重置点未到 ⇒ 本次委派改走 fallback（deepseek-official），读取预算 2s，超时按"无数据"处理（见 `packages/crew/README.md`）。
- 验证：`pnpm -C packages/plan-usage smoke`（live capture 向量 + mock fetch 的 200/403/坏 JSON/无 key 分支）；2026-10-13 另以真 key 实跑 `OpenCodeGoSource.get('opencode-go')` → 三窗口 + 合理重置（5h 窗剩 272min、周 5.7d、月 31d），`percent` 随本会话用量从 0 升到 1/2，反证「已用」而非「剩余」。
