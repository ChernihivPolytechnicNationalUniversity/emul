import * as React from "react"
import { objectRect, toPath, type Rect, type RoutedWire } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { wireColorVar, type WireColorKey } from "@/schematic/wire-colors"
import { readFieldPalette, useThemeName } from "./field-palette"
import { SymbolRaster } from "./symbol-raster"
import { wireCornerRadius } from "./wire-style"

const WIRE_PX = 2
const CASING_PX = 3
/** Rasterisation steps: the picture is drawn at one of these and scaled between them. */
const BUCKETS = [0.03125, 0.0625, 0.125, 0.25, 0.5, 1]

export const rasterBucket = (scale: number) => BUCKETS.find((b) => b >= scale) ?? BUCKETS[BUCKETS.length - 1]

type FieldCanvasProps = {
  objects: readonly PlacedObject[]
  routes: readonly RoutedWire[]
  view: Rect
  grid: number
  scale: number
  colorOf: (wireId: string) => WireColorKey
}

/**
 * Wire outlines in world coordinates, so one path serves every zoom and every scroll position:
 * the context transform does the scaling. Phase 4's router hands back the same `RoutedWire`
 * object for a route that did not change, which is what makes the key work.
 */
const wirePaths = new WeakMap<RoutedWire, Path2D>()

function wirePath(route: RoutedWire, radius: number) {
  const cached = wirePaths.get(route)
  if (cached) return cached
  const path = new Path2D(toPath(route.pts, radius))
  wirePaths.set(route, path)
  return path
}

function cssColor(host: Element, value: string) {
  if (!value.startsWith("var(")) return value
  const name = value.slice(4, -1).trim()
  return getComputedStyle(host).getPropertyValue(name).trim() || "black"
}

/**
 * The whole static picture on one canvas, for zooms where nothing on the field is individually
 * interactive. Objects come from the symbol cache, one `drawImage` each; wires are drawn
 * straight. Redrawn when the document, the view, the zoom bucket or the theme changes — never
 * per frame. FIELD.md §11.
 */
export function FieldCanvas({ objects, routes, view, grid, scale, colorOf }: FieldCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [raster] = React.useState(() => new SymbolRaster())
  const bucket = rasterBucket(scale)
  const theme = useThemeName()

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || view.w <= 0) return
    const device = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1)
    const pixels = bucket * device
    const width = Math.max(1, Math.round(view.w * pixels))
    const height = Math.max(1, Math.round(view.h * pixels))
    if (width > 16384 || height > 16384) return
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) return

    raster.setPalette(readFieldPalette(canvas, theme))
    context.clearRect(0, 0, width, height)

    context.save()
    context.setTransform(pixels, 0, 0, pixels, -view.x * pixels, -view.y * pixels)
    const casing = cssColor(canvas, "var(--background)")
    const radius = wireCornerRadius(grid)
    context.lineCap = "round"
    context.lineJoin = "round"
    for (const pass of ["casing", "body"] as const) {
      context.lineWidth = ((pass === "casing" ? WIRE_PX + CASING_PX : WIRE_PX) * device) / pixels
      if (pass === "casing") context.strokeStyle = casing
      for (const route of routes) {
        if (pass === "body") context.strokeStyle = cssColor(canvas, wireColorVar(colorOf(route.id)))
        context.stroke(wirePath(route, radius))
      }
    }
    context.restore()

    for (const object of objects) {
      const def = getDef(object.def)
      if (!def) continue
      const symbol = raster.get(def, object.rotation ?? 0, grid, pixels)
      if (!symbol) continue
      const rect = objectRect(object, grid)
      context.drawImage(
        symbol.image,
        (rect.x - view.x) * pixels - symbol.originX,
        (rect.y - view.y) * pixels - symbol.originY,
        symbol.width,
        symbol.height,
      )
    }
  }, [objects, routes, view, grid, bucket, theme, colorOf, raster])

  if (view.w <= 0) return null
  return (
    <canvas
      ref={canvasRef}
      data-slot="field-canvas"
      className="pointer-events-none absolute"
      style={{ left: view.x, top: view.y, width: view.w, height: view.h }}
    />
  )
}
