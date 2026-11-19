# dsh-toolchain-access

DSH 沙箱的**窄目录授权**：让 `workspace-write` 下的命令可以写工具链共享缓存
（uv、Typst、Cargo、pnpm、Gradle、Maven）与 Semgrep 的私有 state，而不需要每次撞
EROFS 后申请 Full access。

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

| 预设 | 默认 | 授权路径（默认） | 说明 |
|---|---|---|---|
| `uv-cache` | 开 | `$XDG_CACHE_HOME`/`~/.cache` 下 `uv/` | uv 唯一的共享缓存根 |
| `typst-cache` | 开 | `$XDG_CACHE_HOME`/`~/.cache` 下 `typst/` | Typst 把下载的包写入其中的 `packages/`。授权位置由宿主缓存环境决定，`--package-cache-path` 和 `TYPST_PACKAGE_CACHE_PATH` 无权追加可写目录 |
| `cargo-cache` | 开 | `CARGO_HOME`/`~/.cargo` 下 `registry/`、`git/`、`.package-cache`、`.package-cache-mutate`、`.global-cache` | registry/git 缓存 + Cargo 1.74+ 的**两把**全局锁（共享下载锁与 mutate 锁——只绑第一把时 mutate 锁 EROFS，cargo 会**静默降级为无锁**，与宿主侧并发 cargo 互斥失效）+ use-tracking sqlite；**不是**整个 `~/.cargo`（credentials、config 保持只读） |
| `pnpm-store` | 开 | pnpm home 下 `store/` | 共享包 store（本仓这类 store 在 workspace 内的项目会自动按「已覆盖」扣除） |
| `pnpm-runtime-locks` | 开 | `$XDG_RUNTIME_DIR/pnpm-store-operation-locks-<uid>` | pnpm 12 的 operation lock 域。**必须**绑定宿主原目录：绑到私有 `/tmp` 会拆散共享锁域。要求 `$XDG_RUNTIME_DIR` 满足 pnpm 自己的条件（本 uid 目录、属主可写可搜索、group/other 不可写——0775 会被 pnpm 拒绝回退 `/tmp`）；未设置或不合格时预设拒绝，且 **`paths.pnpmRuntimeLocks` 不能代为修复/迁移**（pnpm 的锁目录只由 `XDG_RUNTIME_DIR` 决定，override 只允许换拼写、不允许换位置）。`/run/user` 是 tmpfs，重启清空——confine 时受控自建 0700 锁目录 |
| `pnpm-engine` | opt-in | 整个 pnpm home（`~/.local/share/pnpm`） | 冷装其他版本 pnpm 需要写 `package-manager-store/`、`global/v11`、`_tmp`。**含可执行 engine 副本**，属单独信任决定，永不默认；热缓存场景不需要它 |
| `gradle-cache` | 开 | `GRADLE_USER_HOME`/`~/.gradle` 下 `caches/`、`wrapper/`、`daemon/`、`native/`、`workers/`、`notifications/`、`kotlin-dsl/`、`.tmp/` | 构建缓存与全部文件锁、wrapper 发行版、daemon 注册表/日志、file-watching 状态、kotlin-dsl 编译缓存、临时区（`.tmp` 实测必需：根只读时构建失败在创建它）。**根目录保持只读**：`gradle.properties` 常含签名密码/仓库 token，本机还是 home-manager 的 nix store 符号链接 |
| `gradle-jdks` | opt-in | `~/.gradle/jdks/` | Gradle 工具链自动下载的 JDK（tarball 中转 + 解包）。**含可执行内容**，与 pnpm-engine 同类的单独信任决定，永不默认，不在 gradle-cache 内 |
| `maven-cache` | 开 | `~/.m2` 下 `repository/`、`wrapper/` | 本地仓库（依赖缓存、`.lastUpdated`、resolver 元数据）与 mvnw 发行版。**`settings.xml` 保持只读**（服务器凭据）；Maven 无标准环境变量，自定义位置用 `paths.mavenHome`（settings.xml 的 `<localRepository>` 迁移同样须显式配置） |
| `semgrep-state` | 开 | `<cache>/semgrep-state` **bind 到**沙箱内 `~/.semgrep`（`XDG_CONFIG_HOME` 为已存在目录时为 `$XDG_CONFIG_HOME/.semgrep`）；另授 `<cache>/semgrep_version` 文件 | semgrep 每次启动都会**原子重写 settings.yml**（`mkstemp` 在数据目录内建临时文件 + rename），只读目录会在扫描开始前以 EROFS 崩溃（1.182.1 实测；Python 只 catch `PermissionError`，EROFS 是普通 `OSError`）。数据目录里的 `settings.yml` 可能含 API token，因此**宿主目录本身不授权**：私有 state 目录被挂到该路径，沙箱只写副本，宿主 settings.yml 在沙箱内不可见也不可写。版本检查缓存位于数据目录之外，单独授文件；不授它时 semgrep 会在版本检查阶段以同样方式崩掉。**登录态不跨沙箱**：`semgrep ci` 需 `SEMGREP_APP_TOKEN`（普通 `scan`、`--config=auto` 不需要） |

### `presets` 的默认语义（三种写法）

行配置对 `presets` 键的处理：

- **省略**（不写这个键）：默认开启上表标「开」的八项常规缓存/state 预设
  （`uv-cache`、`typst-cache`、`cargo-cache`、`pnpm-store`、`pnpm-runtime-locks`、
  `gradle-cache`、`maven-cache`、`semgrep-state`）。本包的 bundle/dev patch
  都按此省略，由插件 schema 默认生效。
- **`presets: []`**：全部关闭，行为与官方 stock sandbox 逐字节一致。
- **显式列表**：**精确替换**默认（不与默认叠加）；`pnpm-engine`（整个 pnpm
  home）与 `gradle-jdks`（自动下载的 JDK）是**整套工具链安装**，维持单独
  opt-in，永不默认。

默认授权的含义：这八项**确切子树**对沙箱内**所有进程**可写（缓存本身也可含
可执行内容，如构建脚本、wrapper 发行版）——不是打开 `~/.cache`、`~/.gradle`
或任何父目录整体；父目录与邻居仍只读，`gradle.properties`、`settings.xml`、
credentials 仍只读。`semgrep-state` 是唯一的**影子挂载**：宿主可写的只有
`<cache>/semgrep-state` 与 `<cache>/semgrep_version`，沙箱内的 `~/.semgrep`
只是前者的挂载点；宿主 `~/.semgrep/settings.yml`（可能含 token）既不可写也
不可见。

默认**不做可用性筛选**：任一启用的预设（含默认八项）无法兑现时，整个
confined 命令 fail-closed，不会静默漏掉预设换取运行成功——典型如
`pnpm-runtime-locks` 在 `$XDG_RUNTIME_DIR` 缺失或不合格时拒绝；非 Linux 平台
或非 stock bwrap 布局（形状不同的 `runnerCommand`、Landlock/Seatbelt rung）下
默认预设同样直接拒绝（`GrantArgvError`）。这类环境要退回官方行为，显式写
`presets: []`；要收敛授权面，显式写出保留项的完整列表。后续层按 id 覆盖本行
时 config 整体替换，`presets`/`paths` 都需按需重述。

`paths` 可显式覆盖各锚点（`uvCache` / `cargoHome` / `pnpmHome` / `pnpmStore` /
`pnpmRuntimeLocks` / `gradleUserHome` / `mavenHome` / `semgrepState` /
`semgrepVersionCache`）；未覆盖时依次取宿主导出变量（`UV_CACHE_DIR`、
`CARGO_HOME`、`PNPM_HOME`、`GRADLE_USER_HOME`、`XDG_*`、`SEMGREP_LOG_FILE`、
`SEMGREP_VERSION_CACHE_PATH`）→ 内置默认。Java 侧实测：gradle 8.8 冷缓存
`help` 构建授权组成功、只读对照失败，并发双构建共享 `daemon/<v>/registry.bin`
锁域；maven 预设按标准布局与 `~/.m2` 实际结构实现（本机无 mvn 二进制，未做
真实构建验证）。Semgrep 侧实测（1.182.1）：`semgrep scan --config=auto` 在可写
state 下成功；影子挂载下本地规则扫描退出 0 并找到 1 条 finding，宿主
settings.yml 在沙箱内不可见；不授 state 目录时启动即崩（settings 原子写），不授
版本缓存时扫描结束前崩。

## 信任语义（使用默认授权前请读）

- **启用预设 = 该目录对沙箱内全部子进程可写**，不只是同名工具。不解析 shell
  猜命令、不按进程名授权。
- 授权来源只有两个：行配置（含省略时采用的默认预设）与宿主环境锚点（操作者会话导出
  的 HOME/XDG/`CARGO_HOME`/`SEMGREP_*` 等）。**agent 的 command/justification、
  仓库文件、项目 `.envrc`（auto-env 叠加的会话环境）都不是授权来源**——项目把
  `UV_CACHE_DIR` 指向别处不会获得授权，只会继续 EROFS，直到操作者显式配置。
- `semgrep-state` 是唯一的**影子挂载**（`destination ≠ source`）：宿主可写的
  源目录是 `paths.semgrepState`（默认 `<cache>/semgrep-state`），它被 bind 到
  沙箱内 semgrep 自己的数据目录（默认 `~/.semgrep`；`XDG_CONFIG_HOME` 是已存在
  目录时是 `$XDG_CONFIG_HOME/.semgrep`）。挂载点只作 bwrap 目标，从不成为宿主
  可写授权——即使它落在 `.config` 等凭据树里也允许（影子是在**遮住**凭据，不是
  开放它）；真正的可写源目录仍按全部底线/凭据规则校验。宿主 `settings.yml`
  因此不在沙箱视野内，登录态不共享。
- 校验（全部 fail-closed，confine 拒绝执行并给出原因；issues 非空时整个 plan
  不产出任何 bind——全有或全无）：路径必须已存在（或可受控自建，见下）、是本
  uid 拥有且**属主可写**的目录或普通文件、非 group/world-writable、realpath
  后不落在系统底线根（`/`、`/home`、`/tmp`、`/etc`、`/run` …）或凭据/令牌树
  （`.ssh`、`.gnupg`、`.netrc`、`.git-credentials`、`.npmrc`、`.config`…）；
  纯默认推导的路径还必须在用户基底树内（基底与 HOME 均按 realpath 对齐，
  HOME 为符号链接或带尾斜杠的宿主不受影响）。显式 `paths` 可以越过基底树
  （操作者声明），但永远不能越过底线。`typst-cache` 只允许规范化后的缓存根下
  的 `typst/`，指向其他位置的目录链接会被拒绝。
- 缺失目录**不会**放宽父目录来迁就；也不会用 `--bind-try` 静默漏挂。要么在
  宿主准备好目录（见下），要么关预设。
- `read-only` 模式不加任何写授权；显式 `presets: []` 时行为与官方逐字节一致
  （省略 `presets` 则为八项默认，见上）。

## 宿主准备（缺失目录怎么办）

分两类：

- **默认推导路径**（未设 `paths` 覆盖、也未导出对应锚点变量）：confine 时**受控
  自建**——按各工具自己的语义创建（缓存目录 0755、pnpm 共享锁目录 0700、
  Cargo 锁文件空文件 0644）。`/run/user` 是 tmpfs、重启即清空，锁目录靠这条
  自建自愈，无需任何手工准备。Semgrep 的默认路径同样受控自建：私有 state 目录
  `0755`、版本缓存空文件 `0644`（semgrep 把空文件视为“无缓存”），以及
  **挂载点 `~/.semgrep` 空目录 `0755`**——bwrap 在 `--ro-bind / /` 之后无法
  创建不存在的挂载点，所以这一步必须由宿主侧完成。`XDG_CONFIG_HOME` 生效时该
  空目录是 `$XDG_CONFIG_HOME/.semgrep`：只创建 semgrep 自己的目录，不授权
  `.config` 树。
- **显式配置路径**（`paths` 覆盖或宿主导出的 `UV_CACHE_DIR`/`CARGO_HOME`/
  `PNPM_HOME`/`semgrepState` 等锚点指向的路径）：操作者声明了确切位置，插件
  **不代建**——缺失即 fail-closed 报错。可按需由 Nix 声明式预置
  （`systemd.tmpfiles` 或 activation），见
  [docs/plan-dsh-toolchain-access.md](../../docs/plan-dsh-toolchain-access.md)。

所有路径（含自建后）都必须通过校验：本 uid 属主、属主可写、非 group/world
可写、不在底线/凭据树内。

## 后端限制

- 只编辑 **Linux / stock bwrap** 布局（钉版 `dsh-sandbox-local` 0.2.2-rc.1 的
  profile 形状，见 [src/bwrap.ts](src/bwrap.ts)）。该形状里的 `--bind` 列表由
  `workspaceWritableRoots()`（canonical workspace + policy 的
  `additionalWritableRoots`）推导，所以策略多给的 root 属于 stock 布局而非漂移；
  授权路径若已被这些 root 覆盖，只记 note、不重复挂载。需要授权的调用在以下情形
  **明确失败**（`GrantArgvError`），不猜 unfamiliar 布局、不静默去掉授权：非
  Linux 平台（在 super.confine 之前拒绝，不产生其他后端如 windows-acl 的副作
  用）、链路选中 Landlock/Seatbelt/ACL、配置了**形状非 stock** 的
  `runnerCommand`（恰好等于裸 `['bwrap']` 的 wrapper 与 stock 不可区分、可正
  常拼接）。升级 dsh 后跑本包测试即可暴露布局漂移。
- 单文件 bind（如 `.package-cache`、`semgrep_version`）绑定的是当前 inode；
  宿主侧删除重建会造成 inode 分叉。目录 bind 无此问题（目录内容动态可见）。
  Cargo 与 semgrep 都以截断方式（`open("w")`）复用原文件、不删除重建，预设按
  现状支持；若未来行为变化，以真实并发测试为准更新预设。
- 影子挂载需要一个**已存在**的目标目录：缺失的 `~/.semgrep` 在 confine 时受控
  建成空目录；如果宿主上它是普通文件、或位于系统底线树（如
  `XDG_CONFIG_HOME=/etc`），整个 plan fail-closed。宿主 `~/.semgrep` 在沙箱内
  被完全遮住（不是 bind 它），所以宿主的 `semgrep login` 状态进不了沙箱：
  `semgrep ci` 用 `SEMGREP_APP_TOKEN`，普通 `scan`/`--config=auto` 不需要登录。
  `SEMGREP_SETTINGS_FILE` 把 settings 指到别处时本预设不覆盖（semgrep 会在该
  路径照常 EROFS，按 README 的“锚点指向别处只会继续 EROFS”原则处理）；
  `SEMGREP_LOG_FILE` / `SEMGREP_VERSION_CACHE_PATH` 作为显式文件授权被尊重
  （log 落在影子目录内时无需额外授权）。
- `semgrep install-semgrep-pro` 写的是 semgrep-core 同目录的**安装树**（uv tool /
  site-packages / nix store），不是用户缓存或 state，本插件不覆盖：Pro Engine
  在沙箱外安装。
- 校验（realpath/stat）发生在 confine 时，bwrap 稍后重新解析同一拼写——两者
  之间的符号链接替换是 argv 级沙箱固有的残余竞态（官方 workspace bind 同
  样存在），本包不声称消除它。
- 本插件授权的是**本地进程沙箱**的目录写。write/edit 文件工具与 remote-exec
  不在本插件的授权范围。

## 与 cmd-permit / auto-permit 的分工

目录授权（本包）管「沙箱内哪些目录可写」；审批插件管「哪次命令可以越出沙
箱」。启用 `cargo-cache` 后 Cargo 构建不再需要提权，因此 cmd-permit 的种子白
名单已收敛为**空**（`cargo`/`direnv` 是缓存绕行；`rtk` 复审后同样移除——按命
令头匹配时 `rtk cargo build` 仍会命中 rtk 条目拿 Full access，详见其 README
与上述 plan 文档的迁移说明），auto-permit 判官 v3 也不再凭「工具+缓存理由」
批准 Full access。用户在 Settings 里显式加回的白名单不受影响。`semgrep-state`
同理：semgrep 对自身数据目录的写由沙箱内影子目录承接，不再需要 Full access；
auto-permit 的缓存上限清单不含 `~/.semgrep`，但启用预设后这条路不会产生越界
写。

## 开发

```sh
pnpm -C packages/toolchain-access test    # grants / bwrap / provider / patch-config
pnpm build && pnpm check
```

- dev overlay：`dsh --profile web --patch $PWD/packages/toolchain-access/dev.patch.yml --no-open --port <端口>`
  （dev.patch.yml 省略 `presets`，走八项默认；要显式定制就在其 config 里写
  `presets: [...]`，`[]` = 全关，改后重启 dsh）。
- 装进 profile：`dsh plugin --profile <profile> add ./packages/toolchain-access`，
  未配置 `presets` 时八项缓存/state 即默认开启；Settings 的 `toolchain-sandbox`
  分区可缩减或关闭授权。本机 Nix overlay 优先于 Settings，需按上述接入计划删除
  旧的 `presets = [];` 后部署并重启。
