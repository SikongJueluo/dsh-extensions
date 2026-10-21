# dsh-cmd-permit

DSH 的按命令放行器：在 `approval/request` waterfall 上插队一个**确定性白名单
answerer**——配置内命令族的 sandbox 提权不再弹窗，也不消耗 auto-permit 的判官
调用。同时它把「高危形状」规则的家安在这里：内置不可逆表来自
[dsh-auto-permit](../auto-permit/)（`isHighRisk`），本行 `denyShape` 配置在其上
追加，并以 `ctx.cmdPermit` 服务暴露给 auto-permit 的 judge 复用——一张表管两条
路径。

> 种子迁移（2026-10-21）：随 [dsh-toolchain-access](../toolchain-access/) 落地，
> 种子白名单从 `rtk,cargo,direnv` 收敛为 `rtk`。`cargo`/`direnv` 当初只为绕过
> HOME 缓存写（cargo registry/git/.package-cache、direnv allow 记录），这层需求
> 现在由目录授权预设承担，不再默认放行 Full access。`rtk` 保留：它改写后几乎
> 前置每条命令，且其自身状态写入不被任何缓存预设覆盖。已装 profile 的存量配置
> 不受种子变化影响；要迁移见
> [plan-dsh-toolchain-access.md](../../docs/plan-dsh-toolchain-access.md)。

## 行为

当一次 bash 提权请求到达时（命令被 sandbox 拒绝后模型带
`sandbox_permissions` 重试）：

1. **高危形状**：内置表（`rm -rf ~`、`git clean -xfd`、`git reset --hard`、
   `git push --force`、`sudo`、`curl|sh` …）∪ 本行 `denyShape` 正则命中 →
   `next()` 交人工，永不过插件。
2. **白名单覆盖**：命令按 `&&`/`||`/`;`/`|`/换行切段，**每段**都被
   `allow`（命令名，自动剥 `VAR=` 前缀 / wrapper / 路径 basename）或
   `allowPattern`（正则，如 `^gh pr\b`）覆盖，且请求的 mode ≤ `maxMode` →
   `allowed-once` + 会话折叠通知行（写明命中的规则）。
3. **其余一切**——段未覆盖、含命令替换（`$(…)`/反引号，内层命令对匹配器
   不可见）、mode 超上限、证据不可恢复 → `next()`，原样交给链路后面
   （auto-permit 判官 → 人工弹窗）。

与 auto-permit 同原则：**永不返回 `rejected`**，插件不能冒充用户的「否」；
自身故障一律向人降级。切分是刻意保守的：引号里的运算符只会**多切**（切出的
段必须各自命中才放行），fail-closed。

## 链序（2026-10-11 二次实测后的最终设计：顺序不再是问题）

实测机制：answerer 都 `prepend`、后挂载的先跑；而 auto-permit 声明
`static inject = ['llm']`，loader 等 llm 就绪才启动它——所以它**永远**
比无依赖的 cmd-permit 后启动、永远占据链头，insert 行序怎么排都改变不了。

因此本插件不再争链头：`ctx.cmdPermit` 服务暴露 `claim(command, mode)`
决策核心，**auto-permit 的 answerer（链头）在「高危检查之后、记忆/判官
之前」咨询它**，得到确定顺序 `[高危 → 白名单 → 记忆 → 判官]`。本插件
自己的 answerer 仍在（无 auto-permit 的组合里独立工作），行序无关紧要。

## 配置（行 config，全部 volatile，Settings 页直接编辑）

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；关闭即整链回落 |
| `allow` | `[]`（bundle 种子 `rtk`） | 命令名；复合命令每段都须命中 |
| `allowPattern` | `[]` | 正则；一条匹配整段即可 |
| `denyShape` | `[]` | 追加的高危形状，两条路径都生效 |
| `maxMode` | `danger-full-access` | 自动放行的最高档；更宽请求交人工 |

信任语义：把一个名字放进 `allow` = 该命令族在 `maxMode` 内免审批。重定向
目标、参数内容不另做检查——高危表与人工兜底覆盖其余。

## 依赖

运行时 import `dsh-auto-permit`（`collectEvidence`/`isHighRisk`），需与
本包装进同一 profile。开发 overlay 时也要求 profile node_modules 里有
dsh-auto-permit（见 [dev.patch.yml](dev.patch.yml) 注释）。

## 测试

```sh
pnpm build   # cmd-permit 经 dsh-auto-permit 的编译产物取 collectEvidence
pnpm -C packages/cmd-permit test              # vitest：直接 / PTC 两路审批集成
node packages/cmd-permit/smoke.mjs
```
