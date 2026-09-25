import { objectRect, toPath, type Rect, type RoutedWire } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { wireColorVar, type WireColorKey } from "@/schematic/wire-colors"
import { readFieldPalette } from "./field-palette"
import type { SymbolRaster } from "./symbol-raster"
import { wireCornerRadius } from "./wire-style"

const WIRE_PX = 2
const CASING_PX = 3


const wirePaths = new WeakMap<RoutedWire, Path2D>()

function wirePath(route: RoutedWire, radius: number) {
  const cached = wirePaths.get(route)
  if (cached) return cached
  const path = new Path2D(toPath(route.pts, radius))
  wirePaths.set(route, path)
  return path
}

export function cssColor(host: Element, value: string) {
  if (!value.startsWith("var(")) return value
  const name = value.slice(4, -1).trim()
  return getComputedStyle(host).getPropertyValue(name).trim() || "black"
}

export type FieldPaint = {
  objects: readonly PlacedObject[]
  routes: readonly RoutedWire[]
  view: Rect
  grid: number
  pixels: number
  device: number
  theme: string
  colorOf: (wireId: string) => WireColorKey
  raster: SymbolRaster
}

export function paintField(context: CanvasRenderingContext2D, host: Element, { objects, routes, view, grid, pixels, device, theme, colorOf, raster }: FieldPaint) {
  raster.setPalette(readFieldPalette(host, theme))
  context.save()
  context.setTransform(pixels, 0, 0, pixels, -view.x * pixels, -view.y * pixels)
  const casing = cssColor(host, "var(--background)")
  const resolved = new Map<WireColorKey, string>()
  const colorFor = (key: WireColorKey) => {
    let color = resolved.get(key)
    if (color === undefined) {
      color = cssColor(host, wireColorVar(key))
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
}
