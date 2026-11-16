# 调研：more-providers 的 MDKJ 图片附件服务报错

调研日期：2026-11-16。依据：本仓源码、当前安装产物、DSH 0.2.2-rc.1 的类型与实现，以及无网络差分实验。本次仅新增调研记录，未修改业务代码、profile 或 Nix 配置。

## 结论

**直接根因是 more-providers 创建 `PiAiAdapter` 时没有传入 `resolveAttachments`。** 请求历史含图片时，适配器无法取得附件服务，在供应商 HTTP 请求之前抛出 `pi-ai image input requires the durable attachment service`（`UNSUPPORTED_CONTENT`）。

与此前 OAuth 的问题同属插件图片链路不完整，但不能说是同一个实现缺陷：旧 OAuth 调研记录的是仅支持文本的序列化限制，以及随后修复的工具结果图片路径；当前 OAuth 已自行读取持久附件，more-providers 则漏接 stock 适配器的服务回调。参见[旧调研的实现记录](research-chatgpt-backend-image-input.md#L87)及[当前 OAuth 接线](../packages/oauth-providers/src/providers/chatgpt/index.ts#L179)。

## 直接证据

| 位置 | 已核实的行为 |
| --- | --- |
| [more-providers 的 buildAdapter](../packages/more-providers/src/providers.ts#L389) | 只传 `profiles`、`resolveApiKey`、`auth`，没有附件服务回调 |
| [插件 apply](../packages/more-providers/src/index.ts#L104) | 创建上述适配器后直接注册给 `ctx.llm` |
| [PiAiAdapterOptions][adapter-options] | `resolveAttachments` 是可选构造参数，因此漏传仍能通过类型检查 |
| [宿主抛错分支][image-guard] | 扫描所有 `options.messages`；含图且回调结果为 `undefined` 时抛出本报错 |
| [宿主实际发起流请求的位置][dispatch] | 在附件检查、图片读取和上下文转换之后，证明本报错早于供应商请求 |
| [stock 插件的接法][stock-wiring] | 请求时调用 `ctx.get('attachments')`，另配图片路径映射 |
| [图片能力 smoke 断言](../packages/more-providers/smoke.mjs#L219) | 验证的是目录模型声明 `['text', 'image']`，不能证明含图请求能成功转换 |

本次通过 Inspect 查询到当前 profile 的 `dsh-more-providers` 条目 `include:more-providers`，其 `packageDir` 为 `/run/user/1000/dsh/profile-IcwA4L/node_modules/dsh-more-providers`。该目录内的入口经 `realpath` 指向[本仓构建产物](../packages/more-providers/lib/index.js#L1146)，同样缺少回调；源码和所指向的产物均存在缺陷，重建同一份代码无法解决。

Inspect 还发现当前 profile 包含 `@deepseek-ai/dsh-attachment-local` 的条目 `include:attachment-local`。无论服务是否可用，当前 `buildAdapter` 都未尝试向宿主取它；增加宿主配置并不能替代插件内的这次接线。

## 无网络复现与单变量实验

使用当前构建产物导出的 `buildProviders` / `buildAdapter`，配置静态 `openai-responses` 模型、假 key、`https://example.invalid/v1` 与一张 1×1 图片引用。全局 `fetch` 被拦截，没有调用 MDKJ、读取真实凭据或使用用户附件。

差分实验只在内存中创建第二个 `PiAiAdapter`：保留第一个实例的所有构造选项，仅增加 `resolveAttachments: () => fixtureStore`。fixture store 返回固定 PNG 请求版本，模拟供应商响应固定为 HTTP 400，以明确实验只验证到请求边界。

| 场景 | 实测结果 |
| --- | --- |
| 原始适配器 + 含图 user 消息 | 完全相同的报错；`code=UNSUPPORTED_CONTENT`；附件读取 0 次；`fetch` 0 次 |
| 只补 `resolveAttachments` + 同一消息 | 附件读取 1 次；模拟 `fetch` 1 次；断言请求含正确的 `input_image.image_url = data:image/png;base64,…` |
| 原始适配器 + 历史图片 + 最新纯文字消息 | 同一报错；没有新请求 |
| 原始适配器 + 完全纯文字历史 | 能到达模拟供应商边界，无需读取附件 |

实际命令形式为 `node --input-type=module` 的内联隔离脚本，断言均通过；现有 `pnpm -C packages/more-providers smoke` 也通过并输出 `smoke OK`，说明现有 smoke 没有捕获这条含图请求故障。隔离实验输出：

```text
BASELINE: exact attachment error; reads=0; fetchCalls=0
ONLY CHANGE resolveAttachments: reads=1; mocked fetchCalls=1; input_image data URL verified
HISTORY IMAGE + TEXT FOLLOWUP: same attachment error; no new fetch
TEXT ONLY: reaches mocked provider without attachment service
```

因此影响范围不限 MDKJ：**凡是经该共享适配器、声明支持图片、且请求历史含 image block 的路由，都存在同一故障。** 历史中的用户附图或工具返回图片都可能触发；最新一条是纯文字并不能避开历史图片。

## OAuth 对照与修复建议

当前 OAuth 在[构造自己的适配器](../packages/oauth-providers/src/providers/chatgpt/index.ts#L179)时传入惰性 `resolveAttachments`；[prepareImages](../packages/oauth-providers/src/providers/chatgpt/adapter.ts#L443) 按附件 id 去重并调用 `readImageRequest`；[序列化](../packages/oauth-providers/src/providers/chatgpt/serialize.ts#L59)再将请求版本编码为 data URL。它自行实现这些步骤，more-providers 则将转换交给 `PiAiAdapter`。

最小修复应让 `buildAdapter` 接收取服务的闭包，并从 `apply` 传入：

```ts
resolveAttachments: () => ctx.get('attachments'),
```

按[宿主构造参数契约][adapter-options]在请求时解析服务，保持当前仅依赖 `llm` 的注入方式；补充 `@deepseek-ai/dsh-attachment` 的 peer/dev 依赖及所需类型声明合并。图片预算参数在 [profileFor](../packages/more-providers/src/providers.ts#L205) 中已经配置，无需用修改预算、key 或 baseURL 处理此报错。

建议同步对齐 stock 的另一项回调：

```ts
resolveImageAccess: (attachments, ref) =>
  resolveImageAttachmentAccess(
    attachments,
    (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
    ref,
  ),
```

`resolveImageAccess` 的[契约][image-access]是把附件宿主路径映射为工具执行环境可用的只读路径。**它是配套的路径提示能力，不是解除本报错的必要条件。** 上述单变量实验没有提供它，仍已成功生成图片请求。

回归验证应走插件 `apply → registerAdapter → stream` 的真实接缝，提供 fixture 附件服务并断言含图请求进入模拟供应商；再覆盖历史图片后追加文字、tool 图片、服务缺席及纯文字历史。仅检查模型目录包含 `image` 不足以锁住这个问题。

## 验证边界

- 本次已定位、复现并隔离插件缺陷；尚未实施修复。
- 未调用真实 MDKJ 后端，不能据此判断修复后的上游可用性、额度或具体模型的图片能力。
- 未读取用户实际模型配置和 `/models` 响应。若某个模型未声明 `image`，会先得到另一条 `does not support image input`；用户提供的本报错对应的是已越过该检查的分支。
- profile 安装路径与磁盘产物已核对；没有对运行进程做内存代码探测或重启。

[adapter-options]: ../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/types/adapter.d.ts#L69
[image-access]: ../node_modules/@deepseek-ai/dsh-llm/lib/types/content.d.ts#L7
[image-guard]: /nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L2000
[dispatch]: /nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L2025
[stock-wiring]: /nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L2946
