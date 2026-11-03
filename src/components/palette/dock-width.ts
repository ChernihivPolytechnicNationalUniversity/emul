import type { WidthClass } from "@/hooks/use-size-class"

// The docked palette's width in px, dragged by its edge and kept in this browser. Narrower than the
// minimum it folds to a column of group icons; a wide screen lets it grow far enough for tiles.

export const DOCK = { min: 224, initial: 288, max: { expanded: 336, large: 384, xl: 448 } as Partial<Record<WidthClass, number>> } as const
/** A drag this far under the minimum folds the palette to its icon column. */
export const FOLD_BELOW = 160

const KEY = "emul.palette.width"

export const clampWidth = (px: number, width: WidthClass) => Math.round(Math.min(DOCK.max[width] ?? DOCK.max.large ?? DOCK.initial, Math.max(DOCK.min, px)))

export function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY))
    return Number.isFinite(n) && n > 0 ? n : DOCK.initial
  } catch {
    return DOCK.initial
  }
}

export function saveWidth(px: number) {
  try {
    localStorage.setItem(KEY, String(Math.round(px)))
  } catch {
    // Storage off: the width holds until the page reloads.
  }
}

const FOLDED_KEY = "emul.palette.folded"

export function savedFolded(): boolean {
  try {
    return localStorage.getItem(FOLDED_KEY) === "1"
  } catch {
    return false
  }
}

export function saveFolded(folded: boolean) {
  try {
    localStorage.setItem(FOLDED_KEY, folded ? "1" : "0")
  } catch {
    // Storage off: the fold holds until the page reloads.
  }
}

/** The width of the folded palette's icon column, px. */
export const RAIL_PX = 56

/** "/" on a tablet: the icon column opens its search. */
export const PALETTE_SEARCH_EVENT = "emul:palette-search"
