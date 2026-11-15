# @dsh-extensions/ui

Shared browser-half UI for this repository's DSH plugins. It is a private
workspace package: each plugin bundles the components it uses into its own
`lib/client.js`, so there is no shared UI bundle to install or enable.

The stack is shadcn/ui composition on **Base UI** primitives
(`@base-ui/react`), **Tailwind CSS v4** utilities, and the public DSH theme
tokens. It is not a general-purpose component library.

The one exception is `src/host/primitives.ts`: it re-exports the host's own
`@deepseek-ai/dsh-client-ui-primitives` for controls whose look and keyboard
behavior must match the stock UI. That package is pinned to the host release,
requested from the shell's frozen module table at runtime, and never bundled.
Import it from the `@dsh-extensions/ui/host` subpath so plugins that do not use
it never request the module. Those devDependencies below `@shikijs/langs` exist
only because the published primitives manifest omits its own runtime imports;
they serve Storybook and the jsdom tests and never reach a production bundle.

## Layout

| Path | Purpose |
| --- | --- |
| `src/components/*.tsx` | shadcn-style components (Button, Input, Field, Card, Badge, Alert, Progress, Spinner, Switch, Select, Dialog, Table) |
| `src/theme.css` | `@theme inline` mappings from `--dsw-alias-*` tokens, scoped base rules |
| `src/lib/cn.ts` | `clsx` + `tailwind-merge`, configured for the `dshx:` utility prefix |
| `src/types.ts` | the client-half context contract (`apply(ctx)` surface) |
| `src/host/primitives.ts` | the pinned host `dsh-client-ui-primitives` re-exports, exposed as `@dsh-extensions/ui/host` |

## Rules

1. **Every slot component returns one `<Root>`.** `Root` adds the `dshx-root`
   class; the scoped reset and the `dshx:` prefixed utilities only apply below
   it. Never import Tailwind Preflight, never style `body`, `html`, or host
   classes.
2. **Only public alias tokens.** Color decisions use the mapped classes
   (`bg-surface`, `text-fg-muted`, `border-border-strong`, `bg-brand`, …),
   which resolve to `--dsw-alias-*`. Do not hard-code a hex color or reach for
   an internal host variable.
3. **Prefix every utility with `dshx:`.** Variants come after the prefix:
   `dshx:hover:bg-surface-2`, `dshx:pointer-coarse:min-h-11`,
   `dshx:data-[checked]:bg-brand`.
4. **Interactive controls are Base UI by default.** `Switch`, `Select`, and
   `Dialog` are the shared wrappers. Their popups portal into a container inside
   the component subtree, not `document.body`, so theme inheritance and slot DOM
   ownership stay intact. Dialogs keep Base UI's focus trap, Escape handling,
   and focus return. `Select` defaults to an `align="start"` popup and offers
   `variant="ghost"` for DSH inline selectors; it stays the shared control for
   ordinary selects. Pass `align="end"` when the control sits at the right edge
   so the popup keeps its right edge fixed and expands left.
   The jj-workspace worktree option is the exception: it uses the host `Menu`
   and `Tooltip` through `@dsh-extensions/ui/host`, renders the menu in place,
   flips to the side with room, and caps the list height instead of portaling
   out of the hero scroll container. The host `MenuSurface` itself still
   portals one inert `aria-hidden` `[data-menu-backing]` decoration to the body
   (removed on close/unmount); that host-managed node is the only approved body
   exception, and plugin code must not add body nodes itself.
5. **Touch first.** Click handlers only; hover is an enhancement. Shared
   controls add `pointer-coarse` minimum targets. Tests for a new component
   should cover disabled, loading/empty, error, and long-content states.
6. **Styles follow the bundle.** `vite.config.ts` inlines the extracted CSS
   into the factory and inserts a `<style data-plugin="<package>">` element
   while the module materializes; the DSH loader claims that tag and removes
   it when the plugin is disabled or reloaded. Do not ship a CSS asset next to
   `client.js`.

## Client build

Each browser-half plugin has:

```text
src/client/index.tsx    # exports apply + inject
src/client/styles.css   # Tailwind theme entry, @source lines
vite.client.config.ts   # defineClientConfig({ id, entry })
tsconfig.client.json    # tsconfig.client.base.json + src/client
```

`styles.css` is the standard three-import header:

```css
@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" layer(theme) prefix(dshx);
@import "tailwindcss/utilities.css" layer(utilities) prefix(dshx);
@import "@dsh-extensions/ui/theme.css";

@source "./**/*.tsx";
@source "../../../ui/src/**/*.tsx";
```

`pnpm build` runs tsdown for the host half and `vite build --config vite.client.config.ts` for the client half (the client-only name keeps Vitest from loading the library build settings). Vite
externalizes only the frozen platform table (`react`, `react/jsx-runtime`,
`react/jsx-dev-runtime`, `react-dom`, `react-dom/client`) plus an exact host
module a package declares in `dsh.client.external` (today only
`@deepseek-ai/dsh-client-ui-primitives`); Base UI, CVA, tailwind-merge, and
lucide are bundled. `pnpm check:client` rejects a request that is neither a
platform module nor a declared external.

## Adding a control

Add it only when a second consumer needs it. Keep the shadcn composition API
(subcomponents and `className`), put variant decisions in `cva`, and use the
existing token classes. Components that render overlays must accept the
in-subtree portal container pattern used by `Select` and `Dialog`.
