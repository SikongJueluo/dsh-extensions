# 调研：DSH session 自动加载 direnv / devenv 环境

> 结论先行：**可以实现，且有官方支持的干净路径**。DSH 的 bash 执行链里有一个明文为
> in-process 插件预留的环境注入缝（`ShellExecRequest.env`），加上 composition patch 的
> id 定向 disable + insert 语义，可以在不改 DSH 上游源码的前提下，让每个 session 按 cwd
> 自动注入 `direnv export` 的环境。推荐做成 `dsh-extensions` 的新 bundle（工作代号
> `auto-env`），替换 `bash-sandbox` 行为注入 direnv 的 executor 子类。

- 调研对象：DSH `0.1.5-rc.2`（本机 nix store 安装）
- 源码基路径（下称 `$DSH`）：
  `/nix/store/0y680nhxl2j24l7jkwa6ndjsf361dypn-dsh-0.1.5-rc.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`
- 行号以各包 `lib/index.js` 为准（dsh-subprocess-local 另有
  `lib/runner-launch-COYGu0Dl.js`，简称 RL）。
- 方法：三路并行源码调研（bash 执行链 / session 生命周期 / 插件扩展点）+ 本机实证。

## 1. 问题与根因

症状：server/client 形态下，工作区（如 `~/Projects/.workspace/<project>/<branch>`，
devenv + `.envrc`）里的 session 执行 bash 时拿不到 devenv 环境（PATH 里没有
`.devenv/profile/bin`、项目专属变量缺失）。

根因链（全部有源码/实证支撑）：

1. `dsh-web.service`（systemd user service）启动 server，环境 = systemd 导入的登录环境
   + agenix secrets。基线 PATH 其实是全的（实证：本 session 内
   `direnv`/`devenv`/`nix`/`jj` 都能 `which` 到，`/etc/profiles/per-user/<user>/bin`
   与 `/run/current-system/sw/bin` 都在）。
2. 模型 bash 工具恒以 `bash -c <command>` 运行 —— 非交互、非 login
   （`$DSH/dsh-bash-local/lib/index.js:214-219, 257-262`；全目标包 grep 无
   `--login`/`.profile`/`.bashrc`/`BASH_ENV` 机制）→ 不读任何 rc 文件，
   direnv hook 永远不会触发。
3. 子进程环境 100% 由"父进程环境 + 显式覆盖层"决定（见 §2），没有任何 per-cwd 的
   环境加载逻辑。

即：**缺的不是全局 PATH，而是 per-workspace 的 direnv/devenv 环境差量没有人负责加载。**

## 2. bash 子进程环境是怎么构造的（注入点就在这）

完整合并链（自底向上）：

```
process.env (server 进程)
  → scrubbedParentEnv()                     dsh-subprocess/lib/index.js:50-56
      剔除 /KEY|PASSWORD|SECRET|TOKEN/i + 所有 DSH_* 前缀键；PATH/HOME/locale 原样保留
  → childEnv(spec.env)                      RL:649-654
      {...scrubbed, ...spec.env}；值为 undefined 的键 = tombstone（unset 继承键）
  → executor 显式层                         dsh-bash-local/lib/index.js:196-200
      env: {...ENV_OVERRIDES(NO_COLOR/TERM=dumb/PAGER/GIT_PAGER),
            ...spec.env, ...spec.dshEnv}
  → execve 恢复完整环境                      linux-scope 路径：launch-request.json(0600)
                                            → systemd-run --user --scope → runner 用
                                            libc execve 恢复 {cwd, env}
                                            (subprocess-local/lib/index.js:386-400, RL:1187-1201)
```

关键结论：

- **`spec.env`（即 `ShellExecRequest.env`）可以覆盖 PATH 等任意变量，且在 credential
  scrub 之后合并 —— 这是官方明文留给 in-process 插件的注入缝**。类型契约原文
  （`$DSH/dsh-shell/lib/types/types.d.ts:57-64`）："env: Ordinary environment entries…
  Set by in-process plugins (the hooks bridges set CLAUDE_PROJECT_DIR…)"——
  dsh-hooks-claude-code 桥注入 `CLAUDE_PROJECT_DIR` 就是现成先例
  （`dsh-hooks-claude-code/lib/index.js:169,185`）。
- 模型 bash 工具构造请求时从不填 `env`（`dsh-tool-bash/lib/index.js:396-402` 只填
  command/workdir/timeoutMs/dshEnv/sandboxPolicy）→ `ctx.shell.resolve()` 是干净的注入窗。
- **沙箱不改 env**：Linux 链是 `systemd-run → runner → bwrap --ro-bind / / … -- bash -c`
  （bwrap workspace-write profile 见 `dsh-sandbox-local/lib/index.js:22-38`），bwrap 只限制
  文件**写**（可写区 = /tmp + workspaceRoot），不限制可执行文件与 PATH；env 原样透传。
- 官方"每命令注入"通道 `ctx.shellEnv.register`（`dsh-shell-env/lib/index.js:54-96`）**强制
  key 必须以 `DSH_` 开头**（:60），承载不了 direnv 的 PATH/PYTHONPATH 等 —— 只能当辅助
  （如 `DSH_DIRENV_ACTIVE` 标记）。

## 3. session / workspace / cwd 语义（缓存 key 的依据）

- `session.header.cwd` 在创建时一次性快照、深冻结、之后永不变化
  （`dsh-session/lib/index.js:1397`；cwd 不一致直接抛 `ApiSessionCwdConflict`，
  `dsh-api-session-controller/lib/types/agent.js:279-281`）。
- Web 建链路：`cwd = workspace?.path ?? request.cwd ?? process.cwd()`
  （`dsh-api-session-controller/lib/types/commands.js:102`）；同一 workspace 的所有
  session 共享同一 cwd（`workspace.path` = 创建时 `fs.realpath`，永不重写，
  `dsh-workspace/lib/types/types.d.ts:32-36`）。
- **in-process subagent（task/subagent tool）原样继承父 session 的 cwd**
  （`dsh-subagent/lib/index.js:502-513` `childSessionMeta`）→ 环境缓存天然覆盖子代理。
- bash 工具每次调用都用 `exec.agent?.session.header.cwd` 解析默认 workdir
  （`dsh-tool-bash/lib/index.js:177-183` `resolveWorkdir`）。

→ **按 canonicalPath(cwd) 做缓存 key，一个 workspace 目录一份，多 session/子代理全部命中。**

## 4. 可挂载的事件 / waterfall

| 事件 | 类型 | 时机与能力 | 出处 |
|---|---|---|---|
| `agent/session-start` | Event | 每 session 恰好一次、首条消息前（startup/resume 都有）；**同步、无 veto、不等待 async**（README 明文） | `dsh-agent/lib/types/runtime-types.d.ts:288-301`，emit 于 `dsh-agent-loop/lib/index.js:1720` |
| `tools/pre-execute` | Waterfall | 每次工具调用前、**可 await**；返回 allow/deny/ask；**故意不能改写 `exec.arguments`**（README:224） | `dsh-tools/lib/index.js:3116`；目录 `dsh-tool-cordis/lib/index.js:5584-5586` |
| `tools/execute` | Waterfall (around-dispatch) | 技术上可改 mutableExec.arguments，但与声明的 desync 设计冲突（UI/日志显示原命令）——不建议 | `dsh-tools/lib/index.js:3213` |
| `agent/created` / `session/created` | Event | publication 时刻，同步 throw 可 veto | `dsh-agent/lib/types/runtime-types.d.ts:224-416` |

外部 hook 三件套（`dsh-hook-protocol` / `dsh-hooks-claude-code` / `dsh-hooks-codex`）是
Claude Code/Codex hooks.json 兼容**外部子进程**桥，效果只有 block/附加上下文，**没有 env
通道**，不能借用（`dsh-hook-protocol/lib/index.js:162`）。

## 5. cordis 服务与 composition patch 语义（方案选型的依据）

- **cordis 没有服务 shadowing**：同 scope 对 `'shell'` 第二次 provide 直接抛
  `service "shell" has been registered`（`cordis/lib/index.js:812`；`dsh-shell` 源码注释
  确认 one-implementation-per-context）。→ "再 provide 一个包装服务"走不通。
- `'shell'` 服务由组合里的 `bash-sandbox` 行提供（Linux 默认；
  `$DSH/dsh-base/cordis.patch.yml:214-218`；`SandboxBashExecutor` 具名导出，
  `dsh-bash-sandbox/lib/index.js:238`，`resolve/run/start` 均可覆写，
  `run` 是 async —— 正好可以 await direnv）。
- **composition patch 支持 id 定向改写与追加**（`cordis-plugin-include/lib/index.js:57-106`
  `applyEntryPatches`，已亲自复核）。注意一个坑：patch 里的 `name` 字段被解构为**防错绑
  guard**（与目标行现有 name 不符则整条跳过），**不能用来改写行的 `name`**。可行的字段：
  `{id: bash-sandbox, name: '@deepseek-ai/dsh-bash-sandbox', disabled: true}` 可关掉原行；
  不带 id 的 `- insert: [...]` 追加到根末尾。层序 = bundle 层 → profile
  `cordis.patch.yml` → `--patch` overlay；本机 systemd 单元正是用
  `--patch /nix/store/…-dsh-plugins.yml` 挂 dsh-extensions 的四个 bundle（insert 用法），
  id 定向 disable + insert 是同一机制的正统用法。

## 6. 本机实证（direnv 探针）

- `direnv 2.37.1`，位于 `/etc/profiles/per-user/sikongjueluo/bin/direnv`；devenv 也在
  同目录 → server 环境可直接调用。
- `direnv export json` 输出（真实运行结果）：JSON 对象，**设值键为 string，删除键为
  `null`**（如 `"NIX_PATH": null`），并附带 `DIRENV_DIFF/DIRENV_DIR/DIRENV_FILE/
  DIRENV_WATCHES` 内部键（注入时应剥离 `DIRENV_*` 与 `DSH_*`）。
- 缓存命中时 `direnv export json` ≈ **20ms**（direnv 自带 `.direnv/cache-*`）；.envrc 变更
  后首次导出会重新求值（devenv `use devenv` 走 nix eval，有 `.devenv/nix-eval-cache.db`，
  可能数秒）。
- **模型侧 bash 沙箱会挡住 direnv**（实证）：workspace-write 下
  `direnv allow`/`export` 需要写 `~/.local/share/direnv/allow/<hash>`（workspace 外，
  read-only 拒绝）与 `.direnv/cache`；且沙箱包装器会剥离 `DIRENV_CONFIG` 等环境变量。
  → **direnv 必须在 host 侧跑**（插件经 `ctx.subprocess`，不受模型 bash 沙箱约束）；
  模型永远无法在沙箱内自己 `direnv allow`。
- 用户真实工作区形态（`~/Projects/.workspace/<project>/<branch>`）：`.envrc` 内容为
  `eval "$(devenv direnvrc)"; use devenv`（部分 workspace 有 `.devenv/` 生成物，部分只有
  `devenv.nix` 没有 `.envrc`）；`~/.local/share/direnv/allow/` 已有多条 allow 记录
  （与交互使用共享同一信任存储）。

## 7. 推荐方案：`auto-env` bundle（patch override executor）

### 结构

1. 新 bundle `packages/auto-env`（`dsh-auto-env`），与现有四个 bundle 同构。
   依赖注意：`@deepseek-ai/dsh-bash-sandbox`（及其传递 peer `dsh-shell`/
   `dsh-bash-local`）目前不在 dsh-extensions 的 node_modules 里，需在 bundle 的
   package.json 声明与 server 相同版本（`0.1.5-rc.2`，npm 公开发布）并 `pnpm install`，
   tsdown 保持 external（现有 bundle 的既有做法）。
2. `cordis.patch.yml` 用 **id 定向 disable + insert**（patch 的 `name` 是 guard、改不了
  原行 name，见 §5）：
   ```yaml
   - id: bash-sandbox
     name: '@deepseek-ai/dsh-bash-sandbox'   # guard：确认目标行没被换过
     disabled: true                           # 关掉原 executor 行
   - insert:
     - id: auto-env
       name: <绝对路径指向 dsh-auto-env 构建产物>
       config: { direnvPath: auto, timeoutMs: 15000, … }
   ```
   —— 官方 patch 语义；cordis 按类插件实例化导出的 Service 子类，原行被禁用故无
   duplicate-service 问题，dispose 干净。
3. 插件导出 `SandboxBashExecutor` 的子类（`extends SandboxBashExecutor`，import 自
   `@deepseek-ai/dsh-bash-sandbox`；该包只导出类，cordis loader 以 class 插件形式
   `new (cls)(ctx, config)` 实例化），覆写：
   - `resolve(request)`：照常调 `super.resolve(request)`（拿到 workdir 默认值）；
   - `run(spec)`：`const env = await this.envFor(spec.workdir)` 后
     `super.run({...spec, env: {...direnvEnv, ...spec.env}})`（调用方显式 env 优先）；
   - `start(spec)`（后台、同步签名）：读同步缓存；未命中则启动计算并按无 env 降级
     （实际几乎不会发生，见触发策略）。
   - 保留 `sandboxMode`/沙箱行为不变（`super` 链路原样）。

### 触发与缓存策略（保证"首用前算好"）

- `agent/session-start`（同步事件）：对 `agent.session.header.cwd` **kick off** 异步
  预计算（fire-and-forget，存入 in-memory 缓存 promise）。模型生成首条 bash 调用的
  延迟（秒级）远大于 direnv 缓存命中的 20ms。
- `tools/pre-execute`（waterfall，filter `name === 'bash'`）：`await` 对应 cwd 的预计算
  promise —— 作为兜底，保证**任何** bash 调用（含后台）执行前缓存已就绪，于是
  executor 里总是同步命中。
- 缓存：in-memory，key = canonicalPath(cwd)；失效 = 短 TTL（如 10s）+ `.envrc`/
  `devenv.nix` mtime 检查（direnv 自身的 `.direnv/cache` 已挡住重求值的大头）。
  可选：`ctx.storageDomain` 自建域按 cwd 持久化（官方 per-workspace KV 缝，
  `dsh-storage-domain/README.md:36-60`），跨进程重启免重算 —— v1 可先不做。

### direnv 计算细节

- host 侧 `ctx.subprocess.spawn` 运行 `direnv export json`，`cwd = 目标目录`，
  环境基线 = server 进程环境（与 bash 子进程的合并基线一致 → PATH 差量语义正确）。
- 解析 JSON：`null` → `undefined`（落到 childEnv 的 tombstone unset 语义）；剥离
  `DIRENV_*` 与 `DSH_*` 键；超时（如 15s，防 nix eval 卡死）。
- 失败降级：`.envrc` 未 `direnv allow`（direnv 报 "is blocked"）、超时或求值失败 →
  不注入 + 经 `ctx.shellEnv.register` 注入 `DSH_DIRENV_STATUS=blocked:<reason>`（或
  systemPrompt section）提示模型/用户跑一次 `direnv allow <dir>`。**绝不自动 allow**
  （direnv 的 allow 机制本身就是信任边界，与用户交互使用共享）。
- 只有 `devenv.nix` 没有 `.envrc` 的 workspace：不在 v1 范围（文档建议补两行标准
  `.envrc`）；后续可加 `devenvFallback` 配置走 `devenv shell -- env -0`（首次构建可能
  数分钟，需明确 opt-in）。

### 安全考量

`direnv export` 会以当前用户身份**在 host 侧执行 `.envrc` 里的任意 shell 代码**
（无沙箱）。这与用户交互式 `cd` 进目录时 direnv 的信任模型完全一致（allow 记录共享），
但要在 README 里明示：**插件把"已 `direnv allow` 的目录"当作可信环境来源**。

## 8. 候选路径对比

| 路径 | 机制 | 官方度 | 评价 |
|---|---|---|---|
| **A. patch disable `bash-sandbox` 行 + insert executor 子类注入 `spec.env`**（本文推荐） | composition 行改写 + `ShellExecRequest.env` 明文契约 | 高（两个机制都是官方语义） | 无 monkey-patch、无 duplicate-service、后台/前台/子代理全覆盖；需随上游 executor API 演进维护 |
| B. 运行时 wrap `ctx.get('shell')` 实例方法 | insert 普通插件行 + monkey-patch 共享实例，disposer 恢复 | 低（无 API 保证，HMR/重载顺序风险） | 即插即用、不动原行；但非契约行为，升级易碎 |
| C. `tools/execute` waterfall 改写 command（前缀 `direnv exec …`） | 改 `mutableExec.arguments` | 低（与 README:224 声明的 desync 顾虑正面冲突） | 每调用引号转义地狱、UI/日志显示原命令、direnv 缺失时静默失败；不推荐 |
| D. `ctx.shellEnv.register` | 官方注册表 | 高但**只收 `DSH_*` 键** | 承载不了 direnv env；仅作 A 的辅助（状态标记） |
| E. 零插件：在已 hook direnv 的 shell 里启动 dsh | `dsh-launch-environment` 把启动 cwd 的 `.env` 与 `$DSH_HOME/.env` 拷入 process.env | 高 | 仅单 workspace/CLI 场景；server（systemd）形态下 cwd=/，无法 per-workspace；作为 README 里的补充说明 |

已知边界：persistent PTY 工具（`dsh-tool-bash-persistent` → `ctx.terminals`）不走
`shell` seam，env 路径不同；当前 composition 未挂载该行，v1 不覆盖（交互 PTY 本身会读
`~/.bashrc`，用户可在其中放 direnv hook）。

## 9. 结论

- DSH 没有内置 direnv/devenv 支持（全源码 grep 零命中），bash 子进程环境完全由
  "scrubbedParentEnv ⊕ spec.env ⊕ dshEnv" 决定，且无任何 rc/login-shell 机制。
- 但 `ShellExecRequest.env` 是官方明文的 in-process 插件注入缝（hooks 桥先例），
  composition patch 的 id 定向 disable + insert 是官方组合机制 —— **方案 A 可以完全在
  dsh-extensions 的 out-of-tree bundle 里实现**，效果：session 创建后（首条 bash 前）
  自动按 cwd 注入 direnv/devenv 环境，前后台 bash、子代理全覆盖，模型无感知。
