# 调研：把 Context7 / DeepWiki 两个 MCP 接进 DSH 的 tool 体系

> 结论先行：**DSH 原生支持 MCP，不需要手搓插件**。dsh `0.2.0-rc.2` 内置
> `@deepseek-ai/dsh-mcp-client`（MCP→`ctx.tools` 桥）与 `@deepseek-ai/dsh-mcp-resources`
> （资源读取，shipped profiles 已默认挂载），默认一个 server 都没开。接入 Context7 /
> DeepWiki 只需**两条配置行**（各连一个 server），推荐落成本仓的 configuration-only
> bundle（只有 `cordis.patch.yml`，无任何代码）或直接在 nix 的 `programs.dsh.plugins`
> 加两行。两个服务都是远程 streamable-http 端点、**免 key 可用**，本机（mihomo tun 下）
> 实测连通且工具调用成功。

- 调研对象：DSH `0.2.0-rc.2`（本机 nix store；
  `/nix/store/0z3j9r5hc9vq2ifb29kcrbbxf4m2ik5q-dsh-0.2.0-rc.2/lib/node_modules/@deepseek-ai/dsh/`，
  内部包在其 `node_modules/@deepseek-ai/` 下，下称 `$DSH/<pkg>`）；
  Context7 MCP（实测 server `Context7 v4.3.0`）、DeepWiki MCP（实测 `v2.14.3`）。
- 需求来源：用户想把 context7 与 deepwiki 加进 tool 列表，问 DSH 支不支持 MCP、
  要不要配置或手搓插件。
- 方法：`$DSH/dsh-mcp-client` README + 构建产物核对 → 官方 MCP 模板
  （`dsh-agent-preset` skill `templates/mcp/`）→ 当前 `web` profile 现状核对
  （Inspect / profile 文件）→ 两个端点的活体协议探测（initialize + tools/list +
  免 key tools/call，2026-10-11）。

## 1. DSH 的 MCP 支持现状（一手：包 README + 构建产物）

| 事实 | 来源 |
|---|---|
| `dsh-mcp-client` 让模型像原生工具一样调用外部 MCP server 的 tools/resources；工具名 `mcp__<serverName>__<rawName>`（与 Claude Code/Codex 同形） | `$DSH/dsh-mcp-client/README.md` |
| 默认**不启用任何 server**；一个 entry 连一个 server | 同上 |
| 传输只支持 `stdio`（`command`/`args`/`env`/`cwd`）与 `streamable-http`（`url`/`headers`）；**没有 legacy SSE 传输**（lib 里 grep 无 `sse` 字面量） | 同上 + `lib/index.js` 实查 |
| 工具列表变更自动同步、断线自动重连（500ms 起指数退避至 30s，10 次失败后放弃）；慢/崩的 server 会拖慢启动 | 同上 |
| `dsh-mcp-resources` 提供 MCP 资源发现/读取的三个共享工具，shipped profiles 已默认挂载——配了 client entry 即自动获得 | `$DSH/dsh-mcp-resources/README.md` |
| stdio 子进程环境会被擦洗（`/KEY\|PASSWORD\|SECRET\|TOKEN/i` 与 `DSH_*` 丢弃），显式 `env` 覆盖可存活；`streamable-http` 的 `headers` 是显式配置不受擦洗影响 | 同 README |
| 官方接入姿势就是 configuration-only bundle：`package.json` 只需 `dsh.bundle.patch`，patch 里 `insert` 一行 `name: '@deepseek-ai/dsh-mcp-client'`，**无需任何代码** | dsh-agent-preset skill `templates/mcp/` + `references/mcp-bundle.md` |

关键配置字段（README 表格，完整版见其 config-catalog）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `serverName` | 必填 | 工具命名空间，`[A-Za-z0-9_-]{1,32}`，scope 内唯一 |
| `transport` | 必填 | `stdio` 或 `streamable-http` |
| `command`/`args`/`env`/`cwd` | — | stdio 专用 |
| `url`/`headers` | — | streamable-http 专用 |
| `toolCallTimeoutMs` | 60,000 | 单次 tools/call 超时 |
| `failOnStartupError` | `false` | 初始连接失败是否拒绝插件激活 |
| `reconnect.*` | 见 README | 重连策略（enabled/initialDelayMs/maxDelayMs/maxAttempts） |

当前 `web` profile 现状：`~/.dsh/profiles/web/package.json` 只挂 base/web-app/schedule
三个 bundle，`cordis.patch.yml` 无 MCP 行，本会话 Inspect `Tool.listTools` 无任何
`mcp__*` 工具——**从零开始，无历史包袱**。（另注：`dsh --profile web --dump-config`
会因 nix 只读 profile 目录报 EROFS，属宿主侧已知形态，不影响本调研。）

## 2. 两个 server 的接入参数（一手：官方文档/源码 + 2026-10-11 活体探测）

### Context7（Upstash，库/框架文档检索）

| 项 | 值 | 来源 |
|---|---|---|
| 远程端点 | `https://mcp.context7.com/mcp`（streamable-http，官方服务卡 `isRequired: false`） | [README](https://github.com/upstash/context7)、[all-clients](https://context7.com/docs/resources/all-clients)、[constants.ts](https://github.com/upstash/context7/blob/master/packages/mcp/src/lib/constants.ts) |
| SSE | **从未提供**：文档不提、路由只认 `/mcp` 与 `/mcp/oauth`、实测 `/sse`→404 | [mcp-route.ts](https://github.com/upstash/context7/blob/master/packages/mcp/src/lib/mcp-route.ts) + 实测 |
| OAuth | `https://mcp.context7.com/mcp/oauth`（仅远程 HTTP；dsh-mcp-client 无 OAuth 授权流，接入用 API key header 即可） | [OAuth 文档](https://context7.com/docs/howto/oauth) |
| 认证 | **免 key 可用**（匿名走 IP 级限流）；可选 key 提额：`Authorization: Bearer ctx7sk-…`（源码也接受 `x-api-key` 等，优先级更低） | [API Guide](https://context7.com/docs/api-guide)、[index.ts](https://github.com/upstash/context7/blob/master/packages/mcp/src/index.ts) |
| key 申请 | [context7.com/dashboard](https://context7.com/dashboard) 创建，只显示一次可撤销；Free 带 key 1,000 次/月（超额阻断、每天补 20 次），Pro $10/seat 2,000 次/月 | [API Keys](https://context7.com/docs/howto/api-keys)、[Plans](https://context7.com/plans) |
| 本地 stdio 备选 | `npx -y @upstash/context7-mcp@latest`（4.3.0，Node ≥20.18.1，`--api-key` 或 `CONTEXT7_API_KEY`） | [npm](https://www.npmjs.com/package/@upstash/context7-mcp)、[developer](https://context7.com/docs/resources/developer) |
| 工具（实测 v4.3.0） | `resolve-library-id`（必填 `libraryName`+`query`）、`query-docs`（必填 `libraryId`+`query`） | 活体 tools/list + [tool-names.ts](https://github.com/upstash/context7/blob/master/packages/mcp/src/lib/tool-names.ts) |

实测记录：免 key `tools/call resolve-library-id` 成功返回。两个易踩坑：
`get-library-docs` 已在 v2.0.0 改名 `query-docs`、`context7CompatibleLibraryID` 改名
`libraryId`（[CHANGELOG](https://github.com/upstash/context7/blob/master/packages/mcp/CHANGELOG.md)）——网上旧教程普遍过时；服务端有参数名兼容 shim 与幻觉参数改写，且
**每个问题最多 3 次工具调用**（工具描述写死）。dsh 桥透传 server 真实 schema，模型侧无感。

### DeepWiki（Cognition/Devin，GitHub 仓库 wiki 问答）

| 项 | 值 | 来源 |
|---|---|---|
| 公共端点 | `https://mcp.deepwiki.com/mcp`（streamable-http，**免费、免认证**，官方原文 "no-authentication-required"） | [mcp.deepwiki.com](https://mcp.deepwiki.com/)、[DeepWiki MCP 文档](https://docs.devin.ai/work-with-devin/deepwiki-mcp) |
| SSE | legacy `/sse` **实测已 410 Gone**（"deprecated in favor of Streamable HTTP"）——dsh 无 SSE 传输，无影响 | 实测 + 同上 |
| 私有仓库 | 走 `https://mcp.devin.ai/mcp` + `Authorization: Bearer cog_…`（旧 `apk_` 前缀不支持；部分账户另需 `X-Org-Id`）；额外解锁 `list_wiki_repos`、`generate_wiki` 与一批 `devin_*` 平台工具 | [Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp) + 实测 |
| stdio | **没有**——无 npm 包、无本地启动方式，只有远程 URL | [DeepWiki MCP 文档](https://docs.devin.ai/work-with-devin/deepwiki-mcp) |
| 工具（实测 v2.14.3） | `read_wiki_structure`、`read_wiki_contents`、`ask_wiki_question`（`repoName` 可传数组，最多 10 仓库） | 活体 tools/list + initialize instructions |
| 速率限制 | 未在一手来源找到数字（官方页通篇无 rate limit 说明） | 同上 |

实测记录：免 key `tools/call read_wiki_structure`（`vercel/next.js`）成功返回完整
目录结构；initialize 响应自带 server instructions（会进入系统提示）。一个文档陷阱：
官方文档把第三个工具写成 `ask_question`，实际暴露的是 `ask_wiki_question`（服务端
做了别名映射，传旧名也能通，但以实际名为准）。

两者公共用法均无需在 DSH 侧存任何凭据（`ctx.credentials` 用不上），`headers` 都可不配。

## 3. 落地路径（按推荐序）

### 路径 A（推荐）：本仓 configuration-only bundle `packages/mcp-docs`

零代码、零 peer 依赖（`dsh-mcp-client` 由 dsh 安装解析，bundle 不声明依赖）。
两个 server 都属「查文档」语义，合一个 bundle、patch 里两行 insert 正合适：

```yaml
# packages/mcp-docs/cordis.patch.yml
- insert:
    - id: mcp-context7
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: context7
        transport: streamable-http
        url: https://mcp.context7.com/mcp
        # 免 key 可用。要提额时注入 token（读 dsh 宿主进程环境变量）：
        # headers:
        #   Authorization: !!js '`Bearer ${process.env.CONTEXT7_API_KEY}`'
    - id: mcp-deepwiki
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: deepwiki
        transport: streamable-http
        url: https://mcp.deepwiki.com/mcp
        failOnStartupError: false   # 文档检索是增强项，挂了别拖垮启动
```

**环境变量注入 token：支持，是官方文档形态。** 两种写法（`$DSH/dsh-mcp-client`
README 的示例即此）：

- streamable-http：`headers` 值用 Loader `!!js` 表达式读宿主进程环境变量——
  `Authorization: !!js '`Bearer ${process.env.MCP_TOKEN}`'`（裸值 `!!js process.env.X`
  不带 `Bearer ` 前缀，要前缀就用模板字符串）。
- stdio：`env: { CONTEXT7_API_KEY: !!js process.env.CONTEXT7_API_KEY }`——显式
  `env` 覆盖擦洗规则存活（ambient 里 `*KEY*/*TOKEN*/*SECRET*/*PASSWORD*`、`DSH_*`
  默认被丢，不写 `env` 子进程拿不到）。

机制与限制（cordis-plugin-loader 源码核对）：`!!js` 在该行 config 解析时
（`internal/config` 阶段，对插件 ctx `with(ctx){eval(expr)}`）**求值一次**，不是每次
工具调用都读——改环境变量需重载配置（live profile 编辑该行即触发重挂）或重启 dsh；
且变量必须存在于 **dsh 宿主进程**的启动环境（本机即 nix 启动链路：`dsh` 由哪个
fish/systemd 会话拉起，变量就要在哪一层导出），不是模型侧 bash 的环境。

`failOnStartupError` 对 context7 也可设 `false`：两个都是外部网络服务，默认值本来就是
`false`（显式写出仅为可读性）。安装走本仓既有循环：`pnpm build`（本包无构建产物，
可跳过）→ `dsh plugin --profile web add ./packages/mcp-docs` → 重启。

### 路径 B：直接在 nix 配置加两行（最少文件）

用户的实际挂载通道是 `~/.config/nixos/home/ai/dsh/plugins.nix` 的
`programs.dsh.plugins`（remote-exec 等本仓插件都走这条，本会话的 `remote_exec` 工具
即其证）。MCP 行无需本地路径，直接：

```nix
{
  id = "mcp-context7";
  name = "@deepseek-ai/dsh-mcp-client";
  config = {
    serverName = "context7";
    transport = "streamable-http";
    url = "https://mcp.context7.com/mcp";
  };
}
```

deepwiki 同理。代价：配置散在 nix 仓而非本仓，与本仓「bundle 即插件源」的定位不符。

### 不需要：手搓插件

`dsh-mcp-client` 已把发现/命名/同步/重连/图像投影/资源桥全部做完；自写插件
`ctx.tools.register` 一个 MCP client 属重复造轮子，只有在要做 per-session 动态开关、
凭据 UI、工具白名单过滤这类 dsh-mcp-client 没有的策略时才值得（那是另一个需求）。

## 4. 接入后的模型体验与注意点

- 工具名：`mcp__context7__resolve-library-id`、`mcp__context7__query-docs`、
  `mcp__deepwiki__read_wiki_structure`、`mcp__deepwiki__read_wiki_contents`、
  `mcp__deepwiki__ask_wiki_question`；权限规则与历史按名存活。
- 工具 schema 进入每次请求（token 成本）；DeepWiki 的 server instructions 也会进
  系统提示。两个 server 共 5 个工具，成本可忽略。Context7 每问最多 3 次工具调用
  （服务端约束，工具描述里写明）。
- 外部网络服务经 mihomo tun——实测两个端点本机均 <1s 响应；若代理抖动，重连策略
  兜底，工具在断连期间「列着但调用失败」属预期行为。
- 后续要开更多 MCP server（memory、playwright 等）时，同一 bundle 里继续 insert 行
  即可，模式完全复用。

## 5. 验证状态

- [x] `$DSH/dsh-mcp-client` README/构建产物：传输枚举、字段表、无 SSE——读码核对。
- [x] 官方模板 `templates/mcp/`：configuration-only bundle 形态确认。
- [x] 当前 profile 无 MCP 行（profile 文件 + Inspect `Tool.listTools`）。
- [x] 两端点活体探测：initialize 200、tools/list、免 key tools/call 全通过
  （2026-10-11，本机 mihomo 网络）。
- [x] 官方文档/源码核对（后台 agent 一手调研）：端点、认证、key 前缀/额度、
  工具名/参数、SSE 状态（Context7 从未提供；DeepWiki 已 410）、DeepWiki 无 stdio。
- [ ] 实际安装 bundle 后 `mcp__*` 工具出现——待用户选定路径后实施时验证。
