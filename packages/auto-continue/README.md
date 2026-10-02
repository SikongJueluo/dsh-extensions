# dsh-auto-continue

GLM Coding Plan 限额后**自动续跑**：当模型请求因套餐限额失败（`QUOTA`，如 *"The usage limit has been reached"*；或内置重试耗尽后的 `RATE_LIMIT`），插件接管恢复——经 `planUsage` 服务（[dsh-plan-usage](../plan-usage/)）读套餐配额窗口，**睡到重置点后原样重试失败的 step**。不需要你再手动发 "continue"。

## 工作原理

DSH 的 agent loop 在模型请求失败后、turn 关闭前会派发 `agent/request-error` waterfall。返回 `{ kind: 'retry' }` 即可让 loop **在同一个打开的 turn 内、基于同一份持久化历史重跑失败的 step**——没有新的用户消息、没有额外 prompt token，重建的请求还能吃到 provider 的 prompt cache。内置 `llm-retry` 只为短瞬断设计（默认不重试 `QUOTA`，backoff 上限 10s），本插件作为它的下游接管长窗口场景：

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

验证：`pnpm -C packages/auto-continue smoke`（调度数学 + 恢复流三路径：委派 / 探测 / 重置对齐重试）。

## restart-resume（跑动任务的跨重启续跑）

限额等待之外，**重启时正在运行的会话**也会自动续跑：插件把 RUNNING 会话集合在每次状态变化时镜像到 `storages/dsh-auto-continue/running.json`（停机顺序无关，硬杀也基本覆盖）；下次 boot 在 `resumeMaxAgeMs`（默认 12h）窗口内逐个冷启动并发送续跑消息。护栏：最后一 turn 已 `completed` 的跳过（状态写入与死亡的竞态）；用户手动停止的会话不在镜像中（停止即写 idle）；subagent 会话不独立恢复（由父会话继续编排）；恢复后若撞限额则自然进入配额等待路径。`resumeOnRestart: false` 可关。

## 已知限制

- 跨重启的恢复走**新 turn + 续跑消息**（重启后原 turn 已被 crash-recovery 标记 interrupted），非同 turn 原样重试；语义等价于准点自动发送 continue。
- 单 dsh 进程假设：多进程共用同一 spool 最坏会重复一条续跑消息。
- dsh 0.2 无宿主插件热重载（`patchReload` 为残留字段）；换插件版本仍需重启进程——restart-resume 即为重启的补偿。
- 无 planUsage（或该路由无 monitor）时只能探测，恢复延迟 = 探测间隔。
