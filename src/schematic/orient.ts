import { diagonalSquare, flipped, nextRotation, objectRect, objectSize, orientationOf, snap, type FlipAxis, type Step, type Turn } from "./geometry"
import { getDef } from "./registry"
import type { PlacedObject, Schematic } from "./types"

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
  return {
    ...doc,
    objects: doc.objects.map((o) => {
      const rect = rects.get(o.id)
      if (!rect) return o
      const turned = reoriented(o, axis)
      return horizontal ? { ...turned, x: snap(across - rect.x - rect.w, grid) } : { ...turned, y: snap(across - rect.y - rect.h, grid) }
    }),
  }
}

const turningCell = ({ w, h }: { w: number; h: number }) => ({ x: Math.floor(w / 2), y: Math.floor(h / 2) })

const standsOnADiagonal = (o: PlacedObject, ids: ReadonlySet<string>) => {
  const def = getDef(o.def)
  return !ids.has(o.id) || !def || diagonalSquare(def) !== null
}

export function rotateSelection(doc: Schematic, ids: ReadonlySet<string>, turn: Turn, grid: number): Schematic {
  const step: Step = doc.objects.every((o) => standsOnADiagonal(o, ids)) ? 45 : 90
  const objects = doc.objects.map((o) => {
    if (!ids.has(o.id)) return o
    const def = getDef(o.def)
    if (!def) return o
    const rotation = nextRotation(def, o.rotation ?? 0, turn, step)
    const before = turningCell(objectSize(def, o.rotation))
    const after = turningCell(objectSize(def, rotation))
    return { ...o, rotation, x: o.x + (before.x - after.x) * grid, y: o.y + (before.y - after.y) * grid }
  })
  return { ...doc, objects }
}
