import { bodyCentre, objectRect, orientationOf, stretchedLeads, toPath, trimRouteEnds, type Point, type Rect, type RoutedWire } from "@/schematic/geometry"
import { runPath } from "@/schematic/wire-look"
import { getDef } from "@/schematic/registry"
import type { ComponentDef, PlacedObject } from "@/schematic/types"
import { wireColorVar, type WireColorKey } from "@/schematic/wire-colors"
import { readFieldPalette } from "./field-palette"
import { SELECTION_BANDS, selectionOutline } from "./selection-geometry"
import { PIN_MARK_CELLS, type SymbolRaster } from "./symbol-raster"
import { CASING_PX, casingTrim, casingWidth, dotRadius, OPEN_END_CELLS, SELECTED_WIRE_PX, WIRE_PX, wireCornerRadius } from "./wire-style"
import type { WireMarks } from "./wire-marks"

const wirePaths = new WeakMap<RoutedWire, Path2D>()

function wirePath(route: RoutedWire, radius: number) {
  const cached = wirePaths.get(route)
  if (cached) return cached
  const path = new Path2D(runPath(route.pts, radius, route.leads))
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

type OutlinePaths = { strokes: Path2D; hollow: Path2D | null }

const outlinePaths = new WeakMap<ComponentDef, { upright?: OutlinePaths; diagonal?: OutlinePaths }>()

function outlinePathsOf(def: ComponentDef, object: PlacedObject) {
  const stretch = stretchedLeads(def, orientationOf(object))
  const cached = outlinePaths.get(def) ?? {}
  outlinePaths.set(def, cached)
  const slot = stretch ? "diagonal" : "upright"
  const found = cached[slot]
  if (found) return found
  const outline = selectionOutline(def)
  const paths = { strokes: new Path2D(stretch ? `${outline.strokes} ${stretch}` : outline.strokes), hollow: outline.hollow ? new Path2D(outline.hollow) : null }
  cached[slot] = paths
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
      const { strokes, hollow } = outlinePathsOf(def, object)
      withObjectFrame(context, object, def, grid, () => {
        context.lineWidth = screenPx(margin * 2) / grid
        context.stroke(strokes)
        if (hollow) context.fill(hollow)
      })
    }
  }
}

function withObjectFrame(context: CanvasRenderingContext2D, object: PlacedObject, def: ComponentDef, grid: number, paint: () => void) {
  const centre = bodyCentre(def, orientationOf(object))
  context.save()
  context.translate(object.x + centre.x * grid, object.y + centre.y * grid)
  context.rotate(((object.rotation ?? 0) * Math.PI) / 180)
  if (object.mirror) context.scale(-1, 1)
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
  netOf?: (wireId: string) => string | undefined
  raster: SymbolRaster
  selection?: Selection
  marks?: WireMarks
  /** A search is on: these objects are drawn at full strength, the rest of the field faint. */
  lit?: ReadonlySet<string> | null
}

function byNet(routes: readonly RoutedWire[], netOf: ((wireId: string) => string | undefined) | undefined): RoutedWire[][] {
  const nets = new Map<string, RoutedWire[]>()
  for (const route of routes) {
    const net = netOf?.(route.id) ?? route.id
    const list = nets.get(net)
    if (list) list.push(route)
    else nets.set(net, [route])
  }
  return [...nets.values()]
}

export type MarkPaint = { radius: number; screenPx: (px: number) => number; pixels: number; device: number; grid: number; casing: string; ink: string; colorFor: (key: WireColorKey) => string; colorOf: (wireId: string) => WireColorKey }

export function paintMarks(context: CanvasRenderingContext2D, routes: readonly RoutedWire[], marks: WireMarks, wire: MarkPaint) {
  const { radius, screenPx, pixels, device, grid, casing, ink, colorFor, colorOf } = wire
  const turning = routes.filter((r) => r.leads)
  const patch = (from: Point, to: Point) => {
    context.beginPath()
    context.moveTo(from.x, from.y)
    context.lineTo(to.x, to.y)
    context.stroke()
  }
  context.lineCap = "butt"
  context.lineWidth = screenPx(WIRE_PX + CASING_PX)
  context.strokeStyle = casing
  const pinMark = grid * PIN_MARK_CELLS + screenPx(1)
  const hiddenUpTo = (lead: Point, pin: Point) => {
    patch(lead, pin)
    context.fillStyle = casing
    context.fillRect(pin.x - pinMark, pin.y - pinMark, pinMark * 2, pinMark * 2)
  }
  for (const r of turning) {
    if (r.leads?.start) hiddenUpTo(r.leads.start, r.pts[0])
    if (r.leads?.end) hiddenUpTo(r.leads.end, r.pts[r.pts.length - 1])
  }
  for (const c of marks.corners) {
    hiddenUpTo(c.a, c.at)
    hiddenUpTo(c.b, c.at)
  }
  context.lineCap = "round"
  context.lineWidth = screenPx(WIRE_PX)
  for (const r of turning) {
    context.strokeStyle = colorFor(colorOf(r.id))
    context.stroke(wirePath(r, radius))
  }
  context.strokeStyle = ink
  for (const c of marks.corners) {
    context.beginPath()
    context.moveTo(c.a.x, c.a.y)
    context.quadraticCurveTo(c.at.x, c.at.y, c.b.x, c.b.y)
    context.stroke()
  }
  const dot = dotRadius(grid, pixels / device)
  for (const { at, color } of marks.dots) {
    context.fillStyle = color ? colorFor(color) : ink
    context.beginPath()
    context.arc(at.x, at.y, dot, 0, Math.PI * 2)
    context.fill()
  }
  for (const { at, color } of marks.open) {
    context.fillStyle = casing
    context.strokeStyle = colorFor(color)
    context.beginPath()
    context.arc(at.x, at.y, OPEN_END_CELLS * grid, 0, Math.PI * 2)
    context.fill()
    context.stroke()
  }
}

/** How strong what a search did not find is drawn. */
const DIMMED = 0.22

export function paintField(context: CanvasRenderingContext2D, host: Element, { objects, routes, view, grid, pixels, device, theme, colorOf, netOf, raster, selection, marks, lit }: FieldPaint) {
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
  if (lit) context.globalAlpha = DIMMED
  const widthOf = (id: string) => (selectedWire(id) ? SELECTED_WIRE_PX : WIRE_PX)
  const plate = selection?.wires.size ? cssColor(host, "var(--selection-tint)") : casing
  for (const net of byNet(routes, netOf)) {
    context.lineCap = "butt"
    for (const route of net) {
      context.strokeStyle = selectedWire(route.id) ? plate : casing
      context.lineWidth = screenPx(casingWidth(widthOf(route.id)))
      context.stroke(casingPath(route, radius, trim))
    }
    context.lineCap = "round"
    for (const route of net) {
      context.strokeStyle = colorFor(colorOf(route.id))
      context.lineWidth = screenPx(widthOf(route.id))
      context.stroke(wirePath(route, radius))
    }
  }
  context.restore()

  for (const object of objects) {
    const def = getDef(object.def)
    if (!def) continue
    const symbol = raster.get(def, orientationOf(object), grid, pixels)
    if (!symbol) continue
    const rect = objectRect(object, grid)
    context.globalAlpha = lit && !lit.has(object.id) ? DIMMED : 1
    context.drawImage(
      symbol.image,
      (rect.x - view.x) * pixels - symbol.originX,
      (rect.y - view.y) * pixels - symbol.originY,
      symbol.width,
      symbol.height,
    )
  }
  context.globalAlpha = 1
  if (marks && (marks.dots.length || marks.open.length || marks.corners.length || routes.some((r) => r.leads))) {
    context.save()
    context.setTransform(pixels, 0, 0, pixels, -view.x * pixels, -view.y * pixels)
    if (lit) context.globalAlpha = DIMMED
    paintMarks(context, routes, marks, { radius, screenPx, pixels, device, grid, casing, ink: cssColor(host, "var(--foreground)"), colorFor, colorOf })
    context.restore()
  }
}
