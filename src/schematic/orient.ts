import { flipped, nextRotation, objectRect, objectSize, orientationOf, snap, type FlipAxis, type Point, type Turn } from "./geometry"
import { getDef } from "./registry"
import type { PlacedObject, Schematic, Wire } from "./types"

function reoriented(object: PlacedObject, axis: FlipAxis): PlacedObject {
  const { rotation, mirror } = flipped(orientationOf(object), axis)
  const { rotation: _rotation, mirror: _mirror, ...rest } = object
  return { ...rest, ...(rotation && { rotation }), ...(mirror && { mirror }) }
}

function unbent(wire: Wire): Wire {
  const { points: _points, ...rest } = wire
  return rest
}

const bentInto = (wire: Wire, turned: ReadonlySet<string>) => wire.points !== undefined && (turned.has(wire.from.object) || turned.has(wire.to.object))

export function flipSelection(doc: Schematic, ids: ReadonlySet<string>, axis: FlipAxis, grid: number): Schematic {
  const chosen = doc.objects.filter((o) => ids.has(o.id) && getDef(o.def))
  if (chosen.length === 0) return doc
  if (chosen.length === 1) {
    const turned = new Set([chosen[0].id])
    return {
      ...doc,
      objects: doc.objects.map((o) => (o === chosen[0] ? reoriented(o, axis) : o)),
      wires: doc.wires.map((w) => (bentInto(w, turned) ? unbent(w) : w)),
    }
  }

  const horizontal = axis === "horizontal"
  const rects = new Map(chosen.map((o) => [o.id, objectRect(o, grid)]))
  const starts = [...rects.values()].map((r) => (horizontal ? r.x : r.y))
  const ends = [...rects.values()].map((r) => (horizontal ? r.x + r.w : r.y + r.h))
  const across = snap(Math.min(...starts) + Math.max(...ends), grid)
  const mirrored = (p: Point): Point => (horizontal ? { x: across - p.x, y: p.y } : { x: p.x, y: across - p.y })
  const turned = new Set(rects.keys())
  const inside = (w: Wire) => turned.has(w.from.object) && turned.has(w.to.object)

  return {
    ...doc,
    objects: doc.objects.map((o) => {
      const rect = rects.get(o.id)
      if (!rect) return o
      const turned = reoriented(o, axis)
      return horizontal ? { ...turned, x: snap(across - rect.x - rect.w, grid) } : { ...turned, y: snap(across - rect.y - rect.h, grid) }
    }),
    wires: doc.wires.map((w) => {
      if (!w.points) return w
      if (inside(w)) return { ...w, points: w.points.map(mirrored) }
      return bentInto(w, turned) ? unbent(w) : w
    }),
  }
}

const turningCell = ({ w, h }: { w: number; h: number }) => ({ x: Math.floor(w / 2), y: Math.floor(h / 2) })

export function rotateSelection(doc: Schematic, ids: ReadonlySet<string>, turn: Turn, grid: number): Schematic {
  const turned = new Set<string>()
  const objects = doc.objects.map((o) => {
    if (!ids.has(o.id)) return o
    const def = getDef(o.def)
    if (!def) return o
    turned.add(o.id)
    const rotation = nextRotation(def, o.rotation ?? 0, turn)
    const before = turningCell(objectSize(def, o.rotation))
    const after = turningCell(objectSize(def, rotation))
    return { ...o, rotation, x: o.x + (before.x - after.x) * grid, y: o.y + (before.y - after.y) * grid }
  })
  return { ...doc, objects, wires: doc.wires.map((w) => (bentInto(w, turned) ? unbent(w) : w)) }
}
