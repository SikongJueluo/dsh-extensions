import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { cn } from '../lib/cn'

export interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  name?: string
  'aria-label'?: string
  className?: string
}

/** Base UI switch; label/touch target comes from the surrounding row. */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  id,
  name,
  'aria-label': ariaLabel,
  className,
}: SwitchProps) {
  return (
    <BaseSwitch.Root
      id={id}
      name={name}
      aria-label={ariaLabel}
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      className={cn(
        'dshx:group dshx:relative dshx:inline-flex dshx:h-[22px] dshx:w-10 dshx:shrink-0 dshx:items-center',
        'dshx:rounded-full dshx:border dshx:border-border-strong dshx:bg-surface-2 dshx:transition-colors',
        'dshx:data-[checked]:border-brand dshx:data-[checked]:bg-brand dshx:disabled:opacity-50',
        'dshx:pointer-coarse:h-7 dshx:pointer-coarse:w-12',
        className,
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'dshx:block dshx:size-4 dshx:translate-x-[3px] dshx:rounded-full dshx:bg-bg dshx:transition-transform',
          'dshx:group-data-[checked]:translate-x-[21px]',
          'dshx:pointer-coarse:translate-x-[4px] dshx:pointer-coarse:group-data-[checked]:translate-x-[27px]',
        )}
      />
    </BaseSwitch.Root>
  )
}
