# 既有验收检查清单

本文件回答一个具体问题：**仓库现在到底有哪些检查、怎么跑、今天能不能通过**。
它是“统一验收入口”这一步的输入，不是新的约定；规则基线见 [quality-gates.md](quality-gates.md)。

实测环境：Node 24.21.0、pnpm 12.3.4、Linux（NixOS）、`jj`/`fish`/`git` 可用，2026-11-16。

## 1. 汇总

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型 | `pnpm typecheck` | ✅ 21 包全过（`tsc -p tsconfig.json` + 双半包 `-p tsconfig.client.json`） |
| 宿主构建 | `pnpm build` | ✅ 20 个 bundle 产出 `lib/index.js` + `lib/index.d.ts` |
| 客户端产物 | `pnpm check:client` | ✅ 8 个 `lib/client.js` |
| 发布内容 | `pnpm check:pack` | ✅ 20 个 bundle 的 pack 内容 |
| Storybook | `pnpm build:storybook` | ✅ 构建成功 |
| 测试 | `pnpm test` | ✅ 12 个包；51 个 vitest 文件 + handoff 的 18 个 `node:test` 用例 |
| smoke | `pnpm check:smoke`，12 个脚本 | ✅ 11 个自动执行（含 fixture 化的 context-audit）、1 个因真实凭据显式排除 |

`pnpm check` = `typecheck` + `build` + `check:client`，不含 test / smoke / pack / Storybook。

## 2. 测试的真实覆盖

`pnpm -r run test` 只在**声明了 `test` 脚本**的包里执行，没有脚本的包被静默跳过——
这不是“全仓测试”。当前 12 个包有脚本：

```
auto-permit  cmd-permit  execution-guard  handoff  jj-workspace  recursive-skills
search-integrator  session-write-access  task-anchor  toolchain-access  triggers  ui
```

9 个包没有任何测试入口：`auto-continue`、`auto-env`、`context-audit`、`crew`、
`more-providers`、`oauth-providers`、`plan-usage`、`remote-exec`、`rtk-rewrite`
（其中多数只靠 `smoke.mjs`）。

原本未收集的测试文件现已接线：

- `packages/auto-permit/test/notice-order.mjs` 是带断言的复现 harness（PRE-FIX 路径必须
  违反 tool-call/result 配对，FIXED 路径必须不违反），但不在 `vitest run` 的收集范围内。
  已加进该包的 `test` 脚本（`vitest run && node test/notice-order.mjs`），不再是“存在但
  永不执行”的文件。

## 3. smoke 脚本（12 个，由 `pnpm check:smoke` 统一执行 11 个、显式排除 1 个）

| 脚本 | 结果 | 说明 |
| --- | --- | --- |
| `cmd-permit/smoke.mjs` | ✅ 0 | 纯匹配器 |
| `context-audit/smoke.mjs` | ✅ 0 | 已改为 **fixture 会话日志**（zstd 压缩的 `session.v1.jsonl.zstd` + projection cache 标题），默认不读 `$DSH_HOME`；`--real` 保留人工全量扫描 |
| `crew/smoke.mjs` | ✅ 0 | stub ctx |
| `jj-workspace/smoke.mjs` | ✅ 0 | 真 `jj` + 临时仓库；不跑远端 push |
| `more-providers/smoke.mjs` | ✅ 0 | 临时目录 + 注入 env |
| `plan-usage/smoke.mjs` | ✅ 0 | stub fetch |
| `remote-exec/smoke.mjs` | ✅ 0 | 只验证构造/解析，不建立 SSH |
| `rtk-rewrite/smoke.mjs` | ✅ 0 | 纯函数 |
| `auto-env/smoke.mjs` | ✅ 0 | 曾因 `Config` 默认值改为 `Volatile` 包装而 6 条断言失效；已改为读 `.get()` |
| `handoff/smoke.mjs` | ✅ 0 | 曾因 stub 缺 `agent.model` 而 `TypeError`；已按 `agent.model.current()`（pending → lastUsed → options）补桩 |
| `auto-continue/smoke.mjs` | ✅ 0 | 曾打印 `smoke OK` 后不退出（4 个未拆除 lifetime 的 retry timer）；脚本现在显式 `process.exit(0)`，未拆除的 lifetime 留给 vitest 覆盖 |
| `search-integrator/scripts/smoke-research.mjs` | ⚠️ 0 | 默认 `--providers`；无 API key 时无输出、空转成功，**不是真实检查**；有凭据时才打真实端点 |

此前三个脚本已随 SDK/配置演进而失效或根本不退出，已修复。现在由
`node scripts/check-smoke.mjs`（`pnpm check:smoke`）统一发现并串行执行：**不允许静默跳过**
——发现的脚本必须要么执行、要么在 `EXCLUDED` 里写明理由，理由指向的文件消失也会让运行失败。
当前 11 个执行、1 个显式排除（需真实凭据），整套约 15 秒。

Fallow 的入口来自 `package.json` 脚本与框架插件，不解析 `check-smoke.mjs` 的发现逻辑，
所以 smoke 与 `live-check.mjs` 在 `.fallowrc.jsonc` 里用 `supportEntry` 建模为开发入口；
剩余的 `unused-files` 只剩 4 个真正无引用的源文件。

## 4. 需要环境、凭据或交互，不能进自动门禁

- `smoke-research.mjs`：需要 `ZHIPU_API_KEY` / `EXA_API_KEY` 等 + 外网，属人工/按需验证。
- `session-write-access` 的真实 profile/交互 recipe（见包 README）不在任何脚本内。
- `dsh plugin add` / `--patch` 加载类验证一律由用户执行（宿主归 Nix 管）。

## 5. 统一入口（已实现）

`pnpm check:quality`（[scripts/check-quality.mjs](../scripts/check-quality.mjs)）按顺序跑 10 步，
默认**跑完全部再汇总**（`--fail-fast` 可改为首个失败即停，`--only=<step>` 只跑单步）：

| # | step | 命令 | 当前状态 |
| --- | --- | --- | --- |
| 1 | format | `format:check` | ✓ 228 个文件已排版 |
| 2 | lint | `lint` | ✗ 2086 条待修 |
| 3 | dead-code | `fallow` | ✗ 3 条 error 级 |
| 4 | types | `typecheck` | ✓ |
| 5 | build | `build` | ✓ |
| 6 | tests | `test` | ✓ |
| 7 | smoke | `check:smoke` | ✓ |
| 8 | client | `check:client` | ✓ |
| 9 | pack | `check:pack` | ✓ |
| 10 | storybook | `build:storybook` | ✓ |

顺序的理由：前三步不需要构建、最快失败；`build` 之后所有 `lib/` 消费者（测试、smoke、
client 检查）才有意义。`fallow health` / `fallow dupes` 不进这个入口，它们是报告，不是门禁。

`pnpm check`（typecheck + build + check:client）保留为旧的快速聚合，不删也不改名，
避免正在使用它的脚本（例如新增插件的流程）静默改变语义。

## 6. Node 20 兼容

构建 target 是 `node20`，但本机只有 Node 24，未实跑验证。

已做的静态扫描（源码 + `lib/` 产物，0 命中）：`Object.groupBy`、`Map.groupBy`、
`Promise.withResolvers`、`Array.fromAsync`、`toSorted`/`toReversed`/`toSpliced`、
`node:sqlite`、`fs.glob`、`process.loadEnvFile`、`import.meta.dirname`、`await using`。

这只是“没有明显越界 API”，不证明依赖与运行时行为兼容。要真正验证，需要把
`nodejs_20` 加进 flake（或临时 `nix shell nixpkgs#nodejs_20`）后跑：
`node -e "import('./packages/<name>/lib/index.js')"` 与能跑的 smoke。
本会话没有 Nix store 写权限，未执行。

## 7. 复现命令

```sh
pnpm check                 # typecheck + build + check:client
pnpm test                  # 12 个包
pnpm check:pack            # 20 个 bundle
pnpm build:storybook
for f in packages/*/smoke.mjs; do node "$f"; echo "$f => $?"; done
```
