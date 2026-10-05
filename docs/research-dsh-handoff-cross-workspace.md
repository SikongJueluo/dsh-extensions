# 调研：handoff 跨工作区交接

> 结论先行：**可行，且比预想的不需要「全局简报存储」**。三路证据（源码 + 本机沙箱实证 +
> inspect live API）合起来的判断：
>
> 1. **GUI**：workspace 选择步完全复用现有模型下拉的模态状态机（我们自己的 `shell.overlay`
>    Picker，已有 model → effort 两级步，加一级 workspace 即可）；数据由宿主
>    `workspaceRegistry.list()` 经现有 `/dsh-handoff` 通道随 pending 请求下发，**无需**新
>    remote 依赖。
> 2. **简报落点：不要改全局，维持原工作区 `.dsh/handoff/`**。`/tmp` 在 bwrap 下是每次调用
>    私有的 tmpfs（bash 写的宿主读不到，本机实证）；`~/.dsh` 不在 workspace-write 允许列表里，
>    agent 侧写入直接被拒且**不弹审批**；而跨工作区传递本来就不需要全局文件——插件宿主半不受
>    沙箱约束，读原文件、内联首 prompt、按需复制进目标工作区即可。
> 3. **spawn**：新会话的沙箱边界自动跟随其 `header.cwd`（= 目标 workspace 路径），所以把
>    `meta.cwd` 换成目标路径后**零沙箱侧改动**；`attachSession` 要求 cwd 与 workspace.path
>    严格相等，恰好被同一值满足。

- 调研对象：DSH `0.2.0-rc.2`（本机 nix store 安装）+ 本仓 `packages/handoff`（v0.2.0）。
- 源码基路径（下称 `$DSH`）：
  `/nix/store/0z3j9r5hc9vq2ifb29kcrbbxf4m2ik5q-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`
- 方法：两路后台源码调研（沙箱可写路径判定 / workspace 注册表与客户端面）+ 本机沙箱实证
  （probe `/tmp`、`~/.dsh`、home 的可写性与可见性）+ `cordis_inspect` live API 查询。

## 1. 现状与需求

现状（`packages/handoff/src/`）：`/handoff <task>` → 浏览器模态选模型（inherit / default /
显式路由 + reasoning 强度二级步）→ 当前 agent 按六节模板把简报写到
`<origin-cwd>/.dsh/handoff/<时间戳>-handoff.md`（末行完成标记）→ 插件轮询命中标记后
`ctx.agents.create({ meta: { cwd: 原会话 cwd } })` + `resolveByPath(cwd) → attachSession`
→ 简报作为新会话首条 prompt。

需求：模型选择后再加一个 workspace 选择步（首项 = 原工作区，下面可搜索列表），新会话落到
**另一个注册 workspace**；简报等中间产物是否需要全局存储待判定。

## 2. 事实链

### 2.1 workspace 的枚举与数据面

- **宿主服务 `workspaceRegistry`**（inspect 实测 + `$DSH/dsh-workspace/lib/types/types.d.ts:57-128`）：
  - `list(): Workspace[]` 同步枚举；`get(id)`；`resolveByPath(path)`（`lib/index.js:635-638`：
    `realpathNormalize` 后与 entity.path 精确匹配）。
  - `Workspace = { id, path, title, createdAt, updatedAt, sessionIds, setTitle,
    attachSession, insertSessionBefore, detachSession, status() }`；`path` 是创建时的
    canonical realpath，之后永不改写；`status()` 返回 `'ok' | 'missing-dir'`（目录可能被移走）。
  - 持久化走 `storageDomain.open(workspaceDomainSpec)`（`lib/index.js:378`，domain
    `'workspace'` v2，一张 `workspaces` KV 表 + global 单例），JSON 后端落盘
    `$DSH_HOME/storages/workspace.json`（本机已验证存在）；bootstrap 后 `list()` 纯内存读
    ——枚举无 IO 成本，picker 数据可以每次 poll 现取。
- **客户端面**（inspect 实测）：
  - GUI 的 workspace 浏览区是 `sidebar.workspaces` slot（自带搜索 + 会话分组列表），空态 Hero
    有 `conversation.hero.workspace` picker——交互模式确实「原来的 GUI 就有」，但两者
    `replaceRisk: shadows-shipped-ui`，**不该去 patch**；正确做法是扩展我们自己的
    `shell.overlay` 模态（本来就复刻了 /model 弹窗结构）。
  - 客户端若要自己订阅 workspace 状态，remote 命名空间是 `ctx.remote.workspace.follow()`
    （`$DSH/dsh-api-workspace-controller/lib/types/feed.d.ts:31`，`WorkspaceFollowFrame` =
    baseline + upsert/remove/order 增量，`WorkspaceView = {workspaceId, path, title,
    sessionIds, createdAt, updatedAt}`，types.d.ts:13-25）。但它由
    `dsh-api-workspace-controller` 声明，**不在** handoff client 现有的
    `dsh.client.inject: ["@deepseek-ai/dsh-api-remotes"]` 里——走这条路要加 client 依赖图。
  - 结论：**roster 随 pending 请求经自有通道下发**（下文 §3.1），零新依赖，dsh-mobile 网关
    同样穿透。
- **spawn 侧约束**（`types.d.ts:86-98` `attachSession` JSDoc）：新会话的 live/persisted
  header cwd 必须解析为**现存目录且等于 workspace.path**，否则拒绝写入。所以跨区 spawn 时
  `meta.cwd` 必须用所选 workspace 的 canonical `path`（不能用用户输入的原始拼写）。

### 2.2 简报写入地址：/tmp、~/.dsh、原工作区逐一判定

写入者是谁决定了约束：简报由**原会话 agent 的文件工具**写（`briefInstruction` 只给路径，
agent 用 write/bash 落盘），因此受原会话沙箱约束；读取者是插件宿主半（`node:fs/promises`
直读，不受沙箱约束——`$DSH/dsh-fs-sandbox/lib/index.js:77-85` 明确定性：fence 是可信代码里
对 model-controlled path 的策略检查，只作用于 `ctx.fs` 与 `ctx.shell` 两个服务 seam）。

| 候选 | 判定 | 证据 |
| --- | --- | --- |
| `/tmp` | **出局**。bwrap profile 是 `--tmpfs /tmp`（私有挂载，非宿主 /tmp）+ `--bind workspaceRoot`（`$DSH/dsh-sandbox-local/lib/index.js:22-39`）；Landlock 方言虽允许真 `/tmp`（:45-52），但本机 bwrap 下 bash 写的文件**下一次调用即消失、宿主不可见**（本机实证：跨 bash 调用 probe 文件消失，write 工具写的 /tmp 文件 bash 也看不到）。另：NixOS 重启清 /tmp、1777 全局可读（简报含项目上下文）。fs 工具（write/edit）的 /tmp 确实落宿主真实 /tmp（策略检查在宿主进程内执行）——但「bash 写 vs fs 写可见性不同」本身就是工具依赖的脆弱性 | writableRoots = `[workspaceRoot, "/tmp", tmpdir()]`（`$DSH/dsh-sandbox/lib/index.js:166-173`）+ 本机实证 |
| `~/.dsh` | **出局（作为 agent 写入点）**。无任何沙箱特判（全部沙箱包 grep 无 `DSH_HOME`），workspace-write 下不在允许列表 → 隐式拒写；且 approval=ask 对**普通**越界写不弹审批、直接返回 `[sandbox: file access denied …]`（`$DSH/dsh-tool-fs/lib/index.js:1159-1163`）——只有模型显式带 `sandbox_permissions` 重试才进审批瀑布，无人应答 fail closed（`$DSH/dsh-user-approval/lib/index.js:176`）。另外本机 `~/.dsh` 是 nix 声明式管理的宿主树（本仓 AGENTS.md 边界），运行时插件往里长可变数据应默认避免 | `$DSH/dsh-sandbox/` 全包 grep + 本机实证（`touch ~/.dsh/...` → `Read-only file system`，bash 方言整片 `/home` RO-bind） |
| 原工作区 `.dsh/handoff/` | **维持**。任何 permission 模式下 agent 都能写（workspace-write 的定义域）、宿主可读、用户可审计、已有 gitignore 惯例；跨区需求由插件搬运解决（§3.2） | 现状即证 |

**关键洞察**：跨工作区 handoff 不需要全局存储。简报内容经插件**内联**进新会话首 prompt，
文件只是「原 agent → 插件」的传输介质；而插件宿主半不受沙箱约束，要做持久化/复制随时可以
（`dsh-credentials-local` 等宿主包就是这么写 `$DSH_HOME` 的）。若将来想要全局历史归档，
正确位置是 `~/.dsh/handoff/`（宿主侧写，opt-in config），绝不是 `/tmp`。

### 2.3 跨区 spawn 与沙箱/权限

- **新会话沙箱自动正确**：`SandboxPolicyService.resolve()` 取
  `session?.header.cwd ?? 配置根` 作 workspaceRoot（`$DSH/dsh-sandbox-policy/lib/index.js:141-148`），
  header.cwd 在创建时定格（`$DSH/dsh-session/lib/index.js:1699-1709`，绝对路径校验 :1044-1046）。
  → `meta.cwd = 目标 workspace.path` 的新会话，其 workspace-write 边界就是目标工作区，无需
  插件做任何沙箱配置。同一会话换 cwd 会抛 `ApiSessionCwdConflict`（dsh-api-session-controller
  :273），所以「跨区」只能新开会话——handoff 本来就是新开。
- **spawn 无权限闸门**：`ctx.agents.create` 是宿主进程调用（Web「新建会话」同链路），
  不经 agent 工具审批。`CreateAgentOptions.meta.cwd` 语义见
  `$DSH/dsh-agent/lib/types/index.d.ts:48-71`（validated absolute cwd，fork lineage 等）。
  校验只有「必须绝对路径」一条（`$DSH/dsh-session/lib/types/index.d.ts:366-368`）——
  不要求已注册 workspace、不要求目录现存（web 链路 host 端 `createOrAdopt` 会先
  `mkdir -p` 再 create，dsh-api-session-controller/lib/index.js:444-458；对注册 workspace
  而言目录本应存在，`status()` 预检兜底即可）。
- **与 web 新建链路同构**（证明插件做法就是官方路径）：client
  `uiWorkspace.openWorkspace` → `ctx.sessions.create({workspaceId})` → remote
  `session/create` → host `SessionCommandController.create`：
  `cwd = workspace?.path ?? request.cwd ?? defaultCwd` → `createOrAdopt` →
  `ctx.agents.create` → `workspace.attachSession`（dsh-api-session-controller/lib/index.js:686-714）。
  插件的 create+attach 组合与其一字不差，只是 cwd 直接取目标 workspace.path。
- **preset 语义维持**：跨区不改变「显式选模型继承原会话 preset、全局默认挂默认 preset」的
  现有规则（同人格、不同大脑）；简报自带上下文，preset 与工作区正交。
- **subagent 边界不涉及**：委托子会话 approval policy 钉死 never（`$DSH/dsh-subagent/lib/index.js:535-560`）
  与本流程无关（handoff spawn 的是 root agent），但提醒了「不要让交接链路依赖任何审批弹窗」。

## 3. 实施方案

### 3.1 通道协议与 GUI（改动最大处）

- `ChoiceRequestWire` 扩展：`origin: { id, title, path }` + `workspaces: [{ id, title, path,
  missing }]`（host 在命令触发时快照 `workspaceRegistry.list()`，`status()` 异步预检标
  `missing`；poll 不刷新——注册表变更罕见，spawn 时校验 id 仍存在即可）。
- `ChoiceOutcome` 扩展：`{ choice, workspace: 'origin' | <WorkspaceId> }`；`parseChoice`
  同步 narrow（channel.ts）。
- client `Picker` 状态机加第三级步：model →（effort）→ **workspace**。首项「原工作区」带
  「当前」徽标（复用 effort 步的 `当前会话` 徽标样式），divider 后接可搜索列表（title + path
  过滤，`missing` 项灰显禁选）。`Esc` 逐级回退（workspace → effort/model → 取消）。
  **仅当 `workspaces.length > 1` 且未给 `--workspace` 时进入该步**——单工作区部署零打扰。
- 降级路径（无浏览器/超时）：模型卡之后追发第二张 `userQuestions` 卡（origin + 前 N 个
  workspace + Other 自由输入 title/path）；超时回退 origin。
- `--workspace <title-or-path>` flag：唯一 title 精确匹配 → `realpath` 后精确匹配 path；
  歧义/未命中报错并列候选（与 `--model` 的解析容错风格一致）。
- 不需要新增 Config 键（workspace 列表是本地同步枚举，无 `modelMenu` 那样的慢 IO 顾虑）。

### 3.2 spawn 侧（小改）

- `PendingHandoff` 增 `target: { id?: WorkspaceId; path: string; title: string }`（origin 时
  即原 cwd 语义）。
- `spawnHandoff`：`meta.cwd = target.path`；`attachToWorkspace` 改为直接持有 workspace 对象
  （省 `resolveByPath`），cwd==path 约束自动满足；`status() === 'missing-dir'` 的目标在
  picker/flag 解析阶段就拦下。
- **跨区时把简报复制进目标工作区**：插件宿主侧 `mkdir -p <target>/.dsh/handoff` + 写入完整
  简报（同文件名）。这让超长截断提示（`完整内容见 <path>`）指向新会话**沙箱内可读**的副本，
  也让目标项目留档交接简报（同工作区 handoff 维持今天的单文件行为）。复制失败降级为不带
  路径的截断提示。
- `bootstrapPrompt` 跨区版补一句：简报中引用的原工作区路径仅作上下文（不在你的沙箱内），
  以目标工作区现状为准；`briefInstruction` 跨区版提示原 agent「Files 节在目标工作区不可读，
  关键内容自行内联」。
- 命令结果文本：workspace 步选择后展示「目标工作区 <title>（<path>）」；「新会话出现在
  **该**工作区侧栏」措辞跟随目标。

### 3.3 验证

- `smoke.mjs` Part 2 扩展：stub `workspaceRegistry`（`list()` 返回两个 workspace、
  `resolveByPath`、`attachSession` 记录）→ 断言 `created.meta.cwd === target.path`、
  attach 到目标 workspace、跨区时目标侧出现简报副本、`--workspace` flag 的三种解析结局。
- 手动：dev overlay 起两个注册 workspace，`/handoff --workspace <另一个>` 走通；确认新会话
  出现在目标侧栏、其 bash 只能写目标工作区。

## 4. Roadmap（本次不做）

- opt-in `archiveDir`（如 `~/.dsh/handoff/`，宿主侧写）做全局交接历史与崩溃后恢复（pending
  watch 目前是内存态，host 重启即丢——与全局存储正交，同工作区路径今天也有此性质）。
- 交接完成后侧栏跳转目标 workspace（`uiWorkspace.openWorkspace`，inspect 实测存在）。
- 简报写好后 `plan-review` 审批卡再 spawn（README 既有 roadmap）。

## 5. 主要证据索引

- 沙箱可写根：`$DSH/dsh-sandbox/lib/index.js:166-173`（writableRoots）、
  `$DSH/dsh-sandbox-local/lib/index.js:22-39`（bwrap `--tmpfs /tmp` 私有挂载）。
- fs/bash 两层 seam 与插件豁免：`$DSH/dsh-fs-sandbox/lib/index.js:77-101,125-166`。
- 越界写不弹审批直接拒：`$DSH/dsh-tool-fs/lib/index.js:1159-1163`；审批瀑布 fail closed：
  `$DSH/dsh-user-approval/lib/index.js:128-181`。
- 沙箱边界 = header.cwd：`$DSH/dsh-sandbox-policy/lib/index.js:113,141-148`；header 定格：
  `$DSH/dsh-session/lib/index.js:1699-1709`。
- workspace 面：`$DSH/dsh-workspace/lib/types/types.d.ts:57-128`（Workspace/attachSession 约束）、
  `lib/index.js:635-638`（resolveByPath canonical）、`lib/index.js:378`（storageDomain 持久化）；
  client wire：`$DSH/dsh-api-workspace-controller/lib/types/types.d.ts:13-25,143-170`。
- spawn 语义：`$DSH/dsh-agent/lib/types/index.d.ts:48-104`（CreateAgentOptions.meta.cwd）。
- 本机实证（本 session，workspace-write + ask）：bash `/tmp` 私有 tmpfs 跨调用不可见；
  write 工具 `/tmp` 文件 bash 不可见；`~/.dsh` 与整个 `/home` 对 bash 为 RO 挂载。
