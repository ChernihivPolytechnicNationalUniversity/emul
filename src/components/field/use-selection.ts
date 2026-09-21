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
export function useSelection(toWorld: (cx: number, cy: number) => Point, worldPerPixel: () => number, grid: number) {
  const origin = React.useRef<Point | null>(null)
  const boxRef = React.useRef<HTMLDivElement>(null)

  const draw = React.useCallback((rect: Rect | null) => {
    const el = boxRef.current
    if (!el) return
    if (!rect) {
      el.style.display = "none"
      return
    }
    el.style.display = ""
    el.style.borderWidth = `${worldPerPixel()}px`
    el.style.left = `${rect.x}px`
    el.style.top = `${rect.y}px`
    el.style.width = `${rect.w}px`
    el.style.height = `${rect.h}px`
  }, [worldPerPixel])

  const start = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      const at = toWorld(e.clientX, e.clientY)
      origin.current = at
      draw({ x: at.x, y: at.y, w: 0, h: 0 })
    },
    [toWorld, draw],
  )

  const move = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!origin.current) return false
      draw(rectFrom(origin.current, toWorld(e.clientX, e.clientY), grid))
      return true
    },
    [toWorld, grid, draw],
  )

  /** Finish the drag. Returns the final rect, or null for a plain click / empty box. */
  const end = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>): Rect | null => {
      if (!origin.current) return null
      const rect = rectFrom(origin.current, toWorld(e.clientX, e.clientY), grid)
      origin.current = null
      draw(null)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      return rect.w > 0 && rect.h > 0 ? rect : null
    },
    [toWorld, grid, draw],
  )

  const clear = React.useCallback(() => {
    origin.current = null
    draw(null)
  }, [draw])

  const isDragging = React.useCallback(() => origin.current !== null, [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clear()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [clear])

  return { boxRef, isDragging, start, move, end, clear }
}
