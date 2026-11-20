# dsh-mobile 对 DSH 0.2.2-rc.5 的兼容状态

调研日期：2026-11-20

## 结论

截至调研日期，npm `@deepseek-ai/dsh` 的 `latest` 为 `0.2.2-rc.5`，仍是预发布版。dsh-mobile npm `latest` 为 `0.8.13`，官方 GitHub release 于 2026-11-18 发布。但在 v0.8.13 标签下，官方 CI 的 `dsh-compatibility` job 固定检出 DSH `dsh-v0.2.2-rc.3`，浏览器启动矩阵也只列到 `0.2.2-rc.3`。因此**没有官方证据证明 dsh-mobile 0.8.13 已支持或测试 DSH 0.2.2-rc.5**。

这表示 rc.5 兼容性尚未确认，不等同于已证明存在运行故障。npm manifest 中的可选 peer 范围较宽，且没有 `engines.dsh`；可安装不代表运行时 API、客户端 slot 或配对流程已验证。

本机 Nix 定义仍固定 dsh-mobile `0.8.0`（见 [`package.nix`](</home/sikongjueluo/.config/nixos/pkgs/dsh-plugins/mobile/package.nix:23>)），所以当前环境比上游最新包更不能视为已验证 rc.5。

## 建议验证

1. 在 Nix 候选配置中单独将 mobile bundle 更新到 `0.8.13`，不要先覆盖当前可用组合。
2. 用 DSH `0.2.2-rc.5` 源码运行上游 `scripts/check-dsh-compatibility.mjs`，并运行 `smoke:dsh-boot`。
3. 在隔离 profile 做真实 Web 配对、重连、移动端布局与本仓客户端插件挂载测试；通过后再更新正式 Nix pin。

## 一手来源

- DSH npm `latest` 元数据：[`@deepseek-ai/dsh/latest`](https://registry.npmjs.org/@deepseek-ai%2fdsh/latest)，版本 `0.2.2-rc.5`。
- DSH 官方 rc.5 发布说明：[dsh-v0.2.2-rc.5](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.5)。
- dsh-mobile npm `latest` 元数据：[`dsh-mobile/latest`](https://registry.npmjs.org/dsh-mobile/latest)，版本 `0.8.13`。
- dsh-mobile 官方发布：[v0.8.13](https://github.com/saya-ch/dsh-mobile/releases/tag/v0.8.13)，发布于 2026-11-18。
- v0.8.13 CI 配置：[`.github/workflows/ci.yml`](https://github.com/saya-ch/dsh-mobile/blob/v0.8.13/.github/workflows/ci.yml)，兼容性源码任务与启动矩阵最高到 DSH rc.3。
- v0.8.13 兼容性检查脚本：[check-dsh-compatibility.mjs](https://github.com/saya-ch/dsh-mobile/blob/v0.8.13/scripts/check-dsh-compatibility.mjs)。
- v0.8.13 更新记录：[CHANGELOG.md](https://github.com/saya-ch/dsh-mobile/blob/v0.8.13/CHANGELOG.md)。
