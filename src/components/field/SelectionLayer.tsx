import * as React from "react"
import { toPath, type RoutedWire } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { placementOf, SELECTION_BANDS, selectionOutline, type Outline } from "./selection-geometry"
import { SELECTED_WIRE_PX, wireCornerRadius } from "./wire-style"

type SelectionLayerProps = {
  objects: readonly PlacedObject[]
  routes: readonly RoutedWire[]
  selectedObjects: ReadonlySet<string>
  selectedWires: ReadonlySet<string>
  grid: number
}

type Plate = { id: string; outline: Outline; transform: string }

function platesOf(objects: readonly PlacedObject[], selected: ReadonlySet<string>, grid: number): Plate[] {
  const plates: Plate[] = []
  for (const object of objects) {
    if (!selected.has(object.id)) continue
    const def = getDef(object.def)
    if (!def) continue
    const { left, top, w, h, rotation } = placementOf(object, def, grid)
    plates.push({ id: object.id, outline: selectionOutline(def), transform: `translate(${left} ${top}) rotate(${rotation} ${w / 2} ${h / 2}) scale(${grid})` })
  }
  return plates
}

export const SelectionLayer = React.memo(function SelectionLayer({ objects, routes, selectedObjects, selectedWires, grid }: SelectionLayerProps) {
  if (selectedObjects.size === 0 && selectedWires.size === 0) return null
  const radius = wireCornerRadius(grid)
  const wires = routes.filter((route) => selectedWires.has(route.id)).map((route) => ({ id: route.id, d: toPath(route.pts, radius) }))
  const plates = platesOf(objects, selectedObjects, grid)
  return (
    <svg data-slot="selection" aria-hidden="true" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: "var(--selection-plate-opacity)" }}>
        {SELECTION_BANDS.map(({ margin, color }) => (
          <g key={margin}>
            {wires.map((wire) => (
              <path key={wire.id} data-wire={wire.id} d={wire.d} stroke={color} strokeWidth={SELECTED_WIRE_PX + margin * 2} vectorEffect="non-scaling-stroke" />
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
