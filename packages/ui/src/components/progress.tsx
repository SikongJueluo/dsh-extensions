/* oxlint-disable jsx-a11y/prefer-tag-over-role -- role is required by the Base UI primitive contract; swapping the element would change host styles */
import { cn } from '../lib/cn'

export interface ProgressProps {
  value: number | null
  tone?: 'brand' | 'warn' | 'danger'
  label?: string
  className?: string
}

const toneClass = {
  brand: 'dshx:bg-brand',
  warn: 'dshx:bg-warn',
  danger: 'dshx:bg-danger',
} as const

/** Quota/consumption bar with the host's progressbar semantics. */
export function Progress({ value, tone = 'brand', label, className }: ProgressProps) {
  const clamped = value === null ? 0 : Math.min(100, Math.max(0, value))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(clamped)}
      className={cn(
        'dshx:h-2 dshx:w-full dshx:overflow-hidden dshx:rounded-full dshx:bg-surface-2',
        className,
      )}
    >
      <div
        className={cn(
          'dshx:h-full dshx:rounded-full dshx:transition-[width] dshx:duration-300',
          value === null ? 'dshx:bg-transparent' : toneClass[tone],
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
