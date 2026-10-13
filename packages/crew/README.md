# dsh-crew

固定路由的委派工具组：`subagent_quick`（便宜快，默认档）、`subagent`（主力）、
`subagent_smart`（最强最贵，保留档）、`create_agent`（常驻角色代理）。
配套控制面 `send_message` / `interrupt_agent` / `list_agents` 来自 stock 的
`tool-subagent-control` / `tool-subagent-list-agents` 行。

## 为什么

stock `@deepseek-ai/dsh-tool-subagent` 挂多个实例时，工具的 description 是
同一段固定文案——模型选型时 schema 里没有任何成本/能力信号，只会扑向最
"正典"的 `subagent`。实测（2026-10-03/04 全部 workspace 的 `tool/call` 事件）
主力档 14 次、最贵 smart 档 4 次、便宜 quick 档仅 2 次：系统性
over-escalation。本插件把档位语义写进各自 description（工具定义是选型时最强
的信号），升级规则是失败驱动（"quick 的结果不够用才升档"），比难度预判可靠。

`create_agent` 起一个常驻角色代理：bootstrap 提示词让子代理确认角色后待命，
后续任务经 `send_message` 投递，适合同类反复工作（如固定职责的 reviewer /
researcher），省去每次委派重述上下文。

## 行为

- 路由在 Config 层钉死（quick=opencode-go/deepseek-v4.1-flash@max、
  workhorse=zai-coding-cn/glm-5.3@max、smart=openai-codex/gpt-6.1-sol@xhigh，
  默认值在 `src/index.ts`，可在 patch 层整体覆盖；`create_agent` 的 tier 枚举
  复用同三条路由）。工具不暴露 provider/model 参数，模型不能选模型。
- 行为对齐 stock 的 continuable 配置：后台默认（`run_in_background: false` 才
  前台等待并返回结果），前台等待时非 `completed` 结束映射为错误 + 诊断 + 部分
  输出，run 必 dispose。`create_agent` 恒为后台。
- depth 读取宿主 `subagent.maxDepth` 设置（默认 1），每次委派时解析。
- provider（默认 `spawn`）需要 `agentOptions` + `prepareContinuable` 能力，
  缺则挂载即报错。provider 后注册也行（`subagent/provider-added` 后补挂）。

## 档位降级（fallback）

每档可再钉一条 `fallback` 路由（`{ provider, model, reasoningEffort }`，
provider/model 留空即关闭）。委派时先预检钉死路由（`ctx.llm.resolveCallConfig`），
命中下面任一情况就改走 fallback：

- **路由不可用**——provider 未注册、模型被改名、effort 不受支持（预检抛错）；
- **套餐窗口用尽**——`planUsage` 服务（[dsh-plan-usage](../plan-usage/)，软依赖，
  缺席即跳过）报告该路由任一窗口 `percent >= 100` 且重置点未到。该读取有 2s
  预算（走服务自身 60s 缓存，冷缓存拉取超时即按"无数据"处理）——路由提示绝不
  拖慢它所路由的委派。

quick 档默认 fallback 到 deepseek-official/deepseek-flash@max：opencode-go 的
Go 套餐窗口（5h/周/月）用尽时，便宜档直接换官方链路，不必等重置。降级会在宿主
日志里告警，并在工具输出尾部附一行 `[crew] …`，调用方据此知道该档已降级。
fallback 也预检不过时两边的原因一起报错（fail loud）；该档没有配 fallback 时，
预检失败照旧直接抛错，窗口用尽则留在原路由上由 dsh-auto-continue 睡到重置点。

已知边界：预检只验路由与模型元数据，**不验凭据**（pi-ai 的 key 在真正发起请求时
才解析），所以 key 缺失/失效属于运行期失败，本插件不接管；运行中途撞限额时同
样走 dsh-auto-continue 的重置点重试，不会热切到 fallback。

## 验证

`pnpm -C packages/crew build && pnpm -C packages/crew smoke`——覆盖默认路由、
降级阶梯（路由不可用 / 窗口用尽 / 无 fallback / 两条都挂 / 取消不降级）与
真实 `apply()` 挂载后的委派路径（断言子代理收到的 `agentOptions` 与输出里的
notice）。


## 部署注意

挂本插件的 profile 应 disable stock 委派工具行：`tool-subagent`（防
`subagent` 工具重名）、`tool-subagent-fork`（继承父模型，旁路）、
`tool-workflow` + `workflow-ptc`（脚本自由选路，旁路）。保留
`tool-subagent-control` 与 `tool-subagent-list-agents`（crew 的控制面）。
完整落地步骤见 `docs/plan-dsh-crew.md` 与 `dev.patch.yml`。
