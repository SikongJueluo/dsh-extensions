# 计划:修复 dsh 沙箱内 ssh(root 属主 config 被 safe-path 拒绝)

状态:方案已在本机沙箱内逐项实测验证,未动任何宿主配置(dsh 由 nix configuration 管理,落点见 §4)。

## 1. 根因(实测)

- DSH bash 沙箱 = bwrap user namespace,只映射调用者 uid(实测 `/proc/self/uid_map` 为 `1000 0 1`,嵌套在 dsh 宿主自身的 userns 里)。未映射的 root 属主在沙箱内显示为 `nobody:nogroup`(65534)。
- ssh 的 safe-path 检查要求用户级配置文件属主为「本用户或 root」,于是两类文件被拒:
  1. `~/.ssh/config` —— home-manager 的 nix store 符号链接,属主 root → 沙箱内 65534;
  2. `/etc/ssh/ssh_config` 的 `Include /nix/store/...-systemd-261.2/.../20-systemd-ssh-proxy.conf` —— 系统级 config 本身不受检,但其 **Include 目标**受检,同样是 root 属主 → 65534。
- 只修 `~/.ssh/config` 不够(实测修完后立即踩到 2);`ssh -F <副本>` 能绕过是因为 `-F` 会**整体跳过系统级 config**,所以此前从没暴露问题 2。

## 2. 方案:`dsh-sandbox-local` 的 `runnerCommand` 缝隙

- `dsh-base` bundle 以 `- id: sandbox` 挂载 `@deepseek-ai/dsh-sandbox-local`(无 config,全默认)。
- 其 Config schema:`runnerCommand: string[]`(操作员断言,跳过 runner 探测,直接作为 argv 前缀)+ `runnerFailureSignatures: string[]`(必须成对,如 `['bwrap: ']`,用于把 runner 级致命错误与命令失败区分开);`probeTimeoutMs` 留默认 5000。
- `confine()` 拼出的 argv = `[...runnerCommand, ...bwrapProfileArgs(policy), "--", ...命令]`。wrapper 收到完整 bwrap 参数,只需在**第一个 `--` 之前**注入自己的 `--ro-bind`。
- **注入点必须在此**(实测):bwrap 按参数顺序挂载,后画的 mount 覆盖先画的;若 prepend,会被 profile 自带的 `--ro-bind / /` 盖掉(对照实验:先 sshdir 后 `/` → 65534;先 `/` 后 sshdir → 1000:100)。
- wrapper 在**宿主侧**被 spawn(不在沙箱内),能看到真实属主;它把用户属主的替身文件以只读 bind 盖到原路径上,沙箱内 ssh 的检查全部通过。沙箱策略本身零改动。

## 3. wrapper 做什么(已实测脚本)

1. `~/.ssh` 镜像:`config` 解引用为真实 600 文件(用户属主),其余条目(config 除外)做符号链接指回原文件(keys/known_hosts 本来就是用户属主,可直接过检);
2. 扫描 ssh 配置链的 `Include` 图(`/etc/ssh/ssh_config` + `~/.ssh/config` 为根,递归 5 层,glob 展开,相对路径按包含文件目录解析),把每个 root 属主的 Include 目标复制为用户属主副本,`--ro-bind 副本 原路径`;
3. 把这些 bind 注入到第一个 `--` 之前,`exec bwrap`;
4. 失败降级:任何准备步骤出错就**不加 bind 直接 exec bwrap**(绝不破坏/削弱沙箱);只有灾难性错误(找不到 bwrap、mktemp 失败)以 `bwrap: ssh-fix: ` 前缀退出,匹配 `runnerFailureSignatures`;
5. 每次调用在 `~/.cache/dsh-sandbox-ssh-fix/run.XXXXXX` 建一套副本(几 ms),超过 12h 的旧目录启动时 GC。

## 4. 落点(nix 声明式)

脚本放 nixos 仓库(如 `dsh/bwrap-ssh-fix.sh`),避免 Nix 字符串对 `${}`/`''` 的转义问题:

```nix
# ~/.config/nixos —— 按仓库实际模块结构落位,示意
let
  bwrapSshFix = pkgs.writeShellScript "bwrap-ssh-fix" (builtins.readFile ./dsh/bwrap-ssh-fix.sh);
in {
  home-manager.users.sikongjueluo = {
    # $DSH_HOME 全局用户层:loader 在 bundle 层之后应用(headless/web 两个 profile 都生效)。
    # 现无此文件,新建即可;勿 nix 管理 profiles/*/cordis.patch.yml —— 那个会被设置 UI 运行时改写。
    home.file.".dsh/cordis.patch.yml".text = ''
      # bwrap 沙箱内 ssh 修复,见 dsh/bwrap-ssh-fix.sh
      - id: sandbox
        name: '@deepseek-ai/dsh-sandbox-local'
        config:
          runnerCommand: ['${bwrapSshFix}']
          runnerFailureSignatures: ['bwrap: ']
    '';
  };
}
```

注意:patch 行整体替换该行 config,`runnerCommand` 与 `runnerFailureSignatures` 必须成对(少一个 provider 构造即抛错)。

### 脚本全文(实测版,逐字可用)

```bash
#!/usr/bin/env bash
# bwrap-ssh-fix — runnerCommand shim for @deepseek-ai/dsh-sandbox-local (Linux/bwrap).
#
# DSH's bwrap profile runs commands in a user namespace where only the invoking
# uid is mapped. Root-owned files then appear as nobody:nogroup inside the
# sandbox, and ssh's safe-path check refuses to load exactly those:
#   - ~/.ssh/config, when it is a home-manager/NixOS store symlink;
#   - every root-owned Include target reachable from the ssh config chain
#     (e.g. /etc/ssh/ssh_config including systemd's store file).
#
# The shim builds user-owned stand-ins (a ~/.ssh mirror with the config
# dereferenced to a real file, plus copies of the root-owned Include targets)
# and binds them read-only OVER the original paths, injected after dsh's own
# profile arguments — later bwrap mounts win, and the confinement profile
# itself is untouched. Any preparation failure degrades to running bwrap with
# no extra binds: fix-up problems never weaken or break the sandbox.

set -u

fatal() { printf 'bwrap: ssh-fix: %s\n' "$1" >&2; exit 1; }

command -v bwrap >/dev/null 2>&1 || fatal 'bwrap not found'

FIX_ROOT="${DSH_SSH_FIX_ROOT:-$HOME/.cache/dsh-sandbox-ssh-fix}"
mkdir -p "$FIX_ROOT" 2>/dev/null || fatal "cannot create $FIX_ROOT"

# Best-effort GC of run dirs older than 12h (one dir per confined command).
find "$FIX_ROOT" -maxdepth 1 -name 'run.*' -type d -mmin +720 -exec rm -rf {} + >/dev/null 2>&1 || true

work="$(mktemp -d "$FIX_ROOT/run.XXXXXX")" || fatal 'mktemp failed'
chmod 700 "$work" || true

binds=()

# --- ~/.ssh: dereferenced user-owned config + symlinks for everything else ---
if [ -f "$HOME/.ssh/config" ]; then
    ok=1
    for e in "$HOME"/.ssh/* "$HOME"/.ssh/.[!.]*; do
        [ -e "$e" ] || continue
        b="${e##*/}"
        [ "$b" = "config" ] && continue
        ln -s "$e" "$work/$b" || ok=0
    done
    cp -L "$HOME/.ssh/config" "$work/config" 2>/dev/null && chmod 600 "$work/config" || ok=0
    [ "$ok" = 1 ] && binds+=(--ro-bind "$work" "$HOME/.ssh")
fi

# --- root-owned Include targets in the ssh config chain ----------------------
scan_includes() { # $1 = config file, $2 = base dir, $3 = depth
    local file=$1 base=$2 depth=$3 line tok pat match
    [ -f "$file" ] || return 0
    [ "$depth" -le 5 ] || return 0
    while IFS= read -r line; do
        # shellcheck disable=SC2086
        for tok in $line; do
            case $tok in
                /*) pat=$tok ;;
                *)  pat=$base/$tok ;;
            esac
            # shellcheck disable=SC2086
            for match in $pat; do
                [ -f "$match" ] || continue
                printf '%s\n' "$match"
                scan_includes "$match" "$(dirname "$match")" $((depth + 1))
            done
        done
    done < <(grep -hiE '^[[:space:]]*include([[:space:]]|$)' "$file" 2>/dev/null \
             | sed -E 's/^[[:space:]]*[Ii][Nn][Cc][Ll][Uu][Dd][Ee][[:space:]]+//')
}

declare -A seen=()
while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -n "${seen[$f]:-}" ] && continue
    seen[$f]=1
    dst="$work/inc.$(printf '%s' "$f" | sha256sum | cut -c1-20)"
    if cp -L "$f" "$dst" 2>/dev/null; then
        chmod 600 "$dst" 2>/dev/null || true
        binds+=(--ro-bind "$dst" "$f")
    fi
done < <(
    scan_includes /etc/ssh/ssh_config /etc/ssh 1
    [ -f "$HOME/.ssh/config" ] && scan_includes "$HOME/.ssh/config" "$HOME/.ssh" 1
    true
)

# --- inject the binds after dsh's profile args, before the "--" separator ----
out=()
injected=0
for a in "$@"; do
    if [ "$injected" = 0 ] && [ "$a" = "--" ]; then
        out+=("${binds[@]+"${binds[@]}"}" "--")
        injected=1
    else
        out+=("$a")
    fi
done
if [ "$injected" = 0 ]; then
    out+=("${binds[@]+"${binds[@]}"}")
fi

exec bwrap "${out[@]}"
```

## 5. 验证清单

已实测(沙箱内模拟 `confine()` 的 argv 逐项验证):

1. mount 顺序语义:先 sshdir 后 `/` → 65534(被盖);先 `/` 后 sshdir → 1000:100 ✓(证明注入点选择正确);
2. 只修 `~/.ssh/config` 会踩 `/etc/ssh/ssh_config` 的 store Include(报 `Bad owner ... 20-systemd-ssh-proxy.conf`)→ 方案里第 2 步覆盖 ✓;
3. wrapper 端到端:沙箱内 `stat ~/.ssh/config` → `1000:100 600 regular file`;`ssh -G no-such-host` 无 Bad owner;`ssh -G <真实别名>` 正确解析出 `hostname`/`user` ✓。

switch 之后补验:

4. 新 bash 调用直接 `ssh -G <别名>`(profile patchReload: live,行可热重挂;若没生效则重启 dsh);
5. 确认普通命令/写工作区不受影响(wrapper 只是加 ro-bind)。

## 6. 限制与回滚

- `~/.ssh` 在沙箱内只读:known_hosts 新主机不落盘(警告,非致命);ControlMaster socket 无法建立(现状沙箱内本就如此,无回退)。
- `runnerCommand` 是操作员断言:跳过 bwrap 探测(本机 bwrap 0.12 已验证可用);脚本灾难性失败按 `bwrap: ` 签名归类为 runner 失败,不会静默。
- 每次 bash 调用多几 ms;副本目录 12h 自动 GC。
- dsh 升级(当前 0.2.0-rc.2)若改 `dsh-base` 的行 id 或 sandbox-local 的 Config,需复核此配方。
- 回滚:删掉 `~/.dsh/cordis.patch.yml` 里的 `sandbox` 行(或整个文件)→ 回默认 bwrap runner。

## 7. 可选:上报 upstream

这对所有「用户 ssh config 为 root 属主」的系统(NixOS/home-manager 常态)都会让沙箱内 ssh 全挂,值得给 deepseek-harness 提 issue:要么在 `bwrapProfileArgs` 内建此类 bind 修正,要么把 `runnerCommand` 配方写进文档。
