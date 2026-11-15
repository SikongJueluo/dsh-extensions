import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { cn, Root } from '@dsh-extensions/ui'
import {
  IconBranchOutlineRegular,
  IconChevronDownOutlineRegular,
  Menu,
  Tooltip,
  type MenuEntry,
} from '@dsh-extensions/ui/host'

/**
 * One selectable base in the worktree menu. `value` is what the Forge Remote
 * accepts (`''` for a detached Git HEAD); `label` is the visible name.
 */
export interface WorktreeChoice {
  value: string
  label: string
  /** Trailing qualifier such as the Git checkout's current branch. */
  note?: string
}

export interface WorktreeOptionProps {
  kind: 'jj' | 'git'
  /** Localized label for the checkbox, `t('jj')` or `t('git')`. */
  label: string
  menuLabel: string
  requested: boolean
  /** The stock request can be created from here (no VCS/permission blocker). */
  usable: boolean
  /** Creation is running or the request itself is in flight. */
  disabled: boolean
  baseText: string
  hint: string
  choices: WorktreeChoice[]
  selected: string
  error: string
  onCheckedChange(checked: boolean): void
  onPick(value: string): void
}

/** Geometry of the stock Forge worktree option, on DSH theme tokens. */
const controlClass = cn(
  'dshx:inline-flex dshx:h-7 dshx:min-w-0 dshx:items-center dshx:gap-1.5 dshx:whitespace-nowrap',
  'dshx:rounded-[var(--dsw-radius-sm)] dshx:border-0 dshx:bg-transparent dshx:px-2',
  'dshx:text-[13px] dshx:font-medium dshx:leading-5 dshx:text-fg-secondary',
  'dshx:max-w-[min(200px,45vw)] dshx:hover:bg-surface-hover dshx:disabled:cursor-default dshx:disabled:text-fg-dimmed',
  'dshx:focus-visible:outline-2 dshx:focus-visible:outline-offset-2 dshx:focus-visible:outline-brand',
  'dshx:max-[600px]:max-w-[120px] dshx:pointer-coarse:min-h-11',
)

function optionLabel(choice: WorktreeChoice): ReactNode {
  if (choice.note === undefined) {
    return <span className="dshx:min-w-0 dshx:truncate dshx:font-code dshx:text-xs">{choice.label}</span>
  }
  return (
    <span className="dshx:inline-flex dshx:min-w-0 dshx:items-baseline dshx:gap-2">
      <span className="dshx:min-w-0 dshx:truncate dshx:font-code dshx:text-xs">{choice.label}</span>
      <span className="dshx:shrink-0 dshx:text-xs dshx:text-fg-tertiary">{choice.note}</span>
    </span>
  )
}

/**
 * The new-session worktree option, following the stock Forge control: the
 * current base (or the base menu once requested), then the checkbox that
 * requests or withdraws it. The menu and the tooltips are host primitives, so
 * their card, rows, and keyboard behavior are the ones the stock UI uses.
 *
 * The menu stays in the slot subtree instead of portaling to the body. It opens
 * on the side with room and caps its height, because the hero row sits inside
 * the conversation scroll container: an in-place card that runs past the
 * scrollport would be clipped. The long list scrolls inside the stock viewport.
 */
export function WorktreeOption({
  kind,
  label,
  menuLabel,
  requested,
  usable,
  disabled,
  baseText,
  hint,
  choices,
  selected,
  error,
  onCheckedChange,
  onPick,
}: WorktreeOptionProps) {
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState<'top' | 'bottom'>('top')
  const menu = requested && usable

  // Withdrawing (or the stock stream clearing the request) unmounts the list;
  // a later request must start closed rather than reuse stale open state.
  useEffect(() => {
    if (!menu) setOpen(false)
  }, [menu])

  // The stock menu portals and flips to fit the viewport. This one stays in the
  // slot subtree, so choose the side with room instead of clipping the card
  // above or below the conversation scroll container.
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    if (open) {
      setOpen(false)
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    setSide(rect.top >= window.innerHeight - rect.bottom ? 'top' : 'bottom')
    setOpen(true)
  }

  const items: MenuEntry[] = [
    { type: 'label', id: 'base', text: menuLabel },
    ...choices.map((choice) => ({ id: choice.value, label: optionLabel(choice) })),
  ]

  return (
    <Root className="dshx:inline-flex dshx:min-w-0 dshx:flex-none dshx:items-center dshx:gap-0.5 dshx:max-[600px]:flex-col dshx:max-[600px]:items-end dshx:max-[600px]:gap-0">
      <span data-jj-workspace-toggle="" data-vcs={kind} className="dshx:contents">
        {menu ? (
          <Menu
            open={open}
            items={items}
            selectedId={selected}
            onSelect={(id) => {
              setOpen(false)
              // Re-submitting the same base is meaningful: the stock Remote
              // forgets a failed attempt, records the request, and rechecks it.
              onPick(id)
            }}
            onClose={() => setOpen(false)}
            side={side}
            align="end"
            listClassName={cn(
              'dshx:max-h-[min(320px,40vh)]!',
              // Host rows are 34px; a coarse pointer needs a 44px target.
              'dshx:[&_button]:pointer-coarse:min-h-11!',
            )}
            anchor={
              <button
                type="button"
                className={cn(controlClass, 'dshx:gap-1 dshx:pr-1')}
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={disabled}
                onClick={toggle}
              >
                <span className="dshx:min-w-0 dshx:truncate">{baseText}</span>
                <IconChevronDownOutlineRegular
                  size={12}
                  className={cn(
                    'dshx:shrink-0 dshx:text-fg-tertiary dshx:transition-transform dshx:duration-150',
                    open && 'dshx:rotate-180',
                  )}
                />
              </button>
            }
          />
        ) : (
          <Tooltip label={baseText} side="bottom" openOnClick>
            <button type="button" className={controlClass} aria-label={baseText}>
              <IconBranchOutlineRegular size={14} className="dshx:shrink-0" />
              <span className="dshx:min-w-0 dshx:truncate">{baseText}</span>
            </button>
          </Tooltip>
        )}
        <Tooltip label={hint} side="bottom" delayMs={500}>
          <label
            className={cn(
              'dshx:inline-flex dshx:h-7 dshx:shrink-0 dshx:cursor-pointer dshx:select-none dshx:items-center dshx:gap-1.5',
              'dshx:rounded-[var(--dsw-radius-sm)] dshx:px-2 dshx:text-[13px] dshx:font-medium dshx:leading-5 dshx:whitespace-nowrap',
              'dshx:text-fg-secondary dshx:hover:bg-surface-hover dshx:pointer-coarse:min-h-11',
              'dshx:data-[disabled]:cursor-default dshx:data-[disabled]:text-fg-dimmed',
              'dshx:has-[input:focus-visible]:outline-2 dshx:has-[input:focus-visible]:outline-offset-2 dshx:has-[input:focus-visible]:outline-brand',
            )}
            data-disabled={disabled ? '' : undefined}
          >
            <input
              type="checkbox"
              className="dshx:m-0 dshx:size-[14px] dshx:shrink-0 dshx:cursor-[inherit] dshx:accent-brand dshx:focus-visible:outline-none"
              checked={requested}
              disabled={disabled}
              onChange={(event) => {
                onCheckedChange(event.currentTarget.checked)
              }}
            />
            <span>{label}</span>
          </label>
        </Tooltip>
        {error ? (
          <span
            role="alert"
            title={error}
            className="dshx:max-w-[min(200px,40vw)] dshx:truncate dshx:text-xs dshx:font-normal dshx:text-danger"
          >
            {error}
          </span>
        ) : null}
      </span>
    </Root>
  )
}
