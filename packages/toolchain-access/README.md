# dsh-toolchain-access

DSH 沙箱的**窄目录授权**：让 `workspace-write` 下的命令可以写工具链共享缓存
（uv、Cargo、pnpm），而不需要每次撞 EROFS 后申请 Full access。

原理：替换 profile 里的 `sandbox` 行，挂一个 `LocalSandboxProvider` 子类。
`confine()` 仍由官方实现完成 runner 选择/探测、enforcement/denial/runner-failure
元数据与 fail-closed；子类只在**钉版验证过的 stock bwrap 布局**上，于
`--ro-bind / /` 之后、`--` 之前追加精确的 `--bind <路径> <原路径>`。同一模式
正是官方 workspace bind 本身（本机已实测：追加 bind 使该子树可写，父目录与
邻居仍 EROFS）。

```text
可信行配置 + 内置预设        （grants.ts：推导/realpath/校验/去重，fail-closed）
        ↓
精确可写 bind 清单            （bwrap.ts：钉版布局验证 + 拼接）
        ↓
sandbox adapter               （super.confine() 官方行为原样保留）
        ↓
命令仍在沙箱内运行 —— 只是多了这几个确切子树可写
```

## 预设

| 预设 | 授权路径（默认） | 说明 |
|---|---|---|
| `uv-cache` | `$XDG_CACHE_HOME`/`~/.cache` 下 `uv/` | uv 唯一的共享缓存根 |
| `cargo-cache` | `CARGO_HOME`/`~/.cargo` 下 `registry/`、`git/`、`.package-cache` | registry/git 缓存 + 全局锁文件；**不是**整个 `~/.cargo`（credentials、config 保持只读） |
| `pnpm-store` | pnpm home 下 `store/` | 共享包 store（本仓这类 store 在 workspace 内的项目会自动按「已覆盖」扣除） |
| `pnpm-runtime-locks` | `$XDG_RUNTIME_DIR/pnpm-store-operation-locks-<uid>` | pnpm 12 的 operation lock 域。**必须**绑定宿主原目录：绑到私有 `/tmp` 会拆散共享锁域（终端与两个 DSH 会话各持私锁共享同一 store）。`XDG_RUNTIME_DIR` 未设置时预设直接拒绝（pnpm 回退 `/tmp` 即私有 tmpfs） |
| `pnpm-engine` | 整个 pnpm home（`~/.local/share/pnpm`） | 冷装其他版本 pnpm 需要写 `package-manager-store/`、`global/v11`、`_tmp`。**含可执行 engine 副本**，属单独信任决定，默认不启用；热缓存场景不需要它 |

`paths` 可显式覆盖各锚点（`uvCache` / `cargoHome` / `pnpmHome` / `pnpmStore` /
`pnpmRuntimeLocks`）；未覆盖时依次取宿主导出变量（`UV_CACHE_DIR`、
`CARGO_HOME`、`PNPM_HOME`、XDG）→ 内置默认。

## 信任语义（读一遍再开预设）

- **启用预设 = 该目录对沙箱内全部子进程可写**，不只是同名工具。不解析 shell
  猜命令、不按进程名授权。
- 授权来源只有两个：行配置（操作者显式选择）与宿主环境锚点（操作者会话导出
  的 HOME/XDG/`CARGO_HOME` 等）。**agent 的 command/justification、仓库文件、
  项目 `.envrc`（auto-env 叠加的会话环境）都不是授权来源**——项目把
  `UV_CACHE_DIR` 指向别处不会获得授权，只会继续 EROFS，直到操作者显式配置。
- 校验（全部 fail-closed，confine 拒绝执行并给出原因）：路径必须已存在、是本
  uid 拥有的目录或普通文件、非 group/world-writable、realpath 后不落在系统
  底线根（`/`、`/home`、`/tmp`、`/etc`、`/run` …）或凭据/工具配置树
  （`.ssh`、`.gnupg`、`.aws`、`.config`…）；纯默认推导的路径还必须在用户基
  底树内。显式 `paths` 可以越过基底树（操作者声明），但永远不能越过底线。
- 缺失目录**不会**放宽父目录来迁就；也不会用 `--bind-try` 静默漏挂。要么在
  宿主准备好目录（见下），要么关预设。
- `read-only` 模式不加任何写授权；无预设时行为与官方逐字节一致。

## 宿主准备（缺失目录怎么办）

首次使用前，预设路径必须已存在（属主为当前用户，建议 0755/0700）。建议由
Nix 声明式预置（`systemd.tmpfiles` 或 activation），见
[docs/plan-dsh-toolchain-access.md](../../docs/plan-dsh-toolchain-access.md)。
`~/.cargo/.package-cache` 由 Cargo 自建；沙箱内无法创建它，需宿主侧
`touch ~/.cargo/.package-cache` 一次或由 Nix 预置。

## 后端限制

- 只编辑 **Linux / stock bwrap** 布局（钉版 `dsh-sandbox-local` 0.2.0-rc.2 的
  profile 形状，见 [src/bwrap.ts](src/bwrap.ts)）。配置了 `runnerCommand`
  包装器、链路选中 Landlock/Seatbelt/ACL，或未来 dsh 改了 profile——需要
  授权的调用**明确失败**（`GrantArgvError`），不猜 unfamiliar 布局、不静默
  去掉授权。升级 dsh 后跑本包测试即可暴露布局漂移。
- 单文件 bind（如 `.package-cache`）绑定的是当前 inode；宿主侧删除重建会造
  成 inode 分叉。目录 bind 无此问题（目录内容动态可见）。Cargo 不删除重建
  `.package-cache`，预设按现状支持；若未来 Cargo 行为变化，以真实并发测试为
  准更新预设。
- 校验（realpath/stat）发生在 confine 时，bwrap 稍后重新解析同一拼写——两者
  之间的符号链接替换是 argv 级沙箱固有的残余竞态（官方 workspace bind 同
  样存在），本包不声称消除它。
- 本插件授权的是**本地进程沙箱**的目录写。write/edit 文件工具与 remote-exec
  不在本插件的授权范围。

## 与 cmd-permit / auto-permit 的分工

目录授权（本包）管「沙箱内哪些目录可写」；审批插件管「哪次命令可以越出沙
箱」。启用 `cargo-cache` 后 Cargo 构建不再需要提权，因此 cmd-permit 的种子白
名单已移除 `cargo`/`direnv`（详见其 README 与上述 plan 文档的迁移说明），
auto-permit 判官 v3 也不再凭「工具+缓存理由」批准 Full access。用户在
Settings 里显式加回的白名单不受影响。

## 开发

```sh
pnpm -C packages/toolchain-access test    # grants / bwrap / provider 三组
pnpm build && pnpm check
```

- dev overlay：`dsh --profile web --patch $PWD/packages/toolchain-access/dev.patch.yml --no-open --port <端口>`
  （改 preset 需改 dev.patch.yml 里的 config 后重启 dsh）。
- 装进 profile：`dsh plugin --profile <profile> add ./packages/toolchain-access`，
  然后在 Settings 的 `toolchain-sandbox` 分区启用预设。
