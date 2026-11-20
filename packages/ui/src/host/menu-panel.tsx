import {
  forwardRef,
  useId,
  useLayoutEffect,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { MenuSurface, type MenuSurfaceProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { cn } from '../lib/cn'
import './menu-panel.css'

export interface MenuPanelProps extends Omit<MenuSurfaceProps, 'children' | 'style'> {
  anchor: RefObject<HTMLElement | null>
  header?: ReactNode
  children: ReactNode
  footer?: ReactNode
  style?: CSSProperties
}

export const MenuPanel = forwardRef<HTMLDivElement, MenuPanelProps>(function MenuPanel(
  { anchor, header, children, footer, className, style, ...surface },
  ref,
) {
  const anchorName = `--dshx-menu-${useId().replaceAll(':', '')}`
  useLayoutEffect(() => {
    const element = anchor.current
    if (element === null) return undefined
    const previous = element.style.getPropertyValue('anchor-name')
    const priority = element.style.getPropertyPriority('anchor-name')
    element.style.setProperty('anchor-name', anchorName)
    return () => {
      element.style.setProperty('anchor-name', previous, priority)
    }
  }, [anchor, anchorName])

  return (
    <MenuSurface
      {...surface}
      ref={ref}
      className={cn('dshx-menu-panel', className)}
      style={{ ...style, positionAnchor: anchorName }}
    >
      {header === undefined ? null : <div className="dshx-menu-panel-header">{header}</div>}
      <div className="dshx-menu-panel-viewport" role="presentation">
        {children}
      </div>
      {footer === undefined ? null : <div className="dshx-menu-panel-footer">{footer}</div>}
    </MenuSurface>
  )
})
