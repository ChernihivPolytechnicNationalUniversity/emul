import * as React from "react"
import type { Point } from "./use-viewport"

/** Axis-aligned rectangle in world coordinates. */
export type Rect = { x: number; y: number; w: number; h: number }

const snap = (v: number, grid: number) => Math.round(v / grid) * grid

function rectFrom(a: Point, b: Point, grid: number): Rect {
  const x1 = snap(Math.min(a.x, b.x), grid)
  const y1 = snap(Math.min(a.y, b.y), grid)
  const x2 = snap(Math.max(a.x, b.x), grid)
  const y2 = snap(Math.max(a.y, b.y), grid)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/**
 * Marquee selection, snapped to the grid. Left drag draws the box; on release the
 * caller reads the final rect (via `end`) and the box disappears.
 */
export function useSelection(toWorld: (cx: number, cy: number) => Point, grid: number) {
  const [selection, setSelection] = React.useState<Rect | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const origin = React.useRef<Point | null>(null)

  const start = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      origin.current = toWorld(e.clientX, e.clientY)
      setSelection(null)
      setDragging(true)
    },
    [toWorld],
  )

  const move = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!origin.current) return false
      setSelection(rectFrom(origin.current, toWorld(e.clientX, e.clientY), grid))
      return true
    },
    [toWorld, grid],
  )

  /** Finish the drag. Returns the final rect, or null for a plain click / empty box. */
  const end = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>): Rect | null => {
      if (!origin.current) return null
      const rect = rectFrom(origin.current, toWorld(e.clientX, e.clientY), grid)
      origin.current = null
      setDragging(false)
      setSelection(null)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      return rect.w > 0 && rect.h > 0 ? rect : null
    },
    [toWorld, grid],
  )

  const clear = React.useCallback(() => setSelection(null), [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [clear])

  return { selection, dragging, start, move, end, clear, setSelection }
}
