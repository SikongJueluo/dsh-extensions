# dsh-handoff

**一条命令完成会话交接**：`/handoff <任务描述>` → 浏览器弹出**模型下拉**（可搜索、按厂商分组，可继承当前会话或用全局默认）→ 当前会话把上下文浓缩成一份自包含简报写入
`.dsh/handoff/<时间戳>-handoff.md` → 插件检测到完成标记后，在同一 workspace 自动新建 session
（与 Web「新建会话」按钮同一条 `ctx.agents.create` 工厂链路），并把简报作为首条 prompt 交给新
agent 直接开工。不再依赖 handoff skill，也不再手动搬运上下文。

## 工作流程

```text
/handoff 修复 README 的安装一节
  │
  ├─ 浏览器模态下拉：搜索 + 按厂商分组的模型列表（数据同 /model 弹窗）
  │    首两项 = 继承当前会话 / 全局默认；Esc 或「取消」= 取消整个 handoff
  │    （无浏览器 half 的部署回退到问题卡片；--model 参数直接跳过选择）
  ├─ 当前 agent 排队一个 turn：按六节模板写简报 + 末尾完成标记
  │    Goal / Current state / Key decisions / Files / Next steps / Open questions
  ├─ 插件轮询简报文件，命中 <!-- handoff:complete --> 即完成
  └─ ctx.agents.create({meta: {cwd 同源}}) → attachSession(归入原 workspace 分组)
     → followup(简报) → 侧边栏出现 "Handoff: 修复 README …" 新会话并开始执行
```

## 选择新会话的模型

1. **浏览器下拉（默认路径）**：Web half 在 `shell.overlay` 注册模态选择器——搜索框、按厂商分组的
   模型列表（显示名 + 描述，数据来自 `ctx.remote.session.modelCatalog()`，与 `/model` 弹窗同源），
   首两项为「继承当前会话」「全局默认」。host 通过 `/dsh-handoff` 通道把待选请求发给浏览器，
   浏览器轮询取件并回传选择（`oauth-providers` 同款通道模式）。
2. **问题卡片（降级路径）**：部署里没有浏览器 half（TUI/headless），或浏览器在 `pickTimeoutMs` 内
   没有应答时，改用 `ctx.userQuestions` 卡片：可点选项 + "Other" 自由输入。选项 label 用模型
   **显示名**（重名时附 `provider`），description 显示 `厂商 · model id`。
3. **命令直达**：`/handoff --model provider/model <任务>` 跳过选择，适合脚本与 `confirm: false`；
   拼写只做形状校验，路由合法性由首次请求验证。

显式切换模型时**保留当前会话的 preset**（同一人设、不同大脑），`reasoningEffort`/`maxTokens`
不从原会话继承，交由目标模型默认值。

要点：

- 新 session 与原 session 同 cwd，并经 `resolveByPath(cwd) → attachSession` 显式归入原 workspace 分组（与 Web 在 workspace 内新建会话同机制，排组内最前）；cwd 无对应 workspace 时保持 ungrouped，与原会话一致。
- 原 session 保持不动，可以继续回去追问。
- 原 agent 忙碌时 `followup` 自动排队到当前 turn 结束。
- 交接失败（超时/创建失败）会记录日志，并可配置向原会话发一条可见通知。
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
  经 `dsh.client` 声明，注册 `shell.overlay` 槽；数据取 `ctx.remote.session.modelCatalog()`，
  与宿主通信走 `/dsh-handoff` 前缀路由（`ctx.connection` 的 client-request/server-response 信封 +
  `ctx.webServer`），与 `oauth-providers` 的通道同构。
- 不发布任何服务，无需 isolate realm，与 stock `web` profile 直接兼容；没有 `connection`/`webServer`
  的组装里宿主半插件照常加载，只是不启用下拉。

## Roadmap（未实现）

- 简报写好后用 `userQuestions` 的 `plan-review` intent 弹审批卡，批准后才 spawn。
- 交接完成后自动跳转新会话。
- 原 session 自动归档开关。
