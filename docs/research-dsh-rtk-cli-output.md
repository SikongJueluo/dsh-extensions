# 调研：rtk（CLI 输出简化）接入 DSH 的可行性与重复功能排查

> 结论先行：**DSH 没有与 rtk 重复的功能**——现有输出管理全部是「内容无关的字节/token 级截断」
> （尾部截断 + spill 文件、token 预算保留、压缩期修剪、LLM 摘要），没有 rtk 那种「按命令语义
> 重排输出」（git status 75-93%、jest 94-99% 这类规则式压缩）。两者互补。
> **DSH 留了插件 API，但恰好缺 rtk 最需要的那个口子**：输出侧改写是一等公民
> （`tools/post-execute` 可整体替换工具结果），而 rtk 的核心机制是**执行前命令改写**
> （`git status` → `rtk git status`），DSH 的 `tools/pre-execute` 设计上不支持入参改写，
> Claude Code hooks 桥也明确忽略 `updatedInput`。因此可行路径是：
> ① 零成本起步——提示词级 awareness 插件（rtk 官方对无 hook 宿主的标准做法）；
> ② 完整方案——`tools/execute` 包装器里 spawn `rtk rewrite`，改写后直调原 bash 定义的
> `execute`（timeout-policy 是同款先例，需原型验证两个契约细节）；
> ③ 远期——给 DSH 上游提「pre-execute 入参改写」或「hooks 桥支持 updatedInput」。

- 调研对象：DSH `0.2.0-rc.2`（本机 nix store；
  `/nix/store/0z3j9r5hc9vq2ifb29kcrbbxf4m2ik5q-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/`，
  内部包在其 `node_modules/@deepseek-ai/` 下，下称 `$DSH/<pkg>`）；
  rtk-ai/rtk `v0.51.0`（develop 分支，2026-10 读码 + 后台 agent 一手资料调研）。
- 需求来源：用户想把 [rtk-ai/rtk](https://github.com/rtk-ai/rtk) 装上并考虑做成 DSH 插件，
> 问两点：有无重复功能、DSH 有无接入 API。
- 方法：Host Inspect Service/Event 目录 → `$DSH` 源码逐包核对（tool-bash / bash-local /
  spill-policy / compaction-tool-result-pruner / tools / hooks-claude-code / shell-env）+
  rtk 官方文档/源码一手调研 + nixpkgs 打包核对。

## 1. rtk 是什么（一手资料摘要）

- 「Rust Token Killer」：单 Rust 二进制的**前缀式 CLI 代理**。宿主把命令改写成
  `rtk <cmd>` 执行，rtk 自己 `std::process::Command` 跑真命令 → 规则过滤（12 种确定性
  策略，无 LLM）→ 输出紧凑版；退出码透传。70+ 内置改写模式，覆盖 git/gh/cargo/jest/
  vitest/pytest/go test/docker/kubectl/aws/ls/tree 等 100+ 命令。
  来源：[README](https://raw.githubusercontent.com/rtk-ai/rtk/develop/README.md)、
  [ARCHITECTURE.md](https://raw.githubusercontent.com/rtk-ai/rtk/develop/docs/contributing/ARCHITECTURE.md)。
- 配套：SQLite 用量记账（`rtk gain`）、**recall**（截断/失败时存完整原始输出，模型可
  `rtk recall <hash>` 主动取回——对宿主零依赖）、TOML 过滤器 DSL、`rtk discover`。
- 对宿主的可编程接口（关键）：
  - `rtk rewrite <command>`：stdout 输出改写后命令（无改写则无输出）；退出码
    0=allow / 2=deny / 3=ask。OpenCode/OpenClaw/Hermes 的宿主插件都是 shell out 到它。
  - `rtk hook claude`：吃 Claude Code PreToolUse JSON（stdin）、吐同格式 JSON
    （`updatedInput.command`）。
  - 无 daemon、无 FFI——就是无状态子进程调用。来源：
    [hooks/README.md](https://raw.githubusercontent.com/rtk-ai/rtk/develop/hooks/README.md)。
- 成熟度：Apache-2.0（develop 分支 Cargo.toml；nixpkgs meta 标 MIT，疑似中途换 license，
  均为宽松协议不影响接入）、2026-01 创建、8.3 万 star、极活跃。
- 注意：rtk 只覆盖 **bash 工具路径**——宿主内置 read/grep 等工具不经它；官方对 Claude Code
  也是同样声明。

## 2. 重复功能排查：DSH 0.2.0-rc.2 现有输出管理栈

| 层 | 包（`$DSH/<pkg>`） | 行为 | 触发时机 | 语义感知？ |
|---|---|---|---|---|
| 执行器截断 | `dsh-bash-local` | 每流 `maxOutputBytes`（默认 64,000 B）尾部截断，溢出写 spill 文件并报路径 | 每条命令即时 | 否（纯字节） |
| 执行器环境 | `dsh-bash-local` | 默认 `NO_COLOR=1 TERM=dumb PAGER=cat GIT_PAGER=cat` | 每条命令 | 否（已消除 ANSI/pager 噪音——rtk 进度条剥离的价值在 DSH 上部分重叠） |
| 结果保留 | `dsh-spill-policy`（自选挂载） | 共享 token 预算内保序 head/tail + 完整结果落盘 + 恢复提示 | 每次 post-execute | 否（token 估算） |
| 压缩修剪 | `dsh-compaction-tool-result-pruner`（web 预设默认挂载，见 `$DSH/dsh-web-app/presets/standard.patch.yml` L74-75） | >8,192 字符的结果换成 head 4,096 + 标记 + tail 1,024 | 仅压缩触发后 | 否（字符数） |
| 压缩摘要 | `dsh-compaction-basic`（默认挂载） | LLM 摘要整段历史 | token 压力达标 | 是（LLM，事后、整段） |

**结论：无重复。** 全栈都是「事后、内容无关」的截断/保留/摘要；没有一条路径理解
「这是 git status / jest 输出」并按命令语义重排。rtk 的价值恰好填这个空：**执行时、
确定性、按命令**。且组合良好——rtk 先把 60-99% 字节压掉，spill/pruner/compaction 的
触发概率随之下降。

## 3. DSH 接入面盘点（都有 API，位置决定怎么用）

工具管线（`$DSH/dsh-tools/lib/types/index.d.ts`；README L105 的固定流水线）：

```text
tools/pre-execute（waterfall：allow/deny/ask，不支持改写入参）
  → 单调 guards（ctx.tools.guard）
  → tools/execute（waterfall：环绕分发，可换 signal、可替换返回结果）
  → tools/post-execute（waterfall：accept+content 整体替换结果 / block / 附加上下文）
  → 定义自有 finalizeContent
  → tools/result（只读观察）
```

| 挂点 | 契约 | 对 rtk 的用处 |
|---|---|---|
| `tools/post-execute` | `PostToolDecision = { kind:'accept', content?: ContentBlock[] } \| …`；`exec` 带只读 `name`/`arguments` | **输出侧改写的一等公民**（`dsh-spill-policy` 就住在里面）。但 rtk 不是输出过滤器——它必须自己执行命令才能过滤，已捕获的输出无法事后喂给 rtk。**用不上** |
| `tools/execute` | 包装器可替换整个返回结果（`$DSH/dsh-tool-call-timeout-policy` 先例：`ctx.on("tools/execute")` 里换 signal、返回自制超时结果） | ~~完整方案的落点~~ **已被证伪为首选**：读 `$DSH/dsh-tools/lib/index.js` L3294-3319 可知 `dispatchToolBody` 直接把 deep-frozen 的 `exec.arguments` 喂给 `tool.execute`（返回**原始 value**，由 registry 内部做 schema 校验 + `output.render` 规范化）——包装器想替换命令就得自建合成 exec 并**复刻 registry 规范化**，契约外且脆 |
| `tools/pre-execute` | d.ts 注释原话："Input rewriting is excluded because arguments are already logged and presented" | **死路**（设计排除） |
| `tools/ptc-dispatch-log` | 改写 run_code 子调用的持久日志副本 | PTC 模式（`mode:'ptc'`）下的补充挂点，同思路可用 |
| `ctx.shell`（`$DSH/dsh-shell`，`dsh-bash-local`/`dsh-bash-sandbox` 实现） | bash 执行器 seam：`resolve`/`execute`/`sandboxMode`；auto-env 证明该行可**替换继承**并在 `execute()` 里调整 spec | **实际落点**：`RtkBashExecutor extends AutoEnvBashExecutor`，宿主侧查 `rtk rewrite` 后换 `spec.command` 再 `super.execute`——jobs/升权/截断/spill 全部原样（见 [packages/rtk-rewrite](../packages/rtk-rewrite/)） |
| `ctx.shellEnv`（`dsh-shell-env`） | 只允许声明 `DSH_*` 键 | 不能塞 PATH shim——PATH 劫持路线被设计排除 |
| `ctx.systemPrompt.section` | 提示词分节注册 | **awareness 路线的落点**（教模型自己加 rtk 前缀） |
| `dsh-hooks-claude-code` | 跑现成 Claude Code hooks.json；`$DSH/dsh-hooks-claude-code/lib/index.js` L109/L189：`updatedInput` **"logged and warned but not honored"** | **死路**（今天就装 `rtk init -g` 也不会改写命令，只会白跑 hook 并打 warning） |

## 4. 方案对比

| 方案 | 做法 | 工作量 | 风险/限制 |
|---|---|---|---|
| **A. awareness 提示词插件** | 小插件注册 system-prompt 分节 +（可选）装 rtk 的 RTK.md 要点：长输出命令优先 `rtk <cmd>`，截断时 `rtk recall` | 极小（半天） | 非强制，模型可能忘；rtk 官方对无 hook 宿主（Windsurf/Cline/Kimi）就是这做法；执行器方案落地后不再需要 |
| ~~B. `tools/execute` 改写包装器~~（原完整形态，**已弃**） | `ctx.on('tools/execute')` 拦 `bash` 后合成 exec 直调原定义 `execute` | 中 | 实现前读码证伪：`tool.execute` 返回**原始 value**，规范化（schema 校验 + `output.render`）是 registry 内部逻辑，包装器得复刻它——契约外且脆。改用 E |
| C. 影子 bash 工具 | 会话作用域注册同名 `bash` 遮蔽全局，内部改写后走 `ctx.shell` | 大 | 要复刻 jobs 提升/沙箱升权提示/presentCall 等一整层；最不划算 |
| D. 上游增强 | 给 `tools/pre-execute` 加受信改写决策，或让 `dsh-hooks-claude-code` 真正 honor `updatedInput`（源码注释自己承认是缺口） | 上游 PR | dsh 归 nix 管，要等发版；hooks 桥一旦支持，`rtk hook claude` 可直接复用 |
| **E. `ctx.shell` 执行器改写**（**已实现**：[packages/rtk-rewrite](../packages/rtk-rewrite/)） | `RtkBashExecutor extends AutoEnvBashExecutor`（auto-env 确立的行替换继承模式）：`execute()` 里宿主侧 spawn `rtk rewrite <command>`，stdout 非空单行则换 `spec.command` 再 `super.execute`；命令串 memo（256 LRU） | 小（半天） | ① 改写后的命令进沙箱跑（实测 rtk 0.49.0 tracking 写入被拒时静默降级，无 stderr 噪音）；② patch 行整体替换——profile 给 auto-env 行设过的键要在 rtk 行重述；③ **判定只看 stdout 不看退出码**（实测 0.49.0 成功改写 rc=3、无等价 rc=1，与其文档 0/2/3 不符，stdout 是唯一稳定契约） |

组合注意：E 的改写发生在执行器内，早于 post-execute——`dsh-spill-policy`（自述
"prepended listener delegates before bounding"）与 `auto-permit`（本仓）看到的分别是
「已压缩的输出」和「原始入参」，顺序天然正确。

### 4.1 与本仓 auto-env（既有 bash 层插件）的组合分析

auto-env 是本仓唯一动 bash 执行链的插件，但它**不改命令字符串**：`AutoEnvBashExecutor
extends SandboxBashExecutor` 替换 `ctx.shell` 执行器行，在 `execute(spec)` 里把 direnv
overlay 叠进 `spec.env`（`packages/auto-env/src/index.ts` L160-183）；`tools/pre-execute`
只是预热 gate。方案 E 直接**继承它**而非并列：


```text
bash(command="git status")
 → tools/pre-execute   auto-env 预热 direnv（gate，不改入参）
 → 工具层（审批/升权/jobs 原样，看到的是原命令）
 → ctx.shell.execute = RtkBashExecutor
       ① 宿主侧 rtk rewrite 查询（沙箱外，~10ms，memo）
       ② spec.command → "rtk git status"
       ③ super.execute = AutoEnvBashExecutor → direnv 叠加 → 沙箱 → spawn
 → tools/post-execute  spill-policy（对已压缩输出做预算）
```

`rtk git status` 会在 devenv 环境里跑（rtk 用 `std::process::Command` 跑真 git，继承
叠加后 env）。两个注意点（已实测/已处理）：

1. **rtk 写路径 vs 模型沙箱**（实测 2026-10-11，rtk 0.49.0）：沙箱内 `rtk git status`
   正常输出紧凑结果、rc=0、tracking DB 写入被拒时**静默降级无噪音**。要完整
   recall/tracking，把 rtk `config.toml` 的 `[tracking]`/`[retriever]` 落盘路径指到
   工作区内。
2. **`rtk rewrite` 子进程走宿主侧 `ctx.subprocess`**（auto-env 跑 `direnv export`
   同款），已按此实现；执行器层也没有 timeout-policy 包装先后的问题（那是
   `tools/execute` 层的事，方案 E 不经过）。

> **已实现**：[packages/rtk-rewrite](../packages/rtk-rewrite/)（2026-10-11）。
> 装进 profile 后建议在 devenv 项目里抽查一条 `rtk <cmd>` 是否拿到叠加环境。

### 4.2 按命令放行：`cmd-permit` 插件设计（与 rtk-rewrite 分开的小插件）

> **已实现**：[packages/cmd-permit](../packages/cmd-permit/)（2026-10-11），
> 高危形状规则同步拆入（内置不可逆表仍源自 auto-permit 的 `isHighRisk`，用户
> `denyShape` 在本插件追加，经 `ctx.cmdPermit` 服务暴露；auto-permit 判官已改为
> 优先咨询该 oracle，两条路径对同一批形状让路）。本节保留设计记录。

需求：`rtk`/`cargo`/`direnv` 这类高频命令别每次撞沙箱都要人批。DSH 的官方挂点是
`approval/request` waterfall——`dsh-user-approval` 定义的 answerer 链，插件可以
`ctx.on('approval/request', handler, /* prepend */ true)` 插队（本仓 auto-permit 先例，
packages/auto-permit/src/index.ts L80-146）。沙箱升权（bash 工具被拒后带
`sandbox_permissions` 的重试）正是走这条链要审批的。

工作流（v1，零契约外用法）：

```text
cargo build → 沙箱拒（写 ~/.cargo）→ 模型带 sandbox_permissions 重试（同轮一次）
  → approval/request（toolName=bash, callId）
  → cmd-permit（白名单 answerer，prepend 在 auto-permit 之前）
      按 callId 从 session log 取命令与请求的 mode（auto-permit 的 collectEvidence
      已 fold 出 ParsedBashCall{command, sandboxPermissions}，可直接复用/peer 依赖）
      ① isHighRisk 形状（auto-permit 导出）→ next() 交人工
      ② 复合命令安全：按 && || ; | 切段，每段都必须命中白名单（rtk registry.rs 先例）
      ③ 命中且请求的 mode ≤ config.maxMode → 会话 notice 行 + return 'allowed-once'
      ④ 未命中 → next() → auto-permit 的 LLM judge → 人工
```

要点：

- **绝不 `rejected`**：与 auto-permit 同原则——插件不能冒充用户的「否」，fail-open
  方向是交人工。
- **行序决定 answerer 顺序**：两个插件都 prepend 时，后挂的行在链头；cmd-permit 行放
  auto-permit 之后即先于 LLM judge 运行（白名单命中连 judge 调用都省了）。cmd-permit
  必须自带 isHighRisk 检查（它先于 auto-permit 拿到请求）。
- **Config（行 schema，settings UI 自动出表单）**：`allow: string[]`（前缀或 `^…`
  正则）、`denyShape: string[]`（额外强制人工形状）、`maxMode`（默认
  `danger-full-access`；`workspace-write` 则只自动放到工作区档）。
- 剩余成本：每个新命令形状仍有一次「被拒→重试」的往返（官方语义是先真实被拒才准升权）。
  auto-permit 的 exact-repeat 记忆 + cmd-permit 前缀匹配让后续全免。想连这次往返也省，
  得在 `tools/execute` 里给白名单命令预注入 `sandbox_permissions`（rtk-rewrite 同款
  合成 exec 手法，契约外，v2 再说）。
- rtk 本身若按 §4.1 把 DB 指进工作区，根本不需要升权——白名单主要收益者是
  cargo/direnv/gh 这类要写家目录的。


## 5. 安装（NixOS，声明式）

- nixpkgs 已有 `pkgs.rtk` = rtk-ai/rtk（by-name/rt/rtk，[package.nix](https://raw.githubusercontent.com/NixOS/nixpkgs/b3da656039dc7a6240f27b2ef8cc6a3ef3bccae7/pkgs/by-name/rt/rtk/package.nix)），
  该 revision 钉 0.38.0，落后上游 v0.51.0（2026-10-02）；进 flake 前确认 unstable 里的版本可接受。
  crates.io 上 `rtk` 是撞名的 Rust Type Kit，`cargo install` 必须 `--git`。
- 插件配置（`config.toml`）只影响 rtk 自身（limits/tracking/hooks 排除清单）；DSH 侧不装
  rtk 的任何 hook（`rtk init` 跳过，hook 由 DSH 插件自己当）。

## 6. 建议路线（进度）

三个互相独立的小插件，各管一层，不塞一个包里：

1. ~~`packages/rtk-rewrite`（方案 B：tools/execute 包装器）~~ → **已按方案 E 实现**
   （[packages/rtk-rewrite](../packages/rtk-rewrite/)）：`RtkBashExecutor extends
   AutoEnvBashExecutor`，宿主侧 `rtk rewrite` 查询（stdout 判定、LRU memo）后换
   `spec.command`；auto-env 为此导出了 `configFields` 供 schema 继承。
2. **`packages/cmd-permit`**（§4.2）：**已实现**——白名单 answerer + 共享高危 oracle，
   auto-permit 判官优先咨询 `ctx.cmdPermit`。
3. **宿主侧 runnerCommand wrapper**（plan 文档，nix 落点）：ssh 修复 + 常用缓存
   （`~/.cargo`、`~/.cache` 等只读或可写 bind）——读类撞墙一次修永久，见
   [plan-dsh-sandbox-ssh-fix.md](plan-dsh-sandbox-ssh-fix.md) 的扩展方向。**未做**。

rtk 已进 nix profile（本机 0.49.0，nixpkgs 0.38.0 落后上游）；顺手向上游反馈
`updatedInput` 缺口（`dsh-hooks-claude-code` 源码注释已自认），若上游实现则
rtk-rewrite 可整体退役换成 hooks 桥直跑 `rtk hook claude`。

## 来源

- DSH 0.2.0-rc.2 本机源码：`$DSH/dsh-tools`（管线契约）、`$DSH/dsh-tool-bash` + `dsh-bash-local`
  （截断/环境默认）、`$DSH/dsh-spill-policy`、`$DSH/dsh-compaction-tool-result-pruner`、
  `$DSH/dsh-hooks-claude-code`（updatedInput 忽略）、`$DSH/dsh-tool-call-timeout-policy`
  （execute 包装先例）、`$DSH/dsh-shell{,-env}`、`$DSH/dsh-web-app/presets/standard.patch.yml`。
- rtk 一手：[README](https://raw.githubusercontent.com/rtk-ai/rtk/develop/README.md) ·
  [ARCHITECTURE](https://raw.githubusercontent.com/rtk-ai/rtk/develop/docs/contributing/ARCHITECTURE.md) ·
  [hooks/README（各宿主 JSON 协议）](https://raw.githubusercontent.com/rtk-ai/rtk/develop/hooks/README.md) ·
  [src/core/README（DSL 与 limits）](https://raw.githubusercontent.com/rtk-ai/rtk/develop/src/core/README.md) ·
  [savings-explained](https://raw.githubusercontent.com/rtk-ai/rtk/develop/docs/guide/resources/savings-explained.md) ·
  [what-rtk-covers（每命令削减率）](https://raw.githubusercontent.com/rtk-ai/rtk/develop/docs/guide/resources/what-rtk-covers.md) ·
  [releases API](https://api.github.com/repos/rtk-ai/rtk/releases/latest)（v0.51.0）。
- nixpkgs：[`pkgs/by-name/rt/rtk/package.nix`](https://raw.githubusercontent.com/NixOS/nixpkgs/b3da656039dc7a6240f27b2ef8cc6a3ef3bccae7/pkgs/by-name/rt/rtk/package.nix)（0.38.0，wrapped with gitMinimal）。
