import * as React from "react"
import type { PlacedObject } from "@/schematic/types"
import { BODY_EDGE_CELLS, BODY_MASK_ID, bodyMaskShapes } from "./body-mask"

const EVERYWHERE = 1e7

export const BodyMask = React.memo(function BodyMask({ objects, grid }: { objects: readonly PlacedObject[]; grid: number }) {
  const shapes = React.useMemo(() => bodyMaskShapes(objects, grid), [objects, grid])
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute top-0 left-0" width={0} height={0}>
      <defs>
        <mask id={BODY_MASK_ID} maskUnits="userSpaceOnUse" x={-EVERYWHERE} y={-EVERYWHERE} width={2 * EVERYWHERE} height={2 * EVERYWHERE}>
          <rect x={-EVERYWHERE} y={-EVERYWHERE} width={2 * EVERYWHERE} height={2 * EVERYWHERE} fill="white" />
          {shapes.bodies.map((points, i) => (
            <polygon key={`b${i}`} points={points.map((p) => `${p.x},${p.y}`).join(" ")} fill="black" stroke="black" strokeWidth={BODY_EDGE_CELLS * grid} strokeLinejoin="round" />
          ))}
          {shapes.leads.map(([a, b], i) => (
            <line key={`l${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="black" strokeWidth={BODY_EDGE_CELLS * grid} strokeLinecap="round" />
          ))}
          {shapes.texts.map((r, i) => (
            <rect key={`t${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill="black" />
          ))}
        </mask>
      </defs>
    </svg>
  )
})
