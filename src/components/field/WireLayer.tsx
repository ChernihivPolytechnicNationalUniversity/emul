import * as React from "react"
import { cn } from "@/lib/utils"
import {
  nearestSegment,
  toPath,
  type Point,
  type RoutedWire,
} from "@/schematic/geometry"
import type { SpatialIndex } from "@/schematic/spatial"
import type { PlacedObject } from "@/schematic/types"
import { wireColorVar, wireFlowVar, type WireColorKey } from "@/schematic/wire-colors"
import { wireCornerRadius } from "./wire-style"
import { pendingPoints, type PendingWire } from "./pending-wire"
import type { WireFlow } from "./wire-flow"

export type { PendingWire }


const WIRE_PX = 2
const CASING_PX = 3
const SELECTED_EXTRA_PX = 1
const HALO_PX = 7
const HIT_PX = 14
const HANDLE_CELLS = 0.15
const HANDLE_MIN_PX = 2.5
const HANDLE_MAX_PX = 4
const HANDLE_HIT_PX = 11

type WireLayerProps = {
  routes: readonly RoutedWire[]
  grid: number
  scale: number
  selected: ReadonlySet<string>
  hoveredNet: string | null
  colorOf: (wireId: string) => WireColorKey
  netOfWire: (wireId: string) => string | undefined
  bendsOf: (wireId: string) => readonly Point[] | undefined
  flow: WireFlow
  onWirePointerDown: (e: React.PointerEvent<SVGPathElement>, id: string) => void
  onWirePointerEnter: (id: string) => void
  onWirePointerLeave: (id: string) => void
  /** Double-click on a segment: insert a bend at `index` of the wire's points. */
  onInsertBend: (wireId: string, index: number, clientX: number, clientY: number) => void
  onRemoveBend: (wireId: string, index: number) => void
  onBendPointerDown: (e: React.PointerEvent<SVGGElement>, wireId: string, index: number) => void
  onBendPointerMove: (e: React.PointerEvent<SVGGElement>) => void
  onBendPointerUp: (e: React.PointerEvent<SVGGElement>) => void
}

type NetGroup = { net: string; wires: RoutedWire[] }

/**
 * All wires in world coordinates, drawn in one SVG over the content layer. Wires are painted a
 * net at a time — every casing of the net first, then every coloured body — so the wires of one
 * net meet cleanly at junctions and shared corridors, while a wire of another net still breaks
 * the one it crosses.
 */
export const WireLayer = React.memo(function WireLayer({
  routes,
  grid,
  scale,
  selected,
  hoveredNet,
  colorOf,
  netOfWire,
  bendsOf,
  flow,
  onWirePointerDown,
  onWirePointerEnter,
  onWirePointerLeave,
  onInsertBend,
  onRemoveBend,
  onBendPointerDown,
  onBendPointerMove,
  onBendPointerUp,
}: WireLayerProps) {
  React.useEffect(() => {
    flow.setScale(scale)
  }, [flow, scale])
  const radius = wireCornerRadius(grid)
  const px = 1 / scale
  const handleR = handleRadius(grid, scale)

  const groups = React.useMemo(() => groupByNet(routes, netOfWire), [routes, netOfWire])
  const paths = React.useMemo(() => new Map(routes.map((r) => [r.id, toPath(r.pts, radius)])), [routes, radius])
  const pathOf = (id: string) => paths.get(id) ?? ""
  const widthOf = (id: string) => WIRE_PX + (selected.has(id) ? SELECTED_EXTRA_PX : 0)

  return (
    <svg data-slot="wires" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      {groups.map(({ net, wires }) => (
        <g
          key={net}
          data-net={net}
          className={cn(hoveredNet !== null && net !== hoveredNet && "opacity-25")}
          style={{ transition: "opacity 120ms" }}
        >
          {wires.map(
            (route) =>
              selected.has(route.id) && (
                <path
                  key={route.id}
                  data-wire={route.id}
                  d={pathOf(route.id)}
                  fill="none"
                  stroke="var(--primary)"
                  strokeOpacity={0.22}
                  strokeWidth={HALO_PX}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              ),
          )}
          {wires.map((route) => (
            <path
              key={route.id}
              data-wire={route.id}
              d={pathOf(route.id)}
              fill="none"
              stroke="var(--background)"
              strokeWidth={widthOf(route.id) + CASING_PX}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {wires.map((route) => {
            const d = pathOf(route.id)
            const width = widthOf(route.id)
            const colorKey = colorOf(route.id)
            const color = wireColorVar(colorKey)
            return (
              <g key={route.id} data-wire={route.id} className="group/wire">
                <path
                  ref={flow.bodyRef(route.id)}
                  data-base={width}
                  d={d}
                  fill="none"
                  stroke={color}
                  strokeWidth={width}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  ref={flow.dashRef(route.id)}
                  d={d}
                  fill="none"
                  stroke={wireFlowVar(colorKey)}
                  strokeWidth={width}
                  strokeDasharray={`${width * 2} ${width * 5.5}`}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  style={{ opacity: 0 }}
                />
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={HIT_PX}
                  vectorEffect="non-scaling-stroke"
                  className="pointer-events-auto cursor-pointer"
                  onPointerDown={(e) => onWirePointerDown(e, route.id)}
                  onPointerEnter={() => onWirePointerEnter(route.id)}
                  onPointerLeave={() => onWirePointerLeave(route.id)}
                  onDoubleClick={(e) => {
                    const seg = nearestSegment(route.pts, clientToLocal(e))
                    onInsertBend(route.id, route.owner[seg], e.clientX, e.clientY)
                  }}
                />
                {selected.has(route.id) &&
                  bendsOf(route.id)?.map((p, idx) => (
                    <g
                      key={idx}
                      data-bend={idx}
                      className="group/bend pointer-events-auto cursor-move"
                      onPointerDown={(e) => onBendPointerDown(e, route.id, idx)}
                      onPointerMove={onBendPointerMove}
                      onPointerUp={onBendPointerUp}
                      onPointerCancel={onBendPointerUp}
                      onDoubleClick={(e) => {
                        e.stopPropagation()
                        onRemoveBend(route.id, idx)
                      }}
                    >
                      <circle cx={p.x} cy={p.y} r={HANDLE_HIT_PX * px} fill="transparent" stroke="none" />
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={handleR}
                        fill={color}
                        stroke="var(--background)"
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                        className="transition-[r] group-hover/bend:fill-primary"
                        pointerEvents="none"
                      />
                    </g>
                  ))}
              </g>
            )
          })}
        </g>
      ))}
    </svg>
  )
})

export function PendingWireLayer({ objects, index, pending, grid, scale }: { objects: readonly PlacedObject[]; index: SpatialIndex; pending: PendingWire | null; grid: number; scale: number }) {
  if (!pending) return null
  return (
    <svg data-slot="pending-wire" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <Pending objects={objects} index={index} pending={pending} grid={grid} radius={wireCornerRadius(grid)} handleR={handleRadius(grid, scale)} />
    </svg>
  )
}

function groupByNet(routes: readonly RoutedWire[], netOfWire: (wireId: string) => string | undefined): NetGroup[] {
  const byNet = new Map<string, RoutedWire[]>()
  for (const r of routes) {
    const net = netOfWire(r.id) ?? r.id
    const list = byNet.get(net)
    if (list) list.push(r)
    else byNet.set(net, [r])
  }
  return [...byNet].map(([net, wires]) => ({ net, wires }))
}

function handleRadius(grid: number, scale: number) {
  return Math.min(Math.max(HANDLE_CELLS * grid, HANDLE_MIN_PX / scale), HANDLE_MAX_PX / scale)
}

function Pending({ objects, index, pending, grid, radius, handleR }: { objects: readonly PlacedObject[]; index: SpatialIndex; pending: PendingWire; grid: number; radius: number; handleR: number }) {
  const pts = pendingPoints(objects, index, pending, grid)
  if (!pts) return null
  const d = toPath(pts, radius)
  const color = wireColorVar(pending.color)
  const end = pts[pts.length - 1]
  return (
    <g pointerEvents="none">
      <path d={d} fill="none" stroke="var(--background)" strokeWidth={WIRE_PX + CASING_PX} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={WIRE_PX}
        strokeDasharray={pending.target ? undefined : `${WIRE_PX * 3} ${WIRE_PX * 2.5}`}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {pending.points.map((p, idx) => (
        <circle key={idx} cx={p.x} cy={p.y} r={handleR} fill={color} stroke="var(--background)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ))}
      <circle cx={end.x} cy={end.y} r={pending.target ? handleR * 1.4 : handleR} fill={pending.target ? color : "var(--background)"} stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </g>
  )
}

function clientToLocal(e: React.MouseEvent<SVGPathElement>): Point {
  const svg = e.currentTarget.ownerSVGElement
  const m = svg?.getScreenCTM()?.inverse()
  if (!m) return { x: e.clientX, y: e.clientY }
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m)
  return { x: p.x, y: p.y }
}
