import * as React from "react"
import { orientationOf, stretchedLeads } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { placementOf, SELECTION_BANDS, selectionOutline, type Outline } from "./selection-geometry"
import { SELECTED_WIRE_PX } from "./wire-style"
import type { WirePlate } from "./wire-plate"

type SelectionLayerProps = {
  objects: readonly PlacedObject[]
  wires: readonly WirePlate[]
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

export const SelectionLayer = React.memo(function SelectionLayer({ objects, wires, selectedObjects, grid }: SelectionLayerProps) {
  if (selectedObjects.size === 0 && wires.length === 0) return null
  const plates = platesOf(objects, selectedObjects, grid)
  return (
    <svg data-slot="selection" aria-hidden="true" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: "var(--selection-plate-opacity)" }}>
        {SELECTION_BANDS.map(({ margin, color }) => (
          <g key={margin}>
            {wires.map((wire) => (
              <path key={wire.key} data-wire={wire.run} data-whole={wire.whole ? "" : undefined} d={wire.d} stroke={color} strokeWidth={SELECTED_WIRE_PX + margin * 2} strokeLinecap={wire.whole ? "round" : "butt"} vectorEffect="non-scaling-stroke" />
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
