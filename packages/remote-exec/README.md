# dsh-remote-exec

DSH 的白名单远端容器执行工具：一个 `remote_exec` 工具，让模型在**固定 SSH 主机上的固定
Docker 容器**里跑 fish 命令。阶段一把「执行环境」（target）和「这次在哪个目录跑」（cwd）
拆开：新增项目只要在已授权容器/挂载里选一个 cwd，不必改 Nix 配置、重启 DSH。设计调研与
原始接口引文见仓库 `docs/research-dsh-remote-exec-tool.md`。

## 为什么是工具而不是修沙箱里的 ssh

- ssh 由**宿主侧** `ctx.subprocess.spawn` 直 exec（argv、不经本地 shell、不经模型
  bash 沙箱），真实 `~/.ssh`、跳板链、agent 转发（`SSH_AUTH_SOCK`）、known_hosts
  原样生效——沙箱内 root 属主 config 的一堆问题从根上消失。
- 模型只提供 `target` 名（白名单 key）、可选的容器内绝对 `cwd` 和命令；hostname/容器/
  用户/ssh 参数全部不越出 operator 配置。cwd 不是目录权限边界，真正的目录保护靠容器
  挂载与 Unix 权限。
- 本地沙箱策略零改动：普通命令照旧在 bwrap 里跑。

## 执行协议（每次调用一次 ssh）

```
ssh [-p port] -o BatchMode=yes [<operator opts>] -o StrictHostKeyChecking=accept-new <host> bash -s --
  ↓ stdin 喂固定脚本（set -Eeuo pipefail）
docker 在吗 → 容器存在吗 → Running？
  ├─ 否且 autoStart: docker start + 轮询（startTimeoutMs 预算）
  └─ 否且 !autoStart / 启动失败: control prep-error + exit 86 —— 终态，绝不回落宿主 shell
  ↓
docker exec -i -u "$(id -u):$(id -g)" -w / <container> /bin/sh -c '<outer>' \
  remote-exec <envlog> <shell> '<fish wrapper>' '<command>' '<cwd>' <status> <envInit> </dev/null
  ↓ outer sh: 把 login fish 的 stdout/stderr 指向容器内 env log；fd 3/4 保留真实 ssh 流
  ↓ fish wrapper: cd -- <cwd> → [fish_add_path + direnv allow/export + eval] → 写 command-start 状态
  ↓               eval <command> >&3 2>&4
  ↓ host 第二次 docker exec 读状态文件；读失败 → status-unknown；env/cwd 失败时 cat env log 到 stderr
  ↓ host 在 stderr 最后输出一行 nonce 控制线（command-start:<rc> / cwd-error / env-error / prep-error / status-unknown）
```

关键点：

- **环境初始化与命令输出按 fd 分离**，不是事后 grep 日志：login fish 启动横幅、
  `fish_add_path`、`direnv allow`、`direnv export fish` 以及导出代码的 `eval`
  输出/错误都进容器内 env log。成功时 env log 被丢弃，结果里只有命令自己的
  stdout/stderr；失败时返回 env log，并且**用户命令不会启动**。env log 在容器内
  保持打开，不会在初始化阶段被 unlink。
- 导出文件先 `cat` 到变量并检查 `cat` 状态，确认读取成功后才 `eval`；读取失败
  或 `eval` 失败都是 `env-error`，不会带着空环境启动命令。
- 命令 **stdin 为 EOF**（工具没有 stdin 参数）：`docker exec` 的 stdin 接
  `/dev/null`，用户程序不会读走远程 bash 的脚本后半段。
- `direnv allow .` 仍沿用 v1 的自动信任行为（兼容）；`.envrc` 以容器用户权限执行。
  是否改为显式信任留给后续阶段。
- `.envrc` 存在但 direnv 缺失/加载失败时是 `env-error`，不会静默当「没有环境」继续。
- 控制线带每次调用生成的 nonce，且固定在 stderr 末尾；正常命令输出不会意外碰撞，
  截断尾部时也不会丢。命令仍是容器内任意代码，这不是安全边界。状态文件读失败
  （容器停止、第二次 exec 失败、状态文件丢失）是 `status-unknown`，不会误报命令
  未启动；控制线 detail 只保留短状态，底层状态读取错误进入普通 stderr，和命令输出
  一样受展示预算与 spill 约束。
- 命令必须是 **fish 语法**（`env VAR=1 cmd`，不是 `VAR=1 cmd`）——login fish 提供
  nix PATH，`.envrc` 存在时按 remote.py 先 direnv 导出（`envInit: none` 可关）。
- 超时/取消只杀**本地** ssh：远端命令可能还在跑，结果报 `timeout-unknown` /
  `cancelled-unknown`，模型被明确告知不要盲目重跑。每次调用的 `timeoutMs` 会被夹在
  1000ms 与 `maxTimeoutMs` 之间；预算耗尽后的实际耗时还包含本地 ssh 的 TERM→KILL
  grace（进程提前退出就不等满）。长任务请在远端 tmux 里提交（`tmux new -d …`），
  本工具不做保活。

## cwd

- 工具参数 `cwd`：容器内**绝对路径**；省略时用 target 的 `defaultCwd`。
- 每次调用独立，不共享 `cd` 状态；并行调用互不影响。
- 目录不存在/不可访问 → `cwd-error`，**不会自动创建，也不会回退到别的目录**。
- 结果里的 `cwd` 是本次请求的目录（省略时是 target 默认值），不是 realpath 解析结果。
- target 仍是 operator 授权的固定主机 + 固定容器；cwd 只决定命令在容器里的起点。
- `defaultCwd` 是 target 的必填字段；第一版的 `workdir` 别名已移除，旧配置必须改写为
  `defaultCwd`（值不变），否则插件挂载失败，不会静默回退。

## 输出协议

每个 stream 有三层预算，互不混淆：

| 层 | 配置 | 默认 | 作用 |
|---|---|---|---|
| 模型可见展示 | `displayMaxBytes`（每 stream） | 16 KiB | 只把有界头尾片段交给模型；ANSI 控制、`\r` 进度覆盖、完全相同的连续行会做确定性折叠 |
| 宿主内存保留 | `stdoutMaxBytes` / `stderrMaxBytes` | 1 MiB / 64 KiB | 保留 tail；溢出时由 subprocess provider 写本地 spill 文件（单 stream 上限 64 MiB） |
| 原文取回 | `ctx.spillStore` | — | 展示被截断时把完整 raw stream 存成 session-scoped spill artifact，返回 `locator`/`bytes`/`hint`；用普通 `read`/`grep` 分页读取 |

- 结果里的 `stdout`/`stderr` 是**已经限长的展示文本**；`stdoutBytes`/`stderrBytes` 是
  截断前的总量；`stdoutTruncated`/`stderrTruncated` 表示展示不是完整流。
- 展示被截断且保存成功时，结果带 `stdoutSpill`/`stderrSpill`；保存失败（spill store
  未挂载、磁盘错误）不会影响命令结果，但会带 `spillError` 明说原文不可取回。
- `lossy: true` 表示 raw stream 本身超出保留上限（连 64 MiB spill 也放不下），只有
  retained tail 可用；此时 spill artifact 名字带 `-tail`。
- 相同连续行折叠带 `[xN]` 次数；不同指标行（如 `step=… loss=…`）不会被当成重复删除。
- 展示处理不改变命令退出码，也不改变 raw 原文；raw spill 保存的是未做 ANSI/CR 清洗的文本。
- `status-unknown` 的 `detail` 只保留短状态；底层状态读取错误进入普通 stderr，同样经过
  `displayMaxBytes` 截断、`stderrTruncated` 标记和 `stderrSpill` 原文取回。
- **这只省 agent 上下文，不省跳板流量**：原始输出仍然经过 ssh/跳板机。500 MB/5h 的
  单 IP 传输限制仍然适用；数据/模型/大产物继续走 Syncthing，不要用本工具搬运。

## 结果语义（outcome）

| outcome | 含义 |
|---|---|
| `ok` | 命令已运行并返回退出码；`exitCode` 可能是非零，**不等于成功** |
| `cwd-error` | cwd 不存在/不可访问；命令未启动 |
| `env-error` | `.envrc`/direnv 初始化、导出读取或 eval 失败；命令未启动；`stderr` 是 env log |
| `prep-error` | docker/容器 prep **确认**失败；命令未启动 |
| `status-unknown` | 命令可能已运行，但结束状态读取失败（容器停止、第二次 exec 失败、状态文件丢失）；`detail` 是短状态，底层错误在 `stderr`（可 spill 取回）；不要盲目重跑 |
| `ssh-error` | ssh 传输失败；如果命令已启动，它可能仍在运行 |
| `spawn-error` | 本地 ssh 无法启动；命令未启动 |
| `timeout-unknown` / `cancelled-unknown` | 本地 ssh 被停止；远端命运未知，不要盲目重跑 |

- `exitCode` 只在命令确实运行且拿到退出码时出现；env/cwd/prep/status-unknown/ssh/timeout 不带。
- `detail` 是 setup/env/cwd/status 失败的控制面消息；命令运行时没有。
- 命令自身退出 255 也不会被误判成 ssh 失败（`command-start` 控制线优先）。

## 审批（approvalMode）

- `session`（默认）：每个 target 每会话首次使用时走 `ctx.approval.request`——弹的
  就是 bash 提权那个 Web 审批面板，`approval/asked`/`decided` 审计对自动进
  session log；放行后本会话内记忆（内存，重启即失）。cwd 不触发新审批。
- `every`：每次调用都问。
- `never`：完全不问（operator 显式信任的 target）。
- 无 approval service 的组合里**fail-closed**（明确报错），绝不静默放行。
- 注意：delegation 种入的子会话 approval policy 常为 `never`，这类会话会被直接
  拒绝——远端执行面向顶层会话。

## 配置

插件行 config（operator 拥有；nixos overlay / `--patch` 行声明权威，Web Settings
分区对 overlay 行只读——与 auto-permit 同一 0.2 规则）：

```yaml
- id: remote-exec
  name: dsh-remote-exec
  config:
    approvalMode: session        # session | every | never
    defaultTimeoutMs: 600000     # 10 min
    maxTimeoutMs: 3600000        # 1 h 上限
    startTimeoutMs: 60000        # docker start + 轮询预算
    displayMaxBytes: 16384       # 每 stream 模型可见展示预算
    targets:
      lab-cuda:
        sshHost: gpu-workstation      # ~/.ssh/config 别名（跳板链写在里面）
        container: research-cuda      # 只 inspect/start/exec，绝不创建/重建
        defaultCwd: /workspace/projects
        description: 实验机（devenv + fish）
        # sshPort: 22                    # 缺省交给 ssh config
        # sshOptions: [-o, ProxyJump=bastion]   # operator 信任的额外参数
        # containerUser: '1000:1000'     # 缺省远端 $(id -u):$(id -g)
        # shell: /home/$(id -un)/.nix-profile/bin/fish
        # envInit: direnv                # direnv | none
        # autoStart: true                # 只 docker start 已有容器
```

迁移：第一版的 `workdir` 已移除，改为同值的 `defaultCwd`；NixOS 里对应
`targets.<name>.workdir = …;` → `targets.<name>.defaultCwd = …;`。仍只写 `workdir` 的
target 缺必填字段，插件在挂载/配置校验期直接失败。

调用示例：

```json
{"target":"lab-cuda","cwd":"/workspace/projects/new-project","command":"pytest -q"}
```

改 `targets` 会重挂插件 → 工具描述里的 target 列表自动刷新；同一容器里新增项目
只改调用参数，不需要改配置/重启。

## 安装

bundle 安装（进 profile）：

```sh
pnpm build
dsh plugin --profile <profile> add ./packages/remote-exec
```

开发 overlay（不安装，立即生效；需重启 dsh 进程才能看到重建产物）：

```sh
pnpm build
dsh --profile web --patch $PWD/packages/remote-exec/dev.patch.yml --no-open --port <端口>
```

宿主部署走 nixos 的 `programs.dsh.plugins` / `extraPatches`（参考
`~/.config/nixos/home/ai/dsh/plugins.nix` 的既有四 bundle 方式）。

## 安全不变量

- 远端脚本模板是常量；operator 参数逐字单引号注入，模型 cwd/命令只作为 docker exec
  的 argv 传入最内层容器 shell（smoke.mjs 有对抗用例与真实 bash/fish fixture）。
- prep 失败（docker 缺失/容器不存在/启动失败）终态报错，**无任何宿主 shell 兜底**。
- `BatchMode=yes` 恒定（工具绝不回答交互提示）；`StrictHostKeyChecking` 默认
  accept-new（TOFU，换钥必败），operator 可用 sshOptions 收紧/放宽。
- 密钥永不出宿主进程；工作区/容器/上下文里都没有凭证。
- 授权按 target 记忆，不逐条命令审批；cwd 不是权限边界。
- 控制线使用 per-call nonce；正常用户输出不会与它意外碰撞（命令本身仍可控制自己的结果）。

## 边界（本阶段不做）

PTY 交互、端口转发、文件传输（Syncthing 继续）、容器创建/重建、跨会话持久授权、
子会话（policy=never）覆盖、后台持久作业/远端 runner、远端 cgroup/资源硬限额、
专用受限 SSH 凭据、远端侧输出过滤（省流量）。`.envrc` 自动 allow 的显式信任流程也
留到后续阶段。二进制输出按 UTF-8 文本处理，不是二进制传输通道。

## 验证

```sh
pnpm --filter dsh-remote-exec build
pnpm --filter dsh-remote-exec smoke   # 协议 + 展示 + runner + spill + 本地 fake ssh/docker/direnv + 真实 bash/fish fixture
pnpm check                            # typecheck + build + client 语法检查
```

真机验证（operator 手动，agent 不连服务器）：

1. 配一个真实 target → Web 里调 `remote_exec(target, cwd, 'pwd; nvidia-smi -L')`：
   首次弹审批；输出无 devenv/direnv 横幅；结果 `cwd` 正确。
2. 传一个不存在的 cwd → `cwd-error`，命令未执行。
3. 放一个会失败的 `.envrc` → `env-error`，返回 env log，命令未执行。
4. `remote_exec(target, cwd, 'false')` → `ok` + `exitCode: 1`（不是工具失败）。
5. `remote_exec(target, cwd, 'seq 1 200000')` → 展示被截断，结果带 `stdoutSpill.locator`；
   用 `read` 打开该路径能看到完整输出。
6. `remote_exec(target, cwd, 'cat')` → `ok`、stdout 为空（stdin 是 EOF，不会读走远程脚本）。
7. 用 `sleep 30` + 小 `timeoutMs` → `timeout-unknown`；不要自动重跑。
