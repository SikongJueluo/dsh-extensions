# dsh-extensions

Out-of-tree [DeepSeek Harness](https://www.deepseek.com/harness/en/) 插件库 —— 一个 pnpm workspace monorepo，每个 `packages/*` 目录都是一个可独立安装的 **bundle**（内含 Cordis plugin）。

以 `packages/hello` 为参考模板：一个可配置的 `greet` 工具，覆盖了插件开发的完整要素（`name` / `inject` / Schemastery `Config` / `ctx.tools.register(defineTool(...))` / `ctx.logger`）。

## 仓库结构

```text
dsh-extensions/
├── package.json            # workspace 根：build / typecheck / clean 聚合脚本
├── pnpm-workspace.yaml     # packages/* 为 workspace 成员
├── tsconfig.base.json      # 共享严格 TS 配置（noEmit，构建交给 tsdown）
└── packages/
    └── hello/              # 示例插件 dsh-hello（复制此目录即得新插件骨架）
        ├── package.json        # 声明 dsh.bundle.patch —— 这是"可安装 bundle"的标志
        ├── cordis.patch.yml    # bundle 层：插入插件行（id + npm 包名）
        ├── tsdown.config.ts    # 构建到 lib/index.js（+.d.ts），依赖保持 external
        ├── tsconfig.json
        ├── dev.patch.yml      # 开发期 --patch overlay（指向构建产物的绝对路径）
        └── src/index.ts        # 插件本体：apply(ctx, config)
```

## 前置条件

- Node.js ≥ 20（直接以 `--patch` 指向 `src/*.ts` 需要 ≥ 23.6 的内置 type stripping；本仓库的开发循环指向构建产物，无此要求）
- pnpm ≥ 10
- 已安装 `dsh` CLI（`npx @deepseek-ai/dsh` 或包管理器安装）

## 日常命令

```sh
pnpm install        # 安装依赖；workspace 各包的 prepare 会自动完成首次构建
pnpm build          # 构建所有包（tsdown → lib/index.js + lib/index.d.ts）
pnpm typecheck      # 所有包 tsc --noEmit
pnpm check          # typecheck + build
pnpm clean          # 清理构建产物
```

## 两种加载方式

### 1. 开发循环：`--patch` overlay（不安装、立即生效）

编辑 `packages/hello/dev.patch.yml`，把绝对路径换成你的机器上的实际路径后：

```sh
pnpm build
dsh web --patch ./packages/hello/dev.patch.yml     # 或 --profile headless 等任意 profile
```

- 路径必须是**绝对路径**（patch 只贡献配置，不改变 loader 的模块解析基准）。
- 重新构建后需重启 dsh 进程才能看到变化（`--patch` overlay 不热重载）。
- 终端出现 `[dsh-hello] loaded (...)` 即加载成功。

### 2. 安装循环：作为 bundle 装进 profile

```sh
pnpm build                                          # link: 安装不会触发构建，先本地构建
dsh plugin --profile <你的profile> add ./packages/hello
dsh --profile <你的profile> --dump-config           # 应看到 "# == dsh-hello" 层
dsh --profile <你的profile>                         # 启动，终端打印 loaded 行
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
- 用户因此可以不碰你的包，直接在自己的 patch 里覆盖你插入的行（本仓库已实测：profile patch 写 `greeting: Bonjour` 后加载日志即变化）。
- `ctx.tools` / `ctx.logger` 等 service 由宿主提供；`inject = ['tools']` 让框架等到 tools service 就绪才执行 `apply`。
- **日志通道**：`ctx.logger(name)` 的 info 进结构化日志缓冲（Web UI 的日志视图可见），CLI 终端默认只出 error/warn。开发期想要终端即时反馈，用 `console.log`（官方第一课的做法，示例里保留了这一行并注明）。

## 新增一个插件

1. `cp -r packages/hello packages/<name>`，目录名即包目录。
2. 改 `package.json`：`name`（如 `dsh-<name>`）、`description`；依赖按需增删（consumed services 进 `peerDependencies` + `devDependencies`）。
3. 改 `cordis.patch.yml`：行的 `id` 与 `name` 换成新包名。
4. 改 `src/index.ts`：插件逻辑（`name` / `inject` / `Config` / `apply`）。
5. 改 `dev.patch.yml` 的绝对路径。
6. `pnpm install && pnpm check`，然后按上面两种方式之一验证。

## 版本对齐说明

`devDependencies` 里 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 钉的是**本机 dsh 内置的精确版本**（4.0.2 / 3.18.2），使本仓库的类型检查与宿主运行时一致——尤其 schemastery 3.18.4 起类型变严，`Schema<Config>` 注解会与 `.default()` 推断冲突。`peerDependencies` 保持宽松范围（`^4.0.2` / `^3.18.2`），交给安装方解析。升级 dsh 后请同步核对这两个钉版。

## 参考

- [Your first Harness plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/) — 插件最小形态、三种写法、`ctx.effect` 清理
- [Build a tool](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/tool) — `defineTool` DSL
- [Plugin configuration](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config) — Schemastery Config 与 HMR
- [Package and install](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish) — bundle/profile 双清单、层序、git 安装的 prepare 陷阱
- [Cordis tutorial](https://deepseek-harness.github.io/deepseek-harness/en/develop/cordis-tutorial/) — 底层框架七讲
- [官方仓库](https://github.com/deepseek-ai/deepseek-harness) / [社区插件主题](https://github.com/topics/dsh-plugin)
