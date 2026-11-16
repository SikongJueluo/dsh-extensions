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
| smoke | 无统一入口，12 个脚本 | ✅ 12 个都退出 0；其中 1 个依赖真实凭据、1 个读真实 `$DSH_HOME`（见第 4 节） |

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

已知未收集的测试文件：

- `packages/auto-permit/test/notice-order.mjs`：不在 `vitest run` 的收集范围内，只能手动
  `node` 跑；Fallow 也把它报成“未被任何入口引用的文件”。聚合时要给它一个 `node --test`
  或显式命令，否则等于不存在。

## 3. smoke 脚本（12 个，全部没有接进任何 `package.json` 脚本）

| 脚本 | 结果 | 说明 |
| --- | --- | --- |
| `cmd-permit/smoke.mjs` | ✅ 0 | 纯匹配器 |
| `context-audit/smoke.mjs` | ✅ 0 | **读取真实 `$DSH_HOME`**：本次扫了 62 个日志、59 个会话才出结果 |
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

此前三个脚本已随 SDK/配置演进而失效或根本不退出，这一层已修复；它们仍然没有接进任何
`package.json` 脚本，所以依旧不会在 `pnpm test` / `pnpm check` 里自动执行。Fallow 的
“未被任何入口引用”仍是同一问题的另一面，接线放在聚合层。

## 4. 需要环境、凭据或交互，不能进自动门禁

- `smoke-research.mjs`：需要 `ZHIPU_API_KEY` / `EXA_API_KEY` 等 + 外网，属人工/按需验证。
- `context-audit/smoke.mjs`：依赖本机真实会话日志才能覆盖报告路径。自动门禁应注入 fixture
  `$DSH_HOME`；否则结果随用户机器变化，且会读取隐私数据。
- `session-write-access` 的真实 profile/交互 recipe（见包 README）不在任何脚本内。
- `dsh plugin add` / `--patch` 加载类验证一律由用户执行（宿主归 Nix 管）。

## 5. 建议的聚合顺序（草案，待批准）

1. `format:check` → `lint` → `fallow dead-code`（最快失败、无需构建）
2. `typecheck`
3. `build`（此后所有 `lib/` 消费者才有意义）
4. `pnpm -r run test`
5. smoke：先做外部程序预检（`jj`、`fish`、`mkfifo`、`tar`），缺一个就 **fail**，不 skip
6. `check:client` → `check:pack` → `build:storybook`
7. `fallow health` / `fallow dupes`：只输出报告，不影响退出码

聚合本身单独一层；smoke 的修复（第 3 节三个失败）与 `notice-order.mjs` 的接线也在那一层，
不要为了“能跑绿”把它们从门禁里删掉。

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
