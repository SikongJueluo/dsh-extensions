# 调研：为什么已有自动审批插件，uv 仍被 sandbox 挡住

日期：2026-10-21。环境：DSH 0.2.0-rc.2、uv 0.13.0、Linux bwrap、`workspace-write`。

本轮只修改本调研文档；没有修改插件、`~/.dsh`、Nix 配置或 ya-vla。执行了工作区内无依赖、离线的 `uv sync` 最小复现，以及纯内存的审批证据提取对照；未申请 Full access、未安装依赖或下载模型，临时复现目录已清理。

## 1. 结论

**已有的是“自动回答提权审批”的插件，不是“永久放行开发工具缓存目录”的插件。**

- `auto-env` 在宿主侧加载已获 direnv 信任的环境，然后给沙箱命令叠加环境变量；它不扩大文件权限。当前 `rtk-rewrite` 继承这项能力。
- `auto-permit` 的判官规则确实包含 **uv、direnv、`~/.cache`、`.direnv`**，但只有产生 bash 审批请求后才参与判断；不能让第一次普通 `uv` 调用自动越过沙箱。
- 项目内 `.devenv` / `.direnv` 本来就在 workspace 可写边界内；**`~/.cache/uv` 是另一条、位于边界外的路径**。放得下 `.venv`，不等于写得了 uv 缓存。
- 用户指定的训练 session 在引用窗口内没有发起过 bash 提权。它选择了项目内缓存重定向，自动审批插件没有机会介入。
- 另发现 **PTC 嵌套调用的审批证据兼容缺陷**。这可能阻碍自动审批，但不是该 session 的直接原因，因为它根本没有申请 bash 提权。

以下分别标明源码事实、实际实验、日志事实和未验证边界，不将“未触发审批”写成“审批拒绝”。

## 2. 最小复现：失败点是 uv 缓存，而非 .venv

本会话 workspace 为 `/home/sikongjueluo/Projects/dsh-extensions`。`uv cache dir` 返回：

```text
/home/sikongjueluo/.cache/uv
```

当时 `UV_CACHE_DIR`、`XDG_CACHE_HOME`、`UV_PROJECT_ENVIRONMENT`、`UV_PYTHON_INSTALL_DIR` 均未设置。

在一次性目录 `.uv-sandbox-probe.nKsxja` 中写入：

```toml
[project]
name = "dsh-uv-sandbox-probe"
version = "0.0.0"
requires-python = ">=3.11"
dependencies = []
```

执行过的命令及结果：

```sh
uv sync --offline --no-python-downloads --no-install-project --project .uv-sandbox-probe.nKsxja
```

```text
error: Could not acquire lock
  cause: Could not create temporary file
  cause: Read-only file system (os error 30) at path "/home/sikongjueluo/.cache/uv/.tmpBEx2Xd"
[sandbox: file access denied under workspace-write mode]
[exit code: 2]
```

随后两个对照均成功，退出码为 0：

```sh
env UV_CACHE_DIR="$PWD/.uv-sandbox-probe.nKsxja/cache" uv sync --offline --no-python-downloads --no-install-project --project .uv-sandbox-probe.nKsxja
uv sync --offline --no-python-downloads --no-install-project --no-cache --project .uv-sandbox-probe.nKsxja
```

第一组使用 CPython 3.13.12 并成功创建工作区内 `.venv`。实验没有接触 ya-vla 的环境，也没有网络下载。它确认默认缓存位置足以导致失败；不证明真实项目的所有构建、下载或 Python 安装路径都已可写。

uv 官方文档明确：默认缓存是 `$XDG_CACHE_HOME/uv` 或 `$HOME/.cache/uv`；`UV_CACHE_DIR` / `--cache-dir` 可覆盖；**uv 总需要缓存，`--no-cache` 实际使用临时缓存**，并非完全不写缓存。见 [uv：Cache directory](https://docs.astral.sh/uv/concepts/cache/#cache-directory)，本机 `uv help cache dir` 亦一致。

## 3. 各层的真实职责

| 层 | 做什么 | 不做什么 |
|---|---|---|
| `dsh-sandbox-local` | 本机 bwrap 将宿主根目录只读挂载；workspace-write 另将 workspace 可写挂载，并提供私有 `/tmp` | 不按 uv、direnv 等命令名自动授予额外目录 |
| `auto-env` | 宿主侧执行 `direnv export json`，将环境差量合并进 `ShellExecSpec.env` | 不改变 sandbox mode 或 writable roots，也不替用户 `direnv allow` |
| `rtk-rewrite` | 继承 auto-env，改写命令后交回同一执行链 | 不取消沙箱 |
| `cmd-permit` | 对已产生的审批请求作命令白名单判断，命中则 `allowed-once` | 不是目录级预授权 |
| `auto-permit` | 对已产生的 bash 审批依次检查高危形状、白名单、历史、模型判官 | 不监控每次文件失败后主动提权，不静默重跑普通调用 |

本仓源码：

- [auto-env/src/index.ts](../packages/auto-env/src/index.ts):34–35、164–185：继承 `SandboxBashExecutor`，只合并 overlay 后 `super.execute()`；[README](../packages/auto-env/README.md):22–42：direnv 在宿主侧求值、信任仍由 allow 记录决定。
- [rtk-rewrite/src/index.ts](../packages/rtk-rewrite/src/index.ts):184、203–211：继承 auto-env，并交回父类执行。
- [auto-permit/src/index.ts](../packages/auto-permit/src/index.ts):145–158、184–220：监听 `approval/request`，恢复不到证据即 `next()`；允许时返回 `allowed-once`。
- [auto-permit/src/judge.ts](../packages/auto-permit/src/judge.ts):39–48：规则 (3) 列出 uv 与公开工具缓存目录，是语义审批规则而非 mount 列表。
- [cmd-permit/src/index.ts](../packages/cmd-permit/src/index.ts):147–181：同样只回答审批，并要求恢复到目标 sandbox mode。

宿主安装包的一手依据：下文 `$PKG` 指
`/nix/store/j180lw8q1g0mdxsp21swmnjbajc7my76-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`。

- `$PKG/dsh-sandbox-local/lib/index.js:22–38`：`--ro-bind / /`，workspace-write 时加 `--tmpfs /tmp` 与 workspace 的 `--bind`。
- `$PKG/dsh-tool-bash/lib/index.js:640–648`：仅参数显式包含 `sandbox_permissions` 和 `justification` 时调用 `approveBashEscalation()`，批准后对**这一次调用**覆盖 mode。
- `$PKG/dsh-bash-sandbox/README.md` 的 Modes / Denials：workspace-write 不授权 HOME 缓存；Full access 不进行文件约束；失败不会被执行器静默重试。
- `$PKG/dsh-sandbox-policy/README.md` 的 Known Limitations：当前 `SandboxExecutionPolicy` 只有一个主要 workspace root，没有额外可写 roots。

因此 `allowed-once` **会允许这一次调用使用更宽的 mode**，但不会留下“今后 `~/.cache/uv` 永远可写”的目录授权。对 workspace-write 而言，stock 模式中再往上的选项是 `danger-full-access`，不是“只多开放 uv 缓存”。

### 当前挂载与配置核对

通过 `cordis_inspect_list` 和 `Config.listConfigs` 读取全部 207 个挂载目录条目，定位到 `include:rtk-rewrite`、`include:auto-permit`、`include:cmd-permit`、`include:sandbox`。扩展以本仓 `file://.../lib/index.js` 挂载，不能因按 npm 包名查询为空就判断未挂载。auto-env 没有独立行，但功能由 rtk-rewrite 继承。

只读核对 Nix 声明 `~/.config/nixos/home/ai/dsh/plugins.nix:54–64`：cmd-permit 配置的 `allow` 为 `[rtk, cargo, direnv]`，不含 uv；auto-permit 声明了判官路由。**这是声明值，不是对当前 volatile 设置值的独立读取**，也未实际发起判官请求验证它会否允许具体命令。把 uv 加入白名单既不是解决“没请求审批”的必要条件，也不是目录级授权。

注意：本轮曾尝试 `dsh --dump-config`，发现它会在 `prepareProfile()` 写 `~/.dsh/profiles/web/cordis.yml`，被 sandbox 拒绝后未提权重试；后续改用 Inspect 与只读配置。不能把这个命令当作无副作用查询。

## 4. 用户指定 session：审批根本没被触发

对象：`Handoff: 实现训练模块`，session `c500b73d-46a2-4f68-bbbc-d6067e1e5e6d`，workspace `/home/sikongjueluo/Projects/ya-vla`。

除用户提供的对话快照外，本轮还只读解压、解析其持久化 `session.v4.jsonl.zstd`，统计**严格限制在引用截止 seq 1888**。日志位于 `~/.dsh/sessions/--home-sikongjueluo-Projects-ya-vla--/<session-id>/`；没有复制完整会话进仓库。

| 事实 | 结果 |
|---|---:|
| 本地 bash 调用（顶层或 PTC dispatch） | 161 |
| 其中命令含 `uv ` 或 `UV_CACHE_DIR` | 74 |
| 其中带 `UV_CACHE_DIR` 覆盖 | 73 |
| 本地 bash 显式包含 `sandbox_permissions` | **0** |
| `approval/asked` | 4，全部为 `remote_exec`，**没有 bash** |
| 本地命令直接含 `uv sync` | 0 |

这段会话主要执行 `uv run` / `just`；不能把用户提到的痛点改写成“该 session 已实跑并被拒绝了一条 `uv sync`”。可确定的是：它沿用了 `UV_CACHE_DIR=<workspace>/.uv-cache` 和 `UV_NO_SYNC=1`，没有走 bash 提权链。`UV_NO_SYNC=1` 不等于禁用缓存写入。

日志 seq 300 还确实出现 HF datasets 在 `~/.cache/huggingface/datasets/...lock` 的 `Read-only file system`。这说明不是单个 uv 命令被封禁，而是多个工具各自的 HOME 写路径撞上同一文件边界。

对话中报告 `.uv-cache` 累积 393M 并进入 Syncthing 同步树：这是“将缓存移入项目”的已报告副作用；**本轮没有重新测量其体积或审计 Syncthing 状态**。不要为确认这个数字而重新同步或清理用户数据。

只读 `readlink -f` 另确认 ya-vla 的 `.venv -> .devenv/state/venv`，目标仍位于项目内部。本轮未写入此环境；没有证据表明这条链接是此次缓存失败原因。一般外链指向 workspace 外的场景未单独复现。

## 5. 独立兼容缺陷：PTC 审批证据缺失

`auto-permit` 的 [evidence.ts](../packages/auto-permit/src/evidence.ts):95–107、186–194 只从顶层 `tool/call` 读取 bash 参数。`cmd-permit` 也复用这个 `collectEvidence()`。

但宿主 `$PKG/dsh-tools/lib/index.js:1298–1305、1354–1359` 在嵌套执行时：

1. 生成 `${exec.callId}:ptc:${n}` 作为实际执行 `callId`；
2. 执行前写入 `tool/ptc-dispatch-start`，参数记录在 `subCallId/name/arguments`，不是新的顶层 bash `tool/call`。

本轮直接导入当前编译产物 `packages/auto-permit/lib/index.js`，给同一个 `collectEvidence()` 传入两种真实事件结构的纯内存 fixture；bash 参数均为 `uv sync --offline` 与 Full access 请求，但**没有执行命令或发起实际审批**：

```text
direct {"callRecovered":true,"command":"uv sync --offline"}
ptc {"callRecovered":false}
```

结合两个审批插件“`evidence.call === undefined` 就 `next()`”的实现，可确认 **PTC 子调用证据无法被当前自动审批链恢复**；预期会交给后续应答器，而不是这些插件自动批准。真实审批端到端尚未测试。

它应单独修复并补回归测试，但不能用来解释原窗口为何没有任何 bash 审批请求。若修复，必须在执行前的可信审计事件中按精确子调用 id 恢复参数，不应从任意文本或执行后的结果猜命令。

## 6. 建议顺序与安全边界（未实施）

1. **先补审批闭环与可观测性。** agent 遇到明确拒绝，应按工具返回的流程对同一命令请求一次合适的更宽权限，而不是误以为 auto-permit 已授予目录写权；补 PTC 证据兼容测试。自动审批可以保留人工 fallback，不承诺每条 uv 命令必然通过。
2. **长期若要无需 Full access 的 uv，设计窄范围可写缓存授权。** 当前 stock schema 没有 `extraWritableRoots`；需宿主/Nix 包装器或上游新能力，优先只授权实际解析后的 uv cache，而不是整个 HOME 或 `~/.cache`。这属于下一轮设计/实施，不是修改 auto-env 的环境变量就能完成。
3. **临时使用工具正式支持的缓存模式。** `--no-cache` 本机最小例成功，但丢失跨调用复用，真实大项目可能增加下载/构建开销；专用项目缓存则必须先明确 Syncthing 排除策略。仅把 `UV_CACHE_DIR` 指向 workspace 外的新目录，**不会凭空获得写权限**。
4. **不要把粗粒度方案误当安全修复。** 全局 Full access、泛开 `~/.cache`、默认重定向整个 `XDG_CACHE_HOME`，或无条件白名单 `uv` 都不是目录级最小授权；uv 可运行项目/构建代码，不应只按程序名假设全部副作用都是缓存。
5. **HF 同步缓存与 uv 缓存分开。** 用户已有服务器只读 HF 链接与本机下载→Syncthing 约定，不应为解决 uv 顺便改写 HF 缓存、服务器链接、网络或同步配置。

验收后续修复时应至少覆盖：直接 bash 与 PTC 两条审批链、未申请提权时仍受限、明确拒绝/人工 fallback、允许缓存但不允许其他 HOME 写入、无项目内同步缓存副作用。本文只完成调研，不声称原运行时问题已修复。
