import * as React from "react"

const MOBILE_BREAKPOINT = 768
/** The menu bar's height on a phone, where its menus are tapped. */
export const MENU_H_TOUCH = 40
/** On a phone a side panel (code, HDL) covers the field below the menu bar instead of docking beside it. */
export const MOBILE_PANEL = "fixed inset-x-0 top-10 bottom-0 z-40 border-l-0"
/**
 * Between the phone and a wide screen (a tablet, a laptop window under 1280 px) a side panel beside the palette
 * would leave the field no width at all: it slides over the field from the right instead.
 */
export const NARROW_PANEL = "max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:z-30 max-xl:max-w-full max-xl:shadow-lg"
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile() {
  return React.useSyncExternalStore(
    subscribe,
    () => window.innerWidth < MOBILE_BREAKPOINT,
    () => false,
  )
}
