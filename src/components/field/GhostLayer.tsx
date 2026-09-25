import * as React from "react"
import { objectIndex, objectRect } from "@/schematic/geometry"
import type { PlacedObject } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { FieldCanvas } from "./FieldCanvas"
import type { SymbolRaster } from "./symbol-raster"

export type Ghost = { key: string | number; color: string; ids: readonly string[]; dx: number; dy: number }

type GhostLayerProps = {
  ghosts: readonly Ghost[]
  objects: readonly PlacedObject[]
  grid: number
  scale: number
  colorOf: (wireId: string) => WireColorKey
  raster: SymbolRaster
}

const NO_ROUTES: never[] = []

function GhostView({ ghost, objects, grid, scale, colorOf, raster }: Omit<GhostLayerProps, "ghosts"> & { ghost: Ghost }) {
  const moved = React.useMemo(() => {
    const byId = objectIndex(objects)
    return ghost.ids.flatMap((id) => {
      const o = byId.get(id)
      return o ? [{ ...o, x: o.x + ghost.dx, y: o.y + ghost.dy }] : []
    })
  }, [objects, ghost])
  const boxes = moved.map((o) => objectRect(o, grid))
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((r) => r.x)) - grid
  const y = Math.min(...boxes.map((r) => r.y)) - grid
  const view = { x, y, w: Math.max(...boxes.map((r) => r.x + r.w)) + grid - x, h: Math.max(...boxes.map((r) => r.y + r.h)) + grid - y }
  return (
    <div className="pointer-events-none absolute top-0 left-0">
      <div className="opacity-70">
        <FieldCanvas objects={moved} routes={NO_ROUTES} view={view} grid={grid} scale={scale} colorOf={colorOf} raster={raster} />
      </div>
      {boxes.map((b, i) => (
        <div
          key={i}
          className="absolute rounded-md border-2"
          style={{ left: b.x, top: b.y, width: b.w, height: b.h, borderColor: ghost.color, backgroundColor: `${ghost.color}10` }}
        />
      ))}
    </div>
  )
}

export function GhostLayer({ ghosts, ...rest }: GhostLayerProps) {
  return (
    <>
      {ghosts.map((g) => (
        <GhostView key={g.key} ghost={g} {...rest} />
      ))}
    </>
  )
}
