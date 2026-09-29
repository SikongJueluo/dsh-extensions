# dsh-oauth-providers

[DeepSeek Harness](https://www.deepseek.com/harness/en/) 的 **OAuth 认证 LLM
厂商集合**：每个厂商一个模块（`src/providers/<id>/`），共享同一套登录通道与
凭据存储。当前包含：

- **ChatGPT**（路由 `chatgpt`）：用 ChatGPT 订阅调用 GPT。

登录是 pi 风格的 OAuth，内置在插件里：点「登录」得到一个链接，浏览器里完成
厂商账号授权后自动回调；回调不可达（远程主机等）时把跳转 URL 或授权码粘贴回
设置页即可。**无需 API Key，无需任何厂商 CLI。**

v0.4 起插件额外提供 **`oauthProviders` 宿主服务**：`ctx.get('oauthProviders')`
→ `token(provider)` 返回带自动刷新轮换的可用 access token（当前支持
`chatgpt`）。供其他插件调用厂商自有后端 API——如 dsh-plan-usage 的 OpenAI
用量查询；未登录/刷新失败返回 `undefined`，不抛错。

命名保持通用（包 `dsh-oauth-providers`、插件行 `oauth-providers`）：将来 DSH
内置了对应的官方 provider，删掉对应厂商模块（或整个包）即可，不留残留。
`chatgpt` 这个路由名同样中性——`openai` / `openai-codex` 已被 DSH 自带的
pi-ai 适配器休眠目录占用。

派生自 [werifu/dsh-oai-oauth](https://github.com/werifu/dsh-oai-oauth)（MIT）
与 pi-ai 的 `openai-codex` OAuth 流程（MIT），见
[THIRD-PARTY-NOTICE.md](./THIRD-PARTY-NOTICE.md)。

## 安装

```sh
pnpm build                                            # 先本地构建
dsh plugin --profile <你的profile> add ./packages/oauth-providers
```

或把 `packages/oauth-providers/dev.patch.yml` 里的两行作为一个 patch 层挂上
（见下「开发/自管部署」）。

## 使用

1. 打开 **设置 → OAuth 登录**，在对应厂商卡片上点 **登录**。
2. 浏览器打开厂商登录页，完成授权；页面跳回 `localhost:1455` 即自动完成。
   若跳转失败，复制地址栏 URL 粘贴回设置页。
3. 授权令牌存入 DSH 凭据商店（记录如 `oauth-providers/chatgpt`），临近过期
   自动刷新（`modifyRecord` 独占写窗口 = 跨进程轮换锁）。退出登录即删除记录。
4. 在会话里选用该路由的模型（如 `chatgpt` 的 gpt-5.x）。

凭据不落 settings 文档、不进仓库；凭据商店文件（默认
`$DSH_HOME/.credentials.yaml`）请勿提交。

## 配置

设置页的卡片刻意极简：状态、登录/退出、模型列表，没有配置表单。出站网络
直接走 dsh 进程的网络（标准 env/系统代理自动探测仍生效，无需配置）；
reasoning 档位在模型选择器里按请求选择。

模型列表**全程联网、零手工维护**：每次都从 ChatGPT 后端 `/models` 实时拉取
（2 小时缓存）。后端按上报的客户端版本放行新模型（如 GPT-6 需要新版），因此
上报的 client version 也从网络解析：npm registry 上最新发布的
`@openai/codex`（同样 2 小时缓存，版本变化立即失效模型缓存），离线时回退内置
快照 `0.157.1`。新模型上线后最多 2 小时自动出现，点「刷新模型」立即拉取。

每厂商仍保留一个 settings 命名空间（如 `oauth-providers-chatgpt`），供组合层
（cordis patch 的行 config）覆盖内部默认，无 UI：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | ChatGPT 后端（Responses API）地址 |
| `clientVersion` | 自动（npm 最新 `@openai/codex`） | 上报给后端的客户端版本；仅需要钉版时设置 |
| `refreshMarginMs` | `86400000`（24h） | 距过期多久时刷新令牌 |
| `defaultContextWindow` | `272000` | 后端未披露时的回退上下文窗口 |

登录记录的写入/删除会以 `llm/adapters-updated` 通知所有已打开的模型选择器
刷新目录（stock 界面只监听 API-key 引用更新，不覆盖授权记录）。

## 架构

- **宿主半**（`lib/index.js`）：
  `src/channel.ts` 是共享登录通道——`ctx.webServer` 上的 `/dsh-oauth-providers`
  前缀路由（connection RPC 同款信封），按 provider id 派发
  providers/status/begin/poll/submit/decline/cancel/logout；
  每个厂商模块注册自己的 `ctx.llm` 路由、`ctx.authorization` 登录流程与
  `ctx.settings` 配置节。
- **浏览器半**（`client/client.js`）：设置页 "OAuth 登录" 分区，每厂商一张
  卡片（状态灯 / 登录流 / 模型 / 配置表单），经 Typed Client Remote 读状态、
  经共享通道完成登录。
- **新厂商**：加 `src/providers/<id>/`（identity + oauth 协议 + token 存取 +
  adapter + 入口），在 `src/index.ts` 的 `apply` 里注册一行，客户端
  `FIELDS` 表加该厂商的配置字段。bundle 的 `cordis.patch.yml` 已一并挂载
  授权缝隙（`dsh-authorization`），所有厂商共用。

## 开发 / 自管部署（如 systemd）

`--patch` 需要 nix 生成的不可变文件时，可在生成配置里追加这两个行（来自
`dev.patch.yml`，路径换成绝对路径）：

```yaml
- insert:
    - id: authorization
      name: '@deepseek-ai/dsh-authorization'
    - id: oauth-providers
      name: '/home/sikongjueluo/Projects/dsh-extensions/packages/oauth-providers/lib/index.js'
```

改代码后 `pnpm build`，再重启你的 dsh 服务（如 `systemctl --user restart
dsh-web`）。

## 卸载

```sh
dsh plugin --profile <你的profile> remove dsh-oauth-providers
```
