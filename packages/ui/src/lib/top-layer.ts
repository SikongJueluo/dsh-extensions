import { useEffect, useRef, type RefObject } from 'react'

/** Whether this browser can promote an element into the top layer. */
function supportsTopLayer(): boolean {
  return typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype
}

const ANCHOR_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  inset: 'auto',
  left: '0',
  top: '0',
  width: '0',
  height: '0',
  margin: '0',
  padding: '0',
  borderWidth: '0',
  backgroundColor: 'transparent',
  backgroundImage: 'none',
  boxShadow: 'none',
  overflow: 'visible',
}

/**
 * Keep one portal anchor in the browser top layer while `active`, so the popup it hosts paints
 * above every stacking context and escapes ancestor `transform`, `filter`, `contain` and
 * `overflow`; the UA popover styles are reset to an invisible zero-size box.
 * @param ref - the portal anchor element.
 * @param active - whether the popup it hosts is open.
 */
export function useTopLayer(ref: RefObject<HTMLElement | null>, active: boolean): void {
  const shown = useRef(false)

  useEffect(() => {
    const element = ref.current
    if (element === null || !supportsTopLayer()) return undefined
    Object.assign(element.style, ANCHOR_STYLE)
    element.setAttribute('popover', 'manual')
    const promote = (): void => {
      if (shown.current || !element.isConnected) return
      element.showPopover()
      shown.current = true
    }
    const release = (): void => {
      if (!shown.current) return
      element.hidePopover()
      shown.current = false
    }
    if (active) promote()
    else release()
    return release
  }, [ref, active])
}
