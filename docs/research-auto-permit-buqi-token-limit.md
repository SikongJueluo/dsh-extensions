# 调研：Buqi 会话的 auto-permit 输出预算耗尽

日期：2026-11-17（Asia/Shanghai）。范围：诊断重复人工授权，不修改审批策略、部署配置或 Buqi 项目。

## 结论

这次重复人工授权的直接原因是 **auto-permit 判官响应达到输出 token 上限，插件主动回落到后方审批链**。此前增加的 Podman / 项目文件调查支持已经在工作，并非整体未部署。

固定检查目标会话最早完成的 7 次判官决定（原始事件 `seq <= 260`）：

- 5 次都是 `invalid-response: the judge output was truncated at the output token limit`。
- 2 次镜像构建成功自动放行，通知附有实际检查的 Containerfile 行号。
- 7 条原命令离线分类均未命中危险形状或容器硬边界，目录和用户任务证据也都恢复成功。

机制上，插件将每次模型请求固定为 **1024 输出 token**，部署却使用 `deepseek-flash + reasoningEffort: high`。真实 DeepSeek 适配器将其序列化为 `max_tokens: 1024`，同时开启 thinking；该 API 的输出预算包含思考 token。这是输出预算与思考配置不匹配的直接证据。

历史日志没有保留每次判官响应的 token usage、思考/正文长度和原始流，因此不能进一步断言这 5 次都把全部 1024 token 花在了思考上，也没有实测多大预算才能稳定解决。已确认的是 provider 的 token-limit 结束状态到达了插件，而非模型明确判断这些操作必须人工批准。

## 目标与证据

目标会话：`ed078b56-24b4-469c-a97c-9f78b58a00e2`，标题「Handoff: 实现模拟通信测试，并使其通过」，原始 workspace 为 Buqi 项目根目录。

一手来源：

1. [目标会话原始压缩日志](/home/sikongjueluo/.dsh/sessions/--home-sikongjueluo-Projects-buqi--/ed078b56-24b4-469c-a97c-9f78b58a00e2/session.v4.jsonl.zstd)。会话仍在运行，本报告固定 `seq <= 260`，不将调查期间增加的事件混入统计。所选审批发生于 00:28:52–00:35:28（+08:00）。
2. [已挂载插件 Config](../packages/auto-permit/src/settings.ts) 与运行时 Inspect：`Config.listConfigs(name=dsh-auto-permit)` 返回 `include:auto-permit`，精确查询返回安装目录 `/run/user/1000/dsh/profile-c7VYGb/node_modules/dsh-auto-permit`。
3. [启动生成的 auto-permit 配置](/run/user/1000/dsh/profile-c7VYGb/dsh-generated.patch.yml#L27-L32)：enabled=true、provider=deepseek-official、model=deepseek-flash、reasoningEffort=high；与 [Nix 声明来源](/home/sikongjueluo/.config/nixos/home/ai/dsh/plugins.nix#L71-L79) 一致。运行时生成路径是临时路径，重启后可能消失。
4. [判官预算](../packages/auto-permit/src/judge.ts#L73-L83)、[实际请求与截断处理](../packages/auto-permit/src/judge.ts#L423-L458)。
5. [当前安装的 DeepSeek 适配器](/nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js#L1720-L1734)：输出预算与 thinking 参数的实际映射；同文件 1927–1933、2002–2027 行将 provider 的 `max_tokens` stop reason 转成 `max-tokens` finish。
6. [DeepSeek Messages API 官方说明](https://api-docs.deepseek.com/api/create-message/)：`max_tokens` 包含 thinking tokens，`thinking.type: enabled` 开启思考，`high` 为思考强度。已通过 Context7 查询并读取官方页面。
7. [之前的 Podman 调研及 v5 后续实施记录](research-auto-permit-podman-runtime-routing.md#L189-L212)：先前问题主要是 wrapper 证据缺失及 `--rm` 正则误报，本次样本呈现不同的失败类别。

安装目录中的宿主产物解析到本仓库 [auto-permit 构建产物](../packages/auto-permit/lib/index.js)，两条路径 sha256 相同，为 `6042bcb1f50c97ab4c21f13d98aa1ca6248f6521d0c5d7be6cdd494f5821b044`；导出的 prompt version 为 `dsh-auto-permit-v5`。这确认当前磁盘安装指向，不单凭哈希推断进程内历史模块字节；历史中实际读取项目文件并放行的通知另行证明 v5 调查能力已参与本会话。

## 逐项审批结果

`ask` 为审批请求事件，`notice` 为之后投递到对话表面的插件通知。通知先进入 next-step inbox，表面呈现较晚；不能按表面顺序推断插件是在人工决定之后才运行。

| 时间（+08） | ask → notice | 操作摘要 | auto-permit 结果 |
| --- | --- | --- | --- |
| 00:28:52 | 45 → 59 | `podman info --format …` | invalid-response，输出 token 截断，交后方 |
| 00:29:22 | 73 → 83 | `podman ps` | 同上 |
| 00:31:09 | 132 → 142 | `podman pull python:3.12-slim` | 同上 |
| 00:33:11 | 185 → 197 | `podman build -f containers/python/Containerfile …` | 自动放行；检查行号 9–64 |
| 00:33:42 | 207 → 218 | 同项目构建，增加 `--http-proxy=false` | 自动放行；检查行号 1–65 |
| 00:34:51 | 230 → 242 | 网关镜像大小检查、`podman load`、一次性 `run --help` | invalid-response，输出 token 截断，交后方 |
| 00:35:28 | 246 → 260 | Nix closure 引用查询与一次性 `podman run` | 同上 |

5 条失败通知给出的理由完全相同：

```text
judge (invalid-response): the judge output was truncated at the output token limit
```

这段文字由插件针对 `finish.kind === 'max-tokens'` 生成，不是判官自己给出的政策理由。分支在正文 verdict 解析之前直接返回，因此即使片段内已有 `VERDICT: allow`，也不会把截断响应视为有效批准。[代码依据](../packages/auto-permit/src/judge.ts#L444-L463)。

原始 `approval/decided` 记录这 7 次最终均为 `allowed-once`，但不记录批准者。上述 5 次回落可确定 auto-permit 未批准、请求交给了后方链路；单看最终 outcome 不能证明由哪位用户或哪一个后方 answerer 批准。

## 为什么支持 Podman 后仍会反复出现

有两个独立层次：

1. **执行沙箱仍会挡住 Podman 运行时写入。** 会话 `seq 0–2` 为 workspace-write / ask。`seq 64` 的工具结果显示 `/run/user/1000/libpod` 设置 sticky bit 时遇到 read-only file system；`seq 71` 显示该运行时目录在沙箱中只读；获批后的 `seq 79` 能列出容器。这里的拒绝会触发命令级提权流程，不等于宿主 Podman 损坏。
2. **auto-permit 负责替每次提权作决定，不发放永久 Podman 权限。** 插件批准返回 `allowed-once`，不切换 session 的沙箱模式。容器命令还刻意不使用精确重复记忆，必须重新判断可变文件和引擎状态；见 [审批入口](../packages/auto-permit/src/index.ts#L307-L344) 及 [现有行为说明](../packages/auto-permit/README.md#L24-L37)。判官多次耗尽输出预算，就表现为一次次重新请人批准。

1024 是**每个模型 step** 的输出上限；最多 6 step、总时限 45 秒是其他预算，不会替单次截断请求补 token。`max-tokens` 分支立即返回，没有后续 step 续判。[预算及分支依据](../packages/auto-permit/src/judge.ts#L73-L83)。

## 排除与保留的假设

| 假设 | 核查结果 |
| --- | --- |
| 之前的 Podman 支持完全未加载 | 不支持。Inspect 有已挂载行；历史两次构建实际检查文件并自动放行，部署产物导出 v5 |
| 再次命中旧 `--rm` / 强制删除正则误报 | 不支持。7 条完整原命令均 `isHighRisk=false`、`containerRisk=undefined`，历史通知也不是硬规则通知 |
| 命令过长 / 长交接丢失正式 Task | 不支持。7 条命令为 48–339 字符；折叠后用户 prompt 共 8171 字符，保留「实现模拟通信测试，并使其通过」 |
| 工作目录 / 证据无法恢复 | 不支持。逐条恢复的 workspace、resolvedWorkdir 均为 Buqi 根目录，待批 call 均存在 |
| provider 适配器把普通正常结束错误映射为截断 | 离线测试未发现。正常 `end_turn` → allow；`max_tokens` → invalid-response，与源码映射一致。没有历史原始 SSE，无法绝对排除服务端错误报告 |
| 1024 输出上限与 high 思考配置不匹配 | 强支持。历史 5 次明确结束于 token-limit；部署与真实适配器离线回放确认请求参数组合；API 官方语义包含思考 token |
| 实际容器操作按政策应当回人工 | 本次 5 次失败未走政策 DEFER，而是在解析 verdict 前截断。预算修复后仍可能有独立的政策回人工项，不能承诺所有历史命令都会允许 |

特别是 Nix store 查询、后续双网络创建/销毁、独立 stop/exec/rm 等，仍需按其实际效果分别判断。当前容器规则保留既有资源生命周期与归属证据限制；解决截断不等于解除这些边界。[现有边界](../packages/auto-permit/README.md#L186-L224)。

## 已执行的验证

### 原始日志与完整命令重放

读取压缩日志，固定 `seq <= 260`，按每个 ask 的历史前缀调用当前部署产物导出的 `collectEvidence()`；逐条执行 `isHighRisk()` 和 `containerRisk()`。结果：7 条 call 全部恢复，硬规则全未命中，目录和正式 Task 保留。

原始日志的快速复核命令（仅统计，不执行历史命令）：

```sh
zstd -dc /home/sikongjueluo/.dsh/sessions/--home-sikongjueluo-Projects-buqi--/ed078b56-24b4-469c-a97c-9f78b58a00e2/session.v4.jsonl.zstd \
  | python3 -c 'import json,sys
es=[json.loads(s) for s in sys.stdin if s.strip()]
ns=[e for e in es if e.get("seq",-1)<=260 and e.get("type")=="user/message" and e.get("data",{}).get("source",{}).get("kind")=="auto-permit"]
texts=["\n".join(b.get("text","") for b in n["data"]["content"]) for n in ns]
bad=sum("judge (invalid-response): the judge output was truncated at the output token limit" in t for t in texts)
assert len(ns)==7 and bad==5, (len(ns),bad)
print("PASS: 7 judge notices; 5 output-limit deferrals; 2 automatic allows")'
```

### 真实 judge + 真实适配器，离线 SSE 回放

在独立 Node 进程导入当前部署 [judge](../packages/auto-permit/lib/index.js) 与上述已安装 DeepSeekAdapter；用 ask 73 的真实历史证据。只替换该测试进程内的 `fetch`，不读取凭据、不联网、不执行 Podman；为适配器提供空认证、空 request extensions，provider 默认输出预算设为 256000。

捕获最终发送体均为：

```json
{"max_tokens":1024,"thinking":{"type":"enabled"},"output_config":{"effort":"high"}}
```

| 注入的 provider SSE | 实际 judge 结果 |
| --- | --- |
| thinking 块 + `stop_reason=max_tokens` | defer / invalid-response / 与历史完全相同的截断理由 |
| 完整 `VERDICT: allow` + `stop_reason=end_turn` | allow，1 step |
| `VERDICT: allow` + `stop_reason=max_tokens` | defer / invalid-response，保持拒绝接受截断批准的保护 |

3 个场景的断言均通过。这是参数映射和回退机制验证，**不是**重新调用真实模型测量截断概率，也不构成增加 token 预算后的效果验证。

现有定向回归也通过：

```sh
pnpm -C packages/auto-permit exec vitest run test/judge.test.ts -t 'truncated model output'
# 1 passed，43 skipped；测试正文见 test/judge.test.ts:542–554
```

该测试确认截断时正确回人工；它没有校准真实 high 思考模型能否在 1024 token 内稳定完成调查。

## 最小改进建议（未实施）

1. **先解决预算匹配，并保留截断回人工。** 对当前 high 思考判官，以更大但有界的单步输出预算做真实样本校准，例如把 4096 / 8192 作为实验候选；保留总时限、工具权限和完整 verdict 校验。不能仅因输出片段出现 allow 就放行，也不能宣称某个候选数值已经足够。
2. **配置侧可另行校准较低 effort。** 当前适配器支持 `low` 与显式 `off`；后者会禁用 thinking。降低 effort 可能改变判决质量，需同时校准应允许和应回人工的样本。仅删除 `reasoningEffort: high` 不等于关思考，适配器未指定时默认仍为 high；见 [适配器文档](/nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/README.md#L55-L63)。
3. **不能只增大全局 provider 的 maxTokens。** auto-permit 显式传入的 1024 优先级更高；离线已用 provider=256000 验证仍发送 1024。需要改判官请求预算，或在插件中增加有界配置入口；当前 Config 仅 enabled/provider/model/reasoningEffort。
4. **补齐预算观测与真实模型校准。** 记录请求预算、effort、finish kind、输出 usage、正文/思考长度和耗时，不保存思考全文或秘密。按已授权的数据外发范围运行选定真实样本，分别统计截断率、允许/回人工是否恰当和延迟；不能仅靠 mock 回退测试宣布解决。
5. **独立处理多容器生命周期授权。** 若后续需要自动执行网络与容器的创建、重启、清理，必须提供可验证的本任务资源归属和范围。那是当前策略能力的后续设计，不是这 5 次输出截断的修复。

本次仅新增本调研文档；未修改实现、测试源码、profile、Nix 声明、权限范围或网络，未重启服务、未运行容器、未重新调用付费判官。

## 调查限制

- 目标会话仍在运行，结论针对上述固定历史窗口，不代表之后所有审批的总数或类别。
- 历史 judge 原始 SSE/usage 未留存；无法给出每次 thinking 与正文的精确 token 分配，也没有验证更大预算或不同 effort 的真实效果。
- 用户服务总线在当前沙箱内不可连接；`journalctl --user -u dsh-web` 所选时间窗没有返回可用 auto-permit 日志。诊断以会话持久事件、已挂载目录、生成配置、源码和离线适配器回放为依据。
- 委派被当前运行时禁用，因此本次为直接调查，没有独立子代理复核。
