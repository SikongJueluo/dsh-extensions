# 调研：ChatGPT backend（`/backend-api/codex/responses`）的图像输入支持

> 结论先行：**`POST https://chatgpt.com/backend-api/codex/responses` 接受 Responses API 格式的图像输入，本插件"adapter 不支持图片"的硬拒绝是过时的自我限制，不是后端限制。** 官方参考客户端 Codex CLI（Rust）自 2025-04 首次导入起就向同一端点发送
> `{ "type": "input_image", "image_url": "data:image/png;base64,…", "detail": "high" }` 内容块；当前 codex 模型目录里全部 11 个模型（含 gpt-6 全家族 `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` / `gpt-6.1-sol`）的 `input_modalities` 均为 `["text","image"]`。放开只需改 serialize.ts 的用户消息分支 + adapter.ts 的 `inputModalities`。

- 调研日期：2026-10-01。方法：浅查无果后全量 clone `openai/codex`（含全部历史 + tags），逐文件读源码 + git 考古；上游 `werifu/dsh-oai-oauth` 同法核对。
- 源码 pin：openai/codex @ [`5aa92804`](https://github.com/openai/codex/commit/5aa92804d255dcaefe169dd7febb4006a2474e32)（2026-09-30，下称 CODEX，行号均取自该 commit）；werifu/dsh-oai-oauth @ [`75a0509`](https://github.com/werifu/dsh-oai-oauth/commit/75a0509a987cb4ba45dc293c0a23f2805988beb4)（2026-08-14，其 HEAD）。
- 本仓现状：[serialize.ts:27-35](../packages/oauth-providers/src/providers/chatgpt/serialize.ts#L27-L35) 对含图内容抛 `UNSUPPORTED_CONTENT`；[adapter.ts:335](../packages/oauth-providers/src/providers/chatgpt/adapter.ts#L335) 与 [:348](../packages/oauth-providers/src/providers/chatgpt/adapter.ts#L348) 广告 `inputModalities: ['text']`。

## 1. Codex CLI 发给该端点的图像 wire 形状（问题 1）

承载结构：`input: Vec<ResponseItem>`，用户消息是 `ResponseItem::Message { role: "user", content: Vec<ContentItem> }`（[protocol/src/models.rs L1012-L1030](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/models.rs#L1012-L1030)）。图像内容块定义（serde 属性逐字核对）：

```rust
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentItem {
    InputText { text: String },
    InputImage {
        #[serde(flatten)] image: ImageReference,
        #[serde(default, skip_serializing_if = "Option::is_none")] detail: Option<ImageDetail>,
    },
    InputAudio { audio_url: String },
    OutputText { text: String },
}
#[serde(untagged)]
pub enum ImageReference {
    Inline { image_url: String },   // → 平铺成 "image_url": "data:<mime>;base64,…"
    File { file_id: String },       // → 平铺成 "file_id": "…"
}
#[serde(rename_all = "lowercase")]
pub enum ImageDetail { Auto, Low, High, Original }   // "auto" | "low" | "high" | "original"
pub const DEFAULT_IMAGE_DETAIL: ImageDetail = ImageDetail::High;
```

来源：[protocol/src/models.rs L876-L936](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/models.rs#L876-L936)。即线上 JSON：

```json
{ "type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo…", "detail": "high" }
```

- `image_url` 是**内联 data URL**（[utils/image/src/lib.rs L55-L58](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/utils/image/src/lib.rs#L55-L58)：`format!("data:{mime};base64,{encoded}")`）；测试快照同样用 `data:image/png;base64,…`（[local_media_tests.rs L35](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/local_media_tests.rs#L35)）。`ImageReference::File { file_id }` 是服务端文件引用的另一形态。
- **没有 `filename` 字段**：文件路径只出现在 codex 额外包裹的说明性文本块里（`local_image_open_tag_text_with_path` 生成 `<image … path="…">` 开标签 + 闭标签，[models.rs L1666-L1690、L1844-L1866](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/models.rs#L1844-L1866)）——纯 UX 标注，非协议必需。
- `detail` 可省略（`skip_serializing_if`）；本地图片走 `Some(detail)`，默认 `high`（[models.rs L1856-L1860](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/models.rs#L1856-L1860)）。
- 请求体外层：`ResponsesApiRequest` 字段为 `model / stream / instructions / input / tools / tool_choice / parallel_tool_calls / reasoning / store / stream_options / include / prompt_cache_key / …`（[codex-api/src/common.rs L278-L302](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/codex-api/src/common.rs#L278-L302)），与我们插件现有字段一致。ChatGPT 登录路径恒定 `store: false`、`stream: true`、`include: ["reasoning.encrypted_content"]`（[core/src/client.rs L965、L995-L1012](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/core/src/client.rs#L995-L1012)）——**与是否含图无任何特殊交互**（构造处无按 content 类型的分支）。
- 端点本身：生产 base URL 为 `https://chatgpt.com/backend-api`（+ `/codex`），见 [agent-identity/src/lib.rs L59-L79](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/agent-identity/src/lib.rs#L59-L79)；本插件所打 `/backend-api/codex/responses` 即此 provider 的 responses 路径。

## 2. 版本历史与使用约束（问题 2）

- **TS 时代**：早在 2025-04-17 就有 "enhance image path detection in input processing"（[commit be7e3fd](https://github.com/openai/codex/commit/be7e3fd377)），说明重写前 TS CLI 已支持在 prompt 里附图。
- **Rust `codex exec`**：首次导入（2025-04-24，[commit 31d0d7a3 / PR #629](https://github.com/openai/codex/commit/31d0d7a305305ad557035a2edcab60b6be5018d8)）的 `exec/src/cli.rs` 就带着与今天完全相同的旗标定义（[exec/src/cli.rs L5-L13 @ 31d0d7a3](https://github.com/openai/codex/blob/31d0d7a305305ad557035a2edcab60b6be5018d8/codex-rs/exec/src/cli.rs#L5-L13)）；包含它的最早 release tag 为 `rust-v0.0.2504291921`（2025-04-29 前后的日期版 tag）。即 **Rust 版从第一个公开发布起就支持 `-i/--image`**。
- **交互式 TUI**：`--image` 旗标最迟在 [commit 2d52e3b4（2025-09-15，PR #3625）](https://github.com/openai/codex/commit/2d52e3b40a07d69ec90bd7c7909184a22d370c62) 已接线到 `interactive.images`（该 commit 让 `codex resume` 也能带 `--image`）；包含它的最早 semver tag 为 **rust-v0.35.0**。精确的"首次引入 interactive `--image`"commit 未再往下 pin（见 §6 未验证项）。
- **今天的旗标**：`-i, --image <FILE>`，`value_delimiter = ','`、`num_args = 1..` —— 可重复传、可逗号分隔，即**多图无数量上限**（[cli/src/main.rs L299-L301](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/cli/src/main.rs#L299-L301)）。源码中未发现"每请求图片数"限制。
- **格式**：解码支持 PNG / JPEG / GIF / WebP（[utils/image/src/lib.rs L127-L134](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/utils/image/src/lib.rs#L127-L134)）；但字节级直传仅 PNG / JPEG / WebP，其余（含 GIF）重编码为 PNG（[L354-L362](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/utils/image/src/lib.rs#L354-L362)，注释明言"官方 API docs 只支持非动图 GIF"）。
- **尺寸/大小**：非 `original` detail 统一 `ResizeToFit`，最长边 > 2048px 时Triangle 滤波缩到 ≤2048（`MAX_DIMENSION`，[L26、L163-L166](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/utils/image/src/lib.rs#L163-L166)）；另有 `ResizeWithLimits` 高/原图档位（high=2048px/2500 patches，original=6000px/10000 patches，[L73-L87](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/utils/image/src/lib.rs#L73-L87)）。字节上限 `MAX_PROMPT_IMAGE_INPUT_BYTES = 1 GiB`，源码注释称这只是"病态输入的兜底护栏，不是协议要求"（[L27-L31](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/utils/image/src/lib.rs#L27-L31)）。
- 附带发现：同一机制也支持音频（`InputAudio { audio_url }`，上限 50 MB，注释称"与 Responses API 音频输入上限一致"，[local_media.rs L12-L14、L39-L58](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/local_media.rs#L12-L58)）。

## 3. 模型与 vision 门控（问题 3）

- codex 打包的模型目录 `models.json`（models-manager 以"bundled models + cache + `/models`"合并远端目录，[models-manager/src/manager.rs L285-L296](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/models-manager/src/manager.rs#L285-L296)；远端就是 `GET <base>/models?client_version=…`，[codex-api/src/endpoint/models.rs L33-L53](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/codex-api/src/endpoint/models.rs#L33-L53)）**当前 11 个模型全部声明 `input_modalities: ["text","image"]` 且 `supports_image_detail_original: true`**：`gpt-6-astra`、`gpt-6.1-sol`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol/terra/luna`、`gpt-daybreak-blue/red-latest`、`gpt-5.5`、`codex-auto-review`（[models-manager/models.json](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/models-manager/models.json)，逐条核对）。目录里**没有裸 `gpt-6` slug**——gpt-6 家族以 astra/sol/luna 后缀呈现（Bedrock 侧目录同族命名可互证，[model-provider/src/amazon_bedrock/catalog.rs L19-L22](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/model-provider/src/amazon_bedrock/catalog.rs#L19-L22)）。
- wire 上省略 `input_modalities` 时，codex 的兼容默认值是 **`[Text, Image]`**，注释原话："conservatively assume both text and images are accepted unless a preset explicitly narrows support"（[protocol/src/openai_models.rs L186-L192](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/openai_models.rs#L186-L192)；`ModelPreset.input_modalities` 字段见 [L281-L282](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/openai_models.rs#L281-L282)）。
- **唯一的图像相关模型门控**是 `supports_image_detail_original`，且只影响 `detail: "original"`：不支持该档的模型会被降级/清洗为默认 high（[tools/src/image_detail.rs L5-L26](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/tools/src/image_detail.rs#L5-L26)）。codex 客户端**不会**因模型"无 vision"而拒绝发送 `input_image`；`input_modalities` 只用于 token/上下文估算等（如 [core/src/compact.rs L277](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/core/src/compact.rs#L277)）——"后端对非 vision 模型的 `input_image` 报什么错"在 codex 源码中无样本，未验证（§6）。

## 4. 第三方实现要点（问题 4）

- **必填字段**：只有 `type: "input_image"` + `image_url`（data URL）；`detail` 可选（省略或 `"high"`；`"original"` 仅对 `supports_image_detail_original` 的模型合法）；**无 `filename` 字段**（§1）。
- **`store: false` / `stream: true` 与图像无交互**：codex 的请求构造对含图/纯文本完全同路（§1 的 client.rs 引用）。
- **畸形图片不会炸请求**：codex 在客户端预校验，失败时**降级为文本占位块**继续发送，而不是让 turn 失败——`"Image located at \`x\` is invalid: …"`、`"Codex cannot attach image at \`x\`: unsupported image \`mime\`."`（[models.rs L1742-L1764、L1766-L1806](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/models.rs#L1742-L1806)）；超 1 GiB 在读取阶段被拒（[local_media.rs L60-L80](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/local_media.rs#L60-L80)）。
- **token 预算**（历史裁剪用）：缩放档图片按 7,373 bytes ≈ 1,844 tokens 估算；`detail:"original"` 按 32px patch 计、上限 10,000 patches（codex 注释援引官方 [images-vision guide](https://platform.openai.com/docs/guides/images-vision)，[core/src/context_manager/history.rs L1041-L1058](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/core/src/context_manager/history.rs#L1041-L1058)）。
- **工具输出也能带图**（可选进阶）：`FunctionCallOutputContentItem::InputImage` 存在并同样受 original-detail 清洗（[models.rs L2100-L2141](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/models.rs#L2100-L2141)）。
- harness 侧图片模型：`ImageBlock { type:'image', attachment: { attachmentId, mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif', bytes, width, height, … } }`，`inputModalities` 合法值 `['text','image']`（本机钉版 dsh-llm 0.2.0-rc.2 类型导出）——mime 与 codex 的直传格式集一一对应，`attachmentId` 需经附件服务取回字节再 base64。

## 5. 上游 werifu/dsh-oai-oauth（问题 5）

**没有加图像支持。** 其 HEAD（2026-08-14）[src/serialize.ts](https://github.com/werifu/dsh-oai-oauth/blob/75a0509a987cb4ba45dc293c0a23f2805988beb4/src/serialize.ts#L20-L27) 仍是与我们同源的 `assertTextOnly` 硬拒绝（同一条报错文案），全历史 `git log --grep=image -i` 无命中。无先例可抄，wire 改法以 codex 源码为准（§1）。

## 6. Conclusion for dsh-oauth-providers

**判定：过时的插件限制，不是后端限制。** 参考客户端自 2025-04 起就在这条 OAuth 线路上发图，当前目录所有模型（含 gpt-6 全家族）都声明接受 image 输入，且 codex 对 wire 的宽容默认（缺省即 text+image）也说明后端无"文本-only"约束。

需要的最小 wire 改动（[serialize.ts](../packages/oauth-providers/src/providers/chatgpt/serialize.ts)）：

1. 删掉用户消息路径上的 `assertTextOnly`（tool 输出路径可暂留文本）。
2. 用户消息 content 从"flatten 成单个 `input_text`"改为按块映射：`text` → `{ type:'input_text', text }`；`image` → `{ type:'input_image', image_url: 'data:' + mediaType + ';base64,' + base64(attachment bytes), detail: 'high' }`（字节经 `attachmentId` 从附件服务取回；GIF 建议重编码 PNG，>2048px 先缩放，对齐 §2 约束）。
3. [adapter.ts:335/:348](../packages/oauth-providers/src/providers/chatgpt/adapter.ts#L335) 的 `inputModalities` 改 `['text','image']`（可按模型目录的 `input_modalities` 投影）。
4. 其余不动：`store:false` / `stream:true` / `include` / `instructions` 与图像正交；畸形图可仿 codex 降级为文本占位而非抛错。

> **2026-10-01 已实现**（feat(oauth-providers): send images to the ChatGPT
> backend）：用户消息 `input_image` 直传（detail high + codex 风格 handle 文本）、
> offload 占位、`input_modalities` 目录投影（缺省 text+image）均已落地；GIF 按
> 附件服务的 mediaType 直传，未做 codex 的 GIF→PNG 重编码（后端接受静态 GIF）。

> **2026-10-02 补充（compact 回归修复）**：声明图片能力后，`read_image` 等工具会向
> 模型返回内嵌 live 图片块的 tool 结果（compact 抹掉原始 user 附图、模型重新读图即
> 触发），适配器最初只在 user 路径放行图片导致 UNSUPPORTED_CONTENT。修复：tool 结果
> 带图时 `function_call_output.output` 从纯字符串切换为 codex 同款 content-item 数组
> （`input_text` / `input_image`；见 [models.rs 的 FunctionCallOutputBody 与
> convert_mcp_content_to_items](https://github.com/openai/codex/blob/5aa92804d255dcaefe169dd7febb4006a2474e32/codex-rs/protocol/src/models.rs)，
> 注释明言 "output is encoded as either an array of structured content items
> or a plain string"）；assistant 角色图片仍拒绝（与 pi-ai 的 user+tool 白名单一致）。

**未验证项**（如实列出）：① 真实 ChatGPT OAuth 会话下 live `GET /backend-api/codex/models` 的响应体（以 codex 打包的 models.json 为代理）；② OpenAI 官方 docs 页面（developers/platform.openai.com）未直接抓取——仅引用了 codex 源码内注释转引的 [images-vision guide](https://platform.openai.com/docs/guides/images-vision)；③ 后端对非 vision 模型收到 `input_image` 时的具体报错（codex 无客户端门控、也无错误样本）；④ 交互式 TUI `--image` 的精确引入 commit（已 pin 到 ≤ rust-v0.35.0 / 2025-09-15）；⑤ live 后端是否存在裸 `gpt-6` slug（目录中无）；⑥ `ResponseItem` 外层 message 的 serde tag（`"type":"message"`）未逐字核对——我们现有无 tag 的 `{role, content}` 形态后端已接受，稳妥起见新增图像时与 codex 保持同构即可。
