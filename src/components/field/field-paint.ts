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
import { notchPath, PLATE_REACH, type WirePlate } from "./wire-plate"

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

type Selection = { objects: ReadonlySet<string>; wires: ReadonlySet<string>; plates?: readonly WirePlate[] }

const bandPaths = new WeakMap<WirePlate, Path2D>()

function bandPath(plate: WirePlate) {
  const cached = bandPaths.get(plate)
  if (cached) return cached
  const path = new Path2D(plate.d)
  bandPaths.set(plate, path)
  return path
}

function platesAmong(routes: readonly RoutedWire[], plates: readonly WirePlate[] | undefined): WirePlate[] {
  if (!plates?.length) return []
  const drawn = new Set(routes.map((r) => r.id))
  return plates.filter((plate) => drawn.has(plate.run))
}

const PLATE_OPACITY = 0.09

export function plateOpacity(host: Element) {
  const value = Number.parseFloat(getComputedStyle(host).getPropertyValue("--selection-plate-opacity"))
  return Number.isFinite(value) ? value : PLATE_OPACITY
}

function paintSelection(context: CanvasRenderingContext2D, host: Element, objects: readonly PlacedObject[], plates: readonly WirePlate[], selection: Selection, grid: number, view: Rect, screenPx: (px: number) => number) {
  for (const { margin, color } of SELECTION_BANDS) {
    const opaque = cssColor(host, color)
    context.strokeStyle = opaque
    context.fillStyle = opaque
    const width = screenPx(SELECTED_WIRE_PX + margin * 2)
    context.lineWidth = width
    context.lineCap = "butt"
    for (const plate of plates) {
      if (plate.notches.length) {
        context.save()
        context.clip(new Path2D(notchPath(plate.notches, screenPx(PLATE_REACH), view)), "evenodd")
        context.stroke(bandPath(plate))
        context.restore()
      } else context.stroke(bandPath(plate))
      for (const cap of plate.caps) {
        context.beginPath()
        context.arc(cap.x, cap.y, width / 2, 0, Math.PI * 2)
        context.fill()
      }
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
  layer?: (width: number, height: number) => CanvasRenderingContext2D | null
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

export type LeadCut = { screenPx: (px: number) => number; grid: number }

export function cutTurnedLeads(context: CanvasRenderingContext2D, routes: readonly RoutedWire[], marks: Pick<WireMarks, "corners">, { screenPx, grid }: LeadCut) {
  const pinMark = grid * PIN_MARK_CELLS + screenPx(1)
  const hiddenUpTo = (lead: Point, pin: Point) => {
    context.beginPath()
    context.moveTo(lead.x, lead.y)
    context.lineTo(pin.x, pin.y)
    context.stroke()
    context.fillRect(pin.x - pinMark, pin.y - pinMark, pinMark * 2, pinMark * 2)
  }
  context.save()
  context.globalCompositeOperation = "destination-out"
  context.globalAlpha = 1
  context.lineCap = "butt"
  context.lineWidth = screenPx(WIRE_PX + CASING_PX)
  context.strokeStyle = "#000"
  context.fillStyle = "#000"
  for (const r of routes) {
    if (r.leads?.start) hiddenUpTo(r.leads.start, r.pts[0])
    if (r.leads?.end) hiddenUpTo(r.leads.end, r.pts[r.pts.length - 1])
  }
  for (const c of marks.corners) {
    hiddenUpTo(c.a, c.at)
    hiddenUpTo(c.b, c.at)
  }
  context.restore()
}

export type MarkPaint = { radius: number; screenPx: (px: number) => number; pixels: number; device: number; grid: number; casing: string; ink: string; colorFor: (key: WireColorKey) => string; colorOf: (wireId: string) => WireColorKey }

export function paintMarks(context: CanvasRenderingContext2D, routes: readonly RoutedWire[], marks: WireMarks, wire: MarkPaint) {
  const { radius, screenPx, grid, casing, ink, colorFor, colorOf } = wire
  const turning = routes.filter((r) => r.leads)
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
  const dot = dotRadius(grid, screenPx(WIRE_PX))
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

const DIMMED = 0.22

type Layer = CanvasRenderingContext2D

let scratch: { canvas: OffscreenCanvas; context: Layer } | null = null

function scratchLayer(width: number, height: number): Layer | null {
  if (typeof OffscreenCanvas === "undefined") return null
  if (!(scratch?.canvas instanceof OffscreenCanvas)) {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext("2d") as Layer | null
    if (!context) return null
    scratch = { canvas, context }
  }
  if (scratch.canvas.width !== width || scratch.canvas.height !== height) {
    scratch.canvas.width = width
    scratch.canvas.height = height
  }
  return scratch.context
}

function onLayer(context: CanvasRenderingContext2D, layer: Layer | null, size: { width: number; height: number }, alpha: number, paint: (target: CanvasRenderingContext2D) => void) {
  if (!layer || layer === context) {
    context.save()
    context.globalAlpha = alpha
    paint(context)
    context.restore()
    return
  }
  layer.save()
  layer.setTransform(1, 0, 0, 1, 0, 0)
  layer.globalCompositeOperation = "source-over"
  layer.globalAlpha = 1
  layer.clearRect(0, 0, size.width, size.height)
  paint(layer)
  layer.restore()
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalAlpha = alpha
  context.drawImage(layer.canvas, 0, 0)
  context.restore()
}

export function paintField(context: CanvasRenderingContext2D, host: Element, { objects, routes, view, grid, pixels, device, theme, colorOf, netOf, raster, selection, marks, lit, layer }: FieldPaint) {
  raster.setPalette(readFieldPalette(host, theme))
  const size = { width: Math.max(1, Math.round(view.w * pixels)), height: Math.max(1, Math.round(view.h * pixels)) }
  const scratchFor = layer ?? scratchLayer
  const world = (target: CanvasRenderingContext2D) => target.setTransform(pixels, 0, 0, pixels, -view.x * pixels, -view.y * pixels)
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
  const widthOf = (id: string) => (selectedWire(id) ? SELECTED_WIRE_PX : WIRE_PX)

  const plates = platesAmong(routes, selection?.plates)
  if (selection && (selection.objects.size || plates.length))
    onLayer(context, scratchFor(size.width, size.height), size, plateOpacity(host), (target) => {
      world(target)
      target.lineJoin = "round"
      paintSelection(target, host, objects, plates, selection, grid, view, screenPx)
    })

  if (routes.length) {
    const masks = casingMaskIndex(objects, grid)
    onLayer(context, scratchFor(size.width, size.height), size, lit ? DIMMED : 1, (target) => {
      world(target)
      target.lineJoin = "round"
      for (const net of byNet(routes, netOf)) {
        target.save()
        target.globalCompositeOperation = "destination-out"
        target.strokeStyle = "#000"
        target.lineCap = "butt"
        clipCasings(target, masks, net, view, grid, screenPx(casingWidth(SELECTED_WIRE_PX)))
        for (const route of net) {
          target.lineWidth = screenPx(casingWidth(widthOf(route.id)))
          target.stroke(casingPath(route, radius, trim))
        }
        target.restore()
        target.lineCap = "round"
        for (const route of net) {
          target.strokeStyle = colorFor(colorOf(route.id))
          target.lineWidth = screenPx(widthOf(route.id))
          target.stroke(wirePath(route, radius))
        }
      }
    })
  }

  const turned = !!marks && (marks.corners.length > 0 || routes.some((r) => r.leads))
  onLayer(context, objects.length ? scratchFor(size.width, size.height) : null, size, 1, (target) => {
    for (const object of objects) {
      const def = getDef(object.def)
      if (!def) continue
      const symbol = raster.get(def, orientationOf(object), grid, pixels)
      if (!symbol) continue
      const rect = objectRect(object, grid)
      target.globalAlpha = lit && !lit.has(object.id) ? DIMMED : 1
      target.drawImage(
        symbol.image,
        (rect.x - view.x) * pixels - symbol.originX,
        (rect.y - view.y) * pixels - symbol.originY,
        symbol.width,
        symbol.height,
      )
    }
    if (!turned || !marks) return
    target.save()
    world(target)
    cutTurnedLeads(target, routes, marks, { screenPx, grid })
    target.restore()
  })

  if (marks && (marks.dots.length || marks.open.length || turned)) {
    context.save()
    world(context)
    context.lineJoin = "round"
    if (lit) context.globalAlpha = DIMMED
    paintMarks(context, routes, marks, { radius, screenPx, pixels, device, grid, casing, ink: cssColor(host, "var(--foreground)"), colorFor, colorOf })
    context.restore()
  }
}
