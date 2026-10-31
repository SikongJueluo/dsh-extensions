# DSH Developer Tools：Nix Worker 启动失败诊断与修复计划

日期：2026-10-31。对象：当前安装的 DSH `0.2.1-rc.5`。

## 结论

不是遗漏 npm 依赖或 Node 内部模块文件，而是 **Nix 包的加载器兼容补丁与 Inspector Worker 的启动参数不匹配**。

当前 DSH derivation 的 `postInstall` 把 `node-addon-require-builtin` 替换为普通 `createRequire()`，并给主启动器加 `--expose-internals`。Inspector 创建 Worker 时显式指定 `execArgv: []`，不继承该参数。Worker 的 profile-resolution bootstrap 因而无法通过普通 `require()` 访问 Node 内部加载器。

此修复应进入 DSH 的 Nix 打包步骤，而不是 auto-permit、profile 插件配置或全局 Node 环境。本文仅记录计划；未改 flake、`~/.dsh` 或 `/nix/store`，未启用现有 profile 的插件。

## 已核对的证据

当前安装根：

```text
/nix/store/hb0wd227jraf356q7r6qsv2xn5kkj97h-dsh-0.2.1-rc.5/lib/node_modules/@deepseek-ai/dsh
```

以下路径相对于该根：

1. `node_modules/@deepseek-ai/dsh-experimental-inspector/lib/index.js:1907–1913`：

   ```js
   function spawnWorker(boot) {
     const options = {
       workerData: boot,
       transferList: [boot.hostSourcePort],
       execArgv: []
     };
     if (!import.meta.url.endsWith(".ts")) return new Worker(new URL("./worker.js", import.meta.url), options);
   ```

2. `node_modules/@deepseek-ai/dsh-experimental-inspector/lib/worker.js:1` 首先导入 `@deepseek-ai/dsh-app-boot/worker/profile-resolution-bootstrap`。
3. `node_modules/@deepseek-ai/dsh-app-boot/lib/worker/profile-resolution-bootstrap.js:563–569`：

   ```js
   function internalModules() {
     const addon = { requireBuiltin: createRequire(import.meta.url) };
     const esmModule = addon.requireBuiltin("internal/modules/esm/loader");
   ```

4. 当前 derivation `/nix/store/z4ar9hvjaa33id7vlhwf8zv3w8ydvs5a-dsh-0.2.1-rc.5.drv` 的 `postInstall` 包含：

   ```sh
   for f in index.js worker/profile-resolution-bootstrap.js; do
     substituteInPlace \
       $out/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/$f \
       --replace-fail 'createRequire(import.meta.url)("node-addon-require-builtin")' \
       '{ requireBuiltin: createRequire(import.meta.url) }'
   done
   ```

   同一安装步骤给 `$out/bin/dsh` 的 Node wrapper 加 `--expose-internals`。这证明普通 `require()` 是打包时引入的替代实现，而非上游原始 addon 路径。

5. 本机 flake `modules/home/dsh.nix:74–85` 的 Web 服务入口同样显式传入 `--expose-internals`，但主线程参数不能覆盖 Inspector 的 `execArgv: []`。包来自 `pkgs.llm-agents.dsh`，flake input 为 `numtide/llm-agents.nix`。

`internal/modules/esm/loader` 是 Node 内嵌的内部模块，不是应该额外安装的 npm 包。错误信息里的 “Cannot find module” 在这里表示普通 `require()` 没有内部模块访问开关。

## 复现与单变量验证

以下检查均使用独立进程；没有修改安装文件或活动 profile。

| 检查 | 结果 |
|---|---|
| 实际 bootstrap，Worker `execArgv: []` | `MODULE_NOT_FOUND: internal/modules/esm/loader`，退出 1，堆栈与用户错误相同 |
| 同一 bootstrap，仅改为 `execArgv: ["--expose-internals"]` | 退出 0 |
| 使用 DSH wrapper 指向的 Node，主进程带 `--expose-internals`，Worker 仍用 `[]` | 仍复现相同错误 |
| 调用安装包真实 `startInspector({ port: 0, captureFetch: false })` | 同样在 bootstrap 失败 |
| 通过 Node `registerHooks` 仅在内存中把 Inspector 的唯一 `execArgv: []` 改为带上述参数，再调用真实 `startInspector` | 启动成功；`/json/list` 返回 200 且包含调试目标；`close()` 正常结束 |

实测 Node 为 `v24.21.0`，最终可执行文件属于 nixpkgs `nodejs-slim`；同一个可执行文件加回参数即可通过，排除“精简包删除内部模块”的解释。

### flake 修复后的回归命令

将 `DSH_IMPL` 换成**重建后**包的真实安装根。此命令兼容 Fish，不使用现有用户 profile，不捕获 fetch，绑定临时端口并最终关闭 Inspector。

```fish
env DSH_IMPL=/nix/store/<new-dsh-output>/lib/node_modules/@deepseek-ai/dsh node --expose-internals --input-type=module -e '
import assert from "node:assert/strict";
import { setEnvironmentData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
const entry = pathToFileURL(process.env.DSH_IMPL + "/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/index.js");
setEnvironmentData("@deepseek-ai/dsh-app-boot/profile-resolution", {
  resolution: { entries: [], profilesDir: process.cwd(), linkedRoots: [], localPackageNames: [] }
});
const { startInspector } = await import(entry.href);
const inspector = await startInspector({ port: 0, captureFetch: false });
try {
  const response = await fetch(new URL("json/list", inspector.endpoint.httpUrl));
  assert.equal(response.status, 200);
  const targets = await response.json();
  assert.ok(Array.isArray(targets) && targets.length > 0);
  console.log("PASS: Inspector starts and exposes a target");
} finally {
  await inspector.close();
}
'
```

对当前旧包执行此调用，已确认得到原始 bootstrap 错误；未修改文件的内存补丁版本已通过同等启动和 HTTP 断言。

## 最小修复建议

在 DSH 的 Nix `postInstall` 中保留现有 addon 替换，同时给已发布 Inspector 的 Worker 补上它所依赖的内部模块访问参数：

```nix
programs.dsh.package = pkgs.llm-agents.dsh.overrideAttrs (old: {
  postInstall = (old.postInstall or "") + ''
    substituteInPlace \
      "$out/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/index.js" \
      --replace-fail 'execArgv: []' 'execArgv: ["--expose-internals"]'
  '';
});
```

该片段供用户落入 flake 的 Home Manager 声明处；更适合长期维护的位置是 `llm-agents.nix` 原有的同一打包补丁旁。`--replace-fail` 让上游布局或实现变化在构建阶段暴露，升级时重新核对。

只传这一项，不把整个 `process.execArgv` 复制给 Worker，避免附带主线程的 inspect、loader 或 eval 参数。仅给主启动命令再次追加该参数不能修复；安装 npm 包、改 `NODE_PATH` 或关沙箱也不针对根因。

## 验收及限制

1. 用户在 flake 中应用补丁并重建，确认新输出包含 Worker 参数。
2. 对新包执行上面的启动回归命令。
3. 重启 DSH Web 服务，再启用 Developer Tools，确认没有 `entry did not activate`。
4. 浏览器打开 NodeJS Inspector，验证 Host/Client Console、Sources 和 Session Log。

已验证的是根因与完整 Inspector 启动、调试目标 HTTP 端点；没有执行 Nix 重建，也没有验证 Web 面板和浏览器连接。不能把本次探针通过等同于 Developer Tools 整个 bundle 已端到端验收。

Inspector 默认捕获 fetch 请求/响应及凭据，CDP 允许执行代码；保持 loopback 绑定，不要为排错公开其端口。本次探针均设置 `captureFetch: false` 并已关闭临时 Inspector。
不存在落盘临时补丁或调试日志需要清理；auto-permit 保持不变。
