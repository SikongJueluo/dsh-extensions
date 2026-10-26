# 调研：handoff 精简 UI、记住模型与选择 preset

> **结论：三项均可在现有插件内完成，DSH 0.2.0-rc.2 API 足够，无需修改 DSH 本体。**
> 模型／思考强度传递和 preset 挂载已有实现；缺少的是 handoff 专用偏好持久化，以及把 preset 从模型选择中解耦。
> 本次仅调研并记录方案，未修改插件实现、安装 bundle 或更改运行配置。

- 日期：2026-10-27。
- 对象：本仓 `packages/handoff` + 当前运行的 DSH `0.2.0-rc.2`。
- 方法：主线程 live Inspect 契约核实 + 本仓源码 + 后台 agent 查阅已安装包源码 + 用户指定 UI skill。
- 已安装包源码基路径（下文 `$DSH`）：
  `/nix/store/j180lw8q1g0mdxsp21swmnjbajc7my76-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`。
  storage 包目录由 live `Config.listConfigs` 返回；preset 注册表类型亦直接复核。

## 1. 现状：哪些已支持，哪些未支持

| 需求 | 当前状态 | 判断 |
| --- | --- | --- |
| 不再选择审核轮数，默认 5 | 宿主已有 `DEFAULT_REVIEW_ROUNDS = 5`；浏览器额外提供 1/2/3/5/8 按钮 | 删除 UI 控件即可，不是 API 问题 |
| 删除说明小字 | 主卡有流程说明，审核区有开关说明／角色说明／信号规则 | 可直接精简，不必改业务流程 |
| 记住上次模型和思考强度 | 普通新 handoff 默认 inherit；只有重试从 sidecar 恢复上次选择 | 需要新增插件偏好记录 |
| 自选 preset，默认继承原会话 | spawn 已用 registry 解析／挂载 preset，但没有独立的选择字段 | API 已具备，需解耦模型与 preset |

证据：`packages/handoff/src/command.ts:55,694-710,757-769`；
`packages/handoff/client/client.js:196-223,665-737`；`packages/handoff/src/spawn.ts:49-97`。

这里的「5 次」按现有代码理解为**自动审核最多 5 轮**，不是创建 5 个 handoff 会话。
建议保留审核开关、移除轮数选择；`--review-rounds N` 可保留为命令高级入口，默认仍为 5。
已有重试记录或显式旗标不是默认值，不应被 UI 隐藏后错误显示成 5。

## 2. 功能一：记住模型与思考强度

### 2.1 传递选择已经支持

- `AgentOptions` 已有 `provider?`、`model?`、`reasoningEffort?`、`maxTokens?`；
  `ctx.agents.create({ agentOptions, ... })` 可直接使用，创建失败／setup 失败会拒绝。
  来源：live `Service.listService({service:'agents'})` 的 `AgentOptions`、`CreateAgentOptions`。
- handoff 已把显式模型和强度映射到创建参数；模型默认强度用省略 `reasoningEffort` 表达。
  来源：`src/selection.ts:65-78`、`src/spawn.ts:49-67`。
- 原会话实际模型取 `modelSelection` 投影的 `pending → lastUsed`，再回退创建选项；
  不应只读 `agent.options`，否则遗漏 `/model` 后续切换。来源：`src/selection.ts:37-62`。
- 模型目录已有每模型的 `reasoning.efforts` 和 `defaultEffort`，无需手写统一的 low/medium/high。
  来源：live `Service.listService({service:'sessionController'})` 的 `ModelCatalog`／`ModelReasoning`。

### 2.2 推荐持久化入口：插件自己的 storage domain

已核实：

- `ctx.storageDomain.open(spec)` 返回 `Domain`；可用 `domain.global.get()`／`global.set(value)`，
  或一张表的 `get`／`put`／`update` 保存记录；调用者负责 `close()`。
  来源：live `Service.listService({service:'storageDomain'})`。
- `defineDomain` 声明名称、版本和 zod schema；读为同步内存值，写在后端确认持久化后才 resolve。
  来源：`$DSH/dsh-storage-domain/README.md:28-58,71-94`。
- 当前 profile 确有 `include:storage-domain`、`include:storage-json` 挂载项。
  来源：live `Config.listConfigs` 对这两个包的查询。
- 本仓 triggers 已采用同一路径，不必另造文件存储层。
  来源：`packages/triggers/src/store.ts:1-6,54-66`。

**建议记录 handoff 专用偏好，不修改 DSH 全局默认模型。**
`agentDefaultModel.saveSelection()` 虽然存在，但会改变部署默认；
`sessionController.selectModel()` 还会改原 session 模型并后台保存默认，都不适合本需求。
来源：live `Service.listService({service:'agentDefaultModel'})` 与 `sessionController`。

概念数据只需 `{ lastModelChoice, updatedAt }`，其中显式模型保存
`provider + model + reasoningEffort?`；若用户选「继承」或「全局默认」，保存选择模式，
不要冻结为当时的某个原会话模型。`reasoningEffort` 缺省明确表示「模型默认」。
不记 workspace、审核开关或 preset 为下一次普通 handoff 默认，避免扩大需求。

建议行为（产品取舍，不是 DSH 自动提供）：

1. 点击「开始交接」、宿主接受有效选择时才保存；浏览列表、取消、超时都不覆盖。
2. 默认优先级：**本次旗标／用户修改 > 本次重试记录 > handoff 上次偏好 > 首次继承原会话**。
3. Web、问题卡片降级、`confirm:false` 共用宿主默认解析；不能只给浏览器预填。
4. 模型已不可用时提示重选；明确不支持的旧强度不得原样提交。元数据暂时加载失败与模型已删除要区分。
   DSH 对显式不支持的 effort 会在 provider I/O 前拒绝，不自动 clamp／alias。
   来源：live `Service.listService({service:'llm'})` 的 `resolveModelInfo`／`resolveCallConfig`。
5. 偏好写失败应提示「本次选择未记住」，无需因此阻止 handoff。

**作用域不能想当然：** domain 的数据边界由后端 route／root 决定，并非名称天然按 profile 隔离。
建议产品语义定为「同一 profile 的 handoff 共用上次选择，跨工作区、跨浏览器」；
若多个 profile 共用 root，应把 profile／插件实例标识纳入记录键。
不建议用浏览器 localStorage 作为唯一数据源（手机、其他浏览器、headless 不共享）。
JSON 后端无跨进程写锁，同一文件并发写为 last-completion-wins；不应承诺跨 Host 进程实时同步。
来源：`$DSH/dsh-storage-domain/README.md:62-67,149-153`；
`$DSH/dsh-storage-json/README.md:34-56,139-143`。

## 3. 功能二：preset 选择，默认继承原 session

### 3.1 已发布的 API

下表均由主线程 live `Service.listService({service:'agentPresets'})` 成功确认，
不是把 Inspect 方法当作插件业务接口：

| 目的 | 插件调用 | 关键语义 |
| --- | --- | --- |
| 枚举 | `ctx.agentPresets.list()` | 含 `id/name?/description?/order?/broken?`，坏 preset 也会列出 |
| 带默认标记的 roster | `remoteExportList()`（Remote `list`） | 行带 `isDefault` |
| 原会话实际 preset | `composedPreset(agent.ctx)` | live 已挂载 preset 的 id；可能 undefined |
| 验证／解析 | `resolve(id?)` | 省略 id = 部署默认，**不是继承原 session** |
| 创建时挂载 | `mount(agentCtx, id)` | 在新会话 `setup` 中绑定当前 revision |
| 精确继承父修订 | `composeFrom(newCtx, parent.ctx)` | 继承父会话实际保留的 revision，而不只是相同 id |

类型补证：`$DSH/dsh-agent-preset-registry/lib/types/index.d.ts:37-95`。
默认 id 无需硬编码：通过默认 roster 标记或 `resolve()` 获取。
`resolve` 的返回可能带 `broken`；显式选择时应检查，不能只检查是否抛错。
来源：该包 `lib/index.js:603-660`。

创建组合已具备：`CreateAgentOptions.meta.agentPreset` 记录创建身份，
`setup` 内执行 `mount`（或继承分支执行 `composeFrom`），`agentOptions` 独立设置模型／强度。
只写 `meta.agentPreset` 不等价于完成挂载。
来源：live `agents` 契约；现有 `packages/handoff/src/spawn.ts:74-97,252-260`；
官方 `$DSH/dsh-api-session-controller/lib/index.js:358-371`。

### 3.2 必须解除现有耦合

现有 `spawn.ts:82-86`：`choice.kind === 'default'` 就 `resolve(undefined)`，
所以「全局默认模型」会**顺带切到默认 preset**；显式模型则继承原 preset。
新增选择后应拆成两项独立意图：

- 模型：上次偏好／继承模型／全局默认模型／显式路由与强度。
- preset：**默认继承原 session**／显式选择某个 preset。

结果可以是「原会话 preset + 上次选择的便宜模型 + 上次强度」，也可以是
「自选执行 preset + 同一个模型」。模型参数与 preset 挂载在工厂入口相互独立；
preset 顶层 schema 只有身份、显示信息、插件列表，不要求模型与之绑定。
来源：live `agents`／`agentPresets`；`$DSH/dsh-agent-preset/lib/types/index.d.ts:6-17`。

不必先新增 preset 白名单、默认 preset 配置或「裸会话」选项；这些不是本次必要需求。
继承语义建议明确为原 live session 实际挂载；若要求连 revision 都一致，可使用 `composeFrom`。
原 session 没挂 preset 时，要明确是否保持无 preset，不能把 undefined 直接传给 resolve 当作「继承」。

preset 选择随本次 pending／sidecar 保存，重试保留本次选择；
下一次普通 handoff 仍默认继承当时的原 session，而非记住上次显式 preset。
已删除／`broken` 的显式 preset 应提示重选或阻止创建，不能照现状静默降级成无 preset 会话。
来源：`src/meta.ts:19-38`、`src/channel.ts:45-98`、`src/spawn.ts:93-96`。

### 3.3 能力边界

preset 不只是显示名称，而是一组工具／提示／行为插件；换 preset 后必须测试任务所需工具可见性。
本仓 triggers 在宿主注册 `trigger_signal`，普通组合下可被新 root 会话继承；
但有工具限制或服务隔离的自定义 preset 不能据此保证兼容。
即使执行者正常结束会自动送审，`needs_user` 仍依赖信号入口。
来源：`packages/triggers/src/{index,tool,prompts}.ts`；`packages/handoff/src/spawn.ts:177-199`；
`$DSH/dsh-tools/lib/index.js:2878-2910,2937-2959`。

## 4. UI 建议：减少决策，不再追加一个配置向导

用户指定参考：
[UI refactor skill](https://github.com/LovroPodobnik/refactoring-ui-skill/blob/main/.claude/skills/ui-refactor/SKILL.md)、
[hierarchy](https://github.com/LovroPodobnik/refactoring-ui-skill/blob/main/.claude/skills/ui-refactor/references/hierarchy.md)、
[layout-spacing](https://github.com/LovroPodobnik/refactoring-ui-skill/blob/main/.claude/skills/ui-refactor/references/layout-spacing.md)。
相关原则是限制选择、优先常用路径、弱化竞争元素、用间距建立分组；不是把所有文字缩得更小。

建议保留现有单页配置卡，直接点值更改，选择器按需展开：

```text
交接任务
<任务>

模型        <上次模型>             ▾
思考强度    <上次强度>             ▾
Preset      继承当前 · <名称>       ▾
工作区      原工作区               ▾

自动审核                         [开关]

                    取消    开始交接
```

- 去掉 1/2/3/5/8 按钮、轮预算标签、角色／trigger_signal 流程说明和底部重复说明。
- 审核开启时可在同一行写「自动审核 · 最多 5 轮」，无需单独说明段；显式旗标／重试显示实际预算。
- 模型、强度突出当前值，不堆「已选模型」「当前」「继承」等重复徽标。
- 单工作区且没有可变更目标时可不占一行；模型不支持强度时不显示强度行。
- preset 列表沿用同卡展开模式，首项「继承当前」，损坏项禁选并展示必要错误。
- 错误、命令锁定、失效偏好等影响结果的信息保留；移动端点按目标仍至少 44px。
- 继续使用宿主主题 token，不引入独立 HTML 或修改宿主 DOM。

当前 live `Slots.listSubTree({root:'shell.overlay'})` 已确认 additive 槽存在、
`dsh-handoff-picker` 注册 active；可在现有挂载点内完成，无需新的 UI 扩展点。
以上仅为信息结构建议，没有制作／安装原型或做浏览器视觉验证。

## 5. 后续实施范围与验证清单

仅需 handoff 包内改动：偏好存储、默认解析、preset wire／sidecar／spawn、client UI；
新增对 storage-domain 的声明依赖，扩充本地 preset 类型 shim 或采用官方类型。
不需要变更 DSH 本体或手动改 `~/.dsh`；特殊 profile 缺存储／preset 服务时须明确降级。

未来实现至少验证：

- 首次／有偏好／取消／重启后记忆；换 session、工作区和浏览器仍按预定作用域工作。
- 显式旗标、重试、`confirm:false`、无 Web 降级路径的默认值一致。
- 切模型后强度不会沿用不支持的旧档；默认强度与显式档位语义分清。
- 默认模型不再切 preset；继承 preset／自选 preset 均能配显式模型和强度。
- preset 删除／broken／无 registry、存储失败时错误可见且不静默裸会话执行。
- 自动审核仍用实际预算；自定义 preset 的执行与 needs_user 链路可用。
- `pnpm check`、相关单测，以及桌面／移动端、明暗主题的实机检查。

本次未运行构建／单测，因为未改实现；未调用创建会话、保存偏好、切换模型或 preset 等 business API。
契约支持与源码路径已核实，不等同于新增功能的运行期端到端验证，也未核实每个已安装 preset 的当前健康状态。
本次没有访问凭据或私有会话内容。
完备 live 契约查询：Host `Service` 的 `agents`、`agentPresets`、`agentDefaultModel`、
`sessionController`、`llm`、`storageDomain`、`settings`；Host `Config` 的 storage 包目录；Client `Slots` 的 `shell.overlay`。
本仓文件链接与 `$DSH` 包内行号为相应事实的一手证据，UI 链接为用户指定设计参考。
