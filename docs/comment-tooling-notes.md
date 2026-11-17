# Build and quality tooling contracts

These notes retain the tooling constraints that previously lived in source comments. The source-comment policy is defined in [comment-policy.md](comment-policy.md).

## Client artifacts

[Client build preset](../tooling/client/index.ts) emits one CJS factory registered with the DSH module loader. React runtime requests are served by the shell's frozen platform table; other dependencies are bundled. The one explicit non-React host coupling is the pinned client UI primitives package. A consuming manifest must declare that exact module in `dsh.client.external`; expanding the allowlist to a package prefix would hide undeclared host dependencies.

Extracted CSS must be inserted during factory execution so the loader owns its style element and removes it during disable or HMR. A CSS asset beside the bundle is never requested by DSH. Host and client outputs share the package output directory, so neither build may erase the other half. React Server Component `use client` directives from dependencies have no meaning in this browser-only CJS artifact.

[Client artifact guard](../scripts/check-client.mjs) checks the registration, external requests, stylesheet ownership, apply/inject exports, and rendering of every registered slot. Node 24 materializes the real pinned host ESM with only CSS module names stubbed; Node 20 cannot require that ESM and uses a shape stub, so Storybook and browser tests provide the stronger coverage. Server-rendering warnings from floating primitives' layout effects are filtered because this guard checks that components can mount, not their browser layout.

[Host build preset](../tooling/host/index.ts) preserves the official ESM/Node 20 layout and external runtime SDK dependencies. Its `clean: false` preserves the client artifact during host-only builds.

## Preview environment

[Storybook configuration](../.storybook/main.ts) selects the automatic JSX runtime because source components do not import React merely for JSX. [Preview tokens](../.storybook/preview.css) are a Storybook-only stand-in copied from the pinned host theme; production styles consume live host variables instead. The toolbar offers two string themes, and the preview validates that value before applying the dark fallback.

## Quality entry points

[Quality runner](../scripts/check-quality.mjs) runs cheap checks before producing build artifacts consumed by smoke, client, package, and Storybook checks. By default it collects all failures; `--fail-fast` stops at the first failure. `--list` prints the steps, and repeatable `--only=<step>` selects individual steps.

[Smoke runner](../scripts/check-smoke.mjs) discovers scripts and requires each to run or have a documented exclusion. Missing excluded paths fail rather than silently retaining stale exceptions. `--list` reports classification and `--verbose` streams child output. The real-provider research smoke needs credentials and network access, so it remains an explicit manual check. CI provisions jj with a test identity and fish because repository tests and shell smoke checks exercise those programs.

[Suppression checker](../scripts/check-suppressions.mjs) compares actual inline lint directives with the approved path/rule registry in both directions. Its [parser-based extraction](../scripts/comments/suppressions.mjs) covers line, next-line, block and file suppressions while ignoring text inside string fixtures. Disabling all rules produces a wildcard that also needs explicit approval. New and stale entries fail; changing the approved registry remains a policy change under [quality-gates.md](quality-gates.md). Its source-directory exclusions concern dependencies and runtime artifacts, not approval bypasses.

## Root configurations

[Lint configuration](../.oxlintrc.json) owns correctness and type-quality; [format configuration](../.oxfmtrc.json) owns layout and deliberately leaves import, manifest and Tailwind sorting disabled. Markdown stays outside formatting because character-based table padding harms the repository's Chinese documentation. Individual lint exclusions and approvals remain recorded in [quality-gates.md](quality-gates.md).

[Root TypeScript program](../tsconfig.json) exists for typed linting of build configs, tests, scripts and Storybook that package programs do not own. It mixes Node and DOM libraries and must not replace the real per-package typechecks. JavaScript receives syntax checks rather than typed rules. Dot-directory preview files are named explicitly because include globs skip them.

[Fallow configuration](../.fallowrc.jsonc) models Cordis service dispatch through runtime proxies and identifies manual smoke/probe entry points; jj is supplied by the host environment. The nested untracked repository is outside this project. The shared dependency catalog pins the SDK to the installed host release and supplies preview dependencies whose upstream primitives manifest does not expose them as runtime dependencies; production does not load that preview graph.
