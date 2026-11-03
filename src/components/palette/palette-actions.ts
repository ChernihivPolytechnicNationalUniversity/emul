import * as React from "react"
import { PALETTE_DRAG_TYPE } from "@/schematic/registry"
import type { ComponentDef } from "@/schematic/types"

/** What every row of the palette does, shared rather than threaded through each list. */
export type PaletteActions = {
  /** A pointer click takes the part in hand; Enter or Space on a focused row places it at once. */
  activate: (def: ComponentDef, e: React.MouseEvent) => void
  armed: string | null
  favourites: ReadonlySet<string>
}

export const Actions = React.createContext<PaletteActions>({ activate: () => {}, armed: null, favourites: new Set() })
export const usePaletteActions = () => React.useContext(Actions)

export const startDrag = (e: React.DragEvent, def: ComponentDef) => {
  e.dataTransfer.setData(PALETTE_DRAG_TYPE, def.id)
  e.dataTransfer.effectAllowed = "copy"
}
