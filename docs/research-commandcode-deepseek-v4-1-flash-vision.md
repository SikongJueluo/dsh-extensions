# 调研：CommandCode DeepSeek V4.1 Flash 无法发送图像

日期：2026-11-17（Asia/Shanghai）。范围：公开一手文档、实时公开模型目录、本仓 more-providers 与 DSH 0.2.2-rc.1 实现。没有调用付费推理接口、读取真实 API key、修改插件行为或运行配置。

## 结论

**用户记忆正确：DeepSeek V4.1 Flash 支持原生视觉。当前本地拒绝图片的直接原因是 CommandCode 模型目录缺少输入模态字段，而 more-providers 的能力兜底规则没有覆盖这个型号，最终把它声明为纯文本。**

证据链：

```text
CommandCode /models：deepseek/deepseek-v4.1-flash，没有 modalities.input
  → more-providers：不匹配 Claude / GPT / Google 三类视觉兜底
  → pi-ai model.input = ["text"]
  → DSH inputModalities = ["text"]
  → 图片提交时报 MODEL_DOES_NOT_SUPPORT_IMAGES
  → 尚未发往 CommandCode 推理接口
```

这不是根据模型名字推断视觉能力；DeepSeek 官方说明与 CommandCode 精确型号页面均提供了独立证据。但本次没有真实发送图片，不能保证放开本地能力标记后，CommandCode 当前转发链路一定端到端可用。

## 上游事实

| 来源 | 已确认内容 |
| --- | --- |
| [DeepSeek V4.1 官方发布文](https://api-docs.deepseek.com/news/news260910/) | V4.1 Flash 有 “native visual understanding” / “native multimodal support”；DeepSeek 官方调用名为 `deepseek-flash` |
| [DeepSeek Vision 指南](https://api-docs.deepseek.com/guides/vision/) | `deepseek-flash` 接受图片与文本；Chat Completions 使用 `image_url`，Responses 使用 `input_image` |
| [CommandCode 精确型号页面](https://commandcode.ai/models/deepseek-v4-1-flash) | 对 `deepseek/deepseek-v4.1-flash` 描述为 “V4.1 hybrid-attention reasoning with vision.” |
| [CommandCode 公开模型目录](https://api.commandcode.ai/provider/v1/models) | 当前条目提供模型 ID、名称、上下文窗口、端点，但没有 `modalities` |
| [CommandCode 官方 pi provider 源码](https://raw.githubusercontent.com/CommandCodeAI/pi-commandcode-provider/main/index.ts) | 官方参考实现也只有 Claude / GPT / Google 三类视觉兜底；目录缺模态且未命中家族时同样退为纯文本 |

公开目录中目标条目的实测值：

```json
{"id":"deepseek/deepseek-v4.1-flash","object":"model","created":1794929663,"owned_by":"command-code","name":"DeepSeek V4.1 Flash (latest)","context_length":1000000,"supported_endpoints":["/chat/completions","/responses"]}
```

`/chat/completions` 与 `/responses` 表示协议端点，不能代替视觉能力声明。同一目录中的 `deepseek/deepseek-v4.1-flash-fast` 与 `deepseek/deepseek-v4.1-flash-ultrafast` 也缺少模态字段；本次没有逐个验证这些变体的视觉保证。

## 本地实现与挂载核对

- [视觉兜底名单](../packages/more-providers/src/commandcode.ts#L41)只有 `claude-`、`gpt-`、`google/`。
- [inputOf](../packages/more-providers/src/commandcode.ts#L102)优先使用 `modalities.input`，缺失时套用名单，否则返回 `['text']`。
- [toPiModels](../packages/more-providers/src/commandcode.ts#L126)把结果写入 pi-ai 模型 `input`。
- [PiAiAdapter 模型信息](../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L1937)把 `model.input` 原样映射到 `inputModalities`。
- [Host 图片准入][admission]在能力不包含 `image` 时抛出 `Model "…" does not support image input.`，reason 为 `MODEL_DOES_NOT_SUPPORT_IMAGES`。
- [Adapter 图片检查](../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js#L2000)还有第二道拒绝：`pi-ai model "…" does not support image input`，发生在供应商请求之前。

Inspect 确认本次挂载条目为 `include:more-providers`，`packageDir` 为 `/run/user/1000/dsh/profile-xYa9rs/node_modules/dsh-more-providers`；对该目录执行 `readlink -f`，结果指向本仓 `packages/more-providers`。因此诊断使用的本仓构建产物与挂载包磁盘路径一致；没有对进程内已加载代码做探测或重启。

此模型同时声明两个协议端点，插件当前选 `openai-completions`，因为其 ID 不以 `gpt-` 开头。当前拒绝由能力标记触发；改用 Responses 不是解除该拒绝的必要条件。

## 复现与验证

在 `packages/more-providers` 下用实际构建产物及实时匿名目录运行：

```sh
node --input-type=module <<'JS'
import { fetchCatalog, toPiModels } from './lib/index.js'
const items = await fetchCatalog('https://api.commandcode.ai/provider/v1/models', 10000)
const item = items.find(x => x.id === 'deepseek/deepseek-v4.1-flash')
if (!item) throw new Error('Flash missing from anonymous catalog')
const model = toPiModels([item], {
  baseURL: 'https://api.commandcode.ai/provider',
  provider: 'command-code',
})[0]
console.log(JSON.stringify({ id: item.id, modalities: item.modalities?.input ?? null,
  api: model?.api, input: model?.input }))
if (!model?.input.includes('image')) throw new Error('REPRO: Flash incorrectly marked text-only')
JS
```

调查分支已运行等价脚本并确认实际输出为：

```text
{"id":"deepseek/deepseek-v4.1-flash","modalities":null,"endpoints":["/chat/completions","/responses"],"api":"openai-completions","input":["text"]}
REPRO: current registry marks Flash text-only
```

该分支的原脚本以“出现当前错误映射”为成功条件；上面的复核命令改成以“支持 image”为通过条件，因此当前状态会失败，便于后续修复验证。

其他已运行检查：

- `pnpm exec vitest run test/api-key-images.test.ts`：10 项通过。这组验证自定义 gateway 的通用附件处理，没有覆盖 CommandCode 对目标型号的能力映射。
- `node smoke.mjs`：`smoke OK`。同样没有捕获这个目录缺字段的能力遗漏。

因此“现有图片测试通过”与“这个型号被拒绝”并不矛盾。

## 处理建议

1. **首选修正本插件的能力映射。** 保持上游显式 `modalities.input` 优先，在缺字段时为已有一手视觉证据的精确型号补充能力；不要把所有 `deepseek/*` 一概标为视觉，旧型号能力不同。至少覆盖当前目录条目、显式文本声明优先，以及旧纯文本型号不被误标。
2. **上游长期修复是补齐目录模态。** CommandCode 若为目标条目返回 `modalities: { input: ['text', 'image'] }`，当前插件会自动采用；官方参考 provider 也存在同样的缺字段兜底遗漏。
3. **配置绕行可新增独立 custom 路由。** 采用该精确 ID、`api: openai-completions`、`baseURL: https://api.commandcode.ai/provider/v1`、静态 `models` 与 `input: [text, image]`，并保留 CommandCode 所需的 `supportsDeveloperRole: false` / `maxTokensField: max_tokens` 兼容参数。这只是可行方向，本次未写入或实测配置。不要直接给现有 `kind: command-code` 增加 `models`：[校验器](../packages/more-providers/src/config.ts#L344)明确禁止，会使整份配置失效。用户环境由 Nix 管理，部署变更应在 flake 中声明。

若实施插件修复，需要构建并按现有 Nix 管理方式部署、重启 DSH，刷新页面后复核模型能力；单独刷新页面无法改变启动时注册的 provider。之后用一张简单测试图做真实识图验证，才能闭合 CommandCode 上游转发是否可用的最后一环。

## 与旧附件故障的关系及证据边界

[此前附件调研](research-more-providers-image-attachments.md)记录的是适配器遗漏 `resolveAttachments`，报错为 `pi-ai image input requires the durable attachment service`。本次是更早的“模型不支持图片”能力检查，错误与修复点不同。当前通用附件测试已通过，不能将旧调查快照直接套到本次现象。

本次未修改业务代码、运行 profile 或 Nix 配置；仅记录研究。未读取用户当前 YAML 或会话日志，也没有在 GUI 中重放原始提交。已确认的是实际目录经过本仓映射会产生纯文本能力，且 Host 对该能力必然拒绝图片；不是对用户原会话每一步的现场回放。

[admission]: /nix/store/yfkrml52prf8himzszzvs7isfz3y96gm-dsh-0.2.2-rc.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js#L844
