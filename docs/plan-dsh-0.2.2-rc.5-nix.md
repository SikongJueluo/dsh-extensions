# 计划:把 Nix 管理的 dsh 从 0.2.2-rc.1 升到 0.2.2-rc.5

状态:本仓插件侧迁移已完成并通过隔离验证;宿主侧(SDK 版本、profile、flake)未改动,由用户落地。
插件侧证据见 [rc.5 迁移记录](dsh-0.2.2-rc.5-migration.md)。

## 1. 现状

- `~/.config/nixos/flake.lock` 锁定的 `llm-agents` 提供 `dsh 0.2.2-rc.1`;本机 `dsh --version` 即
  `0.2.2-rc.1`,而本仓 19 个 bundle 的 peer 已改为 `^0.2.2-rc.5`,catalog 钉 `0.2.2-rc.5`。
- `home/ai/dsh/default.nix` 的本地 `overrideAttrs` 用 `--replace-fail 'execArgv: []'` 给 Inspector
  Worker 补 `--expose-internals`;提供 rc.5 的上游 `llm-agents.nix` 已带上同一补丁。两处同时存在
  时第二次替换找不到旧文本,构建以退出码 1 失败。
- rc.5 的 bare npm 制品仍含原始 Inspector Worker 配置,因此上游 Nix 补丁不能省。

## 2. 步骤

1. 把 `llm-agents` 输入更新到提供 `rc.5` 的修订(`nix flake update llm-agents`,或整体更新后
   核对 `flake.lock` 里该输入的 rev 与 `packages/dsh/package.nix` 的版本)。
2. 删除 `home/ai/dsh/default.nix` 中重复的 Inspector `overrideAttrs`,保留上游补丁;确认没有
   第二处 `execArgv: []` 替换。
3. 先 `nix build` 该配置的 home-manager 闭包(不切换),确认 dsh、Inspector、`app-boot` 的启动脚本
   都构建通过;再 `home-manager switch` 一次,并保留上一个 generation 供回滚。
4. 验证:
   - `dsh --version` 为 `0.2.2-rc.5`;
   - `dsh --profile web --dump-config` 里出现 `jj-worktree`、`jj-tool-worktree` 与顶层
     `forge-panel`,且不再有 `forge-worktree` / `optional-forge-panel`;
   - 启动 Web:侧栏面板、Forge 新建工作树(`jj` 与纯 Git 仓库各一次)、会话 header 的任务 pill、
     写权限菜单(点开、勾选、撤销)、触发器标签页、审批卡;
   - 归档一个创建过 worktree 的 Session,确认 Git checkout 的回收与 `retainOnArchive` 一致;
   - OAuth/API key 刷新一次,确认 401 与 429 的错误分类和重试没有变化。
5. 回滚:`home-manager generations` 切回旧 generation;`~/.dsh` 下的 profiles 与 storage 在升级前
   做一份快照(不要用 Nix 管理 `profiles/*/cordis.patch.yml`,设置 UI 会运行时改写它)。

## 3. 升级时需要观察

- rc.5 打开归档清理:默认 `retainOnArchive = false` 会回收 Session 创建的干净 Git checkout(分支与
  提交保留);jj workspace 的任务记录在池内 JSONL,不在该投影里,始终保留。
- `dsh-mobile` 本机钉 `0.8.0`,没有针对 rc.5 的验证;先只跑桌面 Web,移动端单独一轮。
- 外部 `spine-sdk-plugin` 仍按旧 `{ request }` 形状调用子代理服务,rc.5 下会失败;它需要自己的
  迁移,未包含在本仓改动内。
- 插件安装顺序:`dsh-jj-workspace` 的 bundle 层必须排在 `@deepseek-ai/dsh-experimental-forge-bundle`
  之后,否则它要禁用/插入的 id 还不存在。

## 4. 不在本计划内

不改 `~/.dsh`,不改 `~/.config/nixos`,不运行 `home-manager switch`;这些由用户在自己的终端执行。
