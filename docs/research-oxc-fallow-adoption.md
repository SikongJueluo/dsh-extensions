# Oxfmt、Oxlint、tsgolint 与 Fallow 接入建议

核实日期：2026-11-16。依据官方文档、官方源码和 npm registry；未安装依赖、未运行候选工具。本文只记录选型建议，不表示仓库已接入。

## 结论

建议采用，但按三类职责组织，而不是四条平行检查链：

| 职责 | 工具 | 初期位置 |
| --- | --- | --- |
| 确定性排版 | Oxfmt | 校准范围后作为硬门禁 |
| 单文件规则与类型感知规则 | Oxlint + oxlint-tsgolint | 小规则集；验证客户端覆盖后加入 typed lint 门禁 |
| 跨文件可达性、依赖、重复与复杂度 | Fallow | 先报告、校准入口，再逐类升级门禁 |

`pnpm typecheck`、构建和 `check:client` 暂时保留。Fallow 的报告不构成删除运行时入口或公开 API 的充分依据。

## 1. Oxlint 与 tsgolint：一个用户入口

- tsgolint 是 Oxlint 的类型感知后端：安装 `oxlint` 和 `oxlint-tsgolint`，通过 `oxlint --type-aware` 调用，不需要再维护独立 tsgolint 命令。[官方使用说明](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- Oxlint 负责遍历、配置、非类型规则与输出；tsgolint 使用 `typescript-go` 建立 TypeScript program 并执行类型规则。[官方 README](https://github.com/oxc-project/tsgolint)
- 当前官方要求 TypeScript 7.0+；本仓 catalog 已声明 `typescript: ^7.0.2`，代际相符。仍须锁定兼容的 Oxlint/后端版本，而非假设任意版本可混用。[兼容说明](https://oxc.rs/docs/guide/usage/linter/type-aware.html#typescript-compatibility)
- `--type-aware` 不等于执行编译器诊断；追加 `--type-check` 才包含类型错误。官方允许用 `oxlint --type-aware --type-check` 替代独立 `tsc --noEmit`，但本仓应先验证项目覆盖与诊断一致性再决定，不在初次接入时删除 typecheck。[类型检查说明](https://oxc.rs/docs/guide/usage/linter/type-aware.html#type-checking-diagnostics)

建议从默认 correctness 类目和少量高价值类型规则起步，不启用 `all`：

- `typescript/no-floating-promises`
- `typescript/no-misused-promises`
- `typescript/switch-exhaustiveness-check`

上述类型规则在官方后端实现列表中；React、可访问性和测试规则按客户端/测试目录分别配置，不把环境规则无差别套到所有文件。[规则覆盖](https://github.com/oxc-project/tsgolint#implemented-rules)、[Oxlint 插件与类别](https://oxc.rs/docs/guide/usage/linter/cli.html)

`no-unsafe-*`、严格布尔表达式与风格性限制可在实际报告评估后逐条加。不要为了消除 Promise 报警批量加 `void`：显式丢弃返回值并不处理 rejection，修复仍应遵守调用方的错误处理契约。

## 2. 本仓首要门槛：客户端 tsconfig 发现

仓库事实：

- 宿主 `tsconfig.json` 继承 `tsconfig.base.json`，使用 NodeNext，并排除 `src/client`。
- 浏览器半插件另用 `tsconfig.client.json`，使用 Bundler、DOM 和 JSX。
- 包脚本显式执行两套 `tsc -p`；参见 [jj-workspace 配置](../packages/jj-workspace/package.json)、[宿主配置](../packages/jj-workspace/tsconfig.json)、[客户端配置](../packages/jj-workspace/tsconfig.client.json)。

官方 CLI 明确：`--tsconfig` 只影响 import resolution，**type-aware 不遵守该选项**，而是自行发现 `tsconfig.json`。不能建议用 `--tsconfig tsconfig.client.json` 修复覆盖。[CLI 契约](https://oxc.rs/docs/guide/usage/linter/cli.html#basic-configuration)

后端源码检查文件是否属于发现的配置，并搜索 references 和祖先配置。因此，当前非默认名客户端配置存在漏检风险；这是源码推导，尚未在本仓运行验证。[发现实现](https://github.com/oxc-project/tsgolint/blob/main/internal/utils/find_tsconfig.go)

候选方案：客户端目录提供就近 `tsconfig.json`；或者用默认名 solution config 显式引用各项目。两者都要实测，references 不能写成 glob 字符串数组，应列出 TypeScript 接受的 `{ "path": "…" }` 对象。

验收不能仅看退出码：检查 `OXC_LOG=debug oxlint --type-aware` 的 program 分配与 unmatched 文件，并在宿主、客户端各用临时违规样例确认类型规则会触发。目标是**计划覆盖的 TS/TSX 文件**均被正确检查，不要求仓库所有 JS/工具文件的 unmatched 总数归零。[官方排障](https://oxc.rs/docs/guide/usage/linter/type-aware.html#performance-and-debugging)

官方提醒 monorepo 跨包类型解析可能需要先构建声明。按本仓实际解析需求安排 typed lint；当前根 `check` 是 typecheck → build → check:client，不能未经调整就宣称它已满足新增 typed lint 的构建前置。[monorepo 前置](https://oxc.rs/docs/guide/usage/linter/type-aware.html#monorepos-and-build-outputs)

## 3. Oxfmt：先只改变排版

- 导入排序和 Tailwind 排序默认关闭，`package.json` 字段排序默认开启。首轮建议显式关闭 `sortPackageJson`，其余排序暂不启用，避免把排版接入与重排混成一次修改。[排序默认值](https://oxc.rs/docs/guide/usage/formatter/sorting.html)
- 初期只覆盖明确选定的源码、工具脚本和 JSON；文档排版、YAML、导入排序和 Tailwind class 排序可以独立评估。
- 忽略规则要排除依赖与构建产物，尤其使用精确的 `packages/*/lib/**`，不要写 `**/lib/**` 误伤源码中的同名目录。本仓 `.gitignore` 已刻意区分这两者。[仓库忽略规则](../.gitignore)
- Oxfmt 读取 `.gitignore`，但显式传入 gitignored 文件仍可能格式化；需要强保证的排除项应写入 formatter 的 `ignorePatterns`。[官方忽略语义](https://oxc.rs/docs/guide/usage/formatter/ignore-files.html)
- 当前 registry 的 Oxfmt 为 0.x；不要仅从版本号推断所有功能是否稳定，采用锁定版本并审阅升级 diff 的策略。[官方 registry](https://registry.npmjs.org/oxfmt/latest)

YAML 在官方支持范围内，但本仓 patch 使用 `!!js` 承载表达式；本次未核实 formatter 对这些标签的实际处理。建议先排除 `packages/*/*.patch.yml`，之后在副本上格式化、比较实际输出，并验证 Loader 装载语义。`--check`/`--list-different` 只能说明格式状态，不能替代输出 diff 或装载测试。[语言支持](https://oxc.rs/docs/guide/usage/formatter/language-support.html)、[本仓实例](../packages/session-write-access/cordis.patch.yml)

## 4. Fallow：先建立正确的项目图

Fallow 从入口建立模块图，检测 unused files/exports/types/dependencies 等，另提供 `dupes` 和 `health`。它不是 Oxlint 的又一套全规则替代品；建议只用其跨文件分析能力，避免重复设置语义/风格门禁。[死代码分析](https://fallow.tools/docs/analysis/dead-code/)、[接入指南](https://fallow.tools/docs/adoption/)

官方支持 pnpm workspace 与跨包引用；可从根分析整个项目图。包 exports 和框架插件有自动入口识别能力，但不等于理解本仓所有自定义运行时约定。[workspace 文档](https://fallow.tools/docs/configuration/workspaces/)、[入口配置](https://fallow.tools/docs/configuration/overview/)

需要验证或显式建模的本仓边界：

1. 宿主入口及 `apply`、`name`、`inject`、`Config` 等外部消费者契约，不以仓库内部是否 import 判断死代码。
2. `exports["./client"] → lib/client.js` 与真正入口 `src/client/index.tsx` 的对应关系。
3. `cordis.patch.yml` 和 `dsh.client` 字段中的运行时装载信息。
4. 非标准名 `vite.client.config.ts` 与共享 `defineHostConfig()`/客户端构建工厂的识别程度。
5. Storybook stories、测试、smoke 脚本和 `tooling/`，防止只覆盖主应用代码。
6. 宿主提供的 peer 依赖、用于声明合并的类型依赖，以及测试/预览所需依赖，不能按“源码未 import”自动删除。

优先顺序是：内置插件识别 → `entry`/`dynamicallyLoaded` 表达运行时入口 → 可见性标注/`publicPackages` 表达外部 API → 最小范围的例外。不要把所有源码设成 entry，也不要全局关闭 unused exports：两者都会掩盖真正问题。可安装的 bundle 与私有共享 UI 包应分别建模。[官方采用策略](https://fallow.tools/docs/adoption/#match-the-reason-to-the-right-mechanism)

先用 `fallow list --plugins`、`fallow list --entry-points` 核对自动识别结果，再运行只报告的分析。unused 类别有默认 error，第一次直接挂 CI 可能立即阻断；分阶段把高置信问题升为 error。baseline 只能承接已审查的历史问题，不应掩盖入口缺失。[严重度](https://fallow.tools/docs/configuration/rules/)

重复和复杂度先作为报告：独立 bundle 的相似契约外壳不一定值得抽象，不能为降低重复率制造跨包耦合。

版本门槛：当前 npm `fallow@3.43.1` 要求 Node ≥22，而本仓文档写 Node ≥20。npm 包按平台分发原生二进制，NixOS 上还须实际验证启动；有平台依赖时通过项目 Nix/devShell 声明式解决，不作全局临时安装。[官方 registry](https://registry.npmjs.org/fallow/latest)

## 5. 建议接入阶段与验收

1. 配置并锁定根级工具依赖；保持现有 pnpm catalog 和 hoisted linker 约定。
2. 接入小规则集 Oxlint；配置 Oxfmt 的范围与风格，单独一层完成首次纯格式化，不夹带语义修复。
3. 接入 `oxlint-tsgolint`，解决客户端项目发现；宿主/客户端各验证违规样例，保留双配置 typecheck。
4. 运行 Fallow 报告并校准入口与外部契约；确认的死代码和依赖清理另作变更，不自动批量删除。
5. 逐类收紧门禁；本地与 CI 调用相同脚本，确定性检查进入常规 check，复杂度/重复分析可先独立运行。

另一个现有缺口：根 `package.json` 的 `check` 不包含 `test` 和 `check:pack`。选型不能替代测试和发布产物验证，应明确它们在 CI/发布中的位置；是否并入 check 可以单独决策。[根脚本](../package.json)

未验证：工具安装与原生二进制启动、规则实际噪声、typed lint 客户端覆盖、Fallow 入口映射、Oxfmt 的 `!!js` 处理、任何候选工具的本仓性能与检查结果。本文不据此声称迁移已经可用。
