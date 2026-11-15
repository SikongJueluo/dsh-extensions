import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

export const buttonVariants = cva(
  [
    'dshx:inline-flex dshx:items-center dshx:justify-center dshx:gap-1.5 dshx:whitespace-nowrap',
    'dshx:rounded-control dshx:font-medium dshx:transition-colors dshx:select-none',
    'dshx:focus-visible:outline-2 dshx:focus-visible:outline-offset-1 dshx:focus-visible:outline-brand',
    'dshx:disabled:pointer-events-none dshx:disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        default: 'dshx:bg-brand dshx:text-on-brand dshx:hover:opacity-90',
        secondary:
          'dshx:border dshx:border-border dshx:bg-surface-2 dshx:text-fg dshx:hover:bg-brand/10',
        ghost: 'dshx:text-fg-secondary dshx:hover:bg-surface-2 dshx:hover:text-fg',
        danger:
          'dshx:border dshx:border-danger/40 dshx:text-danger dshx:hover:bg-danger/10',
        link: 'dshx:text-brand dshx:underline-offset-4 dshx:hover:underline',
      },
      size: {
        sm: 'dshx:h-7 dshx:px-2.5 dshx:text-xs dshx:pointer-coarse:min-h-11',
        md: 'dshx:h-8 dshx:px-3 dshx:text-xs dshx:pointer-coarse:min-h-11',
        icon: 'dshx:size-8 dshx:pointer-coarse:size-11',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
