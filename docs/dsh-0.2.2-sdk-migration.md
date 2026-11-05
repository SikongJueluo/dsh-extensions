# dsh 0.2.2-rc.1 SDK 迁移记录

目标：把本仓 17 个 bundle 的宿主契约从 dsh 0.2.0-rc.2（cordis 4.0.4 / schemastery 3.18.4）
迁到 **dsh 0.2.2-rc.1（cordis 4.1.0 / schemastery 3.19.0）**。迁移依据是 npm 上该版本的
发布包（`lib/index.js` + `lib/types/**/*.d.ts`），不是源代码仓库的当前分支。

## 钉版

所有 `packages/*/package.json` 的 `@deepseek-ai/*` devDependencies 已指向
`0.2.2-rc.1`；`@deepseek-ai/cordis` → `4.1.0`，`@deepseek-ai/schemastery` → `3.19.0`。
`peerDependencies` 同步放宽到 `^0.2.2-rc.1` / `^4.1.0` / `^3.19.0`。
`recursive-skills` 原先单独钉在 0.2.1-rc.5，本次与其余包统一。

## 契约变更与本仓处理

| 位置 | 旧契约（0.2.0-rc.2，本仓原钉版） | 新契约（0.2.2-rc.1） | 本仓处理 |
|---|---|---|---|
| `ctx.subagents` | `startContinuable(spec)`（后台）+ `start(provider, request)`（前台） | `startActivation({ provider, label, request, signal, delivery })`，`delivery: 'parent'` 通知父模型、`'caller'` 只把结果交给调用方 | `crew` 统一走 `startActivation`：后台 `parent`、前台 `caller` 并 `dispose()`；provider 能力前置校验（`agentOptions` + `prepareContinuable`）不变 |
| `ctx.sessionController.inspect` | 返回 `{ meta, inheritedEventCount, events }` | 已移除；`ctx.sessionQuery.readSession(id)` 返回 `{ session, inheritedEventCount, events }`（live-preferred，冷读不激活 Agent） | `triggers` 改走 `sessionQuery.readSession`，`inject` 增加 `sessionQuery` |
| 会话缺失的判定 | 所有读取失败都被当成「会话不存在」→ 空历史 | `SessionQueryError` 的 `SESSION_QUERY_SESSION_NOT_FOUND` 才是真空历史 | `triggers` 只吞该 code（按 `code` 匹配而非 `instanceof`：插件解析的是自己那份包），其他读取错误上抛，避免把实现故障伪装成空基线 |
| `ctx.sessionProjections.stateOf(session, key)` | 有类型化返回 | 返回 `unknown`，首次按 key 访问会记弃用告警 | `handoff` 不再读别人的 projection，改用 `agent.model.current()`（内部仍是 pending ?? lastUsed ?? 创建选项） |
| `dsh-sandbox` 的 writable roots | profile 只 bind `policy.workspaceRoot` | `workspaceWritableRoots(policy)` = canonical workspace + `additionalWritableRoots`（额外 root 必须真实存在、非符号链接，去重） | `toolchain-access` 的钉版布局改为调用同一个 helper 推导，继续逐元素校验；被策略 root 覆盖的授权只记 note、不重复挂载 |

版本切分：0.2.1-rc.5（当前宿主）已经删掉 `startContinuable`、引入带 `delivery` 的
`startActivation`，这正是旧 `crew` 在当前宿主上报 `startContinuable is not a function` 的
原因；它同时保留了 `sessionController.inspect` 与 `stateOf`，`sessionQuery.readSession`
也已存在。`workspaceWritableRoots` 与 `agent.model` 是 0.2.2 才出现的入口。

`crew` 的前台委派随之变成一次 local activation（`delivery: 'caller'`）：子会话会进入父
会话的 catalog 并占一个 activation 名额。0.2.2 不再提供「一次性前台 start」这条旁路，
这是新契约下唯一的前台形态。取消语义也跟着变：启动 `signal` 只负责 publication，接受
之后的停止必须由调用方 `dispose()`——所以前台分支在 `exec.signal` abort 时立即 dispose，
等 teardown 与 `result` 都落地才结束工具调用（正常完成走同一条 release，`dispose()` 幂等，
不重复释放）；后台子代理不受本工具调用结束后 signal 的影响。

未改动（类型检查确认仍可用）：其余 14 包的公开钩子（`tools.register` / `tools/pre-execute` /
`tools/result`、`userApproval`、`settings`、`llm`、`storageDomain`、`commands`、`agents`、
`client-connection` / `webServer` 等）、schemastery 的 `Config` 推断方式、Cordis 的
service/inject/effect 生命周期。

## 验证

在 `pnpm install`（`--ignore-scripts`，避免中途重建 `lib/`）之后：

```sh
pnpm typecheck     # 17/17 通过
pnpm build         # 17/17 通过
pnpm check:client  # 6 个 client 文件语法通过
pnpm -r test       # 610 个 vitest + 26 个 node --test，全部通过
node packages/crew/smoke.mjs   # 53 项 smoke 全过
```

按包：auto-permit 178、triggers 129、toolchain-access 91、search-integrator 89、
task-anchor 48、execution-guard 37、recursive-skills 28、cmd-permit 10、handoff 26（node
`--test`）。

针对本次四个改动点新增/改写的测试：

- crew `smoke.mjs`：`startActivation` 的 `delivery`（后台 `parent` / 前台 `caller`）、前台
  正常完成只 dispose 一次、后台不 dispose；以及前台取消生命周期——接受后 abort 立即
  dispose 并等 teardown 落地才结束、publication 期间就 abort 的竞态同样释放、完成与取消
  竞态只释放一次、后台在工具返回后 abort 不被释放。
- triggers `recovery.test.ts`：真空会话（`SESSION_QUERY_SESSION_NOT_FOUND`）重启恢复照常；
  其他读取失败让 bind 直接报错而不是播下空基线。测试宿主的日志读取已从
  `sessionController.inspect` 换成 `sessionQuery.readSession`，不再自造已删除的旧接口。
- handoff `preferences-presets.test.mjs`：origin agent 的 `model.current()` 返回与创建选项
  不同的 durable 选择时，子会话继承的是选择（provider/model/effort 三项）。
- toolchain-access `bwrap.test.ts` / `provider.test.ts`：额外 root 的顺序、与 workspace 去重、
  read-only 忽略额外 root、缺失/符号链接 root 被 SDK 拒绝；provider 层验证真实
  `LocalSandboxProvider.confine()` 产出的 profile 带额外 root、授权被 root 覆盖时不重复挂载。

## 未验证 / 边界

- 没有启动 0.2.2-rc.1 的真实 DSH 进程；所有结论来自精确发布包的类型 + 打包产物 +
  真实 `LocalSandboxProvider` 的 argv（bwrap 运行被置为可用，但没有真正执行 bwrap）。
- 没有跑真实 profile 迁移、手机浏览器 UI、真实 provider/SSH/MCP 业务；dsh-mobile 0.8.0
  不在本次范围。
- client 半插件只做语法检查（`pnpm check:client`），没有浏览器内加载验证。
- 宿主的 `~/.dsh` 与 Nix 声明式组合未改动；宿主侧升级（llm-agents 输入 → 0.2.2-rc.1）
  另行走 flake 流程。
- `auto-continue` 未改代码：它通过 shim 依赖 `sessionController.agents.resolveAgent()`
  恢复会话。该成员在 0.2.2 的公开类型里已移除（改为 private），但发布实现仍在
  `SessionController[Service.init]` 里构造同一个 `ApiSessionAgentController`，因此运行时
  可用；这是对非公开表面的依赖，等上游给出公开的 cold-resume 入口再迁移。
- `handoff` 的 `agentPresets` / `agentDefaultModel` shim 已对照目标包核对：`AgentPreset`
  字段与 `currentSelection()` 形状一致。

## 重启用前置条件

`packages/*/lib/` 现在是按 0.2.2 契约构建的，但实际只有 handoff 要求 0.2.2：

- `handoff` 读 `agent.model`——0.2.1-rc.5 的 Agent 没有该访问器；
- `crew` 用的 `startActivation` / `delivery` 在 0.2.1-rc.5 已存在（0.2.1 删掉了
  `startContinuable`，旧代码本来就在当前宿主上报 `startContinuable is not a function`）；
- `triggers` 用的 `ctx.sessionQuery.readSession` 在 0.2.1 已可用；
- `toolchain-access` 的 `workspaceWritableRoots` 是 0.2.2 才有的导出，但插件用的是自己
  `node_modules` 里那份 0.2.2 `sandbox-local` 基类，宿主只传 policy。

所以**先切 llm-agents 输入、重建宿主，再重启**；若必须提前重启当前 0.2.1 宿主，按 API
存在性核对只有 `/handoff` 会失败（未在 0.2.1 上实跑验证），其余插件可用。切换顺序：改
flake 输入并重建 → 重启 dsh →
`pnpm build` 已是最新，无需再动。
