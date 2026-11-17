import type { Point, RoutedWire } from "@/schematic/geometry"
import { BoxIndex } from "@/schematic/spatial"

export type Region = { x: number; y: number; width: number; height: number }

export function regionAround(routes: readonly RoutedWire[], margin: number): Region | null {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const route of routes)
    for (const p of [...route.pts, ...(route.leads?.start ? [route.leads.start] : []), ...(route.leads?.end ? [route.leads.end] : [])]) {
      left = Math.min(left, p.x)
      top = Math.min(top, p.y)
      right = Math.max(right, p.x)
      bottom = Math.max(bottom, p.y)
    }
  if (left > right) return null
  return { x: left - margin, y: top - margin, width: right - left + 2 * margin, height: bottom - top + 2 * margin }
}

type Piece = { readonly net: number; readonly a: Point; readonly b: Point }

export type NetCuts = { readonly regions: readonly (Region | null)[]; readonly cutBy: readonly (readonly number[])[] }

const piecesOf = (net: number, route: RoutedWire): Piece[] => route.pts.slice(1).map((b, k) => ({ net, a: route.pts[k], b }))

const boxOf = ({ a, b }: Piece, margin: number) => ({ x: Math.min(a.x, b.x) - margin, y: Math.min(a.y, b.y) - margin, w: Math.abs(b.x - a.x) + 2 * margin, h: Math.abs(b.y - a.y) + 2 * margin })

function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

const side = (p: Point, a: Point, b: Point) => Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))

const crossing = (p: Piece, q: Piece) => side(q.a, p.a, p.b) * side(q.b, p.a, p.b) < 0 && side(p.a, q.a, q.b) * side(p.b, q.a, q.b) < 0

export const piecesWithin = (p: Piece, q: Piece, margin: number) =>
  crossing(p, q) || Math.min(pointToSegment(p.a, q.a, q.b), pointToSegment(p.b, q.a, q.b), pointToSegment(q.a, p.a, p.b), pointToSegment(q.b, p.a, p.b)) <= margin

export function netCuts(groups: readonly { wires: readonly RoutedWire[] }[], margin: number): NetCuts {
  const regions = groups.map((g) => regionAround(g.wires, margin))
  const pieces = groups.flatMap((g, net) => g.wires.flatMap((route) => piecesOf(net, route)))
  const index = new BoxIndex(pieces, (piece) => boxOf(piece, margin), 16 * margin)
  const later = groups.map(() => new Set<number>())
  for (const piece of pieces)
    index.some(boxOf(piece, margin), (other) => {
      if (other.net > piece.net && !later[piece.net].has(other.net) && piecesWithin(piece, other, margin)) later[piece.net].add(other.net)
      return false
    })
  return { regions, cutBy: later.map((nets) => [...nets].sort((a, b) => a - b)) }
}
