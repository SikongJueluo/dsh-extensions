import * as React from 'react'
import { cn } from '../lib/cn'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'dshx:h-8 dshx:w-full dshx:min-w-0 dshx:rounded-control dshx:border dshx:border-border',
        'dshx:bg-surface-2 dshx:px-2.5 dshx:text-xs dshx:text-fg dshx:hover:bg-brand/5',
        'dshx:placeholder:text-fg-muted dshx:focus-visible:border-brand',
        'dshx:disabled:opacity-50 dshx:pointer-coarse:min-h-11',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'dshx:min-h-20 dshx:w-full dshx:resize-y dshx:rounded-control dshx:border dshx:border-border',
        'dshx:bg-surface-2 dshx:px-2.5 dshx:py-2 dshx:text-xs dshx:leading-[18px] dshx:text-fg dshx:hover:bg-brand/5',
        'dshx:placeholder:text-fg-muted dshx:focus-visible:border-brand dshx:disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'
