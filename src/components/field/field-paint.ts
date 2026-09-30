import { objectRect, toPath, trimRouteEnds, type Rect, type RoutedWire } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { ComponentDef, PlacedObject } from "@/schematic/types"
import { wireColorVar, type WireColorKey } from "@/schematic/wire-colors"
import { readFieldPalette } from "./field-palette"
import { SELECTION_BANDS, selectionOutline } from "./selection-geometry"
import type { SymbolRaster } from "./symbol-raster"
import { CASING_PX, casingTrim, SELECTED_WIRE_PX, WIRE_PX, wireCornerRadius } from "./wire-style"


const wirePaths = new WeakMap<RoutedWire, Path2D>()

function wirePath(route: RoutedWire, radius: number) {
  const cached = wirePaths.get(route)
  if (cached) return cached
  const path = new Path2D(toPath(route.pts, radius))
  wirePaths.set(route, path)
  return path
}

const casingPaths = new WeakMap<RoutedWire, Path2D>()

function casingPath(route: RoutedWire, radius: number, trim: number) {
  const cached = casingPaths.get(route)
  if (cached) return cached
  const path = new Path2D(toPath(trimRouteEnds(route.pts, trim), radius))
  casingPaths.set(route, path)
  return path
}

const outlinePaths = new WeakMap<ComponentDef, { strokes: Path2D; hollow: Path2D | null }>()

function outlinePathsOf(def: ComponentDef) {
  const cached = outlinePaths.get(def)
  if (cached) return cached
  const outline = selectionOutline(def)
  const paths = { strokes: new Path2D(outline.strokes), hollow: outline.hollow ? new Path2D(outline.hollow) : null }
  outlinePaths.set(def, paths)
  return paths
}

const TINT: Record<string, string> = { "var(--selection)": "var(--selection-tint)", "var(--selection-feather)": "var(--selection-tint-feather)" }

type Selection = { objects: ReadonlySet<string>; wires: ReadonlySet<string> }

function paintSelection(context: CanvasRenderingContext2D, host: Element, objects: readonly PlacedObject[], routes: readonly RoutedWire[], selection: Selection, grid: number, screenPx: (px: number) => number) {
  const radius = wireCornerRadius(grid)
  for (const { margin, color } of SELECTION_BANDS) {
    const tint = cssColor(host, TINT[color])
    context.strokeStyle = tint
    context.fillStyle = tint
    context.lineWidth = screenPx(SELECTED_WIRE_PX + margin * 2)
    for (const route of routes) if (selection.wires.has(route.id)) context.stroke(wirePath(route, radius))
    for (const object of objects) {
      if (!selection.objects.has(object.id)) continue
      const def = getDef(object.def)
      if (!def) continue
      const { strokes, hollow } = outlinePathsOf(def)
      withObjectFrame(context, object, def, grid, () => {
        context.lineWidth = screenPx(margin * 2) / grid
        context.stroke(strokes)
        if (hollow) context.fill(hollow)
      })
    }
  }
}

function withObjectFrame(context: CanvasRenderingContext2D, object: PlacedObject, def: ComponentDef, grid: number, paint: () => void) {
  const rect = objectRect(object, grid)
  context.save()
  context.translate(rect.x + rect.w / 2, rect.y + rect.h / 2)
  context.rotate(((object.rotation ?? 0) * Math.PI) / 180)
  context.scale(grid, grid)
  context.translate(-def.width / 2, -def.height / 2)
  paint()
  context.restore()
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
  selection?: Selection
}

export function paintField(context: CanvasRenderingContext2D, host: Element, { objects, routes, view, grid, pixels, device, theme, colorOf, raster, selection }: FieldPaint) {
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
  const trim = casingTrim(grid)
  const screenPx = (px: number) => (px * device) / pixels
  const selectedWire = (id: string) => selection?.wires.has(id) ?? false
  context.lineCap = "round"
  context.lineJoin = "round"
  if (selection && (selection.objects.size || selection.wires.size)) paintSelection(context, host, objects, routes, selection, grid, screenPx)
  context.lineCap = "butt"
  context.lineWidth = screenPx(WIRE_PX + CASING_PX)
  context.strokeStyle = casing
  for (const route of routes) if (!selectedWire(route.id)) context.stroke(casingPath(route, radius, trim))
  context.lineCap = "round"
  for (const route of routes) {
    context.strokeStyle = colorFor(colorOf(route.id))
    context.lineWidth = screenPx(selectedWire(route.id) ? SELECTED_WIRE_PX : WIRE_PX)
    context.stroke(wirePath(route, radius))
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
