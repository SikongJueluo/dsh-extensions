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
3. **判官判决**：一次性小模型调用，证据 = 会话内全部用户 prompt（截最近
   16 条）+ 待批命令全文（含 description / justification，标记为
   agent 声称的意图）+ 本会话已批准命令列表。`VERDICT: allow` → 放行；
   其余一切（defer / 超时 / 解析失败）→ 回落到人工弹窗。

判官**永不返回 rejected**——AI 的保守误报不能伪装成用户的明确拒绝；
任何插件自身故障也都回落人工（fail-open 向人），坏了最多退回原生行为。

非 bash 工具的审批一律 `next()` 交还原链路。风险自担：放行即
`danger-full-access` 执行，请谨慎选择判官模型。

## 配置

Web 设置页的「自动审批」分区：

- **启用开关**（默认开；未配置判官模型时不生效）。
- **判官模型**：从部署的全部模型目录中选择（与 /handoff、/model 同一目录），
  支持思考强度的二级选择。判官模型必须显式指定——不跟随会话模型，
  避免主模型审自己。

配置落在插件自身的行 config（dsh 0.2 设置模型：settings namespace ≡ profile 行 id
`auto-permit`，`{enabled, provider, model, reasoningEffort?}` 全部 volatile，
Settings 页编辑即热生效，无需重挂载）。

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
