# dsh-handoff

**一条命令完成会话交接**：`/handoff <任务描述>` → 当前会话把上下文浓缩成一份自包含简报写入
`.dsh/handoff/<时间戳>-handoff.md` → 插件检测到完成标记后，在同一 workspace 自动新建 session
（与 Web「新建会话」按钮同一条 `ctx.agents.create` 工厂链路），并把简报作为首条 prompt 交给新
agent 直接开工。不再依赖 handoff skill，也不再手动搬运上下文。

## 工作流程

```text
/handoff 修复 README 的安装一节
  │
  ├─ (可选) 确认卡片：继承当前会话的 preset/model，或全局默认；关掉卡片 = 取消
  ├─ 当前 agent 排队一个 turn：按六节模板写简报 + 末尾完成标记
  │    Goal / Current state / Key decisions / Files / Next steps / Open questions
  ├─ 插件轮询简报文件，命中 <!-- handoff:complete --> 即完成
  └─ ctx.agents.create({meta: {cwd 同源}}) → attachSession(归入原 workspace 分组)
     → followup(简报) → 侧边栏出现 "Handoff: 修复 README …" 新会话并开始执行
```

- 新 session 与原 session 同 cwd，并经 `resolveByPath(cwd) → attachSession` 显式归入原 workspace 分组（与 Web 在 workspace 内新建会话同机制，排组内最前）；cwd 无对应 workspace 时保持 ungrouped，与原会话一致。
- 原 session 保持不动，可以继续回去追问。
- 原 agent 忙碌时 `followup` 自动排队到当前 turn 结束。
- 交接失败（超时/创建失败）会记录日志，并可配置向原会话发一条可见通知。
- 插件行卸载会拆除仍在等待的 watcher；已创建的 session 日志持久化，可从侧边栏重新打开。

## 安装（bundle）

```sh
dsh plugin --profile <name> add <本目录或 tarball>
```

或在 composition patch 里引用 `./cordis.patch.yml`（单行插件 `handoff` → `dsh-handoff`）。

## 配置

插件行 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dir` | `.dsh/handoff` | 简报目录，相对路径基于 session 的 workspace cwd |
| `timeoutMs` | `300000` | 等待完成标记的超时 |
| `pollMs` | `1000` | 简报文件轮询间隔 |
| `confirm` | `true` | 交接前弹 preset/model 确认卡片（兼作取消入口） |
| `notifyFailure` | `true` | 失败时向原会话排一条可见通知 |
| `maxBriefChars` | `65536` | 首条 prompt 的简报截断保护 |

建议把 `.dsh/handoff/` 加进项目 `.gitignore`。

## 依赖面

- 运行时 peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`（`createUserMessage`）、`@deepseek-ai/schemastery`。
- 其余（`dsh-agent` / `dsh-commands` / `dsh-session` / `dsh-session-title` / `dsh-user-questions`）均为
  type-only import，构建时擦除；`agentPresets` / `agentDefaultModel` 用本地最小类型 shim，运行时走
  `ctx.get()` 可选获取。
- 不发布任何服务，无需 isolate realm，与 stock `web` profile 直接兼容。

## Roadmap（未实现）

- 简报写好后用 `userQuestions` 的 `plan-review` intent 弹审批卡，批准后才 spawn。
- 浏览器半插件：交接完成后自动跳转新会话。
- 原 session 自动归档开关。
