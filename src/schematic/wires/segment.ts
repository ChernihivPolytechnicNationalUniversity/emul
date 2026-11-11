import { GRID } from "../grid"
import type { PinKind, Point } from "../types"
import type { WireColorKey } from "../wire-colors"

export const HALF_CELL = GRID / 2

export type WireSegment = { readonly id: string; readonly a: Readonly<Point>; readonly b: Readonly<Point>; readonly color?: WireColorKey }

export type WirePin = { readonly key: string; readonly at: Readonly<Point>; readonly socket?: boolean; readonly kind?: PinKind; readonly out?: Readonly<Point> }

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

export const isHorizontal = (s: WireSegment) => s.a.y === s.b.y

export const isOrthogonal = (s: WireSegment) => (s.a.x === s.b.x) !== (s.a.y === s.b.y)

export const lineOf = (s: WireSegment): LineKey => (isHorizontal(s) ? horizontalLine(s.a.y) : verticalLine(s.a.x))

export const horizontalLine = (y: number): LineKey => Number.isSafeInteger(y) && Number.isSafeInteger(y * 2) ? y * 2 : `h${y}`

export const verticalLine = (x: number): LineKey => Number.isSafeInteger(x) && Number.isSafeInteger(x * 2) && Number.isSafeInteger(x * 2 + 1) ? x * 2 + 1 : `v${x}`

export const isHorizontalLine = (line: LineKey) => typeof line === "number" ? line % 2 === 0 : line[0] === "h"

export const lineCoordinate = (line: LineKey) => typeof line === "number" ? Math.floor(line / 2) : Number(line.slice(1))

export const along = (s: WireSegment, p: Point) => (isHorizontal(s) ? p.x : p.y)

export const lowOf = (s: WireSegment) => Math.min(along(s, s.a), along(s, s.b))

export const highOf = (s: WireSegment) => Math.max(along(s, s.a), along(s, s.b))

export const pointOnLine = (line: LineKey, at: number): Point => {
  const fixed = lineCoordinate(line)
  return isHorizontalLine(line) ? { x: at, y: fixed } : { x: fixed, y: at }
}

export const crossLineThrough = (line: LineKey, p: Point): LineKey => (isHorizontalLine(line) ? verticalLine(p.x) : horizontalLine(p.y))

export function contains(s: WireSegment, p: Point): boolean {
  if (isHorizontal(s)) return p.y === s.a.y && p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x)
  return p.x === s.a.x && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y)
}

export function latticePointsInside(_s: Pick<WireSegment, "a" | "b">): Point[] {
  throw new Error("phase 7: the lattice points inside a diagonal are not built yet")
}

export function latticePointNear(_s: Pick<WireSegment, "a" | "b">, _at: Point, _reach: number): Point | null {
  throw new Error("phase 7: the lattice point of a diagonal nearest a press is not built yet")
}
