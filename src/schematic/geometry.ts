import { getDef, getPin } from "./registry"
import type { ComponentDef, PinDef, PinRef, PlacedObject, Point, Rotation, Side } from "./types"

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

/**
 * Every pin of a placed object, in world coordinates. Used wherever pins have to be found by
 * position rather than by name: touching pins, hit-testing, contact dots.
 */
export function objectPins(obj: PlacedObject, grid: number): { key: string; pin: PlacedPin; point: Point }[] {
  const def = getDef(obj.def)
  if (!def) return []
  return def.pins.map((raw) => {
    const pin = rotatePin(raw, def, obj.rotation)
    return { key: `${obj.id}:${pin.id}`, pin, point: { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid } }
  })
}

/**
 * Group pins that sit on the same point, so components placed pin-to-pin conduct without a
 * wire. Only an exact coincidence counts: a wire or a symbol merely passing over a pin is not
 * a connection. Returns every such pin keyed to its group's representative.
 */
export function pinContacts(objects: PlacedObject[], grid: number): Map<string, string> {
  // Bucket by whole pixel, then compare against the neighbouring buckets, so the sweep stays
  // linear however many pins a board has.
  const buckets = new Map<string, { key: string; point: Point }[]>()
  for (const obj of objects) {
    for (const { key, pin, point } of objectPins(obj, grid)) {
      if (pin.kind === "nc") continue
      const at = `${Math.round(point.x)},${Math.round(point.y)}`
      const list = buckets.get(at)
      if (list) list.push({ key, point })
      else buckets.set(at, [{ key, point }])
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
  for (const [at, list] of buckets) {
    const [bx, by] = at.split(",").map(Number)
    const near: { key: string; point: Point }[] = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const other = buckets.get(`${bx + dx},${by + dy}`)
        if (other && (dx !== 0 || dy !== 0)) near.push(...other)
      }
    }
    const all = [...list, ...near]
    for (const a of list) {
      for (const b of all) {
        if (a.key === b.key) continue
        if (Math.abs(a.point.x - b.point.x) < EPS && Math.abs(a.point.y - b.point.y) < EPS) union(a.key, b.key)
      }
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

/** Object, definition and the pin as seen on the field (rotation applied). */
export function resolvePin(objects: PlacedObject[], ref: PinRef, grid: number) {
  const obj = objects.find((o) => o.id === ref.object)
  if (!obj) return null
  const def = getDef(obj.def)
  const raw = def && getPin(def, ref.pin)
  if (!def || !raw) return null
  const pin = rotatePin(raw, def, obj.rotation)
  return { obj, def, pin, point: { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid } }
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
    for (let k = 1; k <= 6; k++) out.push(c + k * grid, c - k * grid)
    for (let k = 1; k <= 4; k++) out.push(Math.max(lo, hi) + k * grid, Math.min(lo, hi) - k * grid)
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
export function routeObstacles(objects: PlacedObject[], grid: number, from: string, to: string): Rect[] {
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

export const toPath = (pts: Point[]) =>
  pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")

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
