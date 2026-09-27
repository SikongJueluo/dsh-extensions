# dsh-oauth-providers

[DeepSeek Harness](https://www.deepseek.com/harness/en/) 的 **OAuth 认证 LLM
厂商集合**：每个厂商一个模块（`src/providers/<id>/`），共享同一套登录通道与
凭据存储。当前包含：

- **ChatGPT**（路由 `chatgpt`）：用 ChatGPT 订阅调用 GPT。

登录是 pi 风格的 OAuth，内置在插件里：点「登录」得到一个链接，浏览器里完成
厂商账号授权后自动回调；回调不可达（远程主机等）时把跳转 URL 或授权码粘贴回
设置页即可。**无需 API Key，无需任何厂商 CLI。**

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

## 配置（每厂商一个 settings 命名空间，如 `oauth-providers-chatgpt`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://chatgpt.com/backend-api/codex` | ChatGPT 后端（Responses API）地址 |
| `clientVersion` | `0.146.0` | `/models` 端点上报的客户端版本 |
| `proxyUrl` | 自动探测（env / 系统代理） | 出站代理 |
| `defaultReasoningEffort` | `high` | 请求未指定时的 reasoning 档位 |
| `refreshMarginMs` | `86400000`（24h） | 距过期多久时刷新令牌 |
| `defaultContextWindow` | `272000` | 后端未披露时的回退上下文窗口 |

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
