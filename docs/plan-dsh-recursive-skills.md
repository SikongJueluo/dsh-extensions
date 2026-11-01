# 计划:dsh-recursive-skills 的宿主接入

状态(2026-11-01):仓库内实现、测试与只读真实目录验证已完成;本文件是**宿主落点计划**,由用户
落进 flake,agent 不改 `~/.dsh`、不安装 bundle、不重启 profile。当前 `web` 仍只挂原生
filesystem provider,嵌套技能在本会话不可见。

## 1. 交付了什么(仓库内,已验证)

- `packages/recursive-skills`(`dsh-recursive-skills`):补充式 Host provider,递归发现
  `<agentsHome>/skills` 下 depth ≥ 2 的 `SKILL.md` bundle,与原生 provider 共用
  `ctx.skills` 注册表(同一目录、`skill` 工具、`/name` 调用)。
- 直接 skill(`<root>/<name>/SKILL.md`、`<root>/<name>.md`)仍归原生 provider;插件不重复
  登记。嵌套候选默认 rank 501(原生 user-agents 500 优先,bundled 600 靠后)。
- 每个扫描目录与每个发现的 bundle 目录经 `ctx.fs.watch` 观察(可看到 `SKILL.md` 符号链接
  重定向);增删分类/技能、改 frontmatter 触发 `invalidate()`,正文由 `get()` 重读。建 watcher
  后会重新扫描,避免盲窗内的事件被缓存;watcher 建立时记录路径 version,变化(缺失→目录、
  删除重建、子项增删)即替换,缺失根出现后不会停留在父目录过滤模式。I/O 失败返回 incomplete,
  watcher 失败只降级热刷新。
- 解析合同与已安装 `@deepseek-ai/dsh-skill-filesystem` 逐字段差分通过;`disable-model-invocation` /
  `user-invocable` 不被递归路径重新暴露。
- 验证:`pnpm -C packages/recursive-skills test` 28 tests;`pnpm check` 与全仓 `pnpm test` 通过。
  只读扫描真实 `~/.agents/skills` 得到 19 个嵌套候选(docx/pdf/pptx/xlsx 等),
  `get('pdf')` 正文与 resourceBase 正确。另用工作区内临时 `DSH_HOME` +
  `--from-default-profile headless` + `dev.patch.yml` 走真实 Loader 启动(模型凭据缺失在请求
  阶段退出),session 日志的初始技能目录包含 18/19 个嵌套名称;唯一缺席的
  `plannotator-compound` 是 `disable-model-invocation: true`,符合原生策略。**未做** live Web
  的目录替换/热刷新端到端验证。

## 2. Nix 落点(用户执行)

本插件是**追加行**,不替换任何 stock provider,所以**不要**写 `replaces`。在
`~/.config/nixos/home/ai/dsh/plugins.nix` 的 `programs.dsh.plugins` 中加入:

```nix
"recursive-skills" = {
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/recursive-skills/lib/index.js";
  host = true;
  # config 可省略;默认扫描 $DSH_AGENTS_HOME/skills(本机 ~/.agents/skills)。
  # 需要项目根时显式追加:
  # config.extraRoots = [ "/home/sikongjueluo/Projects/<project>/.agents/skills" ];
};
```

前置构建(每次更新插件后):

```sh
pnpm install && pnpm build   # patch/宿主声明引用 lib/index.js,Nix 不参与构建
```

然后按现有 flake/home-manager 流程部署并重启 `dsh-web`。Nix 声明经后置 `--patch` 生效,
优先于 profile Settings;若在 Settings 里改同一行会报
`overridden by a home patch or command-line overlay`,应改 Nix。

没有 Host 插件声明的部署可直接把
`packages/recursive-skills/dev.patch.yml` 加入 `extraPatches`;该 overlay 与 bundle 的配置
语义一致,不要与上面的声明重复插入。

## 3. 启用后的预期

新建 session 会多出 **19 个嵌套候选**（与调研一致）：

```text
academic-paper-review, algorithmic-art, canvas-design, docx, frontend-design,
github-deep-research, pdf, plannotator-compound, ppt-generation, pptx,
rsbuild-best-practices, rslib-best-practices, rspack-best-practices,
rspress-best-practices, rspress-custom-theme, rspress-description-generator,
rspress-docs-generator, rstest-best-practices, xlsx
```

- **19 个候选 ≠ 19 个模型可见名称**：模型侧初始目录实际新增 18 个。
  `plannotator-compound` 带 `disable-model-invocation: true`，按原生策略只对用户
  `/name` 可见，不进入模型目录。
- 这些名称与直接技能不重名，因此不会改变已有的 51 个直接候选。
- 目录只给摘要；模型调用 `skill` 工具或用户输入 `/pdf` 时才读取正文。
- 新增 `~/.agents/skills/<新分类>/<新技能>/SKILL.md` 后,下一次目录替换应自动出现,无需重启。
- 修改嵌套 `SKILL.md` 的 description/name → 目录替换;只改正文 → 下一次加载生效。
- 删除嵌套技能目录 → 目录替换后消失。

## 4. 验收清单

1. `dsh --profile web --dump-config` 出现 `recursive-skills` 行(该命令会写 profile 运行时
   文件,属宿主动作,agent 不执行)。
2. 新 session 里让模型列出技能,或观察初始目录:应包含 `pdf`、`docx`、`pptx`、`xlsx` 等。
3. `skill` 工具加载 `pdf`,正文包含 PDF 处理说明;相对资源路径指向
   `~/.agents/skills/anthropic/pdf`(不是 `$DSH_HOME` 下的副本)。
4. 临时创建 `~/.agents/skills/probe/nested/SKILL.md`(name: probe-nested),不重启,下一轮
   目录替换应包含 `probe-nested`;删除后应消失。
5. 改该文件的 description,下一轮目录应更新;只改正文,重新加载应得到新正文。
6. 宿主日志中不应出现 `recursive-skills:` 告警(坏 YAML 的告警按文件定位才算正常)。

## 5. 回滚

从 `plugins.nix` 删除该行 → 重新部署并重启 `dsh-web`。插件不写用户技能目录、不改
`~/.dsh`,回滚后原生直接技能与配置保持原样。

## 6. 已知边界(如实,不粉饰)

- 只扫描用户共享根;项目 `.agents/skills` / `.dsh/skills` 需显式 `extraRoots`。单数
  `~/.agent/skills` 不猜测。
- 需要 `ctx.fs`;`fs.watch` 不可用的远端 filesystem 后端只能保证首次发现。
- `maxDepth` 默认 4;更深的 bundle 需调大,代价是遍历与 watcher 数量。
- live Web 的目录替换与热刷新**未在本机验证**(profile 只读,未安装、未重启);以上验收
  清单是部署后的确认步骤。
- 与所有技能目录一样,新增摘要会增加每轮目录 token;插件不预注入正文。
