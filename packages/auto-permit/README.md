# dsh-auto-permit

DSH 的 AI 自动审批判官：在 `approval/request` waterfall 上插队一个 answerer，
人工弹窗之前由一个小模型决定是否放行 bash 的 sandbox 提权请求。

## 行为

当一次 bash 审批请求到达时（通常是命令被 sandbox 拒绝后模型带
`sandbox_permissions` 重试），判官按顺序处理：

1. **精确记忆**：同一条命令 + 同一提权目标本会话已被放行过 → 直接放行，
   不调用模型（`approval/asked`/`approval/decided` 审计对就是记忆来源，
   无需自建存储）。
2. **不可逆硬规则**：`rm -rf ~`、`git clean -xfd`、`git reset --hard`、
   `git push --force`、`sudo`、`curl|sh` 一类形状 → 永远交人工，不过模型。
   挂载 [dsh-cmd-permit](../cmd-permit/) 时，判官优先用它的共享 oracle
   （本表 ∪ 其 `denyShape` 配置），两条路径对同一批形状让路。
3. **判官判决**：一次性小模型调用，证据 = 会话内全部用户 prompt（截最近
   16 条）+ 待批命令全文（含 description / justification，标记为
   agent 声称的意图）+ 本会话已批准命令列表。`VERDICT: allow` → 放行；
   其余一切（defer / 超时 / 解析失败）→ 回落到人工弹窗。

证据来源：待批命令从会话日志恢复，两种形态等价——直接调用读顶层
`tool/call`（`callId` + JSON 字符串参数），`run_code`（PTC）子调用读宿主
执行**前**写入的 `tool/ptc-dispatch-start`（`subCallId` + 对象参数；批准
发生时它是唯一已落盘的审计行，执行后的 `tool/ptc-dispatch` 不读）。两路
共用同一份按精确调用 id 的索引，历史批准与精确记忆随之 direct/PTC 互通；
畸形参数、同 id 内容冲突、缺 start 事件的旧宿主一律视为证据不可恢复 →
`next()` 交人工，绝不猜测。

判官**永不返回 rejected**——AI 的保守误报不能伪装成用户的明确拒绝；
任何插件自身故障也都回落人工（fail-open 向人），坏了最多退回原生行为。

非 bash 工具的审批一律 `next()` 交还原链路。风险自担：放行即
`danger-full-access` 执行，请谨慎选择判官模型。

## 可见性

每次判官决策都向会话 log 追加一条 `form: 'notice'` 消息，Web 对话流以
**折叠行**形式持久显示（不展开即可读，随 session 回放；官方 model-switch
通知同款形态）：

- `auto-permit ✓ allowed: <命令>`——判官放行；
- `auto-permit ✓ allowed (seen this session): <命令>`——精确记忆命中，
  零模型调用；
- `auto-permit ✎ deferred to you: <命令>`——判官不确定，回人工弹窗
  （展开可见判官理由）；
- `auto-permit ⚠ irreversible shape — needs you: <命令>`——高风险形状
  直接转人工。

注意：notice 的一行正文会进入模型 transcript（这是唯一能进对话流的第三方
通道，官方未开放零上下文的纯 UI 行）；单行成本极低，且模型知道提权被放行
是正面信息。host 侧同时通过 `ctx.logger` 记日志（`journalctl --user -u
dsh-web | grep auto-permit`）。

### notice 的投递通道（顺序安全，勿改成 `session.append`）

notice **必须**经 `agent.inject()` 投递（见 `deliverNotice()`），不能直接
`session.append('user/message', …, { surfaceOp: 'append' })`。

原因：审批请求是在 agent loop 的 `runGroup` 内部抛出的，此刻
`assistant(tool_calls)` 已落盘（`tool/call` 先于 dispatch 提交），而
`tool/result` 要等 `commitReady` 之后才写。在这个窗口往 surface 追加
`user/message`，`deriveMessages()` 就会投影出
`assistant(tool_calls) → user → tool` 的顺序；OpenAI 兼容端点直接回 HTTP 400，
而且坏顺序已经固化进历史，该会话之后**每一次**请求（含 `/compact`）都会失败。

实证：DSH session `5528dac7` seq 121–129——seq 125 的 auto-permit notice 夹在
seq 121 的 `tool/call` 与 seq 129 的 `tool/result` 之间，整个会话就此卡死。

`agent.inject()` 是宿主自己在这个场景下的答案（`ApprovalService.setPolicy()`
投递轮中通知用的就是它）：消息排进 `next-step` inbox、**不**唤醒 driver，等本批
tool 结果落盘、下一个 step 边界被领取时才写成 surface 的 `user/message`——折叠
行形态不变，顺序正确。dsh-cmd-permit 的 allowlist 通知走同一个 `deliverNotice()`。

回归检查（无需 API key、不发网络请求）：

```sh
pnpm -C packages/auto-permit test             # vitest：证据 fold + 审批链集成
node packages/auto-permit/test/notice-order.mjs
```

它用真实 `Session` 重放失败会话的事件顺序，断言 `assistant(tool_calls)` 后面
紧跟配对的 `tool` 消息；surface-append 路径失败，`agent.inject()` 路径通过。

## 判官判据（v3）

v3（2026-10-21，随 [dsh-toolchain-access](../toolchain-access/) 迁移）收敛 v2
的缓存判据：**缓存写入不再是提权的批准理由**。

1. **显式意图**（不变）：用户明确意图点名/唯一识别每个操作的目标与效果、
   覆盖其完整范围、效果可恢复 → 可 ALLOW。
2. **同族命令等价**（收紧）：同 session 批准过同族命令后，仅差子命令组合、
   输出截断包装、env 前缀、重复幂等执行仍视为等价——但前提是该次提权本身
   依判据 1 独立成立，且缓存上限（下条）不适用。
3. **缓存上限（新增，覆盖前两条）**：越界写工具链公开缓存/registry/store
   （~/.cargo、~/.cache、~/.npm、~/.pnpm-store、~/.uv…）是**沙箱层**的事，
   不是审批层的事。当输入的越界效果**只有**缓存写入时——即使用户意图明确
   覆盖运行该工具——返回 DEFER：正确修复是启用 toolchain-access 目录授权
   （可重建正是长期目录授权的合理性），而不是按命令放宽沙箱。以缓存为由的
   提权请求一律 DEFER，同族等价也不能越过这条。

历史背景：v2（2026-10-02）为解决 cargo 类反复弹窗引入了「缓存副作用可
ALLOW」，当时目录授权尚不存在，按命令提权是唯一出口。如今缓存需求由
toolchain-access 的 `cargo-cache` 等预设承担，继续按缓存理由批准 Full
access 只会把刚收窄的白名单从判官这条路又放出去。判官 prompt 版本
`dsh-auto-permit-v3`；`approval/request` 链序与失败回落不变。

**exact-repeat 记忆的来源门控（2026-10-22，按审查收紧）**：审计事件
（`approval/decided`）只记录结果、不记录批准者，日志里的「批准过」无法证明
来自用户还是旧插件规则。因此重放条件收紧为「**本进程**观察到该批准来自链路
后方（人工弹窗或重新考量过的其他 answerer）」；本插件自己给出的自动批准
（判官/白名单/记忆）不再可被重放——v2 时代的缓存批准不会升级为持续授权。
进程重启后观察记录为空，历史批准一律交 v3 判官/人工重新决定。

## 配置

插件行 config（全部 volatile，`{enabled, provider, model, reasoningEffort?}`）：

- **enabled**（默认开；未配置判官模型时不生效）。
- **provider** / **model**：判官模型路由。必须显式指定——不跟随会话模型，
  避免主模型审自己。可选 **reasoningEffort** 思考强度。
- 写错模型 id 是安全的：判官调用失败 → defer → 回人工弹窗（fail-open）。

两种配置方式（取决于行的来源层，dsh 0.2 的规则是"行 config 权威归定义层"）：

- **nixos / `--patch` overlay 声明**（本仓库作者的用法）：行由
  `programs.dsh.plugins` 注入时直接在行上声明 config，随 rebuild 原子生效。
  注意 `modules/home/dsh.nix` 的 `plugins` 选项默认只透传 `id`+`name`，
  需加一个 `config` 透传。Web 侧对 overlay 行写入会被拒（"overridden by a
  home patch or command-line overlay"）——这是 0.2 ConfigEditor 的设计约束，
  非本插件 bug。
- **bundle 安装（`dsh plugin add`）**：行在 bundles 层，Web 编辑写 profile
  patch 覆盖层，可正常持久化。

### Web 设置分区（"Auto Permit"）

无论行来自哪层，设置页都有 "Auto Permit" 分区：Enabled 开关 + 判官模型
select（按厂商分组）+ 思考强度二级 select（选中带 efforts 的模型时出现），
目录与 `/model` 弹窗同源。它编辑的就是行 config（走官方
`remote.settings` 通道，与 permission-presets 等官方分区同一路径）：

- Web 可写的行（bundle 安装）：选择即生效（volatile 热更新）；
- overlay 行（nixos 声明）：写入得到"此行由 home patch / overlay 管理，
  请在声明处修改"的提示——分区退化为当前值展示 + 目录浏览。

判官模型 id 也可从 `/model` 弹窗查。写错模型 id 是安全的：判官调用失败 →
defer → 回人工弹窗（fail-open）。

## 安装

```sh
pnpm build
dsh plugin --profile <profile> add ./packages/auto-permit
```

开发 overlay：

```sh
pnpm build
dsh --profile web --patch $PWD/packages/auto-permit/dev.patch.yml --no-open --port <端口>
```

## 设计文档

见仓库 `docs/research-dsh-approval-auto-permit.md`（DSH 审批系统调研、
pi ai-bash-judge 提示词迁移说明、决策记录）。
