# dsh-triggers

**结构化交接触发器**：把两个普通 session 绑成一个「执行 ↔ 审核」循环。执行者收尾时调用
`trigger_signal` 工具提交交付信号；其回合**正常结束后**，宿主把审核 prompt 排进审核者
（原始讨论 session）的队列；审核者以 `rework` / `pass` / `needs_user` 回签，返工意见排回
**同一个执行 session**。轮次有预算、可暂停/恢复/取消，一切推进都在宿主进程里完成——
浏览器关着、没人盯着也不中断。

产品形态是通用的「事件 + 模板 + 目标 session」：执行—审核循环是首个预设（一个规则组的
两条方向行共享生命周期与轮次预算），模板可编辑复用。

## 循环语义

```text
启动（handoff 交接 或 UI「启动运行」）
  └─ 第 N 轮：phase=awaiting-delivery（执行者工作）
       执行者调用 trigger_signal(runId, deliver, summary)   ← 工具结果落日志，回合随即结束
       turn/end(completed) → 审核 prompt 队列投给审核者，phase=awaiting-review
  └─ 审核者调用 trigger_signal(runId, rework|pass|needs_user, summary)
       rework 且 N < max  → 返工 prompt 排回执行者，N+1 轮开始
       rework 且 N = max  → paused-budget（保留待发返工意见；加预算可续）
       pass               → completed（执行者收到一条完成通知）
       needs_user         → paused-user（双方任一方都可提出）
```

硬性规则：

- **信号只认工具**。普通回复、step 结束、中间输出都不推进；模型忘叫工具 ≠ 通过。
- **只认本会话本回合**。信号记录提交者 session 与其 turn；只有**该 session 自己**的对应
  turn 结束才算数（双方回合号各自独立，对方同编号回合结束不推进也不打断）。该 turn 以
  `aborted` / `error` 等非 `completed` 结束 → `paused-error`，绝不按已交付推进。同回合重复同
  信号是幂等 no-op，换结论则拒绝；一个 session 的一个回合只能为一个 run 提交信号。
- **迟到即拒绝**。暂停/取消/完成后的 run 拒绝一切信号，旧轮次的信号叫不醒任何人。
- **最后一轮仍完整送审**。预算挡的是「第 N+1 次执行」，不是第 N 次审核。
- **暂停 ≠ 打断**。暂停/预算用尽只停自动交接，不 cancel 正在跑的 agent。

## 可靠投递

每次投递先持久化一条 Delivery（含一次性铸造的 `requestId`）再调
`ctx.sessionController.prompt(mode: 'queue')`；宿主对已入队/已记录的 `requestId`
返回原接受而不重复插入，因此重启补投与手动「重投」天然幂等。发送失败（队列拒绝/超时）
标记 failed 并把 run 置 `paused-error`。手动重投**先恢复运行、后补发**（同 requestId）——
对方收到 prompt 的那一刻运行已在接收状态，不存在「回复被暂停的运行拒绝」的窗口；补发再
失败会重新暂停。三类投递被拒绝：已结束（完成/取消）的运行（不再唤醒对方）；用户/预算暂停
的运行（需先显式恢复）；**过期投递**（不属于当前轮次与当前阶段的旧记录——重发会给对方过时
的指令，其结论可能污染新轮次）。

插件重启时的恢复扫描：带未决信号的 active run 置 `paused-error`（错过 turn/end、无法
确认回合结局，交用户判断）；pending 状态的投递按原 `requestId` 补发。

状态只存宿主 `storageDomain`（`triggers` 域：templates / bindings / runs / deliveries）；
模型看到的一切（工具结果、投递 prompt）都在正常 session 日志里。

## GUI

两个入口，同一套编辑器（`/dsh-triggers` 通道，全部状态读写走宿主，无第二写路径）：

- **侧边栏「触发器」**：规则组表格、模板、运行与投递记录；主面板自动轮询刷新。
- **会话标题操作区 chip**：本 session 参与的运行状态（如「触发 · 第 2/5 轮 · 等待审核」），
  点开有暂停/恢复/续一轮/取消。

规则组表格一行一组，列语义与内容一一对应：

| 规则组 | 执行者 → 审核者 | 运行 / 预算 | 启用 | 操作 |
| --- | --- | --- | --- | --- |
| 循环 · 修 README | 重构任务 · 3f2a… → session-1 | 第 2/5 轮 · 进行中 | ✓ | 详情 / 删除 |

- **新建规则组是表单卡片**：执行者、审核者各配独立下拉（角色显式，不会再把审核者写进执行者
  字段），点「保存规则组」才落库；配对未完成时保存保持禁用。
- **行展开是完整操作面**：名称/预算/双方会话/三个模板编辑；「任务 + 启动运行」显式发起一次
  运行（已有进行中运行时禁用）；下方是运行详情——任务、状态、最近历史、暂停/恢复/续轮/取消，
  投递失败显示错误原因并可「重投」（重投成功会同时恢复运行）。
- 会话标签优先显示**会话标题**，无标题时显示去前缀的短 ID（`session-<uuid>` 不再全部塌缩成
  `session-`）。
- 模板编辑器按模板 id 挂载（切换模板不串写）、未保存的新模板没有删除按钮、另存副本会切到
  保存后的那一条；内置模板可改正文不可删。

移动端：全部点按操作、≥44px 目标、`min(px, vw)` 宽度、表格横向滚动，无 hover-only 行为。

## 与 dsh-handoff 的接入

handoff 选择界面可勾选「执行完成后自动交回当前 Session 审核」；spawn 流程在发出首条
执行 prompt **之前** 调用本插件的 `triggerBindings` 服务建好绑定并启动 run（顺序：创建
session → 持久关联 → 建绑定 → 首条 prompt），执行者拿到的首条 prompt 自带 runId 与
信号说明。详见 dsh-handoff README。默认关闭，不勾选时 handoff 行为与从前完全一致。

## 安装

```sh
pnpm build
dsh plugin --profile <name> add ./packages/triggers
```

或开发 overlay：`dsh --profile web --patch $PWD/packages/triggers/dev.patch.yml --no-open --port <端口>`。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `deliverTimeoutMs` | `120000` | 单次队列投递的等待预算；超时记 failed 并暂停 run |

## 依赖面

- 宿主运行时 peer：`@deepseek-ai/cordis`、`dsh-llm`（defineTool 类型）、`dsh-storage-domain`
  （+ zod，宿主自带）、`dsh-tools`、`schemastery`；`dsh-agent` / `dsh-session` /
  `dsh-api-session-controller` / `dsh-client-connection` / `dsh-host-webserver` 为 type-only。
- 浏览器 half：`client/client.js`（React.createElement，无 JSX），slot：
  `main`、`sidebar.panellist`、`conversation.session.header.actions`；通信走 `/dsh-triggers`
  前缀路由（connection 信封 + webServer）。
- 发布可选服务 `triggerBindings`（`ctx.get('triggerBindings')`）；无 handoff 的组装照常加载。

## Roadmap（未实现）

- 上下文压力阈值暂停（按两边 session 实际窗口占用分别观察）。
- 单向通知类规则（只有一条方向行的规则组）。
- 运行详情页跳转对方 session。
