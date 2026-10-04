# AGENTS.md

dsh-extensions —— out-of-tree DeepSeek Harness 插件 bundle 集。每个 `packages/*` 是一个可独立安装的 bundle（内含 Cordis plugin）；各包细节读其 README。

## 命令

前置：Node ≥ 20、pnpm ≥ 10、`dsh` CLI。

```sh
pnpm install        # 各包 prepare 自动完成首次构建
pnpm build          # tsdown → lib/index.js + lib/index.d.ts
pnpm typecheck      # 各包 tsc --noEmit
pnpm check          # typecheck + build
pnpm clean
```

`pnpm-workspace.yaml` 的 `nodeLinker: hoisted` 是刻意的：本机 pnpm 12 的 isolated store 曾对带 peer 的 `@deepseek-ai/*` 生成悬空链接。勿改回。

## 两种加载方式

开发 overlay（不安装，立即生效）：

```sh
pnpm build
dsh --profile web --patch $PWD/packages/<name>/dev.patch.yml --no-open --port <端口>
```

- patch 内路径必须是绝对路径；重新构建后重启 dsh 进程才生效。
- `--patch` 是全局旗标，配 `--profile` 用；`web` 子命令不接受它。

安装循环（作为 bundle 装进 profile）：

```sh
pnpm build    # add 不会触发构建，先本地构建
dsh plugin --profile <profile> add ./packages/<name>
dsh --profile <profile> --dump-config   # 应出现 "# == dsh-<name>" 层
```

插件按 profile 安装，多个 profile 需分别 `add`。`dsh plugin` 本质是在 profile 目录里转发 pnpm 并对账 `dsh.profile.bundles`。

## 宿主边界（dsh 归 nix 管）

dsh 本体与 `$DSH_HOME`（`~/.dsh` 下 profiles、patch 层、bin 等运行时配置）由用户的 nix configuration 声明式管理。宿主侧的行为问题（沙箱、profile 组合、全局 patch……）一律产出计划文档交用户落进 flake（例：[docs/plan-dsh-sandbox-ssh-fix.md](docs/plan-dsh-sandbox-ssh-fix.md)），不改 `~/.dsh`、不为此申请提权；上面安装循环里的 `dsh plugin add` 等命令也由用户执行，agent 负责构建 bundle 并给出命令。

## 关键概念

- **plugin**：导出 `apply(ctx, config)` 的 ESM，可附 `name` / `inject` / `Config`（Schemastery schema，加载期校验并填默认值）。
- **bundle**：带 `dsh.bundle` 声明的 npm 包 = 一层配置；`cordis.patch.yml` 的行以 `id` + `name`（npm 包名）表示。
- **profile**：`$DSH_HOME/profiles/<name>` 下的可启动组合。层序：bundles → profile 自身 patch → 用户层 patch → `--patch` overlays。后层按 id 覆盖前层，且 config 整体替换而非深合并——覆盖一行必须重述它需要的所有键。
- **双半插件**：`package.json` 的 `dsh.client`（`platform` + `inject` 依赖图）声明浏览器半插件，代码经 `exports["./client"]` 装载；宿主半插件走 `lib/index.js`。两侧经 Typed Client Remote wire（`ctx.remote.*`）或插件自有 webServer 前缀路由通信。
- **凭据**：秘密只存 `ctx.credentials`（`<scope>/<id>`），`modifyRecord` 的独占写窗口即跨进程刷新锁；settings 只有引用。
- **settings（0.2 模型）**：无自定义配置节——`ctx.settings` 自动把每个在挂插件行的 `Config` schema 投影成表单，namespace ≡ profile 行 id；编辑写入即改行 config。volatile 字段（`.volatile()`）热生效不重挂（通过 `Volatile.get()` 读活值、监听 `loader/volatile-update`），非 volatile 字段编辑则重挂插件行。LLM 目录的 `settingsNs` 填行 id、`settingsPath` 填行 config 内的路径。
- service（`ctx.llm` / `ctx.settings` / `ctx.authorization` / `ctx.credentials` / `ctx.logger` 等）由宿主提供；`inject` 列表让 `apply` 等到 service 就绪才执行，`ctx.inject([...], fn)` 等运行期才出现的 service。

## 客户端纪律（移动端）

移动端方案是 [dsh-mobile](https://github.com/saya-ch/dsh-mobile)（社区插件，Android App/手机浏览器，网关已验证 0.2.0-rc.2）：其移动页仍由 DSH 加载同一批 web 客户端插件，移动层只做布局与连接适配；不装它时手机浏览器开的也是同一 web app。浏览器半插件（见上「双半插件」）按此写：

- **挂载只走 slot**：UI 经 `ctx.slots.register` / `ctx.slots.inject`（contribution slot）进宿主界面；不 patch Desktop DOM（`querySelector` / `MutationObserver` / 改 `document.*`）——手机端没有对应结构，slot 是唯一稳定挂载点。
- **通信只走双通道**：`ctx.remote.*`，或本包 `webServer.register` 前缀路由 + client 侧相对路径 fetch（`/dsh-<name>/…`）。不硬编码回环连接（`new WebSocket("ws://localhost:…")`、`fetch("http://127.0.0.1:…/api")`）——手机上 localhost 指向手机自身，且绕过 connection/授权层。
- **触摸优先**：交互绑 `onClick`；hover（`onMouseEnter`）、`onMouseDown` 背景关闭、键盘快捷键、`autoFocus` 只作桌面增强（`pointer: coarse` 退避），须有点按兜底。宽度用 `min(<px>, <vw>)` 自适应，可点目标 ≥ 44px。
- **dsh-mobile 网关边界**：网关以同源代理普通插件路由（GET/HEAD/POST/PUT/PATCH/DELETE，配对 Session + CSRF），相对路径 fetch 原样穿透；回环端口（如 OAuth `localhost:1455` 回跳）**不在代理范围**——登录类流程取舍为「电脑端登录、手机端消费状态」；第三方 WebSocket 路径默认拦截、只能在诊断页按精确路径放行（不支持前缀/查询串），client 侧不建自有 WS。

## 新增插件

1. `cp -r packages/oauth-providers packages/<name>`。
2. 改 `package.json`：`name`（`dsh-<name>`）、`description`；consumed services 进 `peerDependencies` + `devDependencies`，仅宿主侧用不到的 runtime 依赖进 `dependencies`。
3. 改 `cordis.patch.yml`（行的 `id` 与 `name` 换成新包名）和 `dev.patch.yml`（绝对路径）。
4. 改 `src/`；不需要浏览器 UI 就删掉 `client/`、`dsh.client` 声明与 `exports["./client"]`。
5. `pnpm install && pnpm check` 通过，并按上面任一方式验证：Web 里出现对应命令 / 设置分区 / provider。

## 版本钉版

`@deepseek-ai/*` 的 devDependencies 钉本机 dsh 内置的精确版本（dsh 0.2.0-rc.2：cordis 4.0.4 / schemastery 3.18.4 / dsh-* 0.2.0-rc.2），使类型检查与宿主运行时一致。schemastery 3.18.4 起类型把 volatile 模式编进 schema 泛型，**不要给 `Config` 写 `Schema<Config>` 注解**——声明 `interface Config`（volatile 字段用 `Volatile<T>`，见 dsh-llm-pi-ai 或本仓 auto-permit/settings.ts 的写法），让 `const Config = Schema.object({...})` 自行推断，loader 才能对上 `static Config`/`Config` 导出的形状。`peerDependencies` 保持宽松，交给安装方解析。升级 dsh 后同步核对这些钉版；API 演进（如 `CallId` → `ToolCallId`、0.2 删掉 `ctx.settings.installSection`）正是靠钉版类型检查暴露的。

## 参考

- [官方插件开发文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/)（最小形态 / tool / config / 打包安装 / Cordis tutorial）
- [auto-env 调研文档](docs/research-dsh-session-direnv.md)
