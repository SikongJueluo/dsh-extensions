# dsh-crew

用户配置的委派路由：`subagent`（一次性任务，前台/后台）与 `create_agent`
（常驻角色代理）。路由、模型候选、降级顺序全部写在外部 YAML 里；模型只能从
系统提示中的路由表里**选路由名**，不能选 provider/model、不能自己找替代模型。
配套控制面 `send_message` / `interrupt_agent` / `list_agents` 来自 stock 的
`tool-subagent-control` / `tool-subagent-list-agents` 行。

## 为什么

固定三档（quick/workhorse/smart）把「贵/便宜」硬编码进了工具名和描述，用户
无法按自己的工作流增减路由，也无法为一条路由批准多个模型候选。现在策略只有
一个来源：

- 路由数量、名字、用途说明由用户在 `crew.yaml` 里决定；
- 每条路由的 `candidates` 是**显式批准**的有序模型列表，第一个可用者胜出；
- 工具 schema 保持稳定（`route` 是普通字符串），每步通过系统提示给出当前
  路由表，改 YAML 不会在 step 中途重注册工具。

## 快速开始

```fish
pnpm -C packages/crew build
cp packages/crew/example.yaml ~/.dsh/crew.yaml   # 按需改路由/模型
```

然后按 [部署](#部署) 挂上插件。YAML 缺失或无效时插件**拒绝一切新委派**
（工具仍可见，执行时报错），修好后自动恢复，无需重启。

## 配置

默认路径 `$DSH_HOME/crew.yaml`（`DSH_HOME` 默认 `~/.dsh`）。插件行可用
`configFile` 指定另一个文件；相对路径以进程 cwd 为基准，支持 `~/` 展开。
`provider` 插件行选项是 **subagent backend**（默认 `spawn`），与 LLM provider
无关。

```yaml
routes:
  execute:
    desc: 用于代码实现、文件修改和常规执行任务。
    candidates:
      - provider: provider-a
        model: model-a
        reasoningEffort: high
      - provider: provider-b
        model: model-b
  review:
    desc: 成本较高，用于审查、设计讨论和复杂推理。
    candidates:
      - provider: provider-c
        model: model-c
```

| 字段 | 规则 |
| --- | --- |
| `routes` | 必填，至少一条 |
| 路由 id | 小写字母开头，只含小写字母/数字/`_`/`-`，≤40 字符；`constructor` 等原型键保留字不可用 |
| `desc` | 必填的非空字符串；渲染进系统提示时折叠空白 |
| `candidates` | 必填、非空数组；按顺序尝试 |
| `candidate.provider` / `.model` | 必填的非空字符串 |
| `candidate.reasoningEffort` | 可选；省略即用模型默认（不会继承父模型 effort），空字符串视为无效 |
| 其它键 | 根、路由、候选三层都拒绝未知字段 |

整份文件严格校验、整体切换；任何一处错误都让整份策略失效，没有部分生效。
YAML 不展开环境变量、不写密钥；密钥仍在原有凭据机制里。

## 行为

- **选路**：委派前按 `candidates` 顺序检查。`ctx.llm.resolveCallConfig` 失败
  （provider 未注册、模型改名、effort 不支持）或 `planUsage` 明确报告套餐窗口
  用尽，就跳过该候选并试下一个。配额缺失、查询失败或超时一律按**未知**处理，
  不据此判不可用；所有候选的配额读取共享 2s 预算，同一 provider 只读一次。
- **effort**：候选省略 `reasoningEffort` 时，用 `resolveCallConfig` 解析出的
  模型默认值；若解析器合法地没有物化默认值（模型未声明 `defaultEffort`），
  则在 `agent/created` 阶段用子 agent 自己的 `model.select({provider, model})`
  覆盖（文档保证省略 effort 走 adapter 默认、不继承旧值），再让第一步请求执行。
  两种情况都不硬编码 effort。
- **全部候选不可用**：工具调用明确报错，列出每个候选的原因；不跨路由、不采用
  未批准模型、不回退到已耗尽的候选。
- **结果**：返回 `route`、实际 `provider`/`model`（有 effort 时一并返回）与
  agent id；发生跳过时附 `notice` 原因并写 warn 日志。降级是批准范围内的正常
  行为，不弹错误 toast。
- **并发/生命周期**：后台默认（`run_in_background: false` 才前台等待并返回
  结果）；前台非 `completed` 结束映射为错误 + 诊断 + 部分输出，run 必 dispose；
  后台 agent 不随工具调用结束或后续 abort 释放。`create_agent` 恒为后台。
- **depth** 读取宿主 `subagent.maxDepth` 设置，每次委派时解析。
- **backend 能力**：provider（默认 `spawn`）需要 `agentOptions` +
  `prepareContinuable`，缺则挂载即报错；provider 后注册也行
  （`subagent/provider-added` 后补挂）。
- **热加载只影响新 agent**：已创建的常驻 agent 保持原模型，删除路由也不会终止
  它们；不取消已开始执行的子任务。
- **策略在准备期间变化**：如果选路期间 YAML 被改（revision 变化）且子 agent
  尚未创建，本次委派明确拒绝并要求重新委派；不自动重试、不混用新旧策略。
- **配置无效 fail closed**：首次缺失/无效与运行中改坏都拒绝新委派，不使用
  last-known-good；修好并通过整份校验后自动恢复，并在 Web 上显示一次恢复提示。
- 监听的是文件所在目录，因此编辑器原子替换、Nix 符号链接切换、删除后重建都能
  重新加载；80ms 去抖，旧读取永远不会覆盖新读取。

## Web 提示

Host 在 `/dsh-crew/config-status` 暴露当前状态（只读 JSON：文件、错误、revision、
恢复方式）。浏览器半插件经 `shell.overlay` 挂一个共享 toast：

- 页面加载/重连后读取当前状态，仍无效就提示（不会因为页面离线而漏报）；
- 同一错误不因轮询或 watcher 重复弹出；用户关闭后在**同一次连接**内不再打扰，
  但 DSH 重连（新的 connection generation）会重新提示当前仍存在的错误；
- 多个 preset 实例共享同一个状态路由（聚合返回 `instances`），不会因宿主拒绝
  重复路由而丢失通知；
- 修好后自动显示一次「配置已恢复」；
- 已修好的历史错误在页面加载时不补弹。

## 验证

```sh
pnpm -C packages/crew build
node packages/crew/smoke.mjs
```

smoke 覆盖：YAML 校验矩阵、候选顺序降级（路由不可用 / 窗口用尽 / 全部不可用 /
abort 不降级 / 配额去重与超时）、真实 `apply()` 的委派路径与生命周期、每步
路由表、无效配置 fail closed、热加载恢复、准备期间改策略的 revision 拒绝。

## 部署

挂本插件的 profile 应 disable stock 委派行：`tool-subagent`（防 `subagent`
重名）、`tool-subagent-fork`（继承父模型，旁路）、`tool-workflow` +
`workflow-ptc`（脚本自由选路，旁路）。保留 `tool-subagent-control` 与
`tool-subagent-list-agents`。preset 的 `delegation` 组是**嵌套行**，按行 id
覆盖打不到，必须整份重述预设声明——见 [plan-crew-routes.md](../../docs/plan-crew-routes.md)
与 `dev.patch.yml`。

**从三档迁移**：不再有 `subagent_quick` / `subagent_smart` / `create_agent.tier`。
需要把旧插件行 Config 里的 `quick`/`workhorse`/`smart` 与 fallback 改写进
`crew.yaml` 的 routes，并更新 `~/.dsh/AGENTS.md` 里由 Nix 生成的 Delegation
文案（旧文案会继续诱导模型调用已删除的工具）。具体步骤见部署文档。
