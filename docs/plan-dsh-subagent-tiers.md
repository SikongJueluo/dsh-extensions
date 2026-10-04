# 计划：subagent-tiers 插件上线（宿主侧改动）

状态：插件本体已在 `packages/subagent-tiers/` 构建通过（`pnpm check`）。以下是
`~/.config/nixos` 侧需要落的三处改动 + 验证步骤。全部由用户执行，本仓不再
动 `~/.dsh`。

背景（为什么）：stock `dsh-tool-subagent` 挂三个实例时工具描述一字不差，
模型选型没有任何成本/能力信号。实测 2026-10-03/04 全部 workspace 的
`tool/call` 分布：主力档（GLM-5.3）14 次、最贵 smart 档 4 次、便宜 quick 档
仅 2 次——系统性 over-escalation。插件把档位语义写进各自工具描述，升级规则
改为失败驱动（"quick 的结果不够用才升档"），配合 agents-md 的机械式触发
条件。

## 1. `home/ai/dsh/plugins.nix`：挂插件

`programs.dsh.plugins` 列表追加一项（路由用插件 Config 默认值，与现
subagents.patch.yml 完全一致；要改路由就在这里传 `config`，或在 Web 设置页
编辑——插件行 Config 会自动投影成表单）：

```nix
{
  id = "subagent-tiers";
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/subagent-tiers/lib/index.js";
}
```

默认三档（`packages/subagent-tiers/src/index.ts`）：

| 工具 | 路由 |
| --- | --- |
| `subagent_quick` | deepseek-official / deepseek-flash @ max |
| `subagent` | zai-coding-cn / glm-5.3 @ max |
| `subagent_smart` | openai-codex / gpt-6.1-sol @ xhigh |

## 2. `home/ai/dsh/subagents.patch.yml`：瘦身成一条 disable

插件会注册同名 `subagent` 工具，stock preset 里的 `tool-subagent` 行必须
disable（否则重名）；原来的 override + 两个 insert 全部删除（插件接管）。
`tool-subagent-fork` 行不动（fork 继承父上下文/父模型是刻意行为）。整个文件
替换为：

```yaml
# subagent-tiers 插件(dsh-extensions)接管三档委派工具的注册;stock 的
# tool-subagent 实例会注册同名 subagent 工具,disable 防重名。fork 行
# 不受影响(按 id 定位,只有 tool-subagent 这一行被关)。
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
```

## 3. `home/ai/agents-md.nix`：选型文案改机械式触发

`dshBlock` 替换为（失败驱动，不做难度预判）：

```nix
dshBlock =
  "\n## Subagent Tiers (DSH)\n\n"
  + "Three delegation tools with pinned routes; choose the tool, not a model.\n\n"
  + "- Start at `subagent_quick` (cheap & fast) for any delegation whose result you can verify directly.\n"
  + "- Escalate to `subagent` (workhorse) when quick's result is wrong or too shallow, or the task clearly needs multi-file engineering depth up front.\n"
  + "- Escalate to `subagent_smart` (strongest, most expensive) only after cheaper tiers failed, or for architecture decisions and adversarial review.\n"
  + "- `subagent_fork` inherits this conversation and the parent model; use it only when the subtask builds on this conversation's context.\n"
  + "- Never spend an expensive tier on work a cheaper tier already finished adequately.\n";
```

## 4. 生效与验证

```sh
pnpm -C ~/Projects/dsh-extensions build   # 已构建,幂等
# nixosRebuild / home-manager switch 后:
systemctl --user restart dsh-web
```

- 新开会话，模型看到的 `subagent` / `subagent_quick` / `subagent_smart`
  三个工具描述应当各不相同（quick 自称默认档、smart 自称保留档）。
- `dsh --profile web --dump-config`：`tool-subagent` 行带 `disabled`，
  plugins 层出现 `subagent-tiers` 行。
- 观察一周左右的 `tool/call` 分布：期望 quick 占比显著上升、smart 只在
  升级链尾出现。

回滚：revert 上述三处即可，stock `subagent` 工具随 `tool-subagent` 行恢复。

## 已知边界

- `workflow` 工具仍是模型自由选路的旁路（`agent()` 的 provider/model 覆盖
  不经白名单）；本次未处理，需要时再单独 disable `tool-workflow` 行。
- 插件要求 provider（默认 `spawn`）具备 `agentOptions` + `prepareContinuable`
  能力，缺失会在挂载时报错而不是静默降级。
- `subagent_quick` / `subagent_smart` 的 continuable 行为与现配置一致：
  后台默认，`run_in_background: false` 前台等待；depth 仍读宿主
  `subagent.maxDepth` 设置（默认 1）。
