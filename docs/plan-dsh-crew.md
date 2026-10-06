# 计划/记录：crew 插件上线 + 默认委派工具屏蔽

状态：插件本体在 `packages/crew/`（`pnpm check` 通过）；preset 覆盖已扩展到
**standard + cordis**（03:15 二轮发现：新会话落在 cordis 预设，只盖 standard
无效），修复版已离线组合验证，待 rebuild 生效。nix 侧 jj
`feat(dsh): delegate through crew tiers and block stock tools`。

目标工具面（模型的委派选择被收窄到"只能选档位"）：

| 工具 | 来源 | 去向 |
| --- | --- | --- |
| `subagent_quick` / `subagent` / `subagent_smart` | crew 插件 | 保留（三档，路由钉死） |
| `create_agent` | crew 插件 | 保留（常驻角色代理，tier 枚举复用三档路由） |
| `list_agents` / `send_message` / `interrupt_agent` | stock `tool-subagent-control` / `tool-subagent-list-agents` 行 | 保留（crew 的控制面） |
| stock `subagent` / `subagent_fork` | preset `delegation` 组内嵌套行 | **从 preset 覆盖中删除** |
| `workflow` | preset `workflow-ptc` + `tool-workflow` 行 | **从 preset 覆盖中删除** |

## 1. `home/ai/dsh/plugins.nix`：挂插件（已落地）

`programs.dsh.plugins` 追加（路由用插件 Config 默认值，可在 Web 设置页改）：

```nix
{
  id = "crew";
  name = "/home/sikongjueluo/Projects/dsh-extensions/packages/crew/lib/index.js";
}
```

默认三档（`packages/crew/src/index.ts`）：quick = deepseek-official /
deepseek-flash @ max；workhorse = zai-coding-cn / glm-5.3 @ max；smart =
openai-codex / gpt-6.1-sol @ xhigh。

## 2. `home/ai/dsh/subagents.patch.yml`：覆盖 preset-standard 声明

**首轮教训（2026-10-06 实测）**：按行 id `- id: tool-subagent / disabled: true`
只命中**顶层**行（那些本来就被 web-app 根 patch disable 了，等于空操作）；
standard 预设从 `delegation` 组的**嵌套**行重新挂出 stock `subagent`（含
`modelSelectionSettings: true`）、`subagent_fork`、`workflow`。dump-config 证实
嵌套行原样启用。Loader 的按 id 覆盖打不进组内嵌套行，唯一可靠做法是**按行
id `preset-standard` 整份重述声明**（config 整体替换）。

正确做法：该文件内容 = 对官方 `dsh-web-app/presets/standard.patch.yml`
（0.2.0-rc.2）的逐行重述，仅从 `delegation` 组删去 `tool-subagent` /
`tool-subagent-fork` / `workflow-ptc` / `tool-workflow` 四行；其余（persona、
planning/compaction 组、control/list-agents、codex/claude-code/ralph 的原生
disabled 行等）原样保留。模板见 `packages/crew/dev.patch.yml`（由脚本从官方
文件做文本手术生成：去 `- insert:` 头、整体缩进减 4、删四个行块）。

**维护代价**：升级 dsh 后必须重新 diff 官方 standard 预设，把新增/变更行同步
进这份重述，否则 preset 漂移。

## 3. `home/ai/agents-md.nix`：选型文案（已落地）

`dshBlock` 为失败驱动的机械式文案（quick 起步 → 升档要理由 → create_agent /
list_agents 用法），2026-10-06 rebuild 后已确认再生成进 `~/.dsh/AGENTS.md`
并在存活会话内热刷新。

## 4. 生效与验证

```sh
pnpm -C ~/Projects/dsh-extensions build   # 已构建,幂等
sudo nixos-rebuild switch --flake ~/.config/nixos#Minisforum
```

- **新开会话**（旧会话保留其创建时的 preset 修订，工具面不回溯）：委派工具
  应当只剩 `subagent_quick` / `subagent` / `subagent_smart` / `create_agent` /
  `list_agents` / `send_message` / `interrupt_agent`；`subagent_fork` 与
  `workflow` 消失；三个 tier 工具描述各不相同。
- `dsh --profile web --dump-config`：`preset-standard` 行的 config 为重述版
  （delegation 组内无 tool-subagent / fork / workflow）。
- 观察一周左右的 `tool/call` 分布：期望 quick 占比显著上升。

## 验证记录（2026-10-06，首轮 rebuild 后）

- crew 插件挂载 ✓：存活会话内 `subagent_quick` / `subagent_smart` /
  `create_agent` 均为新描述（Tool inspect 证实）。
- **路由钉死 ✓**：`subagent_quick` 前台委派一次，子会话 `request/header` =
  `{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"max"}`。
- 旧会话残留 ✗（预期内）：本会话仍见 stock `subagent`（旧描述）、
  `subagent_fork`、`workflow` —— preset 修订随会话冻结 + 首轮 disable 无效，
  均由 preset 覆盖修复，新会话生效。

## 验证记录（2026-10-06 03:01–03:15，二轮 rebuild 后的新会话测试）

- 02:59:09 的第二次 rebuild **实际已执行**且 bake 了 preset-standard 重述
  （部署单元 ExecStart 引用的 store 文件与源 IDENTICAL，dsh-web 02:59:14 随
  switch 重启）；handoff 里"尚未执行"是过期认知。
- 新会话（03:01:01 创建，晚于重启）工具面仍带 `subagent_fork` / `workflow`。
  根因：会话头 `agentPreset: "cordis"` —— Web UI 记住最近选过的预设，新开
  对话落在 cordis（历史会话 110 standard / 9 cordis / 0 ptc），
  `preset-standard` 覆盖对 cordis 预设零作用。离线 dump-config 复现确认
  preset-standard 的 delegation 组已干净，重述机制本身成立。
- 修复：subagents.patch.yml 追加 `preset-cordis` 整份重述（同样删四行）。
  一处刻意偏差：cordis 的 `skill-filesystem.customSkillDirs` 官方用
  `!!js createRequire(baseUrl)` 相对解析，而 loader 的 `baseUrl` 绑定
  "贡献该行的 patch 文件"（cordis-plugin-loader 的 EntryTree ctx 继承链），
  重述进用户层文件后解析链必然 MODULE_NOT_FOUND；改为
  `createRequire(process.argv[1])`（dsh 的 bin.js，升级稳定），node 实测
  解析到同一 skills 目录。
- ptc 预设（delegation 组还有 tool-subagent/fork 两行 active）从未被任何
  会话使用，暂不覆盖；启用前需按同样手法重述。
- 离线验证方法：临时 `DSH_HOME`（可写）+ 复刻服务 ExecStart 的完整
  `--patch` 链做 `--dump-config`；diff 唯一变化区 = preset-cordis（删四行 +
  锚点改写），其余 1340 行零扰动。注意：`--dump-config` 会写
  `profiles/<p>/cordis.yml`，在会话沙箱内 EROFS；`/tmp` 在 bash 沙箱内按
  调用隔离，写读需同一命令完成或放工作区。

## 验证记录（2026-10-06 12:06–12:10，三轮 rebuild 后终验通过）

- 第三次 rebuild（12:04 switch）生效：dsh-web.service ExecStart 引用新
  store `ws2j59s6c…-subagents.patch.yml`，含 `preset-cordis` 且与源
  IDENTICAL。
- 终验会话（27dc023a，12:06 创建）恰好开在 **cordis 预设**（上次失败
  路径）。结果全绿：
  - 工具面：仅 `subagent_quick` / `subagent` / `subagent_smart` /
    `create_agent` + `list_agents` / `send_message` / `interrupt_agent`；
    `subagent_fork` 与 `workflow` 消失。
  - 技能目录正常：marimo / typst / jujutsu 等自定义技能全部在列 ——
    `customSkillDirs` 的 `process.argv[1]` 锚点在运行时解析成立（离线
    只验证过组合层，此处为运行时实证）。
  - `subagent_quick` 前台（run_in_background:false）往返成功；子会话
    d3efcee3 的 request header =
    `{"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"max"}`。
  - `create_agent`（quick 档持久代理）→ 角色确认回传 → `send_message`
    任务送达 → ack 回传，往返全通。
- 残留事项：两仓 jj describe（nixos 工作副本的 subagents.patch.yml、
  本仓 @ 的 plan doc）；观察数天 tool/call 分布；ptc 预设启用前补覆盖。

## 已知边界

- 插件要求 provider（默认 `spawn`）具备 `agentOptions` + `prepareContinuable`
  能力，缺失会在挂载时报错而不是静默降级。
- `create_agent` 语义 = 常驻角色代理：bootstrap 提示词让子代理确认角色后
  待命，恒为后台；后续任务经 `send_message`。
- depth 仍读宿主 `subagent.maxDepth` 设置（默认 1），create_agent 创建的
  常驻代理同样受深度约束。
