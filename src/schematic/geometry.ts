import { bodyBounds } from "./body"
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

export type Orientation = { rotation: Rotation; mirror: boolean }

export const UPRIGHT: Orientation = { rotation: 0, mirror: false }

export const orientationOf = (obj: { rotation?: Rotation; mirror?: boolean }): Orientation => ({
  rotation: obj.rotation ?? 0,
  mirror: obj.mirror ?? false,
})

export type FlipAxis = "horizontal" | "vertical"

export function flipped({ rotation, mirror }: Orientation, axis: FlipAxis): Orientation {
  const turned = axis === "horizontal" ? 360 - rotation : 540 - rotation
  return { rotation: (turned % 360) as Rotation, mirror: !mirror }
}

const MIRRORED: Record<Direction, Direction> = {
  top: "top",
  bottom: "bottom",
  left: "right",
  right: "left",
  "top-left": "top-right",
  "top-right": "top-left",
  "bottom-left": "bottom-right",
  "bottom-right": "bottom-left",
}

export function orientSide(side: Direction, { rotation, mirror }: Orientation): Direction {
  return rotateSide(mirror ? MIRRORED[side] : side, rotation)
}

export function orientOffset(v: Point, { rotation, mirror }: Orientation): Point {
  const i = rotation / 45
  const x = mirror ? -v.x : v.x
  return { x: x * COS[i] - v.y * SIN[i], y: x * SIN[i] + v.y * COS[i] }
}

export function unorientOffset(v: Point, { rotation, mirror }: Orientation): Point {
  const i = rotation / 45
  const x = v.x * COS[i] + v.y * SIN[i]
  const y = -v.x * SIN[i] + v.y * COS[i]
  return { x: mirror ? -x : x, y }
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
export function orientPin(pin: PinDef, def: ComponentDef, orientation: Orientation = UPRIGHT): PlacedPin {
  const box = objectSize(def, orientation.rotation)
  const at = orientOffset({ x: pin.x - def.width / 2, y: pin.y - def.height / 2 }, orientation)
  return {
    ...pin,
    x: at.x + box.w / 2,
    y: at.y + box.h / 2,
    side: orientSide(pin.side, orientation),
    labelAt: orientSide(pin.labelAt, orientation),
  }
}

export type TextAnchor = "start" | "middle" | "end"

export type PlacedText = { angle: 0 | -90; anchor: TextAnchor }

export function placedText(anchor: TextAnchor, angle: number, orientation: Orientation): PlacedText {
  const turn = (angle * Math.PI) / 180
  const drawn = orientOffset({ x: Math.cos(turn), y: Math.sin(turn) }, orientation)
  const onItsSide = Math.abs(drawn.x) < Math.SQRT1_2 - 1e-9
  const readsBackwards = onItsSide ? drawn.y > 0 : drawn.x < 0
  const flipped: TextAnchor = anchor === "start" ? "end" : anchor === "end" ? "start" : anchor
  return { angle: onItsSide ? -90 : 0, anchor: readsBackwards ? flipped : anchor }
}
export type Rect = { x: number; y: number; w: number; h: number }

export const snap = (v: number, grid: number) => Math.round(v / grid) * grid

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const touches = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y

export function unionOf(rects: readonly Rect[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** World-space bounding box of a placed object. */
export function objectRect(obj: PlacedObject, grid: number): Rect {
  const def = getDef(obj.def)
  if (!def) return { x: obj.x, y: obj.y, w: grid, h: grid }
  const { w, h } = objectSize(def, obj.rotation)
  return { x: obj.x, y: obj.y, w: w * grid, h: h * grid }
}

export type ObjectPin = { key: string; pin: PlacedPin; point: Point }

const placementOf = (obj: PlacedObject, grid: number) => `${obj.id}|${obj.def}|${obj.x}|${obj.y}|${obj.rotation ?? 0}|${obj.mirror ? "m" : ""}|${grid}`

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
  const orientation = orientationOf(obj)
  const pins: readonly ObjectPin[] = def
    ? def.pins.map((raw) => {
        const pin = orientPin(raw, def, orientation)
        return { key: `${obj.id}:${pin.id}`, pin, point: { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid } }
      })
    : []
  placedPins.set(obj, { placement, pins })
  return pins
}

/** World-space center of a pin. */
export function pinPoint(obj: PlacedObject, pinId: string, grid: number): Point | null {
  const def = getDef(obj.def)
  const raw = def && getPin(def, pinId)
  if (!def || !raw) return null
  const pin = orientPin(raw, def, orientationOf(obj))
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
  own: Rect[] = [],
): Route {
  const a1 = stubEnd(a, aSide, aStub, grid)
  const b1 = stubEnd(b, bSide, bStub, grid)
  const pts: Point[] = [a, a1]
  const owner: number[] = [0]
  let horizontal = isHorizontal(aSide, a1, points[0] ?? b1)

  if (points.length === 0) {
    for (const m of autoRoute(a, a1, aSide, b, b1, bSide, grid, avoid, own)) {
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
        const viaH = { x: q.x, y: p.y }
        const viaV = { x: p.x, y: q.y }
        let corner = goHorizontalFirst ? viaH : viaV
        if (i === anchors.length - 1) {
          const before = pts.length > 1 ? pts[pts.length - 2] : p
          const other = goHorizontalFirst ? viaV : viaH
          const arrival = (via: Point) => arrivesFromBehind(collapsed([before, p, via, q, b]), bSide)
          if (arrival(other) < arrival(corner)) corner = other
        }
        pts.push(corner)
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
const BODY_CROSSING_COST = 1e6
const THROUGH_BODY_COST = 1e4

const collapsed = (pts: readonly Point[]) => dedupeRoute([...pts], new Array<number>(Math.max(0, pts.length - 1)).fill(0)).pts

function pathLength(pts: readonly Point[]) {
  let sum = 0
  for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return sum
}

const leavesThroughBody = (pts: readonly Point[], aSide: Direction) =>
  pts.length > 1 && Math.sign(pts[1].x - pts[0].x) * DIR[aSide].x + Math.sign(pts[1].y - pts[0].y) * DIR[aSide].y < 0 ? 1 : 0

const arrivesFromBehind = (pts: readonly Point[], bSide: Direction) => {
  const n = pts.length
  return n > 1 && Math.sign(pts[n - 1].x - pts[n - 2].x) * DIR[bSide].x + Math.sign(pts[n - 1].y - pts[n - 2].y) * DIR[bSide].y > 0 ? 1 : 0
}

const runsAlong = (from: Point, to: Point, side: Direction) =>
  Math.sign(to.x - from.x) === Math.sign(DIR[side].x) && Math.sign(to.y - from.y) === Math.sign(DIR[side].y)

/**
 * Interior points of the automatic route between two stub ends: a centred Z when both stubs
 * point the same way, an L otherwise. When that path runs over another component's body, the
 * mid line is moved — first between the ends, then past them — to the nearest position that
 * clears every body, or the one crossing fewest if none does.
 */
function autoRoute(a: Point, a1: Point, aSide: Direction, b: Point, b1: Point, bSide: Direction, grid: number, avoid: Rect[], own: Rect[]): Point[] {
  const ah = isHorizontal(aSide, a1, b1)
  const bh = isHorizontal(bSide, b1, a1)
  const ownClear = own.filter((r) => !strictlyInside(a1, r) && !strictlyInside(b1, r))
  const cost = (mid: Point[]) => {
    const pts = collapsed([a, a1, ...mid, b1, b])
    const n = pts.length
    const skipsStub = n < 2 ? 0 : (samePoint(a, a1) || runsAlong(pts[0], pts[1], aSide) ? 0 : 1) + (samePoint(b, b1) || runsAlong(pts[n - 1], pts[n - 2], bSide) ? 0 : 1)
    const throughBody = leavesThroughBody(pts, aSide) + arrivesFromBehind(pts, bSide) + skipsStub + crossings(a1, mid, b1, ownClear)
    return crossings(a1, mid, b1, avoid) * BODY_CROSSING_COST + throughBody * THROUGH_BODY_COST + pathLength(pts)
  }
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
  const preferredCost = cost(preferred)
  if (preferredCost < THROUGH_BODY_COST) return preferred

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
  const shortest = pathLength([a, a1]) + Math.abs(b1.x - a1.x) + Math.abs(b1.y - a1.y) + pathLength([b1, b])
  let best = preferred
  let bestCost = preferredCost
  for (const c of candidates) {
    const candidateCost = cost(c)
    if (candidateCost < bestCost) {
      best = c
      bestCost = candidateCost
      if (candidateCost <= shortest + 1e-6) break
    }
  }
  return best
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

const strictlyInside = (p: Point, r: Rect) => p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5

const ownBodyCache = new WeakMap<PlacedObject, { grid: number; body: Rect | null }>()

function ownBody(obj: PlacedObject, grid: number): Rect | null {
  const cached = ownBodyCache.get(obj)
  if (cached && cached.grid === grid) return cached.body
  const body = measureOwnBody(obj, grid)
  ownBodyCache.set(obj, { grid, body })
  return body
}

function measureOwnBody(obj: PlacedObject, grid: number): Rect | null {
  const def = getDef(obj.def)
  if (!def) return null
  const orientation = orientationOf(obj)
  const box = objectSize(def, orientation.rotation)
  const b = bodyBounds(def)
  const corners = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ].map((p) => orientOffset({ x: p.x - def.width / 2, y: p.y - def.height / 2 }, orientation))
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x: obj.x + (x + box.w / 2) * grid, y: obj.y + (y + box.h / 2) * grid, w: (Math.max(...xs) - x) * grid, h: (Math.max(...ys) - y) * grid }
}

export function ownBodies(objects: ReadonlyMap<string, PlacedObject>, grid: number, from: string, to: string): Rect[] {
  const out: Rect[] = []
  for (const id of from === to ? [from] : [from, to]) {
    const obj = objects.get(id)
    const body = obj && ownBody(obj, grid)
    if (body) out.push(body)
  }
  return out
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

export function trimRouteEnds(pts: readonly Point[], by: number): Point[] {
  if (pts.length < 2 || by <= 0) return [...pts]
  const cut = (end: Point, toward: Point) => {
    const len = Math.hypot(toward.x - end.x, toward.y - end.y)
    const t = len ? Math.min(by, len / 2) / len : 0
    return { x: end.x + (toward.x - end.x) * t, y: end.y + (toward.y - end.y) * t }
  }
  const out = [...pts]
  out[0] = cut(pts[0], pts[1])
  out[out.length - 1] = cut(pts[pts.length - 1], pts[pts.length - 2])
  return out
}

function dedupe(pts: Point[]): Point[] {
  return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y)
}

const samePoint = (p: Point, q: Point) => p.x === q.x && p.y === q.y

const turnsBack = (a: Point, b: Point, c: Point) => {
  const ax = Math.sign(b.x - a.x)
  const ay = Math.sign(b.y - a.y)
  const bx = Math.sign(c.x - b.x)
  const by = Math.sign(c.y - b.y)
  return ax * by === ay * bx && ax * bx + ay * by < 0
}

function dedupeRoute(pts: Point[], owner: number[]): Route {
  const outPts: Point[] = []
  const outOwner: number[] = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (outPts.length && samePoint(outPts[outPts.length - 1], p)) continue
    while (outPts.length >= 2 && turnsBack(outPts[outPts.length - 2], outPts[outPts.length - 1], p)) {
      outPts.pop()
      outOwner.pop()
    }
    if (outPts.length && samePoint(outPts[outPts.length - 1], p)) continue
    outPts.push(p)
    if (outPts.length > 1) outOwner.push(owner[i - 1])
  }
  return { pts: outPts, owner: outOwner }
}

export type RoutedWire = {
  id: string
  pts: Point[]
  owner: number[]
}

const routeBoxes = new WeakMap<RoutedWire, Rect>()

export function routeBox(route: RoutedWire): Rect {
  const cached = routeBoxes.get(route)
  if (cached) return cached
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of route.pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  routeBoxes.set(route, box)
  return box
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

type CachedRoute = {
  signature: string
  route: RoutedWire
  wire: Wire
  deps: readonly string[]
  area: Rect
}

const NOTHING_MOVED: ReadonlySet<string> = new Set()

export type LabelRects = (object: PlacedObject, grid: number) => readonly Rect[]

export class Router {
  private readonly labels: LabelRects | null
  private routes = new Map<string, CachedRoute>()
  private objects: readonly PlacedObject[] | null = null
  private grid = 0

  constructor(labels: LabelRects | null = null) {
    this.labels = labels
  }

  private movedSinceLastCall(objects: readonly PlacedObject[], grid: number): ReadonlySet<string> | null {
    const previous = this.objects
    this.objects = objects
    if (!previous || grid !== this.grid) {
      this.grid = grid
      return null
    }
    if (previous === objects) return NOTHING_MOVED
    const before = objectIndex(previous)
    const now = objectIndex(objects)
    const moved = new Set<string>()
    for (const o of objects) if (before.get(o.id) !== o) moved.add(o.id)
    for (const o of previous) if (!now.has(o.id)) moved.add(o.id)
    return moved
  }

  private survives(cached: CachedRoute, w: Wire, moved: ReadonlySet<string>, movedBodies: SpatialIndex | null): boolean {
    if (cached.wire !== w) return false
    if (!movedBodies) return true
    if (moved.has(w.from.object) || moved.has(w.to.object)) return false
    for (const id of cached.deps) if (moved.has(id)) return false
    return !movedBodies.overlaps(cached.area)
  }

  routeAll(objects: readonly PlacedObject[], wires: readonly Wire[], grid: number): RoutedWire[] {
    const moved = this.movedSinceLastCall(objects, grid)
    const movedBodies = moved?.size ? new SpatialIndex(objects.filter((o) => moved.has(o.id)), grid) : null
    const byId = objectIndex(objects)
    let bodies: SpatialIndex | null = null
    const kept = new Map<string, CachedRoute>()
    const out: RoutedWire[] = []
    for (const w of wires) {
      const cached = this.routes.get(w.id)
      if (moved && cached && this.survives(cached, w, moved, movedBodies)) {
        kept.set(w.id, cached)
        out.push(cached.route)
        continue
      }
      const a = resolvePinIn(byId, w.from, grid)
      const b = resolvePinIn(byId, w.to, grid)
      if (!a || !b) continue
      const aStub = a.pin.stub ?? 1
      const bStub = b.pin.stub ?? 1
      const bends = w.points ?? []
      const avoid: Rect[] = []
      const deps: string[] = []
      const area = routeArea(a.point, aStub, b.point, bStub, bends, grid)
      let signature = `${grid}:${a.point.x},${a.point.y},${a.pin.side},${aStub}/${b.point.x},${b.point.y},${b.pin.side},${bStub}`
      for (const p of bends) signature += `/${p.x},${p.y}`
      bodies ??= new SpatialIndex(objects, grid)
      for (const o of bodies.query(area)) {
        const rect = objectRect(o, grid)
        if (!intersects(rect, area)) continue
        deps.push(o.id)
        for (const label of this.labels?.(o, grid) ?? []) {
          if (!intersects(label, area)) continue
          avoid.push(label)
          signature += `|${o.id}#${label.x},${label.y},${label.w},${label.h}`
        }
        if (o.id === w.from.object || o.id === w.to.object) continue
        avoid.push(rect)
        signature += `|${o.id}@${o.def},${o.x},${o.y},${o.rotation ?? 0}${o.mirror ? "m" : ""}`
      }
      if (cached && cached.signature === signature) {
        const same = { ...cached, wire: w, deps, area }
        kept.set(w.id, same)
        out.push(cached.route)
        continue
      }
      const { pts, owner } = routeWire(a.point, a.pin.side, aStub, b.point, b.pin.side, bStub, grid, bends, avoid, ownBodies(byId, grid, w.from.object, w.to.object))
      const route: RoutedWire = { id: w.id, pts, owner }
      kept.set(w.id, { signature, route, wire: w, deps, area })
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
  const pin = orientPin(raw, def, orientationOf(obj))
  return { obj, def, pin, point: { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid } }
}

const NUDGE_STEP = 1 / 3
const NUDGE_MAX = 1 / 2

type Axis = "h" | "v"

const axisOf = (p: Point, q: Point): Axis | null => (p.y === q.y ? "h" : p.x === q.x ? "v" : null)

type RouteSeg = { at: number; axis: Axis; lo: number; hi: number; lean: number; lane: number }

const laneOf = (axis: Axis, along: number) => Math.round(along) * 2 + (axis === "h" ? 0 : 1)

const routeSegs = new WeakMap<RoutedWire, readonly RouteSeg[]>()

function segsOf(route: RoutedWire): readonly RouteSeg[] {
  const cached = routeSegs.get(route)
  if (cached) return cached
  const segs: RouteSeg[] = []
  const pts = route.pts
  for (let at = 1; at < pts.length - 2; at++) {
    const p = pts[at]
    const q = pts[at + 1]
    const axis = axisOf(p, q)
    if (!axis) continue
    const before = pts[at - 1]
    const after = pts[at + 2]
    const lean = axis === "h" ? (before.y + after.y) / 2 - p.y : (before.x + after.x) / 2 - p.x
    const [lo, hi] = axis === "h" ? [Math.min(p.x, q.x), Math.max(p.x, q.x)] : [Math.min(p.y, q.y), Math.max(p.y, q.y)]
    segs.push({ at, axis, lo, hi, lean, lane: laneOf(axis, axis === "h" ? p.y : p.x) })
  }
  routeSegs.set(route, segs)
  return segs
}

/**
 * Separate collinear runs of different nets that share a corridor, libavoid's stage 3 in its
 * cheap form. Each nudged segment is offset sideways on a centred ladder; where a run changes
 * offset along its length, or meets a stub that must stay put, a short jog keeps the route
 * orthogonal. Pins and the direction a wire leaves them are never touched.
 */
export function nudgeRoutes(routes: RoutedWire[], netOf: (wireId: string) => string | undefined, grid: number): RoutedWire[] {
  const nets = routes.map((r) => netOf(r.id) ?? r.id)
  const byWire = routes.map(segsOf)
  const lanes = new Map<number, number[]>()
  for (let wire = 0; wire < byWire.length; wire++) {
    const segs = byWire[wire]
    for (let i = 0; i < segs.length; i++) {
      const list = lanes.get(segs[i].lane)
      if (list) list.push(wire, i)
      else lanes.set(segs[i].lane, [wire, i])
    }
  }

  const offsets: (Map<number, number> | undefined)[] = new Array(routes.length)
  let nudged = false
  const segAt = (cluster: number[], k: number) => byWire[cluster[k]][cluster[k + 1]]
  const separate = (cluster: number[]) => {
    const sum = new Map<string, number>()
    const count = new Map<string, number>()
    for (let k = 0; k < cluster.length; k += 2) {
      const net = nets[cluster[k]]
      sum.set(net, (sum.get(net) ?? 0) + segAt(cluster, k).lean)
      count.set(net, (count.get(net) ?? 0) + 1)
    }
    if (sum.size < 2) return
    const lean = (net: string) => sum.get(net)! / count.get(net)!
    const order = [...sum.keys()].sort((a, b) => lean(a) - lean(b))
    const step = Math.min(NUDGE_STEP * grid, (2 * NUDGE_MAX * grid) / (order.length - 1))
    const span = (order.length - 1) / 2
    const deltaOf = new Map(order.map((net, i) => [net, (i - span) * step]))
    for (let k = 0; k < cluster.length; k += 2) {
      const delta = deltaOf.get(nets[cluster[k]]) ?? 0
      if (!delta) continue
      const wire = cluster[k]
      const byAt = offsets[wire] ?? (offsets[wire] = new Map())
      byAt.set(segAt(cluster, k).at, delta)
      nudged = true
    }
  }

  for (const list of lanes.values()) {
    if (list.length < 4) continue
    const order = Array.from({ length: list.length / 2 }, (_, k) => k)
    const at = (k: number) => byWire[list[k * 2]][list[k * 2 + 1]]
    order.sort((a, b) => at(a).lo - at(b).lo)
    let cluster: number[] = []
    let end = -Infinity
    for (const k of order) {
      const seg = at(k)
      if (cluster.length && seg.lo >= end) {
        separate(cluster)
        cluster = []
      }
      cluster.push(list[k * 2], list[k * 2 + 1])
      end = Math.max(end, seg.hi)
    }
    separate(cluster)
  }

  if (!nudged) return routes
  return routes.map((r, wire) => {
    const byAt = offsets[wire]
    return byAt ? applyOffsets(r, (at) => byAt.get(at) ?? 0) : r
  })
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
const ON_ROUTE_TOLERANCE = 1e-6

function closestOnSegment(a: Point, b: Point, p: Point): Point {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

export function closestOnRoute(pts: readonly Point[], p: Point): Point {
  let best = pts[0] ?? p
  let bestD = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const q = closestOnSegment(pts[i], pts[i + 1], p)
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (d < bestD) {
      bestD = d
      best = q
    }
  }
  return best
}

export function liesOnRoute(pts: readonly Point[], p: Point): boolean {
  const q = closestOnRoute(pts, p)
  return Math.hypot(p.x - q.x, p.y - q.y) <= ON_ROUTE_TOLERANCE
}

export type WireEnd = { point: Point; side: Direction; stub: number }

const routeBetween = (from: WireEnd, to: WireEnd, grid: number, bends: Point[]) =>
  routeWire(from.point, from.side, from.stub, to.point, to.side, to.stub, grid, bends).pts

export function bendReach(from: WireEnd, to: WireEnd, bends: readonly Point[], index: number, start: Point, target: Point, grid: number): Point | null {
  const followed = (at: Point) => {
    const moved = bends.slice()
    moved[index] = at
    return liesOnRoute(routeBetween(from, to, grid, moved), at)
  }
  const steps = Math.max(1, Math.round(Math.max(Math.abs(target.x - start.x), Math.abs(target.y - start.y)) / grid))
  for (let k = steps; k >= 0; k--) {
    const at = { x: snap(start.x + ((target.x - start.x) * k) / steps, grid), y: snap(start.y + ((target.y - start.y) * k) / steps, grid) }
    if (followed(at)) return at
  }
  return null
}

export function bendsOnRoute(route: readonly Point[], bends: readonly Point[]): Point[] {
  return bends.map((bend) => (liesOnRoute(route, bend) ? bend : closestOnRoute(route, bend)))
}

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
