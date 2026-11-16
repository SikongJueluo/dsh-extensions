import * as React from 'react'
import { cn } from '../lib/cn'

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="dshx:w-full dshx:overflow-x-auto">
      <table
        className={cn('dshx:w-full dshx:border-collapse dshx:text-xs dshx:text-fg', className)}
        {...props}
      />
    </div>
  )
}

export function TableHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('dshx:text-fg-muted', className)} {...props} />
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('dshx:border-b dshx:border-border', className)} {...props} />
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'dshx:px-2 dshx:py-1.5 dshx:text-left dshx:text-2xs dshx:font-medium',
        className,
      )}
      {...props}
    />
  )
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('dshx:px-2 dshx:py-1.5 dshx:align-top', className)} {...props} />
}
