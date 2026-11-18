# 调研：more-providers 合并 oauth-providers 后 OAuth 入口与 plan-usage 额度的因果链

日期：2026-11-19。范围：本仓 `dsh-more-providers` / `dsh-plan-usage` 源码、构建产物、[合并迁移计划](plan-more-providers-oauth-merge.md)，以及 DSH 0.2.2-rc.1 安装树的只读实现。

方法：一级源码核对 + 直接调用构建产物导出的 `resolveConfig` 做输入矩阵实测 + 与合并前残留构建产物对照；运行态部分来自主线在**与实机部署相同的构建**上、用真实 Cordis 4.1.0 / DSH 0.2.2-rc.1 与真实 `dsh-llm` 做的 sibling fixture 复现，逐条回到源码确认。**没有读取线上授权响应、凭据记录或 `more-providers.yaml` 原文，未修改任何插件/宿主/Nix 配置，未请求提权，未做 VCS 操作。** 未获运行证据的部分只给判别条件，不下根因结论。

## 结论

1. **已定位并最小复现的插件缺陷：登录通道的子上下文没有注入 `credentials`。** 在与实机部署相同的构建上，`POST /dsh-oauth-providers/providers` 返回 HTTP 200 但 `result.ok=false`、`SIGNIN_FAILED`、`cannot get property "credentials" without inject`，客户端因此拿不到 provider 列表；只把 `credentials` 补进该子注入，同一请求即返回 `ok:true`。**该复现未读取线上授权响应**，线上是否同样是这个失败需按 [§6](#6-判别树未获运行证据时的只读检查) 核对。当前 Web 已加载相同构建；只要已注册 ChatGPT，复现不依赖凭据是否存在。见 [§3.4](#34-根因与实机部署相同构建--真实-cordis-fixture-复现)。
2. **配置失败也会阻断 OAuth，而且是"全有全无"**：整份 YAML 任一字段非法（含 `providers.chatgpt:` 写成空值、旧式 `kind` 键、顶层写 `chatgpt:`）时，`apply` 在创建 `oauthProviders` 服务、登录通道和 `chatgpt` 路由之前就返回——不是"只丢 ChatGPT 卡片"，API-key 路由也一起消失。见 [§2](#2-配置失败怎样阻断-oauth)。live 状态为 `valid`，可排除这条。
3. **"找不到卡片"共有四种形态**：通道子注入缺 `credentials`（分区在、零卡片、无 toast、RPC 200/ok:false）、配置无效（分区在、零卡片、有 toast）、ChatGPT 被显式关闭（分区在、零卡片、无 toast、RPC ok:true 且空数组）、插件仍是合并前版本（连「OAuth 登录」分区都没有）。区分方法见 [§6](#6-判别树未获运行证据时的只读检查)。
4. **设置 → 模型页的 ChatGPT 行消失是确定性的源码变更，与 YAML/OAuth 无关**：合并前包用 `registerConfigurableProviders` 把 `chatgpt` 声明给模型页，合并后没有这一步；宿主对"已注册但未声明"的 provider 生成 `settingsNs: ""` 的行，模型页不会列出它。见 [§3.3](#33-设置--模型页为什么不再有-chatgpt-行)。
5. **`settings.models.provider-card` / `settings.models.footer` occupants 为空不是回归证据**：宿主只在"需要设置的 provider 行"内部渲染该 keyed slot，本仓合并前后都未占用它；空槽说明不了插件是否工作。见 [§3.3](#33-设置--模型页为什么不再有-chatgpt-行)。
6. **plan-usage 的"取不到额度"尚未定位，不能归因于路由缺失。** `PlanUsageService.providers()` 确实会用已知源路由与 `llm.listProviders()` 求交（[§5](#5-plan-usage-的发现条件)），但 live 只确认了 ChatGPT 默认启用与 OAuth/Plan Usage 两个分区 active，**没有确认 `llm.listProviders()` 的实际内容**；fixture 里两路都注册，配额 42% 只能证明"登录列表缺陷与配额取数不相干"。目前凭据记录、刷新、上游三者都未判定，需按 §6 的检查顺序定位。

**live 已确认（主线 Inspect）**：profile 有 `include:more-providers` 与 `include:plan-usage`、无 `dsh-oauth-providers`；`settings.section` 的两个条目（`dsh-oauth-providers` / `dsh-plan-usage`）均 active；`more-providers` 配置状态 `valid`、解析结果 ChatGPT 默认启用；两个 RPC 前缀均已注册（shell 无认证时只能得到 401）。

**尚未确认**：没有读取线上 `/dsh-oauth-providers/providers` 的授权响应，也没有读取凭据记录或 `wham/usage` 响应。因此本文对"卡片消失"给的是"同构建可复现缺陷 + 判别条件"，对"额度消失"只给条件、不下结论。

## 1. 合并后的配置默认值与失败语义

### 1.1 默认值（省略即启用）

`resolveConfig` 把 `providers` 里除 `chatgpt` 之外的每个键当 API-key provider 解析；`providers.chatgpt` 单独走 [`parseChatGpt`](../packages/more-providers/src/config.ts#L592)，**省略或 `{}` 都按内建默认值启用**，只有 `enabled: false` 才返回 `undefined`（[config.ts:610-626](../packages/more-providers/src/config.ts#L610)）。适配器侧默认值在 [`resolveAdapterOptions`](../packages/more-providers/src/providers/chatgpt/index.ts#L48)：

| 字段 | 默认值 | 源码 |
| --- | --- | --- |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | [chatgpt/index.ts:23](../packages/more-providers/src/providers/chatgpt/index.ts#L23) |
| `refreshMarginMs` | 24h（`DEFAULT_REFRESH_MARGIN_MS`） | [auth.ts:12](../packages/more-providers/src/providers/chatgpt/auth.ts#L12) |
| `defaultContextWindow` | 272000 | [chatgpt/index.ts:24](../packages/more-providers/src/providers/chatgpt/index.ts#L24) |
| `promptCacheKey` | `true` | [chatgpt/index.ts:56](../packages/more-providers/src/providers/chatgpt/index.ts#L56) |
| `clientVersion` | 未设置；空串等同未设置 | [chatgpt/index.ts:51](../packages/more-providers/src/providers/chatgpt/index.ts#L51) |

`chatgpt` 是保留路由：`resolveConfig` 先把它放进 `routes` 集合，其他 provider/account 声明同名路由会整份报错（[config.ts:641-648](../packages/more-providers/src/config.ts#L641)）。

### 1.2 输入 → 结果矩阵（实测，构建产物 `lib/index.js` 导出的 `resolveConfig`）

| YAML 形态 | 结果 |
| --- | --- |
| `{}` / 无 `providers` 键 | 抛 `config.providers: is required` |
| `providers:`（空值 = null） | 同上，整份无效 |
| `providers: {}` | 有效，`chatgpt = {}`（启用），0 条 API-key 路由 |
| `providers: { chatgpt: {} }` | 有效，与省略等价 |
| `providers: { chatgpt: { enabled: false } }` | 有效，`chatgpt = undefined`（关闭） |
| `providers: { chatgpt: }`（空值） | 抛 `providers.chatgpt: expected an object`，**整份无效** |
| `providers: { chatgpt: { promptCacheKey: } }`（空值） | 抛 `null is not a valid provider option`，**整份无效** |
| `providers: { chatgpt: { kind: builtin } }`（若沿用合并前 more-providers 的 provider 形态） | 抛 `unknown key "kind"`，**整份无效** |
| 顶层 `chatgpt: {}` | 抛 `config: unknown key "chatgpt"`，**整份无效** |

关键点：**"省略整节"和"写了键但值是空"不是一回事**。前者启用默认值，后者让整份文档失效（[config.ts:594-597](../packages/more-providers/src/config.ts#L594)）。这一条比迁移计划里写的"缺失/无效时 ChatGPT 也一起消失"更具体，也是最容易在手工编辑 YAML 时踩到的坑。

### 1.3 分阶段失败

| 阶段 | 失败范围 | 源码 |
| --- | --- | --- |
| 读文件 / YAML 解析 / `resolveConfig` | 整份无效 | [config/index.ts:78-92](../packages/config/src/index.ts#L78)、[config.ts:672-674](../packages/more-providers/src/config.ts#L672) |
| `buildProviders` 抛 `ConfigError`（未知 builtin catalog、custom 缺 api 等） | 整份无效 | [providers.ts:390-420](../packages/more-providers/src/providers.ts#L390)、[providers.ts:414-417](../packages/more-providers/src/providers.ts#L414) |
| 单路由 key 读不到 | 只该路由休眠 | [providers.ts:397-401](../packages/more-providers/src/providers.ts#L397) |
| 单路由模型目录失败（非 `ConfigError`） | 只跳过该路由 | [providers.ts:414-417](../packages/more-providers/src/providers.ts#L414) |
| ChatGPT 未登录 / 刷新失败 | 只该路由不可用 | [auth.ts:55-85](../packages/more-providers/src/providers/chatgpt/auth.ts#L55) |

`buildProviders` 的 `ConfigError` 分支（[providers.ts:414](../packages/more-providers/src/providers.ts#L414)）值得单独强调：任意一个 builtin provider 写错 `catalog` 也会让整份配置作废，从而连带 OAuth 消失。

## 2. 配置失败怎样阻断 OAuth

`apply` 的顺序是决定性的（[index.ts:65-122](../packages/more-providers/src/index.ts#L65)）：

1. `registerConfig` + `registerConfigStatusRoute`（[index.ts:67-78](../packages/more-providers/src/index.ts#L67)）——**先于**校验结果注册，所以配置无效时 toast 的错误数据仍在。
2. `await store.ready`；`state.value === undefined` 时记一条 error 并 `return`（[index.ts:79-87](../packages/more-providers/src/index.ts#L79)）。
3. `buildProviders` 抛错时 `reportFailure` + `return`（[index.ts:89-101](../packages/more-providers/src/index.ts#L89)）。
4. 只有走到这里才 `new OAuthProvidersService(ctx)` 和 `registerAuthChannel(ctx)`（[index.ts:105-106](../packages/more-providers/src/index.ts#L105)）。
5. `profiles.size > 0` 才注册 API-key adapter（[index.ts:107-110](../packages/more-providers/src/index.ts#L107)）。
6. `chatgpt !== undefined` 时在 `ctx.inject(['credentials'])` 内 `registerChatGpt`，后者注册 `chatgpt` 路由、模型发现与登录流（[index.ts:111-116](../packages/more-providers/src/index.ts#L111)、[chatgpt/index.ts:97-118](../packages/more-providers/src/providers/chatgpt/index.ts#L97)）。

因此：

- **配置无效 = 无 `oauthProviders` 服务、无 `/dsh-oauth-providers` 路由、无 `providerKeys` 服务、无任何 LLM 路由。** plan-usage 的 `ctx.get('oauthProviders')` 得到 `undefined`，OpenAI 源永远拿不到 token（[service.ts:86-89](../packages/plan-usage/src/service.ts#L86)、[openai.ts:92-99](../packages/plan-usage/src/sources/openai.ts#L92)）；同时 `chatgpt` 不在 `llm.listProviders()` 里，卡被求交过滤掉（[service.ts:121-127](../packages/plan-usage/src/service.ts#L121)）。
- **ChatGPT 被关闭 ≠ 配置无效**：服务与通道仍建立，`providers()` 为空、通道 `providers` 端点返回空数组，`chatgpt` 路由不存在（测试 [apply.test.ts:79-93](../packages/more-providers/test/apply.test.ts#L79)）。
- **代理日志是现成的判别器**：无效时只有 `more-providers: config %s is unusable: %s — fix it and restart dsh`（[index.ts:81-86](../packages/more-providers/src/index.ts#L81)）；正常启动才有 `more-providers: registered N API-key route(s); ChatGPT OAuth enabled; config …`（[index.ts:117-122](../packages/more-providers/src/index.ts#L117)），随后 `registerChatGpt` 再打 `loaded (provider=chatgpt, baseURL=…)`（[chatgpt/index.ts:74](../packages/more-providers/src/providers/chatgpt/index.ts#L74)）。

**"聚合日志说 enabled、但没有 `loaded` 行"** 是一个独立的失效形态：配置有效，但 `credentials` 服务始终没出现，`ctx.inject(['credentials'])` 回调未执行——`chatgpt` 静默缺席，API-key 路由照常。旧包把 `credentials` 放在插件级 `inject` 里（合并前构建产物 `packages/oauth-providers/lib/index.js:2003`），缺服务时整插件不加载；新包改成了运行期软注入（[index.ts:113](../packages/more-providers/src/index.ts#L113)），这条差异迁移计划没有列。

另：旧行的 `config.chatgpt` 不会被读取（新行 `Config` 只有 `configFile`，[index.ts:52-60](../packages/more-providers/src/index.ts#L52)）。已实测：Schemastery 3.19.0 对未知键**原样保留、不报错**，所以旧配置残留不会阻断 `apply`，只是静默失效。

## 3. 客户端预期 slot 与真实卡片来源

### 3.1 合并前后都注册的唯一入口

`registerOAuthSettings`（[client/oauth.tsx:617-646](../packages/more-providers/src/client/oauth.tsx#L617)）向 **`settings.section`**（宿主声明为 `kind: "list", scope: "root"`，`@deepseek-ai/dsh-client-ui-settings-general/lib/client.js:1547`）注册：

| 属性 | 值 | 源码 |
| --- | --- | --- |
| `id` | `dsh-oauth-providers`（沿用旧标识） | [oauth.tsx:638](../packages/more-providers/src/client/oauth.tsx#L638) |
| `order` | 20 | [oauth.tsx:639](../packages/more-providers/src/client/oauth.tsx#L639) |
| `label` | locale 命名空间 `oauth-providers` 的 `nav` | [oauth.tsx:18](../packages/more-providers/src/client/oauth.tsx#L18)、[oauth.tsx:640](../packages/more-providers/src/client/oauth.tsx#L640) |
| `inject` | `{ operations, t }` | [oauth.tsx:641](../packages/more-providers/src/client/oauth.tsx#L641) |

此外客户端半还向 `shell.overlay` 注册配置错误 toast（id `dsh-more-providers-config-notice`，order 90），指向 `/dsh-more-providers/config-status`（[client/index.tsx:17-22](../packages/more-providers/src/client/index.tsx#L17)）；该端点在校验前注册，所以**配置无效也仍然可用**（[config/index.ts:300-320](../packages/config/src/index.ts#L300)）。

### 3.2 卡片不是静态渲染的

`Section` 挂载后调用通道 `POST /dsh-oauth-providers/providers`（[oauth.tsx:243-260](../packages/more-providers/src/client/oauth.tsx#L243)），由宿主实际注册的 provider 列表决定渲染几张卡（[channel.ts:161-173](../packages/more-providers/src/oauth/channel.ts#L161)）。通道本身只在 `apply` 走完全部校验后才建立，并要等 `authorization`/`connection`/`webServer` 三者就绪才挂前缀路由（[channel.ts:312-322](../packages/more-providers/src/oauth/channel.ts#L312)）。每张卡的状态另走 `remote.session.modelCatalog()` 查 `chatgpt` 组（[oauth.tsx:292-329](../packages/more-providers/src/client/oauth.tsx#L292)）。

于是四种可见组合互斥：

| 可见现象 | 含义 |
| --- | --- |
| 有「OAuth 登录」导航，零卡片，无 toast，RPC 返回 `ok:false` / `SIGNIN_FAILED` | 通道已挂但子注入缺 `credentials`（同构建已复现的根因，见 [§3.4](#34-根因与实机部署相同构建--真实-cordis-fixture-复现)） |
| 有导航，零卡片，无 toast，RPC 返回 `ok:true` 且 `providers: []` | 通道与注入都正常，只是没有 provider：`chatgpt` 被关闭，或 `registerChatGpt` 未执行 |
| 有导航，零卡片，**有**配置错误 toast | 整份 YAML 无效，通道根本没建立 |
| 连「OAuth 登录」导航都没有 | 客户端半没加载：插件未安装/未重建，或 `inject` 的 `remote.llm` / `remote.session` 不可用 |

第四行的判别依据：客户端半 `inject` 是 `['slots', 'locale', 'remote', 'remote.llm', 'remote.session']`（[client/index.tsx:27](../packages/more-providers/src/client/index.tsx#L27)），只要其一缺失整个 `apply` 不执行；而 plan-usage 客户端只依赖 `slots` + `locale`（[plan-usage client/index.tsx:387](../packages/plan-usage/src/client/index.tsx#L387)）。**"plan-usage 分区在、OAuth 分区不在"就把问题锁定在客户端半或部署，而不是 YAML。**

### 3.3 设置 → 模型页为什么不再有 ChatGPT 行

这是合并带来的确定性变化，与 OAuth/YAML 无关，但会直接表现为"模型设置里找不到 ChatGPT"：

- 合并前：`registerConfigurableProviders([{ provider: 'chatgpt', displayName, settingsNs, settingsPath: ['chatgpt'] }])`（残留构建产物 `packages/oauth-providers/lib/index.js:1981-1986`；该包受跟踪源码已删除，`lib/` 是 ignored 的迁移前产物，仅作行为参照）。
- 合并后：`registerChatGpt` 只调用 `registerAdapter` / `registerModelDiscovery` / `registerSignIn`，**没有任何 `registerConfigurableProviders`**（[chatgpt/index.ts:106-118](../packages/more-providers/src/providers/chatgpt/index.ts#L106)；全仓 `grep` 为 0）。
- 宿主模型页把"已注册但未声明"的 provider 补成 `settingsNs: ""`、`settingsPath: []` 的行（`dsh-client-ui-settings-models/lib/client.js:1324-1348`），随后只用 `row.configured` 与 `namespaces.has(row.entry.settingsNs)` 决定展示（同文件 `:2586-2587`）。`settingsNs` 为空匹配不到任何命名空间，**该行不会出现在模型页**。

同时说明：模型页的 `settings.models.provider-card`（`kind: "keyed"`）与 `settings.models.footer`（`kind: "list"`）是宿主声明的槽（`dsh-client-ui-settings-models/lib/client.js:5472-5477`），其中 `provider-card` 只在"需要设置"的行内部渲染（同文件 `:2669`、`needsSetup` `:2409`）。本仓合并前后都没有插件占用这两个槽，所以 **occupants 为空属于基线，不是本次回归的证据**；真正丢失的是行本身。

如果用户所说的"入口"指模型设置里那行 ChatGPT，那么修复点在源码（补回 configurable provider 声明或接受该行移除），改 YAML、重启、重登录都不会让它回来。

### 3.4 根因：与实机部署相同构建 + 真实 Cordis fixture 复现

主线用与实机部署相同的构建、真实 Cordis 4.1.0 / DSH 0.2.2-rc.1、真实 `dsh-llm`，把 `credentials` 作为 sibling 插件挂载后复现，并只用 Node `registerHooks` 在内存中改写（不落盘源码）`channel.ts:312` 的注入数组做对照。结果与源码一致；**线上授权响应未读取**，因此这一节证明"该构建具备此缺陷且补丁有效"，不等于线上失败原因已被观测到。

源码链路逐条对应：

- 通道 handler 直接读 `svcCtx.credentials.describeRecord(...)` / `deleteRecord(...)`（[channel.ts:164](../packages/more-providers/src/oauth/channel.ts#L164)、[channel.ts:231](../packages/more-providers/src/oauth/channel.ts#L231)）。
- 承载它的子上下文只注入了 `authorization` / `connection` / `webServer`（[channel.ts:312-322](../packages/more-providers/src/oauth/channel.ts#L312)）。`credentials` 由**兄弟**插件提供，不会自动出现在这个子上下文上。
- 异常被最外层 `catch` 折成 `SIGNIN_FAILED`（[channel.ts:239-241](../packages/more-providers/src/oauth/channel.ts#L239)），而 `serve` 不论 `result.ok` 都回 HTTP 200（[channel.ts:308-309](../packages/more-providers/src/oauth/channel.ts#L308)），所以 fixture 里看到的是 **200 + ok:false**。
- 客户端只在 `result.ok` 时 `setProviders`（[oauth.tsx:243-252](../packages/more-providers/src/client/oauth.tsx#L243)），失败就保持 `[]`；分区本身无条件渲染（[oauth.tsx:262-280](../packages/more-providers/src/client/oauth.tsx#L262)）。UI 因此精确表现为「OAuth 登录」在、零卡片、无 toast。

注入边界的历史差异（主线核对 jj 历史 `xpoortouokrq`）：合并前 `packages/oauth-providers/src/index.ts` 的根 `inject` 是 `['llm', 'credentials']`；合并后根只剩 `['llm']`（[index.ts:63](../packages/more-providers/src/index.ts#L63)），`credentials` 只出现在 `registerChatGpt` 的软注入里（[index.ts:113](../packages/more-providers/src/index.ts#L113)），**通道那处兄弟子注入没有补**。这是合并时唯一漏掉的注入面。

最小补丁四格实证（fixture routes；全局 `fetch` 仅桩 `wham/usage`，返回 42%，未发真实上游）：

| 凭据状态 | 修前 | 修后 |
| --- | --- | --- |
| 有 synthetic grant | OAuth 列表 200 / `SIGNIN_FAILED`；plan-usage 配额 42% | 列表 `signedIn: true`；配额 42% |
| 无 grant | 列表失败 | 列表 `signedIn: false`，卡片存在；两格配额都无数据 |

两格无 grant 的配额都报 `no signed-in ChatGPT token, or the usage fetch failed (see host logs)`，桩上游 **0 次**调用。

由此要划清两条边界：

1. **登录列表的注入错误只影响 OAuth 分区的卡片（及 `status` / `logout`），不阻断 token resolver。** `oauthProviders.token('chatgpt')` 走 `TokenStore`（[auth.ts:114-145](../packages/more-providers/src/providers/chatgpt/auth.ts#L114)），完全不经过 `/dsh-oauth-providers` 通道。所以在 fixture 中"卡片失败"与"配额 42%"可以并存；两个症状**不能互证**，线上配额失败仍需单独取证。
2. 若线上确实"取不到额度"，在"路由已 live"的前提下按源码只剩三种可能：凭据记录缺失/格式不符（`AUTH_MISSING` / `AUTH_INVALID`）、刷新失败（`AUTH_REFRESH_FAILED`）、上游非 2xx 或无可用窗口；"路由是否 live"本身是 §5 的第 1 道门，尚未确认。判别见 [§5](#5-plan-usage-的发现条件) 与 [§6](#6-判别树未获运行证据时的只读检查)。

修复点：`channel.ts:312` 的注入列表补 `'credentials'`，其余不动——More Providers 对外的硬依赖仍可只有 `llm`，`registerChatGpt` 的软注入已经覆盖它自己的凭据读取。

## 4. Credential 兼容键

合并保持了旧地址与记录形状，**仍可用的凭据不用迁移，也不用仅因这次合并而重登**：

| 事实 | 新实现 | 合并前 |
| --- | --- | --- |
| 凭据 scope | `oauth-providers`（[identity.ts:10](../packages/more-providers/src/identity.ts#L10)） | `PLUGIN_NAME = "oauth-providers"`（旧产物 `lib/index.js:26`） |
| 凭据 id | `chatgpt`（[chatgpt/identity.ts:10](../packages/more-providers/src/providers/chatgpt/identity.ts#L10)） | `CREDENTIAL_ID = "chatgpt"`（旧产物 `:1811`） |
| 组合键 | `credentialKey(OAUTH_CREDENTIAL_SCOPE, CREDENTIAL_ID)`（[chatgpt/index.ts:21](../packages/more-providers/src/providers/chatgpt/index.ts#L21)） | `credentialKey(PLUGIN_NAME, CREDENTIAL_ID)`（旧产物 `:1898`） |
| 记录形状 | `kind: 'grant'`，payload `{ access, refresh, expires, accountId }`（[auth.ts:68-85](../packages/more-providers/src/providers/chatgpt/auth.ts#L68)、[login.ts:36-39](../packages/more-providers/src/providers/chatgpt/login.ts#L36)） | 同样要求 `kind: 'grant'`，错误文案与字段校验逐字一致（旧产物 `lib/index.js` 的 `credential record has kind` 分支） |
| accountId 来源 | access token 的 `chatgpt_account_id` 声明（[oauth.ts:108-132](../packages/more-providers/src/providers/chatgpt/oauth.ts#L108)） | 同 |
| 记录更新事件 | `credentialKeyScope(key) === 'oauth-providers'` → `llm/adapters-updated`（[channel.ts:101-103](../packages/more-providers/src/oauth/channel.ts#L101)） | 同 scope |
| 服务名 / RPC / 设置分区 id / locale | `oauthProviders`、`/dsh-oauth-providers`、`dsh-oauth-providers`、`oauth-providers`（[identity.ts:12](../packages/more-providers/src/identity.ts#L12)、[oauth.tsx:18-19](../packages/more-providers/src/client/oauth.tsx#L18)） | 同 |

失败文案也刻意保留了旧地址（[auth.ts:57-77](../packages/more-providers/src/providers/chatgpt/auth.ts#L57)），`AUTH_MISSING` / `AUTH_INVALID` / `AUTH_REFRESH_FAILED` 三类错误码原样供客户端归类（[oauth.tsx:170-180](../packages/more-providers/src/client/oauth.tsx#L170)）。

**唯一变化的命名空间**：`settingsNs` 由旧包的 `oauth-providers` 变成插件行 id `more-providers`（[chatgpt/index.ts:97-105](../packages/more-providers/src/providers/chatgpt/index.ts#L97)，回退常量 [chatgpt/identity.ts:8](../packages/more-providers/src/providers/chatgpt/identity.ts#L8)）。它只影响 `llm.discoverModels(ns, …)` 与设置表单的归属；卡片的 `settingsNs` 由同一处通道注册下发，内部自洽。本仓没有外部消费方硬编码旧 ns（search-integrator 只读 `oauthProviders` 服务）。

## 5. plan-usage 的发现条件

额度卡要经过四道门：前两道决定"有没有卡"，后两道决定"卡里有没有数"。

1. **路由必须在 live 列表里**：`providers()` = 已知源路由 ∩ `llm.listProviders()`（[service.ts:121-127](../packages/plan-usage/src/service.ts#L121)），live 列表来自已注册 adapter（`@deepseek-ai/dsh-llm/lib/index.js:1908`），并在 `llm/adapters-updated` 时刷新（[service.ts:105-107](../packages/plan-usage/src/service.ts#L105)）。`llm` 尚未就绪时 `liveRoutes` 为 `undefined`，会短暂返回全部已知路由（[service.ts:110-113](../packages/plan-usage/src/service.ts#L110)）。
2. **`monitored()` 必须为真**：OpenAI 源的 `ready()` 恒为 `true`（[openai.ts:88-90](../packages/plan-usage/src/sources/openai.ts#L88)），所以这一道不筛 ChatGPT。
3. **token 必须拿得到**：`ctx.get('oauthProviders')?.token('chatgpt')`（[service.ts:86-89](../packages/plan-usage/src/service.ts#L86)），未注册服务或未登录都返回 `undefined`。
4. **上游必须给出可用窗口**：`GET https://chatgpt.com/backend-api/wham/usage`，`rate_limit.primary_window` / `secondary_window` 至少一个含 `used_percent`（[openai.ts:50-66](../packages/plan-usage/src/sources/openai.ts#L50)、[openai.ts:92-135](../packages/plan-usage/src/sources/openai.ts#L92)）。

通道把 1+2 的结果作为卡片集合，把 3+4 的失败折成卡内错误（[channel.ts:26-46](../packages/plan-usage/src/channel.ts#L26)）：

| 断点 | 用户可见 |
| --- | --- |
| `chatgpt` 不在 live（YAML 无效 / 部署旧版 / 未挂载） | **没有 OpenAI 卡**，其他源照常 |
| 路由在，`oauthProviders` 缺失或未登录 | 有卡，文案提示无 token / 取数失败 |
| 路由在、token 在，上游非 2xx 或 JSON 不含窗口 | 有卡，文案提示取数失败；宿主日志有具体原因 |
| 路由在、token 在、上游正常，但 OAuth 登录列表 RPC 失败 | **额度照常可取**（[§3.4](#34-根因与实机部署相同构建--真实-cordis-fixture-复现) fixture 四格：修前列表失败、配额仍为 42%） |

## 6. 判别树（未获运行证据时的只读检查）

按代价从低到高，全部只读：

| 检查 | 结果 → 结论 |
| --- | --- |
| 设置导航里有没有「OAuth 登录」 | 无 → 客户端半未加载/未部署（[§3.2](#32-卡片不是静态渲染的) 第四行）；有 → 继续 |
| 有没有红色配置错误 toast；`GET /dsh-more-providers/config-status` 的 `instances[].state` | `invalid` + `error` → 整份 YAML 无效，OAuth 与 API-key 路由一起没了；`valid` → 继续（live 已确认 `valid`，该分支已排除） |
| 宿主日志有没有 `more-providers: registered … ChatGPT OAuth enabled` / `loaded (provider=chatgpt…` | 只有前半 → `credentials` 缺失或 `registerChatGpt` 的软注入未执行；两者都有 → 继续 |
| 模型选择器 / `llm.listProviders()` 里有没有 `chatgpt` | 无且配置有效 → `providers.chatgpt.enabled: false` 或注册失败；有 → 继续 |
| 浏览器同源 `POST /dsh-oauth-providers/providers` | `result.ok=false` + `cannot get property "credentials" without inject` → 通道子注入缺 `credentials`（[§3.4](#34-根因与实机部署相同构建--真实-cordis-fixture-复现)）；`ok=true` + `providers: []` → ChatGPT 关闭或未注册；`ok=true` + 有 provider → 正常 |
| 「OAuth 登录」分区里有没有卡片 | 结合上一行判断：列表失败/为空则必然零卡片；有卡但未登录 → 只需重新登录 |
| plan-usage 有没有 OpenAI 卡 | 无卡 + `chatgpt` 不在 live → 与 §2 同因；有卡但报错 → token/上游问题，查 `plan-usage: no ChatGPT token …` / `codex usage fetch …` 日志 |
| 安装版本 | `--dump-config` 的 `# == dsh-` 层与包版本不是 0.2.0 / 入口不含 `oauthProviders` → 仍是合并前构建，重建安装即可 |

补充：`/dsh-oauth-providers/*` 通道带 `connection.requestRejection`（[channel.ts:250-255](../packages/more-providers/src/oauth/channel.ts#L250)），直接 `curl` 可能 401；在浏览器 DevTools 里看同源请求更可靠。`/dsh-more-providers/config-status` 没有这层校验（[config/index.ts:284-296](../packages/config/src/index.ts#L284)）。

## 7. 与迁移计划、用例的对照

| 计划/文档说法 | 源码核对 |
| --- | --- |
| 默认 `providers: {}` 即启用 ChatGPT（[plan §1.2](plan-more-providers-oauth-merge.md)） | 成立（[config.ts:594](../packages/more-providers/src/config.ts#L594)、实测矩阵） |
| `enabled: false` 只关路由、保留凭据（§1.3） | 成立（[config.ts:619](../packages/more-providers/src/config.ts#L619)、[apply.test.ts:79-93](../packages/more-providers/test/apply.test.ts#L79)） |
| 整份严格校验、失败不注册任何路由（§1.5） | 成立，且**连 `oauthProviders` 与通道都不建**（[index.ts:79-106](../packages/more-providers/src/index.ts#L79)） |
| 兼容面：route/凭据/RPC/服务/slot/locale（§1.7） | 成立（[§4](#4-credential-兼容键)）；`settingsNs` 变化未在计划中列出 |
| 旧行 `config.chatgpt` 不再读取（§3.4） | 成立；未知键被 Schemastery 保留而不报错（实测） |
| 坏配置时「分区仍在、没有卡片」（README） | 成立（[oauth.tsx:634-645](../packages/more-providers/src/client/oauth.tsx#L634)） |
| 部署后应看到 `registered … ChatGPT OAuth enabled`（§5.6） | 字符串成立（[index.ts:117-122](../packages/more-providers/src/index.ts#L117)） |

计划未覆盖、本次发现的三处差异：

1. **登录通道的兄弟子注入漏了 `credentials`**（[§3.4](#34-根因与实机部署相同构建--真实-cordis-fixture-复现)）——RPC 前缀、路由、服务都在，只有 handler 读不到凭据，表现成"200 但 ok:false"。
2. **模型页 ChatGPT 行消失**（[§3.3](#33-设置--模型页为什么不再有-chatgpt-行)）——不是 YAML 问题，也不会随重启恢复。
3. **`providers.chatgpt:` 空值/旧 `kind` 写法会让整份文档失效**（[§1.2](#12-输入--结果矩阵实测构建产物-libindexjs-导出的-resolveconfig)），影响面是全部路由而非仅 ChatGPT。

用例侧，下列测试正好覆盖了本文的关键分支：`apply.test.ts:36-46`（默认启用）、`:68-77`（缺 key 不阻断 OAuth）、`:79-93`（关闭保留凭据）、`:95-103`（旧凭据可继续取 token）、`:106-132`（无效文档零注册 + 状态路由）、`:156-176`（凭据 scope 事件）。它们都是进程内 harness，**没有覆盖客户端 slot 渲染、模型页行可见性，也没有真正发起过登录通道的 HTTP 请求**；更关键的是 harness 在根上下文直接 `ctx.provide('credentials', …)`（[helpers.ts:335](../packages/more-providers/test/helpers.ts#L335)），服务对所有后代可见，恰好绕过了"子上下文必须 inject"的边界。这正是"门禁全绿但上线仍可能拿不到卡片"的缺口。§3.3 与 §3.4 的回归都不会被现有用例拦住。

## 8. 结论性建议（按分支）

- **卡片消失（同构建已复现）**：在 [channel.ts:312](../packages/more-providers/src/oauth/channel.ts#L312) 的子注入数组补 `'credentials'`；其余注入面不动，More Providers 对外的硬依赖仍可只有 `llm`。补丁在 fixture 中已验证列表 `ok:true`、`signedIn` 反映 fixture 凭据状态（线上未验）。
- **配置无效**：把 YAML 修成最小合法形态（`providers: {}` 或删除空值/旧 `kind` 键），重启 dsh；凭据不受影响，无需重登。
- **ChatGPT 被关闭**：YAML 改回省略该节或 `chatgpt: {}`，重启。
- **部署仍是旧版**：`pnpm build` 后按 [迁移计划 §5](plan-more-providers-oauth-merge.md) 由用户重建/重启；旧 `dsh-oauth-providers` 层必须已经消失。
- **模型页需要保留 ChatGPT 行**：属于源码层决定，需要重新引入 `registerConfigurableProviders`（或明确接受该行移除并更新文档）；不在本次只读诊断范围内。
- **路由在但无额度**：先按 §5 的第 3/4 道门查 token 与上游（凭据记录、刷新、`wham/usage`），不要改 YAML；卡片列表的注入缺陷不会直接造成这一现象（[§3.4](#34-根因与实机部署相同构建--真实-cordis-fixture-复现)）。
