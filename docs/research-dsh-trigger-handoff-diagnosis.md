# trigger / handoff 故障与配置界面调研

- 日期：2026-10-22
- 对象：`dsh-triggers 0.1.0`、`dsh-handoff 0.2.0`；DSH `0.2.0-rc.2`、Cordis `4.0.4`。
- 用户确认的主要症状：**handoff 新会话在执行，但没有自动回来审核**；trigger 界面难以理解，handoff 的审核配置混在工作区选择中、容易漏选。
- 本次只调研：未改插件源码、现有测试、构建产物或运行配置；未启动真实 LLM 交接。复现用隔离 Cordis / 内存服务 / 客户端 VM。

## 结论

这是**真实集成缺陷 + 缺失的操作闭环 + 易漏选的交互**叠加，不是用户单纯不会配置。

1. **自动审核即使开启也会绑定失败**：`TriggerService` 使用 ES `#` 私有字段和方法，跨插件 `ctx.get('triggerBindings')` 返回的 Cordis trace Proxy 不满足私有成员品牌检查，`bindReviewLoop()` 抛 `TypeError`。handoff 捕获后继续普通交接，执行者没有 runId / 审核指令，因此不会交回审核。已用真实 Cordis 与真实两包构建产物复现。
2. **trigger 面板新建完规则却不能启动**：后端有 `run.start`，客户端只有未使用的文案，没有调用入口。新建规则组不等于已创建运行。
3. **handoff 工作区行点击即提交**，审核开关却放在列表下方；单工作区/指定工作区时，开关放到模型列表底部，进入思考强度步后又消失。已通过真实客户端逻辑复现默认 `review.enabled=false` 被提交。
4. **trigger 会话选择器丢标题、短 ID 又截到公共前缀**：普通 `session-*` 会话全部显示 `session-`。此外有草稿角色错绑、模板串写/删除异常、运行状态不自动刷新等实际缺陷。
5. **后端还有独立编排缺陷**：另一方同编号回合可误提交本方信号；失败投递重投成功后 run 仍暂停，审核回复被拒绝。均已隔离复现，但没有证据说明用户那次已走到这两个阶段。

## 1. 证据来源与验证边界

### 当前加载与持久状态

- Host Config inspect 的 `include:triggers` / `include:handoff` 指向本仓 `packages/{triggers,handoff}/lib/index.js`，不是另一个 npm 安装副本。构建产物时间均为 2026-10-22 14:15 左右。
- Client Slots inspect：`sidebar.panellist` 中 `dsh-triggers` 为 active，说明不是整个客户端模块未注册。**slot active 不代表界面操作已验证可用**。
- 只读默认存储 `~/.dsh/storages/triggers.json`：templates=3、bindings=0、runs=0、deliveries=0。这与「从未成功绑定」一致，**但不能单凭空表证明用户曾开启审核、每次都失败，或当前活跃后端一定使用这份文件**。
- 本仓 `.dsh/handoff` 三份已 spawn 的 meta（10/20~21）都没有 `review` 节；其中两次原会话的 `command/run` 也未带 `--review`。这些记录只说明其持久记录中没有审核意图，无法区分漏选、当时构建版本更旧等原因，不能代替故障现场。
- 未认证的只读 `/dsh-triggers/state` 请求返回 HTTP 401；没有重试绕过认证或更改权限。
- Host Service inspect 不列出 `triggerBindings` **不是未注册证据**：该目录来源于宿主构建期 API 清单，不包含第三方动态服务（`dsh-tool-cordis/lib/types/api-catalog.js:15`）。隔离真实 Cordis 中服务可取得。

### 已执行验证

| 验证 | 结果 | 能证明什么 |
| --- | --- | --- |
| `pnpm --filter dsh-triggers test` | 2 文件、31/31 通过 | 既有纯引擎与直接实例化 service 的测试通过；不证明跨插件调用可用 |
| `node .dsh/trigger-handoff-contract.mjs` | 绑定处 RED；直接调用同样抛 TypeError | 真实 Cordis + 双插件的自动审核路径失败；无 triggers 时普通交接能继续 |
| 最小 Cordis 私有/普通成员对照（文末） | 因果对照通过 | 同样的服务访问，只有 ES 私有成员发生品牌检查异常 |
| `node .dsh/trigger-ui-repro.mjs` | 6/6 RED | 模板状态/删除、草稿角色、短 ID、handoff 两种漏选路径 |
| `node .dsh/trigger-runtime-repro.mjs foreign-turn` | RED，两次一致 | 对方同号 turn/end 可误推进 |
| `node .dsh/trigger-runtime-repro.mjs redeliver` | RED，两次一致 | 重投成功，审核信号仍被暂停状态拒绝 |
| `node .dsh/trigger-runtime-repro.mjs same-turn-two-runs` | RED | 服务边界允许两信号但只消费第一条；真实工具路径覆盖有限，见后文 |

上述 `.dsh/` 脚本是已忽略的本机诊断材料，不是已纳入正式测试的修复；运行时间均为秒级。集成 harness 在首个阻断点失败后会中断后续场景，**不能宣称全部后续断言已运行或修复后必然全绿**。其一个 meta 检查存在 `undefined === undefined` 假阳性，不将该 PASS 当成绑定成功证据。

客户端 VM 加载真实 `client.js`，只在内存增加测试导出，模拟 React hooks/createElement。没有浏览器点击实测、布局截图、亮暗主题和移动端验证。模板切换测试直接复用编辑器实例，需结合父组件没有 `key` 的源码判断；未来若用父级 key 修复，须相应更新测试接缝。

## 2. 自动审核不工作：跨插件服务被 Proxy 包装后私有成员失效

### 完整触发链

1. `TriggerService extends Service`，保存 `#config / #store / #readyPromise / #currentTurn / #chains`，并以 `#ready()` 等私有方法实现业务（[`service.ts:94-108`](../packages/triggers/src/service.ts#L94-L108)）。
2. handoff spawn 在首条执行 prompt 前调用 `ctx.get('triggerBindings').bindReviewLoop(...)`（[`spawn.ts:177-205`](../packages/handoff/src/spawn.ts#L177-L205)）。
3. Cordis 的服务基类给实例增加 tracker；`ctx.get()` 经 `getTraceable()` 包装服务，方法调用又经 `createShadowMethod()` 将 `this` 替换为 shadow Proxy。见 `node_modules/@deepseek-ai/cordis/lib/index.js:109-152,763-765,1763-1788`。
4. `bindReviewLoop()` 调 `this.#createLoop(...)` 时，`this` 已不再是通过类构造器完成私有品牌初始化的原始实例，立即异常。不是请求字段名不匹配，也不是模型忘记提交信号。
5. handoff catch 后记录 warn、向原会话发 followup，并返回 `undefined`（[`spawn.ts:206-224`](../packages/handoff/src/spawn.ts#L206-L224)），随后照常给新会话普通 bootstrap prompt（[`spawn.ts:263-272`](../packages/handoff/src/spawn.ts#L263-L272)）。
6. `bootstrapPrompt` 的 review 参数缺失，新会话拿不到 `[triggers]` / runId / 信号规则（[`brief.ts:184-196`](../packages/handoff/src/brief.ts#L184-L196)）；无 run 可推进。

### 复现信号

```text
PASS  S1 cordis service registration: ctx.get("triggerBindings") visible across plugins
PASS  S1 command succeeds / result announces auto review
PASS  S1 fresh session spawned
--- direct bindReviewLoop THREW: TypeError: Receiver must be an instance of class anonymous
    at Proxy.bindReviewLoop (.../packages/triggers/lib/index.js:930:30)
    at Object.apply (.../node_modules/@deepseek-ai/cordis/lib/index.js:120:36)
FAIL  S1 exactly one binding bound to origin as parent — []
FAIL  S1 run active in awaiting-delivery, budget 5 — []
FAIL  S1 bootstrap prompt carries [triggers] section with runId
```

另一个容易误导用户的环节：命令在绑定尚未发生时已经显示 `Auto review: 开启`，那只是用户选择的**意图**，不是后台绑定成功。绑定失败没有阻止执行，也没有独立可见的失败状态；一条排队给原 agent 的 followup 不能替代操作结果卡。

### 为什么现有测试漏掉

- [`service.test.ts:82`](../packages/triggers/test/service.test.ts#L82) 直接 `new TriggerService(fakeCtx)`，绕过 Cordis 服务解析和 Proxy。
- `handoff/smoke.mjs:37-43` 的 `ctx.get` 桩没有返回 triggers，缺少「两个插件都挂载 + 开启审核」接缝。
- 插件内部的工具和 HTTP 通道都持有原始 service 实例（[`index.ts:47-49`](../packages/triggers/src/index.ts#L47-L49)），所以工具可注册、面板可读，不等于 handoff 的跨插件调用可用。

### 修复方向

必须处理**所有 `#` 私有字段和私有方法**，不能只改五个字段而保留 `#createLoop/#ready`。优先采用与 Cordis 服务代理兼容的普通成员 / TypeScript `private`；不要绕过 Cordis trace 直接绑定原实例，从而丢失上下文语义。若采用 facade / WeakMap，也须解决 Proxy 身份问题并用真实 Cordis 回归，不能认为 WeakMap 自然兼容代理。

回归最小接缝：真实 Cordis `Context` + 挂载 TriggerService + 另一插件经 `ctx.get().bindReviewLoop()`；再补双插件 handoff spawn、meta、首 prompt、信号与回审的闭环。

## 3. Handoff 为什么容易漏选审核

### 多工作区：选工作区等于立即结束流程

- 审核开关位于工作区列表之后（[`client.js:421-491`](../packages/handoff/client/client.js#L421-L491)，尤其 :475）。
- 每行的 `onPick` 调 `pickWorkspace`，后者直接 `finalize`，没有「选中 → 下一步/确认」阶段（[`client.js:311-315`](../packages/handoff/client/client.js#L311-L315)、:454）。
- VM 实际点击一次工作区行：

```text
choose calls after one workspace row click: 1
payload: {"kind":"inherit","workspace":"ws-1","review":{"enabled":false,"rounds":5}}
```

因此用户先完成眼前的“选工作区”，流程就已提交，根本来不及检查下面的自动审核。这是正对用户反馈的设计问题，不应靠提醒用户“记得先勾选”解决。

### 单工作区 / 指定 `--workspace`：最终强度步不提供开关

没有工作区步时，开关被移到模型列表底部（[`client.js:626`](../packages/handoff/client/client.js#L626)）；选带 reasoning 的模型后进入强度步，该分支不渲染开关（[`client.js:495-540`](../packages/handoff/client/client.js#L495-L540)）。VM 得到：

```text
effort step has review toggle: false
final choose payload: { ..., "reasoningEffort":"high", "review":{"enabled":false,"rounds":5} }
```

开关不是从未存在，而是最后一步不可达；用户必须预先在模型列表勾选，或返回上一步。

### 其它确定的流程不一致

| 场景 | 实际流程 / 问题 |
| --- | --- |
| `--model` + 多工作区 | 直接工作区步，但不显示已固定模型的摘要 |
| `--model` + 单工作区 | 仍问模型；用户选择最终被 flag 覆盖（`command.ts:441-448,699`） |
| `--model` + `--workspace` | 跳过整个弹窗，无法在 UI 开审核；须另给 `--review`（`command.ts:682-684`） |
| 最终提交 | 只关闭弹窗；无模型/工作区/审核结果摘要或运行入口（`client.js:248-251,663`） |
| 模型目录失败 | 同时显示错误和“没有可用模型”，无重试（`client.js:574-577,620-622`） |

**建议流程**：模型 → 思考强度（如有）→ 工作区 → **独立「自动审核」设置** → 本次交接摘要 → 固定「开始交接」按钮。行点击只选择；不因单工作区/旗标绕过审核决策。摘要明确“执行者=新会话、审核者=当前会话、最多 N 轮”。异步绑定后显示“已开启 / 绑定失败”，并提供打开运行的入口。保持审核默认关闭，不在未经确认时自动开启。

## 4. Trigger 界面不是仅仅不好看，而是操作闭环缺失

| 优先级 | 已确认问题 | 源码 / 复现 |
| --- | --- | --- |
| 高：无法独立启动 | 客户端没有 `run.start` 调用，只有闲置 locale；后端端点存在。新建规则后无法从面板开始运行 | `triggers/client/client.js:58,93,353-475`；`src/channel.ts:48-52`；README :15 却写 UI 启动 |
| 高：无法辨认会话 | service 不回传标题；client `slice(0,8)` 将所有 `session-*` 显示成 `session-`，目标列与投递记录也受影响 | `src/service.ts:398-410`；`client.js:145-147,291-298,560-570`；VM T4 RED |
| 高：误配角色 | 草稿两边都是空时，第二行也被判成 executor；先选审核者会写进执行者字段 | `client.js:322-331`；VM T3 RED |
| 高：模板串写 | 切 A→B 无 key 重挂载/状态同步，保存 B 时提交 A 内容，可能覆盖错误模板 | `client.js:478-498,601-615`；VM T1 RED |
| 高：模板操作异常 | 新模板的 tpl=undefined 仍显示删除，点击读取 tpl.id 抛 TypeError | `client.js:530-533,613-614`；VM T2 RED；事件处理异常不等同于已证实整页卸载 |
| 中：草稿保存易丢 | 两侧选好即自动保存并立即清草稿，不等待成功；失败丢配置，同会话错误却写“不能为空” | `client.js:307-313,355,578-583` |
| 中：编辑不透明 | 名称/初始预算不可编辑；没有保存/取消；客户端不带 name，更新时可能重置服务端名称 | `client.js:300-304,369,627-628`；`service.ts:467` |
| 中：状态像卡住 | 主面板仅挂载/操作/手动刷新，无自动更新；运行不显示 task/history，投递不展示单条 error | `client.js:438-472,576,660-664` |
| 中：反馈消失 | 标题 chip 拉取失败直接消失；控制失败不报错，取消也没有面板中的确认 | `client.js:691-700,720-723,744-745` |
| 中：表格语义错位 | 五列表头下第三行却放启用、预算、跨列名称、操作，用户无法从列名理解字段 | `client.js:353-390,636-644` |

补充：新模板保存后不切到已保存 id，重复保存可创建多份（`client.js:493-498,613-614`）。简介还宣称与“单向通知共用表格”（:51），但 README :102-105 将单向通知列为未实现功能，产品文案超前。

短 ID 的边界：宿主 Web controller 默认 `session-${randomUUID()}`（`dsh-api-session-controller/lib/index.js:688`），store 未指定 id 时可生成 `session-<n>`（`dsh-session/lib/index.js:1683`），两者都会塌缩。handoff 自铸无前缀 UUID（`handoff/src/spawn.ts:31-32`），不会全部塌缩，但仍缺标题，不能概括为“所有会话都是同一个 ID”。

**建议首屏**：先做“新建执行—审核任务”，按执行者、审核者、任务、轮预算、模板逐步配置，显式保存并启动。已有任务卡显示双方标题/工作区、当前轮次、最近推进、错误与下一步操作。把通用模板/高级规则放到次级区，不让新用户先理解两条方向行、binding 与 run 的内部模型。启用规则只影响新运行还是现有运行也应明确说明。

## 5. 已复现的独立运行时缺陷

### 5.1 另一方同编号 turn/end 可以错误提交信号

`pendingSignal` 只存 turn，未记信号所属 session。service 检查事件来自双方任一个、且 turn 相同即提交（[`service.ts:190-209`](../packages/triggers/src/service.ts#L190-L209)）；双方回合号是各自的，不具有全局唯一性。

```text
# executor 提交 deliver(turn=1)，executor 尚未结束；reviewer 的 turn=1 先结束
executor has NOT ended; unrelated reviewer turn ended:
{"phase":"awaiting-review","sent":1}  # 期望 sent=0，断言失败
```

修复：信号持久化 callerSession（必要时含 round/phase），提交时匹配 session+turn。已接受信号不应因另一方回合结束而推进/暂停。本例是隔离事件序列，未证明用户真实遇到相同交错。

### 5.2 重投成功但运行仍暂停，审核方无法回签

投递失败置 `paused-error`（`service.ts:258-268`）；`redeliver` 只重发 Delivery，不恢复 run（:514-520）。于是提示已发到审核者，但审核者使用 signal 会被 `run-not-active` 拒绝：

```text
{"delivery":"sent","runStatus":"paused-error",
 "answer":{"ok":false,"error":"本次运行已异常暂停，不再接受交接信号。"}}
```

这并不表示“暂停状态下绝不能补投”；而是 UI 没有表达“补投不等于恢复”，更没有保证先恢复接收能力、再唤醒审核者的原子顺序。单独先恢复/再重投也有竞态。应设计显式「恢复并重投」状态迁移，保留 requestId 幂等并校验运行/阶段仍有效，再验证回签能成功。

### 5.3 服务边界：同 turn 两个 run 信号仅处理第一条

同一 session 允许参与多个 binding；service.signal 对两个 run 均接受，但 `#commitTurnEnd` 在首个推进后 `return`（:211），第二个 pendingSignal 悬挂。隔离结果：sent=1，phases=[awaiting-review, awaiting-delivery]。

**覆盖边界**：真实 `trigger_signal` 成功后调用 `concludeTurn`，一般不会同 turn 连续接受两次工具调用；因此这是服务边界一致性问题，不作为用户故障主因。可禁止同 turn 多 run 提交，或正确处理全部已接受信号，并加真实工具路径测试。

## 6. 已核对、没有发现形状不兼容的宿主契约

| 契约 | 一手依据 | 结论范围 |
| --- | --- | --- |
| `session/event(session,event)`；turn/start、turn/end、reason.kind | Host Event inspect；`dsh-session/lib/types/types.d.ts:165-207,262-276` | 插件读取字段正确；不证明编排逻辑正确 |
| `sessionController.prompt` queue/content/requestId，list.items | Host Service inspect；`dsh-api-session-controller/lib/types/types.d.ts:78-88,159-170,261-268,319-331` | 请求/映射形状匹配；投递重试使用同 requestId |
| `exec.agent`、`exec.concludeTurn()` | `dsh-tools/lib/types/index.d.ts:206-208,305-323`；`dsh-agent-loop/lib/index.js:573,1154-1155` | 有身份与正常结束能力；未执行真实模型闭环 |
| storageDomain.open/table/valueSchema | `dsh-storage-domain/lib/types/domain.d.ts:92-104`、`spec.d.ts:24-29,80,93` | 桩按 schema 验证，已触达记录通过；不代表所有后续路径通过 |
| Service 注册与硬 inject | 真实 Cordis 加载双包，`ctx.get('triggerBindings')` 可取得 | 非服务未注册；异常发生在代理调用内部 |

## 7. 建议修复顺序与验收

1. **先恢复功能**：解决 Service 的所有 `#` 成员与代理冲突；真实 Cordis 双插件回归；覆盖“勾审核 → 简报 → 绑定 → 首 prompt 带 runId → deliver → 回审 → rework → 再交付 → pass”。必须在开发隔离环境做一次真实端到端，而非只看单测。
2. **明确失败语义**：区分“已选择自动审核”和“已绑定成功”。用户要求审核却失败时，不应仅给原 agent 一条 followup 就让用户以为成功；提供显著结果、失败原因、重试/明确继续普通交接的选择，避免静默降级。
3. **重做 handoff 决策流程**：审核独立步骤 + 最终确认；所有单/多工作区、模型/强度/旗标分支都测试；行点击不直接提交。
4. **补齐 trigger 使用闭环**：显示会话标题与真正短 ID；角色显式传参；保存/取消/启动；修复模板串写、未保存删除、重复保存；运行显示任务/历史/错误并及时刷新。
5. **加固编排**：信号身份匹配、恢复重投顺序、多 run 约束；补真实服务解析与持久化边界测试，不仅直接 new + 假表。

本次没有修复或安装插件；不用更改 Nix / profile 配置就能在本仓修复这些已定位的插件缺陷。任何部署/重启仍应按仓库宿主边界由用户执行。

## 附：最小 Cordis 因果对照（无需双插件 harness）

在仓库根运行以下命令；只创建隔离内存 Context，没有访问实际 session：

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
class A extends Service {
  constructor(ctx) { super(ctx, 'privateProbe'); }
  #value = 1;
  #readValue() { return this.#value; }
  read() { return this.#readValue(); }
}
class B extends Service {
  constructor(ctx) { super(ctx, 'plainProbe'); }
  value = 1;
  readValue() { return this.value; }
  read() { return this.readValue(); }
}
const root = new Context();
root.plugin({ name: 'isolated-proxy-probe', apply(ctx) { new A(ctx); new B(ctx); } });
await new Promise(resolve => setTimeout(resolve, 20));
assert.throws(() => root.get('privateProbe').read(), TypeError);
assert.equal(root.get('plainProbe').read(), 1);
console.log('CONFIRMED: ES # members throw; ordinary members return 1');
NODE
```

已运行对照得到 `CONFIRMED`。这证明私有成员与代理的因果关系，不等于已实现或验证完整修复。
