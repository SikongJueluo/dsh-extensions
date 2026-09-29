# dsh-extensions

Out-of-tree [DeepSeek Harness](https://www.deepseek.com/harness/en/) 插件库 —— 一个 pnpm workspace monorepo，每个 `packages/*` 目录都是一个可独立安装的 **bundle**（内含 Cordis plugin）。

当前包含四个 bundle：

- `packages/oauth-providers`（`dsh-oauth-providers`）：**OAuth 认证的 LLM 厂商集合**——每厂商一个模块（当前：ChatGPT 订阅，路由 `chatgpt`），共享同一套 pi 风格登录（链接 → 浏览器授权 → 自动回调 / 粘贴回退），无需 API Key、无需任何厂商 CLI —— 覆盖了插件开发的完整要素（`name` / `inject` / Schemastery `Config` / `ctx.llm` 注册 provider/adapter/discovery / `ctx.settings` 设置节 / `ctx.authorization` 授权流 + `ctx.credentials` 凭据记录 / `ctx.webServer` 自有浏览器↔宿主通道 / `dsh.client` 浏览器半插件 + `settings.section` Slot UI / `ctx.logger`）；v0.4 起提供 `oauthProviders` 宿主服务（`token(provider)` 自动刷新，供 plan-usage 查 OpenAI 用量）。详见[包内 README](./packages/oauth-providers/README.md)。
- `packages/handoff`（`dsh-handoff`）：**一条命令的会话交接**——`/handoff <任务>` 让当前会话写自包含简报（`.dsh/handoff/`），插件检测完成标记后经 `ctx.agents.create`（与 Web 新建会话同一工厂链路）起 session 并 `attachSession` 归入原 workspace 分组，简报即首条 prompt；模型经浏览器下拉选择（`shell.overlay` + `ctx.remote.session.modelCatalog()` 同 `/model` 数据源，`/dsh-handoff` 通道回传；无 Web half 时降级为 `ctx.userQuestions` 卡片）。`ctx.commands` 注册命令、`ctx.agentPresets`/`agentDefaultModel` 预设继承、`ctx.sessionTitle` 命名。详见[包内 README](./packages/handoff/README.md)。
- `packages/plan-usage`（`dsh-plan-usage`）：**Coding 套餐配额查询（三源聚合）**——GLM（z.ai/bigmodel 监控 API）、OpenAI Codex（`wham/usage`，经 `oauthProviders` 服务取 OAuth token）、MiniMax（`token_plan/remains`，2049 自动翻区）三家的 5h/周窗口归一为 `planUsage` 宿主服务（统一消耗% + epoch 毫秒重置时间 + 窗口大小），**只显示本进程实际注册的路由**（GLM 别名家族收敛为一张卡），附设置页「Coding 套餐用量」分区（进度条 + 重置倒计时 + 实际窗口大小）；独立可用。详见[包内 README](./packages/plan-usage/README.md)。
- `packages/auto-continue`（`dsh-auto-continue`）：**限额后自动续跑**——模型请求因套餐限额失败（`QUOTA`）时，在 `agent/request-error` waterfall 上接管恢复：经 `planUsage` 服务读重置点，睡到重置后**同 turn 原样重试失败的 step**（无 "continue" 消息、无额外 prompt token）；服务缺席则退化为阶梯探测。等待写 `llm/retry` 事件（Web 原生渲染倒计时）并持久化到 spool——**跨进程重启**：新实例认领记录，到点经 sessionController 冷启动会话发送续跑消息（护栏：预算过期清理/用户已接管放弃/忙碌重试）。详见[包内 README](./packages/auto-continue/README.md)。

## 仓库结构

```text
dsh-extensions/
├── package.json            # workspace 根：build / typecheck / clean 聚合脚本
├── pnpm-workspace.yaml     # packages/* 为 workspace 成员
├── tsconfig.base.json      # 共享严格 TS 配置（noEmit，构建交给 tsdown）
└── packages/
    ├── oauth-providers/       # dsh-oauth-providers（复制此目录即得新插件骨架）
    │   ├── package.json         # 声明 dsh.bundle.patch + dsh.client —— "可安装 bundle" 的标志
    │   ├── cordis.patch.yml     # bundle 层：插入 authorization 缝隙行 + 插件行
    │   ├── tsdown.config.ts     # 构建到 lib/index.js（+.d.ts），依赖保持 external
    │   ├── tsconfig.json
    │   ├── dev.patch.yml       # 开发期 --patch overlay（同 systemd 单元用法）
    │   ├── THIRD-PARTY-NOTICE.md  # 上游 MIT 许可与派生声明
    │   ├── client/client.js    # 浏览器半插件：设置页 "OAuth 登录" 分区（每厂商一张卡片）
    │   └── src/                # 宿主半插件：apply(ctx, config)
    │       ├── index.ts        # 入口：Config schema + 注册各厂商模块
    │       ├── identity.ts     # 包名 / 插件名 / 浏览器↔宿主通道
    │       ├── channel.ts      # 共享登录通道（/dsh-oauth-providers，按厂商派发）
    │       ├── transport.ts    # 代理感知 fetch（env / macOS / Windows / Linux）
    │       └── providers/chatgpt/   # ChatGPT 厂商模块（新厂商 = 新目录）
    │           ├── index.ts    # 模块入口：Config/路由/目录/设置节/登录 一站注册
    │           ├── identity.ts # 路由 `chatgpt` / 命名空间 / 凭据 id / 显示名
    │           ├── oauth.ts    # OAuth 协议（PKCE + 1455 回调 + 粘贴回退）
    │           ├── auth.ts     # 令牌存取/刷新（凭据商店，跨进程互斥轮换）
    │           ├── login.ts    # 授权流注册（ctx.authorization）
    │           ├── adapter.ts  # LlmAdapter：Responses API → StreamChunk 翻译
    │           ├── catalog.ts  # ChatGPT /models 模型目录（TTL 缓存）
    │           ├── discovery.ts # registerModelDiscovery 处理器
    │           └── serialize.ts # 会话消息 → Responses API input
    └── handoff/                # dsh-handoff（/handoff 会话交接 + 浏览器模型下拉）
        ├── package.json         # dsh.bundle.patch + dsh.client；peer 仅 cordis/dsh-llm/schemastery
        ├── cordis.patch.yml     # 单行插件 handoff → dsh-handoff
        ├── dev.patch.yml        # 开发期 --patch overlay（绝对路径 entry，宿主+浏览器半插件都会接线）
        ├── smoke.mjs            # 冒烟 + 全链路流程测试（node smoke.mjs）
        ├── client/client.js     # 浏览器半插件：shell.overlay 模型下拉（纯 JS + createElement）
        └── src/                 # 宿主半插件：apply(ctx, config)
            ├── index.ts         # 入口：Config schema + HandoffRuntime + 注册命令/通道
            ├── identity.ts      # 包名 / 命令名 / 完成标记 / 默认目录 / 通道前缀
            ├── shims.d.ts       # agentPresets / agentDefaultModel 最小类型 shim
            ├── channel.ts       # /dsh-handoff 通道：待选请求 + 浏览器回传
            ├── command.ts       # /handoff handler：模型选择 + brief 指令 + 防重入
            ├── brief.ts         # 简报模板 / 完成检测 watcher / 失败通知
            └── spawn.ts         # agents.create + preset 挂载 + workspace 归组 + 首条 prompt
```

## 前置条件

- Node.js ≥ 20（直接以 `--patch` 指向 `src/*.ts` 需要 ≥ 23.6 的内置 type stripping；本仓库的开发循环指向构建产物，无此要求）
- pnpm ≥ 10
- 已安装 `dsh` CLI（`npx @deepseek-ai/dsh` 或包管理器安装）
- `dsh-oauth-providers` 无额外前置：登录在 Web 设置页内完成

## 日常命令

`pnpm-workspace.yaml` 里 `nodeLinker: hoisted` 是刻意设置：本机 pnpm 12 的
isolated 虚拟 store 曾对带 peer 的 `@deepseek-ai/*` 包生成悬空链接，hoisted
布局从根解析、对 tsc/tsdown/node 均无差别。

```sh
pnpm install        # 安装依赖；workspace 各包的 prepare 会自动完成首次构建
pnpm build          # 构建所有包（tsdown → lib/index.js + lib/index.d.ts）
pnpm typecheck      # 所有包 tsc --noEmit
pnpm check          # typecheck + build
pnpm clean          # 清理构建产物
```

## 两种加载方式

### 1. 开发循环：用户层 overlay（不安装、立即生效）

用 systemd 同款方式挂 `dev.patch.yml`（或把它的行放进 `$DSH_HOME/cordis.patch.yml` 用户层），然后：

```sh
pnpm build
dsh --profile web --patch $PWD/packages/oauth-providers/dev.patch.yml --no-open --port <端口>
```

- patch 里的路径必须是**绝对路径**（patch 只贡献配置，不改变 loader 的模块解析基准）。
- 重新构建后需重启 dsh 进程才能看到变化（systemd 自管则 `systemctl --user restart dsh-web`）。
- 注意 `--patch` 是全局旗标：配 `--profile web` 使用；`web` 子命令不接受它。
- 验证：Web 设置页出现 "OAuth 登录" 分区并能登录；Models 页出现 `ChatGPT (OpenAI)` provider（路由 `chatgpt`）。

### 2. 安装循环：作为 bundle 装进 profile

```sh
pnpm build                                          # link: 安装不会触发构建，先本地构建
dsh plugin --profile <你的profile> add ./packages/oauth-providers
dsh --profile <你的profile> --dump-config           # 应看到 "# == dsh-oauth-providers" 层
dsh --profile <你的profile>                         # 启动
```

`dsh plugin` 本质是**在 profile 目录里转发 pnpm** 并对账 `dsh.profile.bundles`：声明了 `dsh.bundle` 的包自动追加为 composition 层，`remove` 同时移除依赖与层。详见[官方打包安装文档](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)。

注意：

- **插件按 profile 安装**。`standard / minimal / ...` 若是不同 profile，需分别 `add`，或做一个聚合自己的 base bundle 让多 profile 共用。
- 从 git 安装（`add github:you/dsh-extensions` 场景）时 pnpm ≥ 10 会拦截 `prepare` 脚本，需按提示在 profile 的 `pnpm-workspace.yaml` 里 `allowBuilds` 放行——这等于授权其在安装期执行代码，请先审阅并钉住 commit。

## 关键概念

```text
package.json (dsh.bundle.patch)      cordis.patch.yml           apply(ctx, config)
        "我是 bundle"        ──▶      "我插入哪些插件行"   ──▶        "行加载时执行什么"
```

- **plugin**：导出 `apply(ctx, config)` 的 ESM 模块，可附 `name`、`inject`、`Config`（Schemastery schema，加载期校验并填充默认值）。
- **bundle**：带 `dsh.bundle` 声明的 npm 包 = 一层配置。`cordis.patch.yml` 里的行以 `id` + `name`（npm 包名）表示。
- **profile**：`$DSH_HOME/profiles/<name>` 下的可启动组合。层序：各 bundle 按 `dsh.profile.bundles` 顺序 → profile 自身 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays。**后层按 id 覆盖前层，且 config 是整体替换而非深合并**——覆盖一行必须重述它需要的所有键（未提供的键由插件 schema 默认值补齐）。
- 用户因此可以不碰你的包，直接在自己的 patch 里覆盖你插入的行（如给 `oauth-providers` 行写 `chatgpt: { defaultReasoningEffort: medium }`）。
- `ctx.llm` / `ctx.settings` / `ctx.authorization` / `ctx.credentials` / `ctx.logger` 等 service 由宿主提供；`inject` 列表让框架等到这些 service 就绪才执行 `apply`。`ctx.inject([...], fn)` 可再等运行期才出现的 service（如 `connection`）。
- **双半插件**：`package.json` 里的 `dsh.client`（`platform` + `inject` 模块依赖图）声明浏览器半插件，代码经 `exports["./client"]`（`client/client.js`）由 client module loader 装载；宿主半插件照常走 `lib/index.js`。两侧通过 Typed Client Remote wire（`ctx.remote.settings` / `ctx.remote.llm` / `ctx.remote.session`）或插件自有 webServer 前缀路由（HTTP POST 信封，同 connection RPC 协议）通信。
- **凭据**：OAuth 令牌等秘密存 `ctx.credentials` 记录（`<scope>/<id>`，如 `oauth-providers/chatgpt`），`modifyRecord` 的独占写窗口即跨进程刷新锁；settings 文档永远只有引用没有秘密。
- **日志通道**：`ctx.logger(name)` 的 info 进结构化日志缓冲（Web UI 的日志视图可见），CLI 终端默认只出 error/warn。

## 新增一个插件

1. `cp -r packages/oauth-providers packages/<name>`，目录名即包目录。
2. 改 `package.json`：`name`（如 `dsh-<name>`）、`description`；依赖按需增删（consumed services 进 `peerDependencies` + `devDependencies`；仅宿主侧用不到的 runtime 依赖进 `dependencies`）。
3. 改 `cordis.patch.yml`：行的 `id` 与 `name` 换成新包名。
4. 改 `src/`：插件逻辑（`name` / `inject` / `Config` / `apply`）。不需要浏览器 UI 就删掉 `client/`、`dsh.client` 声明与 `exports["./client"]`。
5. 改 `dev.patch.yml` 的绝对路径。
6. `pnpm install && pnpm check`，然后按上面两种方式之一验证。

## 版本对齐说明

`devDependencies` 里 `@deepseek-ai/*` 钉的是**本机 dsh 内置的精确版本**（cordis 4.0.2 / schemastery 3.18.2 / dsh-llm、dsh-settings、dsh-authorization、dsh-credentials、dsh-client-connection、dsh-host-webserver 0.1.5-rc.2），使本仓库的类型检查与宿主运行时一致——尤其 schemastery 3.18.4 起类型变严，`Schema<Config>` 注解会与 `.default()` 推断冲突。`peerDependencies` 保持宽松范围，交给安装方解析。升级 dsh 后请同步核对这些钉版；API 演进（如 `CallId` → `ToolCallId`、`installSettingsSection` → `ctx.settings.installSection`）正是通过钉版类型检查暴露出来的。

## 许可与致谢

本仓库以 Apache-2.0 发布。`packages/oauth-providers` 部分派生自
[werifu/dsh-oai-oauth](https://github.com/werifu/dsh-oai-oauth)（MIT）与
[@earendil-works/pi-ai](https://github.com/earendil-works/pi)（MIT），两份许可
文本完整保留在 [`packages/oauth-providers/THIRD-PARTY-NOTICE.md`](./packages/oauth-providers/THIRD-PARTY-NOTICE.md)。

## 参考

- [Your first Harness plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) — 插件最小形态、三种写法、`ctx.effect` 清理
- [Build a tool](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool) — defineTool DSL
- [Plugin configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config) — Schemastery Config 与 HMR
- [Package and install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) — bundle/profile 双清单、层序、git 安装的 prepare 陷阱
- [Cordis tutorial](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/) — 底层框架七讲
- [官方仓库](https://github.com/deepseek-ai/deepseek-harness) / [社区插件主题](https://github.com/topics/dsh-plugin)
