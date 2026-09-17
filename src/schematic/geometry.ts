import { getDef, getPin } from "./registry"
import { SpatialIndex } from "./spatial"
import type { ComponentDef, PinDef, PinRef, PlacedObject, Point, Rotation, Side, Wire } from "./types"

export type { Point }

/** Grid pitch in world px. Object coordinates are snapped to it, so it is a document constant. */
export const GRID = 24

/** Outward direction of a pin once the component is rotated; 45° steps add the diagonals. */
export type Direction = Side | "top-right" | "bottom-right" | "bottom-left" | "top-left"

/** A pin as it sits on the field: rotated coordinates, and a direction that may be diagonal. */
export type PlacedPin = Omit<PinDef, "side" | "labelAt"> & { side: Direction; labelAt: Direction }

const DIRECTIONS: Direction[] = [
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
  "top-left",
]

// Exact for the eight steps: Math.cos(Math.PI / 2) is not quite zero, and the size of an
// unrotated component has to come out to exactly its own width and height.
const R = Math.SQRT1_2
const COS = [1, R, 0, -R, -1, -R, 0, R]
const SIN = [0, R, 1, R, 0, -R, -1, -R]

/** Direction after rotating clockwise by `rot`. */
export function rotateSide(side: Direction, rot: Rotation): Direction {
  return DIRECTIONS[(DIRECTIONS.indexOf(side) + rot / 45) % 8]
}

/** Size in cells of the rotated bounding box. On a diagonal it is the axis-aligned hull. */
export function objectSize(def: ComponentDef, rot: Rotation = 0) {
  const i = rot / 45
  const c = Math.abs(COS[i])
  const s = Math.abs(SIN[i])
  return { w: def.width * c + def.height * s, h: def.width * s + def.height * c }
}

/**
 * Pin cell coordinates and direction in the rotated frame (origin = rotated box top-left).
 * The pin is rotated about the component's centre, exactly as the rendered SVG is, so the
 * dot a wire attaches to always sits where the symbol draws it — off the grid on a diagonal.
 */
export function rotatePin(pin: PinDef, def: ComponentDef, rot: Rotation = 0): PlacedPin {
  const i = rot / 45
  const cos = COS[i]
  const sin = SIN[i]
  const dx = pin.x - def.width / 2
  const dy = pin.y - def.height / 2
  const box = objectSize(def, rot)
  return {
    ...pin,
    x: dx * cos - dy * sin + box.w / 2,
    y: dx * sin + dy * cos + box.h / 2,
    side: rotateSide(pin.side, rot),
    labelAt: rotateSide(pin.labelAt, rot),
  }
}
export type Rect = { x: number; y: number; w: number; h: number }

export const snap = (v: number, grid: number) => Math.round(v / grid) * grid

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** World-space bounding box of a placed object. */
export function objectRect(obj: PlacedObject, grid: number): Rect {
  const def = getDef(obj.def)
  if (!def) return { x: obj.x, y: obj.y, w: grid, h: grid }
  const { w, h } = objectSize(def, obj.rotation)
  return { x: obj.x, y: obj.y, w: w * grid, h: h * grid }
}

export type ObjectPin = { key: string; pin: PlacedPin; point: Point }

const placementOf = (obj: PlacedObject, grid: number) => `${obj.id}|${obj.def}|${obj.x}|${obj.y}|${obj.rotation ?? 0}|${grid}`

const placedPins = new WeakMap<PlacedObject, { placement: string; pins: readonly ObjectPin[] }>()

/**
 * Every pin of a placed object, in world coordinates. Used wherever pins have to be found by
 * position rather than by name: touching pins, hit-testing, contact dots.
 */
export function objectPins(obj: PlacedObject, grid: number): readonly ObjectPin[] {
  const placement = placementOf(obj, grid)
  const cached = placedPins.get(obj)
  if (cached && cached.placement === placement) return cached.pins
  const def = getDef(obj.def)
  const pins: readonly ObjectPin[] = def
    ? def.pins.map((raw) => {
        const pin = rotatePin(raw, def, obj.rotation)
        return { key: `${obj.id}:${pin.id}`, pin, point: { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid } }
      })
    : []
  placedPins.set(obj, { placement, pins })
  return pins
}

const PIXEL_KEY_SPAN = 1 << 25
const PIXEL_KEY_BIAS = 1 << 24

const pixelKey = (x: number, y: number) => (x + PIXEL_KEY_BIAS) * PIXEL_KEY_SPAN + (y + PIXEL_KEY_BIAS)

/**
 * Group pins that sit on the same point, so components placed pin-to-pin conduct without a
 * wire. Only an exact coincidence counts: a wire or a symbol merely passing over a pin is not
 * a connection. Returns every such pin keyed to its group's representative.
 */
export function pinContacts(objects: readonly PlacedObject[], grid: number): Map<string, string> {
  // Bucket by whole pixel, then compare against the neighbouring buckets, so the sweep stays
  // linear however many pins a board has.
  const buckets = new Map<number, ObjectPin[]>()
  for (const obj of objects) {
    for (const placed of objectPins(obj, grid)) {
      if (placed.pin.kind === "nc") continue
      const at = pixelKey(Math.round(placed.point.x), Math.round(placed.point.y))
      const bucket = buckets.get(at)
      if (bucket) bucket.push(placed)
      else buckets.set(at, [placed])
    }
  }
  const EPS = 0.01
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k)
    if (p === undefined || p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  // Every key that takes part is recorded, the group's representative included: callers sum
  // terminal currents over a group, so a missing member would silently lose its current.
  const joined = new Set<string>()
  const union = (a: string, b: string) => {
    joined.add(a)
    joined.add(b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const touching = (a: ObjectPin, b: ObjectPin) =>
    a.key !== b.key && Math.abs(a.point.x - b.point.x) < EPS && Math.abs(a.point.y - b.point.y) < EPS
  const near: ObjectPin[] = []
  for (const [at, bucket] of buckets) {
    near.length = 0
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue
        const other = buckets.get(at + dx * PIXEL_KEY_SPAN + dy)
        if (other) for (const placed of other) near.push(placed)
      }
    }
    for (const a of bucket) {
      for (const b of bucket) if (touching(a, b)) union(a.key, b.key)
      for (const b of near) if (touching(a, b)) union(a.key, b.key)
    }
  }
  const contacts = new Map<string, string>()
  for (const key of joined) contacts.set(key, find(key))
  return contacts
}

/** World-space center of a pin. */
export function pinPoint(obj: PlacedObject, pinId: string, grid: number): Point | null {
  const def = getDef(obj.def)
  const raw = def && getPin(def, pinId)
  if (!def || !raw) return null
  const pin = rotatePin(raw, def, obj.rotation)
  return { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid }
}

const objectIndexes = new WeakMap<readonly PlacedObject[], { size: number; byId: Map<string, PlacedObject> }>()

export function objectIndex(objects: readonly PlacedObject[]): ReadonlyMap<string, PlacedObject> {
  const cached = objectIndexes.get(objects)
  if (cached && cached.size === objects.length) return cached.byId
  const byId = new Map<string, PlacedObject>()
  for (const o of objects) if (!byId.has(o.id)) byId.set(o.id, o)
  objectIndexes.set(objects, { size: objects.length, byId })
  return byId
}

/** Object, definition and the pin as seen on the field (rotation applied). */
export function resolvePin(objects: readonly PlacedObject[], ref: PinRef, grid: number) {
  return resolvePinIn(objectIndex(objects), ref, grid)
}

/** Unit vector pointing away from the component, per pin direction. */
export const DIR: Record<Direction, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  "top-left": { x: -R, y: -R },
  "top-right": { x: R, y: -R },
  "bottom-right": { x: R, y: R },
  "bottom-left": { x: -R, y: R },
}

/**
 * Which axis a wire continues along after leaving the pin. A diagonal pin has no axis of its
 * own, so it follows whichever way the other end lies: `to` is the point it is heading for.
 */
function isHorizontal(s: Direction, from?: Point, to?: Point) {
  if (s === "left" || s === "right") return true
  if (s === "top" || s === "bottom") return false
  if (!from || !to) return true
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
}

export type Route = {
  pts: Point[]
  /**
   * For each segment pts[i]→pts[i+1], the index of the user bend point it precedes:
   * 0 = before the first bend, points.length = after the last. Used to insert bends.
   */
  owner: number[]
}

/**
 * Where the wire's stub leaves the pin. A diagonal pin sits off the grid — a lead of n cells
 * rotated 45° spans n/√2 — so its stub end is snapped back onto the grid: the pin stays exactly
 * where the symbol draws it, everything downstream stays orthogonal, and two diagonal pins
 * meeting at a corner land their stubs on the same node.
 */
const stubEnd = (p: Point, side: Direction, stub: number, grid: number): Point => {
  const d = DIR[side]
  const end = { x: p.x + d.x * stub * grid, y: p.y + d.y * stub * grid }
  return d.x !== 0 && d.y !== 0 ? { x: snap(end.x, grid), y: snap(end.y, grid) } : end
}

/**
 * Orthogonal route between two pins through optional user bend points.
 * A stub leaves each pin; consecutive anchors are joined with an L that first
 * continues the incoming axis, so a chain of aligned bends stays straight.
 * Without bend points the two stub ends are joined with a centered two-bend path.
 */
export function routeWire(
  a: Point,
  aSide: Direction,
  aStub: number,
  b: Point,
  bSide: Direction,
  bStub: number,
  grid: number,
  points: Point[] = [],
  avoid: Rect[] = [],
): Route {
  const a1 = stubEnd(a, aSide, aStub, grid)
  const b1 = stubEnd(b, bSide, bStub, grid)
  const pts: Point[] = [a, a1]
  const owner: number[] = [0]
  let horizontal = isHorizontal(aSide, a1, points[0] ?? b1)

  if (points.length === 0) {
    for (const m of autoRoute(a1, aSide, b1, bSide, grid, avoid)) {
      pts.push(m)
      owner.push(0)
    }
    // Through the far stub end; a duplicate point is dropped below.
    pts.push(b1)
    owner.push(0)
  } else {
    const anchors = [...points, b1]
    // Incoming direction; the first leg of each L keeps it unless that would double back.
    let dir: Point = DIR[aSide]
    for (let i = 0; i < anchors.length; i++) {
      const q = anchors[i]
      const p = pts[pts.length - 1]
      if (p.x !== q.x && p.y !== q.y) {
        const goHorizontalFirst = horizontal
          ? Math.sign(q.x - p.x) === Math.sign(dir.x) // continuing does not reverse
          : Math.sign(q.y - p.y) !== Math.sign(dir.y) // continuing vertical would reverse
        pts.push(goHorizontalFirst ? { x: q.x, y: p.y } : { x: p.x, y: q.y })
        owner.push(i)
      }
      const last = pts[pts.length - 1]
      dir = { x: Math.sign(q.x - last.x), y: Math.sign(q.y - last.y) }
      horizontal = last.y === q.y
      pts.push(q)
      owner.push(i)
    }
  }
  if (points.length > 0 && pts[pts.length - 1] !== b1) {
    pts.push(b1)
    owner.push(points.length)
  }
  pts.push(b)
  owner.push(points.length)
  return dedupeRoute(pts, owner)
}

const MID_LINE_STEPS_FROM_CENTRE = 6
const MID_LINE_STEPS_PAST_END = 4

/**
 * Interior points of the automatic route between two stub ends: a centred Z when both stubs
 * point the same way, an L otherwise. When that path runs over another component's body, the
 * mid line is moved — first between the ends, then past them — to the nearest position that
 * clears every body, or the one crossing fewest if none does.
 */
function autoRoute(a1: Point, aSide: Direction, b1: Point, bSide: Direction, grid: number, avoid: Rect[]): Point[] {
  const ah = isHorizontal(aSide, a1, b1)
  const bh = isHorizontal(bSide, b1, a1)
  const zx = (mx: number): Point[] => [
    { x: mx, y: a1.y },
    { x: mx, y: b1.y },
  ]
  const zy = (my: number): Point[] => [
    { x: a1.x, y: my },
    { x: b1.x, y: my },
  ]
  const preferred: Point[] =
    ah && bh ? zx(snap((a1.x + b1.x) / 2, grid)) : !ah && !bh ? zy(snap((a1.y + b1.y) / 2, grid)) : ah ? [{ x: b1.x, y: a1.y }] : [{ x: a1.x, y: b1.y }]
  if (avoid.length === 0 || crossings(a1, preferred, b1, avoid) === 0) return preferred

  // Alternatives, nearest first: the mid line stepped away from centre, then beyond both ends.
  const lines = (lo: number, hi: number) => {
    const c = snap((lo + hi) / 2, grid)
    const out = [c]
    for (let k = 1; k <= MID_LINE_STEPS_FROM_CENTRE; k++) out.push(c + k * grid, c - k * grid)
    for (let k = 1; k <= MID_LINE_STEPS_PAST_END; k++) out.push(Math.max(lo, hi) + k * grid, Math.min(lo, hi) - k * grid)
    return out
  }
  const candidates: Point[][] = [{ x: b1.x, y: a1.y }, { x: a1.x, y: b1.y }].map((p) => [p])
  for (const mx of lines(a1.x, b1.x)) candidates.push(zx(mx))
  for (const my of lines(a1.y, b1.y)) candidates.push(zy(my))
  let best = preferred
  let bestCost = crossings(a1, preferred, b1, avoid) * 1e6 + length(a1, preferred, b1)
  for (const c of candidates) {
    const cost = crossings(a1, c, b1, avoid) * 1e6 + length(a1, c, b1)
    if (cost < bestCost) {
      best = c
      bestCost = cost
    }
  }
  return best
}

function length(a1: Point, mid: Point[], b1: Point) {
  const pts = [a1, ...mid, b1]
  let sum = 0
  for (let i = 1; i < pts.length; i++) sum += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
  return sum
}

/** How many body rectangles the orthogonal path a1 → mid… → b1 runs through (edges do not count). */
function crossings(a1: Point, mid: Point[], b1: Point, avoid: Rect[]) {
  const pts = [a1, ...mid, b1]
  let n = 0
  for (const r of avoid) {
    const x0 = r.x + 0.5
    const x1 = r.x + r.w - 0.5
    const y0 = r.y + 0.5
    const y1 = r.y + r.h - 0.5
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1]
      const q = pts[i]
      const hit =
        p.y === q.y
          ? p.y > y0 && p.y < y1 && Math.max(p.x, q.x) > x0 && Math.min(p.x, q.x) < x1
          : p.x > x0 && p.x < x1 && Math.max(p.y, q.y) > y0 && Math.min(p.y, q.y) < y1
      if (hit) {
        n++
        break
      }
    }
  }
  return n
}

/** Body rectangles a wire between two objects must stay out of: everyone else's. */
export function routeObstacles(objects: readonly PlacedObject[], grid: number, from: string, to: string): Rect[] {
  const out: Rect[] = []
  for (const o of objects) if (o.id !== from && o.id !== to) out.push(objectRect(o, grid))
  return out
}

/** Route from a pin through bend points to a free cursor position (while placing a wire). */
export function routeToPoint(a: Point, aSide: Direction, aStub: number, p: Point, grid: number, points: Point[] = []): Point[] {
  const a1 = stubEnd(a, aSide, aStub, grid)
  const pts: Point[] = [a, a1]
  let horizontal = isHorizontal(aSide, a1, points[0] ?? p)
  let dir: Point = DIR[aSide]
  for (const q of [...points, p]) {
    const last = pts[pts.length - 1]
    if (last.x !== q.x && last.y !== q.y) {
      const goHorizontalFirst = horizontal
        ? Math.sign(q.x - last.x) === Math.sign(dir.x)
        : Math.sign(q.y - last.y) !== Math.sign(dir.y)
      pts.push(goHorizontalFirst ? { x: q.x, y: last.y } : { x: last.x, y: q.y })
    }
    const bend = pts[pts.length - 1]
    dir = { x: Math.sign(q.x - bend.x), y: Math.sign(q.y - bend.y) }
    horizontal = bend.y === q.y
    pts.push(q)
  }
  return dedupe(pts)
}

export function toPath(pts: Point[], radius = 0): string {
  if (pts.length === 0) return ""
  if (radius <= 0 || pts.length < 3) return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")
  const out: string[] = [`M${pts[0].x} ${pts[0].y}`]
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]
    const c = pts[i]
    const n = pts[i + 1]
    const inLen = Math.hypot(c.x - p.x, c.y - p.y)
    const outLen = Math.hypot(n.x - c.x, n.y - c.y)
    const cross = (c.x - p.x) * (n.y - c.y) - (c.y - p.y) * (n.x - c.x)
    if (!inLen || !outLen || Math.abs(cross) < 1e-9) {
      out.push(`L${c.x} ${c.y}`)
      continue
    }
    const r = Math.min(radius, inLen / 2, outLen / 2)
    const a = { x: c.x - ((c.x - p.x) / inLen) * r, y: c.y - ((c.y - p.y) / inLen) * r }
    const b = { x: c.x + ((n.x - c.x) / outLen) * r, y: c.y + ((n.y - c.y) / outLen) * r }
    out.push(`L${a.x} ${a.y}`, `Q${c.x} ${c.y} ${b.x} ${b.y}`)
  }
  const last = pts[pts.length - 1]
  out.push(`L${last.x} ${last.y}`)
  return out.join(" ")
}

function dedupe(pts: Point[]): Point[] {
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y)
}

function dedupeRoute(pts: Point[], owner: number[]): Route {
  const outPts: Point[] = []
  const outOwner: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const prev = outPts[outPts.length - 1]
    if (prev && prev.x === pts[i].x && prev.y === pts[i].y) continue
    outPts.push(pts[i])
    if (i > 0) outOwner.push(owner[i - 1])
  }
  return { pts: outPts, owner: outOwner }
}

export type RoutedWire = {
  id: string
  pts: Point[]
  owner: number[]
}

const SNAP_ERROR_CELLS = 0.5
const ROUTE_SLACK_CELLS = 1
const ROUTE_REACH_CELLS = Math.max(MID_LINE_STEPS_FROM_CENTRE + SNAP_ERROR_CELLS, MID_LINE_STEPS_PAST_END) + ROUTE_SLACK_CELLS

export function routeArea(a: Point, aStub: number, b: Point, bStub: number, bends: readonly Point[], grid: number): Rect {
  let minX = Math.min(a.x, b.x)
  let maxX = Math.max(a.x, b.x)
  let minY = Math.min(a.y, b.y)
  let maxY = Math.max(a.y, b.y)
  for (const p of bends) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  const reach = (Math.max(aStub, bStub) + ROUTE_REACH_CELLS) * grid
  return { x: minX - reach, y: minY - reach, w: maxX - minX + 2 * reach, h: maxY - minY + 2 * reach }
}

type CachedRoute = { signature: string; route: RoutedWire }

export class Router {
  private routes = new Map<string, CachedRoute>()

  routeAll(objects: readonly PlacedObject[], wires: readonly Wire[], grid: number): RoutedWire[] {
    const byId = objectIndex(objects)
    const bodies = new SpatialIndex(objects, grid)
    const kept = new Map<string, CachedRoute>()
    const out: RoutedWire[] = []
    for (const w of wires) {
      const a = resolvePinIn(byId, w.from, grid)
      const b = resolvePinIn(byId, w.to, grid)
      if (!a || !b) continue
      const aStub = a.pin.stub ?? 1
      const bStub = b.pin.stub ?? 1
      const bends = w.points ?? []
      const avoid: Rect[] = []
      let signature = `${grid}:${a.point.x},${a.point.y},${a.pin.side},${aStub}/${b.point.x},${b.point.y},${b.pin.side},${bStub}`
      for (const p of bends) signature += `/${p.x},${p.y}`
      for (const o of bodies.query(routeArea(a.point, aStub, b.point, bStub, bends, grid))) {
        if (o.id === w.from.object || o.id === w.to.object) continue
        avoid.push(objectRect(o, grid))
        signature += `|${o.id}@${o.def},${o.x},${o.y},${o.rotation ?? 0}`
      }
      const cached = this.routes.get(w.id)
      if (cached && cached.signature === signature) {
        kept.set(w.id, cached)
        out.push(cached.route)
        continue
      }
      const { pts, owner } = routeWire(a.point, a.pin.side, aStub, b.point, b.pin.side, bStub, grid, bends, avoid)
      const route: RoutedWire = { id: w.id, pts, owner }
      kept.set(w.id, { signature, route })
      out.push(route)
    }
    this.routes = kept
    return out
  }
}

const defaultRouter = new Router()

export function routeAll(objects: readonly PlacedObject[], wires: readonly Wire[], grid: number): RoutedWire[] {
  return defaultRouter.routeAll(objects, wires, grid)
}

export function resolvePinIn(index: ReadonlyMap<string, PlacedObject>, ref: PinRef, grid: number) {
  const obj = index.get(ref.object)
  if (!obj) return null
  const def = getDef(obj.def)
  const raw = def && getPin(def, ref.pin)
  if (!def || !raw) return null
  const pin = rotatePin(raw, def, obj.rotation)
  return { obj, def, pin, point: { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid } }
}

const NUDGE_STEP = 1 / 3
const NUDGE_MAX = 1 / 2

type Axis = "h" | "v"

const axisOf = (p: Point, q: Point): Axis | null => (p.y === q.y ? "h" : p.x === q.x ? "v" : null)

type Seg = {
  wire: number
  at: number
  net: string
  axis: Axis
  lo: number
  hi: number
  lean: number
}

/**
 * Separate collinear runs of different nets that share a corridor, libavoid's stage 3 in its
 * cheap form. Each nudged segment is offset sideways on a centred ladder; where a run changes
 * offset along its length, or meets a stub that must stay put, a short jog keeps the route
 * orthogonal. Pins and the direction a wire leaves them are never touched.
 */
export function nudgeRoutes(routes: RoutedWire[], netOf: (wireId: string) => string | undefined, grid: number): RoutedWire[] {
  const segs: Seg[] = []
  routes.forEach((r, wire) => {
    const net = netOf(r.id) ?? r.id
    for (let at = 1; at < r.pts.length - 2; at++) {
      const p = r.pts[at]
      const q = r.pts[at + 1]
      const axis = axisOf(p, q)
      if (!axis) continue
      const before = r.pts[at - 1]
      const after = r.pts[at + 2]
      const lean = axis === "h" ? (before.y + after.y) / 2 - p.y : (before.x + after.x) / 2 - p.x
      const [lo, hi] = axis === "h" ? [Math.min(p.x, q.x), Math.max(p.x, q.x)] : [Math.min(p.y, q.y), Math.max(p.y, q.y)]
      segs.push({ wire, at, net, axis, lo, hi, lean })
    }
  })

  const lanes = new Map<string, Seg[]>()
  for (const s of segs) {
    const p = routes[s.wire].pts[s.at]
    const key = `${s.axis}${Math.round(s.axis === "h" ? p.y : p.x)}`
    const list = lanes.get(key)
    if (list) list.push(s)
    else lanes.set(key, [s])
  }

  const offset = new Map<string, number>()
  const separate = (cluster: Seg[]) => {
    const nets = [...new Set(cluster.map((s) => s.net))]
    if (nets.length < 2) return
    nets.sort((a, b) => meanLean(cluster, a) - meanLean(cluster, b))
    const step = Math.min(NUDGE_STEP * grid, (2 * NUDGE_MAX * grid) / (nets.length - 1))
    const span = (nets.length - 1) / 2
    const deltaOf = new Map(nets.map((net, i) => [net, (i - span) * step]))
    for (const s of cluster) {
      const delta = deltaOf.get(s.net) ?? 0
      if (delta) offset.set(`${s.wire}:${s.at}`, delta)
    }
  }
  for (const list of lanes.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => a.lo - b.lo)
    let cluster: Seg[] = []
    let end = -Infinity
    for (const s of list) {
      if (cluster.length && s.lo >= end) {
        separate(cluster)
        cluster = []
      }
      cluster.push(s)
      end = Math.max(end, s.hi)
    }
    separate(cluster)
  }

  if (offset.size === 0) return routes
  return routes.map((r, wire) => applyOffsets(r, (at) => offset.get(`${wire}:${at}`) ?? 0))
}

function meanLean(cluster: Seg[], net: string): number {
  let sum = 0
  let n = 0
  for (const s of cluster) {
    if (s.net !== net) continue
    sum += s.lean
    n++
  }
  return n ? sum / n : 0
}

/**
 * Rebuild a route with each segment moved sideways by its offset. A corner takes both of its
 * segments' offsets, one per axis; two collinear segments with different offsets, or a run
 * next to a stub that is not allowed to move, are joined by a jog.
 */
function applyOffsets(r: RoutedWire, offsetOf: (segment: number) => number): RoutedWire {
  const { pts, owner } = r
  const last = pts.length - 1
  let touched = false
  for (let i = 0; i < last; i++) if (offsetOf(i)) touched = true
  if (!touched) return r

  const moved = (segment: number, p: Point): Point => {
    const d = offsetOf(segment)
    if (!d) return p
    const axis = axisOf(pts[segment], pts[segment + 1])
    if (axis === "h") return { x: p.x, y: p.y + d }
    if (axis === "v") return { x: p.x + d, y: p.y }
    return p
  }

  const outPts: Point[] = [pts[0]]
  const outOwner: number[] = []
  for (let i = 1; i < last; i++) {
    const inAxis = axisOf(pts[i - 1], pts[i])
    const outAxis = axisOf(pts[i], pts[i + 1])
    const turns = inAxis !== null && outAxis !== null && inAxis !== outAxis
    if (turns) {
      outPts.push(moved(i, moved(i - 1, pts[i])))
      outOwner.push(owner[i - 1])
      continue
    }
    outPts.push(moved(i - 1, pts[i]))
    outOwner.push(owner[i - 1])
    if (offsetOf(i - 1) !== offsetOf(i)) {
      outPts.push(moved(i, pts[i]))
      outOwner.push(owner[i])
    }
  }
  outPts.push(pts[last])
  outOwner.push(owner[last - 1])
  return { ...r, pts: outPts, owner: outOwner }
}

/** Index of the polyline segment closest to a point. */
export function nearestSegment(pts: Point[], p: Point): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}
