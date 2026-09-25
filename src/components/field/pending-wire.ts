import { objectRect, resolvePin, routeArea, routeToPoint, routeWire, type Point } from "@/schematic/geometry"
import type { SpatialIndex } from "@/schematic/spatial"
import type { PinRef, PlacedObject } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"

export type PendingWire = {
  from: PinRef
  cursor: Point
  target: PinRef | null
  /** Bend points placed so far. */
  points: Point[]
  /** "drag": mouse still held from the first pin; "click": placing bends click by click. */
  mode: "drag" | "click"
  color: WireColorKey
  chosen: boolean
}

export function pendingPoints(objects: readonly PlacedObject[], index: SpatialIndex, p: PendingWire, grid: number): Point[] | null {
  const a = resolvePin(objects, p.from, grid)
  if (!a) return null
  const target = p.target && resolvePin(objects, p.target, grid)
  if (target && p.target) {
    const aStub = a.pin.stub ?? 1
    const bStub = target.pin.stub ?? 1
    const avoid = index
      .query(routeArea(a.point, aStub, target.point, bStub, p.points, grid))
      .filter((o) => o.id !== p.from.object && o.id !== p.target!.object)
      .map((o) => objectRect(o, grid))
    return routeWire(a.point, a.pin.side, aStub, target.point, target.pin.side, bStub, grid, p.points, avoid).pts
  }
  return routeToPoint(a.point, a.pin.side, a.pin.stub ?? 1, p.cursor, grid, p.points)
}

export function bentWirePoints(objects: readonly PlacedObject[], index: SpatialIndex, from: PinRef, to: PinRef, points: Point[], grid: number): Point[] | null {
  const a = resolvePin(objects, from, grid)
  const b = resolvePin(objects, to, grid)
  if (!a || !b) return null
  const aStub = a.pin.stub ?? 1
  const bStub = b.pin.stub ?? 1
  const avoid = index
    .query(routeArea(a.point, aStub, b.point, bStub, points, grid))
    .filter((o) => o.id !== from.object && o.id !== to.object)
    .map((o) => objectRect(o, grid))
  return routeWire(a.point, a.pin.side, aStub, b.point, b.pin.side, bStub, grid, points, avoid).pts
}
