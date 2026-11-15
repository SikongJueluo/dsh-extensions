import * as React from 'react'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { cn } from '../lib/cn'

export interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  footer?: React.ReactNode
  closeLabel?: string
  className?: string
}

/**
 * Modal dialog on Base UI. Focus trapping, Escape, and focus return are Base
 * UI's contract; the portal targets a container inside the slot subtree so the
 * popup keeps the host's theme variables and never becomes a second app root.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel = 'Close',
  className,
}: DialogProps) {
  const [container, setContainer] = React.useState<HTMLDivElement | null>(null)

  return (
    <div ref={setContainer}>
      <BaseDialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
        {container ? (
          <BaseDialog.Portal container={container}>
            <BaseDialog.Backdrop
              className={cn(
                'dshx:pointer-events-auto dshx:fixed dshx:inset-0 dshx:z-[60] dshx:bg-black/45',
                'dshx:transition-opacity dshx:duration-150',
                'dshx:data-[starting-style]:opacity-0 dshx:data-[ending-style]:opacity-0',
              )}
            />
            <BaseDialog.Popup
              className={cn(
                'dshx:pointer-events-auto dshx:fixed dshx:left-1/2 dshx:top-1/2 dshx:z-[61] dshx:flex dshx:max-h-[86vh] dshx:w-[min(640px,94vw)]',
                'dshx:-translate-x-1/2 dshx:-translate-y-1/2 dshx:flex-col dshx:overflow-hidden',
                'dshx:rounded-card dshx:border dshx:border-border-strong dshx:bg-surface dshx:text-fg',
                'dshx:shadow-2xl dshx:outline-none',
                'dshx:transition-[opacity,scale] dshx:duration-150',
                'dshx:data-[starting-style]:scale-95 dshx:data-[starting-style]:opacity-0',
                'dshx:data-[ending-style]:scale-95 dshx:data-[ending-style]:opacity-0',
                className,
              )}
            >
              <div className="dshx:flex dshx:items-start dshx:justify-between dshx:gap-3 dshx:border-b dshx:border-border dshx:px-5 dshx:py-3.5">
                <div className="dshx:flex dshx:min-w-0 dshx:flex-col dshx:gap-0.5">
                  <BaseDialog.Title className="dshx:text-base dshx:font-semibold dshx:text-fg">
                    {title}
                  </BaseDialog.Title>
                  {description ? (
                    <BaseDialog.Description className="dshx:text-2xs dshx:text-fg-muted">
                      {description}
                    </BaseDialog.Description>
                  ) : null}
                </div>
                <BaseDialog.Close
                  aria-label={closeLabel}
                  className={cn(
                    'dshx:-mr-1.5 dshx:inline-flex dshx:size-8 dshx:shrink-0 dshx:items-center dshx:justify-center',
                    'dshx:rounded-control dshx:text-fg-muted dshx:hover:bg-surface-2 dshx:hover:text-fg',
                    'dshx:pointer-coarse:size-11',
                  )}
                >
                  <X className="dshx:size-4" />
                </BaseDialog.Close>
              </div>
              {children ? (
                <div className="dshx:min-h-0 dshx:flex-1 dshx:overflow-y-auto dshx:px-5 dshx:py-4">
                  {children}
                </div>
              ) : null}
              {footer ? (
                <div className="dshx:flex dshx:flex-wrap dshx:items-center dshx:justify-end dshx:gap-2 dshx:border-t dshx:border-border dshx:px-5 dshx:py-3">
                  {footer}
                </div>
              ) : null}
            </BaseDialog.Popup>
          </BaseDialog.Portal>
        ) : null}
      </BaseDialog.Root>
    </div>
  )
}
