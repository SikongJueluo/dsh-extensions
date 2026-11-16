# 部署与迁移：crew 动态路由 + 共享配置库

状态：仓库内实现与门禁已完成；下列 `~/.dsh` / Nix 改动由用户执行，agent 不写宿主
配置、不改 flake。旧的三档方案见 [plan-dsh-crew.md](plan-dsh-crew.md)（已标记被本文
取代）。

## 目标工具面

| 工具 | 来源 | 说明 |
| --- | --- | --- |
| `subagent` | crew | 必填 `route`；前台/后台语义与 stock continuable 一致 |
| `create_agent` | crew | 必填 `route`；常驻角色代理 |
| `list_agents` / `send_message` / `interrupt_agent` | stock `tool-subagent-control` / `.../list-agents` | 控制面 |
| stock `subagent` / `subagent_fork` | preset `delegation` 组内嵌套行 | **删除**（重名 + 继承父模型旁路） |
| `workflow` | `workflow-ptc` + `tool-workflow` | **删除**（脚本自由选路旁路） |

## 1. 写 `crew.yaml`

```fish
cp ~/Projects/dsh-extensions/packages/crew/example.yaml ~/.dsh/crew.yaml
$EDITOR ~/.dsh/crew.yaml
```

按你实际批准的模型填 `candidates`：第一条首选，后续按顺序降级；`desc` 会被原样
放进系统提示，写成给模型看的一句话。旧 Nix `presets.nix` 里 quick/workhorse/smart
的模型只是**迁移素材**，不是新默认值：把它们翻译成路由，例如把旧的
`opencode-go/deepseek-v4.1-flash@max → deepseek-official/deepseek-flash@max`
写成一条 `execute` 路由的两个候选。

## 2. 更新插件行（必须）

旧行里的 `quick` / `workhorse` / `smart` 字段已从 Config 删除；Schemastery 会
忽略这些未知键（不会报错、也不会生效），但请一并删掉，避免误以为它们还在控制
路由。新行只有两个键：

```nix
{
  id = "crew";
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/crew/lib/index.js";
  # config = { provider = "spawn"; };          # 默认值，可省
  # config = { configFile = "~/elsewhere.yaml"; };  # 需要隔离时才写
}
```

`provider` 是 **subagent backend**（默认 `spawn`），不是 LLM provider。旧行里的
tier 覆盖全部删掉，模型策略只留在 `crew.yaml`。

## 3. 继续重述 preset（机制不变）

`home/ai/dsh/subagents.patch.yml` 仍需整份重述 `preset-standard`（以及会话可能
落在的 `preset-cordis`），从 `delegation` 组删去 `tool-subagent` /
`tool-subagent-fork` / `workflow-ptc` / `tool-workflow` 四行，保留 control /
list-agents。模板见 `packages/crew/dev.patch.yml`。原因与维护代价见旧文档第 2 节：
loader 的按 id 覆盖打不进组内嵌套行，升级 dsh 后要重新 diff 官方预设。

## 4. 更新 `~/.dsh/AGENTS.md` 的 Delegation 文案

该文件由 `home/ai/agents-md.nix` 生成，必须一起改；否则模型仍会被旧文案诱导去
调用已删除的 `subagent_quick` / `subagent_smart`。建议块（按你的路由改名）：

```markdown
## Delegation (DSH)

Delegation runs through the crew tools with user-configured routes.

- `subagent` starts a one-shot child and needs `route`; pick the route whose
  description in the delegation route table matches the task.
- `create_agent` starts a persistent named agent on a route; send it tasks with
  `send_message` and reuse it for repeated work of the same kind.
- The model and any approved fallback are fixed by the configuration. Do not
  ask for or invent provider/model names.
- If the tools report that the configuration is unusable, tell the user to fix
  `~/.dsh/crew.yaml`; do not retry the delegation.
- Start independent delegations together in one assistant message and continue
  useful work while they run.
```

## 5. 生效与验证

```fish
pnpm -C ~/Projects/dsh-extensions build
sudo nixos-rebuild switch --flake ~/.config/nixos#Minisforum
```

- 新会话（旧会话的工具面在创建时冻结）里应只剩 `subagent` / `create_agent`
  与三个控制面工具；`subagent_quick` / `subagent_smart` / `create_agent.tier` 不再存在。
- 把 `~/.dsh/crew.yaml` 改坏一个字段：Web 出现一次错误 toast，包含文件、字段与
  「修好后自动恢复」；此时调用 `subagent` 应明确报错。修好后无需重启，toast 显示
  一次恢复提示，新委派恢复。
- 正常委派的结果里应看到 `route` 与实际 `provider/model`；发生降级时另有
  `notice` 说明跳过了哪个候选及原因。
- more-providers 的配置错误现在也会以 toast 提示，但 provider 注册仍只在启动时
  进行：修好文件后 toast 仍显示错误，直到重启 dsh。这是刻意的（不做 provider
  热注册）。

## 已知边界

- 预检只验路由/模型元数据，不验凭据；key 缺失仍属于请求期失败，不触发候选降级。
- 配额是 provider 级软依赖（`planUsage`），缺失/超时按未知处理，真实请求仍可能
  失败；运行中途撞限额不会热切候选。
- 常驻 agent 创建后不跟随 YAML 变化；删除路由不会终止它们。
