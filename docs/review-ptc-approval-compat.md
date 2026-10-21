# 审查：审批 PTC 兼容（kwquspxq）

日期：2026-10-21。固定范围：研究基线 `mpslzsvq` → 实现层 `kwquspxq`；审查命令 `jj --no-pager --color=never diff --from mpslzsvq --to kwquspxq --git`。需求来源：[交接简报](../.dsh/handoff/20261021-151842-handoff.md) Key decisions 与验收测试。Standards 与 Spec 由独立代理并行检查，主代理复核源码、补充实验、独立重跑门禁。

**结论：核心实现符合预期，可接受主路径；没有阻塞性问题。保留一个非阻塞的防御性边界发现和一项依赖锁图变动提醒。**本轮未修改实现或宿主配置，未执行生产 Full access 审批，未 push。

## Standards

### 硬性规范违反：无

依据根 `AGENTS.md`、两包 README 与相邻测试约定：

- `@deepseek-ai/*` devDependencies 精确版本未变，hoisted linker 未动，未修改宿主或 profile。
- vitest 版本声明、per-package test script、`tsconfig` 包含 test、fake ctx/listener fixture 与已有测试包一致。
- direct/PTC 差异集中在 `auto-permit/src/evidence.ts`，cmd-permit 复用原 interface，没有复制生产 parser、另加授权框架或改判官/高危表/notice。
- 少量测试脚手架重复、`calls` 与 `conflicted` 成对传递、`const call = pending` 别名均属于可选整理，不值得为此次修复扩抽象。

### 非阻塞提醒：lockfile 不只是格式噪声

`pnpm-lock.yaml` 额外变动真实改变了依赖图：项目依赖段的 `zod@4.6.5` 被移除，16 个 snapshot 依赖引用改为已有 `4.4.3`，并新增/重整 DSH peer variants。用 YAML 多文档解析核对：

| 项目依赖段 | 基线 | 实现 |
|---|---:|---:|
| packages 数 | 302 | 301 |
| snapshots 数 | 302 | 319 |
| zod 4.6.5 的 packages / snapshots 条目 | 均存在 | 均移除 |
| 依赖 zod 4.6.5 的 snapshots | 16 | 0 |

因此“基线 zod 条目悬空”不能仅凭会话总结成立，也不能把所有变动称为必然、不可拆分的 peer 重排。引用 session 确实在安装阶段收到 `Broken lockfile: missing snapshot for vitest@3.2.7`，随后使用 `--fix-lockfile`；这能说明修复动机，但不能单独证明整张新图的必要性。

建议保留明确解释或进一步缩小/单列依赖整理。全仓门禁已对新图通过，**未发现这些变更引起运行故障**，本审查未安装或重算 lockfile。

## Spec

### 已落实的主路径

- 保留 `collectEvidence(session, callId)`；一次 snapshot、一个索引恢复 pending 与历史，保留 command/description/mode/justification。
- direct `tool/call.callId` + JSON 字符串，与 PTC **执行前** `tool/ptc-dispatch-start.subCallId` + 对象参数统一处理；不依赖 completion。
- 以精确调用 id 关联，覆盖 siblings、交错、嵌套；direct↔PTC 历史与 exactRepeat 互通，异 mode / 拒绝 / 取消 / 未决定不产生精确允许记忆。
- 新测试通过 `apply()` / `new CmdPermit()` 实际注册的监听器取证，包含白名单、判官输入完整性、高危和缺证据回退，不只是 parser 测试。
- 宿主 `dsh-tools/lib/index.js:1298–1305、1354–1363` 确认 start 在 prepare/dispatch 前持久化，subCallId 就是执行 callId。Inspect `approval/request` 确认为 waterfall，req.callId 为关联字段。

### [P2，非阻塞] 同 id 无效重复未使旧证据失效

位置：[evidence.ts](../packages/auto-permit/src/evidence.ts):123–139、156–165。

交接承诺“畸形、非 bash、标识冲突不能猜测允许”。当前只在**两条记录均能解析为 BashCall 且字段不同**时 poison id；`recordCall()` 对 undefined 直接返回，fold 对非 bash 直接 break，所以同 id 的第二条无效记录会留下第一条有效记录。

本轮纯内存导入当前编译产物，先为同 id 记录白名单 `cargo check`，再记录另一条事件，通过实际 CmdPermit 审批监听器验证（没有执行 shell）：

| 同 id 第二条记录 | 返回 | fallback |
|---|---|---|
| 不同的合法 bash `rm -rf /` | unavailable | true |
| bash，`command: 42` | allowed-once | false |
| 非 bash，`name: read` | allowed-once | false |

现有 tests 覆盖了单独的畸形/非 bash 和双方有效的冲突，没有覆盖上述组合；README / 调研文档“同 id 内容冲突一律丢弃”的表述略宽于实际实现。可选择让所有不一致重复（含不可解析/工具名变化）使 id 失效，或收紧文档并补负例。

**严重度边界：健康的钉版宿主按执行生成唯一 id，且执行前参数经过规范化/校验，未发现正常调用能够制造上述重复。它是异常审计日志下的防御契约缺口，不是已证实的生产越权漏洞，不阻塞正常 PTC 兼容。**当前与历史读同一索引，该边界对二者相同。

## 独立验证

- 新增两包测试：36/36。
- 全仓 `pnpm test`：241 项通过。
- 全仓 `pnpm check`：typecheck、build、client 6 文件语法检查通过。
- 两包 tsc 独立通过；cmd-permit smoke 17 项通过。
- `node packages/auto-permit/test/notice-order.mjs`：旧的 surface append 路径能复现配对错误；当前 inject 路径无配对违反，回归通过。
- 门禁使用单次 `env XDG_RUNTIME_DIR=/tmp`（本机 bwrap 私有 tmpfs）启动 pnpm，不改变项目/宿主配置；原因见 [pnpm 调研](research-dsh-sandbox-pnpm.md)。未运行新的依赖安装，构建仅更新 ignored lib 产物。
- 没有测试生产 profile 的真实审批，也没有重启或重挂。构建成功不等于已运行进程已加载新代码；原 session 已如实声明此边界。

**分轴汇总：Standards 0 项硬违反，1 项非阻塞依赖图提醒；Spec 主路径通过，1 项 P2 防御契约边界（非阻塞）。**
