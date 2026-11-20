# Client UI migration

浏览器半插件已从手写 `client/client.js` 工厂迁到 TSX + 共享 UI。2026-11-16 起 crew 与 more-providers 复用共享 `ConfigStatusToast` 汇报外部 YAML 配置错误；OAuth 登录界面随后并入 more-providers 的同一客户端 bundle，当前共 9 个浏览器半插件。OAuth 的 slot 与 RPC 标识保留，普通参数迁入统一 YAML 的变更见 [合并迁移计划](plan-more-providers-oauth-merge.md)。

## 结构

| 位置 | 作用 |
| --- | --- |
| `packages/ui/` | 私有 workspace 包：shadcn 组合 API、Base UI 原语、Tailwind v4 工具类、DSH 公开 alias token 映射 |
| `packages/ui/src/host/` | 唯一导入钉版宿主 `dsh-client-ui-primitives` 的适配层，经 `@dsh-extensions/ui/host` 子路径导出 |
| `tooling/host/` | 共享 tsdown 预设（ESM、Node 20、`lib/index.js` + `.d.ts`、`clean: false`） |
| `tooling/client/` | 共享 Vite 客户端构建：CJS → DSH `window.__ModuleLoader__.load` factory，CSS 内联，external 平台表 + 精确的已声明宿主模块 |
| `packages/<name>/src/client/index.tsx` | 浏览器半入口，导出 `apply` / `inject` |
| `packages/<name>/src/client/styles.css` | Tailwind v4 入口（`dshx` 前缀 + `@source`） |
| `packages/<name>/vite.client.config.ts` | 三行 `defineClientConfig({ id, entry })` |
| `packages/<name>/tsconfig.client.json` | DOM/JSX 客户端检查；宿主 `tsconfig.json` 排除 `src/client` |

`pnpm-workspace.yaml` 的 `catalog:` 集中 React 18.3.1、Vite 7、Tailwind 4、Base UI 1.9、Storybook 10 与 DSH 0.2.2-rc.5 的精确 dev 版本；`nodeLinker: hoisted` 与单 lockfile 保持不变。

## 命令

```sh
pnpm install
pnpm check          # typecheck + build + client bundle check
pnpm test
pnpm check:pack     # pnpm pack 每个 bundle，检查 lib/client.js、patch、无 src 泄漏
pnpm build:storybook
pnpm storybook      # 6006
```

`scripts/check-client.mjs` 检查每个 `lib/client.js` 的 factory 包装、注册 id、`require` 只落在平台表或该包 `dsh.client.external` 声明的精确宿主模块、内联 `<style data-plugin>`、`apply`/`inject`，并 materialize factory、执行 `apply`、SSR 渲染每个注册组件。宿主 primitives 以真实模块 materialize（只 stub CSS Modules），同时校验 installed 版本等于 catalog 钉版。

## 验证记录（2026-11-15）

- `pnpm run typecheck`：22 个 workspace 项目全过。
- `pnpm run build`：20 个 bundle 全过；8 个 `lib/client.js` 均为 145–480 kB（gzip 34–97 kB），只 `require` `react` / `react/jsx-runtime`（Dialog 相关另需 `react-dom`；2026-11-16 起 jj-workspace 另 require 钉版宿主 primitives，见下节）。
- `pnpm run test`：全仓通过。`packages/ui` 的 jsdom 交互测试确认 Dialog 在 slot 子树内渲染、Escape 关闭并返回焦点，Select 弹层也在子树内且点选回调正确；handoff 测试覆盖 Escape 折叠/取消、搜索过滤与提交 payload。
- `pnpm run check:client`：8/8 通过。
- `node scripts/check-pack.mjs`：20/20 tarball 通过，`lib/client.js` 在包内、无 `src/` 或旧 `client/`。
- `pnpm -r run prepare`：全过（模拟安装期构建）。
- `pnpm run build:storybook`：通过。`main.ts` 同时接入 Tailwind Vite 插件与 automatic JSX（否则 Storybook 运行时报 `React is not defined`）；生成的 `iframe-*.css` 含 343 个 `.dshx\:` 工具类选择器、0 个未解析 `prefix(dshx)`/`@tailwind`。stories 覆盖 Button、表单控件、Alert/Badge/Progress/Spinner、Dialog、Table 的禁用/错误/长内容状态。
- Chromium 复核 ghost Select：trigger 背景/边框透明、28px 高；portal host 是 fixed 零尺寸节点，点击前后 trigger/wrapper/行的宽度与位置在连续 8 帧内不变；右端 `align="end"` 时 popup 右边缘与 trigger 右边缘对齐（delta ≈0.2px），内容更长时向左侧扩展（长选项实测 389px），不会把行顶走；item highlighted 背景为 brand/10。
- 干净跟踪树：把 `jj file list -r @` 的 439 个文件复制到独立目录，按 pnpm 的 workspace 链接方式链接 `@dsh-extensions/ui`，`tsc -p packages/ui/tsconfig.json`、`tsc -p packages/auto-permit/tsconfig.client.json` 与 `vite build` 均通过；`packages/ui/src/lib/cn.ts` 在跟踪树中。
- Chromium 计算样式：深色 token 下 Button 的 default/secondary/ghost/danger/link 与 Input 均 `focusVisible=true`、`outline: solid 2px`（brand）；ghost/danger/link 背景为透明 `rgba(0,0,0,0)`，不再回退到 UA 按钮底色。
- 控件观感：Input/Textarea/Button secondary/Select default 使用 `bg-surface-2` + `border-l1`，Card/Alert 使用 `border-l1`，避免暗色下统一的「黑底白框」；ghost Select 完全透明无边框。Selector 的 trigger 尺寸、28px 高度、max-content popup（min 240 / max 420）与 34px option 对照了宿主 `dsh-client-ui-model-selection` 的公开样式。

## 宿主 primitives 混用（2026-11-16）

jj-workspace 的新会话 worktree 入口不再用 Base UI Select 复刻宿主 selector，而是复用宿主 `@deepseek-ai/dsh-client-ui-primitives` 的 `Menu`、`Tooltip` 和分支/箭头图标。范围只有这一组控件；共享 `Select` 保留给其他消费者。

- **单一导入点**：`packages/ui/src/host/primitives.ts` 经 `@dsh-extensions/ui/host` 子路径导出，不进共享 barrel；其他插件不会请求该模块，生产 bundle 只有 `dsh-jj-workspace` 出现该 `require`。
- **rc.5 变化**：primitives 删除了 `useAnchoredPosition`，定位改为 CSS anchor positioning（`anchor-name` / `position-anchor` / `@position-try`）。`session-write-access` 是唯一使用者，菜单已改为纯 CSS 锚定，见包 README。Chromium 实测：trigger 在页面下部时菜单位于其上方 4px，贴近顶部时用 `@position-try` 翻到下方 4px。
- **卡片骨架进共享库**：`session-write-access` 的菜单曾把 `overflow-y: auto` 写在宿主 `MenuSurface` 卡片本身上，宿主的 `.material`（卡片内 `position: absolute; inset: 0` 的背景层）随内容滚出可视区，滚动后下半截透明。修法与宿主 `Menu` 一致——卡片不滚、内部 viewport 滚——并抽成 `packages/ui/src/host/menu-panel.tsx`（`@dsh-extensions/ui/host/menu-panel`）：`MenuPanel` 负责给 trigger 设 `anchor-name`、给卡片设 `position-anchor`、pin 住 header/footer，只让 `.dshx-menu-panel-viewport` 滚动；尺寸走 `--dshx-menu-panel-width` / `--dshx-menu-panel-max-height` 变量。Chromium 实测：21 行列表滚动 400px 前后，卡片 420px 高度上的 material 未覆盖率均为 0（修复前 304px 裸露），贴近顶部时翻到 trigger 下方并保持 4px 间距。
- **精确钉版**：`pnpm-workspace.yaml` 钉 `0.2.2-rc.5`。`tooling/client` 只 external 这个精确模块名；`dsh-jj-workspace` 在 `dsh.client.external` 声明；`check-client` 拒绝未声明请求、未知声明，并校验 installed 版本等于 catalog。该模块是宿主冻结表的一项，不是官方支持的第三方 SDK；check 只能核对 catalog 与 installed，运行中的 shell 版本仍需在升级 dsh 时人工核对（`dsh --version`、shell 的 module table，再跑 Storybook/真实页），并核对组件 props、CSS Modules 与行为。
- **运行身份**：生产 bundle 只 `require` 宿主表里的同一实例，Menu 的 CSS Modules class 与 shell 样式表天然一致；primitives 不被打进 bundle。
- **预览/测试依赖**：上游包只把运行时 import 列在自己的 devDependencies，因此 Storybook 与 jsdom 测试用 catalog 中的 shiki、simple-icons、mdast/micromark、dsh-client-store 等 devDependency 补齐；这些不进生产。
- **视觉参照**：同位置原生 Forge `WorktreeToggle`。28px 透明 trigger、4px 小间距、13px/20px/500、宿主 `radius-sm`、品牌色 focus ring、14px 原生 checkbox；Menu 卡片、34px 行、check 标记、Escape/Tab/焦点返回都由宿主原语提供。未复制宿主 hash class。未请求时 Tooltip 显示完整 base；请求后菜单列出 `@`/bookmark（Git 为分支，当前分支带 current 注记）；阻塞时保留已选项并允许撤回。
- **挂载边界**：菜单内容与 Tooltip 仍在 slot 子树内；`Menu` 原地渲染，按可用空间选上/下，并用 `max-height: min(320px, 40vh)`（`!important` 盖过宿主视图口头）让列表在宿主 `.viewport` 内滚动。但宿主 `MenuSurface` 自身会无条件向 `document.body` portal 一块 `aria-hidden`、`pointer-events:none` 的 `[data-menu-backing]` 装饰背板（仅 macOS vibrancy 用，Linux 下 `display:none`，关闭/卸载即移除）。用户已批准这一条**仅限宿主组件自带装饰背板**的例外；业务代码仍不得向 body 挂任何节点，菜单内容也不在 body。已用 jsdom 与 Chromium 验证关闭、卸载后计数归零。
- **同值重提交**：点击已选中的 base 仍调用 `pick`，与旧 Select 一致；Forge `requestWorktree` 会 forget 失败 attempt、记录请求并 recheck，所以这是重试语义，不是无操作。
- **粗指针**：菜单作用域内 `[role=menuitem]` 在 `(pointer: coarse)` 下 `min-height: 44px !important`；trigger/label 也是 44px，checkbox 视觉 14px 但整行可点。原生宿主行高 34px 不满足本仓 ≥44px 规则，此为本组控件的局部覆盖。

验证证据（2026-11-16）：

- `pnpm check`、`pnpm test`、`pnpm check:pack`、`pnpm build:storybook` 通过；jj-workspace 42 个测试，含真实 Menu 的打开/选择/Escape 焦点返回、同值重提交、阻塞撤回、加载禁用、body 背板关闭/卸载清理。
- Storybook + Chromium（1280×800、390×844；触摸模拟 `pointer: coarse`）：21 项菜单在 hero 滚动容器内不越界，320px 上限生效、内部滚动（clientHeight 312 / scrollHeight 741）；trigger 28px、13px/500、8px 圆角、透明背景、checkbox 14px 且 `accent-color` 为品牌色；Tooltip fixed、不被裁剪。粗指针下 trigger/label/菜单行均 44px，`data-menu-backing` 为 body 子节点、`aria-hidden=true`、`display:none`，Escape 与卸载后均移除。
- 真实 DSH 页面尚未验证（缺页面 token，需用户启动 overlay）：slot 内实际遮挡/层级、深色/浅色、窄屏触摸、长列表滚动与菜单选中后的焦点。

## 未由 agent 验证（需在真实 DSH 页面确认）

- 真实 slot 挂载后的视觉、深浅色、窄屏/触摸、焦点陷阱与关闭后焦点返回。
- Base UI 弹层在 slot 容器内是否被祖先 `overflow` 裁剪；`Select` 的 portal/positioner 需在设置页和对话页实看。
- HMR/禁用插件时 `<style data-plugin>` 是否随 loader 清理（tag 与插入时机已静态校验）。
- Storybook 的视觉走查（构建通过，未截图比对）。
- 本地目录安装与 dev overlay 的运行时加载（`pnpm pack` 与 `prepare` 已覆盖产物）。

建议验证（宿主命令由用户执行）：

```sh
pnpm build
dsh --profile web --patch $PWD/packages/<name>/dev.patch.yml --no-open --port <端口>
```

重点页面：设置页的 Auto Permit / Coding 套餐用量 / OAuth 登录；Context Audit 侧栏；Handoff 选择卡；Triggers 会话页；会话 header 的 jj 任务 pill；写入范围按钮与浮层。

## 已知取舍

- 旧 `client/client.js` 与手写 CSS 字符串全部删除，不保留双实现。
- 统一密度（12–13px 文本、32px 控件）与 44px 粗指针最小点按目标；个别旧页面更宽松的间距不再逐像素复刻。
- Handoff 的卡片仍保留“Escape 先收起选择器、再取消卡片”的旧语义；handoff 测试覆盖了这一点。
- Session write-access 的旧浮层没有 Escape/焦点陷阱；共享 Dialog 现在提供 Escape、背景点击关闭与焦点返回，属于无障碍增强，调用路径（close → setState open:false）不变。
- Triggers/Handoff/JJ 的旧 VM 测试无法直接运行 TSX；已改写为真实 React + DOM/Test Renderer 测试，覆盖注册、分组、控件 payload、redelivery gating、Escape 等契约，颗粒度低于旧套件。
