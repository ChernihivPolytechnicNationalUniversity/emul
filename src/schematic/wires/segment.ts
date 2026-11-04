import { GRID } from "../grid"
import type { PinKind, Point } from "../types"
import type { WireColorKey } from "../wire-colors"

export const HALF_CELL = GRID / 2

export type WireSegment = { readonly id: string; readonly a: Readonly<Point>; readonly b: Readonly<Point>; readonly color?: WireColorKey }

export type WirePin = { readonly key: string; readonly at: Readonly<Point>; readonly socket?: boolean; readonly kind?: PinKind; readonly out?: Readonly<Point> }

export type LineKey = string

export const pointKey = (p: Point) => `${p.x},${p.y}`

export const samePoint = (p: Point, q: Point) => p.x === q.x && p.y === q.y

export const onLattice = (p: Point) => Number.isInteger(p.x / HALF_CELL) && Number.isInteger(p.y / HALF_CELL)

export const isHorizontal = (s: WireSegment) => s.a.y === s.b.y

export const isOrthogonal = (s: WireSegment) => (s.a.x === s.b.x) !== (s.a.y === s.b.y)

export const lineOf = (s: WireSegment): LineKey => (isHorizontal(s) ? horizontalLine(s.a.y) : verticalLine(s.a.x))

export const horizontalLine = (y: number): LineKey => `h${y}`

export const verticalLine = (x: number): LineKey => `v${x}`

export const along = (s: WireSegment, p: Point) => (isHorizontal(s) ? p.x : p.y)

export const lowOf = (s: WireSegment) => Math.min(along(s, s.a), along(s, s.b))

export const highOf = (s: WireSegment) => Math.max(along(s, s.a), along(s, s.b))

export const pointOnLine = (line: LineKey, at: number): Point => {
  const fixed = Number(line.slice(1))
  return line[0] === "h" ? { x: at, y: fixed } : { x: fixed, y: at }
}

export const crossLineThrough = (line: LineKey, p: Point): LineKey => (line[0] === "h" ? verticalLine(p.x) : horizontalLine(p.y))

export function contains(s: WireSegment, p: Point): boolean {
  if (isHorizontal(s)) return p.y === s.a.y && p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x)
  return p.x === s.a.x && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y)
}



