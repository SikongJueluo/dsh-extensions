import * as React from 'react'
import { cn } from '../lib/cn'

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('dshx:rounded-card dshx:border dshx:border-border dshx:bg-surface', className)}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('dshx:flex dshx:flex-col dshx:gap-1 dshx:p-4', className)} {...props} />
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        'dshx:text-base dshx:font-semibold dshx:leading-[22px] dshx:text-fg',
        className,
      )}
      {...props}
    />
  )
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('dshx:text-xs dshx:text-fg-muted', className)} {...props} />
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('dshx:p-4 dshx:pt-0', className)} {...props} />
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'dshx:flex dshx:flex-wrap dshx:items-center dshx:gap-2 dshx:p-4 dshx:pt-0',
        className,
      )}
      {...props}
    />
  )
}
