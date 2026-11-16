# dsh-oauth-providers 并入 dsh-more-providers（0.2.0）迁移计划

日期：2026-11-16。代码已合并到 more-providers，**尚未部署**。本文给出部署顺序、flake 改动面、兼容矩阵与验证记录。按仓库宿主边界：**`dsh plugin add/remove`、flake 修改与 rebuild 由用户执行**，本次未改宿主配置或安装 profile。

## 1. 已定决策

1. **全部并入 `dsh-more-providers`**，不再保留独立共享库；pi-ai 适配与 ChatGPT 协议都留在
   包内部，`packages/oauth-providers` 将删除。合并后版本 `0.2.0`（原 `oauth-providers` 停在 0.6.0）。
2. **ChatGPT 默认启用**：YAML 只需 `providers: {}`（`providers` 键必填、可空）；省略
   `providers.chatgpt` 整节即用内建默认值。
3. **`providers.chatgpt.enabled: false` 关闭**：不注册 `chatgpt` 路由、设置页不显示对应卡片，
   **凭据保留**，重新开启无需登录。
4. **五个连接参数只放 `providers.chatgpt`**：`baseURL` / `clientVersion` / `refreshMarginMs` /
   `defaultContextWindow` / `promptCacheKey`。没有 `kind` / key / `accounts`。
5. **整份严格校验**：任一字段非法 → 整份 YAML 不生效，**不注册任何路由**（含 ChatGPT），
   也不建立 `oauthProviders` 服务与登录通道；Web 复用共享 `ConfigStatusToast` 报错；改完
   YAML 需重启 dsh。
6. **局部失效**：key 缺失只让该 YAML 路由休眠；未登录只让 `chatgpt` 路由不可用。
7. **兼容面不变**：route `chatgpt`、凭据 `oauth-providers/chatgpt`、RPC 前缀
   `/dsh-oauth-providers`、服务 `oauthProviders` / `providerKeys`、设置页 OAuth 登录 UI
   （slot id `dsh-oauth-providers`、locale 命名空间 `oauth-providers`）。
8. **不能双挂**：旧 bundle 与新 bundle 同时启用必然冲突（见 §5）。

## 2. 代码落点

| 子系统 | 旧位置 | 新位置 |
|---|---|---|
| ChatGPT 配置 | `oauth-providers` 行配置 `config.chatgpt`（设置页热编辑） | YAML `providers.chatgpt`（重启生效） |
| 登录通道 | `packages/oauth-providers/src/channel.ts` | `packages/more-providers/src/oauth/channel.ts` |
| `oauthProviders` 服务 | `…/src/service.ts` | `packages/more-providers/src/oauth/service.ts` |
| ChatGPT provider 模块 | `…/src/providers/chatgpt/*` | `packages/more-providers/src/providers/chatgpt/*` |
| 设置页分区 | `…/src/client/index.tsx` | `packages/more-providers/src/client/oauth.tsx`（入口只 import 一次 `styles.css`） |
| bundle 层 | 两条独立 bundle patch | 只保留 `more-providers` 一条（仍禁用 stock `llm-pi-ai`） |
| 客户端服务声明 | `slots` / `locale` / `remote.*` 在旧包 | 合并进 `more-providers` 的 `inject`，并在 `package.json` 的 `dsh.client.inject` 补齐 |

配套：[第三方许可](../packages/more-providers/THIRD-PARTY-NOTICE.md)已随实现迁入本包并纳入发布文件清单。宿主附件接入集中在 [runtime.ts](../packages/more-providers/src/runtime.ts)，两种适配器共同执行 [图片契约测试](../packages/more-providers/test/image-contract.ts)。

## 3. 用户可见的行为差异

1. **ChatGPT 参数从设置页热编辑改为 YAML**：五个参数改完必须重启 dsh；登录界面仍在设置页。
2. **YAML 缺失/无效时 ChatGPT 也一起消失**：合并前它由独立 bundle 提供，不受 more-providers
   YAML 影响；合并后 `apply` 在读不到有效配置时直接返回，`chatgpt` 路由、`oauthProviders`
   服务、登录通道都不建立。
3. **设置页「OAuth 登录」分区仍固定注册**，但卡片由宿主实际注册的 provider 列表决定：
   ChatGPT 关闭时该分区只剩标题没有卡片。
4. **旧行里的 `config.chatgpt` 不再被读取**：新行 Config 只有 `configFile`。Schemastery 会原样
   保留未知键、不会报错，所以不致命，但建议一并删除避免误解。
5. **消费方不变**：dsh-plan-usage 的 OpenAI 源仍读 `ctx.get('oauthProviders')?.token('chatgpt')`，
   search-integrator 的 chatgpt 检索源同理；`providerKeys` 契约不变。

## 4. 配置迁移

- **默认用户零改动**：不写 `chatgpt` 节，ChatGPT 即按默认值启用；已有登录沿用（凭据地址
  `oauth-providers/chatgpt` 未变），**不需要重新登录**。
- **改过旧行配置的用户**：把旧 `config.chatgpt` 里的自定义值手工搬到 YAML：

```yaml
# 旧（Cordis 行配置，合并后不再读取）
# config:
#   chatgpt:
#     promptCacheKey: false
providers:
  chatgpt:
    promptCacheKey: false
```

- **关闭而不是卸载**：`providers.chatgpt: { enabled: false }`；凭据保留，随时可开回来。
- **最小合法 YAML**：

```yaml
providers: {}
```

## 5. 部署顺序（用户执行）

必须先摘旧、再上新；顺序反了会出现两条 `chatgpt` 路由、两次 `oauthProviders` 服务注册、
同一个 `/dsh-oauth-providers` 前缀与设置页 slot id 重复。

1. **确认 YAML 就位**：`$DSH_HOME/more-providers.yaml` 至少有 `providers: {}`。若默认模型仍是
   `agent-default-model = zai-coding-cn`，该路由的 key 也要先可用，否则重建后没有可用默认模型。
2. **构建本仓**（checkout 内，用户或授权的执行者）：

```sh
pnpm install && pnpm build
```

3. **flake 移除旧 bundle**：已只读核对本机 [plugins.nix](/home/sikongjueluo/.config/nixos/home/ai/dsh/plugins.nix#L27)，从 `programs.dsh.plugins` 中删除下列一项；现有 `more-providers` 项已在同文件第 36 行，无需再添加：

```diff
-      "${extensions}/oauth-providers"
```

   `~/.dsh` 由 home-manager 管，不在 profile 目录里手工改 package/patch。
   若某个 preset 或自定义 patch 层里还有旧插件行，一并移除；步骤 6 的 `--dump-config` 用于核对。
4. **仅当 profile 是手工管理时**才用命令摘旧包（Nix 管的 profile 跳过，rebuild 才是权威）：

```sh
dsh plugin --profile web remove dsh-oauth-providers
```

5. **rebuild + 重启**（按你平时的入口）：

```sh
sudo nixos-rebuild switch    # 或 home-manager switch --flake ~/.config/nixos#<host>
systemctl --user restart dsh-web
```

6. **只读验收**：

```sh
dsh --profile web --dump-config | grep '# == dsh-'
journalctl --user -u dsh-web -n 100 --no-pager
```

   - `--dump-config` 只应出现 `# == dsh-more-providers` 层，不应再有 `# == dsh-oauth-providers`。
   - 日志应出现 `more-providers: registered N API-key route(s); ChatGPT OAuth enabled;
     config /…/more-providers.yaml`。
   - 设置页「OAuth 登录」仍显示已登录（无需重登）；模型选择器里同时有 `chatgpt` 与 YAML 路由。
   - `providers.chatgpt.enabled: false` 时该卡消失、`chatgpt` 路由消失，其余路由不变。

## 6. 回滚

1. 把 flake 的 `programs.dsh.plugins` 改回旧组合（`oauth-providers` + 旧 `more-providers` 版本），
   旧包目录从删除前的仓库 revision 取。
2. rebuild + `systemctl --user restart dsh-web`。
3. YAML 里的 `providers.chatgpt` 节对旧 `more-providers` 不友好：旧版会把 `chatgpt` 当普通
   provider 解析，因缺 `kind` 判整份 YAML 无效。回滚时临时删掉该节（或注掉），旧包本身不需要它。
4. 凭据不需要处理：两条实现的地址都是 `oauth-providers/chatgpt`。

## 7. 风险与未覆盖

- **双挂**会同时冲突 route id、服务名、webServer 前缀、slot id 与凭据写入，必须先摘旧再上新。
- **缺 YAML** 等于本插件什么都不注册：API-key 路由与 ChatGPT 一起消失，默认模型可能直接不可用。
- **登录依赖回环回跳**（`localhost:1455`），dsh-mobile 网关不代理该端口：手机上只能看登录状态，
  登录需在电脑浏览器完成。
- 旧独立包的受跟踪源码、manifest 与构建配置已删除。当前机器的 ignored `lib/` 和 `node_modules/` 暂留，避免影响迁移前仍在运行的进程；Fallow 因该空壳目录报告一次 workspace discovery warning，不影响门禁退出码，也未为它增加 ignore。

## 8. 验证

本仓验证已完成：`pnpm check:quality` 的 format、lint、suppressions、dead-code、types、build、tests、smoke、client、pack、storybook **11 项全部通过**。新 provider 契约测试 4 个文件、44 个用例，使用模拟供应商传输；两种适配器共用同一套 8 场景图片测试。独立代码质量审查未发现阻塞问题。未新增豁免或扩大 ignore。

已自动验证：

- 默认 `providers: {}` 注册 ChatGPT；缺 API key 不阻止 OAuth；未登录不能发送 ChatGPT 请求。
- 显式关闭 ChatGPT 不注册该适配器，并保留原 `oauth-providers/chatgpt` grant；沿用旧 grant 可取得 token；凭据更新仍触发模型目录刷新事件。
- 非法字段和非法参数拒绝整份文档，零 provider 注册，同时配置状态路由仍提供 toast 所需错误数据。
- 经过真实 `apply → registerAdapter → stream` 的用户图、工具图、历史图、去重、offload、缺服务、延迟服务和纯文字；请求中的 data URL 与固定 PNG 一致。另测缓存亲和开关、认证头和预先取消。
- 9 个客户端 factory 的加载、slot 注册和 SSR 渲染；合并包的客户端产物和发布文件检查。

待部署后验证（本次未修改 Nix、profile 或凭据，也未发真实上游请求）：

- [ ] Nix 重建后的 `--dump-config` 不再出现旧 bundle 层。
- [ ] 现有登录在真实 GUI 中保持已登录；桌面浏览器的登录/退出流程和模型刷新。
- [ ] ChatGPT 关闭后的真实卡片状态；坏 YAML 的实际 toast 展示与重启恢复。
- [ ] dsh-plan-usage 的真实套餐配额卡，以及 MDKJ / ChatGPT 各一次带图推理。
