import { getMeta } from "@/schematic/registry"
import { searchRows, type PaletteEntry } from "./items"

// Quick Insert: the palette's search opened where the student is working, not at the edge of the
// screen. "A" with the pointer on the field, Ctrl+K (⌘K) from anywhere but the code, or "Add here…"
// in the field's menu open it; the part picked goes where it was opened. It is the same search and
// the same rows as the palette's, so a query finds the same parts in the same order in both places.

/** The keys of a keyboard event this module reads; a plain object in tests. */
export type KeyLike = { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }

/** Where the key was typed: on the bench (or a button), in a text field, in the code editor. */
export type KeyTarget = "field" | "text" | "code"

/**
 * Whether this key opens Quick Insert. "A" is a letter like any other in a text field, so it opens
 * the panel only from the bench; Ctrl+K types nothing, so it opens it from a text field too. The code
 * editor keeps both: Ctrl+K starts its own chords there.
 */
export function opensQuickInsert(e: KeyLike, target: KeyTarget): boolean {
  if (target === "code" || e.altKey || e.shiftKey) return false
  const mod = !!(e.ctrlKey || e.metaKey)
  const key = e.key.toLowerCase()
  if (mod) return key === "k"
  return key === "a" && target === "field"
}

/** A run of rows under a heading, for a blank query: the parts a student keeps reaching for. */
export type QuickSection = { label: string; entries: PaletteEntry[] }

/** How many recent parts a blank query lists, after the favourites. */
export const QUICK_RECENT = 6

const entryOf = (id: string): PaletteEntry | undefined => {
  const def = getMeta(id)
  return def && { key: id, name: def.name, def }
}

/** For a blank query: favourites, then recent parts that are not favourites; each part once. */
export function quickSections(recent: readonly string[], favourites: readonly string[]): QuickSection[] {
  const starred = new Set(favourites)
  const sections: QuickSection[] = [
    { label: "Favourites", entries: favourites.flatMap((id) => entryOf(id) ?? []) },
    { label: "Recent", entries: recent.filter((id) => !starred.has(id)).flatMap((id) => entryOf(id) ?? []).slice(0, QUICK_RECENT) },
  ]
  return sections.filter((s) => s.entries.length > 0)
}

/** The rows the arrow keys walk and Enter places, in the order they are shown. */
export function pickableRows(query: string, recent: readonly string[], favourites: readonly string[]): PaletteEntry[] {
  return query.trim() ? searchRows(query).pickable : quickSections(recent, favourites).flatMap((s) => s.entries)
}

export type QuickState = { query: string; selected: number }

export const QUICK_START: QuickState = { query: "", selected: 0 }

/** What a key in the panel's box does: move the selection, place a part, clear the query, close. */
export type QuickOutcome =
  | { kind: "state"; state: QuickState }
  | { kind: "place"; entry: PaletteEntry; keepOpen: boolean; state: QuickState }
  | { kind: "close" }
  /** Not the panel's key: the box types it as usual. */
  | { kind: "pass" }

/** Rows PageUp and PageDown move by: about what the panel shows at once. */
const PAGE = 8

/** A new query: the selection goes back to its best match. */
export const typed = (query: string): QuickState => ({ query, selected: 0 })

/**
 * One key in the panel's search box. The arrows wrap round the rows; Enter places the selected part
 * and closes, Shift+Enter places it and stays open for the next; Escape clears a query, then closes.
 */
export function quickKey(state: QuickState, e: KeyLike, rows: readonly PaletteEntry[]): QuickOutcome {
  const n = rows.length
  // The selection stays on a row while the rows change under it (results arriving a frame late).
  const at = n ? Math.min(state.selected, n - 1) : 0
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
      if (!n) return { kind: "state", state }
      return { kind: "state", state: { ...state, selected: (at + (e.key === "ArrowDown" ? 1 : n - 1)) % n } }
    case "PageDown":
    case "PageUp":
      if (!n) return { kind: "state", state }
      return { kind: "state", state: { ...state, selected: e.key === "PageDown" ? Math.min(n - 1, at + PAGE) : Math.max(0, at - PAGE) } }
    case "Enter":
      if (!n || e.ctrlKey || e.metaKey || e.altKey) return { kind: "pass" }
      return { kind: "place", entry: rows[at]!, keepOpen: !!e.shiftKey, state: { ...state, selected: at } }
    case "Escape":
      return state.query ? { kind: "state", state: QUICK_START } : { kind: "close" }
    default:
      return { kind: "pass" }
  }
}

export type Rect = { left: number; top: number; right: number; bottom: number }
export type Size = { width: number; height: number }

/** Clear space between the point a part goes and the panel, px: the part's ghost shows beside it. */
export const PANEL_GAP = 20
/** How far the panel keeps from the bench's edges, px. */
export const PANEL_MARGIN = 8

/**
 * Where the panel stands for a part going at `at` (screen px): to its right with its top a little
 * above it, so the ghost at the point stays in sight; to its left when the right has no room; then
 * pushed inside the bench. A panel taller than the bench starts at its top.
 */
export function panelPosition(at: { x: number; y: number }, panel: Size, bounds: Rect): { left: number; top: number } {
  const minX = bounds.left + PANEL_MARGIN
  const maxX = bounds.right - PANEL_MARGIN - panel.width
  const right = at.x + PANEL_GAP
  const left = at.x - PANEL_GAP - panel.width
  const x = right <= maxX ? right : left >= minX ? left : Math.max(minX, Math.min(maxX, right))
  const minY = bounds.top + PANEL_MARGIN
  const maxY = bounds.bottom - PANEL_MARGIN - panel.height
  const y = Math.max(minY, Math.min(maxY, at.y - PANEL_GAP))
  return { left: Math.round(x), top: Math.round(y) }
}
