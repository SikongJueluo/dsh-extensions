# 计划:toolchain-access 的 Nix 接入与权限迁移

状态:代码与验证已完成(见 [packages/toolchain-access](../packages/toolchain-access/) 与各层提交说明);本文件是**宿主落点计划**,由用户落进 flake,本会话不改 `~/.dsh`、不装 bundle、不 reload profile。本机当前 profile **尚未启用**本插件。

## 1. 交付了什么(仓库内,已验证)

- `packages/toolchain-access`(`dsh-toolchain-access`):`LocalSandboxProvider` 子类,对 `workspace-write` 沙箱追加精确 `--bind`(详见包 README 的信任语义)。
- 预设:`uv-cache`、`cargo-cache`(registry/git/`.package-cache`)、`pnpm-store`、`pnpm-runtime-locks`(`$XDG_RUNTIME_DIR` 共享锁域)、`pnpm-engine`(默认关)。
- confine 时受控自建缺失的**默认推导**路径(pnpm 的 `/run/user` 锁目录重启即清空,0755/0700/锁文件按各工具语义创建);显式 override 与插件加载不写宿主。
- 迁移:cmd-permit 种子收敛为 `[rtk]`;auto-permit 判官 v3「缓存上限」(缓存-only 越界一律 DEFER,同族等价不可越过)。
- 已实测:grant 子树可写、父/邻居仍 EROFS;uv sync、cargo fetch/build(真依赖)、pnpm run 热引擎授权后成功、对照 EROFS;cargo 并发 fetch ×2 共享 cargo-home 均成功;pnpm 锁文件落在宿主共享目录。

## 2. Nix 落点(用户执行)

dsh 归 nix 管。**注意:本插件不能进 `programs.dsh.plugins` 列表**——它要**替换** base 的 `sandbox` 行(patch 不能改行 name,只能 disable+insert),而 plugins 列表只是 append;直接 append 会与官方 sandbox provider 撞 service 注册。正确路径是 `extraPatches`,与现有 rtk-rewrite(dev.patch.yml)同款。

### 方案 A(推荐):自建 patch 文件,config 归 nix 管

在 `~/.config/nixos/home/ai/dsh/` 新建 `toolchain-access.patch.yml`(仿 `subagents.patch.yml` 的存放方式):

```yaml
# 用 dsh-toolchain-access 替换 stock sandbox 行,启用本机常用缓存预设。
# pnpm-engine 默认不开:它授权整个 pnpm home(含可执行 engine 副本)。
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
  disabled: true

- insert:
    - id: toolchain-sandbox
      name: '/home/sikongjueluo/Projects/dsh-extensions/packages/toolchain-access/lib/index.js'
      config:
        presets: [uv-cache, cargo-cache, pnpm-store, pnpm-runtime-locks]
        paths: {}
```

`plugins.nix` 的 `extraPatches` 追加一项 `./toolchain.patch.yml`(同 `subagents.patch.yml` 的 `${./...}` 写法)。改预设 → 编辑此文件 → `home-manager switch` → 重启 dsh。

### 方案 B:直接用仓库的 dev.patch.yml

`extraPatches` 追加 `/home/sikongjueluo/Projects/dsh-extensions/packages/toolchain-access/dev.patch.yml`,预设默认空,需再改该文件(或后层按 id 覆盖 `toolchain-sandbox` 行——覆盖行必须整体重述 `presets` 与 `paths`)。适合先零预设观察、再逐步开。

### 前置构建

每次更新插件后:`pnpm build`(patch 引用的是 `lib/index.js` 绝对路径,nix 不参与构建)。升级 dsh 后:钉版 devDependencies 同步 + 跑 `pnpm -C packages/toolchain-access test`——bwrap 布局钉版测试会暴露官方 profile 漂移。

## 3. cmd-permit 配置迁移(用户决策)

宿主 `plugins.nix` 现声明 `allow = [ "rtk" "cargo" "direnv" ]`(存量,种子变化不影响它)。建议:

```nix
allow = [ "rtk" ];
```

- `cargo`:缓存需求已由 `cargo-cache` 预设覆盖;Full access 自动放行应移除。
- `direnv`:`direnv allow` 写 `~/.local/share/direnv/allow`,但 `direnv`/`direnv exec` 会执行 `.envrc` 任意代码,不是「常规缓存」命令;环境加载已由 auto-env 在宿主侧完成,模型侧 direnv 少见。若你仍想让步,保留它是一个显式选择。
- `rtk`:保留(改写后前置几乎每条命令;其自身状态写不被预设覆盖)。

## 4. auto-permit 判官 v3(无需宿主动作)

判官 prompt 随插件行加载,`dsh-auto-permit` 的行声明不变。版本 `dsh-auto-permit-v3` 生效即新判据。**exact-repeat 记忆是 session 内的**:旧 session 里已批准过的精确命令仍会放行(那是当场的真实授权),新 session 从零开始,不会跨 session 复用旧的缓存类批准。

## 5. 已知边界(如实,不粉饰)

- **冷 pnpm engine 安装未端到端验证**(需联网下载另一版本);`pnpm-engine` 预设按 pnpm 源码路径设计,如遇失败以实际报错调整。
- 本插件只增强**本地进程沙箱**的目录写;write/edit 工具、remote-exec 不在其授权范围。
- 嵌套沙箱(在别人的沙箱里再跑 dsh)时追加 bind 可能继承只读标志——fail-visible(工具继续 EROFS),不会静默放宽。
- 校验(realpath/stat)与 bwrap 稍后重解析之间的符号链接替换是 argv 级沙箱固有的残余竞态,与官方 workspace bind 同级,未消除。
- Cargo `.package-cache` 是单文件 bind(inode 跟随当前文件);Cargo 不删除重建它,若未来行为变化需以真实并发测试更新预设。
- 本机 toolchain rustc 本身已损坏(rustup 二进制请求的 glibc store 路径被 GC);与本插件无关,修复属宿主侧(如 `rustup toolchain install stable` 或 nix rust)。

## 6. 验收清单(启用后抽查)

1. `dsh --profile web --dump-config` 出现 `toolchain-sandbox` 行、`sandbox` 行 disabled(注意该命令会写 profile 运行时文件,属宿主动作)。
2. 会话内 `bash: uv cache dir` 应答 `~/.cache/uv`;`uv sync` 不再 EROFS、不需要 `sandbox_permissions`。
3. `cargo fetch`(真依赖项目)不 EROFS;`~/.cargo/credentials.toml` 仍不可写(`test -w` 应失败)。
4. `pnpm run`(pin 与运行版本不一致的项目)不再报 `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK`;`/run/user/1000/pnpm-store-operation-locks-1000/` 出现 `all-stores.lock`。
5. Settings → `toolchain-sandbox` 分区可见 presets/paths 表单;改 presets 保存后 provider 重挂(非 volatile)。
6. 提权抽查:模型对 `cargo build` 的 Full access 请求应弹窗(cmd-permit 不再白名单)或被 v3 判官 DEFER,而非自动放行。
