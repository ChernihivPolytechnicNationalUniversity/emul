import { GRID } from "../grid"
import type { PinKind, Point } from "../types"
import type { WireColorKey } from "../wire-colors"

export const HALF_CELL = GRID / 2

export type WireSegment = { readonly id: string; readonly a: Readonly<Point>; readonly b: Readonly<Point>; readonly color?: WireColorKey }

export type WirePin = { readonly key: string; readonly at: Readonly<Point>; readonly socket?: boolean; readonly kind?: PinKind; readonly out?: Readonly<Point>; readonly shunt?: Readonly<Point> }

export type LineKey = number | string

export const pointKey = (p: Point) => `${p.x},${p.y}`

export type PointCode = number | string

const CODED = 2 ** 25

export const exactPointCode = (p: Point): PointCode => Number.isInteger(p.x) && Number.isInteger(p.y) && Math.abs(p.x) < CODED && Math.abs(p.y) < CODED ? (p.x + CODED) * 2 ** 26 + (p.y + CODED) : pointKey(p)

export const samePoint = (p: Point, q: Point) => p.x === q.x && p.y === q.y

export const onLattice = (p: Point) => Number.isInteger(p.x / HALF_CELL) && Number.isInteger(p.y / HALF_CELL)

export function seededIds(texts: Iterable<string>, taken: ReadonlySet<string> = new Set()): () => string {
  let h = 0x811c9dc5
  const mix = (code: number) => {
    h ^= code
    h = Math.imul(h, 0x01000193) >>> 0
  }
  for (const text of texts) {
    for (let i = 0; i < text.length; i++) mix(text.charCodeAt(i))
    mix(0)
  }
  const seed = h.toString(36)
  let piece = 0
  return () => {
    let id = `${seed}.${piece++}`
    while (taken.has(id)) id = `${seed}.${piece++}`
    return id
  }
}

export const isHorizontal = (s: Pick<WireSegment, "a" | "b">) => s.a.y === s.b.y

export const isVertical = (s: Pick<WireSegment, "a" | "b">) => s.a.x === s.b.x && s.a.y !== s.b.y

export const isDiagonal = (s: Pick<WireSegment, "a" | "b">) => s.a.x !== s.b.x && s.a.y !== s.b.y

export const isOrthogonal = (s: Pick<WireSegment, "a" | "b">) => (s.a.x === s.b.x) !== (s.a.y === s.b.y)

export const passesAlongItsRow = (pin: WirePin, s: Pick<WireSegment, "a" | "b">) => !!pin.socket && !pin.shunt && !!pin.out && (s.a.y === s.b.y ? pin.out.y === 0 : s.a.x === s.b.x && pin.out.x === 0)

export function greatestDivisor(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) {
    const rest = a % b
    a = b
    b = rest
  }
  return a
}

export type Slope = { readonly run: number; readonly rise: number }

export function slopeOf(s: Pick<WireSegment, "a" | "b">): Slope {
  let run = s.b.x - s.a.x
  let rise = s.b.y - s.a.y
  if (run < 0 || (run === 0 && rise < 0)) {
    run = -run
    rise = -rise
  }
  if (!Number.isSafeInteger(run) || !Number.isSafeInteger(rise)) return { run, rise }
  const g = greatestDivisor(run, rise) || 1
  return { run: run / g, rise: rise / g }
}

export const slopeKey = (slope: Slope) => `${slope.run},${slope.rise}`

export const offsetOn = (slope: Slope, p: Point) => slope.rise * p.x - slope.run * p.y

export const diagonalLine = (slope: Slope, through: Point): LineKey => `d${slope.run},${slope.rise},${offsetOn(slope, through) + 0}`

export const isDiagonalLine = (line: LineKey) => typeof line === "string" && line[0] === "d"

export function diagonalOf(line: LineKey): { slope: Slope; offset: number } {
  const [run, rise, offset] = (line as string).slice(1).split(",").map(Number)
  return { slope: { run, rise }, offset }
}

export const lineOf = (s: Pick<WireSegment, "a" | "b">): LineKey => (isHorizontal(s) ? horizontalLine(s.a.y) : s.a.x === s.b.x ? verticalLine(s.a.x) : diagonalLine(slopeOf(s), s.a))

export const horizontalLine = (y: number): LineKey => Number.isSafeInteger(y) && Number.isSafeInteger(y * 2) ? y * 2 : `h${y}`

export const verticalLine = (x: number): LineKey => Number.isSafeInteger(x) && Number.isSafeInteger(x * 2) && Number.isSafeInteger(x * 2 + 1) ? x * 2 + 1 : `v${x}`

export const isHorizontalLine = (line: LineKey) => typeof line === "number" ? line % 2 === 0 : line[0] === "h"

export const lineCoordinate = (line: LineKey) => typeof line === "number" ? Math.floor(line / 2) : Number(line.slice(1))

export const along = (s: Pick<WireSegment, "a" | "b">, p: Point) => (isHorizontal(s) || s.a.x !== s.b.x ? p.x : p.y)

export const lowOf = (s: Pick<WireSegment, "a" | "b">) => Math.min(along(s, s.a), along(s, s.b))

export const highOf = (s: Pick<WireSegment, "a" | "b">) => Math.max(along(s, s.a), along(s, s.b))

export const alongLine = (line: LineKey, p: Point) => (isHorizontalLine(line) || isDiagonalLine(line) ? p.x : p.y)

export const pointOnLine = (line: LineKey, at: number): Point => {
  if (isDiagonalLine(line)) {
    const { slope, offset } = diagonalOf(line)
    return { x: at, y: (slope.rise * at - offset) / slope.run + 0 }
  }
  const fixed = lineCoordinate(line)
  return isHorizontalLine(line) ? { x: at, y: fixed } : { x: fixed, y: at }
}

export const crossLineThrough = (line: LineKey, p: Point): LineKey => (isHorizontalLine(line) ? verticalLine(p.x) : horizontalLine(p.y))

export const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)

const within = (v: number, a: number, b: number) => (a <= b ? v >= a && v <= b : v >= b && v <= a)

export function contains(s: Pick<WireSegment, "a" | "b">, p: Point): boolean {
  if (isHorizontal(s)) return p.y === s.a.y && within(p.x, s.a.x, s.b.x)
  if (s.a.x === s.b.x) return p.x === s.a.x && within(p.y, s.a.y, s.b.y)
  return within(p.x, s.a.x, s.b.x) && within(p.y, s.a.y, s.b.y) && cross(s.a, s.b, p) === 0
}

export const passesInside = (s: Pick<WireSegment, "a" | "b">, p: Point) => !samePoint(s.a, p) && !samePoint(s.b, p) && contains(s, p)

const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0)

export function segmentsMeet(s: Pick<WireSegment, "a" | "b">, t: Pick<WireSegment, "a" | "b">): boolean {
  if (Math.max(s.a.x, s.b.x) < Math.min(t.a.x, t.b.x) || Math.max(t.a.x, t.b.x) < Math.min(s.a.x, s.b.x)) return false
  if (Math.max(s.a.y, s.b.y) < Math.min(t.a.y, t.b.y) || Math.max(t.a.y, t.b.y) < Math.min(s.a.y, s.b.y)) return false
  const d1 = sign(cross(t.a, t.b, s.a))
  const d2 = sign(cross(t.a, t.b, s.b))
  const d3 = sign(cross(s.a, s.b, t.a))
  const d4 = sign(cross(s.a, s.b, t.b))
  if (d1 * d2 < 0 && d3 * d4 < 0) return true
  return (d1 === 0 && contains(t, s.a)) || (d2 === 0 && contains(t, s.b)) || (d3 === 0 && contains(s, t.a)) || (d4 === 0 && contains(s, t.b))
}

export function crossingOf(s: Pick<WireSegment, "a" | "b">, t: Pick<WireSegment, "a" | "b">): Point | null {
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  const ex = t.b.x - t.a.x
  const ey = t.b.y - t.a.y
  const denominator = dx * ey - dy * ex
  if (denominator === 0 || !segmentsMeet(s, t)) return null
  const wx = t.a.x - s.a.x
  const wy = t.a.y - s.a.y
  const along = wx * ey - wy * ex
  const x = s.a.x + (dx * along) / denominator
  const y = s.a.y + (dy * along) / denominator
  const exact = { x: Math.round(x), y: Math.round(y) }
  return contains(s, exact) && contains(t, exact) ? exact : { x, y }
}

export const lattice = (p: Point): Point => ({ x: p.x / HALF_CELL, y: p.y / HALF_CELL })

export function latticePointsInside(s: Pick<WireSegment, "a" | "b">): Point[] {
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  const g = greatestDivisor(dx / HALF_CELL, dy / HALF_CELL)
  const out: Point[] = []
  if (!Number.isSafeInteger(g)) return out
  for (let k = 1; k < g; k++) out.push({ x: s.a.x + (dx * k) / g + 0, y: s.a.y + (dy * k) / g + 0 })
  return out
}

export function latticePointNear(s: Pick<WireSegment, "a" | "b">, at: Point, reach: number): Point | null {
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  const length2 = dx * dx + dy * dy
  const g = greatestDivisor(dx / HALF_CELL, dy / HALF_CELL)
  if (!length2 || g < 2 || !Number.isSafeInteger(g)) return null
  const t = ((at.x - s.a.x) * dx + (at.y - s.a.y) * dy) / length2
  let best: Point | null = null
  let bestDistance = Infinity
  const nearest = Math.round(t * g)
  for (const k of [nearest - 1, nearest, nearest + 1]) {
    if (k < 1 || k > g - 1) continue
    const p = { x: s.a.x + (dx * k) / g + 0, y: s.a.y + (dy * k) / g + 0 }
    const distance = Math.hypot(p.x - at.x, p.y - at.y)
    if (distance < bestDistance) {
      best = p
      bestDistance = distance
    }
  }
  return best && bestDistance <= reach ? best : null
}

export function distanceToSegment(s: Pick<WireSegment, "a" | "b">, p: Point): number {
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  const length2 = dx * dx + dy * dy
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / length2)) : 0
  return Math.hypot(p.x - (s.a.x + t * dx), p.y - (s.a.y + t * dy))
}

export function nearestOnSegment(s: Pick<WireSegment, "a" | "b">, p: Point): Point {
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  const length2 = dx * dx + dy * dy
  const t = length2 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / length2)) : 0
  return { x: s.a.x + t * dx, y: s.a.y + t * dy }
}

export function entersBox(s: Pick<WireSegment, "a" | "b">, box: { x: number; y: number; w: number; h: number }): boolean {
  if (Math.max(s.a.x, s.b.x) <= box.x || Math.min(s.a.x, s.b.x) >= box.x + box.w || Math.max(s.a.y, s.b.y) <= box.y || Math.min(s.a.y, s.b.y) >= box.y + box.h) return false
  if (s.a.x === s.b.x || s.a.y === s.b.y) return true
  const dx = s.b.x - s.a.x
  const dy = s.b.y - s.a.y
  const tx = [(box.x - s.a.x) / dx, (box.x + box.w - s.a.x) / dx].sort((p, q) => p - q)
  const ty = [(box.y - s.a.y) / dy, (box.y + box.h - s.a.y) / dy].sort((p, q) => p - q)
  return Math.max(0, tx[0], ty[0]) < Math.min(1, tx[1], ty[1])
}
