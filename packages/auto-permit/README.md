# dsh-auto-permit

DSH 的 AI 自动审批判官：在 `approval/request` waterfall 上插队一个 answerer，
人工弹窗之前由一个小模型决定是否放行 bash 的 sandbox 提权请求。

## 行为

当一次 bash 审批请求到达时（通常是命令被 sandbox 拒绝后模型带
`sandbox_permissions` 重试），按顺序处理：

1. **不可逆形状与容器边界**：内置形状（强制删除指向绝对路径/`~`/`$HOME`/
   `..`、`git clean -xfd`、`git reset --hard`、`git push --force`、`sudo`、
   `curl|sh` …；`podman run --rm` 与镜像 tag 里的 `-f` 不再被当成 `rm -f`）∪ 容器边界
   （compose/manifest、远端目标、privileged/设备/capability 放宽、host
   网络/PID 等、引擎 socket、HOME/根/凭据/配置挂载（含 `-v源:目标` 附值、
   `-itv` 分组短选项、尾斜杠/重复斜杠归一化）、既有容器生命周期
   （含 `podman container …` 分组写法）、volume/全局 prune、push（含
   `podman image push`/`manifest push`）、宿主引擎配置）→ 永远交人工，
   不过模型。挂载 [dsh-cmd-permit](../cmd-permit/) 时两侧取**并集**：本插件
   自己的边界不因链上另有一个（可能较旧的）表而失效。该并集同时是
   cmd-permit 的共享 `isHighRisk` oracle，所以显式白名单也覆盖不了这些形状。
2. **显式白名单**：cmd-permit 命中 → 放行（用户显式声明信任，优先于记忆
   与判官）。
3. **精确记忆**：同一条命令 + 同一提权目标本会话已被链路后方（人工弹窗）
   放行过 → 直接放行，不调用模型。容器引擎调用与 `.sh/.bash` 脚本**不
   适用**：效果来自可变文件/引擎状态，命令字符串相同不代表效果相同，
   必须每次重审。
4. **判官调查与判决**：每次审批启动一个短生命周期、干净上下文的只读判官
   回合，证据 = 会话内全部用户 prompt（截最近 16 条）+ 待批命令全文（含
   description / justification、调用 workdir，分别标记为 agent 声称或调用
   上下文）+ 宿主记录的 effective cwd 与按宿主规则解析的 working directory
   + 不可变会话 workspace + 本会话已批准命令列表。判官只有三个工具：
   `read_file`、`list_dir`、`search_files`——读文件、列目录、按字面搜索；
   没有 shell、写文件、网络、Podman 或再委派。简单命令可直接判；脚本 /
   Makefile / wrapper 的实际效果决定请求时，判官先按需读取项目证据再判。
   `VERDICT: allow` → 放行；其余一切（defer、超时、预算耗尽、模型/解析
   失败、证据不可读或放行前被修改）→ 回落到人工弹窗，并带稳定分类。

证据来源：待批命令从会话日志恢复，两种形态等价——直接调用读顶层
`tool/call`（`callId` + JSON 字符串参数），`run_code`（PTC）子调用读宿主
执行**前**写入的 `tool/ptc-dispatch-start`（`subCallId` + 对象参数；批准
发生时它是唯一已落盘的审计行，执行后的 `tool/ptc-dispatch` 不读）。两路
共用同一份按精确调用 id 的索引，历史批准与精确记忆随之 direct/PTC 互通；
畸形参数、同 id 内容冲突（含 workdir 冲突）、缺 start 事件的旧宿主一律视为
证据不可恢复 → `next()` 交人工，绝不猜测。

**待批命令不做截断**：硬规则、容器边界和白名单必须看到完整输入，危险尾部
不能因为截断前缀而消失。判官侧另有 8000 字符的证据预算；完整命令超过预算
时**直接 defer 交人工**（`the complete command exceeds the judge evidence
budget`），绝不用截断前缀让模型判完整命令。

**长人类输入保留首尾与正式 Task**：单条 prompt 超过剩余预算时，不再只取
前缀。新格式保留开头与结尾（最新授权通常在尾部），并单独抽取
`## Task` / `## 任务` 小节（位于被省略中段时），所有省略都带字数标记。
这修复了实测中 13,184 字符 handoff 把位于 12,841 的正式 Task 截掉的问题。

### 判官调查的边界（v5）

- **能力只由程序提供**：判官工具的实现（`src/inspect.ts`）只做 `readFile`/
  `readdir`/字面搜索。所有路径先 `realpath` 再检查是否仍在 session
  workspace 内；symlink 越界、`..` 越界、HOME/其他项目、`.git`、`.ssh`、
  `.env*`、私钥类文件一律拒绝。项目文件内容只作为证据回传，永远不会变成
  判官的系统指令或用户消息。
- **预算**：每次审批最多 6 个模型 step、12 次工具调用、32 KiB 证据输出
  （单次读 12 KiB、单文件 256 KiB、搜索扫描 4 MiB / 400 文件 / 60 条匹配）、
  总时限 45 秒。工具证据总输出是**硬上限**：会越界的整次结果被拒绝，不截断后
  放行。任何工具错误、截断、搜索上限、超大/非文本文件或预算耗尽都会把本回合
  永久标记为不可 ALLOW；后续成功读取不会“补全”并清除该事实，最终裁决由程序
  强制回人工。策略排除项（`.git`、`.env`、`node_modules` 等）**不计入**
  `list_dir` 截断；只有真正超过可见条目上限、或 `search_files` 匹配行被
  裁剪、或有文件被跳过时才算不完整。
- **模型输出预算**：每次模型请求的输出预算默认 8192 token（行 config
  `maxOutputTokens`，允许 256–32768）。思考模型的 reasoning token 计入该
  预算，因此按可见输出估算的 1024 会在 `high` 思考下截断判决。命中上限仍然
  一律 defer 交人工，不解析残缺 verdict，也不因片段里出现 `allow` 而放行。
  每个 step 通过 `ctx.logger` 记录 finish kind、请求预算、effort、usage 与
  耗时，用于区分 token 截断、政策 DEFER 和超时。usage 取决于适配器上报：
  当前 DeepSeek 适配器给出 input / output / cache 计数，不单独提供
  `reasoningTokens`，因此总输出可观测，精确思考用量可能缺失。
- **版本复核**：判官读过的每个逻辑路径记录 realpath 目标 + 内容 sha256 +
  `mtime+size`。同一路径第二次读取若目标或哈希变化，立即 invalidated 并拒绝
  后续 ALLOW；准备 ALLOW 前还会重新 realpath、stat、重读哈希，因此 symlink
  在读后被改指、文件跨两次读取被改都会触发 `evidence-changed`。这是有限
  防护，不是冻结程序或环境，也不消除最终检查之后的 TOCTOU。
- **生命周期**：45 秒截止在创建 inspector 之前开始；模型流、所有工具 I/O、
  最终复核都与请求 signal 竞速，取消/超时后即使模型已输出 `VERDICT: allow`
  也不会放行。
- **失败分类**：`policy`（判官明确 DEFER）、`budget`、`timeout`、`canceled`、
  `provider-error`、`invalid-response`、`empty-response`、
  `evidence-unavailable`、`evidence-changed`、`internal-error`。分类与判官
  引用的文件:行号进入 notice 与 `ctx.logger`，便于事后复现。
- **不可递归**：判官没有可以触发审批的工具；它也不能调用自身或子 Agent。
  父审批取消/超时会 abort 整个回合；插件只把裁决回填到父请求，不自行执行
  待批命令。
- **数据外发**：判官按需读取的项目文件片段会发送给配置的判官模型。默认范围
  是 session workspace，`.env*`、私钥后缀、`.git`/`.ssh` 等已拒绝，但不能
  保证覆盖所有秘密；不要把判官指向不可信的 provider。判官模型需支持原生
  tool calls，不支持时调用失败 → 人工弹窗。

**执行目录分三件事**，不能混用：

- `call_workdir`：模型给调用参数里的 workdir；
- `effective_cwd`：宿主 `working-directory` 服务记录的当前目录（审批时读
  `ctx.workingDirectory.get(session)`；服务不可用时回退日志里最后一条
  `working-directory/change`，再回退不可变 header）；
- `resolved_working_directory`：按宿主 `resolveWorkdir` 规则解析——
  省略 workdir 就用 effective cwd，相对 workdir 拼接到 effective cwd，
  绝对 workdir 原样；拿不到有效目录或路径超长标 unavailable。

`session_workspace` 单独保留为**不可变的原始项目**（session header.cwd）；
它和 effective cwd 可以不同（agent 改过工作目录时）。判官以 resolved
working directory 判断 `$PWD`/相对路径，并要求宿主路径落在 session
workspace 内；两者任一不可靠即 DEFER。workdir/目录字符串不是安全证明。工作
目录值只做有界显示（超长截断并标 unavailable），不参与硬规则判定。

判官**永不返回 rejected**——AI 的保守误报不能伪装成用户的明确拒绝；
任何插件自身故障也都回落人工（fail-open 向人），坏了最多退回原生行为。

非 bash 工具的审批一律 `next()` 交还原链路。风险自担：**放行即整条 bash
命令在沙箱外以 Full access 执行**，不是只开放 Podman 缓存目录；判官是风险
判断，不是隔离。请谨慎选择判官模型。

## 可见性

每次判官决策都向会话 log 追加一条 `form: 'notice'` 消息，Web 对话流以
**折叠行**形式持久显示（不展开即可读，随 session 回放；官方 model-switch
通知同款形态）：

- `auto-permit ✓ allowed: <命令>`——判官放行；
- `auto-permit ✓ allowed (seen this session): <命令>`——精确记忆命中，
  零模型调用；
- `auto-permit ✎ deferred to you: <命令>`——判官不确定/超时/预算耗尽/模型
  失败，回人工弹窗（展开可见分类、理由与证据文件:行号）；
- `auto-permit ⚠ irreversible shape — needs you: <命令>`——高风险形状
  直接转人工；
- `auto-permit ⚠ container boundary — needs you: <命令>`——容器边界形状
  （compose、privileged、既有容器生命周期等）直接转人工，展开可见具体
  边界（`boundary: …`）。

注意：notice 的一行正文会进入模型 transcript（这是唯一能进对话流的第三方
通道，官方未开放零上下文的纯 UI 行）；单行成本极低，且模型知道提权被放行
是正面信息。host 侧同时通过 `ctx.logger` 记日志（`journalctl --user -u
dsh-web | grep auto-permit`）。

### notice 的投递通道（顺序安全，勿改成 `session.append`）

notice **必须**经 `agent.inject()` 投递（见 `deliverNotice()`），不能直接
`session.append('user/message', …, { surfaceOp: 'append' })`。

原因：审批请求是在 agent loop 的 `runGroup` 内部抛出的，此刻
`assistant(tool_calls)` 已落盘（`tool/call` 先于 dispatch 提交），而
`tool/result` 要等 `commitReady` 之后才写。在这个窗口往 surface 追加
`user/message`，`deriveMessages()` 就会投影出
`assistant(tool_calls) → user → tool` 的顺序；OpenAI 兼容端点直接回 HTTP 400，
而且坏顺序已经固化进历史，该会话之后**每一次**请求（含 `/compact`）都会失败。

实证：DSH session `5528dac7` seq 121–129——seq 125 的 auto-permit notice 夹在
seq 121 的 `tool/call` 与 seq 129 的 `tool/result` 之间，整个会话就此卡死。

`agent.inject()` 是宿主自己在这个场景下的答案（`ApprovalService.setPolicy()`
投递轮中通知用的就是它）：消息排进 `next-step` inbox、**不**唤醒 driver，等本批
tool 结果落盘、下一个 step 边界被领取时才写成 surface 的 `user/message`——折叠
行形态不变，顺序正确。dsh-cmd-permit 的 allowlist 通知走同一个 `deliverNotice()`。

回归检查（无需 API key、不发网络请求）：

```sh
pnpm -C packages/auto-permit test             # vitest：证据 fold + 只读调查 + 审批链集成
node packages/auto-permit/test/notice-order.mjs
```

它用真实 `Session` 重放失败会话的事件顺序，断言 `assistant(tool_calls)` 后面
紧跟配对的 `tool` 消息；surface-append 路径失败，`agent.inject()` 路径通过。

## 判官判据（v5）

v5（2026-11-06）在 v4 容器判据上增加**只读项目调查**：wrapper / 脚本 /
Makefile 不再是绝对排除项，只有其实际效果能从被检查证据中确认并满足边界
才可 ALLOW。其余判据延续 v4：

1. **显式意图**（v3 不变）：用户明确意图点名/唯一识别每个操作的目标与效果、
   覆盖其完整范围、效果可恢复 → 可 ALLOW。
2. **同族命令等价**（v3 收紧）：同 session 批准过同族命令后，仅差子命令组合、
   输出截断包装、env 前缀、重复幂等执行仍视为等价——但前提是该次提权本身
   依判据 1 独立成立，且缓存上限不适用。**同族等价不适用于容器调用**：效果
   依赖可变文件与引擎状态，每次调用必须按判据 3 独立成立。
3. **缓存上限**（v3，覆盖判据 1/2）：越界写工具链公开缓存/registry/store
   （~/.cargo、~/.cache、~/.npm、~/.pnpm-store、~/.uv…）是**沙箱层**的事，
   不是审批层的事。当输入的越界效果**只有**缓存写入时——即使用户意图明确
   覆盖运行该工具——返回 DEFER：正确修复是启用 toolchain-access 目录授权，
   而不是按命令放宽沙箱。容器运行时自身的开销（HOME 下的镜像/容器存储、
   namespace、overlay）**不算**这条缓存写，按判据 4 判断；v3 的缓存上限本身
   不变。
4. **容器构建/临时验证**（v4 新增，v5 扩展 wrapper）：用户明确要求构建、
   测试或临时验证**本项目**（或同样具体的容器任务），命令是本地、当前用户
   身份的 podman/docker 调用（直接调用，或经判官检查确认每个 engine 操作
   的项目脚本/Makefile），且每个效果都落在边界内 → 可 ALLOW。边界：
    - 效果限于引擎状态查询、拉取构建所需镜像、从项目上下文构建镜像、为项目
      构建/测试创建并运行一次性（`--rm`）容器，以及同一构建在 workspace 内的
      记账（build 目录 mkdir、stat/检查产物、echo/控制流、只读宿主查询）；
      构建镜像自身拉取基础镜像和依赖的网络属于镜像构建，不是 host namespace；
      显式 `--network host`/`--pid host` 等仍交人工；对既有容器的单独启停/
      exec/rm 一律交人工；
    - 宿主机路径只能在会话 workspace 内（`$PWD`/`${PWD}`/`$(pwd)` 按宿主
      规则解析：resolved working directory = 省略 workdir 取 effective
      cwd、相对 workdir 拼到 effective cwd；effective cwd 由
      working-directory 投影记录，可能已不在原始项目内）。无法解析、
      目录不可用或 working directory 落在 workspace 外 → DEFER；
      引擎自己的镜像/容器存储不算宿主路径；
    - 无引擎 socket、无凭据/配置挂载、无 HOME/宿主根挂载；无
      `--privileged`/设备/`--cap-add`/security-opt 放宽/`--ssh`；无 host
      网络/PID/IPC/UTS/userns；
    - 无 push、system/machine/generate、宿主容器配置修改、全局 prune/reset，
      不删除本任务未创建的资源。

   以下一律交人工（程序硬规则或判官 DEFER）：compose（解析后的挂载/卷/
   网络不在命令字符串里）、运行时生成或 source 的脚本、宿主侧下载后执行的
   代码、效果无法从被检查文件确认的 wrapper / Makefile / 辅助程序、远端或
   无法确认的引擎目标、既有容器的 exec/stop/rm 等生命周期（首版没有可信的
   资源归属证据）、volume/全局 prune/reset、镜像 push、宿主引擎配置。
   `rootless`、`--rm`、名字带 test、`localhost/` tag 只是佐证，不是安全
   保证。

历史背景：v3（2026-10-21，随 [dsh-toolchain-access](../toolchain-access/)
迁移）收敛 v2 的「缓存副作用可 ALLOW」判据；v2（2026-10-02）当时目录授权
尚不存在，按命令提权是唯一出口，如今缓存需求由 toolchain-access 的
`cargo-cache` 等预设承担。判官 prompt 版本 `dsh-auto-permit-v5`；
`approval/request` 链序与失败回落不变。

容器硬规则是**文本启发式**（token 扫描，不是 shell/Podman 解析器）：可能
多拦（多一次人工弹窗），也可能漏掉变形（变量、非常规 wrapper）——漏掉时
仍由判官按判据 4 保守判断。它不宣称完整性，也不是隔离边界。

**exact-repeat 记忆的来源门控（2026-10-22，按审查收紧）**：审计事件
（`approval/decided`）只记录结果、不记录批准者，日志里的「批准过」无法证明
来自用户还是旧插件规则。因此重放条件收紧为「**本进程**观察到该批准来自链路
后方（人工弹窗或重新考量过的其他 answerer）」；本插件自己给出的自动批准
（判官/白名单/记忆）不再可被重放——v2 时代的缓存批准不会升级为持续授权。
进程重启后观察记录为空，历史批准一律交判官/人工重新决定。容器引擎调用与
shell 脚本另外再加一道：即使来源合格也不重放（可变文件/引擎状态）。

## 配置

插件行 config（全部 volatile，`{enabled, provider, model, reasoningEffort?, maxOutputTokens}`）：

- **enabled**（默认开；未配置判官模型时不生效）。
- **provider** / **model**：判官模型路由。必须显式指定——不跟随会话模型，
  避免主模型审自己。可选 **reasoningEffort** 思考强度。
- **maxOutputTokens**（默认 8192，范围 256–32768）：单次模型请求的输出
  token 预算；思考 token 计入。达到上限仍回人工。Web 设置分区目前只编辑
  enabled / 模型 / 思考强度，预算字段在行 config 声明处（Nix、profile patch
  或 settings API）修改；不声明时使用默认值。
- 写错模型 id 是安全的：判官调用失败 → defer → 回人工弹窗（fail-open）。

容器判据与只读调查（v5）随插件启用生效，**没有单独的开关**：安装插件并配置判官路由
本身就是对这套自动审批的信任声明；关掉 **enabled** 后本插件不再处理任何
审批（全部回人工，硬边界形状本来也只回人工）。

两种配置方式（取决于行的来源层，dsh 0.2 的规则是"行 config 权威归定义层"）：

- **nixos / `--patch` overlay 声明**（本仓库作者的用法）：行由
  `programs.dsh.plugins` 注入时直接在行上声明 config，随 rebuild 原子生效。
  注意 `modules/home/dsh.nix` 的 `plugins` 选项默认只透传 `id`+`name`，
  需加一个 `config` 透传。Web 侧对 overlay 行写入会被拒（"overridden by a
  home patch or command-line overlay"）——这是 0.2 ConfigEditor 的设计约束，
  非本插件 bug。
- **bundle 安装（`dsh plugin add`）**：行在 bundles 层，Web 编辑写 profile
  patch 覆盖层，可正常持久化。

### Web 设置分区（"Auto Permit"）

无论行来自哪层，设置页都有 "Auto Permit" 分区：Enabled 开关 + 判官模型
select（按厂商分组）+ 思考强度二级 select（选中带 efforts 的模型时出现），
目录与 `/model` 弹窗同源。它编辑的就是行 config（走官方
`remote.settings` 通道，与 permission-presets 等官方分区同一路径）：

- Web 可写的行（bundle 安装）：选择即生效（volatile 热更新）；
- overlay 行（nixos 声明）：写入得到"此行由 home patch / overlay 管理，
  请在声明处修改"的提示——分区退化为当前值展示 + 目录浏览。

判官模型 id 也可从 `/model` 弹窗查。写错模型 id 是安全的：判官调用失败 →
defer → 回人工弹窗（fail-open）。

## 安装

```sh
pnpm build
dsh plugin --profile <profile> add ./packages/auto-permit
```

开发 overlay：

```sh
pnpm build
dsh --profile web --patch $PWD/packages/auto-permit/dev.patch.yml --no-open --port <端口>
```

## 设计文档

见仓库 `docs/research-dsh-approval-auto-permit.md`（DSH 审批系统调研、
pi ai-bash-judge 提示词迁移说明、决策记录）。
