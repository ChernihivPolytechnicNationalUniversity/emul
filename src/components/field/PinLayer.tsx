import * as React from "react"
import { cn } from "@/lib/utils"
import { objectPins, orientationOf, type ObjectPin, type Point } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { ComponentDef, PinKind, PlacedObject } from "@/schematic/types"
import type { FieldDetail } from "./detail"
import type { PinPointerHandler } from "./ComponentView"
import { ARROW_HEAD_CELLS, boxCorners, KNOCKOUT_OPACITY, labelFrame, labelKnockout, labelOrigin, MONO_ADVANCE_EM, numbersItsPins, PIN_NUMBER_SCALE, pinLabelById, pinLabels, pinNumberPlacement, referenceArrow, type Box, type KnockoutAxis, type LabelGround, type PinLabel } from "./pin-label"
import { pinMarker } from "./pin-marker"
import { referenceTerminals } from "@/schematic/terminals"

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

type LabelledPin = { label: PinLabel; point: Point }

function ReferenceArrow({ pins, def, grid, size }: { pins: readonly ObjectPin[]; def: ComponentDef; grid: number; size: number }) {
  const ends = referenceTerminals(def)
  const from = ends && pins.find(({ pin }) => pin.id === ends[0].id)
  const to = ends && pins.find(({ pin }) => pin.id === ends[1].id)
  const arrow = from && to && referenceArrow(from.pin, to.pin, size)
  if (!from || !arrow) return null
  const [tail, tip] = arrow.map((p) => ({ x: from.point.x + p.x * grid, y: from.point.y + p.y * grid }))
  const length = Math.hypot(tip.x - tail.x, tip.y - tail.y)
  const back = { x: ((tail.x - tip.x) / length) * ARROW_HEAD_CELLS * grid, y: ((tail.y - tip.y) / length) * ARROW_HEAD_CELLS * grid }
  const barb = (sign: number) => `${tip.x + back.x - sign * back.y * 0.6} ${tip.y + back.y + sign * back.x * 0.6}`
  return (
    <path
      data-reference-arrow=""
      d={`M${tail.x} ${tail.y}L${tip.x} ${tip.y}M${barb(1)}L${tip.x} ${tip.y}L${barb(-1)}`}
      fill="none"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
      className="pointer-events-none stroke-muted-foreground"
    />
  )
}

function LabelKnockouts({ pins, grid, size }: { pins: LabelledPin[]; grid: number; size: number }) {
  const advance = monoAdvanceEm()
  const solids = new Map<LabelGround, string[]>()
  const fades: React.ReactNode[] = []
  for (const { label, point } of pins) {
    const knockout = labelKnockout(label.text, label.anchor, size, advance)
    const onField = (p: Point) => ({ x: point.x + p.x * grid, y: point.y + p.y * grid })
    const corners = boxCorners(knockout.solid, labelFrame(label, size)).map(onField)
    const rects = solids.get(label.ground)
    const rect = `M${corners.map((c) => `${c.x} ${c.y}`).join("L")}z`
    if (rects) rects.push(rect)
    else solids.set(label.ground, [rect])
    const anchor = onField(labelOrigin(label, size))
    const transform = label.angle ? `rotate(${label.angle} ${anchor.x} ${anchor.y})` : undefined
    const at = (box: Box) => ({ x: anchor.x + box.x * grid, y: anchor.y + box.y * grid, width: box.w * grid, height: box.h * grid, transform })
    fades.push(
      <rect key={`${label.id}:rise`} {...at(knockout.rise)} fill={`url(#${fadeId(label.ground, knockout.axis, true)})`} />,
      <rect key={`${label.id}:fall`} {...at(knockout.fall)} fill={`url(#${fadeId(label.ground, knockout.axis, false)})`} />,
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
  selected: ReadonlySet<string>
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
  selected,
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
        const labels = names && def ? pinLabelById(pinLabels(def, orientationOf(object))) : undefined
        const numbered = detail.labels && def !== undefined && selected.has(object.id) && numbersItsPins(def)
        const labelled: LabelledPin[] = []
        if (labels) {
          for (const { key, pin, point } of pins) {
            const label = labels.get(pin.id)
            if (label && !contacts.has(key) && (pin.labelAt === pin.side || connected(key))) labelled.push({ label, point })
          }
        }
        return (
        <g key={object.id} data-pins={object.id}>
          {labelled.length > 0 && <LabelKnockouts pins={labelled} grid={grid} size={detail.pinLabelSize} />}
          {numbered && def && <ReferenceArrow pins={pins} def={def} grid={grid} size={detail.pinLabelSize * PIN_NUMBER_SCALE} />}
          {pins.map(({ key, pin, point }) => {
            const live = connected(key)
            const contact = contacts.has(key)
            const color = live ? netColor?.(key) : undefined
            const label = labels?.get(pin.id)
            const origin = label && labelOrigin(label, detail.pinLabelSize)
            const numberSize = detail.pinLabelSize * PIN_NUMBER_SCALE
            const numberAt = numbered && !contact ? labelOrigin(pinNumberPlacement(pin), numberSize) : undefined
            const marker = pinMarker(def, pin.kind, live, contact, color)

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
                {marker && <circle
                  data-marker=""
                  cx={point.x}
                  cy={point.y}
                  r={g(marker.radiusCells)}
                  fill={marker.fill}
                  stroke={marker.stroke}
                  className={marker.className}
                  strokeWidth={marker.strokeWidth}
                  vectorEffect="non-scaling-stroke"
                />}
                {!contact && label && origin && (
                  <text
                    x={point.x + g(origin.x)}
                    y={point.y + g(origin.y)}
                    fontSize={g(detail.pinLabelSize)}
                    textAnchor={label.anchor}
                    dominantBaseline="middle"
                    transform={label.angle ? `rotate(${label.angle} ${point.x + g(origin.x)} ${point.y + g(origin.y)})` : undefined}
                    className={cn(
                      "pointer-events-none stroke-none font-mono",
                      pin.kind === "nc" ? "fill-muted-foreground" : "fill-foreground",
                    )}
                  >
                    {pin.label}
                  </text>
                )}
                {numberAt && (
                  <text
                    data-pin-number={pin.id}
                    x={point.x + g(numberAt.x)}
                    y={point.y + g(numberAt.y)}
                    fontSize={g(numberSize)}
                    textAnchor={pinNumberPlacement(pin).anchor}
                    dominantBaseline="middle"
                    className="pointer-events-none fill-muted-foreground stroke-none font-mono"
                  >
                    {pin.id}
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
