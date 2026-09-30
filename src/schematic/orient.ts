import { flipped, objectRect, objectSize, orientationOf, snap, type FlipAxis, type Point } from "./geometry"
import { getDef } from "./registry"
import type { PlacedObject, Rotation, Schematic } from "./types"

function reoriented(object: PlacedObject, axis: FlipAxis): PlacedObject {
  const { rotation, mirror } = flipped(orientationOf(object), axis)
  const { rotation: _rotation, mirror: _mirror, ...rest } = object
  return { ...rest, ...(rotation && { rotation }), ...(mirror && { mirror }) }
}

export function flipSelection(doc: Schematic, ids: ReadonlySet<string>, axis: FlipAxis, grid: number): Schematic {
  const chosen = doc.objects.filter((o) => ids.has(o.id) && getDef(o.def))
  if (chosen.length === 0) return doc
  if (chosen.length === 1) return { ...doc, objects: doc.objects.map((o) => (o === chosen[0] ? reoriented(o, axis) : o)) }

  const horizontal = axis === "horizontal"
  const rects = new Map(chosen.map((o) => [o.id, objectRect(o, grid)]))
  const starts = [...rects.values()].map((r) => (horizontal ? r.x : r.y))
  const ends = [...rects.values()].map((r) => (horizontal ? r.x + r.w : r.y + r.h))
  const across = snap(Math.min(...starts) + Math.max(...ends), grid)
  const mirrored = (p: Point): Point => (horizontal ? { x: across - p.x, y: p.y } : { x: p.x, y: across - p.y })

  return {
    ...doc,
    objects: doc.objects.map((o) => {
      const rect = rects.get(o.id)
      if (!rect) return o
      const turned = reoriented(o, axis)
      return horizontal ? { ...turned, x: snap(across - rect.x - rect.w, grid) } : { ...turned, y: snap(across - rect.y - rect.h, grid) }
    }),
    wires: doc.wires.map((w) =>
      w.points && rects.has(w.from.object) && rects.has(w.to.object) ? { ...w, points: w.points.map(mirrored) } : w,
    ),
  }
}

export function rotateSelection(doc: Schematic, ids: ReadonlySet<string>, delta: 45 | -45, grid: number): Schematic {
  return {
    ...doc,
    objects: doc.objects.map((o) => {
      if (!ids.has(o.id)) return o
      const def = getDef(o.def)
      if (!def) return o
      const rotation = (((o.rotation ?? 0) + delta + 360) % 360) as Rotation
      const before = objectSize(def, o.rotation)
      const after = objectSize(def, rotation)
      const cx = o.x + (before.w * grid) / 2
      const cy = o.y + (before.h * grid) / 2
      return { ...o, rotation, x: snap(cx - (after.w * grid) / 2, grid), y: snap(cy - (after.h * grid) / 2, grid) }
    }),
  }
}
