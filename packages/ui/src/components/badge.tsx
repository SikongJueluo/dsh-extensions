import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const badgeVariants = cva(
  'dshx:inline-flex dshx:items-center dshx:gap-1 dshx:rounded-full dshx:px-1.5 dshx:text-2xs dshx:font-medium dshx:leading-4 dshx:whitespace-nowrap',
  {
    variants: {
      variant: {
        neutral: 'dshx:bg-surface-2 dshx:text-fg-secondary',
        brand: 'dshx:bg-brand/15 dshx:text-brand',
        success: 'dshx:bg-ok/15 dshx:text-ok',
        warn: 'dshx:bg-warn/15 dshx:text-warn',
        danger: 'dshx:bg-danger/15 dshx:text-danger',
        outline: 'dshx:border dshx:border-border-strong dshx:text-fg-secondary',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
