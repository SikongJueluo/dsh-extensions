# 核查：以前是否已经自动开放 Cargo 缓存写权限

日期：2026-10-21。只读检查 dsh-extensions 的插件、相关历史与文档、pi-extensions，以及 Nix 的 DSH/Pi 声明；未运行 Cargo、未修改实现或宿主配置。结论限于这些来源，不覆盖所有项目的运行时临时授权。

## 结论

**用户确实记得一项已经实现的 Cargo 特殊处理，但 DSH 中实现的是自动批准命令提权，不是 Cargo 缓存目录的持久可写挂载。**此外，更早的 **Pi 的 pi-sandbox 确实有真正的目录白名单**，只是没有明确列出 `~/.cargo`。不能把“本仓没有目录授权插件”外推为“以前所有环境都没有目录授权”。

## 1. DSH：两次明确针对 Cargo 的已实现改动

### 2026-10-02：auto-permit v2

历史 change `nwnmzrymyvzv`，标题 `feat(auto-permit): add v2 judge rules and verdict toasts`。

原问题正是“批准过 cargo 后，cargo fmt / check / clippy 等仍反复弹窗”：命令字符串的微小变化使精确记忆不命中；旧判官又要求用户明确覆盖工具隐式的缓存写入，因此一直 defer。

修复为判官增加“常规工具链缓存副作用可批准”和“同族命令等价”规则，明确提到 `~/.cargo`。当前代码仍在 [judge.ts](../packages/auto-permit/src/judge.ts):47–48；背景见 [旧调研](research-dsh-approval-auto-permit.md):433–455、[README](../packages/auto-permit/README.md):86–103。

### 2026-10-11：cmd-permit

历史 change `ulyvunsprvwy`，标题 `feat(cmd-permit): add allowlist answerer for bash sandbox escalations`。

已实现确定性白名单，Cargo 提权无需人工或判官调用。配置见 [cordis.patch.yml](../packages/cmd-permit/cordis.patch.yml):20–23：`allow: [rtk, cargo, direnv]`，`maxMode: danger-full-access`；Nix 声明 `~/.config/nixos/home/ai/dsh/plugins.nix:55–64` 也包含相同值。这是读取到的声明，不是读取全部 live volatile 设置。

实际行为见 [index.ts](../packages/cmd-permit/src/index.ts):147–179：监听 `approval/request`，恢复命令和目标 mode，高危形状先回退，其余命中则 `allowed-once`。不是注册 `~/.cargo` 路径；若批准 Full access，该次调用不再受文件沙箱限制，授权比只写 Cargo 缓存更宽。

[当时的工作流](research-dsh-rtk-cli-output.md):140–157 直接写明：

```text
cargo build → 沙箱拒（写 ~/.cargo）→ 模型带 sandbox_permissions 重试
  → cmd-permit 白名单 → allowed-once
```

## 2. “直接放行缓存目录”曾经提过，但旧记录明确未做

[research-dsh-rtk-cli-output.md](research-dsh-rtk-cli-output.md):188–200 把三项工作分开：

1. rtk-rewrite：已实现。
2. cmd-permit：已实现。
3. 宿主 runnerCommand wrapper，为 `~/.cargo` / `~/.cache` 等加 bind：**未做**。

本次对 `packages/` 以及 Nix DSH 声明的搜索，没有找到另一个 Cargo writable-root / bind 实现。因此不应因为前两项已实现，就把第三项也记为已落地。

## 3. Pi：确有目录授权，但不在自研审批插件里

`~/Projects/pi-extensions` 的两个权限插件工作在 Bash 授权链上；`CONTEXT.md:35` 与 `packages/pi-permission-ai-judge/README.md:67` 明确判官不是 sandbox。检索该仓 Cargo 相关实现，找到的是 `src/authority/highrisk.ts:223` 的 `cargo publish` 高风险分类，没有 Cargo 缓存挂载规则。

但 Nix 的 **`~/.config/nixos/home/ai/pi/sandbox.nix` 确实为另一插件 `pi-sandbox` 配置了真正目录权限**：

- :8–10：bubblewrap 负责 bash 进程树文件约束，并拦截 read/write/edit。
- :83–92：`allowWrite` 包含项目、`/tmp`、`~/.cache`、`~/.local`、`~/.gradle`、`~/.npm`、`~/.pi`、`~/.rustup`。
- **没有 `~/.cargo`**。本轮 shell 的 CARGO_HOME 未设，`readlink -f ~/.cargo` 仍是独立的 HOME 子目录，不能因开放 `~/.cache` 就认为覆盖了它。

因此，用户记忆可能同时涉及 DSH 的 Cargo 自动审批和 Pi 的真实缓存目录白名单，具体是哪一次体验仍不能唯一定位。未系统审计项目级 `.pi/sandbox.json`、运行时临时 grant 或 pi-sandbox 上游实现；不据此声称 Cargo 曾经绝无其他授权。

## 4. 对下一步设计的意义

- **不是从零做权限系统**：已有 cmd-permit / auto-permit，负责一次命令的审批，保留其职责。
- **真正尚缺的是 DSH 的窄范围目录授权**：可借鉴 Pi 的 allowWrite 使用体验，补工具目录预设与沙箱执行层，而不是再做一遍 Cargo 命令白名单。
- pnpm / uv 当前未获得专门目录 grant；Cargo 白名单的存在不会让它们自动获得相同权限。auto-permit 判官规则虽包含这些工具，也仍须先发起审批。
