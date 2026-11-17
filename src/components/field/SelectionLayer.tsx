import * as React from "react"
import { orientationOf, stretchedLeads, type Point } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import { placementOf, SELECTION_BANDS, selectionOutline, type Outline } from "./selection-geometry"
import { SELECTED_WIRE_PX } from "./wire-style"
import { notchPath, PLATE_REACH, type WirePlate } from "./wire-plate"

type SelectionLayerProps = {
  objects: readonly PlacedObject[]
  wires: readonly WirePlate[]
  selectedObjects: ReadonlySet<string>
  grid: number
}

const capsPath = (caps: readonly Point[]) => caps.map((p) => `M${p.x} ${p.y}l0 0`).join(" ")

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
  const prefix = `selection${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`
  if (selectedObjects.size === 0 && wires.length === 0) return null
  const plates = platesOf(objects, selectedObjects, grid)
  const notchId = (key: string) => `${prefix}-notch-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`
  const notched = (wire: WirePlate) => (wire.notches.length ? `url(#${notchId(wire.key)})` : undefined)
  return (
    <svg data-slot="selection" aria-hidden="true" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <defs>
        {wires.map((wire) =>
          wire.notches.length ? (
            <clipPath key={wire.key} id={notchId(wire.key)} clipPathUnits="userSpaceOnUse">
              <path data-notch="" d={notchPath(wire.notches, PLATE_REACH, wire.box)} clipRule="evenodd" />
            </clipPath>
          ) : null,
        )}
      </defs>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: "var(--selection-plate-opacity)" }}>
        {SELECTION_BANDS.map(({ margin, color }) => (
          <g key={margin}>
            {wires.map((wire) => (
              <React.Fragment key={wire.key}>
                <path data-wire={wire.run} data-whole={wire.whole ? "" : undefined} clipPath={notched(wire)} d={wire.d} stroke={color} strokeWidth={SELECTED_WIRE_PX + margin * 2} strokeLinecap="butt" vectorEffect="non-scaling-stroke" />
                {wire.caps.length > 0 && <path data-wire={wire.run} data-cap="" d={capsPath(wire.caps)} stroke={color} strokeWidth={SELECTED_WIRE_PX + margin * 2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
              </React.Fragment>
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
