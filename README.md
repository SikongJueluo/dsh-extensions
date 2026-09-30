# dsh-extensions

Out-of-tree [DeepSeek Harness](https://www.deepseek.com/harness/en/) 插件 bundle 集，pnpm workspace monorepo。

| Bundle | 说明 |
| --- | --- |
| [`dsh-oauth-providers`](packages/oauth-providers/) | OAuth 认证的 LLM 厂商集（当前：ChatGPT 订阅），无需 API Key |
| [`dsh-handoff`](packages/handoff/) | `/handoff <任务>` 一条命令交接会话，简报即新 session 的首条 prompt |
| [`dsh-plan-usage`](packages/plan-usage/) | GLM / OpenAI Codex / MiniMax 套餐配额查询，`planUsage` 服务 + 设置页分区 |
| [`dsh-auto-continue`](packages/auto-continue/) | 套餐限额后睡到重置点自动重试，支持跨进程重启续跑 |
| [`dsh-auto-env`](packages/auto-env/) | 按 session 工作区自动加载 direnv / devenv 环境 |

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
