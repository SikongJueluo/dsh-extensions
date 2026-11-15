import type { ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * Scoped styling root. Every slot component that renders host DOM wraps its
 * content in one `Root`: the prefixed utilities and the local base rules apply
 * only below this element, so the host's global CSS is never touched.
 */
export function Root({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('dshx-root', className)}>{children}</div>
}
