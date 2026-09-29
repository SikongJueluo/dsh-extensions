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
- 每次等待前写一条 `llm/retry` 会话事件（与内置重试同格式），Web 对话视图**原生渲染重试倒计时**；等待可随时被用户取消（turn abort）或插件卸载中止。
- 默认总预算 `maxWaitMs` 6 小时（覆盖 5h 滚动窗口 + 余量）。若配额显示绑定窗口的重置超出预算（如周限额还有几天），立即放弃，turn 照常失败——不空等。
- **等待跨重启持久化**（默认开启，`persist: false` 关闭）：每次等待先原子写入 spool（`$DSH_HOME/storages/dsh-auto-continue/pending.json`）再入睡；进程重启/插件更新后，新实例在启动时认领记录，到点经 sessionController 冷启动会话（浏览器同款路径，含 preset 组装）并发送一条可见的续跑消息。护栏：超总预算的记录清理；用户在等待期间动过会话（`user/message` seq 更新）则放弃；agent 忙则稍后重试；续跑后若再限额则正常路径接管并重新持久化——可跨任意次重启持续工作。用户取消等待会删除记录，插件卸载则保留。

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

## 已知限制

- 跨重启的恢复走**新 turn + 续跑消息**（重启后原 turn 已被 crash-recovery 标记 interrupted），非同 turn 原样重试；语义等价于准点自动发送 continue。
- 单 dsh 进程假设：多进程共用同一 spool 最坏会重复一条续跑消息。
- 无 planUsage（或该路由无 monitor）时只能探测，恢复延迟 = 探测间隔。
