# dsh 0.2.2-rc.5 迁移记录

日期 2026-11-20。范围是本仓 19 个可安装 bundle 与 `config` / `ui` 两个内部包；宿主 `~/.dsh`、
Nix 组合、外部 `spine-sdk-plugin` 与 `dsh-mobile` 不在本次改动内。调研与逐包基线见
[兼容性调研](research-dsh-0.2.2-rc.5-compatibility.md)。

## 钉版与依赖

- `pnpm-workspace.yaml` 的 47 个 `@deepseek-ai/*` 钉版全部改为 `0.2.2-rc.5`；`cordis 4.1.0` 与
  `schemastery 3.19.0` 不变。
- 19 个 bundle 的 DSH 家族 `peerDependencies` 由 `^0.2.2-rc.1` 改为 `^0.2.2-rc.5`：迁移后的代码
  使用 rc.5 才有的契约（扁平子代理请求、`BuiltinLlmFailureCode`、`retainOnArchive`），对 rc.1
  宿主不再成立。
- `zod`：`dsh-storage-domain` 依赖 zod `4.6.6`，并在运行期对传入 schema 调用 `validate` /
  `validateAsync`。`handoff`、`session-write-access`、`triggers` 从 `4.4.3` 升到 `4.6.6`
  （peer `^4.6.6`、dev 精确 `4.6.6`），hoisted 布局下解析到同一副本。

## 契约变更与处理

| 位置 | rc.1 | rc.5 | 本仓处理 |
| --- | --- | --- | --- |
| `crew` 子代理派发 | `startActivation({ provider, label, request: { prompt, parent, agentOptions, maxDepth }, signal, delivery })` | `SubagentActivationSpec` 直接继承 `SubagentStartRequest`，字段摊平在 spec 上 | 请求对象改名 `startRequest` 并展开进 spec；smoke 断言 `request` 不存在、`prompt` / `parent` / `agentOptions` 在顶层 |
| `more-providers` LLM 错误码 | `LlmError` 构造函数接受任意字符串码 | 只接受 `BuiltinLlmFailureCode`（内置码或 `HTTP_<status>`） | `httpErrorCode()` 返回 `BuiltinLlmFailureCode`；三个自制 catalog 码改为 `DISCOVERY_FAILED`，与上游 pi-ai discovery 的分类一致；消息保留原有细节 |
| `jj-workspace` 组合 | Forge 把 `forge-worktree` 与 `forge-panel` 放进 `optional-forge-panel` 隔离组 | `forge-panel` 在顶层消费顶层 `worktrees`，组与第二个 worktree 行消失 | patch 只禁用 `worktree` / `tool-worktree` 并插入 `jj-worktree` / `jj-tool-worktree`；`dev.patch.yml` 同步；删掉 `jj-forge-worktree` 与 `statusChannel: false` 的第三实例 |
| `jj-workspace` 配置 | `WorktreeService` 配置无归档开关 | `Config` 新增必填 `retainOnArchive: Volatile<boolean>`，归档时回收干净 checkout | `Config` 增加同名字段（`false` 默认、`.volatile()`），整体传给内层 stock `WorktreeService`；README 说明它只作用于 Git fallback |
| 共享 `ui` primitives | 导出 `useAnchoredPosition` | 导出被删除，定位改用 CSS anchor positioning；新增 `useAnchoredMaxHeight` | `packages/ui/src/host/primitives.ts` 去掉该导出；`session-write-access` 菜单改由 `anchor-name` / `position-anchor` / `@position-try` 定位，去掉 JS 测量与内联 style |
| `triggers` 客户端清单 | `@deepseek-ai/dsh-client-ui-locale`（两版都不存在） | 官方包名是 `@deepseek-ai/dsh-client-locale` | 清单改为真实包名；rc.5 的 91 个 `dsh.client` 包里全部可解析 |
| `context-audit` smoke | 从已删除的 `oauth-providers/lib` 深导入 `serializeRequest` | — | 删掉这段属于 more-providers 的断言与导入；等价覆盖补成 `more-providers/test/serialize-affinity.test.ts` |
| `jj-workspace` smoke | 用字面量 `{ id }` 冒充 Session | `appendPluginRecord` 品牌校验真实 `Session` | fixture 改用 `Session.create(SessionId(...))`，Git fallback 路径真实走通 |

## 验证

全部用迁移后的 rc.5 依赖在本仓默认 workspace 执行。

| 检查 | 结果 |
| --- | --- |
| `pnpm -r --parallel --no-bail run typecheck` | 21/21 通过（迁移前 14/21） |
| `pnpm build` | 20/20 有构建脚本的包通过 |
| `pnpm -r run test` | 全部通过，含新增 `serialize-affinity.test.ts` |
| `pnpm check:client` | 9/9；`session-write-access` 的 `shell.overlay` 渲染不再报 `TypeError` |
| `pnpm check:smoke` | 11 个脚本全过，`smoke-research` 仍按批准排除 |
| `pnpm lint` / `check:suppressions` / `fallow` | 0 error；抑制登记 29 条全部已批准 |
| `pnpm check:comments` | 443 文件无违规 |
| `pnpm check:pack` / `build:storybook` | 通过 |

`session-write-access` 菜单的锚定间距在 Chromium 里单独量过：从 `lib/client.js` 抽出内联 CSS、以
`position: fixed` 的 trigger 复现，trigger 在页面下部时菜单底边比 trigger 顶边高 4px，贴近顶部时
翻到下方且间距同为 4px（修复前上方定位写成 `bottom: calc(anchor(top) - 4px)`，`bottom` 的锚点距离
方向相反，实测重叠 4px）。

`pnpm format:check` 只剩 `nixsearch.json` 一处差异：该文件是迁移前就在工作区、与本次改动无关的
401 响应转储，未触碰。

组合与真实宿主验证不使用 Nix 构建，而是取 rc.5 的 npm 制品：

- `@deepseek-ai/dsh-app-boot` 加载真实 profile（`dsh-base` → `dsh-web-app` →
  `dsh-experimental-forge-bundle` → `dsh-jj-workspace`），再用 Nix 启动器导出的
  `validateRootComposition` 复算 patch 树：210 行，`worktree` 为 `disabled`、`forge-panel`
  在顶层、`jj-worktree` / `jj-tool-worktree` 插入成功。把本包 patch 换回迁移前版本后同一条命令
  复现调研报告里的两条错误（`forge-worktree` 不存在、`optional-forge-panel` 匹配不到），说明通过
  结果确实来自 patch 修复而不是检查放宽。
- `dsh --profile web --dump-config`（rc.5 CLI）在隔离 `DSH_HOME` 下合成同一个 profile，输出里
  `worktree` / `tool-worktree` 为 `disabled: true`，forge 四行与两条 jj 行按顺序插入。
- 真实启动：隔离 `DSH_HOME` + `XDG_RUNTIME_DIR`，用 rc.5 制品（按 Nix 包的两处 `require-builtin`
  替换 + `--expose-internals`，因为本机 nixpkgs Node 的原生拦截路径不可用）启动 `web` profile，
  其中挂载 `dsh-base` + `dsh-web-app` + forge bundle + 本仓 18 个 bundle。进程打印
  `dsh web: http://127.0.0.1:...`，没有 plugin 激活失败；唯一的告警来自同时挂 `auto-env` 与
  `rtk-rewrite` 的合成 profile（两者都注册 `shell`，`rtk-rewrite` 的 dev overlay 本来就禁用
  `auto-env`，生产 profile 只挂后者），去掉多余的那一行后 18/18 全部激活。
客户端侧没有被 `tsc` 保护的部分逐项对过 rc.5 的发布包：

- `session-write-access` 依赖的 client 契约在两版之间只增加了字段：`ISessions.binding()`、
  `SessionBinding.session.projections.faceOf`、`SessionBinding.eventSource`、
  `WorkspaceSource.getSnapshot/subscribe` 与 `IWorkspaces.list` 均未改签名（`session.d.ts` 的
  `loadOlder` 与 `snapshot.d.ts` 的 `historyWasPartial` 等改动本包未使用）。
- 本仓用到的 9 个 slot id（`conversation.approval.card`、`conversation.hero.options`、
  `conversation.input.dock`、`conversation.input.left`、`conversation.session.header.utilities`、
  `conversation.view`、`settings.section`、`shell.overlay`、`sidebar.panellist`）在 rc.5 的客户端
  包里都还在；`forge-panel.worktree` cell 与 `forgePanel/branches|cancelWorktree|follow|requestWorktree`
  也仍在。
- `dsh.client.inject` 声明的 10 个客户端包名全部命中 rc.5 的 91 个 `dsh.client` 包；宿主服务名
  （62 个 `Context` 声明）与客户端服务名全部可解析。

## 未验证

- 真实浏览器：菜单定位现在依赖 CSS anchor positioning（Chromium 125+）。离线 `check:client` 用
  jsdom 渲染，不解析 `@position-try`，因此点击/翻转/移动端点按仍需在真实 Web shell 里复核。
- 真实 rc.5 宿主只验证到「全部 bundle 挂载成功并监听」：子代理前台/后台/取消、401/429 错误分类与
  `auto-continue` 重试、归档清理、Koffi 原生路径、凭据/MCP/mobile 场景仍只有类型、单测与组合层
  证据；Nix 构建的 dsh 未跑。
- Nix 侧：`llm-agents` 输入升级、Inspector 重复 patch 的移除、生产 profile 切换都需要用户改
  flake；步骤与验收点见 [Nix 升级计划](plan-dsh-0.2.2-rc.5-nix.md)，本仓不含相应改动。
- 外部 `spine-sdk-plugin` 仍在旧 `{ request }` 形状，需要它自己的迁移。
