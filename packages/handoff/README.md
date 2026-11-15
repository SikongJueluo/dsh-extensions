# dsh-handoff

**一条命令完成会话交接**：`/handoff <任务描述>` → 浏览器弹出**单页配置卡**（模型 / 思考强度 /
Preset / 工作区 / 自动审核；默认值预填，点字段值展开选择器，只有「开始交接」提交）→ 当前会话把
上下文浓缩成一份自包含简报写入 `.dsh/handoff/<时间戳>-handoff.md` → 插件检测到完成标记后，在
**所选工作区**、用**所选 preset** 自动新建 session（与 Web「新建会话」按钮同一条
`ctx.agents.create` 工厂链路），并把简报作为首条 prompt 交给新 agent 直接开工。不再依赖 handoff
skill，也不再手动搬运上下文。**模型与思考强度会被记住**（同一 profile 内跨 session / 工作区 /
浏览器共享），下次普通 handoff 默认沿用；**Preset 默认继承原 session**，不记忆上次的显式选择。
**不带参数的 `/handoff`（或 `/handoff --retry`）重试上一次未完成的交接**：简报已写一半的继续补完，
已写完但没来得及拉起新会话的直接拉起。

## 工作流程

```text
/handoff 修复 README 的安装一节
  │
  ├─ 浏览器弹出「交接任务」单页配置卡（默认值预填好；只有「开始交接」会提交）：
  │    模型       上次使用的模型 / 继承当前会话          [更改]
  │    思考强度   <档位> / 模型默认强度                  [更改]   （模型不支持强度时整行隐藏）
  │    Preset     继承当前 · <preset 名>                 [更改]
  │    工作区     原工作区 / <工作区>                    [更改]   （只有一个可选目标时整行隐藏）
  │    ─────────────────────────────────────
  │    自动审核   [开关]   最多 5 轮
  │                              [取消] [开始交接]
  │    · 「更改」只展开该字段的选择器（模型 / 强度 / Preset / 工作区），选完回到同一张卡
  │    · 旗标固定的字段照常显示并标注「命令指定」，不提供「更改」——摘要永远与实际一致
  │    · 上次模型不可用或旧强度不再支持时，卡片写明原因并要求重新选择
  │    · Esc 收起展开的选择器；在卡片上按 Esc 取消整个 handoff
  │    （无浏览器 half 的部署回退到问题卡片；--model/--workspace 参数预固定对应字段）
  ├─ 当前 agent 排队一个 turn：按六节模板写简报 + 末尾完成标记
  │    Goal / Current state / Key decisions / Files / Next steps / Open questions
  │    （跨区交接时额外提示：原路径对后继会话只读，关键内容自行内联进简报）
  ├─ 命令发起时宿主写 sidecar 记录 <时间戳>-handoff.meta.json（任务/原会话/所选，spawn 后回填）
  ├─ 插件轮询简报文件，命中 <!-- handoff:complete --> 即完成
  └─ ctx.agents.create({meta: {cwd = 目标工作区路径}}) → attachSession(归入目标 workspace 分组)
     → followup(简报) → 侧边栏出现 "Handoff: 修复 README …" 新会话并开始执行
```

## 重试（bare /handoff）

超时、dsh 重启、spawn 失败都会留下一次「未完成的交接」。每个 handoff 发起时会在简报旁边写一份
sidecar 记录 `<时间戳>-handoff.meta.json`（任务、原会话、当时的模型 / Preset / 工作区选择），新会话**成功创建后**
回填 `spawnedAt`——它是「这次交接到底成没成」的唯一持久判定，也是防止重复拉起会话的闸门。

不带参数的 `/handoff`（或 `/handoff --retry`，两者等价；`--retry` 与任务描述互斥）扫描简报目录，取
**最新一份没有 `spawnedAt` 的记录**，按简报文件的现状走三个分支：

1. **简报已有完成标记**（watch 丢了/进程重启了）→ 重新解析模型 / Preset / 工作区后**直接拉起新会话**，不再让
   agent 写任何东西；
2. **简报缺失或没写完** → 重新解析后，给*当前*会话排一条**续写指令**：保留已有内容、只补
   缺失部分，同一文件、超时重新计满。重试者不是原会话时，指令会注明「无法从你的历史确认的内容
   不要臆造，写进 Open questions」；文件根本没写过则退回完整简报指令；
3. **没有可重试的记录** → 报错，并提示用 `/handoff <任务描述>` 发起新交接。

重试把 sidecar 里的模型 / Preset / 工作区作为本次默认（**本次重试记录优先于长期模型偏好**；Preset
不会被记成下次普通 handoff 的默认）；`confirm: false` 时直接沿用记录，不再弹窗。`--model` /
`--workspace` 旗标在重试模式下照常生效，例如 `/handoff --retry --model gpt/x` 就是用指定模型重试。
旧 sidecar 没有 preset 字段时按「继承原会话」处理。失败通知的文案也会明确指路这个重试入口。


## 自动审核（可选，默认关闭）

挂载 [dsh-triggers](../triggers/) 后，配置卡底部有**一行自动审核开关**：默认关闭；开启后同一行显示
「最多 N 轮」。轮数不再由用户点选——默认 **5**，`--review-rounds <n>` 或重试记录里的实际预算会如实
显示。勾选后本次交接变成**执行—审核循环**——执行会话每轮**正常结束回合即自动送审**
（自动送审 run：最终回复作为交付说明；需要用户决定时才调用 `trigger_signal` 提交
needs_user），审核 prompt 自动排队回**当前会话**（保留讨论上下文的 parent）；返工意见自动
发回**同一个执行会话**，直到通过 / 需要用户决定 / 轮次用尽。循环由 triggers 插件在宿主推进，
与 handoff 只在 spawn 时交接一次。执行者侧有活动 goal 时该回合不自动送审（goal 结束后的
下一回合再送），避免把中途进展当交付。

- 审核决策**不因普通旗标被跳过**：只固定模型或工作区时，配置卡/问题卡片仍会问审核；只有显式
  `--review` / `--review-rounds`（裁决已固定，不再追问）或未挂载 triggers 时才不问。
- 顺序保证：创建 session → 记录 spawnedAt → 绑定并启动触发器 run → **才**发出首条执行
  prompt，执行者拿到的首条 prompt 自带 runId 与信号规则。
- **意图与结果分开**：命令结果写「Auto review: 已请求（最多 N 轮）——绑定随新会话创建进行」；
  绑定成功后当前会话标题栏出现「触发」状态 chip，失败则在本会话收到可见通知并降级普通交接，
  绝不留“看似已启动、实际无人审核”的执行者。
- CLI 直达：`/handoff --review <任务>`（`--review-rounds <n>` 设预算并隐含开启）。
- sidecar meta 的 `review` 节记录预算，spawn 后回填绑定结果（bindingId/runId）；裸 `/handoff`
  重试时上次的开启状态会预勾选（`confirm: false` 的无弹窗重试也沿用上次的审核裁决）。
  极少见的「绑定成功但进程随即崩溃」会在触发器面板留下一个等待交付的 run，可手动取消。

## 选择新会话的模型与思考强度

1. **浏览器配置卡（默认路径）**：Web half 在 `shell.overlay` 注册模态卡片。模型字段显示当前生效的
   路由，默认按「命令旗标 → 本次选择 → 本次重试记录 → 记住的上次模型 → 继承原会话」解析；
   「更改」在卡内展开选择器——搜索框、按厂商分组的模型列表（显示名 + 描述 + 「默认强度 X」，数据来自
   `ctx.remote.session.modelCatalog()`，与 `/model` 弹窗同源），首两项为「继承当前会话」「全局默认」。
   host 通过 `/dsh-handoff` 通道把待选请求发给浏览器，浏览器轮询取件并回传选择
   （`oauth-providers` 同款通道模式）。
2. **思考强度附属于模型**。生效模型若声明了 `reasoning.efforts`，卡片显示「思考强度」一行
   （默认「模型默认强度」或当前会话档位）；模型不声明强度时整行隐藏。「更改」展开强度列表（每档显示名
   + 描述，标注「默认」；正在用的档位标「当前」），选完回到卡片。对继承/默认路线改强度会自动变成
   「显式选该模型 + 指定强度」的等价形式。
3. **工作区字段**（仅在注册了多个 workspace 且未给 `--workspace` 时出现）：「更改」展开工作区列表——
   首项「原工作区」（description 为原 cwd），divider 后为可搜索的其余注册工作区（title + path 过滤，
   重名 title 附路径尾段；`status()` 报目录缺失的灰显不可选）。**点选即回到卡片**，名单由 host 在命令
   触发时经 `workspaceRegistry.list()` 快照并随 pending 请求下发，浏览器无需新 remote 依赖。
   只有一个可选目标时整行隐藏；`--workspace` 指定时显示目标并标注「命令指定」，不提供更改。
4. **Preset 字段**：默认「继承当前 · <原会话 preset>」；「更改」展开注册 preset 列表（`broken` 行灰显并
   给出原因）。详见下一节。
5. **问题卡片（降级路径）**：部署里没有浏览器 half（TUI/headless）时改用 `ctx.userQuestions` 卡片：
   可点选项 + "Other" 自由输入。选项 label 用模型**显示名**（重名时附 `provider`），description 显示
   `厂商 · model id`；有可用的记住路由时首项是「上次使用的模型」，失效路由只在 detail 里说明、不再提供。
   该路径不下发强度，用模型默认。需要选工作区时在模型卡之后再发一张工作区卡（同样支持 "Other" 输入
   title/path）；触发器挂载且旗标未决定审核时，**每条卡片路径最后都会多问一张审核卡**（60s 无应答视为
   关闭）；原 session 的 preset 失效时先问一张预设卡。
6. **命令直达**：`/handoff --model provider/model [--workspace <title|path>] <任务>` 跳过对应选择，
   适合脚本与 `confirm: false`；`--model` 拼写只做形状校验，路由合法性由首次请求验证（强度用模型
   默认）；`--workspace` 支持含空格的 title（最长前缀匹配）或 workspace 根路径（realpath 精确匹配），
   未命中/歧义时列出候选。两个 flag 顺序任意，`--retry` 同理（见上节）。

**三条路径各自的强度来源**：

- **继承当前会话** = 原会话**实际在用**的 provider/model/强度，读会话的 `modelSelection` 投影
  （`ctx.sessionProjections.stateOf(session, 'modelSelection')`，取 `pending → lastUsed`；投影缺席时
  回退到 agent 的创建选项）。`/model` 切换过的模型与强度因此能正确带走，原 `maxTokens` 一并保留。
- **全局默认** = 部署默认选择，**含它自带的强度**（此前只取了 provider/model，把强度丢了）。
- **显式选模型** = 你选的强度（没选则用该模型默认值），不继承原 `maxTokens`；preset 由独立字段决定，
  **不会**因为选「全局默认模型」而切回默认 preset。

### 记住上次的模型与思考强度

- 偏好存在插件自己的 storage domain（单元名 `handoff`；JSON 后端下是 `$DSH_HOME/storages/handoff.json`），
  记录键按 profile 隔离（如 `web`），因此**同一 profile 的所有 session / 工作区 / 浏览器共用，重启后
  仍在**，且不会改变 DSH 全局默认模型（`agentDefaultModel`）或新会话按钮的行为。
- 记的是**选择意图**：继承 / 全局默认 / 显式 `provider/model[+强度]`。选「继承」或「全局默认」时保存
  模式而不是冻结当时的路由；省略强度表示该模型自己的默认强度。
- 只有你**明确提交配置卡（或回答问题卡）且新会话创建成功后**才写；点开选择器、取消、超时 / 无人作答、
  `confirm:false` 的自动路径都不覆盖。写失败不阻止交接，但原会话会收到「本次选择未记住」的可见通知。
- 优先级：**命令旗标 → 本次 UI 选择 → 本次重试记录 → 上次记忆 → 首次继承原会话**。`--model` 只影响
  本次，不污染长期偏好。
- 上次模型已从目录消失、或旧强度不再被该模型支持时，卡片显示原因并要求重选，**不会静默换成原会话的
  模型**；无浏览器的路径能重选就重选，不能则带原因失败。目录暂时加载失败（provider 枚举失败/超时）
  不当作模型已删除，仍按记忆尝试，真正的路由错误由首次请求暴露。
- **不记**自动审核开关、工作区或 Preset：它们按每次交接/原 session 重新解析。

## Preset（执行预设）

- 每次普通 handoff 默认**继承原 session 实际挂载的 preset**（`agentPresets.composedPreset`），而不是
  部署默认 preset；原 session 没有 preset 时保持无 preset（`resolve(undefined)` 的语义是部署默认，
  不能当作「继承」）。
- 模型与 preset 是两个独立意图：可以「原 preset + 记住的便宜模型 + 上次强度」，也可以「自选执行
  preset + 同一模型」。
- 卡片里的显式选择只在**本次**交接（及其重试）生效；下一次普通 handoff 仍继承当时的原 session，
  不会记住上次的显式 preset。
- 已删除 / `broken` 的 preset **不会静默降级成无 preset 会话**：显式选择会在开始前失败并给出原因；
  原 session 的 preset 失效时卡片要求改选，无浏览器时问一张预设卡，`confirm: false` 则直接带原因失败。
  旧 sidecar 没有 preset 字段时按「继承原会话」处理。sidecar 里的显式 preset 在当前组合没有可用默认注册表
  （缺失或读取失败）时也会在写简报前可见失败；记录保持未创建，修复组合后可直接重试，不会被改成 inherit。
- preset 会带自己的工具 / 提示 / 行为，挂载成功不等于任务能力齐全（例如限制工具的 preset 可能看不到
  `trigger_signal`）。需要自动审核时先确认执行 preset 能正常送审。

### 其他行为要点

- **简报永远写原工作区** `.dsh/handoff/`：那是原 agent 在任何沙箱模式下都唯一确定可写、宿主插件又
  可读的位置（`/tmp` 在 bwrap 下是每次调用私有的 tmpfs，`~/.dsh` 不在 workspace-write 允许列表里，
  详见 `docs/research-dsh-handoff-cross-workspace.md`）。跨区交接不依赖全局存储：插件读原文件、把
  内容内联进首 prompt，并把**完整简报复制一份到目标工作区** `.dsh/handoff/`（宿主侧写，不受沙箱
  约束），让超长截断提示指向后继会话可读的副本；复制失败则回退引用原文件（读取不被围栏）。
- 新 session 的 `meta.cwd` = 所选工作区的 canonical path（`attachSession` 要求 cwd 与 workspace.path
  严格相等，恰好被同一值满足），并直接 `attachSession` 归入目标 workspace 分组（与 Web 在 workspace
  内新建会话同机制，排组内最前）；选「原工作区」且 cwd 无对应 workspace 时保持 ungrouped，与原会话
  一致。新会话的沙箱边界自动跟随其 cwd，无需任何沙箱侧配置。
- 跨区时简报指令会提示原 agent「原路径对后继只读、关键内容自行内联」；bootstrap prompt 会告知新
  会话「原工作区路径只读，写入一律在当前工作区进行」。
- 原 session 保持不动，可以继续回去追问。
- 原 agent 忙碌时 `followup` 自动排队到当前 turn 结束。
- 交接失败（超时/创建失败/目标工作区消失——spawn 前有 `status()` 预检）会记录日志，并可配置向原会话发一条可见通知（文案自带 bare-`/handoff` 重试指引）。
- 插件行卸载会拆除仍在等待的 watcher；已创建的 session 日志持久化，可从侧边栏重新打开。watcher 丢了也没关系：简报与 sidecar 记录都在磁盘上，bare `/handoff` 能从任何一处断点续上。

## 安装（bundle）

两种等价方式，都会同时接线宿主半插件与浏览器半插件：

1. **作为 bundle 安装**（pnpm 装进 profile 并自动登记进 `dsh.profile.bundles`）：

   ```sh
   dsh plugin --profile <name> add <本目录或 tarball>
   ```

2. **按入口文件绝对路径挂进 patch 层**（`dsh --profile web --patch <overlay>`，适合本地开发——
   entry 路径不会进 Nix store，`pnpm build` 的产物立即生效）：

   ```yaml
   - insert:
       - id: handoff
         name: '/home/<you>/Projects/dsh-extensions/packages/handoff/lib/index.js'
   ```

   client module 扫描器会用 Loader 解析该 entry，再**从 entry 文件向上找到最近的 `package.json`**
   （`packages/handoff/package.json`），读取 `dsh.client` 与 `exports["./client"]`，因此浏览器半插件
   照常加载——不必是 npm 依赖。宿主启动时建立 client 模块图，所以每次 `pnpm build` 之后**重启 dsh
   并刷新页面**。

> 只挂宿主半插件（例如把 `dsh.client` 声明去掉的自定义构建）时，模型选择自动走问题卡片降级路径。

## 配置

插件行 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dir` | `.dsh/handoff` | 简报目录，相对路径基于 session 的 workspace cwd |
| `timeoutMs` | `600000` | 等待完成标记的超时 |
| `pollMs` | `1000` | 简报文件轮询间隔 |
| `confirm` | `true` | 交接前让用户选模型（兼作取消入口） |
| `modelMenu` | `true` | 问题卡片降级路径里枚举所有 provider/model |
| `pickTimeoutMs` | `120000` | 浏览器配置卡的最长等待；超时按已解析的默认继续（默认不可用时带原因失败） |
| `notifyFailure` | `true` | 失败时向原会话排一条可见通知 |
| `maxBriefChars` | `65536` | 首条 prompt 的简报截断保护 |

建议把 `.dsh/handoff/` 加进项目 `.gitignore`。

## 依赖面

- 宿主运行时 peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`（`createUserMessage`）、
  `@deepseek-ai/dsh-storage-domain`（模型偏好）、`@deepseek-ai/schemastery`、`zod`（偏好记录 schema）。
- 其余宿主依赖（`dsh-agent` / `dsh-commands` / `dsh-session` / `dsh-session-title` / `dsh-user-questions` /
  `dsh-workspace`）均为 type-only import，构建时擦除；`agentPresets` / `agentDefaultModel` /
  `storageDomain` 用本地最小类型 shim 或 `ctx.get()` 可选获取，组合里没有对应服务时照常加载。
- 模型偏好走插件自己的 storage domain（`handoff`），不写 `agentDefaultModel`；没有 `storageDomain`
  的组装只是不记忆，交接本身不受影响。
- 浏览器 half：`src/client/index.tsx`（TSX + 共享 `@dsh-extensions/ui`，构建为 `lib/client.js` 的 `window.__ModuleLoader__.load` factory），
  经 `dsh.client` 声明，注册 `shell.overlay` 槽；模型目录取 `ctx.remote.session.modelCatalog()`，
  工作区名单随 pending 请求经通道下发（无需新 remote 依赖），与宿主通信走 `/dsh-handoff` 前缀路由
  （`ctx.connection` 的 client-request/server-response 信封 + `ctx.webServer`），与 `oauth-providers`
  的通道同构。
- **移动端适配**：单卡展开的模型 / 强度 / Preset / 工作区选择器全部触摸可达——每个选择器都有「返回配置」
  实体按钮、卡片都有「取消」（Esc 仅桌面增强），hover 反馈与 `autoFocus` 在 `pointer: coarse` 下退避，
  搜索框 16px 防 iOS 聚焦缩放，宽度 `min(560px, 92vw)` 自适应，行高/按钮 ≥ 44px 点选目标。
- 不发布任何服务，无需 isolate realm，与 stock `web` profile 直接兼容；没有 `connection`/`webServer`
  的组装里宿主半插件照常加载，只是不启用下拉。

## Roadmap（未实现）

- 简报写好后用 `userQuestions` 的 `plan-review` intent 弹审批卡，批准后才 spawn。
- 交接完成后自动跳转新会话。
- 原 session 自动归档开关。
