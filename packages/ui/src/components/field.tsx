import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

export interface FieldProps {
  label?: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  className?: string
}

/** Label + control + hint/error stack used by forms and settings sections. */
export function Field({ label, htmlFor, hint, error, children, className }: FieldProps) {
  return (
    <div className={cn('dshx:flex dshx:flex-col dshx:gap-1.5', className)}>
      {label ? (
        htmlFor ? (
          <label htmlFor={htmlFor} className="dshx:text-xs dshx:font-medium dshx:text-fg">
            {label}
          </label>
        ) : (
          <span className="dshx:text-xs dshx:font-medium dshx:text-fg">{label}</span>
        )
      ) : null}
      {children}
      {hint ? <p className="dshx:text-2xs dshx:text-fg-muted">{hint}</p> : null}
      {error ? (
        <p role="alert" className="dshx:text-2xs dshx:text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
