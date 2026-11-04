import * as React from "react"
import { cn } from "@/lib/utils"
import { toPath, trimRouteEnds, type Point, type RoutedWire } from "@/schematic/geometry"
import { runPath, type PinCorner } from "@/schematic/wire-look"
import type { SpatialIndex } from "@/schematic/spatial"
import type { PlacedObject } from "@/schematic/types"
import { wireColorVar, wireFlowVar, type WireColorKey } from "@/schematic/wire-colors"
import { CASING_PX, casingTrim, SELECTED_WIRE_PX, WIRE_PX, wireCornerRadius } from "./wire-style"
import { pendingPoints, type PendingWire } from "./pending-wire"
import type { WireFlow } from "./wire-flow"

export type { PendingWire }


const HIT_PX = 14
const HANDLE_CELLS = 0.15
const HANDLE_MIN_PX = 2.5
const HANDLE_MAX_PX = 4
const DOT_CELLS = 0.2
const DOT_MIN_PX = 1.5 * WIRE_PX
const DOT_MAX_PX = 2.5 * WIRE_PX
const OPEN_END_CELLS = 0.14

type WireLayerProps = {
  routes: readonly RoutedWire[]
  grid: number
  scale: number
  selected: ReadonlySet<string>
  hoveredNet: string | null
  colorOf: (wireId: string) => WireColorKey
  netOfWire: (wireId: string) => string | undefined
  dots: readonly Point[]
  dangling: readonly Point[]
  corners: readonly PinCorner[]
  flow: WireFlow
  onWirePointerDown: (e: React.PointerEvent<SVGPathElement>, id: string) => void
  onWirePointerEnter: (id: string) => void
  onWirePointerLeave: (id: string) => void
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
  dots,
  dangling,
  corners,
  flow,
  onWirePointerDown,
  onWirePointerEnter,
  onWirePointerLeave,
}: WireLayerProps) {
  React.useEffect(() => {
    flow.setScale(scale)
  }, [flow, scale])
  const radius = wireCornerRadius(grid)
  const px = 1 / scale
  const dotR = Math.min(Math.max(DOT_CELLS * grid * scale, DOT_MIN_PX), DOT_MAX_PX) * px
  const endOf = React.useMemo(() => {
    const m = new Map<string, string>()
    for (const r of routes) for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) if (p) m.set(`${p.x},${p.y}`, r.id)
    return m
  }, [routes])
  const marks = React.useMemo(
    () => ({
      dots: dots.flatMap((p) => {
        const id = endOf.get(`${p.x},${p.y}`)
        return id ? [{ p, id }] : []
      }),
      open: dangling.flatMap((p) => {
        const id = endOf.get(`${p.x},${p.y}`)
        return id ? [{ p, id }] : []
      }),
    }),
    [dots, dangling, endOf],
  )

  const groups = React.useMemo(() => groupByNet(routes, netOfWire), [routes, netOfWire])
  const paths = React.useMemo(() => new Map(routes.map((r) => [r.id, runPath(r.pts, radius, r.leads)])), [routes, radius])
  const patches = React.useMemo(
    () => [
      ...routes.flatMap((r) => [r.leads?.start && toPath([r.leads.start, r.pts[0]]), r.leads?.end && toPath([r.leads.end, r.pts[r.pts.length - 1]])].filter((d): d is string => !!d)),
      ...corners.map((c) => toPath([c.a, c.at, c.b])),
    ],
    [routes, corners],
  )
  const pathOf = (id: string) => paths.get(id) ?? ""
  const trim = casingTrim(grid)
  const casings = React.useMemo(() => new Map(routes.map((r) => [r.id, toPath(trimRouteEnds(r.pts, trim), radius)])), [routes, radius, trim])
  const casingOf = (id: string) => casings.get(id) ?? ""
  const widthOf = (id: string) => (selected.has(id) ? SELECTED_WIRE_PX : WIRE_PX)

  return (
    <svg data-slot="wires" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      {patches.length > 0 && (
        <g data-slot="pin-turns" pointerEvents="none">
          {patches.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--background)" strokeWidth={WIRE_PX + CASING_PX} strokeLinecap="butt" strokeLinejoin="miter" vectorEffect="non-scaling-stroke" />
          ))}
          {corners.map((c) => (
            <path key={`${c.at.x},${c.at.y}`} data-corner={`${c.at.x},${c.at.y}`} d={`M${c.a.x} ${c.a.y} Q${c.at.x} ${c.at.y} ${c.b.x} ${c.b.y}`} fill="none" className="stroke-foreground" strokeWidth={WIRE_PX} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      )}
      {groups.map(({ net, wires }) => (
        <g
          key={net}
          data-net={net}
          className={cn(hoveredNet !== null && net !== hoveredNet && "opacity-25")}
          style={{ transition: "opacity 120ms" }}
        >
          {wires.map(
            (route) =>
              !selected.has(route.id) && (
                <path
                  key={route.id}
                  data-wire={route.id}
                  data-casing=""
                  d={casingOf(route.id)}
                  fill="none"
                  stroke="var(--background)"
                  strokeWidth={WIRE_PX + CASING_PX}
                  strokeLinejoin="round"
                  strokeLinecap="butt"
                  vectorEffect="non-scaling-stroke"
                />
              ),
          )}
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
                />
              </g>
            )
          })}
        </g>
      ))}
      <g data-slot="wire-marks" pointerEvents="none">
        {marks.dots.map(({ p, id }) => (
          <g key={`dot:${p.x},${p.y}`} data-junction={`${p.x},${p.y}`}>
            <circle cx={p.x} cy={p.y} r={dotR + CASING_PX * px} fill="var(--background)" />
            <circle cx={p.x} cy={p.y} r={dotR} fill={wireColorVar(colorOf(id))} />
          </g>
        ))}
        {marks.open.map(({ p, id }) => (
          <circle key={`open:${p.x},${p.y}`} data-dangling={`${p.x},${p.y}`} cx={p.x} cy={p.y} r={OPEN_END_CELLS * grid} fill="var(--background)" stroke={wireColorVar(colorOf(id))} strokeWidth={WIRE_PX} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  )
})

type PendingPart = "route" | "marks"

export function PendingWireLayer({ objects, index, pending, grid, scale, part }: { objects: readonly PlacedObject[]; index: SpatialIndex; pending: PendingWire | null; grid: number; scale: number; part: PendingPart }) {
  if (!pending) return null
  return (
    <svg data-slot={`pending-wire-${part}`} className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <Pending objects={objects} index={index} pending={pending} grid={grid} radius={wireCornerRadius(grid)} handleR={handleRadius(grid, scale)} part={part} />
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

function Pending({ objects, index, pending, grid, radius, handleR, part }: { objects: readonly PlacedObject[]; index: SpatialIndex; pending: PendingWire; grid: number; radius: number; handleR: number; part: PendingPart }) {
  const pts = pendingPoints(objects, index, pending, grid)
  if (!pts) return null
  const d = toPath(pts, radius)
  const color = wireColorVar(pending.color)
  const end = pts[pts.length - 1]
  if (part === "marks") {
    return (
      <g pointerEvents="none">
        {pending.points.map((p, idx) => (
          <circle key={idx} cx={p.x} cy={p.y} r={handleR} fill={color} stroke="var(--background)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ))}
        <circle cx={end.x} cy={end.y} r={pending.target ? handleR * 1.4 : handleR} fill={pending.target ? color : "var(--background)"} stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </g>
    )
  }
  return (
    <g pointerEvents="none">
      <path d={toPath(trimRouteEnds(pts, casingTrim(grid)), radius)} fill="none" stroke="var(--background)" strokeWidth={WIRE_PX + CASING_PX} strokeLinejoin="round" strokeLinecap="butt" vectorEffect="non-scaling-stroke" />
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
    </g>
  )
}

