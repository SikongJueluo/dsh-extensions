# dsh-auto-permit

DSH 的 AI 自动审批判官：在 `approval/request` waterfall 上插队一个 answerer，
人工弹窗之前由一个小模型决定是否放行 bash 的 sandbox 提权请求。

## 行为

当一次 bash 审批请求到达时（通常是命令被 sandbox 拒绝后模型带
`sandbox_permissions` 重试），按顺序处理：

1. **不可逆形状与容器边界**：内置形状（`rm -rf ~`、`git clean -xfd`、
   `git reset --hard`、`git push --force`、`sudo`、`curl|sh` …）∪ 容器边界
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
4. **判官判决**：一次性小模型调用，证据 = 会话内全部用户 prompt（截最近
   16 条）+ 待批命令全文（含 description / justification、调用 workdir，
   分别标记为 agent 声称或调用上下文）+ 宿主记录的 effective cwd 与按宿主
   规则解析的 working directory + 不可变会话 workspace + 本会话已批准命令
   列表。`VERDICT: allow` → 放行；其余一切（defer / 超时 / 解析失败 /
   命令超出判官证据预算）→ 回落到人工弹窗。

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
- `auto-permit ✎ deferred to you: <命令>`——判官不确定，回人工弹窗
  （展开可见判官理由）；
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
pnpm -C packages/auto-permit test             # vitest：证据 fold + 审批链集成
node packages/auto-permit/test/notice-order.mjs
```

它用真实 `Session` 重放失败会话的事件顺序，断言 `assistant(tool_calls)` 后面
紧跟配对的 `tool` 消息；surface-append 路径失败，`agent.inject()` 路径通过。

## 判官判据（v4）

v4（2026-11-05）在 v3 之上新增**容器判据**，并把容器里最危险的形状做成程序
硬规则（见「行为」第 1 条）：

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
4. **容器构建/临时验证**（v4 新增）：用户明确要求构建、测试或临时验证**本
   项目**（或同样具体的容器任务），命令是直接的本地、当前用户身份的
   podman/docker 调用，且每个效果都落在边界内 → 可 ALLOW。边界：
    - 效果限于引擎状态查询、拉取构建所需镜像、从项目上下文构建镜像、为项目
      构建/测试创建并运行一次性（`--rm`）容器；对既有容器的单独启停/exec/
      rm 一律交人工；
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
   网络不在命令字符串里）、wrapper 脚本与 Makefile/辅助程序、远端或无法
   确认的引擎目标、既有容器的 exec/stop/rm 等生命周期（首版没有可信的
   资源归属证据）、volume/全局 prune/reset、镜像 push、宿主引擎配置。
   `rootless`、`--rm`、名字带 test、`localhost/` tag 只是佐证，不是安全
   保证。

历史背景：v3（2026-10-21，随 [dsh-toolchain-access](../toolchain-access/)
迁移）收敛 v2 的「缓存副作用可 ALLOW」判据；v2（2026-10-02）当时目录授权
尚不存在，按命令提权是唯一出口，如今缓存需求由 toolchain-access 的
`cargo-cache` 等预设承担。判官 prompt 版本 `dsh-auto-permit-v4`；
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

插件行 config（全部 volatile，`{enabled, provider, model, reasoningEffort?}`）：

- **enabled**（默认开；未配置判官模型时不生效）。
- **provider** / **model**：判官模型路由。必须显式指定——不跟随会话模型，
  避免主模型审自己。可选 **reasoningEffort** 思考强度。
- 写错模型 id 是安全的：判官调用失败 → defer → 回人工弹窗（fail-open）。

容器判据（v4）随插件启用生效，**没有单独的开关**：安装插件并配置判官路由
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
