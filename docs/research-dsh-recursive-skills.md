# 调研：DSH 递归发现分类目录中的 skills

> **可用插件实现，无需修改 DSH。** 当前内置 filesystem provider 明确只支持
> `<root>/<skill>/SKILL.md` 和 `<root>/<skill>.md`，不递归分类目录。公开的
> `ctx.skills.registerProvider()` 正是补充这种来源的扩展点。固定分类目录也可先用
> `customSkillDirs` 解决，不必立即写插件。[S1][S2]

- 日期：2026-11-01。
- 对象：当前安装的 DSH **0.2.1-rc.5**；不将结论外推到其他版本。
- 方法：live Inspect 合同 + 安装包 README / `.d.ts` / 构建源码 + 独立 Node 实验。
- 本次只产出调研文档；未修改 skills、profile、`~/.dsh`、Nix 配置，也未安装插件。
- 原计划后台代理并行查证，但 `subagent_quick`、`create_agent` 均报
  `ctx.subagents.startContinuable is not a function`，改为直接查一手来源。

## 1. 现状与根因

### 1.1 实际路径

本机存在的是 **`~/.agents/skills`**（复数），其中有：

```text
~/.agents/skills/
├── research/SKILL.md                 # 原生支持
├── anthropic/
│   ├── pdf/SKILL.md                  # 原生不发现
│   ├── docx/SKILL.md
│   └── ...
├── deerflow/.../SKILL.md
├── extra/.../SKILL.md
└── rstack/.../SKILL.md
```

这次检查的 home 与当前项目路径中没有 `.agent/skills`。官方默认是 `.agents`，
不是 `.agent`；若以后确实采用单数目录，需要显式配置扫描根。[S3]

### 1.2 不递归是当前合同，不是 watcher 参数没开

官方 README 写明 nested `**/SKILL.md` **deliberately not discovered**。
源码 `discoverRoot()` 只枚举根的直接子项：遇目录就试它的 `SKILL.md`，不存在便跳过，
不会继续下降。因此它试的是 `anthropic/SKILL.md`，不是 `anthropic/pdf/SKILL.md`。[S1][S4]

watcher 同样只设 `depth: 1`，事件过滤只接受根级 Markdown 或直接 bundle 中的
`SKILL.md`。**单纯改 watcher 深度仍不能改变发现算法**，且公开 Config 没有
`recursive` / `maxDepth` 字段。[S4][S5]

## 2. 已验证的原生配置替代

`customSkillDirs` 接受额外扫描根。将分类目录自身作为根，其下的 skills 就变成
直接子目录，可复用原生解析、按需加载、资源路径和该根内的 watch。[S1][S4]

以下只是配置内容示意，**不是已应用的 patch**：

```yaml
customSkillDirs:
  - /home/sikongjueluo/.agents/skills/anthropic
  - /home/sikongjueluo/.agents/skills/deerflow
  - /home/sikongjueluo/.agents/skills/extra
  - /home/sikongjueluo/.agents/skills/rstack
```

注意：

- 配置项是目录路径，不是 glob；源码对每项直接 `path.resolve()`，不要写
  `**/skills`，也不要假设字符串中的 `~` 会展开。使用绝对路径。[S4:78,165–169]
- 后续新增**已配置根内的直接 skill**可被原生 watcher 发现；新增另一分类根或更深一层
  分类仍要更新配置。[S1][S4]
- custom 根 rank 为 **300**，默认 user-agents 为 **500**；数值小者优先。
  同名 custom skill 会覆盖默认用户 skill，这不是与原来完全等价的递归扩展。[S1][S2]
- 若落到 Loader patch，`config` 是整体替换，不是深合并，必须保留原行需要的其他键。
  当前 Inspect 把模板行 `include:skill-filesystem` 报为 inactive，而当前会话已有
  `skill` 工具和目录；不能据此断言整个 skills 功能关闭。真正落配置前应核对生效的
  preset/composition。本次没有修改它。[S10]
- 宿主配置归 Nix 管理；需要采用此方案时由用户落入 flake，不直接编辑 `~/.dsh`。

## 3. 公开插件 API

### 3.1 推荐入口：`ctx.skills.registerProvider()`

通过 live Inspect 的 `Service.listService({ service: 'skills' })` 核对，类型与安装包一致：

```ts
registerProvider(
  create: (control: SkillProviderControl) => SkillProvider,
): () => void

interface SkillProviderControl {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

interface SkillProvider {
  readonly name: string
  readonly list: (options: SkillLookupOptions) => Promise<
    readonly SkillCandidate[] | SkillProviderObservation
  >
  readonly get: (
    candidate: SkillCandidate,
    options: SkillLookupOptions,
  ) => Promise<SkillDefinition | undefined>
}

interface SkillLookupOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
}
```

关键语义：[S2][S6]

| 项目 | 合同及实现要求 |
|---|---|
| 依赖 | 插件声明 `inject: ['skills']`；使用 filesystem 服务时再依赖 `fs` |
| 注册时机 | 在 `apply()` 同步注册 factory；异步遍历放进 `list()` |
| provider 名 | 同一 layer 唯一，不能使用保留名 `runtime`；建议 `recursive-filesystem` |
| `list()` | 返回名称、描述、invocation、source、provider、rank、opaque locator 等候选信息 |
| `get()` | 重新读取被选中 skill 的正文，不提前把所有正文注入上下文 |
| `resourceBase` | `{ kind: 'directory', path: skillDirectory }`，保证相对 references/scripts 路径正确 |
| `path` | 可选的绝对指令文件路径，供文件预览使用 |
| `rank` | 同一 layer 中数值小者优先；相同 rank 按 provider 注册顺序及候选顺序决胜 |
| `source` | 来源标签；**不是**优先级，真正决定同层优先级的是 rank |
| scope | Host 行注册全局 provider；preset standing composition 中注册则限于该 scope；更近 layer 可不看 rank 直接遮蔽远层同名项 |
| 失效 | 注册表无 TTL；文件/目录变化必须调用该注册的 `control.invalidate()` |
| 卸载 | 注册返回 disposer；注册被释放时 `control.signal` abort，插件须关闭观察器、停止后台工作 |
| 部分失败 | `{ candidates, complete: false }` 表示不完整发现，避免将临时失败误当作技能删除 |

不建议启动时读完文件再逐个 `ctx.skills.register()`：这是固定 runtime skill 的接口，
其同层 rank 为 **250**，会改变用户技能的覆盖关系，也需要另写动态注册与重载管理。
可变磁盘目录更适合 provider。[S2][S6]

### 3.2 正常接入后无需另造模型工具或改 system prompt

`dsh-tool-skill` 消费同一个注册表，提供：初始目录、后续完整替换目录、`skill` 工具、
用户 `/name` 显式调用及统一资源指导。自定义 provider 的结果沿原通道进入会话，
不必劫持 `agent/pre-step` 或手工注入全文。[S7]

这里的“自动加载”应准确理解为：**自动发现并公布摘要，匹配任务时按需加载正文**，
不是把递归目录里所有 `SKILL.md` 全文塞进系统提示。新增技能会增加目录 token 成本；
正文仍按需读取。[S7]

### 3.3 可复用与不可直接复用的能力

`@deepseek-ai/dsh-skill-filesystem` 公开导出 `FileSystemSkillProvider`，其 constructor
接受 `(ctx, control, config)`，并有 `list/get/observeHostMutation/dispose`。[S5][S8]

因此有两种实现路径：

1. **复用扫描器的薄包装**：插件递归找到分类根/skill 父目录，将展开后的根交给
   `FileSystemSkillProvider`，复用解析与加载。需要自己管理展开根集合、分类目录变化、
   helper 实例替换与异步 dispose，且 custom 根默认 rank 300 需要显式处理。
2. **自有递归 provider（推荐完整方案）**：自己负责树遍历、frontmatter 解析和观察，
   直接产生候选；依赖更少、来源优先级与扫描停止规则更清晰，但需要测试解析兼容性。

**解析函数 `parseFrontmatter` / `parseSkillFile` 没有公开导出**，不能从内部文件路径
偷用。若选第二条，复用公开 `isSkillName()` 与 `yaml`，按当前 frontmatter 合同实现
所需字段；不是假定 DSH 已提供通用 parser API。[S4:667–707,783–808,852–885,891][S6]

## 4. 建议的第一版边界（设计建议，尚未实现）

建议 bundle 名 `dsh-recursive-skills`，作为**补充 provider**保留原生 provider。
先满足当前用户目录需求，不替换整个 skills 子系统。

1. 默认根通过 `resolveAgentsHome()` 得到 `<agentsHome>/skills`，可另配 roots；
   `.agent/skills` 仅显式 opt-in，不静默猜多个根。[S3]
2. 只补充原生根下**更深的** `SKILL.md`，原生支持的直接 skill 仍交给原 provider。
   若显式根本身未被原生扫描，可另定包含直接子项的配置语义。
3. 目录包含 `SKILL.md` 就视为 skill bundle 边界，不继续钻进其 references/scripts/assets；
   只递归分类目录，不将树下任意 `.md` 都识别成 skill。
4. 兼容符号链接：本机技能可能由 Nix 链接进来；规范化目标并记录 visited 身份，避免循环
   和重复遍历。设置明确扫描深度/数量上限，而不是无边界扫描整个 home。
5. 保留 YAML `name`，不改成 `anthropic/pdf`；注册表要求 kebab-case，路径命名空间不是
   公开 skill-name 格式。重名输出可定位告警并保持确定性顺序。[S6]
6. 必须保留 `description`、`whenToUse`、`metadata`、`disable-model-invocation`、
   `user-invocable` 语义；不能把禁用的 skill 因递归导入而重新暴露给模型。[S1][S4]
7. 同层 user-agents 嵌套候选可采用 **rank 501**，让原生直接 user skill（500）优先，
   同时仍优先于 bundled（600）。这是建议策略，不是 DSH 强制值。需确认与相关原生
   provider 的注册 layer：若补充 provider 挂 Host 全局层，preset 更近层的同名项仍会
   优先，不受 501/600 关系约束。以后若支持项目根，应分别定义其优先级，不能所有来源
   都用同一 rank。[S1][S6]
8. watcher 覆盖分类目录增删、skill 文件与 frontmatter 变化，合并重复事件后 invalidate；
   body-only 编辑由 `get()` 重读，不必因正文变动而强制重发目录。[S2][S7]
9. 优先通过 `ctx.fs` 遍历、解析和读文件，不擅自绕开当前 filesystem 后端用 Node 读本地。
   live `fs.watch(target, changed, signal)` 只观察**文件或目录直接子项**，不是递归 API；
   因此要管理每个被遍历分类目录/skill 文件的观察与异步关闭。若刻意只做本地主机目录，
   应明示其不支持远程 filesystem 的边界。[S9]

版本依赖按本机核对结果准备：DSH 包 `0.2.1-rc.5`、Cordis `4.0.5`、Schemastery
`3.18.5`。仓库 AGENTS.md 中旧 `0.2.0-rc.2` 示例不代表当前宿主版本。
本次未修改依赖，也未做跨版本兼容承诺。

## 5. 实验证据

### 5.1 最小红灯：确实走安装版本 scanner

在临时目录构造以下输入，用公开 `FileSystemSkillProvider`、`watch: false`、
`includeDefaultRoots: false` 运行 `list()`：

```text
root/direct-skill/SKILL.md          name: probe-direct
root/vendor/nested-skill/SKILL.md   name: probe-nested
```

运行结果：

```text
customSkillDirs: [root]
  => [probe-direct]
customSkillDirs: [root, root/vendor]
  => [probe-direct, probe-nested]
get(probe-nested)
  => body: # probe-nested
     resourceBase: root/vendor/nested-skill
assert(parent-root results include probe-nested)
  => AssertionError; exit code 1（预期红灯）
```

直接 skill 是正对照；仅改变 custom roots 后嵌套 skill 可读，排除了这个最小输入的
frontmatter 格式或加载器问题。测试调用的是安装包，不是另写的模拟扫描算法。

最小复现命令（把 `$PKG` 替换为 §6 的绝对基路径；可在 Fish 中用 `env PKG=... node ...`）：

```js
// node --input-type=module，运行目录中预先放置上述 fixture；此处 root 使用绝对路径。
const { FileSystemSkillProvider } = await import(
  `${process.env.PKG}/dsh-skill-filesystem/lib/index.js`
)
const provider = new FileSystemSkillProvider(
  { get: () => undefined, logger: { warn: console.warn } },
  { signal: new AbortController().signal, invalidate() {} },
  { includeDefaultRoots: false, customSkillDirs: [root], watch: false },
)
try {
  const skills = await provider.list({})
  if (!skills.some(s => s.name === 'probe-nested')) throw new Error('nested skill missing')
} finally {
  await provider.dispose()
}
```

### 5.2 用户真实目录只读比较

对 `~/.agents/skills` 跑同一 provider（无其他默认根、无 watcher）：

- 只指定父根：**51 个候选**。
- 再加入 `anthropic`、`deerflow`、`extra`、`rstack` 四个根：**70 个候选**。
- 新增名称 **19 个**：

```text
academic-paper-review, algorithmic-art, canvas-design, docx, frontend-design,
github-deep-research, pdf, plannotator-compound, ppt-generation, pptx,
rsbuild-best-practices, rslib-best-practices, rspack-best-practices,
rspress-best-practices, rspress-custom-theme, rspress-description-generator,
rspress-docs-generator, rstest-best-practices, xlsx
```

这是**候选数**，不是保证模型目录新增 19 项：最终还受重名、scope、invocation 策略影响。

### 5.3 Provider API 独立烟测

在新的内存 Cordis `Context` 中挂载 `SkillRegistry`，注册一个内存 provider，断言：

- 两次 `skills.list()` 只触发一次 provider `list()`：PASS。
- `skills.get()` + 标准 `renderSkillContent()` 保留正文与 directory resourceBase：PASS。
- `control.invalidate()` 后重新发现并移除候选：PASS。
- unregister 后 `control.signal.aborted === true`：PASS。
- 按当前 Cordis README 以 `await ctx.plugin(...)`、`ctx.fiber.dispose()` 管理生命周期。
  初次沿用不存在的 `ctx.start()` 时失败，按文档修正后以上断言全部通过。[S11]

这些是可行性验证，**不是已经实现的递归插件集成测试**；未验证当前 Web 会话新增目录、
外部编辑器实时刷新、Nix symlink 重定向或远程 filesystem 的实际行为。

### 5.4 实现后最小验收清单

- 多层分类中的合法 SKILL.md 可发现、按原 `name` 加载，references 路径正确。
- 原生直接 skills 不重复、不被意外覆盖；同名候选选择稳定。
- invocation 禁用、坏 YAML、缺字段保留原有合同与诊断。
- symlink 目标能加载；循环或多别名不造成无穷扫描。
- 新增/删除分类及 skill、改 description/name 后，下一步发布正确的新目录。
- 改 body 后下次加载得到新正文；正文不全量灌入模型上下文。
- 卸载后 provider、watcher、定时器及后台任务均清理；无旧回调污染新注册。
- I/O 临时失败标为 incomplete，不能把失败误报为全部删除。

## 6. 一手来源索引

下列 `$PKG` 统一指本机已安装包目录：

```text
/nix/store/hb0wd227jraf356q7r6qsv2xn5kkj97h-dsh-0.2.1-rc.5/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
```

行号仅对应该安装版本；构建文件不是另一个版本的 GitHub main。
包 manifest 的 repository 指向官方
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，
filesystem 包路径为 `packages/skill/skill-filesystem`。[S8]

- **[S1]** `$PKG/dsh-skill-filesystem/README.md:34–56,67–85,107–113,145–151`：
  格式、故意不递归、根和 rank、watch、限制。
- **[S2]** `$PKG/dsh-skill/README.md:48–68,82–102,135–140`：
  provider/运行时注册、scope 合并、缓存与 invalidation、失败状态。
- **[S3]** `$PKG/dsh-home-paths/lib/types/index.d.ts:12–17,43–47,60–72`：
  `.agents`、环境变量及 home 路径解析；本机直接调用 `resolveAgentsHome()` 验证。
- **[S4]** `$PKG/dsh-skill-filesystem/lib/index.js:20–59,72–107,114–186,370–383,544–565,584–665,667–808,852–891`：
  Config、根、扫描、watch 过滤、解析、symlink 与真实 exports。
- **[S5]** `$PKG/dsh-skill-filesystem/lib/types/index.d.ts:17–83`：
  Config 全字段与公开 provider 类；没有递归选项。
- **[S6]** `$PKG/dsh-skill/lib/types/index.d.ts:15–100,151–193,214–284`；
  `$PKG/dsh-skill/lib/index.js:20–23,147–214,519–520`：
  候选、provider/control、scope、低 rank 优先、runtime rank 250。
  已与 live `Service.listService({ service: 'skills' })` 交叉核对。
- **[S7]** `$PKG/dsh-tool-skill/README.md:28–61,73–89,110–137`：
  cwd、初始与替换目录、按需工具、用户显式调用、token 成本。
- **[S8]** `$PKG/dsh-skill-filesystem/package.json:2–24,31–46`：
  版本、官方源码仓库、包公开入口及依赖。
- **[S9]** 当前 Host Inspect：`Service.listService({ service: 'fs' })`，
  `resolve/listDir/readText/watch` 精确合同；`watch` 只观察目录直接子项。
- **[S10]** 当前 Host Inspect：`Config.listConfigs` 的
  `@deepseek-ai/dsh-skill` / `@deepseek-ai/dsh-skill-filesystem` / `@deepseek-ai/dsh-tool-skill`
  查询及各 entry packageDir；`Event.listEvents({ event: 'skills/change' })` 确认模式 `emit`。
  Loader 字段替换语义另见当前 `cordis-composition-reference` skill。
- **[S11]** `$PKG/cordis/README.md:18–67`：当前 Context、插件挂载和 fiber 生命周期。

**建议下一步：**如果只是恢复这四组现有 skills，先由用户声明式配置四个 custom roots；
如果目标是“以后放入任意分类目录都自动发现”，实现补充式 recursive provider，
不要 patch 原生 scanner 或另造一个同名 `skill` 工具。
