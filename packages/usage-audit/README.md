# dsh-usage-audit

`/usage-audit`：扫描本机 DSH 会话事件日志（`$DSH_HOME/sessions/…/session.v*.jsonl.zstd`），
输出**各 provider/model 路由与各会话的缓存命中率、token 用量**。数据不离开本机。

它是为缓存优化工作准备的度量工具：例如 [dsh-oauth-providers](../oauth-providers) 的
chatgpt `promptCacheKey` 开关（prompt cache 亲和）做 A/B 时，用同一命令前后对比命中率。

## 用法

```
/usage-audit          # 近 14 天（days 配置项可改）
/usage-audit 7        # 近 7 天
/usage-audit all      # 全部历史
```

输出两张表：

- **按 provider/model 汇总**：请求数、prompt 总量（uncached+缓存读）、缓存读取、命中率、输出、会话数；
- **按会话**：uncached 输入最多的前 N 个（`sessionLimit`，默认 15），含标题、时间范围、路由构成。

命中率口径：`cacheRead / (cacheRead + uncachedInput)`。会话日志里的 usage 桶是适配器
归一化后的**不相交**分桶（`inputTokens` 已扣除缓存读），直接相加即可，不会重复计数。

## 安装

```sh
pnpm build    # 位于仓库根：packages/usage-audit 构建产物
dsh plugin --profile <profile> add ./packages/usage-audit
dsh --profile <profile> --dump-config   # 应出现 "# == dsh-usage-audit" 层
```

## 设计说明

- 纯宿主侧插件：无浏览器半插件、无 service，只注册一条斜杠命令。
- 日志解析容错：损坏/半写的 zstd 日志跳过不报错；标题来自
  `storages/session_projcache/sessions/<id>.json`，读不到就显示会话 id 前缀。
- mtime 预过滤：文件修改时间早于窗口起点即跳过，全历史扫描 ~100 个日志也在秒级。
- zstd 解压用 [fzstd](https://www.npmjs.com/package/fzstd)（纯 JS），不依赖系统二进制。

## 配置（Settings 中编辑）

| 键 | 默认 | 含义 |
|---|---|---|
| `days` | 14 | 不带参数时的默认扫描窗口（天） |
| `sessionLimit` | 15 | 按会话表格最多列出的会话数 |
