/**
 * What a passive display's glass shows, as its digital model reports it in its snapshot: a grid
 * of dots, each with how strongly it is driven. A character LCD groups its dots into character
 * cells with a gap between them; an OLED is one plain grid. Plain data: it crosses the worker.
 */
export type Screen = {
  /** Dots across and down (a character LCD: every cell's dots, gaps not counted). */
  width: number
  height: number
  /** Character cells: `w × h` dots each, a dot-wide gap between them. Absent: one plain grid. */
  cell?: { w: number; h: number }
  /** How dark (LCD) or bright (OLED) each dot is, 0–255, row-major. */
  dots: number[]
  /** Glass and ink colours as CSS: the dot's colour moves from `glass` towards `ink` with its value. */
  glass: string
  ink: string
  /** Rows from `from` down light in their own ink (a two-colour OLED's yellow top band). */
  bands?: { from: number; ink: string }[]
  /** The colours with the backlight off, for a screen part that names its backlight LED: mixed in by its level. */
  unlit?: { glass: string; ink: string }
  /** Bumped whenever anything above changes; the view redraws only then. */
  version: number
}

/** The screen in a digital part's snapshot, if it has one. */
export function screenOf(snapshot: unknown): Screen | undefined {
  const screen = (snapshot as { screen?: unknown } | undefined)?.screen
  return screen && typeof screen === "object" && Array.isArray((screen as Screen).dots) ? (screen as Screen) : undefined
}

/** A servo's horn angle in degrees (0 straight up, clockwise positive), if the snapshot has one. */
export function angleOf(snapshot: unknown): number | undefined {
  const angle = (snapshot as { angle?: unknown } | undefined)?.angle
  return typeof angle === "number" ? angle : undefined
}

/** Canvas size of a screen in dots, the gaps between character cells included. */
export function screenCanvas(screen: Pick<Screen, "width" | "height" | "cell">) {
  if (!screen.cell) return { width: screen.width, height: screen.height }
  const cols = screen.width / screen.cell.w
  const rows = screen.height / screen.cell.h
  return { width: screen.width + cols - 1, height: screen.height + rows - 1 }
}
