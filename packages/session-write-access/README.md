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

`dev.patch.yml` 设置 `protectPluginCode: false`，因为本仓库通常就是开发会话的 workspace。生产部署必须保留默认保护，并从与本源码树分离的项目目录启动会话。

## 配置

替换行会整体替换 config，覆盖时必须重述 `mode`、`workspaceRoot`、`additionalWritableRoots`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `read-only`（bundle patch 设 `workspace-write`） | 会话初始文件策略；仍受宿主显式 mode override 影响 |
| `workspaceRoot` | `process.cwd()` | 无 session cwd 时的回退根 |
| `additionalWritableRoots` | `[]` | 部署级额外可写目录，所有 session 共享，界面不可撤销 |
| `protectedPaths` | `[]` | 额外声明的受保护物理路径；支持 `~/`、`$DSH_HOME`、`$HOME` |
| `protectHomeData` | `true` | 保护 DSH home（profile、bundle、授权存储） |
| `protectPluginCode` | `true` | 保护本包安装目录 |
| `managementIdentity` | `owner-cookie` | 管理路由身份策略；`isolated` 在 cookie secret 可读时拒绝加载（要求 Host 与 Agent 不同 OS 用户） |

加载时核对部署级 roots，session 初始化时核对 workspace，新增授权时核对目标目录；任一覆盖受保护路径即报错拒绝，不会裁掉 workspace 或假装安全。`storageDomain` 不公开物理存储位置，因此部署必须保证受保护声明与实际 backend/profile 位置一致。

## 用户面板

composer 左侧的「写入范围」按钮打开面板：

- 查看 mode、workspace、部署级目录、session 授权目录及其来源；
- 选择目录（宿主目录选择器）或手工输入绝对路径添加；
- 对待确认申请执行允许/拒绝，允许后整个 session 家族共享；
- 撤销单个授权；若父目录仍授权，会明确提示该目录依旧可写；
- 「Fork 并继承授权」创建独立授权组并打开新会话；可选填事件序号，从旧消息切分。

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
- 浏览器操作走同源前缀路由，并复用 connection 服务的 Host/Origin 与已认证 Peer 检查；普通无 cookie 请求返回 401。这条边界的具体限制见下节。
- 显式 Full access 仍按宿主原语义执行，本插件不宣称约束它。
- 两个并行 DSH 进程之间不做实时同步；本版只承诺同一实例内与重启恢复。
- 已运行的 bash/终端/后台进程保留启动时权限；撤销只影响后续调用。

## 管理入口身份边界（未满足的部署前提）

面板路由**不是 Agent-proof 的用户专用边界**。它只做 DSH 的 owner-cookie / live-peer 准入；在默认同一 UID 的 bwrap 沙箱中，模型 shell 可以读取 `$DSH_HOME/.credentials.yaml` 里的 cookie 签名 secret，也可以访问本机回环网络，因此能够离线伪造 owner 凭据并调用 `add` / `decide`。`protectHomeData` 只阻止写，不阻止读。插件加载时若发现该文件可读会打印警告（只检查可读性，不读取内容）。

要真正保证“Agent 不能自授权”，需要宿主侧提供以下之一：

- Host/浏览器与 Agent 运行在不同 OS 用户下，使 Agent 读不到 credentials；
- 宿主为插件管理路由提供独立的人类在场授权能力（0.2.2-rc.1 没有此 seam）。

在满足前，本包只把面板当作用户操作界面，不声称它是针对 Agent 的安全边界。模型工具仍只有查看与申请入口，普通无 cookie 请求返回 401；这不足以阻止读过 credentials 的同 UID shell。

部署若已经让 Host 与 Agent 使用不同 OS 用户，可设 `managementIdentity: isolated`：加载时若仍能读到 cookie secret 就直接拒绝启动，而不是继续带着错误假设运行。默认 `owner-cookie` 保留可用性，但只打印警告。

## Fork

面板入口（可带事件序号）在调用公开的 `sessionController.fork({ sessionId, atSeq? })` 前登记 Fork 记录并捕获授权快照。Fork 期间新建的 seeded root session 会在 `agent/pre-step` 被拒绝，直到 host 返回确切的新 session id 并写入新组；归属只使用返回值，不猜事件前缀。失败时会话若已创建，会落入只有默认 workspace 的独立组，不会继承或扩大权限；Fork 记录标为 failed 供面板展示。

原生 Fork 按钮不经过本入口：新会话得到默认 workspace 与部署级 roots，不继承插件授权。这是刻意差异，界面和本文都明确说明。

## 回滚

仅停用替换行会留下没有策略提供者的组合。完整回滚必须二者之一：

- 卸载 bundle（移除本包 patch 层，stock 行恢复）；或
- 同时移除替换行和本 bundle 对 stock `sandbox-policy` 的 `disabled` patch，然后重启并确认只有一个 `sandboxPolicy` 提供者。

持久记录保留在 storageDomain；插件未挂载时记录不生效。是否清除记录由部署决定，删除存储前先确认没有会话仍依赖它。

## 验证状态（2026-11-14）

已运行：

- `pnpm --filter dsh-session-write-access build`：通过，生成 `lib/index.js` / `lib/index.d.ts`。
- `vitest run`（本包）：6 个测试文件、58 项通过。覆盖根路径包含判定、路径准入/保护重叠/symlink 拒绝、group 与 child 归属、慢父查询下的 pre-step 等待与 resolve fail-closed、申请去重与空理由拒绝、陈旧 revision、撤销不复活、Fork 首步闸门、group/member/fork 三个写入点失败后的重启对账、`sandboxPolicy` 实际挂载、`workspaceWritableRoots` 包含授权目录且不包含未授权 child cwd、管理路由 401/状态返回，以及 bundle patch/manifest 与身份边界闸门断言。
- `node scripts/check-client-syntax.mjs`：8 个 client 文件通过。
- 契约核对：安装包中 `dsh-fs-sandbox`、`dsh-bash-sandbox`、`dsh-terminal-bash`、`dsh-pwsh-sandbox` 均调用 `sandboxPolicy.resolve()`，因此本替换只改这一处策略即可同时覆盖文件围栏与进程沙箱。
- `pnpm check`（仓库根）：通过（typecheck + 全包 build + client syntax，exit 0）。

未运行（需要用户部署环境）：

- 真实 DSH Web 组合中启动本行、真实文件工具与 bwrap bash 写 A/B/C 的端到端测试；
- 与 `toolchain-access` 同时挂载的组合测试；
- 真实浏览器上的面板点按与移动端验证；
- `~/.dsh` / Nix profile 接入。宿主由用户的 Nix 配置声明式管理，本仓库不修改。

## 已知限制

- 钉版集成：stock `SandboxPolicyService` 的构造函数、`Service.init` 或 resolve 语义变化会使替换失效；升级 DSH 后需重新核对并在真实组合中验证。
- 只支持同一 DSH 实例、本机文件系统和本地子 Agent；不向外部 ACP/Codex/Claude Code 或远程执行转授权限。
- 不给原生 Fork 自动继承。
- 目录被删除或替换为 symlink 后，宿主会在调用时拒绝该策略（fail closed），需要用户在面板撤销/重新授权。
