# dsh-extensions

Out-of-tree [DeepSeek Harness](https://www.deepseek.com/harness/en/) 插件 bundle 集，pnpm workspace monorepo。

| Bundle | 说明 |
| --- | --- |
| [`dsh-oauth-providers`](packages/oauth-providers/) | OAuth 认证的 LLM 厂商集（当前：ChatGPT 订阅），无需 API Key |
| [`dsh-plan-usage`](packages/plan-usage/) | GLM / OpenAI Codex / MiniMax / OpenCode Go 套餐配额查询，`planUsage` 服务 + 设置页分区 |
| [`dsh-auto-permit`](packages/auto-permit/) | 审批瀑布上的 AI 判官：小模型在弹窗之前决定是否放行 bash 提权（精确记忆 → 高危形状让路 → 判官调用） |
| [`dsh-cmd-permit`](packages/cmd-permit/) | 同一瀑布上的确定性白名单：配置内的命令族提权不弹窗也不耗判官调用（种子收敛为 `rtk`；缓存类绕行改走 toolchain-access 目录授权）；`denyShape` 高危表以 `ctx.cmdPermit` 共享给上面那位 |
| [`dsh-execution-guard`](packages/execution-guard/) | 参数预检（审批与副作用**之前**、同批整体校验）+ 重复 `INVALID_ARGS` 纠偏提示（原生 repeat-reminder 只认完全相同的参数，抓不到"值在变、形状没变"） |
| [`dsh-task-anchor`](packages/task-anchor/) | `checkpoint_task` 恢复锚点：记 jj 工作层 / goal 身份 / 阶段 / 归属文件 / 验证摘要，恢复时比对并报告一致或漂移（只报告，不 rebase、不 resume goal） |
| [`dsh-auto-env`](packages/auto-env/) | 按 session 工作区自动加载 direnv / devenv 环境 |
| [`dsh-auto-continue`](packages/auto-continue/) | 套餐限额后睡到重置点自动重试，支持跨进程重启续跑 |
| [`dsh-crew`](packages/crew/) | 固定路由委派工具组：三档 subagent（quick / 主力 / smart）+ `create_agent` 常驻角色代理，档位语义写进工具描述治 over-escalation |
| [`dsh-handoff`](packages/handoff/) | `/handoff <任务>` 一条命令交接会话，简报即新 session 的首条 prompt |
| [`dsh-context-audit`](packages/context-audit/) | `/context-audit` 命令 + 侧边栏面板：按 provider/model、工具、会话三层统计本机会话日志（缓存命中率、工具失败率…），数据不出本机 |
| [`dsh-remote-exec`](packages/remote-exec/) | 白名单远端容器执行工具：在固定 SSH 主机的固定 Docker 容器里跑 fish 命令，ssh 走宿主侧 spawn，跳板链与 agent 转发原样生效 |
| [`dsh-rtk-rewrite`](packages/rtk-rewrite/) | rtk 命令改写执行器：模型跑 `git status`、实际执行 `rtk git status`，用确定性压缩输出降低上下文压力 |
| [`dsh-search-integrator`](packages/search-integrator/) | 多源检索 + 整合模型一次成文：`web_research` 吃整个问题，去重排序后返回带引文校验的综合答案与覆盖说明 |

## 安装

```sh
pnpm install && pnpm build
dsh plugin --profile <profile> add ./packages/<name>
dsh --profile <profile>
```

- 插件按 profile 安装，多个 profile 需分别 `add`。
- 从 git 安装时 pnpm ≥ 10 会拦截 `prepare` 脚本，需按提示在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 放行——等于授权安装期执行代码，先审阅并钉住 commit。

## 开发

见 [AGENTS.md](AGENTS.md)。

## 许可

GPL-3.0-or-later。`packages/oauth-providers` 部分派生自 [werifu/dsh-oai-oauth](https://github.com/werifu/dsh-oai-oauth)（MIT）与 [@earendil-works/pi-ai](https://github.com/earendil-works/pi)（MIT），完整许可文本见 [THIRD-PARTY-NOTICE.md](packages/oauth-providers/THIRD-PARTY-NOTICE.md)。
