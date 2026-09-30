# dsh-auto-env

**按 session 工作区自动加载 direnv / devenv 环境**的 DSH 插件。

DSH 的每条 bash 命令都是非交互非 login 的 `bash -c`，永远不会触发 direnv
hook——devenv 工作区（`.envrc` + `devenv.nix`）里的 PATH、`PYTHONHOME` 等环境对
session 不可见。本插件把 base composition 的沙箱 bash 执行器（`bash-sandbox` 行）
替换为一个子类：约束行为原样保留，只是在每条命令的环境上叠加宿主侧求值好的
`direnv export json` 差量。

## 工作机制

```
agent/created ─────► 对 session 目录 kick 一次 direnv 求值（预热）
tools/pre-execute  ──► 每次 bash 工具调用前 await 该目录的 overlay（封死竞态）
executor execute  ──► overlay 合并进 ShellExecSpec.env（官方 in-process 注入缝，
                        hooks 桥注入 CLAUDE_PROJECT_DIR 用的同一通道；
                        dsh 0.2 起 run/start 合并为单一 execute，前台/后台
                        只是调用方是否 await handle.result 的差别）
```

- **direnv 在宿主侧运行**（经 `ctx.subprocess`），不在模型 bash 沙箱里——沙箱会拒绝
  direnv 的 allow 记录与 cache 写入，模型侧永远无法自己 `direnv allow`。
- overlay 按 `.envrc` 所在目录缓存（TTL + 并发去重；direnv 自带 `.direnv/cache`
  让重复求值约 20 ms），`null` 差量项变成 unset tombstone，`DSH_*` / `DIRENV_*`
  键被剥离；同一工作区的所有 session 与 in-process 子代理共享一份。
- **主动失效**：对 `.envrc` 目录挂 inotify watcher（rename 安全，也捕捉新建
  `devenv.nix`），`.envrc` / `devenv.nix` / `devenv.yaml` / `devenv.lock` 任一变更
  即丢弃缓存——agent 改完 devenv 的下一条命令就是新环境，不等 TTL；求值进行中
  的变更由代数守卫丢弃过期结果。另 watch direnv 的 allow 目录，你在终端里
  `direnv allow` 后 session 立即解除 `blocked`。`.envrc` 里私有 `watch_file` 的
  目标仍靠 TTL 兜底（可用 `direnvWatch: false` 整体关闭回到纯 TTL）。
- 模型可经 `$DSH_DIRENV`（`active|none|pending|blocked|timeout|error|missing`）与
  `$DSH_DIRENV_RC` 观察加载状态。

## 信任模型（重要）

`direnv export` 会在宿主侧以你的用户身份执行 `.envrc` 里的 shell 代码。这与你在
shell 里 `cd` 进该目录时的 direnv 信任模型**完全一致**：只有内容哈希已进入
`~/.local/share/direnv/allow` 的 `.envrc` 才会被求值，未 allow 的目录状态为
`blocked`、什么都不加载，本插件**绝不**替你 `direnv allow`。首次在某个工作区使用
前，请在任意 shell 里 `direnv allow <目录>` 一次（`.envrc` 内容变化后需重新 allow，
jjn 改写托管段落也算内容变化）。

## 配置

行 `id: auto-env`（可在更后层的 patch 里按 id 覆盖，config 整体替换）：

| 键 | 默认 | 说明 |
|---|---|---|
| `timeoutMs` | `60000`（bundle 行）| 每条命令的超时（毫秒），同原 `bash-sandbox` 行 |
| 其余 executor 键 | 同 `dsh-bash-local` 默认 | `cwd` / `maxTimeoutMs` / `maxOutputBytes` / `maxSpillBytes` / `graceMs` |
| `direnvPath` | `direnv` | direnv 可执行文件（绝对路径或 PATH 名） |
| `direnvTimeoutMs` | `30000` | 单次 direnv 求值预算；devenv 冷求值（nix eval）可能要几十秒 |
| `direnvRevalidateMs` | `30000` | 缓存过期阈值，过期后下次使用时重求值 |
| `direnvStdoutMaxBytes` | `1048576` | 单次 direnv 导出的 stdout 预算 |
| `direnvWatch` | `true` | inotify 主动失效（`.envrc`/`devenv.*` 变更 + allow 列表变更）；关掉则纯 TTL |

## 安装

```sh
# 开发/部署 overlay（disable bash-sandbox + 插入本插件，绝对路径已固定为本仓库布局）
dsh --profile web --patch ~/Projects/dsh-extensions/packages/auto-env/dev.patch.yml --no-open --port <端口>
# 或作为 bundle 安装进 profile
dsh plugin --profile web add ~/Projects/dsh-extensions/packages/auto-env
```

NixOS 部署走 `programs.dsh.extraPatches`（指向 `dev.patch.yml`，见仓库 README
「两种加载方式」与 `~/.config/nixos/home/ai/dsh/plugins.nix`）。

## 已知边界

- 只有 `devenv.nix` 而没有 `.envrc` 的工作区不会被加载——补一个两行标准
  `.envrc`（`eval "$(devenv direnvrc)"` + `use devenv`）即可。
- `dsh-tool-bash-persistent`（交互 PTY shell，当前 composition 未挂载）不走
  `shell` seam，不在覆盖范围；交互 PTY 本身会读 `~/.bashrc`，可在其中放 direnv hook。
- 某目录首次求值若超过 `direnvTimeoutMs`（冷 devenv/nix eval），该轮命令以无
  overlay 运行并在 `$DSH_DIRENV` 报 `timeout`，缓存好后的后续命令恢复正常。
- 本插件不产生浏览器 UI。

## 实现注记（踩坑记录）

**`'shell'` 服务类里禁止使用 `#private` 成员。** cordis 对 service 方法调用会把
receiver 重绑为一个 shadow Proxy（`createShadowMethod`，让方法看到调用方的活跃
context），而 V8 的私有 brand 检查在 Proxy receiver 上必然抛
`Receiver must be an instance of class …`——一条 `this.#x` 就能让每条 bash 命令
报废（0.1.0 首版即栽在此：启动验证通过、命令全炸）。上游 executor 全用公开成员
（`mode` / `processFacts`）正是为此。规则：凡是会经过 ctx/service proxy 调用的
方法，其触达的一切保持公开；只被真实实例直调的内部对象（如 `DirenvLoader`）
可以私有。

## 验证

```sh
pnpm smoke                     # 假 direnv 的确定性用例（分类/缓存/合并/tombstone）
node live-check.mjs <dir>      # 真实 direnv 全链路（需 direnv allow 过的目录；
                               # 模型 bash 沙箱内无法写 allow 记录，需在宿主 shell 运行）
DSH_HOME=<隔离目录> dsh --profile web --patch ./dev.patch.yml --dump-config
                               # 确认 bash-sandbox 被禁用、auto-env 行就位
```

设计与可行性调研见仓库 `docs/research-dsh-session-direnv.md`。
