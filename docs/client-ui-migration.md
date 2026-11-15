# Client UI migration

八个浏览器半插件（auto-permit、context-audit、handoff、jj-workspace、oauth-providers、plan-usage、session-write-access、triggers）已从手写 `client/client.js` 工厂迁到 TSX + 共享 UI。业务协议、slot 契约、config 字段与 RPC 不变。

## 结构

| 位置 | 作用 |
| --- | --- |
| `packages/ui/` | 私有 workspace 包：shadcn 组合 API、Base UI 原语、Tailwind v4 工具类、DSH 公开 alias token 映射 |
| `tooling/host/` | 共享 tsdown 预设（ESM、Node 20、`lib/index.js` + `.d.ts`、`clean: false`） |
| `tooling/client/` | 共享 Vite 客户端构建：CJS → DSH `window.__ModuleLoader__.load` factory，CSS 内联，仅 external 宿主平台表 |
| `packages/<name>/src/client/index.tsx` | 浏览器半入口，导出 `apply` / `inject` |
| `packages/<name>/src/client/styles.css` | Tailwind v4 入口（`dshx` 前缀 + `@source`） |
| `packages/<name>/vite.client.config.ts` | 三行 `defineClientConfig({ id, entry })` |
| `packages/<name>/tsconfig.client.json` | DOM/JSX 客户端检查；宿主 `tsconfig.json` 排除 `src/client` |

`pnpm-workspace.yaml` 的 `catalog:` 集中 React 18.3.1、Vite 7、Tailwind 4、Base UI 1.9、Storybook 10 与 DSH 0.2.2-rc.1 的精确 dev 版本；`nodeLinker: hoisted` 与单 lockfile 保持不变。

## 命令

```sh
pnpm install
pnpm check          # typecheck + build + client bundle check
pnpm test
pnpm check:pack     # pnpm pack 每个 bundle，检查 lib/client.js、patch、无 src 泄漏
pnpm build:storybook
pnpm storybook      # 6006
```

`scripts/check-client.mjs` 检查每个 `lib/client.js` 的 factory 包装、注册 id、仅平台表 `require`、内联 `<style data-plugin>`、`apply`/`inject`，并 materialize factory、执行 `apply`、SSR 渲染每个注册组件。

## 验证记录（2026-11-15）

- `pnpm run typecheck`：22 个 workspace 项目全过。
- `pnpm run build`：20 个 bundle 全过；8 个 `lib/client.js` 均为 145–480 kB（gzip 34–97 kB），只 `require` `react` / `react/jsx-runtime`（Dialog 相关另需 `react-dom`）。
- `pnpm run test`：全仓通过。`packages/ui` 的 jsdom 交互测试确认 Dialog 在 slot 子树内渲染、Escape 关闭并返回焦点，Select 弹层也在子树内且点选回调正确；handoff 测试覆盖 Escape 折叠/取消、搜索过滤与提交 payload。
- `pnpm run check:client`：8/8 通过。
- `node scripts/check-pack.mjs`：20/20 tarball 通过，`lib/client.js` 在包内、无 `src/` 或旧 `client/`。
- `pnpm -r run prepare`：全过（模拟安装期构建）。
- `pnpm run build:storybook`：通过。`main.ts` 同时接入 Tailwind Vite 插件与 automatic JSX（否则 Storybook 运行时报 `React is not defined`）；生成的 `iframe-*.css` 含 343 个 `.dshx\:` 工具类选择器、0 个未解析 `prefix(dshx)`/`@tailwind`。stories 覆盖 Button、表单控件、Alert/Badge/Progress/Spinner、Dialog、Table 的禁用/错误/长内容状态。
- Chromium 复核 ghost Select：trigger 背景/边框透明、28px 高；portal host 是 fixed 零尺寸节点，点击前后 trigger/wrapper/行的宽度与位置在连续 8 帧内不变；右端 `align="end"` 时 popup 右边缘与 trigger 右边缘对齐（delta ≈0.2px），内容更长时向左侧扩展（长选项实测 389px），不会把行顶走；item highlighted 背景为 brand/10。
- 干净跟踪树：把 `jj file list -r @` 的 439 个文件复制到独立目录，按 pnpm 的 workspace 链接方式链接 `@dsh-extensions/ui`，`tsc -p packages/ui/tsconfig.json`、`tsc -p packages/auto-permit/tsconfig.client.json` 与 `vite build` 均通过；`packages/ui/src/lib/cn.ts` 在跟踪树中。
- Chromium 计算样式：深色 token 下 Button 的 default/secondary/ghost/danger/link 与 Input 均 `focusVisible=true`、`outline: solid 2px`（brand）；ghost/danger/link 背景为透明 `rgba(0,0,0,0)`，不再回退到 UA 按钮底色。
- 控件观感：Input/Textarea/Button secondary/Select default 使用 `bg-surface-2` + `border-l1`，Card/Alert 使用 `border-l1`，避免暗色下统一的「黑底白框」；ghost Select 完全透明无边框。Selector 的 trigger 尺寸、28px 高度、max-content popup（min 240 / max 420）与 34px option 对照了宿主 `dsh-client-ui-model-selection` 的公开样式。

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
