# dsh-rtk-rewrite

DSH 的 rtk 命令改写执行器：模型跑 `git status`，实际执行 `rtk git status`——
rtk（[rtk-ai/rtk](https://github.com/rtk-ai/rtk)）跑真命令并输出确定性压缩
的结果（60-99% 字节削减），上下文压力与 spill/压缩触发概率随之下降。

## 为什么在执行器层

DSH 的 `tools/pre-execute` 设计上不支持入参改写，`dsh-hooks-claude-code`
也明确忽略 `updatedInput`——rtk 官方的 Claude Code 集成路在 DSH 走不通。
本插件改在 **`ctx.shell` 执行器 seam** 做改写，即 [dsh-auto-env](../auto-env/)
确立的模式：`RtkBashExecutor extends AutoEnvBashExecutor`，在 `execute()`
里先做宿主侧 `rtk rewrite <command>` 查询，把 `spec.command` 换成查询结果
再 `super.execute`。效果：

- direnv/devenv overlay 照常叠加（继承 auto-env）；
- 沙箱、审批、后台 jobs、超时、截断/spill、UI 呈现全部原样——改写只动
  命令字符串；
- 改写查询走宿主侧 `ctx.subprocess`（沙箱外，auto-env 跑 `direnv export`
  同款），改写后的命令才进沙箱。

实测（rtk 0.49.0）：沙箱内 `rtk git status` 正常输出紧凑结果、rc=0、
tracking DB 写入被拒时静默降级无报错噪音。要完整 recall/tracking 功能，
把 rtk `config.toml` 的 `[tracking]`/`[retriever]` 落盘路径指到工作区内。

## 接口契约（版本兼容的关键）

改写判定**只看 stdout**：`rtk rewrite <cmd>` stdout 非空单行 = 改写结果；
空 = 原样执行。**退出码一律忽略**——0.49.0 实测成功改写返回 3、无等价
返回 1，与其文档（0/2/3）不符，stdout 是唯一跨版本稳定信号。查询结果按
命令串 memo（256 条 LRU），重复命令零额外开销；首次查询约 10ms。

## 行序与安装

本 bundle 的 patch 禁用 `auto-env` 行并追加 `rtk-rewrite` 行（同时兜底
禁用 base `bash-sandbox` 行，未装 auto-env 也能独立用）。**patch 行的
config 是整体替换**：profile 里给 auto-env 行设过的键（`direnvPath` 等）
要在本行重述。

```sh
pnpm build
dsh plugin --profile web add ./packages/rtk-rewrite   # 在 dsh-auto-env 之后
# 或 overlay：
dsh --profile web --patch ./packages/rtk-rewrite/dev.patch.yml --no-open --port <端口>
```

前置：`rtk` 在**宿主环境** PATH 上（nix profile 已装 0.49.0）；profile
node_modules 里有 `dsh-auto-env`（运行时继承其类）。

## 配置（行 config；`rewrite` volatile 可热切换，rtk 键改动重挂执行器）

继承 auto-env 全部键（executor + direnv），另加：

| 字段 | 默认 | 含义 |
|---|---|---|
| `rewrite` | `true` | 总开关；false = 全部原样执行（含 direnv 照常） |
| `rtkPath` | `rtk` | rtk 可执行文件，绝对路径或 PATH 名 |
| `rewriteTimeoutMs` | `5000` | 单次查询预算；超时/失败原样执行 |

## 非目标

PTC（run_code）子分发不经此改写（`tools/ptc-dispatch-log` 未挂）；
`Read`/`Grep` 等内置工具的输出不经 rtk（rtk 本身也只声明覆盖 bash 路径）。

## 测试

```sh
pnpm build && node packages/rtk-rewrite/smoke.mjs
```
