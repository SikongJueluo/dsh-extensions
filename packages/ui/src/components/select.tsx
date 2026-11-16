import * as React from 'react'
import { Select as BaseSelect } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'

export interface SelectOption {
  value: string
  label: React.ReactNode
  disabled?: boolean
}

export interface SelectGroup {
  label: React.ReactNode
  options: SelectOption[]
}

export interface SelectProps {
  value: string
  onValueChange: (value: string) => void
  options?: SelectOption[]
  groups?: SelectGroup[]
  placeholder?: string
  disabled?: boolean
  id?: string
  name?: string
  className?: string
  'aria-label'?: string
  /** `ghost` is the DSH inline selector: transparent, borderless, compact. */
  variant?: 'default' | 'ghost'
  /** Which trigger edge the popup follows; inline controls at the right use `end`. */
  align?: 'start' | 'end' | 'center'
}

/**
 * Base UI select styled as the shadcn trigger/popup pair. The popup portals
 * into a container inside this component's own subtree, not into `document.body`,
 * so it inherits the host theme and stays inside the slot's DOM ownership.
 */
export function Select({
  value,
  onValueChange,
  options = [],
  groups,
  placeholder,
  disabled,
  id,
  name,
  className,
  'aria-label': ariaLabel,
  variant = 'default',
  align = 'start',
}: SelectProps) {
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null)
  const flat = groups ? groups.flatMap((group) => group.options) : options

  const renderItem = (option: SelectOption) => (
    <BaseSelect.Item
      key={option.value}
      value={option.value}
      disabled={option.disabled}
      className={cn(
        'dshx:grid dshx:cursor-default dshx:grid-cols-[1rem_1fr] dshx:items-center dshx:gap-1.5',
        'dshx:min-h-[34px] dshx:rounded-[6px] dshx:px-2 dshx:py-1.5 dshx:text-sm dshx:text-fg dshx:select-none',
        'dshx:hover:bg-brand/10 dshx:data-[highlighted]:bg-brand/10 dshx:data-[disabled]:opacity-50',
        'dshx:pointer-coarse:min-h-11',
      )}
    >
      <BaseSelect.ItemIndicator className="dshx:col-start-1 dshx:flex">
        <Check className="dshx:size-3.5" />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className="dshx:col-start-2">{option.label}</BaseSelect.ItemText>
    </BaseSelect.Item>
  )

  return (
    <div className={cn('dshx:relative', variant === 'ghost' && 'dshx:inline-flex', className)}>
      {/* A fixed, zero-size portal host keeps the popup out of the slot's
          layout and scrollable overflow; the positioner still uses viewport
          coordinates, so the popup cannot push the surrounding UI. */}
      <div ref={setContainer} className="dshx:fixed dshx:left-0 dshx:top-0 dshx:h-0 dshx:w-0" />
      <BaseSelect.Root
        value={value === '' ? null : value}
        onValueChange={(next) => onValueChange(next === null ? '' : String(next))}
        items={flat.map((option) => ({ label: option.label, value: option.value }))}
        disabled={disabled}
        name={name}
      >
        <BaseSelect.Trigger
          id={id}
          aria-label={ariaLabel}
          className={cn(
            'dshx:flex dshx:items-center dshx:justify-between',
            'dshx:text-sm dshx:text-fg dshx:focus-visible:border-brand',
            'dshx:data-[disabled]:opacity-50 dshx:pointer-coarse:min-h-11',
            variant === 'ghost'
              ? 'dshx:h-7 dshx:w-auto dshx:max-w-[360px] dshx:gap-1 dshx:rounded-[6px] dshx:border-0 dshx:bg-transparent dshx:pl-2 dshx:pr-1 dshx:text-fg-secondary dshx:hover:bg-brand/10 dshx:hover:text-fg'
              : 'dshx:h-8 dshx:w-full dshx:gap-2 dshx:rounded-control dshx:border dshx:border-border dshx:bg-surface-2 dshx:px-2.5 dshx:hover:bg-brand/5',
          )}
        >
          <BaseSelect.Value
            placeholder={placeholder}
            className="dshx:min-w-0 dshx:truncate dshx:text-left"
          />
          <BaseSelect.Icon className="dshx:shrink-0 dshx:text-fg-muted">
            <ChevronDown className="dshx:size-3.5" />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        {container ? (
          <BaseSelect.Portal container={container}>
            <BaseSelect.Positioner
              sideOffset={4}
              align={align}
              alignItemWithTrigger={false}
              collisionPadding={8}
              className="dshx:z-[70] dshx:outline-none"
            >
              <BaseSelect.Popup
                className={cn(
                  'dshx:max-h-[min(360px,calc(100vh-96px))] dshx:w-max dshx:min-w-[min(240px,calc(100vw-32px))] dshx:max-w-[min(420px,calc(100vw-32px))] dshx:overflow-y-auto',
                  'dshx:rounded-[10px] dshx:border dshx:border-border dshx:bg-surface-2 dshx:p-1 dshx:shadow-xl',
                  'dshx:text-fg dshx:shadow-lg dshx:outline-none',
                )}
              >
                {groups
                  ? groups.map((group, index) => (
                      <BaseSelect.Group key={index}>
                        <BaseSelect.GroupLabel className="dshx:px-2 dshx:py-1 dshx:text-2xs dshx:text-fg-muted">
                          {group.label}
                        </BaseSelect.GroupLabel>
                        {group.options.map(renderItem)}
                      </BaseSelect.Group>
                    ))
                  : options.map(renderItem)}
              </BaseSelect.Popup>
            </BaseSelect.Positioner>
          </BaseSelect.Portal>
        ) : null}
      </BaseSelect.Root>
    </div>
  )
}
