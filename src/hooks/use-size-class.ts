import * as React from "react"

/**
 * The window's size class, after Material's: width compact < 600 ≤ medium < 840 ≤ expanded < 1200 ≤
 * large < 1600 ≤ extra-large, and a short height under 480 (a phone on its side, a laptop at 200 %).
 * The structure of the screen follows the class; what a panel shows inside follows the panel's own
 * width (container queries), so a panel dragged wider shows more without a class changing.
 */
export type WidthClass = "compact" | "medium" | "expanded" | "large" | "xl"

export type SizeClass = { width: WidthClass; shortHeight: boolean }

const WIDTHS: [WidthClass, number][] = [
  ["xl", 1600],
  ["large", 1200],
  ["expanded", 840],
  ["medium", 600],
]
const SHORT_HEIGHT = 480

export function sizeClassOf(width: number, height: number): SizeClass {
  return { width: WIDTHS.find(([, min]) => width >= min)?.[0] ?? "compact", shortHeight: height < SHORT_HEIGHT }
}

/** How the palette sits on a screen of this class. */
export type PaletteMode = "bottom-sheet" | "side-sheet" | "rail" | "dock"

export function paletteModeOf({ width, shortHeight }: SizeClass): PaletteMode {
  // A phone held upright: the palette rises from the bottom, under the thumb.
  if (width === "compact" && !shortHeight) return "bottom-sheet"
  // Too little height for a sheet from below: one from the side, over the field.
  if (shortHeight && (width === "compact" || width === "medium" || width === "expanded")) return "side-sheet"
  // A tablet upright: a column of group icons, a group slides out over the field.
  if (width === "medium" || width === "compact") return "rail"
  return "dock"
}

let cached: { w: number; h: number; value: SizeClass } | null = null
const read = (): SizeClass => {
  const w = window.innerWidth
  const h = window.innerHeight
  if (!cached || cached.w !== w || cached.h !== h) {
    const value = sizeClassOf(w, h)
    // The same class keeps the same object: a resize within a class re-renders nothing.
    cached = { w, h, value: cached && cached.value.width === value.width && cached.value.shortHeight === value.shortHeight ? cached.value : value }
  }
  return cached.value
}

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange)
  return () => window.removeEventListener("resize", onChange)
}

const SERVER: SizeClass = { width: "large", shortHeight: false }

export function useSizeClass(): SizeClass {
  return React.useSyncExternalStore(subscribe, read, () => SERVER)
}
