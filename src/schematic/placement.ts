import { DIR, intersects, objectPins, objectRect, objectSize, orientationOf, orientOffset, placedText, resolvePinIn, routeBox, snap, type Point, type Rect, type RoutedWire } from "./geometry"
import { getDef } from "./registry"
import { pinLabelKnockout } from "@/components/field/pin-label"
import type { BodyShape, ComponentDef, PinRef, PlacedObject, Wire } from "./types"

const CLEARANCE_CELLS = 0.1
const TEXT_ADVANCE_EM = 0.55
const TEXT_INSET_CELLS = 0.04
const EPSILON = 1e-6
const SEARCH_RINGS = 24

const COMMAND = /[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g
const PAIRS: Record<string, number> = { M: 1, L: 1, T: 1, C: 3, S: 2, Q: 2 }

function pathPoints(d: string): Point[] {
  const tokens = d.match(COMMAND) ?? []
  const points: Point[] = []
  let at = { x: 0, y: 0 }
  let start = at
  let command = "M"
  let i = 0
  const number = () => Number(tokens[i++])
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) command = tokens[i++]
    const upper = command.toUpperCase()
    const relative = command !== upper
    const base = relative ? at : { x: 0, y: 0 }
    if (upper === "Z") {
      at = start
      continue
    }
    if (upper === "H") at = { x: base.x + number(), y: at.y }
    else if (upper === "V") at = { x: at.x, y: base.y + number() }
    else if (upper === "A") {
      const rx = number()
      const ry = number()
      i += 3
      at = { x: base.x + number(), y: base.y + number() }
      points.push({ x: at.x - rx, y: at.y - ry }, { x: at.x + rx, y: at.y + ry })
    } else {
      for (let k = 0; k < (PAIRS[upper] ?? 1); k++) {
        const p = { x: base.x + number(), y: base.y + number() }
        points.push(p)
        at = p
      }
    }
    points.push(at)
    if (upper === "M") {
      start = at
      command = relative ? "l" : "L"
    }
  }
  return points
}

function shapePoints(shape: BodyShape): Point[] {
  if (shape.type === "text") return []
  if (shape.type === "rect") return [{ x: shape.x, y: shape.y }, { x: shape.x + shape.w, y: shape.y + shape.h }]
  if (shape.type === "circle") return [{ x: shape.cx - shape.r, y: shape.cy - shape.r }, { x: shape.cx + shape.r, y: shape.cy + shape.r }]
  return pathPoints(shape.d)
}

const bounds = new WeakMap<ComponentDef, Rect>()

export function bodyBounds(def: ComponentDef): Rect {
  const cached = bounds.get(def)
  if (cached) return cached
  const points = [...def.body.flatMap(shapePoints), ...def.pins.map((pin) => ({ x: pin.x, y: pin.y }))]
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const rect = points.length
    ? { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    : { x: 0, y: 0, w: def.width, h: def.height }
  bounds.set(def, rect)
  return rect
}

type Quad = { corners: Point[]; box: Rect }

function frameOf(object: PlacedObject, def: ComponentDef, grid: number) {
  const orientation = orientationOf(object)
  const size = objectSize(def, orientation.rotation)
  const origin = objectRect(object, grid)
  return ({ x, y }: Point): Point => {
    const at = orientOffset({ x: x - def.width / 2, y: y - def.height / 2 }, orientation)
    return { x: origin.x + (at.x + size.w / 2) * grid, y: origin.y + (at.y + size.h / 2) * grid }
  }
}

function rectQuad(r: Rect): Quad {
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
  return { corners, box: r }
}

const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

function propsOf(def: ComponentDef, object: PlacedObject): Record<string, string> {
  const props = { ...def.defaults, ...object.props }
  return def.derive ? { ...props, ...def.derive(props) } : props
}

function textRectsOf(object: PlacedObject, def: ComponentDef, grid: number): Rect[] {
  const at = frameOf(object, def, grid)
  const orientation = orientationOf(object)
  const props = propsOf(def, object)
  const inset = TEXT_INSET_CELLS * grid
  const rects: Rect[] = []
  for (const shape of def.body) {
    if (shape.type !== "text") continue
    const text = shape.text.replace(/\{(\w+)\}/g, (_, key: string) => props[key] ?? "")
    if (!text.trim()) continue
    const size = (shape.size ?? 0.4) * grid
    const w = text.length * TEXT_ADVANCE_EM * size
    const anchor = at({ x: shape.x, y: shape.y })
    const placed = placedText(shape.anchor ?? "middle", shape.rotate ?? 0, orientation)
    const start = placed.anchor === "start" ? 0 : placed.anchor === "end" ? -w : -w / 2
    const along = { x: start + inset, w: w - inset * 2 }
    const across = { y: -size / 2 + inset, h: size - inset * 2 }
    rects.push(
      placed.angle === 0
        ? { x: anchor.x + along.x, y: anchor.y + across.y, w: along.w, h: across.h }
        : { x: anchor.x + across.y, y: anchor.y - along.x - along.w, w: across.h, h: along.w },
    )
  }
  return rects
}

function pinNameRects(object: PlacedObject, grid: number): Rect[] {
  const inset = TEXT_INSET_CELLS * grid
  const rects: Rect[] = []
  for (const { pin, point } of objectPins(object, grid)) {
    if (!pin.label) continue
    const box = pinLabelKnockout(pin.label, pin.labelAt, 1).text
    rects.push({ x: point.x + box.x * grid + inset, y: point.y + box.y * grid + inset, w: box.w * grid - inset * 2, h: box.h * grid - inset * 2 })
  }
  return rects
}

const outsideBody = (object: PlacedObject, rects: readonly Rect[], grid: number) => {
  const body = footprint(object, grid)
  return body ? rects.filter((r) => r.w > 0 && r.h > 0 && !inside(r, body.box)) : []
}

const labelCache = new WeakMap<PlacedObject, { grid: number; rects: readonly Rect[] }>()

export function designatorRects(object: PlacedObject, grid: number): readonly Rect[] {
  const cached = labelCache.get(object)
  if (cached && cached.grid === grid) return cached.rects
  const def = getDef(object.def)
  const rects = def && !isJunction(object) ? outsideBody(object, textRectsOf(object, def, grid), grid) : []
  labelCache.set(object, { grid, rects })
  return rects
}

export function footprints(object: PlacedObject, grid: number): { body: Quad; labels: Quad[] } | null {
  const body = footprint(object, grid)
  const def = getDef(object.def)
  if (!body || !def || body.box.w <= 0 || body.box.h <= 0) return null
  const labels = [...designatorRects(object, grid), ...outsideBody(object, pinNameRects(object, grid), grid)]
  return { body, labels: labels.map(rectQuad) }
}

export function footprint(object: PlacedObject, grid: number): Quad | null {
  const def = getDef(object.def)
  if (!def) return null
  const b = bodyBounds(def)
  const inset = Math.min(CLEARANCE_CELLS, b.w / 2, b.h / 2)
  const corners = [
    { x: b.x + inset, y: b.y + inset },
    { x: b.x + b.w - inset, y: b.y + inset },
    { x: b.x + b.w - inset, y: b.y + b.h - inset },
    { x: b.x + inset, y: b.y + b.h - inset },
  ].map(frameOf(object, def, grid))
  return { corners, box: boxOf(corners) }
}

function boxOf(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

const moved = (q: Quad, dx: number, dy: number): Quad => ({ corners: q.corners.map((p) => ({ x: p.x + dx, y: p.y + dy })), box: { x: q.box.x + dx, y: q.box.y + dy, w: q.box.w, h: q.box.h } })

function axesOf(points: readonly Point[]): Point[] {
  const axes: Point[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len > 0) axes.push({ x: -(q.y - p.y) / len, y: (q.x - p.x) / len })
  }
  return axes
}

function separated(a: readonly Point[], b: readonly Point[]) {
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    const pa = a.map((p) => p.x * axis.x + p.y * axis.y)
    const pb = b.map((p) => p.x * axis.x + p.y * axis.y)
    if (Math.max(...pa) <= Math.min(...pb) + EPSILON || Math.max(...pb) <= Math.min(...pa) + EPSILON) return true
  }
  return false
}

const overlap = (a: readonly Point[], b: readonly Point[]) => !separated(a, b)

const socketed = (a: PlacedObject, b: PlacedObject) => !!(getDef(a.def)?.pinsAreSockets || getDef(b.def)?.pinsAreSockets)

function touchingPins(a: PlacedObject, b: PlacedObject, grid: number) {
  const pins = objectPins(b, grid)
  return objectPins(a, grid).some(({ point }) => pins.some((other) => Math.abs(other.point.x - point.x) < EPSILON && Math.abs(other.point.y - point.y) < EPSILON))
}

export type PlacementScene = {
  objects: readonly PlacedObject[]
  wires: readonly Wire[]
  routes: readonly RoutedWire[]
  grid: number
}

type Placed = { object: PlacedObject; body: Quad; labels: Quad[]; box: Rect }

const isJunction = (object: PlacedObject) => {
  const pins = getDef(object.def)?.pins ?? []
  return pins.length > 0 && pins.every((pin) => pin.kind === "node")
}

function union(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y }
}

function reachOf(segments: readonly Point[][], dx: number, dy: number): Rect {
  if (!segments.length) return { x: 0, y: 0, w: 0, h: 0 }
  const b = boxOf(segments.flat())
  return { x: b.x + dx - 1, y: b.y + dy - 1, w: b.w + 2, h: b.h + 2 }
}

export function placementCheck(scene: PlacementScene, moving: readonly PlacedObject[]): (dx: number, dy: number) => boolean {
  const ids = new Set(moving.map((o) => o.id))
  const place = (object: PlacedObject): Placed | null => {
    if (isJunction(object)) return null
    const f = footprints(object, scene.grid)
    return f ? { object, ...f, box: union([f.body.box, ...f.labels.map((q) => q.box)]) } : null
  }
  const movers = moving.map(place).filter((p): p is Placed => p !== null)
  const others = scene.objects.filter((o) => !ids.has(o.id)).map(place).filter((p): p is Placed => p !== null)
  const byId = new Map(scene.objects.map((o) => [o.id, o]))
  const stubOf = (ref: PinRef): Point[] | null => {
    const found = resolvePinIn(byId, ref, scene.grid)
    if (!found) return null
    const d = DIR[found.pin.side]
    const stub = (found.pin.stub ?? 1) * scene.grid
    return [found.point, { x: found.point.x + d.x * stub, y: found.point.y + d.y * stub }]
  }
  const attached = new Set(scene.wires.filter((w) => ids.has(w.from.object) || ids.has(w.to.object)).map((w) => w.id))
  const routes = scene.routes.filter((r) => !attached.has(r.id)).map((route) => ({ route, box: routeBox(route) }))
  const routeById = new Map(scene.routes.map((r) => [r.id, r]))
  const carried: { segment: Point[]; target: string | null }[] = []
  const anchored: Point[][] = []
  for (const w of scene.wires) {
    const fromMoves = ids.has(w.from.object)
    const toMoves = ids.has(w.to.object)
    if (fromMoves && toMoves) {
      const route = routeById.get(w.id)
      if (route) for (let i = 1; i < route.pts.length; i++) carried.push({ segment: [route.pts[i - 1], route.pts[i]], target: null })
    } else if (fromMoves || toMoves) {
      const [near, far] = fromMoves ? [w.from, w.to] : [w.to, w.from]
      const moving = stubOf(near)
      const fixed = stubOf(far)
      if (moving) carried.push({ segment: moving, target: far.object })
      if (fixed) anchored.push(fixed)
    }
  }
  if (!movers.length || (!others.length && !routes.length && !anchored.length)) return () => false
  const area = union(movers.map((m) => m.box))
  const hit = (a: Quad, b: Quad) => intersects(a.box, b.box) && overlap(a.corners, b.corners)
  const hitsAny = (a: Quad, list: readonly Quad[]) => list.some((b) => hit(a, b))
  const collide = (m: Placed, o: Placed, touching: boolean) =>
    hit(m.body, o.body) || (!touching && (hitsAny(m.body, o.labels) || hitsAny(o.body, m.labels)))
  return (dx, dy) => {
    const reach = { x: area.x + dx, y: area.y + dy, w: area.w, h: area.h }
    const placed = movers.map((m) => ({
      object: { ...m.object, x: m.object.x + dx, y: m.object.y + dy },
      body: moved(m.body, dx, dy),
      labels: m.labels.map((q) => moved(q, dx, dy)),
      box: { x: m.box.x + dx, y: m.box.y + dy, w: m.box.w, h: m.box.h },
    }))
    for (const other of others) {
      if (!intersects(other.box, reach)) continue
      for (const m of placed) {
        if (!intersects(m.box, other.box)) continue
        const touching = touchingPins(m.object, other.object, scene.grid)
        if (!collide(m, other, touching)) continue
        if (!touching || !socketed(m.object, other.object)) return true
      }
    }
    for (const other of others) {
      if (!intersects(other.box, reachOf(carried.map((c) => c.segment), dx, dy))) continue
      for (const { segment: [p, q], target } of carried) {
        const segment = [
          { x: p.x + dx, y: p.y + dy },
          { x: q.x + dx, y: q.y + dy },
        ]
        if (other.labels.some((l) => overlap(segment, l.corners))) return true
        if (target !== other.object.id && overlap(segment, other.body.corners)) return true
      }
    }
    for (const segment of anchored) {
      for (const m of placed) {
        if (m.labels.some((l) => overlap(segment, l.corners))) return true
      }
    }
    for (const { route, box } of routes) {
      if (!intersects(box, reach)) continue
      for (const m of placed) {
        if (!intersects(box, m.box)) continue
        for (let i = 1; i < route.pts.length; i++) {
          const segment = [route.pts[i - 1], route.pts[i]]
          if (overlap(segment, m.body.corners) || m.labels.some((q) => overlap(segment, q.corners))) return true
        }
      }
    }
    return false
  }
}

const pinKey = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`

export function contactCheck(scene: PlacementScene, moving: readonly PlacedObject[]): (dx: number, dy: number) => boolean {
  const ids = new Set(moving.map((o) => o.id))
  const fixed = new Set<string>()
  for (const o of scene.objects) if (!ids.has(o.id)) for (const { point } of objectPins(o, scene.grid)) fixed.add(pinKey(point.x, point.y))
  const pins = moving.flatMap((o) => objectPins(o, scene.grid).map(({ point }) => point))
  return (dx, dy) => pins.some((p) => fixed.has(pinKey(p.x + dx, p.y + dy)))
}

type Refuse = (dx: number, dy: number) => boolean

const refused = (refuse: readonly Refuse[], dx: number, dy: number) => refuse.some((r) => r(dx, dy))

export function freeOffset(refuse: readonly Refuse[], grid: number, from: Point = { x: 0, y: 0 }): Point | null {
  if (!refused(refuse, from.x, from.y)) return from
  for (let ring = 1; ring <= SEARCH_RINGS; ring++) {
    const found: Point[] = []
    for (let i = -ring; i <= ring; i++) {
      for (const [cx, cy] of [
        [i, -ring],
        [i, ring],
        [-ring, i],
        [ring, i],
      ]) {
        const at = { x: from.x + cx * grid, y: from.y + cy * grid }
        if (!refused(refuse, at.x, at.y)) found.push(at)
      }
    }
    if (found.length) return found.reduce((best, p) => (Math.hypot(p.x - from.x, p.y - from.y) < Math.hypot(best.x - from.x, best.y - from.y) ? p : best))
  }
  return null
}

export function landingOffset(refuse: readonly Refuse[], dx: number, dy: number, grid: number): Point | null {
  if (!refused(refuse, dx, dy)) return { x: dx, y: dy }
  const steps = Math.ceil(Math.hypot(dx, dy) / (grid / 2))
  let previous: Point | null = null
  for (let i = steps - 1; i >= 0; i--) {
    const at = { x: snap((dx * i) / steps, grid), y: snap((dy * i) / steps, grid) }
    if (previous && previous.x === at.x && previous.y === at.y) continue
    previous = at
    if (!refused(refuse, at.x, at.y)) return at
  }
  return freeOffset(refuse, grid, { x: dx, y: dy })
}
