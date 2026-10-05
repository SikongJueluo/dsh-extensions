# 计划：crew 插件上线 + 默认委派工具屏蔽（宿主侧改动）

状态：插件本体已在 `packages/crew/` 构建通过（`pnpm check`；旧名
`subagent-tiers` 已废弃改名）。以下是 `~/.config/nixos` 侧需要落的三处改动 +
验证步骤。全部由用户执行，本仓不动 `~/.dsh`。

目标工具面（模型的委派选择被收窄到"只能选档位"）：

| 工具 | 来源 | 去向 |
| --- | --- | --- |
| `subagent_quick` / `subagent` / `subagent_smart` | crew 插件 | 保留（三档，路由钉死） |
| `create_agent` | crew 插件 | 保留（常驻角色代理，tier 枚举复用三档路由） |
| `list_agents` / `send_message` / `interrupt_agent` | stock `tool-subagent-control` / `tool-subagent-list-agents` 行 | 保留（crew 的控制面） |
| stock `subagent` | preset `tool-subagent` 行 | **disable**（与 crew 的 `subagent` 重名） |
| `subagent_fork` | preset `tool-subagent-fork` 行 | **disable**（继承父模型 = 绕过档位；fork 钉别的模型又会丢 KV 前缀复用，不如关） |
| `workflow` | preset `tool-workflow` + `workflow-ptc` 行 | **disable**（脚本里 `agent()` 可自由指定 provider/model，最后一条旁路） |

背景（为什么）：stock `dsh-tool-subagent` 挂多个实例时工具描述一字不差，
模型选型没有任何成本/能力信号。实测 2026-10-03/04 全部 workspace 的
`tool/call` 分布：主力档（GLM-5.3）14 次、最贵 smart 档 4 次、便宜 quick 档
仅 2 次——系统性 over-escalation。crew 把档位语义写进各自工具描述，升级规则
改为失败驱动（"quick 的结果不够用才升档"），并把 fork / workflow 两条自由
选路旁路一并关掉。

## 1. `home/ai/dsh/plugins.nix`：挂插件

`programs.dsh.plugins` 列表追加一项（路由用插件 Config 默认值；要改路由就
在这里传 `config`，或在 Web 设置页编辑——插件行 Config 会自动投影成表单）：

```nix
{
  id = "crew";
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/crew/lib/index.js";
}
```

默认三档（`packages/crew/src/index.ts`）：

| 档位 | 路由 |
| --- | --- |
| quick | deepseek-official / deepseek-flash @ max |
| workhorse | zai-coding-cn / glm-5.3 @ max |
| smart | openai-codex / gpt-6.1-sol @ xhigh |

## 2. `home/ai/dsh/subagents.patch.yml`：disable 全部 stock 委派工具

整个文件替换为（`tool-subagent-control` / `tool-subagent-list-agents` 两行
**不在**此列，保留）：

```yaml
# crew 插件(dsh-extensions)接管全部委派工具的注册。disable 四条 stock 行:
# - tool-subagent:注册同名 subagent 工具,与 crew 重名;
# - tool-subagent-fork:fork 继承父上下文与父模型,是绕过档位的旁路
#   (fork 钉别的模型会丢 KV 前缀复用,不划算,直接关);
# - tool-workflow / workflow-ptc:workflow 脚本的 agent() 可自由指定
#   provider/model,是模型选路白名单的最后一条旁路。
# 保留 tool-subagent-control 与 tool-subagent-list-agents(send_message /
# interrupt_agent / list_agents 是 crew 的配套控制面)。
- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true

- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true

- id: tool-workflow
  disabled: true

- id: workflow-ptc
  disabled: true
```

## 3. `home/ai/agents-md.nix`：选型文案改机械式触发

`dshBlock` 替换为（失败驱动，不做难度预判）：

```nix
dshBlock =
  "\n## Delegation (DSH)\n\n"
  + "Delegation runs through the crew tools with pinned routes; choose the tier, not a model.\n\n"
  + "- Start at `subagent_quick` (cheap & fast) for any delegation whose result you can verify directly.\n"
  + "- Escalate to `subagent` (workhorse) when quick's result is wrong or too shallow, or the task clearly needs multi-file engineering depth up front.\n"
  + "- Escalate to `subagent_smart` (strongest, most expensive) only after cheaper tiers failed, or for architecture decisions and adversarial review.\n"
  + "- `create_agent` starts a persistent named agent with a standing role on a tier; send it tasks with `send_message` and reuse it for repeated work of the same kind.\n"
  + "- `list_agents` lists live agents; `interrupt_agent` stops one.\n"
  + "- Never spend an expensive tier on work a cheaper tier already finished adequately.\n";
```

## 4. 生效与验证

```sh
pnpm -C ~/Projects/dsh-extensions build   # 已构建,幂等
# nixosRebuild / home-manager switch 后:
systemctl --user restart dsh-web
```

- 新开会话，模型看到的委派工具应当**只有**：`subagent_quick` / `subagent` /
  `subagent_smart` / `create_agent` / `list_agents` / `send_message` /
  `interrupt_agent`（外加 `job_*` 常规件）。`subagent_fork` 与 `workflow`
  应当消失；三个 tier 工具描述各不相同（quick 自称默认档、smart 自称保留档）。
- `dsh --profile web --dump-config`：上述四行带 `disabled`，plugins 层出现
  `crew` 行。
- 观察一周左右的 `tool/call` 分布：期望 quick 占比显著上升、smart 只在
  升级链尾出现。

回滚：revert 上述三处即可，stock 工具随行恢复。

## 已知边界

- 插件要求 provider（默认 `spawn`）具备 `agentOptions` + `prepareContinuable`
  能力，缺失会在挂载时报错而不是静默降级。
- `create_agent` 语义 = 常驻角色代理：bootstrap 提示词让子代理确认角色后
  待命，恒为后台；后续任务经 `send_message`。没有"空 prompt 创建"的 API，
  这是最贴近的等价物。
- depth 仍读宿主 `subagent.maxDepth` 设置（默认 1），create_agent 创建的
  常驻代理同样受深度约束（它们自己不能再委派，除非调大设置）。
