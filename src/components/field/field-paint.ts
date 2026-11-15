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
import { BODY_EDGE_CELLS, bodyMaskShapes } from "./body-mask"
import { BoxIndex } from "@/schematic/spatial"
import type { WirePlate } from "./wire-plate"

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

type Selection = { objects: ReadonlySet<string>; wires: ReadonlySet<string>; plates?: readonly WirePlate[] }

const platePaths = new WeakMap<WirePlate, { band: Path2D; casing: Path2D }>()

function platePath(plate: WirePlate) {
  const cached = platePaths.get(plate)
  if (cached) return cached
  const paths = { band: new Path2D(plate.d), casing: new Path2D(plate.casing) }
  platePaths.set(plate, paths)
  return paths
}

function platesAmong(routes: readonly RoutedWire[], plates: readonly WirePlate[] | undefined): WirePlate[] {
  if (!plates?.length) return []
  const drawn = new Set(routes.map((r) => r.id))
  return plates.filter((plate) => drawn.has(plate.run))
}

function paintSelection(context: CanvasRenderingContext2D, host: Element, objects: readonly PlacedObject[], plates: readonly WirePlate[], selection: Selection, grid: number, screenPx: (px: number) => number) {
  for (const { margin, color } of SELECTION_BANDS) {
    const tint = cssColor(host, TINT[color])
    context.strokeStyle = tint
    context.fillStyle = tint
    context.lineWidth = screenPx(SELECTED_WIRE_PX + margin * 2)
    for (const plate of plates) {
      context.lineCap = plate.whole ? "round" : "butt"
      context.stroke(platePath(plate).band)
    }
    context.lineCap = "round"
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

type CasingMask = { box: Rect } & ({ polygon: readonly Point[] } | { lead: readonly [Point, Point] } | { text: Rect })

const casingMasks = new WeakMap<readonly PlacedObject[], { grid: number; index: BoxIndex<CasingMask> }>()

function casingMaskIndex(objects: readonly PlacedObject[], grid: number): BoxIndex<CasingMask> {
  const cached = casingMasks.get(objects)
  if (cached?.grid === grid) return cached.index
  const shapes = bodyMaskShapes(objects, grid)
  const radius = BODY_EDGE_CELLS * grid / 2
  const bounds = (points: readonly Point[]): Rect => {
    const x = Math.min(...points.map((p) => p.x)) - radius
    const y = Math.min(...points.map((p) => p.y)) - radius
    return { x, y, w: Math.max(...points.map((p) => p.x)) + radius - x, h: Math.max(...points.map((p) => p.y)) + radius - y }
  }
  const masks: CasingMask[] = [
    ...shapes.bodies.map((polygon) => ({ box: bounds(polygon), polygon })),
    ...shapes.leads.map((lead) => ({ box: bounds(lead), lead })),
    ...shapes.texts.map((text) => ({ box: text, text })),
  ]
  const index = new BoxIndex(masks, (mask) => mask.box, 16 * grid)
  casingMasks.set(objects, { grid, index })
  return index
}

function clipCasings(context: CanvasRenderingContext2D, index: BoxIndex<CasingMask>, routes: readonly RoutedWire[], view: Rect, grid: number, width: number) {
  const points = routes.flatMap((r) => r.pts)
  const margin = Math.max(width, 3 * grid)
  const x = Math.min(...points.map((p) => p.x)) - margin
  const y = Math.min(...points.map((p) => p.y)) - margin
  const box = { x, y, w: Math.max(...points.map((p) => p.x)) + margin - x, h: Math.max(...points.map((p) => p.y)) + margin - y }
  const beginHole = () => {
    context.beginPath()
    context.rect(view.x, view.y, view.w, view.h)
  }
  const clipLead = ([a, b]: readonly [Point, Point]) => {
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const radius = BODY_EDGE_CELLS * grid / 2
    beginHole()
    context.moveTo(a.x + Math.sin(angle) * radius, a.y - Math.cos(angle) * radius)
    context.arc(b.x, b.y, radius, angle - Math.PI / 2, angle + Math.PI / 2)
    context.arc(a.x, a.y, radius, angle + Math.PI / 2, angle + 3 * Math.PI / 2)
    context.closePath()
    context.clip("evenodd")
  }
  index.some(box, (mask) => {
    if ("lead" in mask) clipLead(mask.lead)
    else if ("text" in mask) {
      beginHole()
      context.rect(mask.text.x, mask.text.y, mask.text.w, mask.text.h)
      context.clip("evenodd")
    } else if (mask.polygon.length) {
      beginHole()
      context.moveTo(mask.polygon[0].x, mask.polygon[0].y)
      for (const p of mask.polygon.slice(1)) context.lineTo(p.x, p.y)
      context.closePath()
      context.clip("evenodd")
      mask.polygon.forEach((p, i) => clipLead([p, mask.polygon[(i + 1) % mask.polygon.length]]))
    }
    return false
  })
}

export type MarkPaint = { radius: number; screenPx: (px: number) => number; pixels: number; device: number; grid: number; casing: string; ink: string; colorFor: (key: WireColorKey) => string; colorOf: (wireId: string) => WireColorKey; tint?: string; plated?: ReadonlySet<string> }

export function paintMarks(context: CanvasRenderingContext2D, routes: readonly RoutedWire[], marks: WireMarks, wire: MarkPaint) {
  const { radius, screenPx, pixels, device, grid, casing, ink, colorFor, colorOf, tint = casing, plated } = wire
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
  const hiddenUpTo = (lead: Point, pin: Point, under = casing) => {
    context.strokeStyle = under
    patch(lead, pin)
    context.fillStyle = under
    context.fillRect(pin.x - pinMark, pin.y - pinMark, pinMark * 2, pinMark * 2)
  }
  const underEnd = (run: string, end: "start" | "end") => (plated?.has(`${run}:${end}`) ? tint : casing)
  for (const r of turning) {
    if (r.leads?.start) hiddenUpTo(r.leads.start, r.pts[0], underEnd(r.id, "start"))
    if (r.leads?.end) hiddenUpTo(r.leads.end, r.pts[r.pts.length - 1], underEnd(r.id, "end"))
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
  const plates = platesAmong(routes, selection?.plates)
  if (selection && (selection.objects.size || plates.length)) paintSelection(context, host, objects, plates, selection, grid, screenPx)
  const wholeRuns = new Set(plates.filter((p) => p.whole).map((p) => p.run))
  const tintedChains = plates.filter((p) => !p.whole)
  if (lit) context.globalAlpha = DIMMED
  const widthOf = (id: string) => (selectedWire(id) ? SELECTED_WIRE_PX : WIRE_PX)
  const plate = selection?.wires.size ? cssColor(host, "var(--selection-tint)") : casing
  const masks = routes.length ? casingMaskIndex(objects, grid) : undefined
  for (const net of byNet(routes, netOf)) {
    context.lineCap = "butt"
    context.save()
    if (masks) clipCasings(context, masks, net, view, grid, screenPx(casingWidth(SELECTED_WIRE_PX)))
    for (const route of net) {
      context.strokeStyle = wholeRuns.has(route.id) ? plate : casing
      context.lineWidth = screenPx(casingWidth(widthOf(route.id)))
      context.stroke(casingPath(route, radius, trim))
      for (const chain of tintedChains) {
        if (chain.run !== route.id) continue
        context.strokeStyle = plate
        context.stroke(platePath(chain).casing)
      }
    }
    context.restore()
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
    const plated = new Set(plates.flatMap((p) => [...(p.start ? [`${p.run}:start`] : []), ...(p.end ? [`${p.run}:end`] : [])]))
    paintMarks(context, routes, marks, { radius, screenPx, pixels, device, grid, casing, ink: cssColor(host, "var(--foreground)"), colorFor, colorOf, tint: plate, plated })
    context.restore()
  }
}
