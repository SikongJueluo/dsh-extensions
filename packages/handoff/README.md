# dsh-handoff

**一条命令完成会话交接**：`/handoff <任务描述>` → 浏览器弹出**模型下拉**（可搜索、按厂商分组，可继承当前会话或用全局默认）→ 注册了多个 workspace 时再弹**工作区选择步**（首项「原工作区」，其余可搜索）→ 当前会话把上下文浓缩成一份自包含简报写入
`.dsh/handoff/<时间戳>-handoff.md` → 插件检测到完成标记后，在**所选工作区**自动新建 session
（与 Web「新建会话」按钮同一条 `ctx.agents.create` 工厂链路），并把简报作为首条 prompt 交给新
agent 直接开工。不再依赖 handoff skill，也不再手动搬运上下文。

## 工作流程

```text
/handoff 修复 README 的安装一节
  │
  ├─ 浏览器模态下拉：搜索 + 按厂商分组的模型列表（数据同 /model 弹窗）
  │    首两项 = 继承当前会话 / 全局默认；选中带 reasoning 的模型再选「思考强度」
  │    多工作区时再选「新会话开在哪个工作区？」：首项 = 原工作区（「当前」徽标），
  │    其余可搜索；目录已不存在的灰显不可选。Esc 逐级回退、再按取消整个 handoff
  │    （无浏览器 half 的部署回退到问题卡片；--model/--workspace 参数直接跳过对应选择）
  ├─ 当前 agent 排队一个 turn：按六节模板写简报 + 末尾完成标记
  │    Goal / Current state / Key decisions / Files / Next steps / Open questions
  │    （跨区交接时额外提示：原路径对后继会话只读，关键内容自行内联进简报）
  ├─ 插件轮询简报文件，命中 <!-- handoff:complete --> 即完成
  └─ ctx.agents.create({meta: {cwd = 目标工作区路径}}) → attachSession(归入目标 workspace 分组)
     → followup(简报) → 侧边栏出现 "Handoff: 修复 README …" 新会话并开始执行
```

## 选择新会话的模型与思考强度

1. **浏览器下拉（默认路径）**：Web half 在 `shell.overlay` 注册模态选择器——搜索框、按厂商分组的
   模型列表（显示名 + 描述 + 「默认强度 X」，数据来自 `ctx.remote.session.modelCatalog()`，与
   `/model` 弹窗同源），首两项为「继承当前会话」「全局默认」。host 通过 `/dsh-handoff` 通道把待选
   请求发给浏览器，浏览器轮询取件并回传选择（`oauth-providers` 同款通道模式）。
2. **第二步：思考强度**。选中的模型若声明了 `reasoning.efforts`，同一模态切到强度列表（每档显示名 +
   描述，标注「默认」；若所选正是当前会话的模型，则预标注该会话正在用的档位为「当前会话」）。
   `Esc`／「返回」回模型列表，「取消」结束整个 handoff。
3. **第三步：目标工作区**（仅在注册了多个 workspace 且未给 `--workspace` 时出现）：同一模态切到
   工作区列表——首项「原工作区」（带「当前」徽标，description 为原 cwd），divider 后为可搜索的
   其余注册工作区（title + path 过滤，重名 title 附路径尾段；`status()` 报目录缺失的灰显不可选）。
   名单由 host 在命令触发时经 `workspaceRegistry.list()` 快照并随 pending 请求下发，浏览器无需新
   remote 依赖。`Esc`／「返回」逐级回退（工作区 → 强度 → 模型），「取消」结束整个 handoff。
4. **问题卡片（降级路径）**：部署里没有浏览器 half（TUI/headless），或浏览器在 `pickTimeoutMs` 内
   没有应答时，改用 `ctx.userQuestions` 卡片：可点选项 + "Other" 自由输入。选项 label 用模型
   **显示名**（重名时附 `provider`），description 显示 `厂商 · model id`；该路径不下发强度，用模型默认。
   需要选工作区时在模型卡之后再发一张工作区卡（同样支持 "Other" 输入 title/path）。
5. **命令直达**：`/handoff --model provider/model [--workspace <title|path>] <任务>` 跳过对应选择，
   适合脚本与 `confirm: false`；`--model` 拼写只做形状校验，路由合法性由首次请求验证（强度用模型
   默认）；`--workspace` 支持含空格的 title（最长前缀匹配）或 workspace 根路径（realpath 精确匹配），
   未命中/歧义时列出候选。两个 flag 顺序任意。

**三条路径各自的强度来源**：

- **继承当前会话** = 原会话**实际在用**的 provider/model/强度，读会话的 `modelSelection` 投影
  （`ctx.sessionProjections.stateOf(session, 'modelSelection')`，取 `pending → lastUsed`；投影缺席时
  回退到 agent 的创建选项）。`/model` 切换过的模型与强度因此能正确带走，原 `maxTokens` 一并保留。
- **全局默认** = 部署默认选择，**含它自带的强度**（此前只取了 provider/model，把强度丢了）。
- **显式选模型** = 你选的强度（没选则用该模型默认值），**保留当前会话的 preset**（同一人设、不同大脑），
  不继承原 `maxTokens`。

要点：

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
- 交接失败（超时/创建失败/目标工作区消失——spawn 前有 `status()` 预检）会记录日志，并可配置向原会话发一条可见通知。
- 插件行卸载会拆除仍在等待的 watcher；已创建的 session 日志持久化，可从侧边栏重新打开。

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
| `timeoutMs` | `300000` | 等待完成标记的超时 |
| `pollMs` | `1000` | 简报文件轮询间隔 |
| `confirm` | `true` | 交接前让用户选模型（兼作取消入口） |
| `modelMenu` | `true` | 问题卡片降级路径里枚举所有 provider/model |
| `pickTimeoutMs` | `120000` | 浏览器下拉的最长等待；超时按「继承当前会话」继续 |
| `notifyFailure` | `true` | 失败时向原会话排一条可见通知 |
| `maxBriefChars` | `65536` | 首条 prompt 的简报截断保护 |

建议把 `.dsh/handoff/` 加进项目 `.gitignore`。

## 依赖面

- 宿主运行时 peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`（`createUserMessage`）、`@deepseek-ai/schemastery`。
- 其余宿主依赖（`dsh-agent` / `dsh-commands` / `dsh-session` / `dsh-session-title` / `dsh-user-questions` /
  `dsh-workspace`）均为 type-only import，构建时擦除；`agentPresets` / `agentDefaultModel` 用本地最小类型
  shim，运行时走 `ctx.get()` 可选获取。
- 浏览器 half：`client/client.js`（`window.__ModuleLoader__.load`，纯 JS + `React.createElement`），
  经 `dsh.client` 声明，注册 `shell.overlay` 槽；模型目录取 `ctx.remote.session.modelCatalog()`，
  工作区名单随 pending 请求经通道下发（无需新 remote 依赖），与宿主通信走 `/dsh-handoff` 前缀路由
  （`ctx.connection` 的 client-request/server-response 信封 + `ctx.webServer`），与 `oauth-providers`
  的通道同构。
- **移动端适配**：三级步全部触摸可达——工作区/强度步有「返回」「取消」实体按钮（Esc 仅桌面增强），
  hover 反馈与 `autoFocus` 在 `pointer: coarse` 下退避，搜索框 16px 防 iOS 聚焦缩放，宽度
  `min(560px, 92vw)` 自适应，行高保持 ≥ 44px 点选目标。
- 不发布任何服务，无需 isolate realm，与 stock `web` profile 直接兼容；没有 `connection`/`webServer`
  的组装里宿主半插件照常加载，只是不启用下拉。

## Roadmap（未实现）

- 简报写好后用 `userQuestions` 的 `plan-review` intent 弹审批卡，批准后才 spawn。
- 交接完成后自动跳转新会话。
- 原 session 自动归档开关。
