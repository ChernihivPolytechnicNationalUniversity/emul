import { nearestSegment, resolvePin, routeObstacles, routeWire, snap, type Point } from "./geometry"
import type { PinRef, PlacedObject, Schematic, Wire } from "./types"
import type { WireColorKey } from "./wire-colors"

export const samePin = (a: PinRef, b: PinRef) => a.object === b.object && a.pin === b.pin

const JUNCTION_DEF = "junction"
const JUNCTION_PIN = "J"
const EPS = 1e-6

const newWire = (from: PinRef, to: PinRef, points: readonly Point[], color?: WireColorKey): Wire => ({
  id: crypto.randomUUID(),
  from,
  to,
  ...(points.length ? { points: [...points] } : {}),
  ...(color ? { color } : {}),
})

const joins = (w: Wire, a: PinRef, b: PinRef) => (samePin(w.from, a) && samePin(w.to, b)) || (samePin(w.from, b) && samePin(w.to, a))

export function connectPins(doc: Schematic, from: PinRef, to: PinRef, points: readonly Point[] = [], color?: WireColorKey): Schematic {
  if (samePin(from, to)) return doc
  if (doc.wires.some((w) => joins(w, from, to))) return doc
  return { ...doc, wires: [...doc.wires, newWire(from, to, points, color)] }
}

export function tapWireAt(
  doc: Schematic,
  wireId: string,
  at: Point,
  from: PinRef,
  grid: number,
  points: readonly Point[] = [],
  color?: WireColorKey,
): Schematic {
  const w = doc.wires.find((x) => x.id === wireId)
  if (!w || samePin(w.from, from) || samePin(w.to, from)) return doc
  const a = resolvePin(doc.objects, w.from, grid)
  const b = resolvePin(doc.objects, w.to, grid)
  if (!a || !b) return doc

  const bends = w.points ?? []
  const route = routeWire(a.point, a.pin.side, a.pin.stub ?? 1, b.point, b.pin.side, b.pin.stub ?? 1, grid, bends, routeObstacles(doc.objects, grid, w.from.object, w.to.object))
  const seg = nearestSegment(route.pts, at)
  const on = pointOnSegment(route.pts[seg], route.pts[seg + 1], at, grid)
  if (coincide(on, a.point)) return connectPins(doc, from, w.from, points, color)
  if (coincide(on, b.point)) return connectPins(doc, from, w.to, points, color)

  const split = route.owner[seg] ?? bends.length
  const junction: PlacedObject = { id: crypto.randomUUID(), def: JUNCTION_DEF, x: on.x - grid, y: on.y - grid }
  const node: PinRef = { object: junction.id, pin: JUNCTION_PIN }
  return {
    ...doc,
    objects: [...doc.objects, junction],
    wires: [
      ...doc.wires.map((x) => (x.id === wireId ? rewire(x, node, bends.slice(0, split)) : x)),
      newWire(node, w.to, bends.slice(split), w.color),
      newWire(from, node, points, color),
    ],
  }
}

function rewire(w: Wire, to: PinRef, points: Point[]): Wire {
  const { points: _replaced, ...rest } = w
  return points.length ? { ...rest, to, points } : { ...rest, to }
}

const coincide = (p: Point, q: Point) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS

function pointOnSegment(p: Point, q: Point, at: Point, grid: number): Point {
  const dx = q.x - p.x
  const dy = q.y - p.y
  const len2 = dx * dx + dy * dy
  if (!len2) return p
  const t = Math.max(0, Math.min(1, ((at.x - p.x) * dx + (at.y - p.y) * dy) / len2))
  const on = { x: p.x + t * dx, y: p.y + t * dy }
  if (dy === 0) return { x: snapWithin(on.x, p.x, q.x, grid), y: p.y }
  if (dx === 0) return { x: p.x, y: snapWithin(on.y, p.y, q.y, grid) }
  return on
}

const snapWithin = (v: number, a: number, b: number, grid: number) => Math.min(Math.max(snap(v, grid), Math.min(a, b)), Math.max(a, b))
