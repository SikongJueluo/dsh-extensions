import { cn } from '../lib/cn'

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'dshx:inline-block dshx:size-3.5 dshx:animate-spin dshx:rounded-full',
        'dshx:border dshx:border-border-strong dshx:border-t-brand',
        className,
      )}
    />
  )
}
