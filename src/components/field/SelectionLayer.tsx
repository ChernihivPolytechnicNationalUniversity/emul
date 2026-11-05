import * as React from "react"
import { orientationOf, stretchedLeads } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { placementOf, SELECTION_BANDS, selectionOutline, type Outline } from "./selection-geometry"
import { SELECTED_WIRE_PX } from "./wire-style"

type SelectionLayerProps = {
  objects: readonly PlacedObject[]
  segments: readonly { id: string; run: string; a: { x: number; y: number }; b: { x: number; y: number } }[]
  selectedObjects: ReadonlySet<string>
  grid: number
}

type Plate = { id: string; outline: Outline; transform: string }

function platesOf(objects: readonly PlacedObject[], selected: ReadonlySet<string>, grid: number): Plate[] {
  const plates: Plate[] = []
  for (const object of objects) {
    if (!selected.has(object.id)) continue
    const def = getDef(object.def)
    if (!def) continue
    const { left, top, w, h, rotation, mirror } = placementOf(object, def, grid)
    const reflect = mirror ? ` translate(${w} 0) scale(-1 1)` : ""
    const outline = selectionOutline(def)
    const stretch = stretchedLeads(def, orientationOf(object))
    plates.push({ id: object.id, outline: stretch ? { ...outline, strokes: `${outline.strokes} ${stretch}` } : outline, transform: `translate(${left} ${top}) rotate(${rotation} ${w / 2} ${h / 2})${reflect} scale(${grid})` })
  }
  return plates
}

export const SelectionLayer = React.memo(function SelectionLayer({ objects, segments, selectedObjects, grid }: SelectionLayerProps) {
  if (selectedObjects.size === 0 && segments.length === 0) return null
  const wires = segments.map((s) => ({ id: s.id, run: s.run, d: `M${s.a.x} ${s.a.y} L${s.b.x} ${s.b.y}` }))
  const plates = platesOf(objects, selectedObjects, grid)
  return (
    <svg data-slot="selection" aria-hidden="true" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: "var(--selection-plate-opacity)" }}>
        {SELECTION_BANDS.map(({ margin, color }) => (
          <g key={margin}>
            {wires.map((wire) => (
              <path key={wire.id} data-wire={wire.run} data-segment={wire.id} d={wire.d} stroke={color} strokeWidth={SELECTED_WIRE_PX + margin * 2} vectorEffect="non-scaling-stroke" />
            ))}
            {plates.map((plate) => (
              <g key={plate.id} data-plate={plate.id}>
                <path d={plate.outline.strokes} transform={plate.transform} stroke={color} strokeWidth={margin * 2} vectorEffect="non-scaling-stroke" />
                {plate.outline.hollow && <path d={plate.outline.hollow} transform={plate.transform} fill={color} stroke="none" />}
              </g>
            ))}
          </g>
        ))}
      </g>
    </svg>
  )
})
