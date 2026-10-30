# 调研：toolchain-access 已挂载，为什么 uv 缓存仍要求提权

日期：2026-10-30。环境：当前 `web` profile，DSH 0.2.0-rc.2、uv 0.13.0、Linux bwrap、`workspace-write`。

本轮只新增此文档；未修改插件、Nix、`~/.dsh` 或许可配置，未申请 Full access。源码合同由独立后台 agent 调查，运行时探针与配置核对由主 agent 完成。没有审计某个历史 agent 的完整会话，因此结论限于当前运行链路，不推断用户以前在哪个界面或 profile 保存过设置。

## 1. 结论

**当前插件确实已挂载，但部署配置为 `presets: []`、`paths: {}`，也就是没有启用任何目录授权。** 当前命令的真实 bwrap 参数只有 workspace 的可写挂载，没有 uv 缓存挂载；`~/.cache/uv` 因而仍然只读。不是“uv-cache 已启用但 bind 失效”。

证据闭环：

1. Host Inspect 中 `include:toolchain-sandbox` 存在，入口为本仓 `packages/toolchain-access/lib/index.js`；stock `include:sandbox` 为 inactive。
2. Nix 声明与 systemd 服务引用的不可变 overlay 都明确配置空预设，profile patch 中也没有 `toolchain-sandbox` 覆盖。
3. 当前实际 bwrap argv 无 uv bind，`findmnt` 显示 uv 缓存所在挂载为 `ro`；离线 uv 命令实报缓存临时文件 EROFS。
4. 导入当前构建产物做纯内存对照，**只把 `presets` 改为 `["uv-cache"]` 就会生成正确 bind**，且目录本身通过校验。

此外，**Nix 使用后置 `--patch` 声明这行配置，优先于 profile Settings**。这能解释为何仅在低优先级层增加许可不能改变最终配置；但没有证据证明用户曾在该处保存失败。当前宿主在这种冲突下会明确报错，不是静默吞掉设置。

## 2. 当前部署的配置来源

### 2.1 声明与生成结果一致为空

只读检查 `~/.config/nixos/home/ai/dsh/plugins.nix:177–185`：

```nix
"toolchain-sandbox" = {
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/toolchain-access/lib/index.js";
  host = true;
  config = {
    # 刻意保持空授权：需要哪个缓存目录再在 paths/presets 里显式打开。
    presets = [];
    paths = {};
  };
  replaces = ["sandbox"];
};
```

`~/.config/systemd/user/dsh-web.service:6` 的 `ExecStart` 传入了：

```text
--profile web
--patch /nix/store/wm2pigzi5v4sqyf4xsjd6k5gsjqxpbxf-dsh-host-plugins.yml
```

解析该 overlay 的 `toolchain-sandbox` 行得到：

```json
{"config":{"paths":{},"presets":[]},"id":"toolchain-sandbox","name":"/home/sikongjueluo/Projects/dsh-extensions/packages/toolchain-access/lib/index.js"}
```

同一 overlay 禁用了 stock `sandbox`。生成器将 `plugin.config` 原样投影到 Host 行，见 `~/.config/nixos/modules/home/dsh/host-layer.nix:19–27, 38–51`。

另核对：

- `~/.dsh/profiles/web/cordis.patch.yml` 没有 `toolchain-sandbox` 或 uv 授权项；`~/.dsh/cordis.patch.yml` 不存在。
- 服务在 Host overlay 之后加载的 mobile、presets、MCP 三个 overlay 中，没有 `sandbox` / `toolchain-sandbox` 行；生成的 presets 也没有另挂 `dsh-sandbox-local`。
- 按 npm 包名查询 Config 为空只是因为这里用 `file://` 入口，**不能据此判断插件未加载**。分页目录定位到的准确 entry 是 `include:toolchain-sandbox`。
- Inspect 返回的是 Config schema，不是配置当前值；上述配置值来自磁盘声明/生成文件，并由下面的真实 argv 行为交叉确认。

### 2.2 Settings 的层级边界

以下 `$DSH` 指 `/nix/store/j180lw8q1g0mdxsp21swmnjbajc7my76-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh`。

- 组合顺序：bundle → profile patch → HOME patch → `--patch` overlays，见 `$DSH/lib/profile-boot-BZ2ZjNWi.js:193–214`。
- 同 id 的 `config` 是整体替换，不是深合并，见本仓 `AGENTS.md` 的 profile 说明、`packages/toolchain-access/cordis.patch.yml:17–18`。
- Settings 配置编辑器写 profile patch；保存前重新组合并核对目标值。若高层 overlay 盖住它，会抛 `Configuration for "toolchain-sandbox" is overridden by a home patch or command-line overlay`，发生在文件写入之前，见 `$DSH/node_modules/@deepseek-ai/dsh-config-editor/lib/index.js:23–25, 118–125`。

因此本机应优先在 **Nix 的 Host 插件 config** 中启用预设，而不是尝试在更低层反复添加同一设置。

## 3. 最小复现与验证

### 3.1 uv 实际缓存写失败

本轮执行：

```sh
uv --version
uv cache dir
uv python find --offline --system
```

关键输出：

```text
uv 0.13.0 (x86_64-unknown-linux-gnu)
/home/sikongjueluo/.cache/uv
error: Could not acquire lock
  cause: Could not create temporary file
  cause: Read-only file system (os error 30) at path "/home/sikongjueluo/.cache/uv/.tmpoOUfUY"
```

子进程未设置 `UV_CACHE_DIR` / `XDG_CACHE_HOME`。`readlink -f ~/.cache/uv` 仍为原路径，`stat` 为 uid 1000、0755、目录；没有发现本例中的路径重定向或目录权限不合格。

这是离线查找 Python，不下载/安装包；失败点已经是 uv 缓存锁，而非 `.venv`。

### 3.2 实际挂载证据与稳定验收信号

只读 `/proc/1/cmdline`，当前调用确实运行于：

```text
bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc
      --die-with-parent --tmpfs /tmp
      --bind /home/sikongjueluo/Projects/dsh-extensions /home/sikongjueluo/Projects/dsh-extensions
      -- bash -c <本次探针>
```

**没有 `--bind /home/sikongjueluo/.cache/uv /home/sikongjueluo/.cache/uv`。**

为避免重试被拒绝的缓存写，后续使用只读挂载断言（在工具实际使用的 Bash 中执行）：

```bash
mount_options=$(findmnt -T "$HOME/.cache/uv" -n -o VFS-OPTIONS)
printf 'uv cache mount options: %s\n' "$mount_options"
if [[ ",$mount_options," == *,rw,* ]]; then
  printf 'PASS: uv cache mount is writable\n'
else
  printf 'FAIL: expected writable uv cache mount under workspace-write\n'
  exit 1
fi
```

已执行，退出 1：

```text
uv cache mount options: ro,nosuid,nodev,relatime
FAIL: expected writable uv cache mount under workspace-write
```

### 3.3 同一构建产物的单变量对照

通过 `node --input-type=module` 导入 `packages/toolchain-access/lib/index.js` 的 `Config` / `ToolchainAccessSandboxProvider`，使用最小测试 Context，强制 stock bwrap 探测为真；调用 `confine()` 而不 spawn 命令。两组读取相同的真实缓存目录、使用相同 workspace / `workspace-write` policy，唯一变化是 `presets`。

```text
组 A：部署 overlay 的 config
presets=[]
binds=[[workspace,workspace]]
enforcement=full

组 B：仅在内存把 presets 改为 ["uv-cache"]
binds=[[workspace,workspace],["/home/sikongjueluo/.cache/uv","/home/sikongjueluo/.cache/uv"]]
enforcement=full

PASS: identical provider + paths; only presets changes whether uv cache is bound writable.
```

断言两组 uv bind 的有无与上述预期一致，退出 0。未写 profile；缓存已存在，未触发受控自建。此对照验证当前构建产物能正确生成授权，不声称已经修改并端到端验收生产授权。

### 3.4 测试限制

尝试执行 `pnpm -C packages/toolchain-access test`，在测试启动前被 pnpm 自身的 engine store operation lock 写入 EROFS 阻断（`ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`）。未提权、未换路重试；**不能报告测试套件通过或失败，只能报告未能启动**。

另曾尝试 `dsh --profile web --dump-config`；它在 `prepareProfile()` 写 `~/.dsh/profiles/web/cordis.yml` 时 EROFS，未重试。该命令不是无副作用读取；后续证据全部通过 Inspect、直接只读解析配置及 argv 获取。

## 4. 源码合同：为什么表现如此

| 合同 | 一手证据 |
|---|---|
| 默认 `presets` 是空数组；挂插件不等于开启缓存许可 | `packages/toolchain-access/src/index.ts:110–114, 136–138`；`cordis.patch.yml:14–28` |
| `super.confine()` 后，空预设立刻 `return base`，不会追加授权 bind | `src/index.ts:300–312`；已有测试 `test/provider.test.ts:111–125` |
| `paths.uvCache` 只是预设路径覆盖，不是独立授权开关；只填 paths、未启用 uv-cache 仍不授权 | `src/grants.ts:345–379`；空 presets 的早退点为 `src/index.ts:301` |
| uv 路径优先级：`paths.uvCache` → 宿主 `UV_CACHE_DIR` → `(XDG_CACHE_HOME 或 ~/.cache)/uv` | `src/grants.ts:369–379` |
| 锚点来自宿主 `process.env`，构造时采集；会话 `.envrc` / auto-env overlay 不是授权来源 | `src/index.ts:156–175, 229–240`；`README.md:47–50` |
| 只在 workspace-write 下加 bind；read-only 不增加授权；路径校验失败时拒绝整个 confine，不静默漏挂 | `src/index.ts:301–312`；`src/grants.ts:858–862` |
| 只影响本地进程沙箱，不覆盖 write/edit 文件工具或 remote-exec | `README.md:96–97` |

表中缩写路径均相对 `packages/toolchain-access/`。

另有一个与排障直接相关的可观测性缺口：空 plan 时 `logPlan()` 无输出，见 `src/index.ts:259–275`。所以“已挂载但没有启用预设”没有醒目的状态提示；只看插件存在或日志无警告，容易误以为缓存已经放行。这不是本次 bind 算法错误，但值得后续改善。

### 目录授权与自动审批不能互相代替

- toolchain-access 决定“沙箱内哪些目录可写”，不参与回答审批。
- cmd-permit / auto-permit 只回答已经产生的提权请求，批准一次不留下永久目录挂载，见 `packages/toolchain-access/README.md:99–106`。
- 当前 auto-permit 的判官提示词明确要求**纯缓存写导致的越界请求返回 DEFER**，交后续应答器，而不是用 Full access 替代目录授权，见 `packages/auto-permit/src/judge.ts:53`（当前构建产物 `lib/index.js:244` 同样包含此规则）。这是提示词规则，本轮未实际发起判官审批验证某次请求的结果。

因此当前组合存在一个配置缺口：目录许可未启用，而自动审批又刻意不替纯缓存请求扩大沙箱，agent 遇到 EROFS 后仍向用户申请是可解释的。无需为了它把 `uv` 整体加入 Full access 白名单。

## 5. 建议落点（未实施）

在 `~/.config/nixos/home/ai/dsh/plugins.nix` 的现有 `toolchain-sandbox.config` 中改为：

```nix
config = {
  presets = ["uv-cache"];
  paths = {};
};
```

当前 `~/.cache/uv` 已存在且校验合格，默认推导就足够，无需额外 `paths.uvCache`，更不需要放开整个 `~/.cache` / HOME。如果之后已有其他明确批准的预设，应保留它们，不要用此最小示例覆盖掉其他授权。

由用户通过现有 flake/home-manager 流程部署并重启 `dsh-web`；**仅重编本仓插件或刷新浏览器不能改变这个 Nix overlay 的空配置**。之后在新的工具调用中核对：

1. 实际 bwrap 参数出现 uv 缓存的精确 `--bind`；`findmnt -T ~/.cache/uv` 的 VFS 选项为 rw。
2. 原命令 `uv python find --offline --system` 不再报缓存 EROFS（如果另有 Python 查找问题，应与缓存授权区分）。
3. 父目录和相邻缓存仍只读；read-only 模式仍不加该授权。
4. 若真实项目仍失败，先看**实际报错路径**：项目 `.envrc` 重定向的缓存、uv 管理的 Python/tool 安装目录、HF 缓存等不自动包含在 `uv-cache` 中，不应一概升级 Full access。

本轮未追溯用户此前许可的历史来源；如果“已加入许可”指某个具体设置页或旧配置，需要该位置或会话 id 才能继续确认是不同 profile、历史迁移，还是保存时被 overlay 明确拒绝。当前这条运行链路的空授权、实际只读及其因果关系已有充分证据。
