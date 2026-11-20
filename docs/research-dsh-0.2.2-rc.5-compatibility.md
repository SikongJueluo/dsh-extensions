# 调研：DSH 0.2.2-rc.1 → 0.2.2-rc.5 插件兼容性

调研日期为 2026-11-20。本机 `web` profile 运行 DSH `0.2.2-rc.1`，通过 Nix 管理。检查范围包括本仓 19 个可安装 bundle、两个内部共享包、Nix 启动组合，以及当前 profile 中已识别的外部插件。基线与候选的对照使用 Node `24.22.2`、pnpm `12.3.4`。

**建议将当前 profile 保持在 `0.2.2-rc.1`，把 `0.2.2-rc.5` 作为迁移目标。** 按当前启动配置直接换版本，`jj-workspace` 的 patch 会阻止 profile 合成。处理该问题后，已有 `session-write-access` 产物仍会在 Web 渲染时调用已删除的 API。`crew` 与外部 SpineJIT 仍向子代理服务发送旧格式，需要同批适配。Nix 更新还需同步移除已被上游接管的 Inspector 补丁。

## 1. 目标版本与安装来源

截至调研日，npm 的 `latest` 和 `next` 均为 `0.2.2-rc.5`，`alpha` 为 `0.2.2-alpha.3`。GitHub 在 2026-11-18 发布了 `rc.5` 并标记为预发布，稳定 release 接口返回 404。`rc.2` 已移除本仓使用的 UI hook，也已变更 `SubagentActivationSpec`，所以切到中间 RC 也需要这两项迁移。判断 API 以精确版本的发布制品为准，部分升级指南的目录版本早于接口实际改动进入 npm 的版本。
[官方 npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh) · [GitHub 发布记录](https://github.com/deepseek-ai/deepseek-harness/releases) · [rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2) · [rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)

npm 制品可安装，隔离环境中的 `--version` 和 stock `web --dump-config` 均成功。本次安装检查发现 `koffi` 的原生安装脚本被包管理器的脚本允许列表跳过，因此依赖 `koffi` 的 fs-local、JSONL 持久化、subprocess-local 和 LibreOffice 路径未验证。本机的 nixpkgs Node 在启动原样 npm 制品时触发 `node-addon-require-builtin` 的 `Unsupported/no-getter`。隔离对照应用了 Nix 的 app-boot 替换与 `--expose-internals`，stock Web 进程随后打印了监听地址。该实验验证至进程启动，完整 Nix 构建、原生依赖路径及仓库插件的真实浏览器联调仍待验证。
[上游对照与复现记录](../.tmp/dsh-upgrade-audit-20261120/upstream.md#4-npm-制品是否可装可跑实测)

本机 flake 锁定的 `llm-agents` 修订提供 `rc.1`。调查时的 `llm-agents.nix` 修订提供 `rc.5` 并已加上 Inspector Worker 的 `--expose-internals` 补丁。Home Manager 里的本地 `overrideAttrs` 使用相同的 `--replace-fail 'execArgv: []'`。按上游打包顺序连续执行两次替换，第二次因找不到旧文本退出 1。更新输入时应同步移除本地重复的 override，保留上游 Nix 补丁，再独立构建 Nix 配置验证。裸 npm 制品仍含原始 Inspector Worker 配置。
[本机 flake 锁定](</home/sikongjueluo/.config/nixos/flake.lock#L1059>) · [本地 override](</home/sikongjueluo/.config/nixos/home/ai/dsh/default.nix#L47>) · [候选 Nix 包](https://github.com/numtide/llm-agents.nix/blob/3e6e622935b31f805b3ef893d71b97c1469965e1/packages/dsh/package.nix) · [上游补丁提交](https://github.com/numtide/llm-agents.nix/commit/83e1e9392cbcd5e22ae054e95743f9c4ead1c140)

## 2. 已定位的兼容冲突

| 影响 | 实测或制品证据 | 迁移时的验收条件 |
| --- | --- | --- |
| **Nix profile 合成** · `jj-workspace` | 用实际 Nix 启动器的 dry-run 对照两版，`rc.1` 成功，`rc.5` 报找不到 `forge-worktree` 和 `optional-forge-panel`。候选将 `forge-panel` 移到了顶层，由它消费顶层的 Worktree 服务。`WorktreeService` 配置另新增必填 `retainOnArchive`。 [现有 patch](../packages/jj-workspace/cordis.patch.yml#L7) · [类型错误](../.tmp/dsh-upgrade-audit-20261120/final-typecheck.log#L24) · [运行日志](../.tmp/dsh-upgrade-audit-20261120/compose-rc5.log) · [Forge 发布包](https://registry.npmjs.org/@deepseek-ai/dsh-experimental-forge-bundle/-/dsh-experimental-forge-bundle-0.2.2-rc.5.tgz) | 让 Forge 与工具通过同一顶层 JJ 服务，明确配置归档保留策略，用临时 JJ 和 Git 仓库验证创建、取消、归档和重开。上游在归档时默认会清理符合条件的干净 Git worktree，保留分支和提交。 [归档迁移指南](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/upgrade-guide/v0.2.2-rc.1/archive-worktrees/guide.zh.md) |
| **Web 渲染** · `session-write-access` 和共享 `ui` | `rc.5` 的 Web shell 保留 primitives 模块键，移除了 `useAnchoredPosition` 导出。插件在检查菜单开关之前调用这个 hook，页面初载也可触发。候选产物检查实际报 `TypeError`，独立地只去掉旧导出也复现相同错误。 [共享导出](../packages/ui/src/host/primitives.ts#L8) · [插件调用](../packages/session-write-access/src/client/index.tsx#L343) · [候选检查](../.tmp/dsh-upgrade-audit-20261120/final-client.log) · [Web 发布包](https://registry.npmjs.org/@deepseek-ai/dsh-web-frontend/-/dsh-web-frontend-0.2.2-rc.5.tgz) | 移除该 hook 依赖并使用候选支持的定位方式。检查页面初载、授权菜单、键盘焦点、移动端点按及真实批准和撤销。 |
| **子代理派发** · `crew`、外部 SpineJIT | 两个调用者都发送旧的 `{ request: … }`。候选接口将其字段摊平，真实服务直接读取 `spec.parent.id`，原调用会失败。`crew` 的候选类型检查报错，现有 mock 仍接受旧结构。 [crew 调用](../packages/crew/src/index.ts#L461) · [SpineJIT 调用](</home/sikongjueluo/Projects/spine-sdk-plugin/packages/dsh/src/spawn.ts#L138>) · [候选子代理包](https://registry.npmjs.org/@deepseek-ai/dsh-subagent/-/dsh-subagent-0.2.2-rc.5.tgz) | 两包一起迁移到候选接口，用真实宿主验证前台完成、后台通知、取消和父子关系。 |
| **LLM 错误契约** · `more-providers` | 候选 `new LlmError()` 的错误码参数为 `BuiltinLlmFailureCode`，ChatGPT adapter 和模型目录仍传自定义码。候选类型检查有四处错误，相关运行时错误分支尚待验证。 [adapter](../packages/more-providers/src/providers/chatgpt/adapter.ts#L539) · [模型目录](../packages/more-providers/src/providers/chatgpt/catalog.ts#L194) · [候选 LLM SDK](https://registry.npmjs.org/@deepseek-ai/dsh-llm/-/dsh-llm-0.2.2-rc.5.tgz) | 用候选 SDK 的失败分类和 `LlmError.fromFailure` 保留有意义的 provider 错误信息。验证 401、429、模型目录失败、取消和 `auto-continue` 的重试判定。 |
| **存储 schema 类型** · `handoff`、`session-write-access`、`triggers` | 三包的 Zod `4.4.3` schema 不满足候选 `dsh-storage-domain` 实际解析的 Zod `4.6.6` 类型，缺 `validate` / `validateAsync`。候选类型检查能稳定复现，旧记录读取和写回尚待验证。 [handoff](../packages/handoff/src/preferences.ts#L40) · [session-write-access](../packages/session-write-access/src/domain.ts#L76) · [triggers](../packages/triggers/src/model.ts#L17) · [候选类型日志](../.tmp/dsh-upgrade-audit-20261120/final-typecheck.log#L29) | 对齐 SDK 所用的 Zod 版本和 lockfile，拿隔离副本验证旧偏好、授权记录和触发器队列的加载与写回。 |

## 3. 全部 bundle 核查与联调标准

21 个 workspace 包中有 19 个可安装 bundle 和两个内部包 `config`、`ui`，其中 9 个 bundle 带 Web 客户端。当前 `web` 的 Host Inspector 可见 17 个 bundle 的配置行。`crew` 由 Nix 声明给特定 preset，本次 Inspector 查询未见其行。`auto-env` 没有独立配置行，当前 `rtk-rewrite` 仍继承它的执行器。下表覆盖仓库全部 19 个 bundle。

19 个 manifest 均通过 DSH 对 `rc.5` 的版本门槛。18 个 bundle 的 DSH peer 范围为 `^0.2.2-rc.1`，`plan-usage` 未声明 DSH 家族 peer。loader 使用 `includePrerelease: true`，范围匹配不会拦住上述 API 和配置冲突。候选 SDK 共 47 个精确钉版可解析，Cordis `4.1.0`、Schemastery `3.19.0` 与基线一致。
[仓库 SDK catalog](../pnpm-workspace.yaml#L32) · [上游版本门槛实现](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/packages/boot/app-boot/src/plugin-compatibility.ts)

| Bundle | `rc.5` 检查结果与实际联调标准 |
| --- | --- |
| [auto-continue](../packages/auto-continue/package.json) | 类型通过。公开的 `resolveAgent()` 仍在。用 429、中断、冷会话和归档跳过验证恢复，和 `more-providers`、`plan-usage` 连跑。 |
| [auto-env](../packages/auto-env/package.json) | 类型通过。Bash executor 入口仍在。单独挂载验证 direnv 的 set/unset、目录切换、超时和原有沙箱约束。 |
| [auto-permit](../packages/auto-permit/package.json) | 类型与客户端检查通过。联测审批链的允许、拒绝及转人工，并检查设置和模型目录。 |
| [cmd-permit](../packages/cmd-permit/package.json) | 类型通过。和 `auto-permit` 共存时，复验白名单命中、复合命令、拒绝以及审批只答复一次。 |
| [context-audit](../packages/context-audit/package.json) | 类型与客户端检查通过。候选仍枚举面板图标，但图标移入 `sidebar.panel.icon` factory。检查真实侧栏、面板路由与新旧 Session 日志。当前 standalone smoke 引用了已删除的 `oauth-providers` 包，干净工作树需先修该 fixture。 |
| [crew](../packages/crew/package.json) | 子代理调用形状不匹配。迁移后在实际配置的 preset 启动，验证前后台派发、取消、YAML 热加载及工具可见性。 |
| [execution-guard](../packages/execution-guard/package.json) | 类型通过。检查正常重复调用和受控循环拦截，覆盖动态工具清单、错误、取消及结果事件。 |
| [handoff](../packages/handoff/package.json) | 客户端检查通过，存储 schema 类型报错。测试 `/handoff` 跨工作区保留或切换模型、reasoning、preset，并重开验证旧偏好。 |
| [jj-workspace](../packages/jj-workspace/package.json) | 合成与 Host 类型检查失败。客户端离线检查通过，候选 `Menu` 和 Forge Remote 仍在。复验真实菜单、键盘返回、分支选择、Git fallback、归档及权限联动。 |
| [more-providers](../packages/more-providers/package.json) | Host 错误码类型报错，客户端检查通过，`llm-pi-ai` override 目标仍在。验证普通和流式对话、模型目录、取消、OAuth 刷新和图片附件。 |
| [plan-usage](../packages/plan-usage/package.json) | 类型与客户端检查通过。用无凭据及已配置场景验证配额路由、刷新、鉴权、缓存和恢复窗口。 |
| [recursive-skills](../packages/recursive-skills/package.json) | 类型通过。检查嵌套分类、重名优先级、修改后刷新和 watch 异常时的发现。 |
| [remote-exec](../packages/remote-exec/package.json) | 类型和候选 smoke 通过。基线 fixture 曾在状态读取/超时路径失败，不能据此判断宿主行为差异。仍需用本地 fixture 复验授权、定时、取消和失败分类。 |
| [rtk-rewrite](../packages/rtk-rewrite/package.json) | 类型通过。发布 patch 只禁用 `bash-sandbox`，开发 overlay 才额外禁用 `auto-env`。迁移时保证同一 scope 只有一个生效的 Bash executor，验证 RTK 开关、direnv 和退出语义。 |
| [search-integrator](../packages/search-integrator/package.json) | 类型通过，默认 `web_research` 与内置 `web_search` 名称不同。候选会根据当前模型选择内置搜索路由，显式配置保留。分别验证两工具可见、路由和凭据。真实搜索 smoke 需要测试凭据。 [官方搜索迁移说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/upgrade-guide/v0.2.2-rc.4/web-search-deepseek-model-default/guide.zh.md) |
| [session-write-access](../packages/session-write-access/package.json) | 存储 schema 类型和客户端渲染均失败。修复后检查 Bash/FS 权限一致、授权撤销、fork 隔离及跨重启持久化。 |
| [task-anchor](../packages/task-anchor/package.json) | 类型通过。用临时 JJ 工作区验证切层、目标 revision 冲突、恢复锚点与漂移提示。 |
| [toolchain-access](../packages/toolchain-access/package.json) | 类型通过，宿主的 `sandbox` override 目标仍在。用实际 bwrap 验证已授权目录、只读目录、额外写根以及 Bash/FS 的一致性。 |
| [triggers](../packages/triggers/package.json) | 存储 schema 类型报错，客户端离线检查通过。两版的清单均写成 `@deepseek-ai/dsh-client-ui-locale`，实际 Web 包是 `@deepseek-ai/dsh-client-locale`。修正清单后检查真实触发器标签页、execute/review 回路、重启和重复信号。 [客户端清单](../packages/triggers/package.json#L35) · [Web 发布包](https://registry.npmjs.org/@deepseek-ai/dsh-web-app/-/dsh-web-app-0.2.2-rc.5.tgz) |

仓库以外的 `dsh-mobile` 当前由 Nix 钉在 `0.8.0`，其 DSH peer 为 `*`。上游另有 `0.8.13`，现有发布信息不足以证明本机 `0.8.0` 与 `rc.5` 的行为兼容。升前要测试配对、重连、问题卡、触发器与插件同源路由。运行中的 SpineJIT `0.1.2` 已有上表所列子代理调用冲突，还需检查它的 Web primitives 兼容。MCP 行、Inspector 和其他官方组件应随生产组合做一次实际启动验证。候选还将 `dsh-experimental-agent-team-profile` 列为退役包，但本机 `plugins.nix` 未引用它，不构成当前配置冲突。
[本机 Mobile 打包](</home/sikongjueluo/.config/nixos/pkgs/dsh-plugins/mobile/package.nix#L23>) · [Mobile 上游发布](https://github.com/saya-ch/dsh-mobile/releases/tag/v0.8.13)

## 4. 验证记录

在隔离工作副本中仅改 47 个 DSH SDK catalog 钉版，重新解析依赖和 lockfile，清理继承的构建产物后测试候选。宿主组合用实际 Nix 启动器的 `DSH_COMPOSE_DRY_RUN`，fixture 保留 17 个声明加载的本仓 Host bundle、Forge、Inspector、Session Titles 及 4 个声明的 crew preset，从隔离 `DSH_HOME` 和 `XDG_RUNTIME_DIR` 运行。完整的第三方组合、用户数据与凭据未参与这次 dry-run。
[实际启动器](</home/sikongjueluo/.config/nixos/modules/home/dsh/compose.mjs#L779>) · [rc.1 fixture](../.tmp/dsh-upgrade-audit-20261120/compose-rc1.json) · [rc.5 fixture](../.tmp/dsh-upgrade-audit-20261120/compose-rc5.json)

| 检查 | 基线 `rc.1` | 候选 `rc.5` |
| --- | --- | --- |
| `pnpm -r --parallel --no-bail run typecheck` | 21/21 | 14/21，6 个 bundle 和共享 `ui` 失败。 [基线](../.tmp/dsh-upgrade-audit-20261120/baseline-typecheck.log) · [候选](../.tmp/dsh-upgrade-audit-20261120/final-typecheck.log) |
| `pnpm -r --no-bail run build` | 全通过 | 20/20 有构建脚本的包通过。 [候选](../.tmp/dsh-upgrade-audit-20261120/final-build.log) |
| `pnpm -r --parallel --no-bail run test` | 全通过 | 现有单测全通过。 [候选](../.tmp/dsh-upgrade-audit-20261120/final-test.log) |
| `pnpm check:client` | 9/9 | 8/9，`session-write-access` 的 `shell.overlay` 渲染出错。该检查用实际构建产物和模拟的 Slots/Remote。 [候选](../.tmp/dsh-upgrade-audit-20261120/final-client.log) |
| `pnpm check:smoke` | `jj-workspace` 通过。`remote-exec` fixture 失败一次。 | 9/11。`jj-workspace` 的 Git fallback fixture 提供了模拟 `Session`，被候选的 `appendPluginRecord` 拒绝，真实 Git fallback 待测。`context-audit` 缺失旧 `oauth-providers` 产物，基线副本留有旧构建文件。搜索集成的真实凭据场景按仓库规则另行排除。 [基线](../.tmp/dsh-upgrade-audit-20261120/baseline-smoke.log) · [候选](../.tmp/dsh-upgrade-audit-20261120/final-smoke.log) |
| Nix 启动器 `DSH_COMPOSE_DRY_RUN` | 退出 0 | 退出 1，`jj-workspace` 两个 patch 目标消失。 [基线](../.tmp/dsh-upgrade-audit-20261120/compose-rc1.log) · [候选](../.tmp/dsh-upgrade-audit-20261120/compose-rc5.log) |

以上日志和 fixture 位于本地忽略目录，可用于复核本次运行。真实候选浏览器、生产 Nix 构建、外部插件完整启用、旧会话数据以及 OAuth 等联网路径仍待联调。两次当前客户端 Slot Inspector 查询超时，客户端证据来自官方 Web 发布制品与离线复现。

## 5. 推荐迁移顺序

1. 在分开的 Nix 测试环境联动锁定 `rc.5` 与插件 SDK，移除重复的本地 Inspector 补丁，完整构建并确认 stock Web 与 Inspector 能启动。
2. 先修复 `jj-workspace` 合成和归档策略、`session-write-access` 的 Web hook、`crew` 与 SpineJIT 的派发契约，再完成 LLM 错误和 Zod 对齐。一起修掉 triggers 的客户端清单及 context-audit 的 smoke fixture。
3. 使用独立 `DSH_HOME`、会话/存储副本和测试凭据重跑上面的门禁与联调。候选须先合成成功，再在真实页面验证审批、写权限、归档/恢复、子代理与移动端核心路径。核查 Nix 构建和 Inspector Worker 后再更新生产 profile，保留 `rc.1` 的旧 generation 与数据快照以便回退。

## 6. 迁移结果（2026-11-20）

按上面的顺序完成了本仓范围的迁移，逐项契约与验证证据见
[rc.5 迁移记录](dsh-0.2.2-rc.5-migration.md)。要点：

- 47 个 DSH 钉版升到 `0.2.2-rc.5`，19 个 bundle 的 peer 改为 `^0.2.2-rc.5`；`zod` 在三处存储
  schema 包对齐到宿主实际使用的 `4.6.6`。
- 五处真实契约冲突全部按新 API 修：`jj-workspace` 组合与 `retainOnArchive`、`crew` 扁平子代理
  请求、`more-providers` 的 `BuiltinLlmFailureCode`、`ui` 移除的 `useAnchoredPosition`、
  `triggers` 的 locale 包名。两个 smoke fixture 的缺陷单独修正，未作为兼容性修复汇报。
- 迁移后 `typecheck` 21/21、`build` 20/20、`test`、`check:client` 9/9、`check:smoke` 11/11
  全过，`lint`/`fallow`/注释/抑制门禁保持原有规则。
- 组合验证用 rc.5 的 `dsh-app-boot` 加载真实四层 profile，再用 Nix 启动器的
  `validateRootComposition` 复算：210 行、`worktree` 禁用、`forge-panel` 顶层、两条 jj 行插入；
  换回旧 patch 可复现本文第 2 节的两条报错。
- 真实 rc.5 制品（非 Nix 构建）已在隔离 `DSH_HOME` 下启动 `web` profile，本仓 18 个 bundle
  全部激活并监听；真实浏览器里的 CSS 锚定菜单、Nix 构建、归档清理与 Koffi 原生路径、
  凭据/MCP/mobile 场景仍未验证。Nix 侧（llm-agents 输入、Inspector 重复 patch、生产 profile）
  与外部 `spine-sdk-plugin` 属范围外，需要用户分别在 flake 与外部仓库落地。
