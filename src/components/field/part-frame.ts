import { bodyCentre, orientationOf, type Point } from "@/schematic/geometry"
import type { ComponentDef, PlacedObject } from "@/schematic/types"

export type LeadCut = readonly [Point, Point, Point]

export function toPartFrame(object: PlacedObject, def: ComponentDef, grid: number) {
  const w = def.width * grid
  const h = def.height * grid
  const orientation = orientationOf(object)
  const centre = bodyCentre(def, orientation)
  const middle = { x: object.x + centre.x * grid, y: object.y + centre.y * grid }
  const angle = (-orientation.rotation * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return (p: Point): Point => {
    const x = p.x - middle.x
    const y = p.y - middle.y
    const turned = { x: x * cos - y * sin, y: x * sin + y * cos }
    return { x: (orientation.mirror ? -turned.x : turned.x) + w / 2, y: turned.y + h / 2 }
  }
}
