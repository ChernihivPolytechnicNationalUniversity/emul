import * as React from "react"
import { BODY_MASK } from "./body-mask"
import { cn } from "@/lib/utils"
import { toPath, type Point, type RoutedWire } from "@/schematic/geometry"
import type { PinCorner } from "@/schematic/wire-look"
import { wireColorVar, wireFlowVar, type WireColorKey } from "@/schematic/wire-colors"
import { bendsOf, type Stretch } from "@/schematic/conflict-marks"
import { casingWidth, CONFLICT_PX, glowCutWidth, dotRadius, OPEN_END_CELLS, SELECTED_WIRE_PX, WIRE_HIT_PX, WIRE_PX } from "./wire-style"
import { conflictCutPaths, conflictGlowPaths, PENDING_WIRE_CUT_ID, WIRE_LIFT_CUT_ID, wireCasingPath, wireStrokePath } from "./wire-paths"
import { wireMarks } from "./wire-marks"
import type { WireFlow } from "./wire-flow"
import { netCuts, regionAround } from "./wire-cuts"


const HANDLE_CELLS = 0.15
const HANDLE_PER_WIRE = 1.25

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
  lifted?: boolean
  onWirePointerDown: (e: React.PointerEvent<SVGPathElement>, id: string) => void
  onWirePointerEnter: (id: string) => void
  onWirePointerLeave: (id: string) => void
}

type NetGroup = { net: string; wires: RoutedWire[] }

const EVERYWHERE = { x: -1e7, y: -1e7, width: 2e7, height: 2e7 }

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
  lifted = false,
  onWirePointerDown,
  onWirePointerEnter,
  onWirePointerLeave,
}: WireLayerProps) {
  const dotR = dotRadius(grid, WIRE_PX)
  const hitWidth = Math.max(WIRE_HIT_PX, WIRE_HIT_PX / scale)
  const marks = React.useMemo(() => wireMarks(routes, dots, dangling, corners, colorOf, true), [routes, dots, dangling, corners, colorOf])
  const prefix = `wires${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`
  const cutId = (net: number) => `${prefix}-cut-${net}`
  const maskId = (net: number) => `${prefix}-mask-${net}`

  const groups = React.useMemo(() => groupByNet(routes, netOfWire), [routes, netOfWire])
  const wiresAt = React.useMemo(() => wiresByPoint(routes), [routes])
  const wiresOf = (at: Point) => wiresAt.get(`${at.x},${at.y}`)?.join(" ")
  const cuts = React.useMemo(() => netCuts(groups, grid), [groups, grid])
  const extents = React.useMemo(() => new Map(routes.map((r) => [r.id, regionAround([r], grid)])), [routes, grid])
  const paths = React.useMemo(() => new Map(routes.map((r) => [r.id, wireStrokePath(r, grid)])), [routes, grid])
  const pathOf = (id: string) => paths.get(id) ?? ""
  const casings = React.useMemo(() => new Map(routes.map((r) => [r.id, wireCasingPath(r, grid)])), [routes, grid])
  const casingOf = (id: string) => casings.get(id) ?? ""
  const widthOf = (id: string) => (selected.has(id) ? SELECTED_WIRE_PX : WIRE_PX)

  return (
    <svg data-slot="wires" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <defs>
        {groups.map(({ net, wires }, j) => (
          <g key={net} id={cutId(j)}>
            {wires.map((route) => (
              <path
                key={route.id}
                data-wire={route.id}
                data-casing=""
                d={casingOf(route.id)}
                fill="none"
                stroke="black"
                strokeWidth={casingWidth(widthOf(route.id))}
                strokeLinejoin="round"
                strokeLinecap="butt"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </g>
        ))}
        {groups.map(({ net }, i) => {
          if (!cuts.cutBy[i].length) return null
          return (
            <mask key={net} id={maskId(i)}>
              <rect {...EVERYWHERE} fill="white" />
              <g mask={BODY_MASK}>
                {cuts.cutBy[i].map((j) => (
                  <use key={j} href={`#${cutId(j)}`} />
                ))}
              </g>
            </mask>
          )
        })}
        <mask id={WIRE_LIFT_CUT_ID}>
          <rect {...EVERYWHERE} fill="white" />
          <g mask={BODY_MASK}>
            <use href={`#${PENDING_WIRE_CUT_ID}`} />
            <g data-slot="band-cut" />
          </g>
        </mask>
      </defs>
      <g mask={lifted ? `url(#${WIRE_LIFT_CUT_ID})` : undefined}>
        <g data-slot="wire-nets">
          {groups.map(({ net, wires }, i) => (
            <g
              key={net}
              data-net={net}
              className={cn(hoveredNet !== null && net !== hoveredNet && "opacity-50")}
              style={{ transition: "opacity 120ms" }}
            >
              <g mask={cuts.cutBy[i].length ? `url(#${maskId(i)})` : undefined}>
                {wires.map((route) => {
                  const d = pathOf(route.id)
                  const width = widthOf(route.id)
                  const colorKey = colorOf(route.id)
                  const color = wireColorVar(colorKey)
                  const extent = extents.get(route.id)
                  return (
                    <g key={route.id} data-wire={route.id} data-points={route.pts.map((p) => `${p.x},${p.y}`).join(" ")} className="group/wire">
                      {extent && <rect data-extent="" {...extent} fill="none" />}
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
                        strokeWidth={hitWidth}
                        vectorEffect="non-scaling-stroke"
                        className="pointer-events-auto cursor-(--wire-cursor)"
                        onPointerDown={(e) => onWirePointerDown(e, route.id)}
                        onPointerEnter={() => onWirePointerEnter(route.id)}
                        onPointerLeave={() => onWirePointerLeave(route.id)}
                      />
                    </g>
                  )
                })}
              </g>
            </g>
          ))}
        </g>
      </g>
      <g data-slot="wire-marks" pointerEvents="none">
        {marks.dots.map(({ at, color }) => (
          <g key={`dot:${at.x},${at.y}`} data-junction={`${at.x},${at.y}`} data-wires={wiresOf(at)}>
            {color ? <circle cx={at.x} cy={at.y} r={dotR} fill={wireColorVar(color)} /> : <circle cx={at.x} cy={at.y} r={dotR} className="fill-foreground" />}
          </g>
        ))}
        {marks.open.map(({ at, color }) => (
          <circle key={`open:${at.x},${at.y}`} data-dangling={`${at.x},${at.y}`} data-wires={wiresOf(at)} cx={at.x} cy={at.y} r={OPEN_END_CELLS * grid} fill="var(--background)" stroke={wireColorVar(color)} strokeWidth={WIRE_PX} vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    </svg>
  )
})

const PIN_TURN_GLOW_CUT_ID = "pin-turn-glow-cut"

export const PinTurnLayer = React.memo(function PinTurnLayer({ corners, scale, grid, conflict }: { corners: readonly PinCorner[]; scale: number; grid: number; conflict?: readonly Stretch[] }) {
  const px = 1 / scale
  const cut = conflict?.length ? conflictCutPaths(conflict, grid) : []
  return (
    <svg data-slot="pin-turns" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      {cut.length > 0 && <GlowCut id={PIN_TURN_GLOW_CUT_ID} paths={cut} px={px} />}
      <g mask={cut.length > 0 ? `url(#${PIN_TURN_GLOW_CUT_ID})` : undefined}>
        <g data-slot="pin-turn-patches" pointerEvents="none">
          <g data-band-patches="" />
        </g>
      </g>
      {corners.map((c) => (
        <path key={`${c.at.x},${c.at.y}`} data-corner={`${c.at.x},${c.at.y}`} d={`M${c.a.x} ${c.a.y} Q${c.at.x} ${c.at.y} ${c.b.x} ${c.b.y}`} fill="none" className="stroke-foreground" strokeWidth={WIRE_PX} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  )
})

export type ContinueCue = { at: Point; along: Point | null; color: WireColorKey; reach: number }

const CUE_STUB_PX = 14

const outward = (at: Point, along: Point, by: number): Point => ({ x: at.x + along.x * by, y: at.y + along.y * by })

export function OpenEndCue({ cue, grid, scale }: { cue: ContinueCue | null; grid: number; scale: number }) {
  if (!cue) return null
  const { at, along, color, reach } = cue
  const stroke = wireColorVar(color)
  const stub = along && Math.max(grid, CUE_STUB_PX / scale)
  return (
    <svg data-slot="open-end-cue" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      {along && stub && (
        <path
          d={toPath([outward(at, along, reach), outward(at, along, reach + stub)])}
          fill="none"
          stroke={stroke}
          strokeWidth={WIRE_PX}
          strokeDasharray={`${WIRE_PX * 3} ${WIRE_PX * 2.5}`}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <circle data-continues={`${at.x},${at.y}`} cx={at.x} cy={at.y} r={reach} fill="none" stroke={stroke} strokeWidth={WIRE_PX} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

type PendingPart = "route" | "marks" | "glow"

export type PendingLook = { points: readonly Point[]; corners: readonly Point[]; color: WireColorKey; refused: boolean; landing: boolean; conflict?: readonly Stretch[] }

export function PendingWireLayer({ pending, grid, scale, part }: { pending: PendingLook | null; grid: number; scale: number; part: PendingPart }) {
  if (!pending || pending.points.length < 1) return null
  if (part === "glow") return <Pending pending={pending} grid={grid} px={1 / scale} handleR={handleRadius(grid)} part={part} />
  return (
    <svg data-slot={`pending-wire-${part}`} data-refused={pending.refused ? "" : undefined} className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <Pending pending={pending} grid={grid} px={1 / scale} handleR={handleRadius(grid)} part={part} />
    </svg>
  )
}

function GlowCut({ id, paths, px }: { id: string; paths: readonly string[]; px: number }) {
  return (
    <mask id={id} maskUnits="userSpaceOnUse" {...EVERYWHERE}>
      <rect {...EVERYWHERE} fill="white" />
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="black" strokeWidth={glowCutWidth(px)} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </mask>
  )
}

function wiresByPoint(routes: readonly RoutedWire[]): Map<string, string[]> {
  const byPoint = new Map<string, string[]>()
  for (const r of routes)
    for (const p of r.pts) {
      const key = `${p.x},${p.y}`
      const ids = byPoint.get(key)
      if (!ids) byPoint.set(key, [r.id])
      else if (ids.at(-1) !== r.id) ids.push(r.id)
    }
  return byPoint
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

function handleRadius(grid: number) {
  return Math.max(HANDLE_CELLS * grid, HANDLE_PER_WIRE * WIRE_PX)
}

function Pending({ pending, grid, px, handleR, part }: { pending: PendingLook; grid: number; px: number; handleR: number; part: PendingPart }) {
  const pts = pending.points
  const d = wireStrokePath({ pts }, grid)
  const color = wireColorVar(pending.color)
  const glow = pending.conflict?.length ? conflictGlowPaths(pending.conflict, bendsOf([pts]), grid) : []
  const end = pts[pts.length - 1]
  if (part === "glow") {
    if (!glow.length) return null
    return (
      <g data-slot="pending-wire-glow" data-conflict-glow="" style={{ ["--conflict-px" as string]: `${px}px` }}>
        {glow.map((g, i) => (
          <path key={i} d={g} fill="none" stroke="var(--conflict)" strokeWidth={CONFLICT_PX} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
      </g>
    )
  }
  if (part === "marks") {
    return (
      <g pointerEvents="none">
        {pending.corners.map((p, idx) => (
          <circle key={idx} cx={p.x} cy={p.y} r={handleR} fill={color} stroke="var(--background)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ))}
        <circle cx={end.x} cy={end.y} r={pending.landing ? handleR * 1.4 : handleR} fill={pending.landing ? color : "var(--background)"} stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </g>
    )
  }
  return (
    <g pointerEvents="none">
      <defs>
        <g id={PENDING_WIRE_CUT_ID}>
          <path d={wireCasingPath({ pts }, grid)} fill="none" stroke="black" strokeWidth={casingWidth(WIRE_PX)} strokeLinejoin="round" strokeLinecap="butt" vectorEffect="non-scaling-stroke" />
        </g>
      </defs>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={WIRE_PX}
        strokeDasharray={pending.landing ? undefined : `${WIRE_PX * 3} ${WIRE_PX * 2.5}`}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </g>
  )
}
