/**
 * Host UI primitives.
 *
 * This is the one deliberate host coupling in the repository: DSH seeds
 * `@deepseek-ai/dsh-client-ui-primitives` into the web shell's frozen module
 * table, so a client bundle that requests it runs the same module instance, CSS
 * Modules and icons the stock UI uses. It is not a supported third-party SDK;
 * the version is pinned exactly to the host release and every consumer declares
 * the request under `dsh.client.external`. Upgrade notes live in
 * `docs/client-ui-migration.md`.
 *
 * Import from `@dsh-extensions/ui/host`, never from the package root barrel:
 * the barrel is shared by plugins that must not request this module.
 */
export {
  IconBranchOutlineRegular,
  IconChevronDownOutlineRegular,
  Menu,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
export type {
  MenuEntry,
  MenuItem,
  MenuLabel,
  MenuSeparator,
} from '@deepseek-ai/dsh-client-ui-primitives'
