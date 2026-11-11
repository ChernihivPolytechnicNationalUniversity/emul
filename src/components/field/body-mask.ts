import { bodyAndLeads } from "@/schematic/body"
import { placedFields } from "@/schematic/fields"
import { framePoint, orientationOf, type Point, type Rect } from "@/schematic/geometry"
import { footprints } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"

export const BODY_MASK_ID = "field-body-mask"
export const BODY_MASK = `url(#${BODY_MASK_ID})`

export const BODY_EDGE_CELLS = 0.15

export type BodyMaskShapes = { bodies: Point[][]; leads: (readonly [Point, Point])[]; texts: Rect[] }

export function bodyMaskShapes(objects: readonly PlacedObject[], grid: number): BodyMaskShapes {
  const shapes: BodyMaskShapes = { bodies: [], leads: [], texts: [] }
  for (const object of objects) {
    const def = getDef(object.def)
    if (!def || def.pinsAreSockets) continue
    const orientation = orientationOf(object)
    shapes.bodies.push(bodyAndLeads(def).hull.map((p) => {
      const at = framePoint(def, orientation, p)
      return { x: object.x + at.x * grid, y: object.y + at.y * grid }
    }))
    shapes.leads.push(...(footprints(object, grid)?.leads ?? []))
    shapes.texts.push(...placedFields(object, grid, def).map((f) => f.box))
  }
  return shapes
}
