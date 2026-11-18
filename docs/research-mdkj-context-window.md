# 调研：为什么 MDKJ 的 GPT-6.2 在 DSH 显示 131K

调研日期：2026-11-18。环境：当前 Web profile、DSH 0.2.2-rc.1、实际挂载的 `dsh-more-providers`。只新增本记录，没有改动业务代码、Nix 或运行配置。

## 结论

**131K 是本机 `more-providers` 插件给缺失窗口元数据的模型填的默认值 `131072`，不是 MDKJ 返回的窗口，也不是 DSH 把 272K 减去输出预算后的结果。** 当前 MDKJ Stable 和 Cheap 的目录都列出了 `gpt-6.2-sol`、`gpt-6.2-astra`，但两条路由都没提供这两个模型的窗口字段；本机静态配置也只为 `gpt-6.1-sol` 填了窗口。

## 本机证据

1. 对两条路由配置里的同一个 [MDKJ 模型目录](https://mdkj.lol/v1/models) 分别做了一次认证 `GET`。两次均为 HTTP 200，各返回 7 个模型。两个 GPT-6.2 条目均只有 `id`、`object`、`created`、`owned_by`、`type`、`display_name`，没有上下文窗口或输出上限字段。没有记录凭据，也没有调用推理接口。
2. [目录解析](../packages/more-providers/src/providers.ts#L154) 从 `context_length`、`context_window`、`contextWindow` 依次读取正整数，目录未给时只从[相同模型 ID 的静态配置](../packages/more-providers/src/providers.ts#L243)补值。[本机 Nix 配置](</home/sikongjueluo/.config/nixos/home/ai/dsh/more-providers.yaml#L39>)的 `524288` 属于旧的 `gpt-6.1-sol`，不会被两个 GPT-6.2 模型继承。都没有值时，[构造模型](../packages/more-providers/src/providers.ts#L92)用 `131072`；`maxTokens` 是另一项，不参与这次取值。
3. [适配器][adapter]将窗口原样交给宿主，[agent loop][agent-loop]写入请求的上下文事件，[token meter][token-meter]再把它交给 [Web 会话组件][client-ui]作为上下文占用的分母。Web 按十进制千位四舍五入，所以 `131072` 显示为 `131K`。如果启用了[自动压缩][compaction]，其阈值也会基于这个窗口另算；压缩不是 131K 的来源。

用当前安装产物跑了隔离实验：假凭据、拦截目录请求、不发推理，经过 `buildProviders → buildAdapter → resolveModel`。

| 目录窗口 | 同 ID 静态窗口 | 适配器实际窗口 |
| --- | --- | --- |
| 缺失 | 缺失 | 131072 |
| 缺失 | 272000 | 272000 |
| 250000 | 272000 | 250000 |

## 272K 是哪一层的数字

| 来源 | 数值和含义 |
| --- | --- |
| OpenAI 官方 API：[Sol][openai-sol]、[Astra][openai-astra] | 都是 1,050,000 总窗口、922,000 最大输入、128,000 最大输出；输入超过 272,000 token 是长上下文**计价阈值**，不是输入上限。 |
| Sub2API [记录的 Codex 0.169.0 目录][codex-catalog]：[Sol][codex-sol]、[Astra][codex-astra] | 该目录快照中，Sol 的 `context_window` 是 500,000，Astra 是 272,000。这是特定 Codex 目录的值，不是 MDKJ 当前账号的实测限制。 |
| 当前 MDKJ 两条路由 | `/v1/models` 没发布 GPT-6.2 的窗口。未复核用户看到的 272K 对应哪个模型或页面字段，也未压测 MDKJ `/responses` 的输入上限。 |

因此，如果页面说的是 **Astra 的 Codex 窗口**，272K 与该目录快照一致；如果说的是 **Sol**，不能从 Astra 的窗口或 OpenAI 的计价阈值推导出 Sol 的可用窗口。也不宜把 OpenAI 直连的 1.05M 直接填给 MDKJ。

## 怎么调整

先确认 MDKJ 对**具体模型 ID 和账号**承诺的窗口。若确认 Astra 在该路由的适用值确实为 272,000，在 [Nix 管理的配置](</home/sikongjueluo/.config/nixos/home/ai/dsh/more-providers.yaml#L39>)中保留现有 6.1 条目，并在 `providers.mdkj.models` 下追加：

```yaml
- id: gpt-6.2-astra
  contextWindow: 272000
```

当前两个账号都[继承 provider 的 `models`](../packages/more-providers/src/config.ts#L457)，所以共享项会同时补给两条路由；若只有某个账号适用，应在该账号的 `models` 写相应列表，并保留该账号所需的已有条目。应用 Home Manager 配置并重启当前 `dsh-web`，在对应路由发起一条新请求后再看分母。这个配置只补 DSH 的本地元数据和预算，不会提高网关的实际限制；将来 MDKJ 若返回有效窗口字段，目录值优先。

[openai-sol]: https://developers.openai.com/api/docs/models/gpt-6.2-sol
[openai-astra]: https://developers.openai.com/api/docs/models/gpt-6.2-astra
[codex-catalog]: https://github.com/Wei-Shaw/sub2api/pull/8906
[codex-sol]: https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/pkg/openai/codex_gpt62_sol.json
[codex-astra]: https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/pkg/openai/codex_gpt62_astra.json
[adapter]: </nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L1945>
[agent-loop]: </nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L1066>
[token-meter]: </nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js#L449>
[client-ui]: </nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js#L21519>
[compaction]: </nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js#L124>
