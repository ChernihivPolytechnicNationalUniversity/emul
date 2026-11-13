import { diagonalSquare, flipped, nextRotation, objectRect, objectSize, orientationOf, snap, unionOf, type FlipAxis, type Point, type Rect, type Step, type Turn } from "./geometry"
import { getDef } from "./registry"
import { turnLanding } from "./placement"
import type { ComponentDef, PlacedObject, Schematic } from "./types"

function reoriented(object: PlacedObject, axis: FlipAxis): PlacedObject {
  const { rotation, mirror } = flipped(orientationOf(object), axis)
  const { rotation: _rotation, mirror: _mirror, ...rest } = object
  return { ...rest, ...(rotation && { rotation }), ...(mirror && { mirror }) }
}

export function flipSelection(doc: Schematic, ids: ReadonlySet<string>, axis: FlipAxis, grid: number, line?: number): Schematic {
  const chosen = doc.objects.filter((o) => ids.has(o.id) && getDef(o.def))
  if (chosen.length === 0) return doc
  if (chosen.length === 1 && line === undefined) return { ...doc, objects: doc.objects.map((o) => (o === chosen[0] ? reoriented(o, axis) : o)) }

  const horizontal = axis === "horizontal"
  const rects = new Map(chosen.map((o) => [o.id, objectRect(o, grid)]))
  const starts = [...rects.values()].map((r) => (horizontal ? r.x : r.y))
  const ends = [...rects.values()].map((r) => (horizontal ? r.x + r.w : r.y + r.h))
  const across = line ?? snap(Math.min(...starts) + Math.max(...ends), grid)
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

export function selectionStep(doc: Schematic, ids: ReadonlySet<string>, withWires = false): Step {
  return !withWires && doc.objects.every((o) => standsOnADiagonal(o, ids)) ? 45 : 90
}

const pivotOf = (o: PlacedObject, def: ComponentDef, grid: number): Point => {
  const cell = turningCell(objectSize(def, o.rotation))
  return { x: o.x + cell.x * grid, y: o.y + cell.y * grid }
}

export function turnPivot(doc: Schematic, ids: ReadonlySet<string>, grid: number, extra: readonly Rect[] = []): Point | null {
  const chosen = doc.objects.filter((o) => ids.has(o.id) && getDef(o.def))
  if (!chosen.length && !extra.length) return null
  if (chosen.length === 1 && !extra.length) return pivotOf(chosen[0], getDef(chosen[0].def)!, grid)
  const box = unionOf([...chosen.map((o) => objectRect(o, grid)), ...extra])
  return { x: snap(box.x, grid) + Math.floor(Math.round(box.w / grid) / 2) * grid, y: snap(box.y, grid) + Math.floor(Math.round(box.h / grid) / 2) * grid }
}

export function turnedAbout(p: Point, pivot: Point, degrees: number): Point {
  const rad = (degrees * Math.PI) / 180
  const cos = Math.round(Math.cos(rad) * 1e12) / 1e12
  const sin = Math.round(Math.sin(rad) * 1e12) / 1e12
  const dx = p.x - pivot.x
  const dy = p.y - pivot.y
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos }
}

export function turnedSelection(doc: Schematic, ids: ReadonlySet<string>, steps: number, grid: number, about?: { pivot: Point; step: Step }): Schematic {
  const pivot = about?.pivot ?? turnPivot(doc, ids, grid)
  if (!pivot || !steps) return doc
  const step = about?.step ?? selectionStep(doc, ids)
  const turn: Turn = steps > 0 ? 1 : -1
  const objects = doc.objects.map((o) => {
    if (!ids.has(o.id)) return o
    const def = getDef(o.def)
    if (!def) return o
    let rotation = o.rotation ?? 0
    for (let k = 0; k < Math.abs(steps); k++) rotation = nextRotation(def, rotation, turn, step)
    const swung = turnedAbout(pivotOf(o, def, grid), pivot, steps * step)
    const after = turningCell(objectSize(def, rotation))
    return { ...o, rotation, x: snap(swung.x, grid) - after.x * grid, y: snap(swung.y, grid) - after.y * grid }
  })
  return { ...doc, objects }
}

export const rotateSelection = (doc: Schematic, ids: ReadonlySet<string>, turn: Turn, grid: number): Schematic => turnedSelection(doc, ids, turn, grid)

export function flipLine(doc: Schematic, ids: ReadonlySet<string>, axis: FlipAxis, grid: number, extra: readonly Rect[] = []): number | null {
  const chosen = doc.objects.filter((o) => ids.has(o.id) && getDef(o.def))
  if (!chosen.length && !extra.length) return null
  const horizontal = axis === "horizontal"
  const rects = [...chosen.map((o) => objectRect(o, grid)), ...extra]
  if (rects.length === 1 && chosen.length === 1) return horizontal ? 2 * rects[0].x + rects[0].w : 2 * rects[0].y + rects[0].h
  const starts = rects.map((r) => (horizontal ? r.x : r.y))
  const ends = rects.map((r) => (horizontal ? r.x + r.w : r.y + r.h))
  return snap(Math.min(...starts) + Math.max(...ends), grid)
}

export type InPlace = { readonly doc: Schematic; readonly shift: Point }

export function landedInPlace(before: Schematic, after: Schematic, ids: ReadonlySet<string>, grid: number): InPlace | null {
  if (after === before) return { doc: after, shift: { x: 0, y: 0 } }
  const chosen = (doc: Schematic) => doc.objects.filter((o) => ids.has(o.id))
  const shift = turnLanding(after.objects, chosen(before), chosen(after), grid)
  if (!shift) return null
  if (!shift.x && !shift.y) return { doc: after, shift }
  return { doc: { ...after, objects: after.objects.map((o) => (ids.has(o.id) ? { ...o, x: o.x + shift.x, y: o.y + shift.y } : o)) }, shift }
}
