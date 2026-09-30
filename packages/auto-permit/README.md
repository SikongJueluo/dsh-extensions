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
