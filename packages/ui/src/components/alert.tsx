import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const alertVariants = cva('dshx:rounded-control dshx:border dshx:px-3 dshx:py-2 dshx:text-xs', {
  variants: {
    variant: {
      info: 'dshx:border-border dshx:bg-surface dshx:text-fg-secondary',
      success: 'dshx:border-ok/30 dshx:bg-ok/5 dshx:text-ok',
      warn: 'dshx:border-warn/30 dshx:bg-warn/5 dshx:text-warn',
      error: 'dshx:border-danger/30 dshx:bg-danger/5 dshx:text-danger',
    },
  },
  defaultVariants: { variant: 'info' },
})

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {}

/** Inline status/error notice; errors assertively announce to screen readers. */
export function Alert({ className, variant, role, ...props }: AlertProps) {
  return (
    <div
      role={role ?? (variant === 'error' ? 'alert' : 'status')}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}
