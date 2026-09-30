import * as React from "react"
import { cn } from "@/lib/utils"
import { objectPins, type PlacedPin, type Point } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { ComponentDef, PinKind, PlacedObject } from "@/schematic/types"
import type { FieldDetail } from "./detail"
import type { PinPointerHandler } from "./ComponentView"
import { KNOCKOUT_OPACITY, MONO_ADVANCE_EM, PIN_LABEL_CELLS, pinLabelGround, pinLabelKnockout, pinLabelOffset, type Box, type KnockoutAxis, type LabelGround } from "./pin-label"
import { hollowMarkerHidden } from "./pin-marker"

const PIN_FILL: Record<PinKind, string> = {
  power: "fill-red-500",
  gnd: "fill-neutral-700 dark:fill-neutral-300",
  analog: "fill-amber-500",
  digital: "fill-background",
  node: "fill-foreground",
  nc: "fill-muted",
}

const PIN_MARK: Record<PinKind, string> = {
  power: "fill-red-500",
  gnd: "fill-neutral-700 dark:fill-neutral-300",
  analog: "fill-amber-500",
  digital: "fill-foreground/70",
  node: "fill-foreground",
  nc: "fill-muted-foreground/40",
}

const MARK_CELLS = 0.16

const KNOCKOUT_COLOR: Record<LabelGround, string> = {
  board: "var(--card)",
  zone: "var(--muted)",
  chip: "var(--foreground)",
  connector: "var(--secondary)",
  foreground: "var(--foreground)",
  field: "var(--background)",
}

const GROUNDS = Object.keys(KNOCKOUT_COLOR) as LabelGround[]
const AXES: readonly KnockoutAxis[] = ["x", "y"]

const fadeId = (ground: LabelGround, axis: KnockoutAxis, rising: boolean) => `pin-knockout-${ground}-${axis}-${rising ? "rise" : "fall"}`

let measuredAdvanceEm: number | undefined

function monoAdvanceEm() {
  if (measuredAdvanceEm !== undefined) return measuredAdvanceEm
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim()
  const context = document.createElement("canvas").getContext("2d")
  if (!family || !context) return MONO_ADVANCE_EM
  context.font = `100px ${family}`
  measuredAdvanceEm = context.measureText("0").width / 100 || MONO_ADVANCE_EM
  return measuredAdvanceEm
}

const KnockoutFades = React.memo(function KnockoutFades() {
  return (
    <defs>
      {GROUNDS.flatMap((ground) =>
        AXES.flatMap((axis) =>
          [true, false].map((rising) => (
            <linearGradient key={fadeId(ground, axis, rising)} id={fadeId(ground, axis, rising)} x2={axis === "x" ? 1 : 0} y2={axis === "y" ? 1 : 0}>
              <stop offset={0} style={{ stopColor: KNOCKOUT_COLOR[ground], stopOpacity: rising ? 0 : KNOCKOUT_OPACITY }} />
              <stop offset={1} style={{ stopColor: KNOCKOUT_COLOR[ground], stopOpacity: rising ? KNOCKOUT_OPACITY : 0 }} />
            </linearGradient>
          )),
        ),
      )}
    </defs>
  )
})

type LabelledPin = { pin: PlacedPin; point: Point }

function LabelKnockouts({ def, pins, grid, boost }: { def: ComponentDef; pins: LabelledPin[]; grid: number; boost: number }) {
  const advance = monoAdvanceEm()
  const solids = new Map<LabelGround, string[]>()
  const fades: React.ReactNode[] = []
  for (const { pin, point } of pins) {
    const knockout = pinLabelKnockout(pin.label, pin.labelAt, boost, advance)
    const ground = pinLabelGround(def, pin.id)
    const at = (box: Box) => ({ x: point.x + box.x * grid, y: point.y + box.y * grid, width: box.w * grid, height: box.h * grid })
    const solid = at(knockout.solid)
    const rects = solids.get(ground)
    const rect = `M${solid.x} ${solid.y}h${solid.width}v${solid.height}h${-solid.width}z`
    if (rects) rects.push(rect)
    else solids.set(ground, [rect])
    fades.push(
      <rect key={`${pin.id}:rise`} {...at(knockout.rise)} fill={`url(#${fadeId(ground, knockout.axis, true)})`} />,
      <rect key={`${pin.id}:fall`} {...at(knockout.fall)} fill={`url(#${fadeId(ground, knockout.axis, false)})`} />,
    )
  }
  return (
    <g pointerEvents="none" stroke="none">
      {[...solids].map(([ground, rects]) => (
        <path key={ground} d={rects.join("")} fill={KNOCKOUT_COLOR[ground]} fillOpacity={KNOCKOUT_OPACITY} />
      ))}
      {fades}
    </g>
  )
}

type PinLayerProps = {
  objects: readonly PlacedObject[]
  grid: number
  detail: FieldDetail
  connected: (pinKey: string) => boolean
  /** Pins that touch another pin; they are drawn as a junction dot, without a label. */
  contacts: ReadonlyMap<string, string>
  sheeted?: (object: PlacedObject) => boolean
  netColor?: (pinKey: string) => string | undefined
  onPinPointerDown: PinPointerHandler
  onPinPointerMove: PinPointerHandler
  onPinPointerUp: PinPointerHandler
}

function PinMarks({ object, grid }: { object: PlacedObject; grid: number }) {
  const r = grid * MARK_CELLS
  const byKind = new Map<PinKind, string[]>()
  for (const { pin, point } of objectPins(object, grid)) {
    const marks = byKind.get(pin.kind)
    const mark = `M${point.x - r} ${point.y - r}h${r * 2}v${r * 2}h${-r * 2}z`
    if (marks) marks.push(mark)
    else byKind.set(pin.kind, [mark])
  }
  return [...byKind].map(([kind, marks]) => <path key={kind} d={marks.join("")} stroke="none" className={PIN_MARK[kind]} />)
}

/**
 * Every pin of every component, drawn in world coordinates above the wires.
 *
 * Pins live here rather than inside each component's SVG so that a pin lying on a wire stays
 * both visible and clickable: the wire layer paints on top of the components and claims a hit
 * area five times its own width, which would otherwise swallow the pin underneath it.
 */
export const PinLayer = React.memo(function PinLayer({
  objects,
  grid,
  detail,
  connected,
  contacts,
  sheeted,
  netColor,
  onPinPointerDown,
  onPinPointerMove,
  onPinPointerUp,
}: PinLayerProps) {
  const g = (v: number) => v * grid
  if (!detail.pins) {
    if (!detail.pinMarks || detail.canvas) return null
    return (
      <svg data-slot="pins" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
        {objects.map((object) => (
          <g key={object.id} data-pins={object.id}>
            <PinMarks object={object} grid={grid} />
          </g>
        ))}
      </svg>
    )
  }
  return (
    <svg data-slot="pins" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <KnockoutFades />
      {objects.map((object) => {
        const def = getDef(object.def)
        const names = detail.labels && !sheeted?.(object)
        const pins = objectPins(object, grid)
        const labelled = names && def ? pins.filter(({ key, pin }) => pin.label && !contacts.has(key) && (pin.labelAt === pin.side || connected(key))) : []
        return (
        <g key={object.id} data-pins={object.id}>
          {def && labelled.length > 0 && <LabelKnockouts def={def} pins={labelled} grid={grid} boost={detail.textBoost} />}
          {pins.map(({ key, pin, point }) => {
            const live = connected(key)
            const contact = contacts.has(key)
            const color = live ? netColor?.(key) : undefined
            const label = pinLabelOffset(pin.labelAt)
            const markerHidden = hollowMarkerHidden(def, pin.kind, live, contact)

            return (
              <g
                key={key}
                data-object={object.id}
                data-pin={pin.id}
                className="group/pin pointer-events-auto cursor-crosshair"
                onPointerDown={(e) => onPinPointerDown(e, object.id, pin.id)}
                onPointerMove={(e) => onPinPointerMove(e, object.id, pin.id)}
                onPointerUp={(e) => onPinPointerUp(e, object.id, pin.id)}
              >
                <circle cx={point.x} cy={point.y} r={g(pin.stub === 0 ? 0.22 : 0.45)} className="fill-transparent stroke-none" />
                {!markerHidden && <circle
                  cx={point.x}
                  cy={point.y}
                  r={g(contact ? 0.26 : pin.kind === "nc" ? 0.14 : 0.2)}
                  fill={color && (contact || pin.kind === "node") ? color : undefined}
                  stroke={color}
                  className={cn(
                    "transition-[r] group-hover/pin:stroke-primary",
                    !color && "stroke-foreground/60",
                    !color && live && !contact && "stroke-primary",
                    !(color && (contact || pin.kind === "node")) && (contact ? "fill-foreground" : PIN_FILL[pin.kind]),
                  )}
                  strokeWidth={live ? 2 : 1}
                  vectorEffect="non-scaling-stroke"
                />}
                {!contact && names && (
                  <text
                    x={point.x + g(label.x)}
                    y={point.y + g(label.y)}
                    fontSize={g(PIN_LABEL_CELLS * detail.textBoost)}
                    textAnchor={label.anchor}
                    dominantBaseline="middle"
                    className={cn(
                      "pointer-events-none stroke-none font-mono",
                      pin.kind === "nc" ? "fill-muted-foreground" : "fill-foreground",
                    )}
                  >
                    {pin.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>
        )
      })}
    </svg>
  )
})
