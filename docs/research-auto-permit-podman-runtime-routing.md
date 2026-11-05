# 调研：RealSense 会话中的 Podman 重复审批

日期：2026-11-06（Asia/Shanghai）。范围为诊断，不修改审批策略、profile、Nix 或机器人项目。

## 结论

**不是审批没有送到 auto-permit。** 目标执行会话的 13 次 bash 提权全部留下 auto-permit 通知，但自动放行 0 次：

- **10 次**判官明确因 wrapper / 脚本 / pytest 的实际容器操作不在证据里而 DEFER；这是 v4 首版范围限制与实际工作流不匹配。
- **2 次**普通直接 `podman run` 被旧的危险删除正则误报，跳过模型直接交后方审批链；已对原命令离线复现。
- **1 次** `podman images` / `ps` 查询得到无理由 DEFER；现有观测不能区分正常无理由判决、格式错误、空响应、调用异常等，不应猜成超时或路由失败。
- 所有审批最终 `allowed-once`，但该 outcome 本身不记录批准者。插件通知显示其先行 DEFER/让路，因此能确定最终批准来自后方链路，不能仅凭日志 outcome 证明是人工本人。

此前审核只验证了 fixture/mock 的链路和危险形状，未做真实判官/实际项目工作流校准。代码通过审核不代表这类脚本化工作流已经能自动审批。

## 一手证据与范围

目标会话：`83e31667-da14-460b-b961-32900fe1caf6`，标题 `Handoff: 实现本地运行realsense camera`，workspace 为 `robot`。

原始只读日志：

```text
$DSH_HOME/sessions/--home-sikongjueluo-Projects-robot--/
  83e31667-da14-460b-b961-32900fe1caf6/session.v4.jsonl.zstd
```

引用快照只含人类输入和最终回复，没有工具调用/审批细节。本次读取原始 JSONL：`approval/asked=13`、`approval/decided=13`、`source.kind=auto-permit` 的 `user/message=13`。没有 PTC 分派，13 次均为直接 bash 调用。目标审批时间范围为 2026-11-05 22:12:05–22:38:45（+08:00）。

其他一手来源：

- [审批入口和链路顺序](../packages/auto-permit/src/index.ts)：高危 → 白名单 → 来源门控记忆 → 判官 → `next()`。
- [证据折叠](../packages/auto-permit/src/evidence.ts)：用户 prompt、当前命令/目录和历史批准；**不提供其他工具结果或脚本内容**。
- [判官 v4 提示词与失败回落](../packages/auto-permit/src/judge.ts)：直接 engine 条件、wrapper DEFER、异常无理由 DEFER。
- [硬规则](../packages/auto-permit/src/rules.ts)：旧 `rm` 正则。
- [可变文件重审](../packages/auto-permit/src/container.ts)：任何包含 Podman/Docker 的输入和 shell 脚本不走精确记忆。
- [现有功能与限制](../packages/auto-permit/README.md)：已明确首版只支持直接调用、没有脚本证据和资源归属。

未复制完整会话、设备标识、认证信息或秘密环境到此文档。

## 审批逐项对照

`ask` 是 `approval/asked.seq`，`notice` 是稍后持久呈现的插件通知 seq。通知先经 `agent/inbox/spliced` 排队，再在工具批次完成后的 step 展示；不能拿 notice 的呈现顺序误判成插件没有先于人工参与。

| ask → notice | 命令类别（省略非关键参数） | 插件实际处理 |
|---|---|---|
| 555 → 565 | `podman images …; podman ps …` | 判官路径，无理由 DEFER |
| 576 → 586 | `bash scripts/realsense_dev.sh --engine podman build` | 脚本未在证据中，DEFER |
| 589 → 598 | 同脚本 `--variant official build-image` | 同上 |
| 610 → 619 | `env -u … bash … official build-image` | 包装脚本内构建/网络效果不可见，DEFER |
| 676 → 685 | 同上，`tail -80` 改为 `tail -60` | 同上；历史批准不构成容器同族授权 |
| 780 → 790 | 同脚本 `official build` | 同上 |
| 793 → 803 | 同脚本 `official install` + 项目内产物检查 | `install` 的实际容器操作不可见，DEFER |
| 813 → 822 | 直接 `podman run --rm --network none`，项目产物只读挂载，容器内 `ldd/probe` | 危险删除正则误报，1 ms 内排队 `irreversible shape` 通知，无判官调用路径 |
| 825 → 834 | 同类直接 run，容器内 `ldd/grep` | 同一误报 |
| 837 → 847 | `IAL_G1D_REALSENSE_PRODUCER_ENGINE=podman … pytest …test_realsense_wire.py` | 测试内 engine 操作不可见，DEFER |
| 874 → 884 | 同脚本 `official check` | 脚本未在证据中，DEFER |
| 936 → 946 | `./g1d camera realsense probe --engine podman --json` | `g1d` wrapper 的挂载/设备效果不可见，DEFER |
| 1013 → 1023 | 同 engine 环境下全量 pytest | 测试内 engine 操作不可见，全量范围也大于已批 wire 测试，DEFER |

判官原文例（notice 586）：

> The input runs a wrapper script (`scripts/realsense_dev.sh`) whose effective container operations are not visible, so it cannot satisfy container rule (3) …

notice 946 则明确指出 `./g1d` wrapper 的 mounts/device mappings 不可见。它们说明模型已运行 v4 容器规则，不是旧版完全不懂 Podman。

审批耗时总计约 **18 分 36 秒**，其中首次状态查询约 **16 分钟**；其他 12 次合计约 **2 分 36 秒**。通知排队前总耗时约 46.9 秒（包含模型路径与宿主开销），之后后方审批链累计等待约 17 分 49 秒。此分解不是模型推理精确计时，但足以区分主要等待来自后方链路。

## 原因一：主会话读过脚本，判官却看不到

主执行会话 seq 43 已读取 `scripts/realsense_dev.sh`，seq 32 已读取 `src/ial_g1d/commands/realsense.py`；seq 547 也查看了 wire 测试前 130 行。判官输入不是主会话完整 transcript：`collectEvidence()` 没有采集这些 read/bash 工具结果，所以主模型知道的脚本内容不会自动传给判官。

v4 的限制会在以下两处叠加：

1. `SYSTEM_PROMPT` 要求直接调用 engine；wrapper、Makefile、辅助程序当前效果不可见时 DEFER。
2. 容器命令禁用同族等价；含 Podman 的命令又由 `isMutableFileDependent()` 禁用精确记忆。用户先后批准 `build-image/build/check/install` 不会转成后续步骤的范围授权。

因此在脚本化项目里，“装了 Podman 支持”表现为**每次都请模型确认自己必须交人工**。只改模型、更长超时或重启无法补回缺失证据。

### 不能把所有 wrapper 一刀切自动批准

只读检查目标项目当前代码（它们可变，不代表此刻重新授权历史命令）：

- `robot/scripts/realsense_dev.sh:142–155,189–277`：构建步骤用项目源码只读挂载、项目 build 目录可写、`--rm`、`--userns=keep-id`；build/check/install 的容器网络为 none。`install` 在项目 build 内 staging，并非直接写宿主 `/opt`。这些是优先补证据后可判的常规构建步骤。
- `robot/tests/test_realsense_wire.py:59–108`：创建唯一命名的临时 producer，项目 build 挂载、loopback 端口，清理会 `engine rm -f <本次名称>`。现有首版无资源归属证据，对清理一概人工。要支持此类测试需表达“清理自己的临时资源”，不能扩大成删除任意已有容器。
- `robot/src/ial_g1d/commands/realsense.py:245–278`：显式容器采集路径包含 USB `--device` 和清理。即使补脚本内容，设备访问也仍超出当前默认边界；不能把它与纯容器编译等同。

## 原因二：`--rm` 被当成 `rm -f`

两条直接 run（call seq 812、824）离线重放都满足：

```text
containerRisk(command) = undefined
isHighRisk(command) = true
```

命中的是 `rules.ts` 旧危险删除正则：

```js
/\brm\s[^;|&]*?-[a-zA-Z]*f[a-zA-Z]*[^;|&]*?(?:~|\$\{?HOME\}?|(?:^|\s)\/(?:[\w.$-]|$))/
```

它跨 token 搜索：

1. `\brm` 可以命中 `--rm` 中的 `rm`（前面的 `-` 是非单词字符）；
2. 后面任意 `-…f…` 可以命中镜像标签 `realsense-official` 的 `-official`，并不要求是 `rm` 的 flag；
3. 后面的容器内绝对路径 `/app/…` 又满足“绝对路径目标”。

最小差分（只做字符串分类，**没有执行下面的 Podman**）：

```text
podman run --rm --network none -v "$PWD/out:/app:ro" \
  localhost/realsense-official:2.59.1 ldd /app/bin/camera
  → highRisk=true，containerRisk=undefined

同命令将镜像名换为 localhost/app:2.59.1
  → highRisk=false

保留原镜像名，仅去掉 --rm
  → highRisk=false

rm -f /home/u/untracked.txt
  → highRisk=true（必须保留）
```

去掉 `--rm`、改镜像名只是定位误报的差分探针，**不是运行时规避审批的建议**。

本次已将原命令 812/824 输入 `isHighRisk`，断言普通只读 probe 不应命中删除规则，结果为 `AssertionError: BUG: disposable, project-only read-only probes are incorrectly sent straight to human as rm -f`。这是已执行、秒级、无需模型/容器的红色复现，可直接成为后续回归测试。

## 原因三：意图截断与观测缺口

### 长交接丢了正式 Task

首条人类输入 seq 9 有 **13,184 字符**，`## Task` 位于 **12,841**。`collectEvidence()` 的人类 prompt 总预算为 12,000 字符，超长时取前缀，所以正式任务尾段被截掉；仍保留前文 Goal/Next steps 等语义，不能断言模型因此完全没看到授权。

以实际事件重建 ask 555/576/813/837/936 的证据：目录均正确为 robot workspace；用户 prompt 都为 12,000 字符前缀 + 截断标记；没有脚本源码。13 次待批命令最长 394 字符，**不是**之前修复的 8000 命令预算问题，也不是 PTC call-id 恢复问题。

### 无理由 defer 无法溯源

首次 ask 555 在约 6.763 秒后排队 defer 通知，之后约 15 分 53 秒才由后方批准。判官默认 timeout 为 15 秒，因此不能把这次直接描述成“耗尽 15 秒超时”。当前 `judge()` 对匹配失败、异常等都返回同样 `{ verdict: 'defer' }`，也不保留 failure category；正常 `VERDICT: defer` 没理由时也同形。

`journalctl --user -u dsh-web` 的目标时间窗只有 3 条非审批的 LLM 目录消息，没有 auto-permit info/error，可用日志不能进一步区分。需要新增分类观测，不能依据 absence 推断请求没有进入插件。

## 部署核对

当前 Inspect `Config.listConfigs` 返回 `include:auto-permit` 为 schema 状态，实际名字是 workspace 的 `file:///…/packages/auto-permit/lib/index.js`，不是 npm 包名。因此以 `name: dsh-auto-permit` 查询空结果**不代表未加载**。

当前 systemd 声明式 overlay 的非秘密字段：

```yaml
auto-permit:
  enabled: true
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: high
```

当前构建产物 `PROMPT_VERSION=dsh-auto-permit-v4`；该历史会话的 10 条判官理由也明确引用 rule (3)，足以排除“整场未启用 auto-permit / 完全未加载容器判据”。没有历史热配置快照，不能把当前具体模型与所有历史请求绑定为确定事实。

独立风险：当前 cmd-permit overlay 仍含旧 `rtk,cargo,direnv` Full access 白名单，虽仓库种子已清空，部署显式配置不会自动迁移。它没有覆盖这些直接 Podman/脚本请求（本场没有白名单通知），**不是本次反复审批根因**；应由用户在 flake 里另行审阅，不能 agent 顺手改配置。

## 最小改进顺序（尚未实施）

1. **先修误报与观测**：危险删除规则必须识别删除命令/参数，而非从 `--rm`、镜像名、普通参数中拼出形状；保留真实危险 rm 的人工路径。defer 加 `policy / invalid-response / empty-response / provider-error / timeout / budget / unavailable-evidence` 等稳定分类和耗时，不能只记录一个空理由。
2. **让受限证据到达判官，而不是取消审批**：按待批调用补充实际引用的项目脚本及必要相邻内容，记录来源/内容版本/省略项，严格当非可信数据。对源代码已经变化的调用重新读证据；不可仅凭路径名或 agent 的“脚本安全”声明放行。
3. **微调 wrapper 政策使证据可被利用**：当前“必须直接调用”的绝对条件要改成“有效操作在证据中可确认”。先覆盖有界 shell 构建 wrapper，未知的间接调用继续人工；pytest/资源清理按真实需求另一步收敛。只加文件证据却保留直接调用硬要求，仍会全 defer。
4. **保留完整当前意图**：长交接应保留首尾或单列有来源的 Task/最近人类授权，缺失明确标识；不能把主模型生成摘要冒充人类授权，也不要用无限上下文替代有界证据。
5. **如仍要减少重复点击，再设计有界任务授权**：绑定 workspace、脚本/配置内容版本、命令效果范围及临时资源身份；文件变化/新增设备/远端/持久卷操作即重审。不要退回“按 podman 命令头全放行”或只按字符串长期记忆。
6. **用本会话真实样本校准**：旧正则误报必须红→绿；build/check/install wrapper 用足够证据后可获判断；wire 测试只清理自己资源；USB/既有持久容器仍按独立权限处理。真实模型应测试“批准/让路的质量”，不能只断言 prompt 包含某一句。

本次不改代码、不自动加白名单、不改 Podman storage、不启动容器、不调用付费判官重放、不重启服务。子代理因 `ctx.subagents.startContinuable is not a function` 无法启动，以上为直接调查而非独立代理复核。

## 可重复核验

下面只统计日志，不运行历史命令：

```sh
zstd -dc "$DSH_HOME/sessions/--home-sikongjueluo-Projects-robot--/83e31667-da14-460b-b961-32900fe1caf6/session.v4.jsonl.zstd" \
  | python3 -c 'import sys,json,collections
es=[json.loads(l) for l in sys.stdin if l.strip()]
asks=[e for e in es if e.get("type")=="approval/asked"]
notices=[e for e in es if e.get("type")=="user/message" and e.get("data",{}).get("source",{}).get("kind")=="auto-permit"]
assert len(asks)==len(notices)==13
print("approval requests:",len(asks),"auto-permit notices:",len(notices))
'
```

历史条目不可变；未来代码修复只影响离线分类与新的审批，不会把这些旧通知改成 allowed。
