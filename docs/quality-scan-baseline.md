# 质量门禁扫描基线（数据附录）

> 本文件是 [quality-gates.md](quality-gates.md) 的数据附录：逐规则的理由码、存量计数与样例。
> 数据来自 Node 24.21.0 / pnpm 12.3.4 / oxlint 1.93.0 / oxfmt 0.78.0 / fallow 3.43.1 的一次全仓扫描；
> 命令见文末。计数会随修复下降，规则判定（归组码）才是需要长期维护的部分。

## 归组码

- **R** — 已采纳（保留为 error），此处仅记录存量。
- **F** — 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。
- **T** — 个人风格/结构口味：不影响正确性，强制只会增加改动量。
- **N** — 数值预算：由 `fallow health` 报告，不做逐行卡口。
- **X** — 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。
- **L** — 禁用语言特性：本仓刻意使用该特性（async/optional chaining/spread/TLA/`undefined` 等）。
- **D** — 与已采纳规则冲突或重复：保留会造成互相打架。
- **M** — 不适用：框架/构建形态不匹配（无 i18n、无 Next/Vue、无 fast refresh、d.ts 等）。

`style`/`restriction` 两类的命中数来自“所有类别全开”的对照扫描，用于逐条判定；
候选基线只跑保留规则，因此这些命中不会出现在日常 lint 输出里。

## A. `style` 类别（整类关闭，仅逐条采纳 6 条）

| 规则 | 命中 | 归组 | 说明 | 例子 |
| --- | ---: | --- | --- | --- |
| `eslint/one-var` | 3781 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/identity.ts:21` |
| `eslint/no-magic-numbers` | 3263 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/auth.ts:22` |
| `eslint/sort-keys` | 3014 | F | 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。 | `packages/session-write-access/vite.client.config.ts:3` |
| `eslint/curly` | 1585 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:38` |
| `eslint/no-ternary` | 1118 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/discovery.ts:43` |
| `import/no-named-export` | 1042 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/identity.ts:13` |
| `eslint/func-style` | 1011 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/discovery.ts:34` |
| `eslint/capitalized-comments` | 913 | F | 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。 | `packages/oauth-providers/src/providers/chatgpt/discovery.ts:37` |
| `import/group-exports` | 833 | F | 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。 | `packages/oauth-providers/src/providers/chatgpt/identity.ts:13` |
| `jest/prefer-expect-assertions` | 693 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/toolchain-access/test/patch-config.test.ts:19` |
| `vitest/prefer-expect-assertions` | 693 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/toolchain-access/test/patch-config.test.ts:19` |
| `import/exports-last` | 557 | F | 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:27` |
| `jest/require-hook` | 499 | X | 测试里在用例内直接建临时目录/桩，比 `beforeEach` 更清晰。 | `packages/jj-workspace/test/worktree-option.test.mjs:13` |
| `vitest/require-hook` | 499 | X | 测试里在用例内直接建临时目录/桩，比 `beforeEach` 更清晰。 | `packages/jj-workspace/test/worktree-option.test.mjs:13` |
| `eslint/sort-imports` | 489 | F | 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。 | `packages/oauth-providers/src/providers/chatgpt/discovery.ts:15` |
| `eslint/id-length` | 434 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/src/client/worktree-option.stories.tsx:133` |
| `eslint/max-statements` | 414 | N | 数值预算：由 `fallow health` 报告，不做逐行卡口。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:60` |
| `unicorn/no-null` | 362 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/auth.ts:103` |
| `jest/prefer-strict-equal` | 309 | X | `toStrictEqual` 与 `toEqual` 的取舍是测试意图问题，309 处属口味。 | `packages/toolchain-access/test/patch-config.test.ts:24` |
| `vitest/prefer-strict-equal` | 309 | X | `toStrictEqual` 与 `toEqual` 的取舍是测试意图问题，309 处属口味。 | `packages/toolchain-access/test/patch-config.test.ts:24` |
| `eslint/init-declarations` | 195 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:72` |
| `eslint/no-continue` | 195 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/catalog.ts:83` |
| `node/no-sync` | 187 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/toolchain-access/test/patch-config.test.ts:20` |
| `import/no-nodejs-modules` | 183 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/toolchain-access/test/patch-config.test.ts:9` |
| `unicorn/numeric-separators-style` | 149 | F | 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。 | `packages/oauth-providers/src/providers/chatgpt/index.ts:38` |
| `vitest/prefer-to-be-truthy` | 136 | X | `toBeTruthy` 与 `toBe(true)` 的取舍属口味。 | `packages/jj-workspace/test/worktree-option.test.mjs:124` |
| `typescript/method-signature-style` | 133 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/auth.ts:26` |
| `react/jsx-max-depth` | 133 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/ui/src/components/dialog.stories.tsx:33` |
| `eslint/prefer-destructuring` | 128 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:93` |
| `jest/max-expects` | 117 | N | 数值预算：由 `fallow health` 报告，不做逐行卡口。 | `packages/search-integrator/test/fetch-page.test.ts:40` |
| `vitest/max-expects` | 117 | N | 数值预算：由 `fallow health` 报告，不做逐行卡口。 | `packages/search-integrator/test/fetch-page.test.ts:40` |
| `promise/prefer-await-to-then` | 107 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:84` |
| `import/consistent-type-specifier-style` | 106 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/src/client/worktree-option.tsx:1` |
| `promise/avoid-new` | 100 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/oauth.ts:215` |
| `eslint/prefer-template` | 90 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/search-integrator/test/evidence.test.ts:118` |
| `jest/prefer-ending-with-an-expect` | 86 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/recursive-skills/test/frontmatter.test.ts:61` |
| `vitest/prefer-to-be-falsy` | 84 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/recursive-skills/test/frontmatter.test.ts:64` |
| `eslint/no-duplicate-imports` | 83 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/oauth-providers/src/providers/chatgpt/discovery.ts:15` |
| `unicorn/no-await-expression-member` | 82 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/handoff/test/review-integration.test.mjs:303` |
| `unicorn/max-nested-calls` | 74 | N | 数值预算：由 `fallow health` 报告，不做逐行卡口。 | `packages/task-anchor/test/checkpoint.test.ts:95` |
| `eslint/max-params` | 72 | N | 数值预算：由 `fallow health` 报告，不做逐行卡口。 | `packages/oauth-providers/src/providers/chatgpt/oauth.ts:165` |
| `eslint/new-cap` | 68 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/toolchain-access/test/patch-config.test.ts:24` |
| `unicorn/switch-case-braces` | 66 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/session-write-access/src/channel.ts:122` |
| `vitest/no-importing-vitest-globals` | 51 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/toolchain-access/test/patch-config.test.ts:12` |
| `eslint/no-nested-ternary` | 44 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/handoff/test/review-integration.test.mjs:358` |
| `promise/prefer-await-to-callbacks` | 37 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:84` |
| `eslint/prefer-named-capture-group` | 37 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/search-integrator/src/fetch-page.ts:22` |
| `vitest/prefer-describe-function-title` | 34 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/recursive-skills/test/frontmatter.test.ts:8` |
| `jest/require-top-level-describe` | 29 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/jj-workspace/test/worktree-option.test.mjs:27` |
| `vitest/require-top-level-describe` | 29 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/jj-workspace/test/worktree-option.test.mjs:27` |
| `unicorn/no-nested-ternary` | 29 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/handoff/test/review-integration.test.mjs:360` |
| `jest/prefer-expect-resolves` | 29 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/task-anchor/test/checkpoint.test.ts:119` |
| `vitest/prefer-expect-resolves` | 29 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/task-anchor/test/checkpoint.test.ts:119` |
| `jest/no-hooks` | 25 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/jj-workspace/test/worktree-option.test.mjs:27` |
| `vitest/no-hooks` | 25 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/jj-workspace/test/worktree-option.test.mjs:27` |
| `unicorn/relative-url-style` | 23 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/handoff/test/review-integration.test.mjs:181` |
| `jest/prefer-lowercase-title` | 20 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/execution-guard/test/repeat.test.ts:21` |
| `vitest/prefer-lowercase-title` | 20 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/execution-guard/test/repeat.test.ts:21` |
| `react/jsx-props-no-spreading` | 19 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/src/client/worktree-option.stories.tsx:128` |
| `promise/param-names` | 19 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/search-integrator/test/pipeline.test.ts:301` |
| `promise/prefer-catch` | 17 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/src/client/index.tsx:276` |
| `unicorn/prefer-string-raw` | 17 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/transport.ts:90` |
| `typescript/array-type` | 15 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/oauth-providers/src/providers/chatgpt/catalog.ts:66` |
| `unicorn/catch-error-name` | 15 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/client/index.tsx:303` |
| `unicorn/prefer-global-this` | 14 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/test/worktree-option.test.mjs:21` |
| `unicorn/prefer-response-static-json` | 14 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/test/client-deps.test.mjs:101` |
| `import/no-namespace` | 14 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/handoff/test/review-integration.test.mjs:14` |
| `import/prefer-default-export` | 12 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/session-write-access/src/policy.ts:21` |
| `eslint/arrow-body-style` | 12 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/client/index.tsx:540` |
| `typescript/consistent-type-imports` | 12 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/search-integrator/src/pipeline.ts:366` |
| `unicorn/consistent-existence-index-check` | 11 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/recursive-skills/src/frontmatter.ts:83` |
| `eslint/func-names` | 10 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/test/client-deps.test.mjs:39` |
| `import/no-duplicates` | 9 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/session-write-access/src/service.ts:22` |
| `typescript/prefer-readonly` | 9 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/triggers/src/service.ts:151` |
| `typescript/parameter-properties` | 8 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/execution-guard/src/checkpoint.ts:137` |
| `jest/consistent-test-it` | 7 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/jj-workspace/test/worktree-option.test.mjs:78` |
| `vitest/consistent-test-it` | 7 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/jj-workspace/test/worktree-option.test.mjs:78` |
| `unicorn/prefer-spread` | 7 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/providers/chatgpt/serialize.ts:186` |
| `unicorn/custom-error-definition` | 7 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/session-write-access/src/service.ts:50` |
| `eslint/no-template-curly-in-string` | 6 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/auto-permit/test/container.test.ts:100` |
| `unicorn/prefer-export-from` | 6 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/index.ts:27` |
| `eslint/no-implicit-coercion` | 5 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/client/index.tsx:413` |
| `jest/padding-around-after-all-blocks` | 4 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/toolchain-access/test/bwrap.test.ts:61` |
| `vitest/padding-around-after-all-blocks` | 4 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/toolchain-access/test/bwrap.test.ts:61` |
| `unicorn/prefer-logical-operator-over-ternary` | 4 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/oauth-providers/src/transport.ts:245` |
| `typescript/consistent-type-definitions` | 3 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/src/client/index.tsx:200` |
| `unicorn/prefer-ternary` | 3 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/execution-guard/src/preflight.ts:132` |
| `react/function-component-definition` | 3 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/ui/src/components/input.tsx:7` |
| `jest/prefer-each` | 2 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/toolchain-access/test/patch-config.test.ts:18` |
| `vitest/prefer-each` | 2 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/toolchain-access/test/patch-config.test.ts:18` |
| `import/first` | 2 | F | 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。 | `packages/jj-workspace/test/client-deps.test.mjs:12` |
| `import/newline-after-import` | 2 | F | 纯排版/布局：由 Oxfmt 承担，lint 不重复判断。 | `packages/jj-workspace/test/client-deps.test.mjs:12` |
| `vitest/no-import-node-test` | 2 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/handoff/test/review-integration.test.mjs:10` |
| `vitest/prefer-importing-vitest-globals` | 2 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/handoff/test/review-integration.test.mjs:210` |
| `eslint/prefer-const` | 2 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/triggers/test/engine.test.ts:206` |
| `unicorn/prefer-default-parameters` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/src/client/index.tsx:558` |
| `vitest/prefer-expect-type-of` | 1 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/task-anchor/test/integration.test.ts:157` |
| `unicorn/no-useless-collection-argument` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/execution-guard/src/preflight.ts:176` |
| `eslint/object-shorthand` | 1 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/session-write-access/test/service.test.ts:360` |
| `typescript/prefer-for-of` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/recursive-skills/src/provider.ts:225` |
| `eslint/default-param-last` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/handoff/test/preferences-presets.test.mjs:241` |
| `node/callback-return` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/test/client.test.mjs:49` |
| `vitest/prefer-called-once` | 1 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/handoff/test/client.test.mjs:149` |
| `jest/prefer-to-have-length` | 1 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/triggers/test/cordis.test.ts:274` |
| `vitest/prefer-to-have-length` | 1 | X | 测试框架风格：与本仓 vitest/`node:test` 用法无关或纯口味。 | `packages/triggers/test/cordis.test.ts:274` |
| `import/no-named-default` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/jj-workspace/smoke.mjs:11` |
| `eslint/no-return-assign` | 1 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/crew/src/index.ts:197` |
| `react/jsx-boolean-value` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/triggers/src/client/index.tsx:1109` |
| `typescript/prefer-regexp-exec` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `scripts/check-client.mjs:83` |

## B. `restriction` 类别（整类关闭，仅逐条采纳 13 条）

| 规则 | 命中 | 归组 | 说明 | 例子 |
| --- | ---: | --- | --- | --- |
| `eslint/no-undefined` | 1983 | L | TS 里 `undefined` 是正常值；禁用字面量没有收益。 | `packages/oauth-providers/src/providers/chatgpt/discovery.ts:43` |
| `oxc/no-async-await` | 1117 | L | 禁用语言特性：本仓刻意使用该特性（async/optional chaining/spread/TLA/`undefined` 等）。 | `packages/oauth-providers/src/providers/chatgpt/discovery.ts:35` |
| `oxc/no-optional-chaining` | 947 | L | 禁用语言特性：本仓刻意使用该特性（async/optional chaining/spread/TLA/`undefined` 等）。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:91` |
| `vitest/require-test-timeout` | 693 | M | 要求每个测试显式超时；本仓超时在需要处显式设置。 | `packages/toolchain-access/test/patch-config.test.ts:19` |
| `oxc/no-rest-spread-properties` | 552 | L | 禁用语言特性：本仓刻意使用该特性（async/optional chaining/spread/TLA/`undefined` 等）。 | `packages/oauth-providers/src/providers/chatgpt/discovery.ts:43` |
| `typescript/explicit-function-return-type` | 445 | T | `tsc` 已完整推断返回类型；全量标注是 445 处风格改动。 | `packages/oauth-providers/src/providers/chatgpt/login.ts:64` |
| `node/no-top-level-await` | 336 | L | 禁用语言特性：本仓刻意使用该特性（async/optional chaining/spread/TLA/`undefined` 等）。 | `packages/search-integrator/scripts/smoke-research.mjs:202` |
| `typescript/explicit-member-accessibility` | 220 | T | 类成员可见性标注是风格选择。 | `packages/oauth-providers/src/providers/chatgpt/auth.ts:53` |
| `typescript/no-non-null-assertion` | 189 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/oauth-providers/src/providers/chatgpt/oauth.ts:118` |
| `eslint/no-empty-function` | 179 | T | Storybook/测试桩里的空函数是占位实现。 | `packages/jj-workspace/src/client/worktree-option.stories.tsx:30` |
| `import/no-relative-parent-imports` | 166 | L | monorepo 无路径别名，`../../tooling/...` 是既定写法。 | `packages/session-write-access/vite.client.config.ts:1` |
| `typescript/promise-function-async` | 141 | T | 强制 Promise 返回函数写成 `async` 会改变错误堆栈与调度，不是无成本改动。 | `packages/triggers/src/service.ts:428` |
| `eslint/no-use-before-define` | 128 | L | 禁用语言特性：本仓刻意使用该特性（async/optional chaining/spread/TLA/`undefined` 等）。 | `packages/session-write-access/src/channel.ts:92` |
| `react/forbid-component-props` | 111 | M | `className`/`style` 是本仓 Tailwind 布局的核心手段。 | `packages/ui/src/components/feedback.stories.tsx:8` |
| `eslint/no-console` | 100 | R | 已在源码区采纳为 error；测试/smoke/脚本放行，因为 stdout 就是它们的接口。 | `packages/search-integrator/scripts/smoke-research.mjs:32` |
| `eslint/no-void` | 95 | D | 见上：与 `no-floating-promises` 冲突。 | `packages/oauth-providers/src/client/index.tsx:242` |
| `node/no-process-env` | 83 | T | 本仓有 21 处 `process.env` 回退（`DSH_HOME`、provider key、可注入 `environment` 参数），是有意契约。 | `packages/plan-usage/src/sources/commandcode.ts:252` |
| `react/jsx-no-literals` | 62 | M | 没有 i18n 层，UI 文案直接写在 JSX 里。 | `packages/ui/src/components/feedback.stories.tsx:21` |
| `unicorn/import-style` | 55 | T | 不强制 `import * as` / 具名导入的固定形态。 | `packages/toolchain-access/test/patch-config.test.ts:10` |
| `import/no-default-export` | 49 | L | 禁用语言特性：本仓刻意使用该特性（async/optional chaining/spread/TLA/`undefined` 等）。 | `packages/session-write-access/vite.client.config.ts:3` |
| `eslint/complexity` | 43 | N | 与 B9-B18 同属数值预算，由 `fallow health` 报告（4756 函数中 308 个超阈值）。 | `packages/plan-usage/src/sources/commandcode.ts:185` |
| `react/no-multi-comp` | 40 | T | 一个文件多个组件（含 stories）是既定组织方式。 | `packages/ui/src/components/interaction.test.tsx:64` |
| `react/only-export-components` | 34 | M | DSH loader 没有 React fast refresh，此规则的前提不成立。 | `packages/oauth-providers/src/client/index.tsx:227` |
| `typescript/explicit-module-boundary-types` | 33 | T | 同 explicit-function-return-type。 | `packages/jj-workspace/src/client/worktree-option.tsx:74` |
| `react/jsx-filename-extension` | 31 | M | 本仓 JSX 一律 `.tsx`，规则建议的 `.jsx` 不适用。 | `packages/jj-workspace/src/client/worktree-option.stories.tsx:105` |
| `eslint/class-methods-use-this` | 28 | T | 实现接口/覆盖基类时方法可以不用 `this`。 | `packages/jj-workspace/test/worktree-option.test.mjs:16` |
| `eslint/no-plusplus` | 24 | T | `++` 在计数循环里是明确写法，无缺陷信号。 | `packages/oauth-providers/src/providers/chatgpt/adapter.ts:193` |
| `typescript/non-nullable-type-assertion-style` | 22 | D | 它建议改用 `!`，与已采纳的 `no-non-null-assertion` 直接冲突。 | `packages/search-integrator/src/tool.ts:272` |
| `unicorn/no-process-exit` | 13 | T | CLI/smoke 脚本用 `process.exit` 表达退出码。 | `packages/search-integrator/scripts/smoke-research.mjs:167` |
| `eslint/default-case` | 9 | D | 与 type-aware 的 `switch-exhaustiveness-check` 冲突：穷尽联合类型不需要 default。 | `packages/recursive-skills/src/frontmatter.ts:148` |
| `react/rule-suppression` | 7 | D | 它扫描抑制注释本身；抑制卫生由 `reportUnusedDisableDirectives` 负责。 | `packages/oauth-providers/src/client/index.tsx:246` |
| `promise/catch-or-return` | 7 | R | 已采纳：`.then()` 必须返回或接 `.catch()`。 | `packages/oauth-providers/src/client/index.tsx:378` |
| `unicorn/prefer-number-properties` | 7 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/oauth-providers/src/transport.ts:95` |
| `eslint/no-bitwise` | 5 | T | 位掩码用法（`toolchain-access` 授权位）是有意的。 | `packages/toolchain-access/test/grants.test.ts:182` |
| `typescript/no-explicit-any` | 5 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/ui/src/types.ts:18` |
| `unicorn/no-array-for-each` | 4 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/search-integrator/src/pipeline.ts:92` |
| `import/no-cycle` | 4 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/handoff/src/brief.ts:16` |
| `typescript/use-unknown-in-catch-callback-variable` | 4 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/jj-workspace/smoke.mjs:193` |
| `eslint/no-empty` | 3 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/auto-env/src/direnv.ts:327` |
| `typescript/no-dynamic-delete` | 2 | T | `tooling/client/index.ts` 对 bundle record 做 `delete bundle[fileName]`，是刻意的动态删除。 | `tooling/client/index.ts:54` |
| `unicorn/no-array-reduce` | 1 | T | 个人风格/结构口味：不影响正确性，强制只会增加改动量。 | `packages/auto-continue/src/schedule.ts:80` |
| `typescript/no-invalid-void-type` | 1 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/ui/src/types.ts:14` |
| `react/button-has-type` | 1 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/ui/src/components/button.tsx:41` |
| `eslint/no-param-reassign` | 1 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/plan-usage/src/client/index.tsx:93` |
| `oxc/no-barrel-file` | 1 | M | `packages/triggers/src/index.ts` 是包入口 barrel，是本仓形态。 | `packages/triggers/src/index.ts:25` |
| `import/unambiguous` | 1 | M | `tooling/client/env.d.ts` 是 ambient 声明文件，不能写 ESM 语法。 | `tooling/client/env.d.ts:1` |
| `eslint/no-sequences` | 1 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/remote-exec/smoke.mjs:631` |
| `eslint/no-alert` | 1 | R | 已采纳（保留为 error），此处仅记录存量。 | `packages/triggers/src/client/index.tsx:803` |

## C. Fallow 明细

### 未被任何入口引用的文件（4）

- `packages/auto-permit/src/identity.ts`
- `packages/execution-guard/src/checkpoint.ts`
- `packages/execution-guard/src/goal-evidence.ts`
- `packages/execution-guard/src/jj.ts`


### 循环依赖（2）

- 2 环：packages/handoff/src/brief.ts ↔ packages/handoff/src/spawn.ts
- 3 环：packages/handoff/src/brief.ts ↔ packages/handoff/src/spawn.ts ↔ packages/handoff/src/meta.ts

### 重复导出（3）

- `ConflictSide`：`packages/search-integrator/src/integrate.ts` / `packages/search-integrator/src/types.ts`
- `FetchLike`：`packages/plan-usage/src/sources/commandcode.ts` / `packages/plan-usage/src/sources/glm.ts`
- `SourceLogger`：`packages/plan-usage/src/sources/commandcode.ts` / `packages/plan-usage/src/sources/minimax.ts`

### 仍在报的类成员（19，含 3 条静态图限制）

- `packages/auto-continue/src/spool.ts :: WaitSpool`：set
- `packages/auto-env/src/direnv.ts :: DirenvLoader`：snapshot
- `packages/plan-usage/src/sources/commandcode.ts :: CommandCodeSource`：get; id; ready; routes
- `packages/plan-usage/src/sources/minimax.ts :: MiniMaxSource`：get; id; ready; routes
- `packages/plan-usage/src/sources/openai.ts :: OpenAiUsageSource`：get; id; ready; routes
- `packages/plan-usage/src/sources/opencode.ts :: OpenCodeGoSource`：get; id; ready; routes
- `packages/rtk-rewrite/src/rewrite.ts :: RewriteCache`：size

## D. 复现命令

```sh
pnpm lint                      # oxlint（含 type-aware，读 .oxlintrc.json）
OXC_LOG=debug pnpm lint        # 打印 program 分配与 unmatched 列表
pnpm format:check              # oxfmt --check .（排版已收敛，当前 0 差异）
pnpm fallow                    # fallow dead-code（102 条 error 级）
pnpm fallow:health             # 复杂度报告（不阻塞）
pnpm fallow:dupes              # 重复度报告（不阻塞）
```

