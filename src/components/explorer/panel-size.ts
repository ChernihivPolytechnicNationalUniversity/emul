// The field explorer's size, dragged by its edges and kept in this browser: its width, and how much
// of its height the docked inspector takes under the list.

export const FIELD_WIDTH = { min: 240, initial: 288, max: 560 } as const
/** Dragged narrower than this, the panel folds to its floating button. */
export const FIELD_FOLD_BELOW = 180
/** The inspector's share of the panel's height. */
export const INSPECTOR_SHARE = { min: 0.15, initial: 0.45, max: 0.85 } as const

const WIDTH_KEY = "emul.field.width"
const SHARE_KEY = "emul.field.inspector"

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const clampFieldWidth = (px: number) => Math.round(clamp(px, FIELD_WIDTH.min, FIELD_WIDTH.max))
export const clampShare = (share: number) => clamp(share, INSPECTOR_SHARE.min, INSPECTOR_SHARE.max)

function read(key: string, fallback: number, fix: (n: number) => number): number {
  try {
    const n = Number(localStorage.getItem(key))
    return localStorage.getItem(key) !== null && Number.isFinite(n) ? fix(n) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Storage off: the size holds until the page reloads.
  }
}

export const savedFieldWidth = () => read(WIDTH_KEY, FIELD_WIDTH.initial, clampFieldWidth)
export const saveFieldWidth = (px: number) => write(WIDTH_KEY, clampFieldWidth(px))
export const savedShare = () => read(SHARE_KEY, INSPECTOR_SHARE.initial, clampShare)
export const saveShare = (share: number) => write(SHARE_KEY, Math.round(clampShare(share) * 1000) / 1000)
