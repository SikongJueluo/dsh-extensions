# dsh-recursive-skills

**让分类目录里的 skill 自动进入原生技能目录。** 原生 filesystem provider 有意只扫描技能根的
直接子项（`<root>/<skill>/SKILL.md`、`<root>/<skill>.md`），所以
`~/.agents/skills/anthropic/pdf/SKILL.md` 这类嵌套 bundle 永远不会被发现。本插件在原生
provider 旁边**追加**一个递归 provider：候选进入同一个 `ctx.skills` 注册表，因此沿用原生的
初始目录、替换目录、`skill` 工具与用户 `/name` 调用。**自动加载仍指“自动发现摘要、按需读取
正文”**，不会把嵌套 skill 全文预注入系统提示。

## 发现规则

```text
<root>/direct/SKILL.md              → 原生 provider 负责（本插件跳过）
<root>/flat.md                      → 原生 provider 负责（本插件忽略）
<root>/category/pdf/SKILL.md        → 本插件发现（depth 2）
<root>/category/sub/x/SKILL.md      → 本插件发现（depth 3，默认上限 4）
<root>/category/pdf/references/...  → 不导入：遇到 SKILL.md 即 bundle 边界
```

- **只补深层**：depth 1 的直接 skill 与根级 `.md` 仍归原生 provider；本插件只登记 depth ≥ 2
  的 bundle。这样不会产生重复候选，也不会改变已有直接 skill 的解析。
- **bundle 边界**：某目录含 `SKILL.md` 就停止下钻，不把 `references/`、`scripts/`、`assets/`
  里的 Markdown 当 skill。
- **符号链接**：遍历走 `ctx.fs`，按 target identity 去重；别名不会重复登记，环不会无限递归。
  Nix 链接进来的技能目录因此可用。遍历是**广度优先**：浅层真实路径先于深层别名，深别名不会
  占用真实目录的剩余深度预算，因此不会遮蔽合法技能。
- **名称与策略**：保留 frontmatter 的原始 `name`（不改成 `anthropic/pdf`）；必须是
  kebab-case。`description`、`whenToUse`、`metadata`、`disable-model-invocation`、
  `user-invocable` 的含义与原生解析一致。坏 YAML、缺字段、旧版 invocation 键会被忽略并告警，
  不影响同层其他技能。
- **同名**：同一 provider 内按“根配置顺序 → 目录名排序 → 先到先得”确定，并输出带双方路径的
  告警；跨 provider 由注册表按 rank 决定。默认 rank **501**，让原生 user-agents（500）优先，
  同时仍优先于 bundled（600）。
- **来源标签**：默认根（`<agentsHome>/skills`）标为 `user-agents`，`extraRoots` 标为 `custom`。

## 变动与失效

- 注册表没有 TTL，因此插件自己观察变化。它为每个扫描到的根/分类目录和每个发现的
  **bundle 目录**各开一个 `ctx.fs.watch`（`fs.watch` 只观察直接子项，不是递归 watcher）。
  观察 bundle 目录而不是 `SKILL.md` 目标，才能看到 `SKILL.md` 符号链接被重定向到另一个文件。
- 首次扫描后才知道要观察哪些目录，因此“扫描 → 建 watcher”之间存在盲窗。只要 `reconcile`
  新开了 watcher，插件会在观察就绪后**重新扫描**再返回；最多 3 轮，仍不稳定则返回 incomplete，
  不把可能漏事件的目录缓存下来。
- 后端在 watcher 初始化时按当时的路径状态固定观察模式（缺失路径观察父目录并过滤该路径；
  目录观察直接子项）。插件给每个 watcher 记录建立时的路径 version，`reconcile` 时重新探测：
  version 变化（缺失 → 目录、目录删除重建、直接子项增删）就替换该 watcher。缺失根出现后会
  升级为目录模式，之后新增分类仍能持续热发现，不需要重启或无关事件。
- 新增/删除分类或 skill、修改 `SKILL.md` 的 frontmatter，都会 `invalidate()` 当前注册，
  下一次目录读取重新扫描并校正 watcher 集合——**新增分类目录不需要重启**。
- 只改正文不替换目录：`get()` 每次重读文件，正文编辑在下一次加载时生效。
- 单个目录/文件读失败返回 **incomplete** observation，已读到的候选仍然保留，不会把一次 I/O
  故障误报成“所有嵌套技能被删除”。watcher 初始化失败只降级热刷新（告警），不影响发现。
- 卸载时关闭全部 watcher，并等待关闭完成；迟到的回调被忽略。

## 配置

行内 `config` 可省略，默认值如下：

| 字段 | 默认 | 含义 |
|---|---|---|
| `providerName` | `recursive-filesystem` | 注册表内唯一的 provider 名；不能是 `runtime` |
| `agentsHome` | `$DSH_AGENTS_HOME` 或 `~/.agents` | 共享 agent 配置根；扫描 `<agentsHome>/skills` |
| `extraRoots` | `[]` | 追加扫描根（完整技能根）；`~` 会展开，相对路径按宿主进程 cwd 解析 |
| `maxDepth` | `4` | bundle 目录的最大深度，根为 0；嵌套 bundle 至少为 2 |
| `rank` | `501` | 同层优先级，越小越优先 |
| `watch` | `true` | 观察扫描目录与 bundle 目录 |

示例（Nix 宿主声明，见 [接入计划](../../docs/plan-dsh-recursive-skills.md)）：

```nix
"recursive-skills" = {
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/recursive-skills/lib/index.js";
  host = true;
  config = {
    extraRoots = [ "/path/to/project/.agents/skills" ];
  };
};
```

## 安装

```sh
pnpm install && pnpm build

# 开发 overlay（不安装、立即生效；重启 dsh 进程后加载新构建）
dsh --profile web --patch $PWD/packages/recursive-skills/dev.patch.yml --no-open --port <端口>

# 或作为 bundle 安装（profile 可写时；本机 profile 由 Nix 管理，优先走宿主声明）
dsh plugin --profile <profile> add ./packages/recursive-skills
```

插件只依赖 `skills` 与 `fs` 服务，必须挂在 **Host** 平面；本包没有浏览器半插件。
`@deepseek-ai/*` 的 peer 依赖交给安装方解析，运行时 `yaml` 由包自身依赖提供。

## 验证

```sh
pnpm -C packages/recursive-skills test   # 28 tests
pnpm check                               # 全仓 typecheck + build + client syntax
```

测试覆盖：真实 `SkillRegistry` + `LocalFileSystem` 集成、与**已安装原生 provider 的逐字段
差分**、直接 skill 跳过、bundle 边界、坏 YAML/旧 invocation、同名确定性、`maxDepth`、
符号链接（外链/别名/环、`SKILL.md` 重定向与换名）、I/O 失败 incomplete、新增分类与描述变更的
热刷新、watcher 就绪前写入不被缓存吞掉、缺失根出现后连续新增分类、根删除重建、深别名不遮蔽
浅层真实技能、错误路径延迟关闭纳入卸载等待、正文重读、watcher 开闭配平。

只读扫描本机真实根 `~/.agents/skills`（2026-11-01）得到 **19 个嵌套候选**，与调研预期一致：
`academic-paper-review, algorithmic-art, canvas-design, docx, frontend-design,
github-deep-research, pdf, plannotator-compound, ppt-generation, pptx,
rsbuild-best-practices, rslib-best-practices, rspack-best-practices,
rspress-best-practices, rspress-custom-theme, rspress-description-generator,
rspress-docs-generator, rstest-best-practices, xlsx`。
`get('pdf')` 返回正文与 `resourceBase = ~/.agents/skills/anthropic/pdf`，`path` 指向 Nix
store 的真实文件。

经真实 Loader 的端到端验证：用工作区内的临时 `DSH_HOME` + `--from-default-profile headless`
+ `dev.patch.yml` 启动（模型凭据缺失，在请求阶段退出），session 日志的**初始技能目录**包含
18/19 个嵌套名称；唯一缺席的 `plannotator-compound` 带 `disable-model-invocation: true`，
被原生策略正确排除。说明 patch 装载、Config 默认值、目录合并与 invocation 语义均生效。
**未做** live Web 的目录替换/热刷新端到端验证：本机 profile 由 Nix 只读管理，需由用户落宿主
声明并重启后确认。

## 已知边界

- 需要 `ctx.fs`。遍历、读取走当前执行世界的 filesystem；`fs.watch` 不可用的远端后端只能保证
  首次发现，热刷新会降级为告警。
- 默认只扫描用户共享根；项目 `.agents/skills`、`.dsh/skills` 需显式加入 `extraRoots`。
  单数 `~/.agent/skills` 不会被猜测，只能显式配置。
- `maxDepth` 之外的 bundle 不发现；候选数量只受深度和目录规模约束，没有额外配额。
- 每个嵌套技能都会增加目录摘要的 token 成本；正文仍按需加载。
- 观察 bundle 目录意味着 `references/` 等资源变动也会触发一次目录重读；这是能发现
  `SKILL.md` 符号链接重定向的代价。
- 根或分类目录不可读时返回 incomplete，注册表因此不缓存该次观察，消费者保留上一份良好目录。
