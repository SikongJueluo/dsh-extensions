# 计划/记录：crew 插件上线 + 默认委派工具屏蔽

状态：插件本体在 `packages/crew/`（`pnpm check` 通过）；nix 侧已由 agent 代改
（jj `feat(dsh): delegate through crew tiers and block stock tools`）。首轮部署
用的"顶层行 disable"被实测证伪，已改为 **preset-standard 声明覆盖**，等待再次
rebuild 生效。

目标工具面（模型的委派选择被收窄到"只能选档位"）：

| 工具 | 来源 | 去向 |
| --- | --- | --- |
| `subagent_quick` / `subagent` / `subagent_smart` | crew 插件 | 保留（三档，路由钉死） |
| `create_agent` | crew 插件 | 保留（常驻角色代理，tier 枚举复用三档路由） |
| `list_agents` / `send_message` / `interrupt_agent` | stock `tool-subagent-control` / `tool-subagent-list-agents` 行 | 保留（crew 的控制面） |
| stock `subagent` / `subagent_fork` | preset `delegation` 组内嵌套行 | **从 preset 覆盖中删除** |
| `workflow` | preset `workflow-ptc` + `tool-workflow` 行 | **从 preset 覆盖中删除** |

## 1. `home/ai/dsh/plugins.nix`：挂插件（已落地）

`programs.dsh.plugins` 追加（路由用插件 Config 默认值，可在 Web 设置页改）：

```nix
{
  id = "crew";
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/crew/lib/index.js";
}
```

默认三档（`packages/crew/src/index.ts`）：quick = deepseek-official /
deepseek-flash @ max；workhorse = zai-coding-cn / glm-5.3 @ max；smart =
openai-codex / gpt-6.1-sol @ xhigh。

## 2. `home/ai/dsh/subagents.patch.yml`：覆盖 preset-standard 声明

**首轮教训（2026-10-06 实测）**：按行 id `- id: tool-subagent / disabled: true`
只命中**顶层**行（那些本来就被 web-app 根 patch disable 了，等于空操作）；
standard 预设从 `delegation` 组的**嵌套**行重新挂出 stock `subagent`（含
`modelSelectionSettings: true`）、`subagent_fork`、`workflow`。dump-config 证实
嵌套行原样启用。Loader 的按 id 覆盖打不进组内嵌套行，唯一可靠做法是**按行
id `preset-standard` 整份重述声明**（config 整体替换）。

正确做法：该文件内容 = 对官方 `dsh-web-app/presets/standard.patch.yml`
（0.2.0-rc.2）的逐行重述，仅从 `delegation` 组删去 `tool-subagent` /
`tool-subagent-fork` / `workflow-ptc` / `tool-workflow` 四行；其余（persona、
planning/compaction 组、control/list-agents、codex/claude-code/ralph 的原生
disabled 行等）原样保留。模板见 `packages/crew/dev.patch.yml`（由脚本从官方
文件做文本手术生成：去 `- insert:` 头、整体缩进减 4、删四个行块）。

**维护代价**：升级 dsh 后必须重新 diff 官方 standard 预设，把新增/变更行同步
进这份重述，否则 preset 漂移。

## 3. `home/ai/agents-md.nix`：选型文案（已落地）

`dshBlock` 为失败驱动的机械式文案（quick 起步 → 升档要理由 → create_agent /
list_agents 用法），2026-10-06 rebuild 后已确认再生成进 `~/.dsh/AGENTS.md`
并在存活会话内热刷新。

## 4. 生效与验证

```sh
pnpm -C ~/Projects/dsh-extensions build   # 已构建,幂等
sudo nixos-rebuild switch --flake ~/.config/nixos#Minisforum
```

- **新开会话**（旧会话保留其创建时的 preset 修订，工具面不回溯）：委派工具
  应当只剩 `subagent_quick` / `subagent` / `subagent_smart` / `create_agent` /
  `list_agents` / `send_message` / `interrupt_agent`；`subagent_fork` 与
  `workflow` 消失；三个 tier 工具描述各不相同。
- `dsh --profile web --dump-config`：`preset-standard` 行的 config 为重述版
  （delegation 组内无 tool-subagent / fork / workflow）。
- 观察一周左右的 `tool/call` 分布：期望 quick 占比显著上升。

## 验证记录（2026-10-06，首轮 rebuild 后）

- crew 插件挂载 ✓：存活会话内 `subagent_quick` / `subagent_smart` /
  `create_agent` 均为新描述（Tool inspect 证实）。
- **路由钉死 ✓**：`subagent_quick` 前台委派一次，子会话 `request/header` =
  `{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"max"}`。
- 旧会话残留 ✗（预期内）：本会话仍见 stock `subagent`（旧描述）、
  `subagent_fork`、`workflow` —— preset 修订随会话冻结 + 首轮 disable 无效，
  均由 preset 覆盖修复，新会话生效。

## 已知边界

- 插件要求 provider（默认 `spawn`）具备 `agentOptions` + `prepareContinuable`
  能力，缺失会在挂载时报错而不是静默降级。
- `create_agent` 语义 = 常驻角色代理：bootstrap 提示词让子代理确认角色后
  待命，恒为后台；后续任务经 `send_message`。
- depth 仍读宿主 `subagent.maxDepth` 设置（默认 1），create_agent 创建的
  常驻代理同样受深度约束。
