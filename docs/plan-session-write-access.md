# 计划：持久化的 Session 多项目写入授权

状态（2026-11-14）：**需求已确认，待实现与集成验证**。本文是后续实现和验收的依据，不表示插件已可用。本次只新增文档，不修改 DSH、profile、Nix 配置或运行权限。拟交付 `packages/session-write-access`（`dsh-session-write-access`），名称暂定，尚未创建或发布。

## 1. 已确认的行为

目的：把反复批准跨项目 bash 的体验，改成「用户为一个会话批准多个可写目录」。保留 `workspace-write`，不新增沙箱模式，不自动切到 Full access。

| 场景 | 行为 |
|---|---|
| 初始权限 | 主会话的原始 workspace 可写，额外项目默认未授权 |
| 手动添加 | 用户可以提前为当前会话添加可写目录 |
| 按需申请 | 越界操作先被拒绝；Agent 申请明确目录，用户确认后持续生效，也允许提前申请 |
| 授权对象 | 目录及其子目录；允许新建、修改、删除，不仅是编辑源码 |
| 一致性 | 文件工具、bash、新启动终端使用同一份目录策略 |
| 持久化 | 同一 session 重启恢复后继续授权，不再次询问；撤销也持久保存 |
| 本地子 Agent | 与主会话共享授权组；子 Agent 发起的申请获批后，整个家族共享新增权限 |
| 撤销 | 家族后续操作跟随撤销；不自动终止已运行的命令、终端或后台进程 |
| 普通 Fork | 用插件入口复制点击时有效的额外授权，此后独立管理；从旧消息 Fork 也不复活历史已撤销权限 |
| 只读模式 | 不因目录授权而获得写权；授权记录保留，回到 `workspace-write` 后适用 |
| 其他权限 | 不扩大读取、网络、远程执行或其他独立审批权限 |

授权不会改变 working directory、原始 workspace 身份或其他普通会话的权限。部署配置中已有的 `additionalWritableRoots` 和平台临时目录按宿主原有语义保留，不能在界面上伪装成本插件可撤销的 session 授权。

第一版覆盖**一个 DSH 运行实例内、本地文件系统和受其管理的本地子 Agent**。关闭旧实例再启动新实例必须恢复权限；不承诺两个并行 DSH 进程实时同步撤销。不自动向外部 Codex / Claude Code / ACP 等执行方或远程文件系统转授权限。

## 2. 可行性与当前契约

以 DSH **0.2.2-rc.1** 的 Inspect、安装包 README、类型和构建代码核对：

| 已核实事实 | 对设计的影响 |
|---|---|
| `SandboxExecutionPolicy.additionalWritableRoots` 已由执行层消费 | 无须另造沙箱或只给 bash 加 bind |
| `sandboxPolicy` 的 roots 来自装载期配置，所有 session 共享 | 不能把全局配置当作 session 授权表 |
| 公开的 `SandboxPolicyService.resolve()` 是同步方法；无 session roots setter / hook | 不能作为普通旁挂插件追加授权；选择组合层替换策略模块 |
| `SandboxPolicyService` 公开导出；现有 bundle 支持禁用 stock 行再插入替代实现 | 可以不重打包 DSH，但替换是钉版集成，不是稳定的第三方 roots 扩展点 |
| `storageDomain.open()` 异步加载，打开后读同步，写入返回前持久化 | 可保存独立于 session 日志的授权记录，供同步策略解析读取 |
| `agent/created` 是 awaited serial 初始化，queued input 等其完成 | 可在 Agent 首次执行前准备授权归属；初始化失败不得带着不完整权限继续运行 |
| 本地子 Agent 原来的权限继承是创建时快照 | 本插件必须每次读取共享组，不能照搬该快照机制 |
| `parentSession` 单独不足以分类子 Agent | 用 `origin` 和已验证的创建关系区分子 Agent 与普通 Fork |
| 原生普通 Fork 复制事件前缀，不复制插件存储，也不向通用创建监听器提供来源 | 第一版新增插件 Fork 入口，不宣称原生按钮自动继承 |
| 普通 approval 只有一次性 outcome；child 通常固定 `never`；userQuestions 不允许 child 直接发起交互 | 持续目录授权使用独立的持久待确认队列和用户操作，不借普通审批放行 |

参考位置（相对安装包的 `node_modules/@deepseek-ai/`）：

- `dsh-sandbox-policy/README.md`：配置、策略优先级、部署级 roots 的限制；`lib/types/index.d.ts`：公开类与同步 `resolve`。
- `dsh-sandbox/lib/types/roots.d.ts`：`workspaceWritableRoots()`、目录有效性与符号链接约束。
- `dsh-storage-domain/README.md`：持久记录、同步读取、生命周期；Inspect `storageDomain` 的 `open` / `KvTable` 契约。
- `dsh-agent/lib/types/runtime-types.d.ts`：`agent/created` 的初始化保证。
- `dsh-session/lib/types/types.d.ts`：`SessionHeader`；`dsh-api-session-controller/lib/index.js` 中 `fork()`：创建与发布次序。
- `dsh-subagent/README.md`：本地与外部 provider、跨进程限制；`lib/types/child-agent.d.ts`：原有权限快照。
- `dsh-user-questions/README.md`：root-only 人类交互；`dsh-user-approval/README.md`：`never` 与一次性审批。
- 本仓 [toolchain-access patch](../packages/toolchain-access/cordis.patch.yml)：组合替换模式；它只替换进程沙箱，不能直接承担本需求。

## 3. 模块与执行路径

### 3.1 组合替换，不改 DSH 安装目录

bundle 禁用 stock `sandbox-policy` 行（附包名断言），插入 `SandboxPolicyService` 的插件实现，继续提供同一 `sandboxPolicy`。保留原有 mode 解析、部署级目录和 runtime-context 贡献；将授权组目录合并到解析结果。

这不同于替换 `sandbox`：后者只影响进程 confinement，无法覆盖进程内文件围栏。`toolchain-access` 可以继续提供自己的进程沙箱，两者需做组合测试。

后层 config 是整体替换。切换策略实现时要完整保留 `mode`、`workspaceRoot`、`additionalWritableRoots`；其他 overlay 不能重新启用 stock 行或让两个实现竞争同一服务。第一版面向已核对的 Web 组合，不宣称 headless `--add-dir` 覆盖自动兼容。

### 3.2 一份目录策略，两个执行家族

```text
用户添加 / 允许申请 / 撤销
          │ 用户专用操作
          ▼
持久授权存储 ── 已提交快照 ──┐
                           ▼
工具调用 ── sandboxPolicy.resolve(session)
                           │
                  mode + 原始 workspace
                  + 部署级额外目录
                  + 当前授权组额外目录
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
      文件工具的文件围栏        bash / 新终端的进程沙箱
```

`workspace-write` 下，主会话原始 workspace 是家族的默认根。**子 Agent 即使在别的 cwd 创建，也不能因此多出默认可写根**；子调用的目录范围取共享组的 workspace 和额外授权。cwd 仅决定相对路径解析，不能作为授权证明。

继续尊重宿主的 mode 和经批准的单次 mode override。`read-only` 不授写权；显式 Full access 仍按宿主语义处理，本插件不把目录授权伪装成针对 Full access 的限制。

### 3.3 授权归属

```text
主 session A ─┬─ 本地子 Agent 1 ──→ 授权组 G1
              └─ 本地子 Agent 2 ──→ 授权组 G1

插件 Fork A → 普通 session B ─────→ 授权组 G2（复制当下有效目录）
                         └─ 子 Agent → G2
```

逐级解析并持久记录本地子会话归属，避免同步 `resolve()` 临时读冷日志。恢复时通过受支持的 session 读取与 `agent/created` 完成归属核对；找不到必要父信息时返回明确初始化错误，不能猜测或把 child.cwd 当成授权根。普通 Fork 不沿历史父指针动态追溯权限。

## 4. 持久化与状态一致性

使用独立 `storageDomain`，由插件单一所有者打开并随插件释放。以下是逻辑记录，不是已发布 schema 或工具名称：

| 记录 | 最小内容 |
|---|---|
| 授权组 | 组 id、原始 workspace、revision、当前额外目录及用户授权来源/时间 |
| session 归属 | session id、组 id、已核对的本地父关系或普通 Fork 来源 |
| 待确认申请 | request id、组 id、申请 session、规范目录、理由、状态、提交版本 |
| Fork 初始化 | source、目标 session id（取得后）、授权快照、阶段，用于失败恢复与执行闸门 |

原则：

1. **磁盘记录是权限事实，内存是读取快照。** 成功回执和新权限发布以持久写入成功为准；存储损坏或失败要显式报错，不能清空后当作首次使用。
2. 同组变更串行化；一次用户决策检查 request id 和预期版本，重复确认幂等。过期申请不能在撤销后通过旧按钮重新放开目录。
3. 权限只从授权组的已提交记录派生。申请状态用于交互，不以某条申请标记为 approved 代替实际授权。
4. `storageDomain` 未承诺多表事务；涉及多记录的步骤要有明确发布点和可恢复状态。撤销保存失败就报告失败，不能在重启后悄悄恢复一项界面声称已撤销的权限。
5. 权限存储及能改变授权执行逻辑的 profile、策略配置和插件代码必须位于 standing `workspace-write` 策略不可写的宿主数据区。`storageDomain` 不公开物理存储位置，因此部署需通过插件 Config 显式声明实际受保护路径并保证与 backend、profile 配置一致；不能从 domain 名猜路径。生产策略代码应使用 Agent 不可写的安装产物；开发 overlay 的测试 session 使用与插件源码分离的项目目录。加载期核对部署级 roots，session 初始化核对默认 workspace，每次新增授权再核对目录覆盖关系；覆盖受保护路径时明确报错，不裁掉原始 workspace 或自动降级。显式 Full access 仍具有宿主原有写入能力，本插件不宣称抵御它。
6. 不新增宿主不认识的 session 事件，不调用保留给实验包的 `appendPluginRecord()`，不解析普通 approval 历史作为持续授权依据。

## 5. 用户与 Agent 交互

### 5.1 Session 写入范围面板

在现有 composer 旁新增「写入范围 · N 个目录 · M 项待确认」入口，使用 additive slot（当前可用 `conversation.input.left`），不替换原有 permission 控件或 patch DOM。

面板展示默认 workspace、部署级目录、session 授权目录及其来源；只允许撤销 session 授权。支持选择/输入本地目录、查看申请、允许、拒绝。目录选择复用宿主可用能力，宿主端重新校验路径，不能仅信任浏览器。

共享授权的确认文案必须明确「允许此主会话及其本地子 Agent 在该目录及子目录内新建、修改、删除文件，直到撤销」。撤销提示旧进程可能仍持有启动时权限；本版不承诺收集所有运行实例或自动终止它们。

### 5.2 申请流程

```text
越界写入被宿主拒绝（也允许事先申请）
  → Agent 提交明确目录和理由
  → 持久保存申请，返回 pending + request id
  → 主会话面板显示待确认
  → 用户允许 / 拒绝
  → 更新共享组并持久保存决策
  → Agent 查询或后续上下文看到结果，再决定下一步
```

- 工具只开放查看、申请和查询结果；增加、批准、撤销等权限决策由用户专用命令或经授权的 Host 入口调用同一内部实现。
- Host 入口验证有权管理目标 session 的真实调用者；不把模型传入的 `actor=user` 或任意 session id 当授权。自定义路由不能绕开 connection / Remote access。
- Agent 无须无限等待用户；可以继续其他工作。同组同目录的 pending 请求合并，拒绝后不自动重复提交。用户仍可手动授权或在明确新请求中重新考虑。
- 当前普通拒绝提示未必会指向新工具。通过短的工具发现说明和 runtime context 明确申请入口；对文件工具拒绝结果能否追加提示需验证扩展点，不猜结构化 denied-path 字段。
- 不尝试从任意 bash 文本或 stderr 自动推断授权根。Agent 提交具体目录；即使推荐了项目根，也必须让用户看到并确认准确范围。
- 失败 bash 可能已产生部分副作用。授权后不重放整条命令；Agent 先检查再继续。

### 5.3 与 auto-permit 的关系

目录面板与普通 bash 审批分开，但批准后的执行策略统一。授权 B 后，正常 bash 命令可以写 B，**不需要再为 B 请求 `danger-full-access`**。命令仍写 C 或触发其他独立权限时，按原机制处理。

不修改 auto-permit 的判断规则，不把它的自动批准计作用户目录授权。它仍处理显式的一次性提权；目录授权工具不走该 approval waterfall。

## 6. 插件 Fork：已知缺口与处理

新增用户专用「Fork 并继承授权」入口，替代日常使用的原生 Fork。复制点击时有效的额外目录、保留 workspace，创建独立组。旧消息边界只决定聊天历史，不决定权限回滚。

原生普通 Fork 的公开 Host 方法是 `sessionController.fork({ sessionId, atSeq? })`。可复用它的历史切分、preset 和 workspace 行为；它不自动 prompt，但在返回新 id 前已创建并发布 Agent。因此，**await fork 返回后再写授权存在发布窗口**，不能仅凭「通常空闲」宣称初始化原子性。

实施先验证如下路线：

1. 用户入口捕获源授权快照，登记 Fork 初始化操作。
2. 调用公开 Fork，取得新 id 后提交独立授权组和归属；成功前不引导用户进入新会话。
3. 策略默认不给未知新会话额外授权；需验证 `agent/pre-step` 或其他公开初始化闸门能使并发客户端也无法在授权归属未定时开始执行，并在失败后安全恢复。
4. 如果无法可靠关联并拦住这个窗口，停止该集成路线，明确报告需要额外受支持 seam 或自有创建路径；不复制整个内部控制器、猜测事件前缀来源或 monkey patch stock 方法。

原生按钮不会经过插件入口，不能自动继承 sidecar。界面和 README 必须说明该差异：额外目录方面，原生 Fork 只有默认 workspace 与部署级 roots，不从历史猜测本插件授权；mode 等其他状态仍按宿主 Fork 的既有规则继承。插件 Fork 失败后的提示要带已创建的 session id（若已取得），不谎称未产生会话。

## 7. 路径、安全和生命周期

- 授权已存在的本地物理绝对目录，复用宿主根校验，拒绝无效目录和 symlink 根；每次执行仍由宿主校验，不只在批准时检查一次。
- UI 展示最终授权范围，不因文件路径自动放大为父目录、HOME 或整个 Projects。重叠授权需计算有效覆盖，撤销子目录而父目录仍授权时明确显示它依然可写。
- jj workspace 和共享 `.jj` / `.git` 元数据目录分别授权；给工作树写权不等于给整个原仓库或共享元数据写权。可写 hooks / 配置有执行风险，确认时要如实展示。
- 改 cwd、创建子 Agent、恢复冷会话、普通 Fork、空输入初始化都不能成为绕开授权的路径。
- 恢复主会话和子会话时核对归属；过时的运行上下文只作历史显示，执行以当前策略为准。上下文通过宿主正常装配进入可重建的会话历史，不篡改过去消息。
- 进程权限在启动时固定。新授权不会自动扩展已有终端；撤销不会收回旧进程权限。需新权限的终端应由用户重建，不能声称动态完全同步。
- 回滚必须同时撤销替换行和 bundle 对 stock `sandbox-policy` 的禁用 patch，或由部署显式重启用 stock 行；仅停用替换行会留下没有策略提供者的组合，不能称为自动恢复。用户通过 Nix/profile 调整完整组合并重启后核对只有一个提供者。持久记录保留与否需在后续实现 README 中明确，记录本身不能在插件未挂载时生效。

## 8. 实施顺序与停止条件

每步作为独立逻辑变更；此文不授权安装、修改 `$DSH_HOME` 或 Nix 配置。

1. **先验证核心接线**：最小替换策略 + 临时测试存储；对同一个额外目录分别跑真实文件工具与 bash，对照未授权目录仍拒绝。确认 stock mode、runtime context、toolchain-access 组合无退化。
2. **实现持久授权和家族归属**：受保护的存储、提交后发布、冷恢复、本地 child 动态共享；新增用户手动管理入口。完成后，重启与撤销验收全部通过。
3. **实现申请面板与模型接口**：独立待确认记录、用户身份核验、去重、状态查询；验证主会话空闲时 child 申请仍可出现，auto-permit 无法代批。
4. **验证并实现插件 Fork**：先解决第 6 节的发布/恢复闸门，再交付入口。不能以“没有立即调用工具”代替并发与失败验证。
5. **完善交付**：本地化展示资源、manifest、README、smoke/集成测试和宿主接入说明；仓库构建检查通过后交用户部署命令或 Nix 落点。

停止条件：若公开接口无法安全替换策略、保证用户专用授权或完成已确认 Fork 语义，就报告具体缺口和上游所需接口，不能静默降级需求、复制内部大段逻辑或换用 Full access 伪造成功。

## 9. 验收清单

使用隔离测试 profile、临时项目 A/B/C 和持久测试存储；不向真实项目写测试哨兵。每项记录命令/操作、结果和证据位置，未跑项明确列出。

### 统一执行与默认约束

- [ ] 默认 A 可写；文件工具和 bash 写 B 均被拒绝。
- [ ] 用户批准 B 后，文件工具写 B 成功；正常 bash 修改 A+B 成功，无单次提权参数、无 B 的二次审批；写 C 仍被拒绝。
- [ ] 新终端获得相同目录范围；旧终端没有新增权限时明确提示重建，而非宣称全部进程动态获权。
- [ ] `read-only` 下 A/B 均不可写；恢复 `workspace-write` 后 B 授权仍在；显式 mode override 保持宿主原语义。
- [ ] 部署级 roots、平台临时目录和 toolchain-access 的既有行为保留，UI 不允许伪撤销部署权限。

### 持久化、家族与撤销

- [ ] 授权 B，退出并重启 DSH，恢复同一 session：B 无须重新确认即可写。
- [ ] 撤销 B 后重启：B 仍拒绝，不从聊天历史、旧申请或 auto-permit 记忆复活。
- [ ] child 在 C 启动不自动获得 C 写权；主、child 和孙代共享 A+B。
- [ ] child 申请 C，用户批准后主会话与兄弟 child 的后续调用都可写 C。
- [ ] 主会话撤销 B，已有 child 的后续文件操作和新命令均拒绝 B；独立普通 session 不受影响。
- [ ] 恢复冷 child 可找回正确授权组；缺父信息、损坏存储、持久写失败均报明确错误，不扩大权限或显示假成功。
- [ ] 并发批准/撤销、重复点击、旧页面确认、存储失败和中途崩溃均不导致撤销权限复活。

### 用户交互与防自授权

- [ ] 手动添加与批准申请走同一校验和持久发布路径；允许/拒绝只有真实授权用户能执行。
- [ ] Agent 只能查看/申请/查询，不能通过工具、任意 session id、HTTP 或伪造 actor 自行授权；非授权客户端也不能代批。
- [ ] 待确认申请跨重启保留，主会话空闲时仍可展示本地 child 申请；同目录申请去重，拒绝不自动循环弹出。
- [ ] auto-permit 自动放行一次命令不会增加目录授权；已授权 B 的正常 bash 不再因 B 越界触发它。
- [ ] 符号链接、目录被替换、相似路径前缀和重叠根均按约束处理；默认 workspace、部署级 roots 或新 grant 覆盖声明的存储/profile/策略代码保护路径时明确拒绝；声明与实际部署位置一致。
- [ ] 移动浏览器可点按完成添加、确认、拒绝、撤销；只用 slot 和同源/Typed Remote 通信。

### Fork 与交付

- [ ] 插件 Fork 从旧消息切分时复制当前有效目录；先前已撤销目录不复活。
- [ ] Fork 后两组独立授权/撤销，Fork 子 Agent 跟随新组；重启后仍成立。
- [ ] 两客户端并发、Fork 部分失败和崩溃恢复均不会在授权初始化前误执行，也不把新会话误关联到别的组。
- [ ] 原生 Fork 不被声称自动继承；新入口、差异和失败后的会话位置说明清楚。
- [ ] `pnpm check`、新增自动测试、真实沙箱集成测试通过；显示资源和安装包内容检查通过。
- [ ] 部署与完整回滚后均核对仅一个 `sandboxPolicy` 实现；回滚同时撤销替换行和 stock 禁用 patch；用户按宿主边界完成 Nix/profile 接入后再验证生产效果。

## 10. 仍需实证的集成点

需求已定，不再把实现事实作为用户选择题。以下风险由实现阶段验证：

1. 子类初始化、依赖和替换顺序是否在真实 Web composition 中保持 stock 行为，并与 toolchain-access 共存。
2. 受保护物理路径的部署声明与实际 backend/profile/策略代码位置是否一致，覆盖校验是否完整；存储与已提交快照的发布次序是否在失败、重启、并发操作下始终一致。
3. 本地子会话冷恢复的归属准备是否早于策略读取；不能以 `parentSession` 单字段猜来源。
4. 插件 Fork 的来源关联、首步闸门与崩溃恢复是否能使用当前公开契约可靠完成。
5. 用户专用 Host 入口、Remote access 和 Client slot 的实际接线；普通工具拒绝后的申请发现体验。

上述未验证前，只能称为可行设计与实施计划，不称为已完成的权限能力。
