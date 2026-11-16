# 质量门禁（Oxfmt / Oxlint / Fallow）

> **状态：候选基线，等待例外批准。** 工具已安装并锁定、配置已落地、全仓扫描已跑完；
> 本文第 6 节的清单是本次接入**必须由用户批准**的部分。批准前这些条目只算提案，
> 修复分层从第 8 节开始，最终 `pnpm check` 会等修复完成后才把它们并入门禁。
> 逐条原始数据见 [quality-scan-baseline.md](quality-scan-baseline.md)。

## 1. 职责分离

| 工具 | 负责 | 明确不负责 |
| --- | --- | --- |
| `tsc`（现有 `pnpm typecheck`） | 每个包的完整类型检查（宿主 `tsconfig.json` + 双半包 `tsconfig.client.json`） | 风格、跨文件死代码 |
| `oxfmt` | 纯排版：引号、分号、缩进、换行、行宽 | 语义、命名、导入顺序、Tailwind 顺序、manifest 字段顺序 |
| `oxlint` + `oxlint-tsgolint` | 单文件正确性与类型规则（含不安全断言、浮空 Promise、hooks、a11y） | 跨文件可达性、依赖卫生、重复度 |
| `fallow` | 跨文件图：死代码、依赖卫生、循环依赖、重复与复杂度报告 | 单文件语义规则，也不替代 `tsc` |

排版规则不从 lint 里重复；Fallow 不承担“某行是否该加分号”这种判断。

## 2. 版本与环境

```text
oxlint 1.93.0          oxlint-tsgolint 7.0.2007
oxfmt 0.78.0           fallow 3.43.1
```

- 四个工具都在根 `devDependencies` 经 `catalog:` 精确钉版（无 `^`/`latest`）。升级是独立提交，须按第 8 节审查新增规则。
- 开发与完整 CI 用 **Node 24 LTS**（根 `package.json` `engines.node >= 24`），pnpm 12.3.4。Node 24 以外的 Node 20 只用于**产物兼容性验证**，不跑开发工具。
- 本机 Node 24.21.0 已实测：oxlint/oxfmt/fallow 三个原生二进制在 NixOS 上都能启动，`fallow --version` 自检签名通过；未新增系统依赖。
- 自动检查需要的外部程序：`jj`、`git`、`fish`、`mkfifo`、`tar`。Fallow 把 `jj` 记为外部提供（`.fallowrc.jsonc` 的 `ignoreBinaries`），其余是常规 POSIX/工具链。
- 网络由 mihomo 管理，本次未改任何网络配置。

## 3. Oxlint

### 3.1 区域与插件

`plugins` 的缺省集合是 `eslint / typescript / unicorn / oxc / import / promise / node`，再按区域叠加：

| 区域 | 文件 | 追加插件 | env | 类型感知 |
| --- | --- | --- | --- | --- |
| 宿主半 | `packages/*/src/**`（除 client） | — | `builtin` + `node` | 是 |
| 客户端半 | `packages/*/src/client/**`、`packages/ui/src/**`、`.storybook/**` | `react`、`jsx-a11y` | `browser`（关掉 `node`） | 是 |
| 测试与脚本 | `**/test/**`、`**/*.test.*`、`**/smoke.mjs`、`packages/*/scripts/**`、`scripts/**` | `vitest` | `builtin` + `node` + `vitest` | 是（TS）/ 否（JS） |
| 其余 JS | `**/*.{js,mjs,cjs}` | — | 同上 | **否**（见 3.4-C2） |

`no-console` 在源码里是错误，在测试/smoke/脚本里关闭：那些程序的 stdout 就是它们的接口。

### 3.2 类别策略

- `correctness`、`suspicious`、`pedantic`、`perf`：整类 **error**，只按 3.4 的批准清单收窄。
- `style`：整类 **off**。理由：其中大多数规则只是重述排版（已由 Oxfmt 独占），其余是个人口味或数值预算；有语义价值的 6 条逐条采纳（3.3）。逐条判定见 baseline 附录 A。
- `restriction`：整类 **off**，因为它按定义是“禁用某语言特性”（`no-async-await`、`no-optional-chaining`、`no-rest-spread-properties`、`no-undefined`……），与本仓代码的既定写法直接冲突；有项目约束价值的 13 条逐条采纳（3.3）。逐条判定见 baseline 附录 B。
- `nursery`：off。上游标注为不稳定，升级时按第 8 节单独审查。

### 3.3 采纳的规则

从 `style` 采纳（203 处存量）：`prefer-const`、`object-shorthand`、`prefer-template`、
`no-duplicate-imports`、`typescript/consistent-type-imports`、`typescript/array-type`。

从 `restriction` 采纳（223 处存量）：`typescript/no-explicit-any`、
`typescript/no-non-null-assertion`、`typescript/no-invalid-void-type`、
`typescript/use-unknown-in-catch-callback-variable`、`import/no-cycle`、`no-alert`、
`no-empty`、`no-param-reassign`、`no-return-assign`、`no-sequences`、
`promise/catch-or-return`、`unicorn/prefer-number-properties`、`react/button-has-type`
（仅客户端区域）。

`no-unassigned-import` 不算排除：它用 `allow: ["**/*.css"]` 放行样式副作用导入。

### 3.4 排除与降级（待批准）

#### A. 类别级（两项）

| # | 决定 | 影响 | 理由 |
| --- | --- | --- | --- |
| A1 | `style` 整类 off，仅采纳 3.3 的 6 条 | 279 条 style 规则不参与，其中 109 条在对照扫描中命中 | Oxfmt 独占排版；其余为口味/数值预算。逐条理由见 baseline 附录 A 的 F/T/N/X 码 |
| A2 | `restriction` 整类 off，仅采纳 3.3 的 13 条 | 101 条 restriction 规则不参与，其中 48 条命中 | 该类别按定义禁用语言特性；本仓刻意使用 async/await、可选链、展开、具名导出、`undefined`。逐条理由见 baseline 附录 B |

#### B. 规则级（19 条，全部来自 `pedantic`/`suspicious`）

| # | 规则 | 命中 | 例子 | 理由 |
| --- | --- | --- | --- | --- |
| B1 | `typescript/prefer-readonly-parameter-types` | 1475 | `triggers/src/replay.ts:62` | 要求每个参数类型的每个成员都标 `readonly`；编译器不依赖它，不构成缺陷，纯标注风格 |
| B2 | `typescript/strict-boolean-expressions` | 290 | `triggers/src/service.ts:1068` | 在 `tsc --strict` 之上额外禁止真值判断；290 处都是正常的空值/长度守卫 |
| B3 | `require-await`（eslint） | 240 | `oauth-providers/.../login.ts:107` | async 无 await 是本仓插件契约返回 Promise 的写法；去掉 async 会改变函数身份与调度 |
| B4 | `typescript/require-await` | 217 | `triggers/test/durable.test.ts:94` | 同 B3，type-aware 版本 |
| B5 | `typescript/no-confusing-void-expression` | 124 | `triggers/src/service.ts:194` | React 事件处理器 `() => setX()` 是惯用写法 |
| B6 | `no-negated-condition` | 67 | `oauth-providers/.../discovery.ts:43` | `if (!x)` 早返回是本仓主流守卫写法 |
| B7 | `unicorn/no-negated-condition` | 67 | 同上 | 同 B6 |
| B8 | `no-inline-comments` | 42 | `search-integrator/test/fetch-page.test.ts:108` | 本仓用行尾注释解释相邻常量，属既定风格 |
| B9 | `max-lines` | 68 | `plan-usage/src/sources/commandcode.ts:317` | 数值预算，按第 8 节由 Fallow health 报告，不做逐行卡口 |
| B10 | `max-lines-per-function` | 198 | `oauth-providers/.../login.ts:51` | 同 B9 |
| B11 | `max-statements` | 414 | 同上 | 同 B9 |
| B12 | `max-depth` | 27 | `oauth-providers/.../adapter.ts:275` | 同 B9 |
| B13 | `max-classes-per-file` | 11 | `oauth-providers/.../auth.ts:15` | 同 B9 |
| B14 | `max-params` | 72 | `oauth-providers/.../oauth.ts:165` | 同 B9；拆参数对象不是无成本改动 |
| B15 | `max-expects` | 117 | `search-integrator/test/fetch-page.test.ts:40` | 同 B9；测试断言密度不设硬上限 |
| B16 | `vitest/max-expects` | 117 | 同上 | 同 B15 |
| B17 | `unicorn/max-nested-calls` | 74 | `task-anchor/test/checkpoint.test.ts:95` | 同 B9 |
| B18 | `no-await-in-loop` | 105 | `jj-workspace/test/client-deps.test.mjs:154` | 循环内顺序 await 是本仓刻意的顺序/背压语义；并行化会改变可观察顺序 |
| B19 | `import/max-dependencies` | 8 | `oauth-providers/.../chatgpt/index.ts:22` | 数值预算；依赖卫生由 Fallow 负责 |
| B20 | `unicorn/no-useless-undefined` | 108 | 测试/host stub 里的 `() => undefined`、`return undefined` | 纯风格：显式 `undefined` 在 stub 里表达“没有值”的意图；自动修复有 13 处与 `Promise<T \| undefined>` / `Promise<void>` 签名冲突（去掉实参直接 `tsc` 报错），且 62 处是测试桩，改与不改没有质量差别 |
| B21 | `import/no-empty-named-blocks` + `unicorn/require-module-specifiers` | 50 × 2 | `oauth-providers/.../chatgpt/index.ts:11` | 两条规则只测 `specifiers.length === 0`、不看 `importKind`，把 `import type {} from 'x'` 判成残留空括号。该写法是 TS 拉入 declaration merge（`Context.settings`、`Context.attachments`、SlotMap…）的唯一无运行期导入方式：实测删掉后 `ctx.settings` 不再通过类型检查；搬进 `.d.ts` 同样被报；改裸 `import 'x'` 会变成运行期导入。宿主 SDK（deepseek-ai/deepseek-harness）用同一写法并附同样注释。全仓没有 `import {} from` 或 `export {}` 的其它用法，排除的只是这一形态 |
| B22 | `no-redeclare` | 21 | `remote-exec/src/index.ts:107` | 全部是 `interface Config` + `const Config = Schema.object(...)` 的声明合并（AGENTS.md 规定的写法：loader 要按推断出的 schema 对上 interface）。TS 对重复的块级声明本就报 `Cannot redeclare block-scoped variable`，JS 里重复 `const` 是解析错误，本仓又不用 `var`，因此这条规则在本仓没有可命中的真实缺陷 |
| B23 | `typescript/no-unsafe-type-assertion`（仅测试/smoke 文件） | 229 | `execution-guard/test/integration.test.ts:40` | 测试双无法在类型上满足类形态的主机接口：cordis `Context` 挂十几个服务、`SessionEvent` 是带 branded `seq` 的判别联合，fixture 构造"假装是主机"的对象时，断言是唯一手段。豁免只落在 fixture 层：`no-non-null-assertion` 在测试里**仍然强制**（161 条逐条修），其余 unsafe-\* 规则不变，且 `scripts/check-suppressions.mjs` 把任何未登记的内联抑制挡在门外 |

#### C. 插件与范围（三项）

| # | 决定 | 理由 |
| --- | --- | --- |
| C1 | 不启用 `jest`、`jsdoc`、`nextjs`、`vue` 插件 | 本仓用 vitest + `node:test`，没有 Jest；没有 JSDoc `@param` 约定（文档在 README/`docs/`）；没有 Next.js/Vue 应用 |
| C2 | 类型感知规则对 `*.{js,mjs,cjs}` 全关 | 无注解的 JS 只能推出 `any`/error 类型：实测 `handoff/smoke.mjs` 因 `let registered = null` 产生 857 条 `no-unsafe-member-access` 假阳性。JS 仍受全部语法级规则约束 |
| C3 | 不启用 `react-perf` 插件（98 处命中） | `jsx-no-new-function-as-prop` 一类规则迫使到处 `useCallback`/`useMemo`，与“不为数值盲目抽象”的既定政策冲突，且无实测渲染成本证据 |

### 3.5 类型感知覆盖（实测证据）

配置解决方式（不是 `--tsconfig`：官方明确它只影响 import 解析）：

1. 每个双半包新增 `packages/*/src/client/tsconfig.json`（8 个，内容只有
   `{"extends": "../../tsconfig.client.json"}`）。tsgolint 为每个文件找**最近的同名
   `tsconfig.json`**，客户端文件因此在真实客户端 program 里，配置与
   `tsc -p tsconfig.client.json` 完全一致。
2. 新增根 `tsconfig.json`：只给 per-package 配置覆盖不到的 TS（`*.config.ts`、
   `packages/*/test`、`scripts/`、`tooling/`、`.storybook/`）。这是**仅用于 lint 的
   program**，不参与 `pnpm typecheck`；`allowJs` 关闭。

实测（`OXC_LOG=debug oxlint`）：

```text
Starting to assign files to programs. Total files: 277
Done assigning files to programs. Total programs: 30. Unmatched files: 24
```

24 个 unmatched **全部是 `.mjs`**（测试/smoke/脚本），与 C2 的“JS 不做类型感知”一致。
253 个文件分到 30 个真实 program；宿主、客户端、ui、构建配置、Storybook、tooling 的
TS/TSX 没有一个落空。分布（`OXC_LOG=debug` 的分配日志）：

| program | 文件 |
| --- | ---: |
| 根 `tsconfig.json`（配置、测试、脚本、tooling、Storybook） | 37 |
| `packages/ui` | 24 |
| `search-integrator` | 21 |
| `auto-permit` | 16 |
| `triggers` | 15 |
| `oauth-providers` / `session-write-access` | 14 / 14 |
| `execution-guard` / `handoff` | 12 / 12 |
| `plan-usage` | 11 |
| `auto-continue` / `recursive-skills` | 10 / 10 |
| `task-anchor` | 9 |
| `jj-workspace` | 8 |
| `toolchain-access` | 7 |
| `more-providers` / `cmd-permit` | 6 / 6 |
| `context-audit` / `remote-exec` | 3 / 3 |
| `auto-env` / `rtk-rewrite` | 2 / 2 |
| `crew` | 1 |
| 8 个 `packages/*/src/client/tsconfig.json` | 各 1（jj-workspace 3） |

违规样例验证（临时文件，验证后删除）：在宿主 `src/*.ts`、客户端 `src/client/*.tsx`、
`scripts/*.mjs` 各放 `await 1` + 未处理 Promise，三处都报出
`typescript(await-thenable)` / `typescript(no-floating-promises)`；同一样例在
`.mjs` 中只报语法级规则，符合 C2。

断言族行为实测（`packages/handoff` 临时样例）：

| 写法 | 结果 |
| --- | --- |
| `as const`、`satisfies T` | 不报（安全收窄） |
| `x as string`（`x: unknown`） | `no-unsafe-type-assertion` |
| `x as unknown as T` | 报后半个 `as T` |
| `x as never`、`x as any` | `no-unsafe-type-assertion`（+ `no-explicit-any`） |
| `maybe!.value` | `no-non-null-assertion` |

即：`as const`、`satisfies`、普通类型注解不会被误判；不安全的**收窄**才会。规则本身
不能证明类型守卫实现真实，语义仍需人工审查。

### 3.6 现有内联抑制

7 处存量 `// eslint-disable-next-line react-hooks/exhaustive-deps`
（jj-workspace 4、oauth-providers 2、plan-usage 1）。oxlint 认这个 id，且
`reportUnusedDisableDirectives: error` 已开：当前 1 处已无用（`oauth-providers/src/client/index.tsx:246`）。
这 7 处按“逐处审查”处理，不自动迁移成新豁免。

### 3.7 修复积压（1810 条，分层计划）

| 层 | 内容 | 数量 |
| --- | --- | --- |
| 类型逃生口 | `no-unsafe-type-assertion` 442、`no-non-null-assertion` 181、`no-unsafe-*`（member/call/assign/return/argument）55、`no-explicit-any` 5 | 683 |
| 机械可改 | 有建议修复的其余条目，如 `require-unicode-regexp` 228、`no-useless-undefined` 108、`prefer-template` 90、`no-duplicate-imports` 83 | ~1300 |
| 语义需判断 | `no-floating-promises` 16、`consistent-return` 10、`unbound-method` 10、`prefer-nullish-coalescing` 54、`no-array-sort` 38、`promise/always-return` 36 等 | ~150 |

有建议修复 ≠ 可以批量 `--fix`：`require-unicode-regexp` 加 `u`、`.sort()` → `.toSorted()`
都改变运行时行为，须逐处确认；`no-void`、`no-floating-promises` 更不允许靠加 `void`
或空 `.catch()` 消音。

#### 3.7.1 类型逃生口按区域分布（接入时快照；当前总量见 3.7）

| 规则 | src | client | test | 合计 |
| --- | ---: | ---: | ---: | ---: |
| `no-unsafe-type-assertion` | 202 | 15 | 245 | 462 |
| `no-non-null-assertion` | 21 | 1 | 167 | 189 |
| `no-unsafe-member-access` | 8 | 8 | 7 | 23 |
| `no-unsafe-assignment` | 1 | 0 | 9 | 10 |
| `no-unsafe-call` | 0 | 8 | 1 | 9 |
| `no-unsafe-return` / `argument` | 0 / 2 | 5 / 0 | 3 / 1 | 11 |
| `no-explicit-any` | 5 | 0 | 0 | 5 |

另有 1 条 `no-unsafe-assignment` 在 `.storybook/preview.tsx`（不在上表四列内，故合计为 710）。

八条规则合计：生产代码（src + client）**276 条**、测试 **433 条**、Storybook 预览 1 条。其中 `no-unsafe-type-assertion` 在生产侧 217 条、测试侧 245 条。测试占比高不代表可以整体
豁免——测试里的假类型同样会在重构时骗过编译器——但修复顺序应先生产后测试：生产侧的断言
掩盖的是真实契约。

#### 3.7.2 生产侧按写法分类（接入时快照：219 条）

| 写法 | 数量 | 例子 | 正确修法 |
| --- | ---: | --- | --- |
| 收窄断言（`x as T`，含 `JSON.parse` 与 `ctx.get`） | 163 | `JSON.parse(payload) as JsonRpcResponse`（`search-integrator/src/mcp.ts:63`） | 在边界做真实校验（schema/type guard），或补 SDK 泛型 |
| 从 `any` 断言 | 52 | `ctx.get('spillStore') as SpillStoreLike \| undefined`（`search-integrator/src/audit.ts:49`） | 查宿主契约后用带类型的 getter；`ctx.get` 的返回形状要靠 SDK 类型验证 |
| 泛型断言（类型参数可任意实例化） | 4 | — | 用真实的泛型约束替代断言 |

按语言惯用法再切一刀（src 内文本匹配）：`as unknown as` 18 处、`as never` 10 处、
`JSON.parse(...) as T` 15 处、`ctx.get(...) as T` 8 处——这 51 处是最值得先处理的一批，
因为它们是“边界未校验”或“宿主契约未验证”的明确信号。

热点文件：`search-integrator/src/providers.ts` 17、`integrate.ts` 10、
`triggers/src/service.ts` 9、`search-integrator/src/tool.ts` 8、`more-providers/src/config.ts` 7、
`triggers/src/replay.ts` 7、`triggers/src/channel.ts` 7、`cmd-permit/src/index.ts` 7。

#### 3.7.3 修复顺序（每层独立 jj 层）

1. **边界校验**（`JSON.parse(...) as T` 15 处）：补 schema 或 type guard，顺带覆盖真实运行时
   输入；这是唯一能真正消除断言的一类。
2. **宿主服务形状**（`ctx.get(...) as T` 8 处）：先核 SDK 类型与 Inspect 提供的方法签名，
   能用官方泛型就用；不能用的逐处记录契约依据。
3. **`as unknown as`（18）与 `as never`（10）**：逐个看是否真的跨越了类型边界；`as never`
   多用于 `throw`，与 `only-throw-error` 一起处理。
4. **`!` 非空断言（生产 22 处）**：改成显式判空或改类型；不允许用 `?.` 掩盖“本该存在”的契约。
5. **测试断言（412 处）**：优先把 fixture 构造成真实类型；确实需要构造“非法形状”时，用
   `satisfies` 或显式 helper 收拢，而不是散落的 `as unknown as`。

每层都要跑 `typecheck` + 相关测试；改动涉及错误传播、后台任务或 fail-open 语义时先问，
不靠加 `void`、空 `catch` 或防御性 fallback 消音。

## 4. Fallow

### 4.1 自动识别的模型（未手写 entry 列表）

`fallow list` 实测自动识别 286 个文件、21 个 workspace，插件：`vite`、`tsdown`、
`storybook`、`typescript`、`tailwind`、`pnpm`、`vitest`（外加 oxlint/oxfmt 配置）。
入口来自 `package.json` 的 `main`/`exports`、`cordis.patch.yml`、`vite.client.config.ts`、
`tsdown.config.ts`、Storybook 与 Vitest 配置、根 `package.json` 脚本。

关键验证点：

- 客户端半 `src/client/index.tsx` 与 `lib/client.js` 的映射：`package.json`
  `exports["./client"]` 指向 `lib/client.js`，Fallow 把 `src/client/index.tsx` 识别为入口
  （见 `fallow list` 的 `package.json main` 来源），不需要手写 `entry`。
- 非标准 Vite 配置（`defineClientConfig` 工厂）与共享 `tooling/*` 构建预设：通过
  `vite.client.config.ts` / `tsdown.config.ts` 入口跟到 `tooling/`，`tooling/client/index.ts`
  的导出仍报 unused-export（`scripts/check-client.mjs` 未导入它），属真实可清理项。
- `cordis.patch.yml` 被当入口，避免把 bundle 清单误判为死文件。

### 4.2 运行时合同建模

静态图看不见 Cordis 的服务调用，`.fallowrc.jsonc` 用 `usedClassMembers` 声明：

- `{ "extends": "Service", "members": ["*"] }`、`{ "extends": "SandboxPolicyService", "members": ["*"] }`：
  服务类的方法与静态 `Config`/`inject` 由宿主经 `ctx.<name>` 代理调用，没有静态调用边。

配额源不再需要单独的例外：`QuotaSource` 合同原先埋在 `service.ts` 里，4 个源看不到它，
现在合同搬进 `sources/contracts.ts`，5 个源都写 `implements QuotaSource`，Fallow 通过接口
本身就能给成员记引用——所以那条 `usedClassMembers` 规则已删除，少一条配置、少一条告警。

建模前后：`unused-class-members` 38 → 3。剩余 3 条：`WaitSpool.set` 与
`DirenvLoader.snapshot` 只在 `.mjs` smoke 里调用（Fallow 无法给 JS 调用点归属类型），
`RewriteCache.size` 是未被使用的公开 getter（属于已发布的类表面，删除要先确认 API 取舍）。

### 4.3 扫描结果（`fallow dead-code`）

**3 条 error 级、35 条 warn 级。** error 级构成：

| 类别 | 数量 | 性质 |
| --- | --- | --- |
| unused class members | 3 | 见 4.2：2 个只有 `.mjs` smoke 调用点，1 个是未使用的公开 getter |

已清零的类别（各自在独立层完成）：unused files（4 个 `task-anchor` 拆分遗留模块）、
unused exports（64）、unused types（9）、unlisted dependencies（5）、duplicate exports（3）、
circular dependencies（2：`handoff` 的 `brief↔spawn` 与 `brief→spawn→meta`，已把 `brief` 拆成
`choice` / `pending` / `prompt` / `brief` 四个单向模块）。
`unused exports`/`unused types` 的处理方式是“能删的删、只在本文件用的去掉 `export` 关键字”，
过程中顺带暴露出 7 个连本文件都不用的符号，一并删除。

warn 级：`duplicate-export-aliases` 5（`export class X` + `export default X` 是有意的
测试/加载双入口）、`unused-dev-dependencies` 30（其中 `packages/ui` 的 20+ 个是
`@deepseek-ai/dsh-client-ui-primitives` 的预览/测试依赖图，见 `pnpm-workspace.yaml` 注释；
4 个是 CLI 工具本身）。

### 4.4 复杂度与重复：报告，不阻塞

- `fallow health`：4756 个函数中 308 个超过默认阈值（cyclomatic 20 / cognitive 15 /
  CRAP 30 / unit 60），平均可维护性 90.0。
- `fallow dupes`：4.56% 重复行（1940 / 42620），54 个克隆组、41 个簇。

按既定政策，这两项先作为**分析报告**，不进阻塞门禁；数值本身不作为拆函数/抽象的依据。

### 4.5 未采纳的可选件

`fallow-type-aware`（3.43.1）试装过并卸载：`unused-class-members` 38→36（仅 2 条），
同时把 17 处“导出的签名引用了宿主包导入的类型”（`Context`、`ShellExecSpec` 等）误报为
`private-type-leaks`。收益不抵多一个原生依赖，最终未加入。

## 5. Oxfmt

### 5.1 配置

`singleQuote: true`、`semi: false`、`tabWidth: 2`、`printWidth: 100`、
`trailingComma: all`、`arrowParens: always`、`endOfLine: lf`。
`sortImports`、`sortPackageJson`、`sortTailwindcss`、`jsdoc` 全部显式 `false`
（`sortPackageJson` 上游默认是 **on**，必须显式关掉）。

### 5.2 范围与验证（迁移已完成）

- 覆盖 JS/TS/TSX/JSON/CSS/YAML：**228 个文件**（159 ts、21 mjs、19 tsx、18 json、9 css、
  2 yml），实际改动 **+13479 / -5137 行**；最大单文件 `plan-usage/smoke.mjs`（+550 / -124）。
  `format:check` 现在通过（398 个受管文件、0 差异）。
- 行宽保持默认 100：现有 55446 行里 p95 = 97、p99 = 132，100 最贴近既有写法。换成 120
  会把改动降到 207 个文件 / +8200 -4607 行，但那是为了少改而改标准，不采用；若之后要改，
  只是重跑一次 `oxfmt --write .` 的独立层。
- **排版不是一次收敛的（实测复现）**：第一遍 `oxfmt --write .` 之后
  `packages/triggers/src/service.ts` 仍然不同，第二遍才稳定，第三遍为 no-op。排版层因此
  跑了两遍；`format:check` 只在两遍之后才会绿。
- **产物影响**：宿主 `lib/index.js` / `lib/index.d.ts` 逐字节不变；6 个客户端 bundle 的字节
  变了，原因是 `styles.css` 里 `@import "…"` 被改成单引号并被内联进 bundle（CSS 规范里
  两种引号等价）。`check:client`、`check:pack`、`build:storybook`、`test`、`check:smoke`
  在排版后全部通过。
- **YAML 已验证**：40 个 patch 文件的副本全部格式化后，7 条 `!!js` 行逐字未变
  （`disabled: !!js process.platform === 'win32'` 等），注释与层级保持不变。实际变动的只有
  `auto-permit` 的两个文件，差异是空字符串引号 `""` → `''`；用 js-yaml + 自定义 `!!js` tag
  解析原文件与格式化文件，文档树**逐值相等**（`SEMANTICALLY IDENTICAL`）。
- **Markdown 排除（A6 待批）**：Oxfmt 会重排所有表格列宽，宽度按字符数而非显示宽度计算，
  对本仓大量中文表格是**变差**而不是变好（实测 `README.md` 44 行、`packages/handoff/README.md`
  25 行，全部是表格 padding 与列表缩进）。若 A6 被否，补一层 `oxfmt --write '**/*.md'` 即可。
- `.tmp/`、`.dsh/`、`packages/*/lib/`、`storybook-static/` 由 `.gitignore` 自动排除；
  `repo/`（来源不明的嵌套仓库，未被本仓跟踪）显式排除，三个工具一致。

## 6. 批准清单

> **2026-11-16 已获批准：A1–A19 全部通过**（用户回复「我觉得可以」）。下列条目已落到配置与代码中，仅 A19 的剩余修复随修复层推进。

逐项批准/否决即可（例如“A1-A19 全部批准，但 B15 保留启用”）。

2026-11-16 OAuth 并入 more-providers：A9 中原 OAuth 客户端的同一处 hooks 抑制迁到
`packages/more-providers/src/client/oauth.tsx`，A17 的同一处 transport 抑制迁到
`packages/more-providers/src/oauth/transport.ts`。登记只跟随原代码移动，规则和豁免数量不变。

| # | 待批准项 | 建议 |
| --- | --- | --- |
| A1 | `style` 整类 off + 采纳 6 条 | 批准 |
| A2 | `restriction` 整类 off + 采纳 13 条 | 批准 |
| A3 | 规则级排除 B1–B23（表 3.4-B） | 批准 |
| A4 | 不启用 `jest`/`jsdoc`/`nextjs`/`vue`/`react-perf` 插件（C1、C3） | 批准 |
| A5 | 类型感知规则对 JS 全关（C2） | 批准 |
| A6 | Oxfmt 排除 Markdown（5.2） | 批准 |
| A7 | Fallow `usedClassMembers` 三条合同建模（4.2） | 批准 |
| A8 | 复杂度/重复只报告、不阻塞（4.4） | 批准 |
| A9 | 7 处存量 `react-hooks/exhaustive-deps` 抑制在修复层逐处处理（3.6） | 批准 |
| A10 | 根 `engines.node >= 24`（2） | 批准 |
| A11 | `check:smoke` 排除 `search-integrator/scripts/smoke-research.mjs`（需要真实 API key 与外网），保留为人工验证 | 批准 |
| A12 | 给 `WaitSpool.set` 与 `DirenvLoader.snapshot` 加两条带理由的 `fallow-ignore` 内联抑制（它们只在 `.mjs` smoke 里被调用，静态图无法归属类型） | 批准 |
| A13 | 删除 `RewriteCache.size`（未使用的公开 getter）。它是已发布包导出的类表面，删除属 API 收窄 | 批准 |
| A14 | 给 `handoff/src/selection.ts:195` 的 `await llm.listModels(...)` 加一条带理由的 `oxlint-disable-next-line typescript/await-thenable`（tsgolint 误报，`tsc` 证明该调用返回 Promise） | 批准 |
| A15 | `handoff/src/client/index.tsx` 的 `autoFocus={!COARSE}` 加一条带理由的抑制（AGENTS 明确：autoFocus 只作桌面增强、`pointer: coarse` 时关闭） | 批准 |
| A16 | `remote-exec/src/display.ts` 与 `auto-env/src/direnv.ts` 的 ANSI 正则加两条带理由的 `no-control-regex` 抑制（正则本身就是要匹配控制字符） | 批准 |
| A17 | `more-providers/src/oauth/transport.ts:19` 的 `promisify(execFile)` 加一条带理由的 `strict-void-return` 抑制（tsgolint 对 promisify 重载的误报；显式标注类型无效，`tsc` 通过） | 批准 |
| A18 | `no-duplicate-imports` 设 `allowSeparateTypeImports: true`：81 条里有 54 条是 `import type {…}` 与同模块值导入并存，而 `typescript/consistent-type-imports` 要求类型导入单独成句，两条规则当前互相打架 | 批准 |
| A19 | 剩余 9 条 correctness 的处理授权：优先按语义修正；凡修正会改变 UI 结构或可观察行为的（`set-state-in-effect` 5、`prefer-tag-over-role` 2、`no-callback-in-promise` 1），改为一条带理由的抑制并在提交说明里写明为什么不能改 | 批准 |
| A20 | 规则级排除 B21（`import/no-empty-named-blocks`、`unicorn/require-module-specifiers`）：这两条在 oxlint 里没有选项，而 `import type {} from 'x'` 是本仓（以及宿主 SDK）拉 declaration merge 的唯一写法 | 批准 |
| A21 | 规则级排除 B22（`no-redeclare`）：21 条命中全是 `interface Config` + `const Config` 的声明合并，TS 自身已覆盖重复声明检测 | 批准 |
| A22 | 规则级豁免 B23（`no-unsafe-type-assertion` 仅在 `**/test/**`、`**/*.test.*`、`**/*.spec.*`、`**/smoke.mjs`、`packages/*/scripts/**` 关闭）；同时新增 `check:suppressions` 门禁：内联抑制必须逐条登记在本文件 §6，未登记或已消失都会失败 | 批准 |
| A23 | `auto-env/src/index.ts` 的 `mergeOverlay` 加一条带理由的 `no-unsafe-type-assertion` 抑制：SDK 的 `ShellExecSpec.env` 是 `Record<string, string>`，拼不出"unset"；子进程 seam 把 `undefined` 当 tombstone（`direnv export` 的 `null` 就靠它），类型上无第二种表达（模块增强不能改属性类型） | 批准 |
| A24 | `session-write-access/src/service.ts` 与 `handoff/src/preferences.ts` 的 `facility.get(...)` 复用路径各加一条带理由的 `no-unsafe-type-assertion` 抑制：SDK 的 `DomainFacility.get()` 按设计返回未类型化的 `DomainImpl`（d.ts 原文："Diagnostic surface; typed consumers hold the handle returned by open"），而 `open()` 对已打开的 domain 直接抛 `already-open`，热重载复用没有类型化入口 | 批准 |
| A25 | `auto-permit/src/evidence.ts`、`auto-continue/src/resume.ts`、`auto-continue/src/restart.ts` 三处加带理由的 `no-deprecated` 抑制：`Session` 上三个同步日志读（`snapshotEvents` / `ownEvents` / `eventAt`）在 dsh-session 0.2.2-rc.1 全部标记 deprecated，而官方替代 `ctx.sessionQuery.readSession()` 是异步且是可选服务——迁移会改变导出函数的同步契约（`collectEvidence`）与恢复逻辑的控制流/延迟，属于 API 迁移而非 lint 修复 | 批准（迁移记为后续项） |
| A26 | `triggers/src/client/index.tsx` 的取消按钮加一条带理由的 `no-alert` 抑制：`window.confirm` 的阻塞确认就是取消门本身，换成应用内对话框会改变可观察的取消流程（A19 已授权的类别） | 批准 |
| A27 | 同一文件 `props.useSessions(...)` 加一条带理由的 `react/hooks` 抑制：该 hook 由宿主 slot 以 prop 传入，是宿主 store 的模块级函数，跨渲染同一（`client.test.mjs` 用同一 prop 形态验证），规则无法静态证明 | 批准 |
| A28 | `crew/src/index.ts` 的 `ContentBlock[] → JsonValue[]` 加一条带理由的 `no-unsafe-type-assertion` 抑制：工具 output schema 推断出 `JsonValue[]`，而 SDK 的 block 接口是结构上可 JSON 但不带 index signature 的 interface，二者无公开转换器可桥接（深拷贝会改变非 JSON block 的运行期行为） | 批准 |

若希望更严：`require-unicode-regexp`（228）、`prefer-strict-equal` 与
`prefer-to-be-truthy/falsy`（vitest 风格，606）、`strict-boolean-expressions`（B2）
都可以改为保留，代价是相应存量必须一起改。

## 7. 未验证 / 缺口

- 统一入口已实现：`pnpm check:quality` 按固定顺序跑 11 步（见 [quality-acceptance-inventory.md](quality-acceptance-inventory.md) 第 5 节），当前 8 步绿、2 步红（lint、dead-code）。
- CI 已真实运行（`.github/workflows/quality.yml`，node 24 + pnpm 12.3.4 + 安装 jj + fish + `pnpm check:quality`）：2026-11-16 的两次 push 运行（run `43815905270`、`43824255641`）都只失败在 `pnpm check:quality` 内，日志确认三件事——lint 是主因（1515 条），`packages/handoff` 的 review-integration 用例在 CI 上读到尚未写完的 `.meta.json`（时序竞态，本地不复现），`packages/remote-exec/smoke.mjs` 的 Part 8 需要真实 `fish`（runner 镜像没有）。后两者已修（测试改为 `until(...)` 重试；smoke 在缺少 fish 时打印理由跳过，workflow 则安装 fish 保留覆盖）。分支保护／必需检查属于仓库设置，需维护者单独开启。
- 现有测试/smoke 的真实范围已逐项实测并列在 [quality-acceptance-inventory.md](quality-acceptance-inventory.md)：`pnpm test` 只覆盖声明了 `test` 的 12 个包（9 个包没有测试入口），12 个 smoke 脚本现在由 `pnpm check:smoke` 统一执行（10 个可无人值守、2 个显式排除并打印理由），`notice-order.mjs` 未被 Vitest 收集。接线在“验收聚合”层处理。
- `context-audit` smoke 读取 `$DSH_HOME` 真会话日志（本次实测扫了 62 个日志），需在聚合时改为 fixture 隔离，不能直接进门禁。
- Node 20 产物兼容性尚未验证（本次只跑 Node 24 的 typecheck/build/lint）。
- 需要 profile/凭据/交互的验证（如 session-write-access 的手工 recipe）不在脚本覆盖内。
- **已知工具误报 1 处**：`typescript/await-thenable` 对 `for (const x of await llm.listModels(…))` 报“await 非 Promise”，但 `tsc` 明确该调用返回 `Promise<…>`（删掉 `await` 会报 TS2488）。这是 tsgolint 在 for-of 头部解析上的缺陷，需要一条带理由的抑制（加入待批准项）。
- 纯排版层已落地：228 个文件、+13479/-5137 行；`format:check` 现在通过。详见 5.2。

## 8. 当前状态

截至 2026-11-16 本次实测（`pnpm check:quality`）：

| 步骤 | 状态 |
| --- | --- |
| format / suppressions / lint / dead-code / types / build / tests / smoke / client / pack / storybook | ✅ **11 步全绿** |
| lint | ✅ **0**（接入时 2173；清零过程中只新增了 §6 里逐条记录的 B19/B21/B22/B23 与 A23–A28） |
| dead-code | ✅ 0 error（Fallow 仍以 `●` 报告 30 条 unused devDependency + 5 条 duplicate export alias，两者都是非阻塞类别） |
| 远端 CI | ⏳ workflow 已按两次真实运行的失败修正（缺 `jj`、缺 `fish`、handoff 测试的 meta.json 竞态），**本地入口已全绿**；推送后由 GitHub Actions 复验，分支保护仍未设置 |

清零的三个来源，按条数排序：类型逃逸（`no-unsafe-type-assertion` 623 中的生产部分逐处换成守卫/判别式，
测试双那部分按 B23 豁免）、`require-unicode-regexp` 逐条加 `u` 并改写 u 模式非法转义、
`no-non-null-assertion` 逐处给出存在性证据（`expect(...)` + `if (x === undefined) throw` 或 `requireFound` 助手）。
结构性重复也一并收掉：`isRecord` / `record.ts` 守卫在多个包内只留一份，`interface Config` + `const Config`
的声明合并按 B22 不再改名。

需要用户确认的完整清单就是第 6 节的 A1–A28 与 3.4-B 的 B1–B23。
与规则无关的清理（死模块、重复契约、循环依赖、无用导出、未声明依赖、游离 smoke 接线、排版）
已经全部落地。

## 8.1 后续分层

1. **本层（当前）**：工具 + 配置 + 扫描 + 本文批准清单。
2. ~~纯排版层~~（已完成）：228 个文件单独一层，未夹带语义修复；`typecheck`/`build`/`test`/`check:smoke`/`check:client`/`check:pack`/`build:storybook` 全部通过。
3. 类型与语义修复层：先机械类（import/模板/无用导出），再类型逃生口（683 条，逐处判定契约），最后语义类（浮空 Promise、`consistent-return` 等，涉及行为时先问）。
4. Fallow 清理层：只剩 3 个类成员（2 个需要内联抑制、1 个公开 getter 需 API 取舍）；其余类别已清零。
5. 统一入口层：把 `format:check`、`lint`、`fallow`、现有测试/smoke、`check:pack`、Storybook build 聚合进 `pnpm check`；skip 必须可见且不能替代必需项。
6. CI 层：GitHub Actions 复用同一入口；远端成功记录与平台保护设置分开报告。
7. 升级流程：每次升 oxlint/oxfmt/fallow，列出新增规则 → 已启用/不适用/待决定，并记录默认值与行为变化。
