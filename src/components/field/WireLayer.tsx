import * as React from "react"
import { cn } from "@/lib/utils"
import { nearestSegment, resolvePin, routeObstacles, routeToPoint, routeWire, toPath, type Point } from "@/schematic/geometry"
import type { PinRef, PlacedObject, Wire } from "@/schematic/types"

export type PendingWire = {
  from: PinRef
  cursor: Point
  target: PinRef | null
  /** Bend points placed so far. */
  points: Point[]
  /** "drag": mouse still held from the first pin; "click": placing bends click by click. */
  mode: "drag" | "click"
}

type WireLayerProps = {
  objects: PlacedObject[]
  wires: Wire[]
  grid: number
  hairline: number
  selected: ReadonlySet<string>
  pending: PendingWire | null
  /** Mean amps per wire, positive from `from` to `to`; empty when the simulation is off. */
  currents: Map<string, number>
  /** Mean |amps| per wire: sets the weight of the wire. */
  currentsAbs: Map<string, number>
  /**
   * Flow marker position per wire (world px), integrated by the solver from the instantaneous
   * current. The dashes are placed at it, interpolating between snapshots, so they move
   * exactly as the charge does: back and forth at 1 Hz, a blur or a standstill at 60 Hz.
   */
  phases: Map<string, number>
  /** Paused: keep the picture, stop the dashes. */
  paused: boolean
  onWirePointerDown: (e: React.PointerEvent<SVGPathElement>, id: string) => void
  /** Double-click on a segment: insert a bend at `index` of the wire's points. */
  onInsertBend: (wireId: string, index: number, clientX: number, clientY: number) => void
  onRemoveBend: (wireId: string, index: number) => void
  onBendPointerDown: (e: React.PointerEvent<SVGCircleElement>, wireId: string, index: number) => void
  onBendPointerMove: (e: React.PointerEvent<SVGCircleElement>) => void
  onBendPointerUp: (e: React.PointerEvent<SVGCircleElement>) => void
}

/** Below this the wire is drawn as idle. */
const FLOW_MIN = 1e-5
/** Real-time smoothing of the displayed current weight, ms. */
const FLOW_TAU = 300

/** Visual weight of a current on a log scale: 0 at 10 µA, 1 at 100 mA. */
function weight(i: number) {
  const a = Math.abs(i)
  if (a < FLOW_MIN) return 0
  return Math.min(1, Math.log10(a / FLOW_MIN) / 4)
}

/** All wires in world coordinates, drawn in one SVG over the content layer. */
export function WireLayer({
  objects,
  wires,
  grid,
  hairline,
  selected,
  pending,
  currents,
  currentsAbs,
  phases,
  paused,
  onWirePointerDown,
  onInsertBend,
  onRemoveBend,
  onBendPointerDown,
  onBendPointerMove,
  onBendPointerUp,
}: WireLayerProps) {
  const stroke = Math.max(2, hairline * 1.5)
  const pendingPath = pending && pendingRoute(objects, pending, grid)

  // The snapshot's |i| are means over the last report interval, so a square wave or a sine
  // reads as steady weight rather than whatever phase a sample landed on; a little smoothing
  // over real time keeps the width from jumping between reports. A wire that stopped carrying
  // current — a switch opened, a part burnt — goes idle at once: a fading tail would read as
  // current still flowing.
  const [flow, setFlow] = React.useState<Map<string, number>>(() => new Map())
  const flowAt = React.useRef(0)
  React.useEffect(() => {
    const now = performance.now()
    const k = flowAt.current ? 1 - Math.exp(-(now - flowAt.current) / FLOW_TAU) : 1
    flowAt.current = now
    setFlow((prev) => {
      const next = new Map<string, number>()
      for (const [id, i] of currents) {
        const abs = currentsAbs.get(id) ?? Math.abs(i)
        const p = prev.get(id) ?? abs
        next.set(id, abs < FLOW_MIN ? 0 : p + (abs - p) * k)
      }
      return next
    })
  }, [currents, currentsAbs])

  // Dash positions: each snapshot brings the solver's marker positions; frames slide the
  // dashes from where they were to where they are over one report interval, so the motion is
  // the real one, delayed by that interval rather than invented.
  const flowRefs = React.useRef(new Map<string, SVGPathElement>())
  const target = React.useRef<{ from: Map<string, number>; to: Map<string, number>; at: number; span: number }>({ from: new Map(), to: new Map(), at: 0, span: 50 })
  const shown = React.useRef(new Map<string, number>())
  React.useEffect(() => {
    const now = performance.now()
    const t = target.current
    const span = t.at ? Math.min(250, Math.max(16, now - t.at)) : 50
    target.current = { from: new Map(shown.current), to: phases, at: now, span }
  }, [phases])
  const live = currents.size > 0
  const animate = live && !paused
  React.useEffect(() => {
    if (!animate) return
    let raf = 0
    const frame = (now: number) => {
      const t = target.current
      const k = Math.min(1, (now - t.at) / t.span)
      for (const [id, el] of flowRefs.current) {
        const to = t.to.get(id)
        if (to === undefined) continue
        const from = t.from.get(id) ?? to
        const pos = from + (to - from) * k
        shown.current.set(id, pos)
        el.style.strokeDashoffset = `${-pos}`
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [animate])

  return (
    <svg data-slot="wires" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      {wires.map((w) => {
        const a = resolvePin(objects, w.from, grid)
        const b = resolvePin(objects, w.to, grid)
        if (!a || !b) return null
        const route = routeWire(a.point, a.pin.side, a.pin.stub ?? 1, b.point, b.pin.side, b.pin.stub ?? 1, grid, w.points, routeObstacles(objects, grid, w.from.object, w.to.object))
        const d = toPath(route.pts)
        const isSel = selected.has(w.id)
        const wgt = weight(flow.get(w.id) ?? 0)
        const width = (isSel ? stroke * 1.6 : stroke) * (1 + wgt)
        return (
          <g key={w.id} data-wire={w.id} className="group/wire pointer-events-auto cursor-pointer">
            {/* wide invisible hit path */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={stroke * 5}
              onPointerDown={(e) => onWirePointerDown(e, w.id)}
              onDoubleClick={(e) => {
                const svg = e.currentTarget.ownerSVGElement!
                const m = svg.getScreenCTM()!.inverse()
                const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m)
                const seg = nearestSegment(route.pts, { x: p.x, y: p.y })
                onInsertBend(w.id, route.owner[seg], e.clientX, e.clientY)
              }}
            />
            <path
              d={d}
              fill="none"
              className={cn(
                "stroke-emerald-600 group-hover/wire:stroke-primary dark:stroke-emerald-400",
                live && wgt === 0 && "stroke-emerald-600/40 dark:stroke-emerald-400/40",
                isSel && "stroke-primary",
              )}
              strokeWidth={width}
              strokeLinejoin="round"
              strokeLinecap="round"
              pointerEvents="none"
            />
            {live && wgt > 0 && (
              <path
                ref={(el) => {
                  if (el) flowRefs.current.set(w.id, el)
                  else flowRefs.current.delete(w.id)
                }}
                d={d}
                fill="none"
                className="stroke-amber-400"
                strokeWidth={width * 0.7}
                strokeDasharray={`${stroke * 1.5} ${stroke * 4}`}
                strokeLinecap="round"
                pointerEvents="none"
              />
            )}
            {isSel &&
              w.points?.map((p, idx) => (
                <circle
                  key={idx}
                  cx={p.x}
                  cy={p.y}
                  r={stroke * 2.2}
                  className="cursor-move fill-background stroke-primary hover:fill-primary/20"
                  strokeWidth={hairline * 1.5}
                  onPointerDown={(e) => onBendPointerDown(e, w.id, idx)}
                  onPointerMove={onBendPointerMove}
                  onPointerUp={onBendPointerUp}
                  onPointerCancel={onBendPointerUp}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    onRemoveBend(w.id, idx)
                  }}
                />
              ))}
          </g>
        )
      })}
      {pendingPath && (
        <g pointerEvents="none">
          <path
            d={pendingPath}
            fill="none"
            className={cn("stroke-primary", !pending?.target && "opacity-60")}
            strokeWidth={stroke}
            strokeDasharray={pending?.target ? undefined : `${stroke * 2} ${stroke * 2}`}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {pending?.points.map((p, idx) => (
            <circle key={idx} cx={p.x} cy={p.y} r={stroke * 1.6} className="fill-primary stroke-none" />
          ))}
        </g>
      )}
    </svg>
  )
}

function pendingRoute(objects: PlacedObject[], p: PendingWire, grid: number) {
  const a = resolvePin(objects, p.from, grid)
  if (!a) return null
  const b = p.target && resolvePin(objects, p.target, grid)
  if (b) {
    return toPath(routeWire(a.point, a.pin.side, a.pin.stub ?? 1, b.point, b.pin.side, b.pin.stub ?? 1, grid, p.points, routeObstacles(objects, grid, p.from.object, p.target!.object)).pts)
  }
  return toPath(routeToPoint(a.point, a.pin.side, a.pin.stub ?? 1, p.cursor, grid, p.points))
}
