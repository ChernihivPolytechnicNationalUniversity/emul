import * as React from "react"

/**
 * The palette's one hover card: whichever part the mouse rests on for 300 ms. One card for the whole
 * palette, not one per row, so a list of thousands (drawn in a window) carries nothing extra.
 *
 * A line then runs round the card; when it closes, the card is held (as a strategy game's tooltips
 * are): the pointer can cross any other part on its way to the card's datasheet link without the
 * card moving to them. Until then the card follows the pointer from part to part. A held card moves
 * to another part the pointer stays on (600 ms), and goes when the pointer leaves it, leaves the
 * palette, or presses elsewhere.
 */
export type CardAnchor = { id: string; top: number; bottom: number; right: number; held: boolean }

/** How long the pointer rests on a part before its card opens. */
const SHOW_MS = 300
/** How long the line takes to run round the card before it is held. */
export const HOLD_MS = 900
/** A held card moves to another part when the pointer stays on that one this long: a pass across it on the way to the card is shorter. */
const HELD_SWITCH_MS = 600
const HIDE_MS = 300

let current: CardAnchor | null = null
let showTimer: ReturnType<typeof setTimeout> | undefined
let hideTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()

function set(next: CardAnchor | null) {
  current = next
  for (const l of listeners) l()
}

function anchorOf(id: string, el: Element): CardAnchor {
  const r = el.getBoundingClientRect()
  // The card stands beside the palette, not beside a tile in the middle of it.
  const panel = el.closest('[data-slot="sidebar-container"], [data-slot="sidebar"]')?.getBoundingClientRect()
  return { id, top: r.top, bottom: r.bottom, right: panel ? panel.right : r.right, held: false }
}

export function hoverPart(id: string, el: Element) {
  if (current?.held) {
    clearTimeout(showTimer)
    if (current.id !== id) showTimer = setTimeout(() => set(anchorOf(id, el)), HELD_SWITCH_MS)
    return
  }
  clearTimeout(hideTimer)
  clearTimeout(showTimer)
  if (current) return current.id === id ? undefined : set(anchorOf(id, el))
  showTimer = setTimeout(() => set(anchorOf(id, el)), SHOW_MS)
}

export function leavePart() {
  clearTimeout(showTimer)
  if (current?.held) return
  clearTimeout(hideTimer)
  if (current) hideTimer = setTimeout(() => set(null), HIDE_MS)
}

/** The line round the card closed: the card stays put until the pointer leaves it or the palette. */
export function holdCard() {
  if (current && !current.held) set({ ...current, held: true })
}

/** The pointer reached the card: it stays. */
export function keepCard() {
  clearTimeout(hideTimer)
  clearTimeout(showTimer)
}

/** The pointer left a held card, or left the palette with the card held: it goes after a moment. */
export function releaseCard() {
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => set(null), HIDE_MS)
}

/** A press, a drag, a scroll: the card goes now. */
export function hideCard() {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  if (current) set(null)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export const useCardAnchor = () => React.useSyncExternalStore(subscribe, () => current, () => null)
