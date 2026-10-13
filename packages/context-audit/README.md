# dsh-context-audit

`/context-audit` 命令 + 侧边栏「上下文审计」面板：扫描本机 DSH 会话事件日志
（`$DSH_HOME/sessions/…/session.v*.jsonl.zstd`），输出三层统计。数据不离开本机。

1. **按 provider/model 路由**：请求数、prompt 总量（uncached+缓存读）、缓存读取、
   命中率、输出、会话数 —— 缓存优化（如 [dsh-oauth-providers](../oauth-providers) 的
   chatgpt `promptCacheKey` 开关）A/B 对照的核心读数；
2. **按工具**：调用数、失败数、失败率、平均/最长耗时、无结果（中断）数、会话数、
   错误码分布 —— 判断你的工具与 DSH 内置工具的好坏，指导后续改进；
3. **按会话**：uncached 输入最大的会话（标题 + 时间范围 + 路由构成）。

## 用法

命令（在任意会话里）：

```
/context-audit          # 近 14 天（days 配置项可改）
/context-audit 7        # 近 7 天
/context-audit all      # 全部历史
```

侧边栏面板（web UI 左侧栏，与 Plugins / Tasks 同级的「上下文审计」）：
窗口切换（7 天 / 14 天 / 30 天 / 全部）+ 手动刷新，表格同上。

## 口径

- 命中率 = `cacheRead / (cacheRead + uncachedInput)`；会话日志里的 usage 桶是适配器
  归一化后的**不相交**分桶（`inputTokens` 已扣除缓存读），直接相加即可。
- 失败率 = `isError 结果数 / 已完成结果数`；`tool/call` 与 `tool/result` 按 `callId`
  配对，耗时 = 结果时间 − 调用时间；只有调用没有结果的记为「无结果」（会话中断）。
- 错误码取自结果事件的 `error.code`（缺省 `error.name`，再缺省 `ERROR`）。

## 安装

```sh
pnpm build    # 位于仓库根：packages/context-audit 构建产物
dsh plugin --profile <profile> add ./packages/context-audit
dsh --profile <profile> --dump-config   # 应出现 "# == dsh-context-audit" 层
```

浏览器半插件（侧边栏面板）与宿主半（命令 + `/dsh-context-audit/report` 通道）同包分发，
`dsh.client` 声明依赖 `dsh-client-ui-sidebar` / `dsh-client-ui-layout` / `dsh-client-locale`。

## 设计说明

- 宿主半：无自有 service；命令走 `ctx.commands`，通道软注入 `connection` + `webServer`
  （connection RPC 信封，同 dsh-plan-usage 的语法），扫描在通道侧串行化防连点。
- 浏览器半：手写 client.js（无 JSX），UI 只经 contribution slot 挂载
  （`main` + `sidebar.panellist`），通信走本包 webServer 前缀路由的相对路径 fetch；
  交互全部 `onClick`，触摸可用。
- 日志解析容错：损坏/半写的 zstd 日志跳过不报错；标题来自
  `storages/session_projcache/sessions/<id>.json`，读不到就显示会话 id 前缀。
- mtime 预过滤：文件修改时间早于窗口起点即跳过，全历史扫描 ~100 个日志也在秒级。
- zstd 解压用 [fzstd](https://www.npmjs.com/package/fzstd)（纯 JS），不依赖系统二进制。

## 配置（Settings 中编辑）

| 键 | 默认 | 含义 |
|---|---|---|
| `days` | 14 | 不带参数时的默认扫描窗口（天） |
| `sessionLimit` | 15 | 按会话表格最多列出的会话数 |
