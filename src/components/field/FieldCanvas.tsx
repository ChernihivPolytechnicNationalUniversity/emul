import * as React from "react"
import { objectRect, toPath, type Rect, type RoutedWire } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { wireColorVar, type WireColorKey } from "@/schematic/wire-colors"
import { readFieldPalette, useThemeName } from "./field-palette"
import { deviceScale, MAX_CANVAS_PX, rasterBucket, type SymbolRaster } from "./symbol-raster"
import { wireCornerRadius } from "./wire-style"

const WIRE_PX = 2
const CASING_PX = 3

type FieldCanvasProps = {
  objects: readonly PlacedObject[]
  routes: readonly RoutedWire[]
  view: Rect
  grid: number
  scale: number
  colorOf: (wireId: string) => WireColorKey
  raster: SymbolRaster
}

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

export function FieldCanvas({ objects, routes, view, grid, scale, colorOf, raster }: FieldCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const bucket = rasterBucket(scale)
  const theme = useThemeName()

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || view.w <= 0) return
    const device = deviceScale()
    const pixels = bucket * device
    const width = Math.max(1, Math.round(view.w * pixels))
    const height = Math.max(1, Math.round(view.h * pixels))
    if (width > MAX_CANVAS_PX || height > MAX_CANVAS_PX) return
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) return

    raster.setPalette(readFieldPalette(canvas, theme))
    context.clearRect(0, 0, width, height)

    context.save()
    context.setTransform(pixels, 0, 0, pixels, -view.x * pixels, -view.y * pixels)
    const casing = cssColor(canvas, "var(--background)")
    const resolved = new Map<WireColorKey, string>()
    const colorFor = (key: WireColorKey) => {
      let color = resolved.get(key)
      if (color === undefined) {
        color = cssColor(canvas, wireColorVar(key))
        resolved.set(key, color)
      }
      return color
    }
    const radius = wireCornerRadius(grid)
    context.lineCap = "round"
    context.lineJoin = "round"
    for (const pass of ["casing", "body"] as const) {
      context.lineWidth = ((pass === "casing" ? WIRE_PX + CASING_PX : WIRE_PX) * device) / pixels
      if (pass === "casing") context.strokeStyle = casing
      for (const route of routes) {
        if (pass === "body") context.strokeStyle = colorFor(colorOf(route.id))
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
