# dsh-extensions

Out-of-tree [DeepSeek Harness](https://www.deepseek.com/harness/en/) 插件 bundle 集，pnpm workspace monorepo。

| Bundle | 说明 |
| --- | --- |
| [`dsh-plan-usage`](packages/plan-usage/) | GLM / OpenAI Codex / MiniMax / OpenCode Go 套餐配额查询，`planUsage` 服务 + 设置页分区 |
| [`dsh-auto-permit`](packages/auto-permit/) | 审批瀑布上的 AI 判官：小模型在弹窗之前决定是否放行 bash 提权（高危/容器硬边界 → 白名单 → 精确记忆 → 判官调用；含本地容器构建/临时验证） |
| [`dsh-cmd-permit`](packages/cmd-permit/) | 同一瀑布上的确定性白名单：配置内的命令族提权不弹窗也不耗判官调用（种子为空——缓存类绕行改走 toolchain-access 目录授权，rtk 代理任意命令也不再默认 Full access）；`denyShape` 高危表以 `ctx.cmdPermit` 共享给上面那位 |
| [`dsh-execution-guard`](packages/execution-guard/) | 参数预检（审批与副作用**之前**、同批整体校验）+ 重复 `INVALID_ARGS` 纠偏提示（原生 repeat-reminder 只认完全相同的参数，抓不到"值在变、形状没变"） |
| [`dsh-jj-workspace`](packages/jj-workspace/) | 原 `create_worktree` 工具与新会话工作树入口在 jj 仓库创建 workspace + 同名任务 bookmark，Git 仓库继续走原实现；项目内 `.agents/workspaces` 池，工具/UI 统一任务状态显示在会话 header，只读观测 bookmark move/delete，不自动推进/清理/恢复 |
| [`dsh-task-anchor`](packages/task-anchor/) | `checkpoint_task` 恢复锚点：记 jj 工作层 / goal 身份 / 阶段 / 归属文件 / 验证摘要，恢复时比对并报告一致或漂移（只报告，不 rebase、不 resume goal） |
| [`dsh-auto-env`](packages/auto-env/) | 按 session 工作区自动加载 direnv / devenv 环境 |
| [`dsh-auto-continue`](packages/auto-continue/) | 套餐限额后睡到重置点自动重试，支持跨进程重启续跑 |
| [`dsh-crew`](packages/crew/) | 固定路由委派工具组：三档 subagent（quick / 主力 / smart）+ `create_agent` 常驻角色代理，档位语义写进工具描述治 over-escalation |
| [`dsh-handoff`](packages/handoff/) | `/handoff <任务>` 一条命令交接会话，简报即新 session 的首条 prompt |
| [`dsh-context-audit`](packages/context-audit/) | `/context-audit` 命令 + 侧边栏面板：按 provider/model、工具、会话三层统计本机会话日志（缓存命中率、工具失败率…），数据不出本机 |
| [`dsh-remote-exec`](packages/remote-exec/) | 白名单远端容器执行工具：在固定 SSH 主机的固定 Docker 容器里跑 fish 命令，ssh 走宿主侧 spawn，跳板链与 agent 转发原样生效 |
| [`dsh-rtk-rewrite`](packages/rtk-rewrite/) | rtk 命令改写执行器：模型跑 `git status`、实际执行 `rtk git status`，用确定性压缩输出降低上下文压力 |
| [`dsh-search-integrator`](packages/search-integrator/) | 多源检索 + 整合模型一次成文：`web_research` 吃整个问题，去重排序后返回带引文校验的综合答案与覆盖说明 |
| [`dsh-session-write-access`](packages/session-write-access/) | 持久化的 Session 多项目写入授权：替换 `sandboxPolicy`，用户可在面板提前添加或批准 Agent 申请的目录，主会话与本地子 Agent 共享、重启恢复；文件工具与 bash 同一策略，显式「Fork 并继承授权」；接入与回滚见包 README |
| [`dsh-toolchain-access`](packages/toolchain-access/) | 沙箱窄目录授权：默认开启 uv/Cargo/pnpm/Gradle/Maven 缓存、共享锁目录与 Semgrep 私有 state，workspace-write 下精确 bind（钉版 bwrap 布局、fail-closed）；可显式缩减或全关，整套工具链安装另行 opt-in；接入见 [plan-dsh-toolchain-access.md](docs/plan-dsh-toolchain-access.md) |
| [`dsh-recursive-skills`](packages/recursive-skills/) | 分类目录里嵌套的 `SKILL.md` 自动进入原生技能目录：追加 provider、按需加载、增删与 frontmatter 变化热刷新；原生直接技能仍优先；接入见 [plan-dsh-recursive-skills.md](docs/plan-dsh-recursive-skills.md) |
| [`dsh-more-providers`](packages/more-providers/) | YAML 注册额外 LLM 厂商（builtin / custom / Command Code，三种 wire 协议映射），并内建默认启用的 ChatGPT 订阅 OAuth（原 `dsh-oauth-providers` 并入本包，桥接回环登录需在桌面浏览器完成） |
| [`dsh-triggers`](packages/triggers/) | 双会话 execute → review → rework 触发循环：轮次预算、暂停/恢复、会话内浏览器视图 |

## 安装

```sh
pnpm install && pnpm build
dsh plugin --profile <profile> add ./packages/<name>
dsh --profile <profile>
```

- 插件按 profile 安装，多个 profile 需分别 `add`。
- 从 git 安装时 pnpm ≥ 10 会拦截 `prepare` 脚本，需按提示在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 放行——等于授权安装期执行代码，先审阅并钉住 commit。

## 客户端 UI

九个浏览器半插件共享 [`packages/ui`](packages/ui/)：shadcn 组合 API + Base UI 原语 + Tailwind CSS v4，颜色只使用公开的 `--dsw-alias-*` token。它是私有 workspace 包，构建期按需打进各插件的 `lib/client.js`，不单独安装或启用。构建约定见 [packages/ui/README.md](packages/ui/README.md)，迁移范围与验证记录见 [docs/client-ui-migration.md](docs/client-ui-migration.md)。

## 开发

安装 Nix 和 [devenv](https://devenv.sh/) 后，在仓库根目录运行：

```sh
devenv shell
pnpm install --frozen-lockfile
pnpm typecheck
```

使用 direnv 时，运行 `direnv allow` 即可在进入仓库时加载同一环境。devenv 提供 Node 24 和 JS/TS 语言服务器，Corepack 按 [package.json](package.json) 选择 pnpm；TypeScript 编译器仍由 workspace 锁定（`pnpm exec tsc --version`）。测试与检查所需的 Git、jj、Fish 和 Python 也在环境中；`dsh` CLI 仍由宿主提供。

[.gitignore](.gitignore) 由 [devenv.nix](devenv.nix) 中的 `integrations.gitnr` 生成。修改规则后运行 `devenv tasks run devenv:gitnr:install`，并把生成结果一同纳入版本控制，让未进入开发环境的 Git 和 jj 也能使用。

完整开发命令见 [AGENTS.md](AGENTS.md)。

## 许可

GPL-3.0-or-later。[`dsh-more-providers`](packages/more-providers/) 的 ChatGPT 协议部分派生自 [werifu/dsh-oai-oauth](https://github.com/werifu/dsh-oai-oauth)（MIT），pi-ai 适配沿用 [@earendil-works/pi-ai](https://github.com/earendil-works/pi)（MIT），完整许可文本见 [THIRD-PARTY-NOTICE.md](packages/more-providers/THIRD-PARTY-NOTICE.md)。
