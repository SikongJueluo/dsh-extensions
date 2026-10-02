# dsh-remote-exec

DSH 的白名单远端容器执行工具：一个 `remote_exec` 工具，让模型在**固定 SSH 主机上的固定
Docker 容器**里跑 fish 命令——协议逐字镜像 Mini-Nav 的
`mini_nav/utils/remote.py`（外加 autoStart 分支）。设计调研与全部接口引文见仓库
`docs/research-dsh-remote-exec-tool.md`。

## 为什么是工具而不是修沙箱里的 ssh

- ssh 由**宿主侧** `ctx.subprocess.spawn` 直 exec（argv、不经本地 shell、不经模型
  bash 沙箱），真实 `~/.ssh`、跳板链、agent 转发（`SSH_AUTH_SOCK`）、known_hosts
  原样生效——沙箱内 root 属主 config 的一堆问题从根上消失。
- 模型只提供 `target` 名（白名单 key）+ 容器内命令；hostname/容器/用户/ssh 参数
  全部不越出 operator 配置。
- 本地沙箱策略零改动：普通命令照旧在 bwrap 里跑。

## 执行协议（每次调用一次 ssh）

```
ssh [-p port] -o BatchMode=yes [<operator opts>] -o StrictHostKeyChecking=accept-new <host> bash -s --
  ↓ stdin 喂固定脚本（set -Eeuo pipefail）
docker 在吗 → 容器存在吗 → Running？
  ├─ 否且 autoStart: docker start + 轮询（startTimeoutMs 预算）
  └─ 否且 !autoStart / 启动失败: exit 86 + 'remote-exec: error:' 标记行 —— 终态，绝不回落宿主 shell
  ↓
exec docker exec -i -u "$(id -u):$(id -g)" -w <workdir> <container> \
     /home/$(id -un)/.nix-profile/bin/fish -l -c \
     'fish_add_path -g $HOME/.nix-profile/bin; [direnv allow . + eval (direnv export fish);] <命令>'
```

- 命令必须是 **fish 语法**（`env VAR=1 cmd`，不是 `VAR=1 cmd`）——login fish 提供
  nix PATH，`.envrc` 存在时按 remote.py 先 direnv 导出（`envInit: none` 可关）。
- 超时/取消只杀**本地** ssh：远端命令可能还在跑，结果报 `timeout-unknown` /
  `cancelled-unknown`，模型被明确告知不要盲目重跑。长任务请在远端 tmux 里提交
  （`tmux new -d …`），本工具不做保活。

## 审批（approvalMode）

- `session`（默认）：每个 target 每会话首次使用时走 `ctx.approval.request`——弹的
  就是 bash 提权那个 Web 审批面板，`approval/asked`/`decided` 审计对自动进
  session log；放行后本会话内记忆（内存，重启即失）。
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
    targets:
      mini-nav-gpu:
        sshHost: gpu-workstation      # ~/.ssh/config 别名（跳板链写在里面）
        container: mini-nav           # 只 inspect/start/exec，绝不创建/重建
        workdir: /workspace/Mini-Nav
        description: Mini-Nav 实验机（devenv + fish）
        # sshPort: 22                 # 缺省交给 ssh config
        # sshOptions: [-o, ProxyJump=bastion]   # operator 信任的额外参数
        # containerUser: '1000:1000'  # 缺省远端 $(id -u):$(id -g)
        # shell: /home/$(id -un)/.nix-profile/bin/fish
        # envInit: direnv             # direnv | none
        # autoStart: true             # 只 docker start 已有容器
```

改 `targets` 会重挂插件 → 工具描述里的 target 列表自动刷新。

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

- 远端脚本模板是常量；operator 参数逐字单引号注入，模型命令只进最内层
  `fish -c` 引号串（smoke.mjs 有对抗用例）。
- prep 失败（docker 缺失/容器不存在/启动失败）终态报错，**无任何宿主 shell 兜底**。
- `BatchMode=yes` 恒定（工具绝不回答交互提示）；`StrictHostKeyChecking` 默认
  accept-new（TOFU，换钥必败），operator 可用 sshOptions 收紧/放宽。
- 密钥永不出宿主进程；工作区/容器/上下文里都没有凭证。
- 授权按 target 记忆，不逐条命令审批；拒绝结果如实返回模型。

## 边界（v1 不做）

PTY 交互、端口转发、文件传输（Syncthing 继续）、容器创建/重建、任务调度与保活
（远端 tmux 自理）、跨会话持久授权、子会话（policy=never）覆盖、后台作业
（`ctx.jobs` 是现成的 v2 路径——照 bash 的 `ctx.inject(['jobs'])` 模板即可）。

## 验证

```sh
pnpm --filter dsh-remote-exec smoke   # 纯协议部分：脚本构建/argv/分类/grant 表
pnpm check                            # typecheck + build
```

真机验证（operator 手动）：配置一个真实 target → Web 里让模型调
`remote_exec(target, 'echo ok; fish -c "exit")` → 首次弹审批 → 容器输出与退出码
回显；再停掉容器验证 autoStart；`remote_exec` 一个不存在的 target 名验证枚举报错。
