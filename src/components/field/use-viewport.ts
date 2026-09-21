import * as React from "react"
import type { Rect } from "@/schematic/geometry"
import { dotGridStyle } from "./dot-grid"

export type Viewport = { x: number; y: number; scale: number }
export type Point = { x: number; y: number }

export const MIN_SCALE = 0.1
export const MAX_SCALE = 8
const ZOOM_STEP = 1.2
/** Time constant of the zoom follow animation: the view closes ~63% of the gap per TAU_MS. */
const TAU_MS = 70
const VIEW_PADDING_SCREENS = 1
const VIEW_TRAVEL_FRACTION = 0.25
const VIEW_SCALE_STEP = 0.14

const EMPTY_VIEW: Rect = { x: 0, y: 0, w: 0, h: 0 }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Pan / zoom state for the field.
 * - wheel: pan; ctrl/meta + wheel (and trackpad pinch): zoom to cursor
 * - middle button or space + left button: drag to pan
 * - ctrl/meta + / - / 0: zoom in / out / reset
 */
export function useViewport(grid: number, initial: Viewport = { x: 0, y: 0, scale: 0.5 }) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const contentRef = React.useRef<HTMLDivElement>(null)
  const [publishedScale, setPublishedScale] = React.useState(initial.scale)
  const [view, setView] = React.useState<Rect>(EMPTY_VIEW)
  const viewPublishedAt = React.useRef<Viewport | null>(null)
  const publish = React.useCallback((scale: number) => setPublishedScale(scale), [])

  /**
   * Zoom is animated by following a target: every frame the viewport closes part of the
   * gap to `target`. Wheel ticks and button presses just move the target, so rapid input
   * stays responsive and still eases. Pans are applied to both immediately.
   */
  const target = React.useRef<Viewport>(initial)
  const current = React.useRef<Viewport>(initial)
  const raf = React.useRef(0)
  const lastFrame = React.useRef(0)
  const paintedScale = React.useRef(NaN)
  React.useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const size = React.useRef({ width: 0, height: 0 })
  const measure = React.useCallback(() => {
    const container = containerRef.current
    if (container) size.current = { width: container.clientWidth, height: container.clientHeight }
    return size.current
  }, [])

  const publishView = React.useCallback((v: Viewport, animating: boolean) => {
    const { width, height } = size.current.width ? size.current : measure()
    if (!width || !height) return
    const shown = viewPublishedAt.current
    if (shown && animating) return
    const travelled =
      !shown ||
      Math.abs(Math.log(v.scale / shown.scale)) > VIEW_SCALE_STEP ||
      Math.abs(v.x - shown.x) > width * VIEW_TRAVEL_FRACTION ||
      Math.abs(v.y - shown.y) > height * VIEW_TRAVEL_FRACTION
    if (!travelled) return
    viewPublishedAt.current = v
    const padX = (width * VIEW_PADDING_SCREENS) / v.scale
    const padY = (height * VIEW_PADDING_SCREENS) / v.scale
    setView({
      x: -v.x / v.scale - padX,
      y: -v.y / v.scale - padY,
      w: width / v.scale + padX * 2,
      h: height / v.scale + padY * 2,
    })
  }, [measure])

  const paint = React.useCallback(
    (v: Viewport, animating = false) => {
      const content = contentRef.current
      if (content) content.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`
      const container = containerRef.current
      if (!container) return
      publishView(v, animating)
      container.style.backgroundPosition = `${v.x}px ${v.y}px`
      if (v.scale === paintedScale.current) return
      paintedScale.current = v.scale
      const dots = dotGridStyle(grid, v.scale)
      container.style.backgroundImage = dots.backgroundImage
      container.style.backgroundSize = dots.backgroundSize
    },
    [grid, publishView],
  )

  React.useEffect(() => paint(current.current), [paint])

  React.useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      measure()
      viewPublishedAt.current = null
      publishView(current.current, false)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [measure, publishView])

  const follow = React.useCallback(() => {
    if (raf.current) return
    lastFrame.current = performance.now()
    const frame = (now: number) => {
      const dt = now - lastFrame.current
      lastFrame.current = now
      const k = 1 - Math.exp(-dt / TAU_MS)
      const c = current.current
      const t = target.current
      const next: Viewport = {
        x: c.x + (t.x - c.x) * k,
        y: c.y + (t.y - c.y) * k,
        scale: c.scale + (t.scale - c.scale) * k,
      }
      const done = Math.abs(t.scale - next.scale) < 1e-4 && Math.abs(t.x - next.x) < 0.1 && Math.abs(t.y - next.y) < 0.1
      current.current = done ? t : next
      paint(current.current, !done)
      if (done) publish(current.current.scale)
      raf.current = done ? 0 : requestAnimationFrame(frame)
    }
    raf.current = requestAnimationFrame(frame)
  }, [paint, publish])

  /** Set the viewport immediately (drag, wheel pan). */
  const setNow = React.useCallback((next: Viewport | ((v: Viewport) => Viewport)) => {
    const n = typeof next === "function" ? next(current.current) : next
    // Keep any in-flight zoom: shift the target by the same pan delta.
    const dx = n.x - current.current.x
    const dy = n.y - current.current.y
    const sameScale = n.scale === current.current.scale
    target.current = sameScale ? { ...target.current, x: target.current.x + dx, y: target.current.y + dy } : n
    current.current = n
    paint(n)
    if (!sameScale) publish(n.scale)
  }, [paint, publish])

  /** Ease the viewport towards `to`. */
  const animateTo = React.useCallback(
    (to: Viewport) => {
      target.current = to
      follow()
    },
    [follow],
  )

  /** Viewport zoomed by `factor` around a field point (defaults to the center). */
  const zoomed = React.useCallback((v: Viewport, factor: number, px?: number, py?: number): Viewport => {
    const { width, height } = size.current.width ? size.current : measure()
    const cx = px ?? width / 2
    const cy = py ?? height / 2
    const scale = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE)
    const k = scale / v.scale
    return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
  }, [measure])

  /** Smooth zoom around a point (wheel / pinch); chains from the current target. */
  const zoomAt = React.useCallback(
    (factor: number, px?: number, py?: number) => animateTo(zoomed(target.current, factor, px, py)),
    [animateTo, zoomed],
  )

  const zoomIn = React.useCallback(() => animateTo(zoomed(target.current, ZOOM_STEP)), [animateTo, zoomed])
  const zoomOut = React.useCallback(() => animateTo(zoomed(target.current, 1 / ZOOM_STEP)), [animateTo, zoomed])
  const reset = React.useCallback(() => animateTo({ x: 0, y: 0, scale: 1 }), [animateTo])
  /** Zoom and pan so that a world rectangle fills the view, with some margin. */
  const fitTo = React.useCallback(
    (r: { x: number; y: number; w: number; h: number }, margin = 48) => {
      const { width, height } = measure()
      if (!width || !height) return
      const scale = clamp(Math.min((width - 2 * margin) / r.w, (height - 2 * margin) / r.h), MIN_SCALE, MAX_SCALE)
      animateTo({
        scale,
        x: width / 2 - (r.x + r.w / 2) * scale,
        y: height / 2 - (r.y + r.h / 2) * scale,
      })
    },
    [animateTo, measure],
  )
  const panBy = React.useCallback(
    (dx: number, dy: number) => setNow((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
    [setNow],
  )

  /** Screen (client) coordinates -> world coordinates. */
  const worldPerPixel = React.useCallback(() => 1 / current.current.scale, [])

  const toWorld = React.useCallback((clientX: number, clientY: number): Point => {
    const r = containerRef.current?.getBoundingClientRect()
    const sx = clientX - (r?.left ?? 0)
    const sy = clientY - (r?.top ?? 0)
    const v = current.current
    return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale }
  }, [])

  // Wheel must be non-passive to call preventDefault, so bind it manually.
  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        // Mouse wheel notches (|deltaY| ≈ 100) zoom by a fixed step; trackpad pinch sends
        // many small deltas and scales continuously.
        const notch = Math.abs(e.deltaY) >= 50
        const factor = notch ? (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP) : Math.exp(-e.deltaY * 0.01)
        zoomAt(factor, e.clientX - r.left, e.clientY - r.top)
      } else {
        panBy(-e.deltaX, -e.deltaY)
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [zoomAt, panBy])

  // Space held -> left drag pans instead of selecting.
  const [spaceHeld, setSpaceHeld] = React.useState(false)
  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      if (e.code === "Space" && !e.repeat && !typing) {
        e.preventDefault()
        setSpaceHeld(true)
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false)
    }
    window.addEventListener("keydown", down)
    window.addEventListener("keyup", up)
    return () => {
      window.removeEventListener("keydown", down)
      window.removeEventListener("keyup", up)
    }
  }, [])

  const [panning, setPanning] = React.useState(false)
  const last = React.useRef<Point | null>(null)

  /** Returns true if the pointer event should start a pan. */
  const isPanStart = React.useCallback(
    (e: React.PointerEvent) => e.button === 1 || (e.button === 0 && spaceHeld),
    [spaceHeld],
  )

  const startPan = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    last.current = { x: e.clientX, y: e.clientY }
    setPanning(true)
  }, [])

  const movePan = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!last.current) return false
      panBy(e.clientX - last.current.x, e.clientY - last.current.y)
      last.current = { x: e.clientX, y: e.clientY }
      return true
    },
    [panBy],
  )

  const endPan = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!last.current) return false
    last.current = null
    setPanning(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    return true
  }, [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key === "=" || e.key === "+") {
        e.preventDefault()
        zoomIn()
      } else if (e.key === "-") {
        e.preventDefault()
        zoomOut()
      } else if (e.key === "0") {
        e.preventDefault()
        reset()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [zoomIn, zoomOut, reset])

  return {
    containerRef,
    contentRef,
    scale: publishedScale,
    view,
    worldPerPixel,
    panning,
    spaceHeld,
    zoomIn,
    zoomOut,
    reset,
    fitTo,
    toWorld,
    isPanStart,
    startPan,
    movePan,
    endPan,
  }
}
