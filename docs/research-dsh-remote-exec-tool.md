# 调研：DSH 远端容器执行工具（remote-exec）

> 结论先行：**可以实现，且不需要动 DSH 上游或放宽沙箱**。四个所需能力在 0.2.0-rc.2
> 里都有官方挂点：`ctx.tools.register`（给模型一个 `remote_exec` 工具）、
> `ctx.subprocess.spawn`（宿主侧 spawn `ssh`，天然不在模型 bash 沙箱内，能读真实
> `~/.ssh`）、`ctx.approval.request`（复用 bash 提权同款 Web 审批弹窗，按 target
> 授权）、插件行 `Config`（白名单由 operator 声明式管理）。推荐做成 dsh-extensions
> 新 bundle `packages/remote-exec`（`dsh-remote-exec`）。

- 调研对象：DSH `0.2.0-rc.2`（本机 nix store 安装；
  `/nix/store/0z3j9r5hc9vq2ifb29kcrbbxf4m2ik5q-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/`，
  内部包在其 `node_modules/@deepseek-ai/` 下，下称 `$DSH/<pkg>`）。
- 需求来源：「沙箱SSH拦截解决方案」会话的收敛结论（白名单远端容器执行工具）。
- 方法：Host Inspect 服务目录 + 三路并行源码调研（工具注册链 / 宿主执行 / 审批模型）
  + 本仓 auto-env、auto-permit 两个已上线插件的先例 + Mini-Nav `remote.py` 协议读码。

## 1. 需求回顾（上一轮讨论收敛的规格）

| 需求 | 决策 |
|---|---|
| 主接口 | `remote_exec(target, command, timeout?)` 一个；服务器/容器/用户/目录/shell 全部藏在配置里 |
| 白名单 | 配置固定 server + container（+ user/workdir/shell/autoStart），模型只能选 target 名，不能覆盖 hostname/容器/SSH 参数 |
| 强制进 Docker | 宿主侧只允许「检查容器 → 必要时 `docker start` → `docker exec`」；容器不存在/启动失败明确报错；**绝不回落宿主 shell** |
| 自动启动 | 只 `docker start` 已有容器；不创建、不重建、不换镜像 |
| 授权 | 按 target 授权（会话级），不逐条审批实验命令 |
| SSH 身份 | 私钥、known_hosts、config 全部留宿主侧；不复制进工作区/容器/上下文 |
| 结果语义 | 容器内输出 + 退出码；准备阶段错误单独分类；超时/断线 = 结果未知，不自动重跑 |
| 长任务 | 不在本工具范围（远端 tmux 自理：agent 可用本工具提交 `tmux new -d …`） |
| 数据同步 | 继续走 Syncthing；本工具不做文件传输/端口转发/PTY |

## 2. 要镜像的执行协议（Mini-Nav `remote.py` 读码）

`~/Projects/Mini-Nav/mini_nav/utils/remote.py`（2026-10 读码）现有链路：

```text
本地 ssh -p <port> -o BatchMode=yes -o StrictHostKeyChecking=accept-new [<opts>] <target> bash -s --
    ↓ stdin 喂远端 bash 脚本（set -Eeuo pipefail）
检查 docker 存在 → docker inspect 容器存在（否则 exit 127）→ State.Running == true（否则 exit 127）
    ↓
exec docker exec -i -u "$(id -u):$(id -g)" -w <workdir> <container> \
     /home/"$(id -un)"/.nix-profile/bin/fish -l -c '<inner>'
    ↓ inner = fish_add_path -g $HOME/.nix-profile/bin;
             若有 .envrc: direnv allow . （静默容错）+ eval (direnv export fish);
             <用户命令>
```

对本工具的三点含义：

1. **UID/GID 与 fish 路径都在远端求值**（`$(id -u)` 在远端 bash 里展开），
   本地不假设具体 UID——保持这个性质，operator 配置里就不需要硬编码
   `containerUser: "1000:1000"`（可留显式覆盖口）。
2. **脚本经 stdin 传输**（`bash -s --`），避免多层 argv 引号地狱——插件的
   `subprocess.spawn` 支持写 stdin：`stdio.stdin: 'pipe'` 暴露
   `handle.stdin: Writable`（`$DSH/dsh-subprocess/lib/types/types.d.ts:26-27,57,157-158`，
   亲自核对）。
3. **现状不自动启容器**（not running → exit 127）。本工具在此处插入
   `autoStart` 分支：`docker start` + 轮询 `State.Running`（带上限），其余
   行为原样保留。`direnv allow .` 是否自动执行做成 per-target 配置
   （`envInit: 'direnv' | 'none'`），把 remote.py 里的隐式行为显式化。

## 3. DSH 接口逐项核对

（本节按三路源码调研的结果填写，所有断言带 `$DSH/<pkg>/lib/…:行号` 引文。）

### 3.1 工具注册：`ctx.tools.register`（+ `defineTool`）

（源码调研确认，行号相对 `$DSH` 内部包的 `lib/types/index.d.ts` 等。）

- `ToolRuntime.register(definition): () => void`（dsh-tools/lib/types/index.d.ts:636）：
  effect-based、返回精确 disposer；**scope-aware**——普通插件 `ctx.tools.register`
  = 全局层（所有 agent 可见），在 `agent.ctx` 上调用 = 该 agent 层。
- `ToolDefinition = ToolSchema + { output, execute, timeoutMs?, … }`
  （index.d.ts:115-191）。模型可见的只有 name/description/parameters
  （`schemas()` 白名单，lib/index.js:3039-3049）。
- **参数 schema 不是 schemastery/zod**，是 dsh-tools 自带的
  `ParameterSchemaSpec` DSL（`{ type:'string'|'number'|…, required?, description? }`，
  schema.d.ts:72-84）。用 `defineTool({...})`（schema.d.ts:248）获得
  InferArgs/InferValue 推断 + 自动校验；schemastery 只用于插件行 Config。
- `execute(args, exec: ToolRunContext): Promise<unknown>`：args 冻结快照；
  `exec` = `{ callId, rootCallId, name, arguments, agent?, parent?, signal }`
  （index.d.ts:216-242, 282-287, 305-322）——**agent ✅ / session ✅
  （`exec.agent.session`）/ 取消 signal ✅ / cwd 无直接字段**（bash 的取法
  `exec.agent?.session.header.cwd`，dsh-tool-bash/lib/index.js:294）。
- 返回**单个 canonical lossless-JSON value**，须过 `output.schema` 校验，由
  `output.render(args, value)` 投影成 ContentBlock[]（index.d.ts:106-113）；
  throw = isError 结果。`presentCall`/`presentResult` 可选做 UI 卡片。
- **超时**：`ToolDefinition.timeoutMs` 是框架协作预算（模型不可见，由
  `dsh-tool-call-timeout-policy` 作为 `tools/execute` wrapper 执行，
  index.d.ts:152-158）——声明即得，要求工具转发 `exec.signal`。
  bash 参数里的 `timeoutMs` 是 bash 自己转发给 shell executor 的模型参数；
  我们照 bash 做：`args.timeoutMs` + config 默认/上限，自己控制 AbortController。
- **后台**：`run_in_background` 是 bash 的参数，但底座 **`ctx.jobs` 是通用作业
  服务**（`start/list/read/kill/wait/remove`，dsh-jobs/lib/types/index.d.ts:59-137）。
  bash 的模板：`ctx.inject(['jobs'], jobCtx => …)` 服务出现时热切后台版、缺席时
  降级 foreground-only（dsh-tool-bash/lib/index.js:697-710）——v2 想给
  remote_exec 加后台时照抄即可；模型的 job_* 工具由 dsh-tool-jobs 提供，自动通用。
- 标准插件四导出（dsh-tool-bash / dsh-tool-todo 同构）：
  `export const name` / `export const inject = ['tools', …]` / `export const Config`
  （schemastery）/ `export function apply(ctx, config)`。官方模板
  （docs /en/develop/basic/tool + dsh-tools/README.md:30-58）：

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'remote-exec'
// approval 机会式获取（ctx.get('approval')，缺席 fail-closed），不进 inject：
export const inject = ['tools', 'subprocess']

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'remote_exec',
    description: '…',
    parameters: { target: { type: 'string', required: true }, … },
    output: { schema: { type: 'object', … }, render: (args, value) => […] },
    async execute(args, exec) { /* exec.signal / exec.agent 可用 */ },
  }))
}
```

### 3.2 宿主侧执行：`ctx.subprocess`

（源码调研确认；行号相对 `$DSH` 内部包。）

- `spawn(spec: SubprocessSpawnSpec)`（dsh-subprocess/lib/types/types.d.ts:69-99）：
  - `argv: readonly string[]`——**argv 数组，绝不本地 shell 解释**（无 shell
    选项；shell 语义归 dsh-shell 消费者）；
  - `cwd` 必填；`graceMs` 必填（TERM→KILL 宽限期）；
  - `stdio`：stdin = `'ignore' | 'pipe' | {data: string}`（**静态脚本能以
    `{data}` 一次喂入**，types.d.ts:30-32）；stdout/stderr =
    `'pipe' | 'inherit' | {maxBytes, spill?: {maxBytes}}`（尾保留 + 溢出
    spill 文件）；
  - `signal?: AbortSignal` 是**唯一**取消/超时机制（"the caller owns
    deadlines"，本 seam 无 timeoutMs 字段）——插件自己持 AbortController；
  - `env?`：显式条目在 scrub 后合并，`undefined` 值 = 墓碑删除。
- `SubprocessHandle`（types.d.ts:156-183）：`stdin`(Writable，pipe 模式)、
  `collected`（collect 流 offset 读器，退出后仍可读）、
  `done: Promise<{exitCode, signal}>`、`terminate()`（幂等）、
  `waitForExit()`（等进程组清空）。
- **环境继承**：scrubbedParentEnv 只剔 `/KEY|PASSWORD|SECRET|TOKEN/i` +
  `DSH_*` 前缀键；**PATH、HOME、locale、代理变量明确存活**
  （dsh-subprocess/lib/types/index.d.ts:26-27 文档原句），
  **`SSH_AUTH_SOCK` 不匹配正则、存活**——宿主侧 ssh 的 agent 转发与
  `~/.ssh` 全部可用。
- **不经沙箱**：dsh-subprocess-local 完全不知道 sandbox（bwrap/Landlock 只
  在 dsh-sandbox-local，其调用方是 bash/pwsh/terminal 执行器与
  ptc-runtime-node 等）。宿主 spawn 的"containment"只是进程树管理：Linux
  上经 `systemd-run --user --scope` 放进用户瞬态 scope（= dsh server 同
  UID），无任何文件系统隔离。
- `resolveExecutable(command)`：绝对路径校验 / 裸名按 PATH 查找
  （`sshPath: 'ssh'` 配置可直接用它）。
- 本仓先例（已上线）：`packages/auto-env/src/direnv.ts:208-218` 同款形状
  （argv / cwd / stdio 预算 / graceMs / signal / `await handle.done` /
  `handle.collected.stdout.readFrom(0)`），完整可抄。

### 3.3 审批：`ctx.approval.request`（复用 bash 提权同款 UI）

（0.2.0-rc.2 源码确认 + 本仓 `docs/research-dsh-approval-auto-permit.md` 背景。）

- `ApprovalRequest` 字段：`{ agent, toolName, callId?, reason?, displayReason?{en,…},
  signal? }`（dsh-user-approval/lib/types/index.d.ts:68-89；没有
  kind/permission/metadata——权限语义编入 reason 字符串）。`displayReason`
  是 0.2 新增，仅本地化展示、不进审计。
- `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
  （types.d.ts:26）。answerer 链 = `approval/request` waterfall（Web GUI
  审批面板 + ACP 编辑器都是链上 answerer）；缺失/异常归一 'unavailable'
  （fail-closed）。
- **自定义工具直接复用**：工具 `execute()` 内
  `await ctx.approval.request({ agent: exec.agent, toolName, callId: exec.callId,
  reason, displayReason: {en, zh}, signal: exec.signal })` 即弹出与 bash 提权
  一样的 ApprovalPanel（UI 按 toolName 泛化，带 callId 还有调用详情 slot，
  dsh-client-ui-approval/lib/client.js:111,350-353）。bash 的提权正是同一
  seam（dsh-sandbox/lib/index.js:99-123）。注意 `ctx.get('approval')`
  机会式获取 + fail-closed（dsh-tools/lib/index.js:3440-3447 模式）。
- 审计：request() 自动成对 append `approval/asked`/`approval/decided` 到
  session log，**必须 turn 包裹**（dsh-user-approval/lib/index.js:128-144）——
  工具 execute() 天然在 turn 内，满足。
- 审批时机：bash 是「模型先被沙箱拒 → 带参重试才触发」；我们没有沙箱拒绝
  这一层，**每次首次用 target 时主动 ask**（tool-body 路径）。对比
  `tools/pre-execute` 返回 `{kind:'ask'}`：两条路汇合于同一 waterfall/UI，
  但 tool-body 更贴切——工具自己知道 target 语义，不必解析 `exec.arguments`
  （pre-execute 适合门禁「别的」工具）。
- 会话记忆三选一：(a) 插件内存 `Map<sessionId, Set<target>>`（v1 采用，
  重启即失）；(b) fold session log 的 asked/decided 审计对（auto-permit 先例
  `packages/auto-permit/src/evidence.ts:150-182`，resume 存活）；(c) 注册
  自定义 session projection（`SessionProjectionMap` 开放接口，
  dsh-session-projection/lib/types/types.d.ts:21-26，持久+可重放+客户端可见，
  范式 dsh-permission-presets/lib/index.js:188-201）——授权记忆要跨重启时
  的正统升级路径。
- 注意：delegation 种入的子会话 policy 常为 `'never'`（service 层直接拒，
  不进 waterfall）；远端执行主要面向顶层会话，v1 不处理子会话。

### 3.4 白名单配置：插件行 `Config`（operator 声明式）

Schemastery `Schema.dict(Schema.object({...}))` 即可表达 targets 表；
行 config 权威归定义层（nixos `programs.dsh.plugins` / `--patch` overlay），
Web Settings 分区对 overlay 行退化为展示——**这正好符合「白名单是 operator
配置、不收模型/会话侧写入」的信任模型**（同 auto-permit 的 0.2 迁移决策，
见其 README「配置」节）。targets 用非 volatile 字段：改白名单 → 重挂插件 →
工具 schema 里的 target 枚举自动刷新。

### 3.5 上游 `ssh` 服务查证：是远端工作区传输，非通用 SSH 客户端

- 提供者是 `@deepseek-ai/dsh-ssh`（共享 OpenSSH master 连接 + 远端 POSIX
  helper，配套 dsh-fs-ssh / **dsh-subprocess-ssh** / dsh-sandbox-ssh 在其上
  实现远端 fs/subprocess/sandbox provider——「远端工作区」场景，包不在本
  checkout 内）。
- `request(method, params, zod)` 是**与远端 helper 的私有版本化协议**，
  不是通用 exec API；且只有部署了远端工作区组合它才存在。
- **结论：不用它**。本工具直接宿主侧 spawn `ssh` 二进制——用户
  `~/.ssh/config` 的跳板链、ControlMaster、known_hosts、agent 转发语义只有
  真 ssh 才完整保留（§3.2 已确认环境全够用），这正是本工具的核心价值。
  （dsh-subprocess-ssh 的存在也佐证了「SSH 上叠 provider」是上游自己的正规
  扩展模式，但我们按 target 白名单的粒度走工具层更合适。）

上游包清单（`ls $DSH/node_modules/@deepseek-ai/`）确认：`dsh-tool-*` 家族
没有远端执行/ssh 类工具，无现成轮子。

## 4. 方案设计（v1）

### 4.1 Config 草案

```ts
Config = Schema.object({
  sshPath: Schema.string().default('ssh'),
  approval: Schema.object({
    mode: Schema.string().enum(['session', 'every', 'never']).default('session'),
  }),
  defaultTimeoutMs: Schema.number().default(600_000),
  maxTimeoutMs: Schema.number().default(3_600_000),
  startTimeoutMs: Schema.number().default(60_000),
  targets: Schema.dict(Schema.object({
    sshHost: Schema.string().required().description('~/.ssh/config 里的别名'),
    sshPort: Schema.number(),
    sshOptions: Schema.array(Schema.string()),   // operator 信任的额外 -o，不收模型输入
    container: Schema.string().required(),
    containerUser: Schema.string().description('缺省 = 远端 $(id -u):$(id -g)'),
    workdir: Schema.string().required(),
    shell: Schema.string().default('/home/%u/.nix-profile/bin/fish'),
    envInit: Schema.string().enum(['direnv', 'none']).default('direnv'),
    autoStart: Schema.boolean().default(true),
    description: Schema.string(),
  })).default({}),
})
```

### 4.2 工具 schema

```
remote_exec:
  target:    string（description 列出配置里的 target 名；execute 内再校验，
             配置变更重挂插件后 description 自动刷新）
  command:   string（容器内 fish 兼容命令）
  timeoutMs: number?（≤ maxTimeoutMs，缺省 defaultTimeoutMs）
```

### 4.3 执行序列（宿主侧，单次 spawn）

1. 解析 target → 未配置名直接报错（description 提示 + execute 校验双保险）；
2. 授权检查（§3.3）：`ctx.approval.request({agent: exec.agent, toolName:
   'remote_exec', callId: exec.callId, reason: 'execute on <target>:
   <target.description>', displayReason: {en, zh}, signal: exec.signal})`，
   `allowed-once` → 记入会话 grant 表；其余 outcome fail-closed 返回明确错误；
3. `subprocess.spawn({ argv: [ssh, …target 参数, 'bash', '-s', '--'], cwd: HOME,
   stdio: { stdin: {data: 脚本}, stdout: collect, stderr: collect }, graceMs,
   signal })`——脚本协议同 §2（加 autoStart 分支），`{data}` 一次喂入；
4. AbortController 管 deadline（`args.timeoutMs` 夹在 default/max 之间），
   转发 `exec.signal`（用户打断）；
5. 返回 canonical value `{ exitCode, stdout, stderr, target, durationMs,
   outcome: 'ok' | 'ssh-error' | 'prep-error' | 'timeout-unknown' }` +
   `output.render` 成文本；ssh 自身失败（255）与远端 prep 错误（127 系列）
   分类标注；超时 → terminate 本地 ssh，明确返回「远端命令可能仍在运行，
   结果未知」，不自动重跑。

### 4.4 安全不变量

- 宿主侧脚本模板是**常量**（容器/目录等参数逐字 quote 注入），用户命令只
  进入最内层 `fish -c` 的引号内，与 remote.py 同构；
- 不透传模型提供的任何 SSH 参数/主机名/容器名；
- 失败不回落宿主执行、不换容器、不创建容器；
- 密钥不出宿主进程；`StrictHostKeyChecking` 不由模型控制（沿用
  accept-new 或 operator 在 ~/.ssh/config 里自定）。

## 5. 候选路径对比

| 路径 | 机制 | 评价 |
|---|---|---|
| **A. 插件工具 `remote_exec`**（本文推荐） | `ctx.tools.register` + `ctx.subprocess` + `ctx.approval` | 官方挂点齐备；审批/审计/配置全部进 DSH 体系；模型侧零沙箱改动 |
| B. 继续修沙箱内 ssh（runnerCommand bind） | `docs/plan-dsh-sandbox-ssh-fix.md` 的 wrapper | 已验证可行但维护面大（Include 图扫描、每次调用镜像），且把「完整用户终端职责」塞给工作区沙箱，方向不对；保留为兼容修复 |
| C. 关 sandbox / 全局 danger-full-access | 权限换便利 | 否决：远端 Docker 不补偿本地密钥/配置暴露 |
| D. MCP server 包装 remote.py | `dsh-mcp-client` 挂外部 server | 可行但审批要走自制 UI、配置脱离 profile 体系、还要管 server 生命周期；不如 A 原生 |

## 6. 边界与非目标（v1 明确不做）

PTY 交互、端口转发、文件传输、容器创建/重建、任务调度与保活（远端 tmux
自理）、跨会话持久授权、子会话（policy='never'）覆盖。

## 7. 结论

**可以实现，接口面全部核实，无上游阻碍。** 逐条对应需求：

| 需求 | 承接接口 | 状态 |
|---|---|---|
| 模型侧单一工具 | `ctx.tools.register` + `defineTool`（官方模板齐备） | ✅ §3.1 |
| 宿主侧 SSH（真实 `~/.ssh`、agent 转发） | `ctx.subprocess.spawn`（argv 直 exec、零沙箱、SSH_AUTH_SOCK/HOME 存活） | ✅ §3.2 |
| 按 target 授权（同款审批 UI + 审计） | `ctx.approval.request` + 会话 grant 表 | ✅ §3.3 |
| 白名单 operator 声明式管理 | 插件行 `Config`（Schema.dict，nixos overlay 权威） | ✅ §3.4 |
| 脚本协议 / autoStart | 镜像 `remote.py`（§2）+ `docker start` 分支 | ✅ 规格就绪 |
| 超时 / 断线语义 | 自管 AbortController + 「结果未知」结果分类 | ✅ §4.3 |

v1 明确不做的事（PTY、传文件、容器创建、跨会话授权、子会话覆盖）都有清晰
边界；后台作业（`ctx.jobs`）与持久授权记忆（fold 审计对 / session
projection）是现成的 v2 升级路径，不需要预先设计。

下一步（实现阶段，另行开工）：按 AGENTS.md 流程新增 `packages/remote-exec`
bundle——四导出插件（inject `['tools', 'subprocess']`，approval 用
`ctx.inject`/`ctx.get` 机会式获取），peerDeps 加 `dsh-tools` /
`dsh-subprocess` / `dsh-user-approval` / `dsh-agent`（类型），无 client 半边。
