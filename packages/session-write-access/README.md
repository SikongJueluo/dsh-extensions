# dsh-session-write-access

持久化的 Session 多项目写入授权。默认只允许会话原始 workspace；用户可以在面板里提前添加目录，或在 Agent 越界写入被拒绝后批准它的目录申请。授权按 session 家族共享、重启恢复，文件工具与 bash 读取同一份策略。

本包**替换**宿主 `sandbox-policy` 行，继续提供同名 `sandboxPolicy` 服务：stock 的 mode、workspace 解析、部署级 roots 和 runtime context 都保留，只在 `workspace-write` 结果上追加当前授权组的目录。这不是稳定的第三方 roots 扩展点，而是对 DSH `0.2.2-rc.1` 组合的钉版集成。

## 行为

| 场景 | 行为 |
|---|---|
| 初始 | 主会话 workspace 可写；额外项目默认未授权 |
| 用户添加 | 面板中选择/输入已存在的物理绝对目录，立即持久生效 |
| Agent 申请 | `write_access_request` 写入待确认队列；用户在面板允许或拒绝 |
| 授权范围 | 目录及子目录的新建、修改、删除；文件工具与 bash/新终端共用 |
| 持久化 | 同一 session 重启后恢复；撤销同样持久化 |
| 本地子 Agent | 与发起它的 session 共享一个授权组；子 Agent 的 cwd 不会成为新的可写根 |
| 撤销 | 后续调用生效；不终止已运行的终端或后台进程 |
| 只读模式 | 授权不产生写权，记录保留，回到 `workspace-write` 后继续生效 |
| Fork | 面板中的「Fork 并继承授权」复制点击时有效的额外目录；原生 Fork 不继承 |

部署级 `additionalWritableRoots` 和平台临时目录保持宿主原语义，界面明确标为不可撤销。

## 安装

bundle 方式（用户执行）：

```sh
pnpm install && pnpm build
dsh plugin --profile <profile> add ./packages/session-write-access
dsh --profile <profile> --dump-config   # 应出现 "# == dsh-session-write-access"
```

开发 overlay（不安装）：

```sh
pnpm build
dsh --profile web --patch "$PWD/packages/session-write-access/dev.patch.yml" --no-open --port 3081
```

`dev.patch.yml` 设置 `protectPluginCode: false`，因为本仓库通常就是开发会话的 workspace。默认保护（`protectHomeData` / `protectPluginCode` 和 `protectedPaths`）适合会话不落在授权存储与策略代码里的部署；若部署配置本身或本源码树就是日常 workspace，必须显式关掉对应那一项，代价是这些会话可以改写策略代码与部署配置——这是使用决策，插件不会替你裁掉工作区。

## 配置

替换行会整体替换 config，覆盖时必须重述 `mode` 和 `additionalWritableRoots`（以及自己改动的受保护路径）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `read-only`（bundle patch 设 `workspace-write`） | 会话初始文件策略；仍受宿主显式 mode override 影响 |
| `workspaceRoot` | 无 | 无 session cwd 时的回退根；缺省表示不提供回退——这类 `workspace-write` 调用显式拒绝，不会继承进程 cwd |
| `additionalWritableRoots` | `[]` | 部署级额外可写目录，所有 session 共享，界面不可撤销 |
| `protectedPaths` | `[]` | 额外声明的受保护物理路径；支持 `~/`、`$DSH_HOME`、`$HOME` |
| `protectHomeData` | `true` | 保护 DSH home（profile、bundle、授权存储） |
| `protectPluginCode` | `true` | 保护本包安装目录 |

加载时核对部署级 roots（只核对显式声明的 `workspaceRoot` / `additionalWritableRoots`，不从进程 cwd 推导），session 初始化时核对 workspace，新增授权时核对目标目录；任一覆盖受保护路径即报错拒绝，不会裁掉 workspace 或假装安全。`storageDomain` 不公开物理存储位置，因此部署必须保证受保护声明与实际 backend/profile 位置一致。

## 用户面板

composer 左侧的「写入范围」按钮仅在 `workspace-write` 模式下显示；切换到只读或全部权限时隐藏，已有授权记录保留：

- 主视图为工作区多选列表：当前工作区置顶、固定勾选；其他工作区勾选即授权，取消即撤销；
- 部署级目录及已被父目录覆盖的工作区保持勾选，固定权限不可在此取消；已有的非工作区目录也显示在同一列表中；
- 待确认申请只在有内容时显示，保留理由和允许/拒绝操作；
- 「更多」中保留选择/输入其他目录、刷新、最近决定和「Fork 并继承授权」（含可选事件序号）。

面板是用户专用操作面；Agent 只有下面两个工具。

## Agent 工具

- `write_access_status`：查看当前 workspace、授权目录、待确认申请。
- `write_access_request`：提交一个明确存在的绝对目录和理由。

工具不经过普通 approval waterfall；auto-permit 自动放行一次命令不会产生目录授权。审批后不会自动重放失败的 bash 命令，Agent 需要先检查副作用再继续。

`storageDomain` 是本包的硬依赖：没有 storage-domain 行时插件拒绝加载，而不是退回“授权只存在内存”。

## 持久化与安全边界

- 磁盘记录是权限事实，内存是读取快照；写入成功后才发布新策略。授权组的 group record 是权限变更的提交点；申请状态是交互状态，可从 group 重新核对。
- 同组变更串行化；用户决定校验 request id 与页面显示的 group revision，旧页面不能把已撤销目录重新放开。
- 本地子会话按持久化的 `origin` / `parentSession` 链归属到根 session 的组；冷恢复找不到父信息会明确失败，不把 `child.cwd` 当授权根。
- 浏览器操作走同源前缀路由，并复用 connection 服务的 Host/Origin 与已认证 Peer 检查；普通无 cookie 请求返回 401。
- 显式 Full access 仍按宿主原语义执行，本插件不宣称约束它。
- 两个并行 DSH 进程之间不做实时同步；本版只承诺同一实例内与重启恢复。
- 已运行的 bash/终端/后台进程保留启动时权限；撤销只影响后续调用。

## 管理入口

面板与浏览器操作沿用 DSH 原生的 owner-cookie / live-peer 准入；普通无 cookie 请求返回 401。管理路由不在模型工具表中：模型只能通过 `write_access_status` / `write_access_request` 查看和申请，添加、批准、撤销与 Fork 由浏览器操作调用同一内部实现。插件不额外引入身份隔离配置；认证边界的强度由当前 DSH 宿主决定。

## Fork

面板入口（可带事件序号）在调用公开的 `sessionController.fork({ sessionId, atSeq? })` 前登记 Fork 记录并捕获授权快照。Fork 期间新建的 seeded root session 会在 `agent/pre-step` 被拒绝，直到 host 返回确切的新 session id 并写入新组；归属只使用返回值，不猜事件前缀。正常回滚路径下，失败时会话若已创建，会落入只有默认 workspace 的独立组，不会继承或扩大权限，Fork 记录标为 failed 供面板展示；若清理写入本身也失败，错误会明确要求检查面板，不会宣称已回到默认范围。

原生 Fork 按钮不经过本入口：新会话得到默认 workspace 与部署级 roots，不继承插件授权。这是刻意差异，界面和本文都明确说明。

## 回滚

仅停用替换行会留下没有策略提供者的组合。完整回滚必须二者之一：

- 卸载 bundle（移除本包 patch 层，stock 行恢复）；或
- 同时移除替换行和本 bundle 对 stock `sandbox-policy` 的 `disabled` patch，然后重启并确认只有一个 `sandboxPolicy` 提供者。

持久记录保留在 storageDomain；插件未挂载时记录不生效。是否清除记录由部署决定，删除存储前先确认没有会话仍依赖它。

## 验证状态（2026-11-14）

已运行：

- `pnpm --filter dsh-session-write-access build`：通过，生成 `lib/index.js` / `lib/index.d.ts`。
- `vitest run`（本包）：5 个测试文件、61 项通过。覆盖根路径包含判定、路径准入/保护重叠/symlink 拒绝、缺省 `workspaceRoot` 不推导进程 cwd 与无 cwd 会话的显式拒绝、group 与 child 归属、慢父查询下的 pre-step 等待与 resolve fail-closed、申请去重与空理由拒绝、陈旧 revision、撤销不复活、Fork 首步闸门、首次 intent 写入失败/宿主 attach 失败/catch 内 member 失败、abort 后重启不复活的回归、`sandboxPolicy` 实际挂载、`workspaceWritableRoots` 包含授权目录且不包含未授权 child cwd、管理路由 401/状态返回，以及 bundle patch/manifest 断言。
- `pnpm check:client`：校验 `lib/client.js` 的 DSH factory 包装、外部请求、内联样式，并 materialize/apply/render 每个注册组件。
- 启动回归（隔离 `DSH_HOME`、独立端口、进程 cwd = `$HOME`）：不声明 `workspaceRoot` 的新代码在两种 config 下都只余 1 条未激活（`experimental-inspector` 的已知问题）：(a) 旧部署 config（`protectedPaths` 含 `~/.config/nixos`）；(b) 目标 config（只保护 `~/.ssh` / `~/.gpg`、`protectPluginCode: false`）。旧代码在同样输入下报 `deployment root "/home/sikongjueluo" overlaps protected "/home/sikongjueluo/.ssh"` 并留下 23 条未激活。
- 契约核对：安装包中 `dsh-fs-sandbox`、`dsh-bash-sandbox`、`dsh-terminal-bash`、`dsh-pwsh-sandbox` 均调用 `sandboxPolicy.resolve()`，因此本替换只改这一处策略即可同时覆盖文件围栏与进程沙箱。
- `pnpm check`（仓库根）：通过（typecheck + 全包 build + client syntax，exit 0）。

## 真实环境验收（2026-11-14）

在隔离 `DSH_HOME`（仓库内 `.smoke-dsh-home/`，已忽略）、独立 Web 端口 3181、测试项目 A/B/C 中启动真实 Web profile，加载 `dev.patch.yml`（`workspace-write`，与 profile 既有 `toolchain-access` 行共存），会话 cwd 为 A。结果：

- 初始：文件工具写 A 成功，写 B 被拒绝，错误为 `[sandbox: file access denied under workspace-write mode]`。
- 面板 `add B` 后 revision=2；文件工具写 B 成功，写 C 仍拒绝。普通 bash 命令写 A、B 成功，写 C 报 `Read-only file system`。
- 停止并重启 DSH 后，同一 session 的 state 仍为 revision=2、B 在 grants 中；文件工具写 B 成功、写 C 拒绝，未再次确认。
- Agent 调 `write_access_request` 申请 C，面板显示 pending；`decide allow` 后 revision=3，文件工具写 C 成功；面板撤销 C 后 revision=4，写 C 再次被拒绝。
- 管理路由无 cookie 请求返回 401；带浏览器 cookie 的 state/add/remove/decide 返回预期结果；client bundle 由该服务实际提供，包含 `conversation.input.left` / `shell.overlay`。

证据：`.dsh/accept/` 下的响应 JSON、会话日志副本路径与被拒绝的写结果；测试服务已停止。未自动点击 React 面板：安装的 Chromium 在当前文件沙箱内崩溃；面板按钮调用的正是上述同一路由，UI 模块已实际加载，但视觉/移动端点按仍需浏览器手工复核。

仍未运行：

- 生产 `~/.dsh` / Nix profile 接线与升级 DSH 后的重新验证；宿主由用户的 Nix 配置声明式管理，本仓库不修改。
- 真实浏览器中的 React 面板点按与移动端布局；Chromium 在当前文件沙箱内无法稳定启动，面板后端路由已实测。

## 已知限制

- 钉版集成：stock `SandboxPolicyService` 的构造函数、`Service.init` 或 resolve 语义变化会使替换失效；升级 DSH 后需重新核对并在真实组合中验证。
- 只支持同一 DSH 实例、本机文件系统和本地子 Agent；不向外部 ACP/Codex/Claude Code 或远程执行转授权限。
- 不给原生 Fork 自动继承。
- 目录被删除或替换为 symlink 后，宿主会在调用时拒绝该策略（fail closed），需要用户在面板撤销/重新授权。
