import * as React from "react"
import { objectIndex, objectRect, snap } from "@/schematic/geometry"
import { getDef, getDefsVersion, getMeta, subscribeDefs } from "@/schematic/registry"
import type { PlacedObject } from "@/schematic/types"
import type { WireColorKey } from "@/schematic/wire-colors"
import { FieldCanvas } from "./FieldCanvas"
import { ComponentView } from "./ComponentView"
import { PinLayer } from "./PinLayer"
import type { FieldDetail } from "./detail"
import type { SimStore } from "@/sim/sim-store"
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

/** Where a part taken from the palette lands: the part itself, see-through, centred on the pointer and snapped as it will be placed. */
function placementObject(defId: string, at: { x: number; y: number }, grid: number): PlacedObject | null {
  const def = getDef(defId)
  if (!def) return null
  return { id: "placing", def: defId, x: snap(at.x - (def.width * grid) / 2, grid), y: snap(at.y - (def.height * grid) / 2, grid) }
}

const NOTHING = new Set<string>()
const NO_CONTACTS = new Map<string, string>()
const NO_PARTS = {}
const ignore = () => {}
const unconnected = () => false

/**
 * The part in hand, drawn as the field draws a placed one (its body and its pins, at the field's
 * level of detail) and see-through. Zoomed far out the field paints parts on a canvas, so does the ghost.
 */
export function PlacementGhost({ defId, at, grid, scale, detail, sim, colorOf, raster }: { defId: string; at: { x: number; y: number }; grid: number; scale: number; detail: FieldDetail; sim: SimStore; colorOf: (wireId: string) => WireColorKey; raster: SymbolRaster }) {
  // Redrawn when a file of parts arrives: the part in hand may be the one that was loading.
  const version = React.useSyncExternalStore(subscribeDefs, getDefsVersion)
  const object = React.useMemo(() => (void version, placementObject(defId, at, grid)), [defId, at, grid, version])
  if (!object) return <LoadingGhost defId={defId} at={at} grid={grid} scale={scale} />
  if (detail.canvas) {
    const box = objectRect(object, grid)
    const view = { x: box.x - grid, y: box.y - grid, w: box.w + 2 * grid, h: box.h + 2 * grid }
    return (
      <div data-slot="placement-ghost" className="pointer-events-none absolute top-0 left-0 opacity-60">
        <FieldCanvas objects={[object]} routes={NO_ROUTES} view={view} grid={grid} scale={scale} colorOf={colorOf} raster={raster} />
      </div>
    )
  }
  return (
    <div data-slot="placement-ghost" className="pointer-events-none absolute top-0 left-0 opacity-60 [&_*]:pointer-events-none!">
      <div className="absolute top-0 left-0">
        <ComponentView
          object={object}
          grid={grid}
          detail={detail}
          sheeted={false}
          selected={false}
          parts={NO_PARTS}
          sim={sim}
          onBodyPointerDown={ignore}
          onBodyPointerMove={ignore}
          onBodyPointerUp={ignore}
          onBodyContextMenu={ignore}
          onPartChange={ignore}
        />
      </div>
      <PinLayer objects={[object]} grid={grid} detail={detail} connected={unconnected} contacts={NO_CONTACTS} selected={NOTHING} onPinPointerDown={ignore} onPinPointerMove={ignore} onPinPointerUp={ignore} />
    </div>
  )
}

/** Cells the stand-in icon spans at most: a board's icon is not drawn board-sized. */
const LOADING_ICON_CELLS = 3

/**
 * A part whose file is still loading: its palette icon (the same IEC symbol) under the pointer,
 * as faint as the ghost, until the part itself can be drawn. The catalogue has the icon from the start.
 */
function LoadingGhost({ defId, at, grid, scale }: { defId: string; at: { x: number; y: number }; grid: number; scale: number }) {
  const meta = getMeta(defId)
  if (!meta) return null
  const size = Math.min(meta.width, meta.height, LOADING_ICON_CELLS) * grid
  const Icon = meta.icon
  return (
    <div data-slot="placement-ghost" data-loading="" className="pointer-events-none absolute text-foreground opacity-60" style={{ left: at.x - size / 2, top: at.y - size / 2, width: size, height: size }}>
      {/* The icon draws in a 24-unit box: its line stays about 1.5 screen px at any zoom. */}
      <Icon width={size} height={size} strokeWidth={(1.5 * 24) / (size * scale)} />
    </div>
  )
}
