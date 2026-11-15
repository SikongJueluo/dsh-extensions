# dsh-jj-workspace

**让现有的 `create_worktree` 工具和新会话「新建工作树」在 jj 仓库里创建独立 Jujutsu workspace**，并配套同名任务 bookmark；只有 Git 的仓库继续走原实现。不新增管理页、不接管手工 workspace、不改宿主组合之外的任何东西。

## 做了什么

- **两个原入口都接管**：工具 `create_worktree` 的模型契约改为 VCS 中立；新会话 hero 的 stock 控件由本包在**同一 slot cell**（`forge-panel.worktree`，priority `-1`）以官方覆盖方式替换，因此 jj（colocated 与非 colocated）默认从当前 `@` 创建，Git 仍按当前分支创建。两者最终都走同一个 `worktrees` 服务，命名、baseline、bookmark、失败语义一致。
- **按最近的 VCS 根分流**：从会话目录向上找最近的 `.jj`（目录）或 `.git`（文件/目录）。最近的根是 jj workspace（包括 colocated）→ jj 分支；是 Git worktree → 原 Git 分支（即使外层项目是 jj，也不会把 Git worktree 当 jj）。
- **默认起点是当前 `@`**：省略 `from` 时用 `-r @`，`jj workspace add` 会先快照源 workspace 的受跟踪文件，新 workspace 因此包含当前进度；不复制 ignored 文件/依赖。显式 `from` 接受 change id 或 bookmark，解析为唯一 change 后固定。新会话控件里只有用户显式选择 bookmark 时才传 `from`。
- **workspace 与 bookmark 分离**：默认目录 `<源项目>/.agents/workspaces/<任务名>/`；workspace 名为任务名，新 workspace 初始 `@` 上创建同名任务 bookmark。源 baseline bookmark 不动。
- **不自动推进 bookmark**：不会因为 `jj new`、对话结束、后台刷新而移动它。开发中 bookmark 落后于 workspace `@` 是正常的。
- **不自动 rebase/push/清理/恢复**：PR 前是否线性化由用户或 agent 显式发布流程决定；workspace/bookmark 永远不自动删除；已删除 workspace 的恢复明确报「不支持」而不是误调 Git。
- **默认池自我忽略**：池目录由本包独占创建时写入 `*` 的 `.gitignore`，避免被源 workspace 快照/跟踪；已存在的池不覆盖用户文件。
- **统一任务状态**：每次成功创建（工具或 UI）追加一行 JSON 到 `<池>/.dsh-jj-workspace-records.jsonl`，记录 session、项目根、workspace、路径、bookmark、初始 change、固定 base change/commit、来源（tool/ui）与时间。宿主只读观测 workspace 目录身份（登记名 + 实际目录 + `.jj`）与精确名本地 bookmark 的现状（忽略 remote-tracking / absent 行，conflict 不读空 normal_target），再把 `ok` / `moved` / `bookmark-missing` / `workspace-missing` / `conflict` / `unavailable` 通过受支持的 `/dsh-jj-workspace/tasks` 通道送到 Session header 的紧凑状态 pill；工具创建、UI 创建、重启后都读同一份记录。不写任何新的 Session event type，不自动移动/恢复/猜 rename。
- **创建门控来自公开状态**：新会话控件使用 Forge 面板公开的 `editable`、`creation`、`request`、`blocker`，并叠加 jj 自己的只读/可写根检查；不可创建时 checkbox 禁用并显示原因，已选请求仍可取消撤回。创建中禁止反复 request/cancel。
- **失败保守保留**：workspace 名、bookmark 名、目标目录任一已存在则在分配前失败；目录以独占 `mkdir` + jj 自身的 workspace 名检查兜底竞态。中途失败保留已创建的目录/workspace/bookmark 并报出具体路径，不自动回滚；cwd 只在整条流程成功后切换。

## 宿主契约

替换两层 `worktrees` 提供者：

以下三行由本 bundle 置为 `disabled`（带包名 guard，找不到就跳过而不是误禁用别家）：

| 原行 | 作用域 |
|---|---|
| `worktree` (`@deepseek-ai/dsh-experimental-worktree`) | 工具作用域 |
| `tool-worktree` (`@deepseek-ai/dsh-experimental-tool-worktree`) | 工具 |
| `forge-worktree`（`optional-forge-panel` 隔离组内） | 新会话 UI / Forge 创建 |

替换为：

| 新行 | 包入口 | 作用 |
|---|---|---|
| `jj-worktree` | `dsh-jj-workspace` | 根作用域 `worktrees`；同时挂 `/dsh-jj-workspace/status` 与 `/dsh-jj-workspace/tasks` 只读通道 |
| `jj-tool-worktree` | `dsh-jj-workspace/tool` | 注册 `create_worktree` |
| `jj-forge-worktree` | `dsh-jj-workspace`（`statusChannel: false`） | Forge 隔离组内的 `worktrees` |

Git 实现不是复制：本提供者在 `ctx.isolate('worktrees')` 的私有 realm 里构造**原 `WorktreeService`**，Git 请求原样委托。这样 Git 的 behavior/config/卸载都还是 stock 实现，只有 jj 分支是本包的。

浏览器半（`src/client/index.tsx`）同样通过官方 slot 覆盖原控件：`conversation.hero.options` 的 `forge-panel.worktree` cell 用 priority `-1` 占据，jj（colocated 与非 colocated）默认请求 `null`（服务端解释为 `@`），用户从 `<select>` 显式选择 bookmark 时才传名字；纯 Git 沿用「当前分支」请求。请求仍走 Forge 的 `forgePanel.requestWorktree/cancelWorktree/follow`，首条消息等待、进度卡、重试/撤回都是 Forge 原有生命周期。Session / 目录 / 权限变化时先丢弃旧 status（并清空 Git 分支缓存）再重取，失败每 2 秒重试；未确认前不渲染、也不按旧 VCS 语义发请求，不把未确认的 jj 当 Git 回退。Session header 的 `jj-workspace.task` pill 显示统一任务状态；它只读、无操作入口。

## 配置（`jj-worktree` / `jj-forge-worktree` 行）

```yaml
- id: jj-worktree
  name: dsh-jj-workspace
  config:
    workspaceDirectory: .agents/workspaces  # jj 池（相对源项目）
    jjCommand: jj                            # jj 0.46+
    directory: .agents/worktrees             # 仍用于 Git 池
    namePrefix: dsh-                         # 自动命名前缀（tool 省略 name 时）
    gitCommand: git
    nodeCommand: node
    timeoutMs: 60000
    graceMs: 3000
    maxOutputBytes: 65536
    statusChannel: true                      # 只有根 provider 需要
```

`jj-forge-worktree` 必须保持 `statusChannel: false`（一个进程只挂一条状态路由），且 `workspaceDirectory` / `jjCommand` 应与 `jj-worktree` 一致（默认相同）。配置整体替换而非深合并；覆盖任一行的池或命令时，请在另一行也重述。

## 安装 / 启用

宿主 `dsh` 与 `~/.dsh` 由用户的 Nix 配置声明式管理，本包只产出 bundle，不执行安装。

**开发 overlay**（不安装，立即生效，需重启 dsh）：

```fish
pnpm install
pnpm --filter dsh-jj-workspace build
dsh --profile web --patch $PWD/packages/jj-workspace/dev.patch.yml --no-open --port 3181
```

**作为 bundle 安装**（用户执行）：

```fish
pnpm --filter dsh-jj-workspace build
dsh plugin --profile web add ./packages/jj-workspace
dsh --profile web --dump-config   # 应能看到 jj-worktree / jj-tool-worktree / jj-forge-worktree
```

bundle 层必须排在 `@deepseek-ai/dsh-experimental-forge-bundle` **之后**（`dsh plugin add` 默认追加）；否则禁用/插入的 id 尚不存在，patch 会被跳过。

## 验证

```fish
pnpm --filter dsh-jj-workspace typecheck
pnpm --filter dsh-jj-workspace test      # 35 个 vitest：真实 jj 临时仓库 + 真实 React 渲染 + 真实 Cordis 依赖契约
pnpm --filter dsh-jj-workspace smoke     # 真实 Cordis Context + 本地进程 stub：jj/Git 两臂、记录、任务状态、blocker、restart
pnpm check                                # 全仓 typecheck + build + client syntax
```

测试用临时 `HOME`/`XDG_CONFIG_HOME`/`JJ_CONFIG` 与测试身份，不读用户 alias/hooks；jj 集成测试覆盖默认 `@` 快照、colocated 且 Git HEAD attached 时仍从 `@`、显式 bookmark base、嵌套目录、重名/路径冲突、非 colocated 无 `.git`。React 测试覆盖 colocated jj 默认 `null`、显式 bookmark、Git 当前分支、read-only/creation/editable 门控与撤回、权限切换重取、目录切换期间不复用旧语义、status 失败重试、header task pill。`test/client-deps.test.mjs` 在真实 Cordis Context 上挂载实际的 client module：Forge Remote namespace（`remote.forgePanel`）未挂载时不注册替换控件，挂载后能订阅面板、发出 status 并渲染控件，namespace 卸载时控件撤回；普通对象 mock 不能替代这道依赖检查。

## 已知边界

- **浏览器半依赖 Forge 客户端包**（`@deepseek-ai/dsh-experimental-client-ui-forge`）：它通过 Forge 的 Remote 复用请求/等待/进度生命周期，不自行复制一套。替换控件按 `remote.forgePanel` 这个 Cordis namespace 服务设作用域：namespace 未挂载时不注册、不 shadow stock 入口，挂载后才接管；Session header 的 task pill 不依赖 Forge。没有 Forge 客户端包时，client 入口仍会因包加载依赖不满足而不激活。
- **覆盖是 slot cell 级的**：卸载本插件后 stock 控件恢复；本包对 Git 的控件是兼容实现（当前分支默认、显式分支选择、blocked 撤回），不是源码复用。
- **Forge 侧栏的 Git 本地 diff/缺失恢复没有为 jj 适配**。colocated workspace 里 Git 能读的部分照常显示；非 colocated workspace 没有 Git 面板。恢复按钮对 jj 记录明确报「不支持」，不会调 Git restore。这是刻意的第一版范围。
- **任务状态是只读观测**：pill 每 10 秒重读一次；workspace 缺失以实际目录/`.jj`/登记 root 三者不一致判定，bookmark 只认本地 present 行；显示 bookmark move/delete/conflict 与 workspace 缺失，不自动追踪 rename、不自动恢复、不移动 bookmark。多个任务时显示最新一条记录；无任务时 pill 不出现。
- **嵌套创建**：从子 workspace 再创建时，池定位到 `jj workspace list` 中能包含当前 workspace 的最浅根（通常是 default 根）；若该根在会话 header.cwd 的沙箱可写根之外，目录/记录写入会按策略失败并报告，不扩权、不绕过。状态通道据此返回 `outside-writable-root`，控件禁用并显示原因。
- **池已存在但无 ignore 规则**时不覆盖用户文件，也不改父 `.gitignore`；此时新 workspace/记录可能被源 workspace 跟踪，需用户自行处理。
- **jj 版本**：使用 0.46 的 `workspace add --name/-r`、空目录目标、`workspace list -T`、`bookmark list -T`。更老的 jj 不支持这些调用，不会静默退回 Git。
- 只读查询用 `--ignore-working-copy`，不触发自动 stale 更新；`workspace add`/`bookmark create` 是显式写操作，遵守 jj 自己的 `snapshot.auto-update-stale` 等配置，不额外运行 update-stale，也不关闭用户配置。遇到 stale/divergence 由 jj 报错，本包不偷偷修复。
- 记录采用追加写（O_APPEND），两个 provider 实例并发创建不会互相覆盖。

## 文件

- `src/jj.ts` — jj 领域：VCS 根检测、名字/起点解析、workspace+bookmark 创建、bookmark/workspace 只读探测、记录格式。
- `src/process.ts` — 受会话 sandbox 约束的 jj / Node 子进程，目录独占分配，记录追加。
- `src/service.ts` — `worktrees` 提供者：jj 分流 + 隔离 realm 里的 stock Git 委托 + status/tasks 只读状态。
- `src/tool.ts` — VCS 中立的 `create_worktree`。
- `src/channel.ts` — 浏览器 status/tasks 通道（连接 RPC 信封 + `requestRejection`）。
- `src/client/index.tsx` — 覆盖原新会话控件 + Session header 任务 pill（构建为 `lib/client.js`）。
- `test/`、`smoke.mjs`、`client-smoke.mjs` — 验证。
