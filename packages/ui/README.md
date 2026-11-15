# @dsh-extensions/ui

Shared browser-half UI for this repository's DSH plugins. It is a private
workspace package: each plugin bundles the components it uses into its own
`lib/client.js`, so there is no shared UI bundle to install or enable.

The stack is shadcn/ui composition on **Base UI** primitives
(`@base-ui/react`), **Tailwind CSS v4** utilities, and the public DSH theme
tokens. It is not a general-purpose component library.

## Layout

| Path | Purpose |
| --- | --- |
| `src/components/*.tsx` | shadcn-style components (Button, Input, Field, Card, Badge, Alert, Progress, Spinner, Switch, Select, Dialog, Table) |
| `src/theme.css` | `@theme inline` mappings from `--dsw-alias-*` tokens, scoped base rules |
| `src/lib/cn.ts` | `clsx` + `tailwind-merge`, configured for the `dshx:` utility prefix |
| `src/types.ts` | the client-half context contract (`apply(ctx)` surface) |

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
4. **Interactive controls are Base UI.** `Switch`, `Select`, and `Dialog` are
   the shared wrappers. Their popups portal into a container inside the
   component subtree, not `document.body`, so theme inheritance and slot DOM
   ownership stay intact. Dialogs keep Base UI's focus trap, Escape handling,
   and focus return. `Select` defaults to an `align="start"` popup and offers
   `variant="ghost"` for the DSH inline selector (transparent, borderless,
   compact, arrow at the right); use the ghost variant inside dense controls
   such as the jj-workspace hero row. Pass `align="end"` when the control sits
   at the right edge so the popup keeps its right edge fixed and expands left.
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
`react/jsx-dev-runtime`, `react-dom`, `react-dom/client`); Base UI, CVA,
tailwind-merge, and lucide are bundled.

## Adding a control

Add it only when a second consumer needs it. Keep the shadcn composition API
(subcomponents and `className`), put variant decisions in `cva`, and use the
existing token classes. Components that render overlays must accept the
in-subtree portal container pattern used by `Select` and `Dialog`.
