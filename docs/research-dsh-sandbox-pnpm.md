# 调研：pnpm 12 的 operation lock 为什么会挡住 DSH workspace-write

日期：2026-10-21。环境：DSH 0.2.0-rc.2、Linux bwrap `workspace-write`；宿主 pnpm 12.9.0（Rust binary，`/nix/store/gslcmgvwsgn1csg90b4dpcgxr57x91yv-pnpm-12.9.0/bin/pnpm`）；本仓库 `packageManager: pnpm@12.3.4`；`XDG_RUNTIME_DIR=/run/user/1000`，`PNPM_HOME` 与其余 XDG 变量未设。

范围：只读 pnpm 源码/官方文档、只读本机状态与单变量实测；只改本文件，不改仓库配置、不装依赖、不做 VCS 操作。本文严格区分**包 store**与**operation lock**。

## 1. 结论

1. 默认 `pnpm run` 的失败不是脚本、不是包 store，而是 **pre-command 自动切换 `packageManager` 时的 engine store operation lock**。运行中的 12.9.0 在检查 12.3.4 engine 是否已缓存**之前**先取锁；锁目录在 `$XDG_RUNTIME_DIR`，workspace-write 下该目录只读。
2. `pnpm run` 并非天生要锁 store：关闭 manager version switch（实测 `npm_config_manage_package_manager_versions=false`；官方把 `pmOnFail: ignore` 列为等价语义，[见文档](https://pnpm.io/settings/cli#pmonfail)）后，同一个 `pnpm run check:client` 在默认 XDG 下也能成功。不能写成“所有 pnpm run 都必须写 store lock”。
3. `store-dir` / `PNPM_HOME` 都不改变 operation lock 根目录。`--store-dir /tmp` 已确认生效，但 `pnpm run` 仍是同一错误；源码里全局 `all-stores.lock` 和 per-store 锁都由 `secure_user_lock_dir()` 放在 runtime dir。
4. `XDG_RUNTIME_DIR=/tmp` 或 unset（回退 `/tmp`）可绕过，但只证明**热缓存**：12.3.4 engine 已在 `~/.local/share/pnpm/package-manager-store`。冷 engine 安装还会写 `PNPM_HOME`/HOME 下的 engine store 与 env lockfile，`/tmp` 成功不能推出冷安装也成功。
5. PTC/审批修复不扩大文件权限；所引 session 也没有 PTC 事件或审批请求。这不是审批链问题。

## 2. 已证：单变量实测

| 命令 | 结果 |
|---|---|
| `pnpm --version`（默认） | `[WARN] Cannot use the pnpm version this project pins: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK ...`，输出 `12.9.0`，exit 0 |
| `pnpm run check:client`（默认） | `Error: ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` / `lock the package-manager engine store` / `Failed to open the store operation lock at "pnpm-store-operation-locks": Read-only file system (os error 30)`，exit 1 |
| `env XDG_RUNTIME_DIR=/tmp pnpm --version` | `12.3.4`，exit 0（切换成功） |
| `env XDG_RUNTIME_DIR=/tmp pnpm run check:client` | 成功，`client syntax: 6 file(s) ok` |
| `env -u XDG_RUNTIME_DIR pnpm run check:client` | 成功（`/tmp` 回退） |
| `pnpm --store-dir /tmp/pnpm-store-probe run check:client` | 同一 operation lock 错误，exit 1；`pnpm --store-dir ... config get store-dir` 确认为 `/tmp/pnpm-store-probe` |
| `env PNPM_HOME=/tmp/pnpm-home-probe pnpm run check:client` | 同一 operation lock 错误，exit 1 |
| `env npm_config_manage_package_manager_versions=false pnpm run check:client` | 成功（主代理实测） |

机械证据（主代理 strace，已核对）：

- 主代理核对日志：seq 214/229/250/270/290 均为同一 operation lock，不是一次性失败。
- `mkdir /run/user/1000/pnpm-store-operation-locks-1000` → `EEXIST`；`statx` 显示 0700；随后 `chmod` 同目录 → `EROFS`，再报 engine store lock。**不是目录不存在，而是只读挂载下连 chmod 都失败。**
- 还看到 `~/.local/share/pnpm/_tmp...` 的 `mkdir` → `EROFS`（pnpm 的多级临时目录回退），说明 HOME 写路径还有第二层；但首个致命错误是 runtime operation lock。
- 本机当前 `pnpm store path` 指向 workspace 内（`node_modules/.pnpm-store/v11`），所以本轮不是“包 store 被挡”。

## 3. 源码定位（v12.9.0）

### 3.1 锁文件在 runtime dir，不在 store dir

- `StoreDir::lock_for_use()` 同时锁两个文件：全局 `all-stores.lock` 与 per-store `<hash>.lock`；`lock_for_prune()` 才用独占锁。见 [store_lock.rs#L43-L63](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/store-dir/src/store_lock.rs#L43-L63)。
- 目录名 `pnpm-store-operation-locks`；`secure_user_lock_dir()` 在目录后追加 `-<uid>`，`create_dir_all` 后**无条件** `chmod 0700`；per-store 文件名是 store 真实路径的哈希。见 [store_lock.rs#L75-L105](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/store-dir/src/store_lock.rs#L75-L105)。
- 根目录解析：Unix 上 `$XDG_RUNTIME_DIR`（必须是绝对路径、当前用户所有、owner 可写可搜索、group/other 不可写），否则 `/tmp`。见 [secure_temp_lock.rs#L21-L42](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/fs/src/secure_temp_lock.rs#L21-L42)、[#L50-L86](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/fs/src/secure_temp_lock.rs#L50-L86)、chmod [#L213-L226](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/fs/src/secure_temp_lock.rs#L213-L226)。
- 错误显示的是相对名 `"pnpm-store-operation-locks"`，因为 `Open` 分支把常量路径直接塞进错误对象；这不代表它在当前目录，实际路径在 `/run/user/1000/...`。

### 3.2 engine store 先加锁、后查缓存

- `install_engine_from_env_with_config()` 第一步就是 `config.store_dir.lock_for_use()`，下一行才用 `linked_engine_bins()` 判断“已安装、已链接”。见 [install.rs#L141-L148](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/engine_pm/install.rs#L141-L148)。**即使 12.3.4 已缓存，也会先失败在锁上；错误发生在 pre-command，`check:client` 脚本未执行。**
- engine store 根是 `<pnpm home>/package-manager-store`（本机 `~/.local/share/pnpm/package-manager-store/v11`）；engine 的 env lockfile 在 `global/v11/pnpm-lock.yaml`，安装槽锁在 store 的 `engine-locks/`。见 [install.rs#L286-L289](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/engine_pm/install.rs#L286-L289)、[#L339-L341](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/engine_pm/install.rs#L339-L341)。

### 3.3 为什么 `pnpm run` 会走到这里

- 本仓库 pin 是 12.3.4，运行的是 12.9.0；`pin.rs` 默认 `PmOnFail::Download`，于是 `switch_wanted` 为真，进入 `switch_or_sync`。见 [pin.rs#L35-L67](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/cli_args/pre_command/pin.rs#L35-L67)、[#L206-L214](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/cli_args/pre_command/pin.rs#L206-L214)、[pre_command.rs#L258-L276](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/cli_args/pre_command.rs#L258-L276)。
- `run` 不在跳过 pre-command 的命令集合里（该集合只有 `cat-file`、`dlx`、`store`、`with` 等）；所以任何普通命令都会先做这一步。见 [input.rs#L190-L255](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/cli_args/pre_command/input.rs#L190-L255)。
- 版本不同才安装 engine：`execute.rs` 在版本等于运行版本时直接返回 `None`，12.3.4 则调用 `install_engine_to_store()`。见 [execute.rs#L181-L197](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/cli_args/pre_command/execute.rs#L181-L197)。
- `--version` 是特例：pre-command 失败被捕获，打印警告后用运行版本回答；普通命令的错误直接向上抛，所以 exit 1。见 [lib.rs#L240-L262](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/cli/src/lib.rs#L240-L262)。
- v12.3.4 的 store-dir/fs/cli 源码中检索不到 `StoreOperationLock` / `lock_for_use` / `pnpm-store-operation-locks`；同一安装函数只有 `package_manager_env_lock`。见 [v12.3.4 install.rs#L59-L99](https://github.com/pnpm/pnpm/blob/v12.3.4/pnpm/crates/cli/src/engine_pm/install.rs#L59-L99)。**这套锁来自运行中的 12.9.0，不是被切换的 12.3.4。** 若 pin 与运行版本一致，就不会有这次 engine 安装与锁。

## 4. 为什么 `store-dir` / `PNPM_HOME` 不足

- `store-dir` 只改变 per-store 锁的哈希对象与包 store 位置；`global_operation_lock_path()` 仍固定走 `secure_user_lock_dir("pnpm-store-operation-locks")`，与 store 路径无关。所以把 store 指到 `/tmp` 后，先失败的仍是全局 runtime 锁。
- `PNPM_HOME` 是 store 默认值、global dir、engine store 的根（[defaults.rs#L76-L119](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/config/src/defaults.rs#L76-L119)、[#L132-L146](https://github.com/pnpm/pnpm/blob/v12.9.0/pnpm/crates/config/src/defaults.rs#L132-L146)），但它不参与 `secure_user_lock_dir()`。把它指到 `/tmp` 可以移动 engine store，却移动不了 runtime 锁目录。
- 真正的开关是 `XDG_RUNTIME_DIR`：要么指到可写的绝对目录（如 `/tmp` 或 workspace 子目录），要么 unset 让 pnpm 回退 `/tmp`。DSH 的 workspace-write 为 `/tmp` 提供了私有可写 tmpfs，所以这两个都有效。
- 把 `XDG_RUNTIME_DIR` 指到 workspace 子目录也能工作（现有 `.pnpm-run/pnpm-store-operation-locks-1000/{all-stores.lock,<hash>.lock}` 就是同类结构），但会在仓库里留下运行时锁文件，需要 ignore/清理策略；不建议作为长期方案。
- **并发设计边界**：bwrap 的 `/tmp` 每次调用独立。把 runtime 锁移到每次私有 `/tmp`，不能再协调同时使用同一个持久 store 的宿主/其他沙箱进程；per-workspace 锁目录也不能协调其他 workspace。本轮只是对热 engine 运行门禁，未执行安装/prune，临时重定向不是共享 store 的长期锁方案。生产修复必须让共享 store 的使用者共享同一锁域，不能用“命令成功”代替并发正确性验证。

## 5. 与 uv 的对比

| 维度 | uv | pnpm 12 |
|---|---|---|
| 默认 workspace 外写路径 | `$XDG_CACHE_HOME/uv` 或 `~/.cache/uv`；`UV_CACHE_DIR`/`--cache-dir` 可覆盖 | runtime operation lock（`XDG_RUNTIME_DIR`）+ engine store（`PNPM_HOME`）+ 包 store（本仓库当前在 workspace）+ 元数据 cache/state |
| 本次实际触发的锁 | 默认缓存根内创建锁用临时文件失败；uv 还使用目标 venv 的文件锁 | `XDG_RUNTIME_DIR` 下的 `all-stores.lock` + per-store 哈希锁，先于 engine 缓存检查 |
| 本轮对照开关 | `--no-cache` 仍使用临时缓存（官方文档明确） | 关闭 manager switch 会跳过本次 engine 安装，但不等于禁止 pnpm 缓存或其他锁 |

uv 的缓存这一层是单一可重定向根，文档明确“uv 总是需要缓存，`--no-cache` 仍用临时缓存”，见 [uv Caching#cache-directory](https://docs.astral.sh/uv/concepts/cache/#cache-directory)；其并发安全靠缓存/venv 的文件锁，见 [Cache safety](https://docs.astral.sh/uv/concepts/cache/#cache-safety)。pnpm 则是**多层**：runtime 锁、engine store、包 store、元数据 cache 各自有路径；本次默认 run 只卡在第一层，但不能因此说“只要放行 XDG_RUNTIME_DIR 就都解决了”。

## 6. PTC / 审批边界

- DSH 的 workspace-write 以 `--ro-bind / /` 只读挂载全系统，再把 workspace `--bind` 成可写，并给 `/tmp` 私有 tmpfs（`dsh-sandbox-local/lib/index.js:22–38`）。
- 只有 bash 参数显式带 `sandbox_permissions` + `justification` 时才会进入审批；批准只覆盖**这一次调用**的 sandbox mode，不产生目录 ACL（`dsh-tool-bash/lib/index.js:640–648`）。
- auto-permit / PTC 证据修复只影响“是否回答这次审批”，不改变 writable roots；本 session（6e1c065b…，截止 seq 502）的 50 条 bash 调用全部无 `sandbox_permissions`，无 PTC start、无 `approval/asked`（主代理核对）。因此这次失败不是审批插件漏批，也不是 PTC 证据缺失。
- XDG 重定向后（seq 279）出现的 `Broken lockfile: missing snapshot vitest@3.2.7` 由 `--fix-lockfile`（seq 284）修复，是另一层（lockfile/版本差异），不要归因于 operation lock；seq 289 未带 env 的 `pnpm -C test` 仍复现 operation lock。

## 7. 证据等级与未测边界

- **已证（源码 + 实测）**：锁位置与 chmod 行为、先锁后查缓存、`--store-dir` 生效但无效、`PNPM_HOME` 同错、`XDG_RUNTIME_DIR=/tmp`/unset 成功、`--version` 警告与 run 失败的分叉、12.3.4 无这套锁代码、包 store 在 workspace 内、session 无审批/PTC。
- **推断（有源码/ strace 支撑，未端到端）**：冷 engine 安装在仅改 `XDG_RUNTIME_DIR=/tmp` 时仍会因 `~/.local/share/pnpm/package-manager-store` 或 `global/v11` 写入失败；`_tmp` 的 EROFS 是同一类 HOME 写路径。
- **未测**：直接用 12.3.4 binary（不经过 12.9.0 switch）在 sandbox 下运行；冷 engine 安装的完整链路；`pnpm install` 在额外可写 root 下的行为；12.9.1+ 是否改动；PTC 审批的端到端。
- **不建议**：全局 Full access、泛开 `~/.cache` 或整个 HOME、把 `XDG_RUNTIME_DIR` 永久指向仓库、为绕过锁而永久关闭版本管理。若要做宿主级修复，应只授权实际需要的 runtime 锁目录（冷安装还需 engine store），或由包装器按命令设置 `XDG_RUNTIME_DIR`；这属于 DSH/Nix 层，不在本仓改配置的范围。

## 8. 附注（2026-10-21 实现会话）：`--fix-lockfile` 的波及范围

审查指出 kwquspxq 的 lockfile 变化不止加 vitest：还移除了 `zod@4.6.5` 快照（基线中它有完整条目，并非悬空），把全部 zod peer 上下文收敛到 `4.4.3`，并重整了一批 peer variant 键。补充实测与结论：

- **窄化不可行**：把 lockfile 恢复到基线（mpslzsvq）后重跑 `pnpm install`（12.3.4，XDG_RUNTIME_DIR 重定向），稳定复现 `Broken Lockfile: missing snapshot for vitest@3.2.7`——尽管基线里 `vitest@3.2.7` 的裸快照与 peer 后缀快照（`vitest@3.2.7(@types/node@24.19.0)(yaml@2.9.1)`）都存在。即基线 lockfile 在 importer 变更后本身就无法被 12.3.4 引擎安装，`--fix-lockfile` 的全局 peer 重解析是唯一可用修复路径，zod 收敛是其副作用，不是可选缩小的部分。
- **为什么收敛到 4.4.3 是安全的**：仓库唯一直接钉的 zod 就是 triggers 的精确 `4.4.3`（peer + dev）；此前 peer 上下文里出现 4.6.5 是旧一次解析的产物。此 lockfile 只喂本仓 dev/typecheck/test 与 `dsh plugin add` 前的本地构建；profile 安装按 bundle 的 peer 声明在 profile 内独立解析，不受本 lockfile 影响。修复后全仓 241 项测试与 `pnpm check` 均绿。
- **状态**：已接受保留（kwquspxq），记录于此供后续审查；若未来想恢复 zod 4.6.5 上下文，需在上游 pnpm 修复“missing snapshot”误判后重新生成，而不应手工回滚条目。
