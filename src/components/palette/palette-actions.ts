import * as React from "react"
import type { ComponentDef } from "@/schematic/types"

/** What every row of the palette does, shared rather than threaded through each list. */
export type PaletteActions = {
  /** A pointer click takes the part in hand; Enter or Space on a focused row places it at once. */
  activate: (def: ComponentDef, e: React.MouseEvent) => void
  /** Take this part in hand (a drag starting), or put whatever is in hand back (a drag let go off the field). */
  take: (def: ComponentDef | null) => void
  armed: string | null
  favourites: ReadonlySet<string>
}

export const Actions = React.createContext<PaletteActions>({ activate: () => {}, take: () => {}, armed: null, favourites: new Set() })
export const usePaletteActions = () => React.useContext(Actions)

/**
 * A part dragged out of the palette with a mouse or pen. Pointer events, not the browser's drag and
 * drop: the part is simply in hand while the button is down (the field draws its ghost), and the
 * field places it where the button comes up. A finger taps instead: on a touch screen a drag in
 * the palette scrolls it.
 */
export const paletteDrag = { active: false }

/** How far the pointer moves before a press on a row is a drag, px. */
const DRAG_SLOP = 6
let swallowClick = false

/** Whether the click that ends a drag should be ignored (it would put the part straight back). */
export const clickEndsDrag = () => swallowClick

export function useDragOut(def: ComponentDef) {
  const { take } = usePaletteActions()
  return {
    draggable: false,
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch") return
      const from = { x: e.clientX, y: e.clientY }
      const move = (ev: PointerEvent) => {
        if (paletteDrag.active || Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_SLOP) return
        paletteDrag.active = true
        document.documentElement.dataset.paletteDrag = ""
        take(def)
      }
      const up = () => {
        window.removeEventListener("pointermove", move)
        window.removeEventListener("pointerup", up)
        window.removeEventListener("pointercancel", up)
        if (!paletteDrag.active) return
        // The field, under the pointer, has placed the part by now; let go anywhere else, it goes back.
        paletteDrag.active = false
        delete document.documentElement.dataset.paletteDrag
        take(null)
        swallowClick = true
        setTimeout(() => (swallowClick = false))
      }
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", up)
      window.addEventListener("pointercancel", up)
    },
  }
}
