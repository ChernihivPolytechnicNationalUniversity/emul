import * as React from "react"

/**
 * The palette's one hover card: whichever row the mouse rests on for 300 ms. One card for the whole
 * palette, not one per row, so a list of thousands (drawn in a window) carries nothing extra. Moving
 * from row to row with the card open switches it at once; leaving gives the pointer a moment to
 * reach the card, which keeps itself open while under it.
 */
export type CardAnchor = { id: string; top: number; bottom: number; right: number }

const SHOW_MS = 300
const HIDE_MS = 150

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
  return { id, top: r.top, bottom: r.bottom, right: panel ? panel.right : r.right }
}

export function hoverPart(id: string, el: Element) {
  clearTimeout(hideTimer)
  clearTimeout(showTimer)
  if (current) return set(anchorOf(id, el))
  showTimer = setTimeout(() => set(anchorOf(id, el)), SHOW_MS)
}

export function leavePart() {
  clearTimeout(showTimer)
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => set(null), HIDE_MS)
}

/** The pointer reached the card: it stays. */
export function keepCard() {
  clearTimeout(hideTimer)
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
