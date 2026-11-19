# dsh-auto-continue

在 DSH 模型请求失败或宿主重启后自动续跑，减少手动发送 `continue`。配额错误等待重置；短时服务故障在同一 turn 内补试；重启后的恢复从已记录的进度开始。

## 工作原理

DSH 在模型请求失败后、turn 关闭前派发 `agent/request-error` waterfall。返回 `{ kind: 'retry' }` 会在原 turn、原 step 中重新发请求，不追加用户消息，也不重做此前已记录的工具步骤。

- **短时故障**：优先沿用宿主重试。宿主未接管时，对 `SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` 以及 pi-ai 归为 `PI_AI_ERROR` 的精确提示 `The service is temporarily unavailable. Please retry later.`，每个失败 step 最多补试 4 次，间隔 5、15、30、60 秒。服务商要求更长等待时尊重结构化 `providerRetryAfterMs`；该字段缺失时，也识别报错末尾完整 JSON 正文中以秒为单位的非负数值 `retry_after`，并在宿主重试前传递等待提示。例如 Cloudflare 502 的 `"retry_after": 60` 会让下一次请求至少等待 60 秒。正文提示超过 2 分钟时直接停止这条普通重试路径；格式错误或非数值提示忽略。身份验证、其他未分类错误、显式关闭重试以及 `always` 路由不接管；不切换模型或服务商。
- **配额耗尽**：`QUOTA` 或原生重试未接管的 `RATE_LIMIT` 仍按套餐重置点等待。

```
QUOTA 失败 ──▶ planUsage 服务在？──▶ 查配额窗口 ──▶ 睡到 nextResetTime + 余量 ──▶ 同 turn 重试
                    │ 否 / 无数据
                    └─▶ 阶梯探测（2m,5m,10m,15m,30m…；4h 后加密到 5m）
```

- 与 plan-usage 是**软依赖**（`ctx.get('planUsage')`）：服务在就精确对齐重置点；不在或无该路由的 monitor，退化为阶梯探测，插件独立可用。
- 等待期间（turn 仍打开时）写 `llm/retry` 事件，Web 对话视图**原生渲染重试倒计时**；重启后被认领的等待在会话打开时补一条**折叠通知行**（`user/message` + `form: 'notice'`，auto-permit verdict 同款——`llm/retry` 有 turn/step 不变量，turn 关闭后写入会腐蚀日志，见 repair-llm-retry.py）——不再是静默黑盒。
- **操作员可见可控**：`/ac-status` 查看当前会话的等待（provider、触发时刻）；`/ac-cancel` 随时取消（清除记录 + 定时器 + 进行中的等待）。默认自动续跑，取消权在你。
- 默认总预算 `maxWaitMs` 6 小时（覆盖 5h 滚动窗口 + 余量）。若配额显示绑定窗口的重置超出预算（如周限额还有几天），立即放弃，turn 照常失败——不空等。
- **等待跨重启持久化**（默认开启，`persist: false` 关闭）：每次等待先原子写入 spool（`$DSH_HOME/storages/dsh-auto-continue/pending.json`）再入睡；进程重启/插件更新后，新实例在启动时认领记录，到点经 sessionController 冷启动会话（浏览器同款路径，含 preset 组装）并发送一条可见的续跑消息。护栏：超总预算的记录清理；用户在等待期间动过会话（`user/message` seq 更新）则放弃；agent 忙则稍后重试；续跑后若再限额则正常路径接管并重新持久化——可跨任意次重启持续工作。turn 中止（用户停止 / relay 对端拆 turn / 优雅停机的拆除顺序）**不**视为放弃：记录一律保留，由恢复时的 user-message 护栏与预算超时兜底；同进程内被中止的等待会立即重新武装到恢复定时器。

## 配置（cordis 行）

```yaml
- id: auto-continue
  name: dsh-auto-continue
  config:
    maxWaitMs: 21600000      # 首次接管后的总等待预算（默认 6h）
    resetMarginMs: 60000     # 重置时间之后的额外余量
```

## 推荐搭配

与 `dsh-plan-usage` 同装：用量可视 + 重置点对齐一起拿走。两行分别是 `plan-usage` 与 `auto-continue`。

## 开发

```fish
pnpm -C packages/auto-continue build
dsh --profile web --patch ./packages/plan-usage/dev.patch.yml --patch ./packages/auto-continue/dev.patch.yml --no-open --port 3180
```

验证：`pnpm -C packages/auto-continue smoke`（退避、配额调度、停止、公开的冷恢复接口和连续重启）。

## 重启恢复

插件在 `turn/start` 时将普通会话记录到 `storages/dsh-auto-continue/running.json`，在正常结束或手动停止时清除。正常停机留下的 `aborted/disposed` 和硬中断后由宿主补记的 `interrupted` 都可恢复。启动时，在 `resumeMaxAgeMs`（默认 12 小时）内通过公开的 `sessionController.resolveAgent()` 逐个打开会话。忙碌、归档、已完成或已收到新输入的会话不会被额外唤醒；子任务由父会话继续编排；已有配额等待记录的会话仍等到原定时间。`resumeOnRestart: false` 可关闭普通重启恢复。

已关闭的 turn 不能原地重试，因此重启恢复会由插件发送一条可见的续跑消息，提醒模型核实执行结果不明的工具调用后再继续。它不会重新激活已暂停的持久化 Goal，也不会回扫历史失败。如果旧版在关机时已经清空记录，升级不能补回那次中断。

## 已知限制

- 瞬时补试只覆盖模型适配器已经报告给 `agent/request-error` 的失败，不兜底插件或宿主内部抛错。
- 两种持久化记录均假定一个 DSH 进程写入；共享同一目录的多个进程不受支持。新 turn 的镜像尚未写入就被硬杀，也可能没有可恢复记录。
- 无 planUsage（或该路由无 monitor）时，配额路径只能按探测间隔恢复。
