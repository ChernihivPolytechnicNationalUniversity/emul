import * as React from "react"
import { cn } from "@/lib/utils"
import { objectPins, objectSize, orientationOf, routeBox, touches, type Point, type Rect, type RoutedWire } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PinKind, PlacedObject } from "@/schematic/types"
import type { FieldDetail } from "./detail"
import type { PinPointerHandler } from "./ComponentView"
import { boxCorners, KNOCKOUT_OPACITY, labelKnockout, labelOrigin, numbersItsPins, OVERBAR_WEIGHT_EM, overbar, PIN_NUMBER_SCALE, pinLabelById, pinLabels, pinNumberPlacement, type Box, type KnockoutAxis, type LabelAnchor, type LabelGround } from "./pin-label"
import { pinMarker, pinsOnSwitchContacts, SWITCH_CONTACT_CELLS } from "./pin-marker"
import { crossedBy, monoAdvanceEm, namesUnderDocked, printedNameAt, printedNameLayout, printedNameOnField, printedNameSize } from "./printed-names"

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

type Knockout = { id: string; text: string; anchor: LabelAnchor; angle: number; ground: LabelGround; at: Point; size: number }

function LabelKnockouts({ items, grid }: { items: Knockout[]; grid: number }) {
  const advance = monoAdvanceEm()
  const solids = new Map<LabelGround, string[]>()
  const fades: React.ReactNode[] = []
  for (const { id, text, anchor: align, angle, ground, at: anchor, size } of items) {
    const knockout = labelKnockout(text, align, size, advance)
    const cos = Math.cos((angle * Math.PI) / 180)
    const sin = Math.sin((angle * Math.PI) / 180)
    const onField = (p: Point) => ({ x: anchor.x + (p.x * cos - p.y * sin) * grid, y: anchor.y + (p.x * sin + p.y * cos) * grid })
    const corners = boxCorners(knockout.solid, onField)
    const rects = solids.get(ground)
    const rect = `M${corners.map((c) => `${c.x} ${c.y}`).join("L")}z`
    if (rects) rects.push(rect)
    else solids.set(ground, [rect])
    const transform = angle ? `rotate(${angle} ${anchor.x} ${anchor.y})` : undefined
    const at = (box: Box) => ({ x: anchor.x + box.x * grid, y: anchor.y + box.y * grid, width: box.w * grid, height: box.h * grid, transform })
    fades.push(
      <rect key={`${id}:rise`} {...at(knockout.rise)} fill={`url(#${fadeId(ground, knockout.axis, true)})`} />,
      <rect key={`${id}:fall`} {...at(knockout.fall)} fill={`url(#${fadeId(ground, knockout.axis, false)})`} />,
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
  routes?: readonly RoutedWire[]
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
function routesOver(routes: readonly RoutedWire[], object: PlacedObject, def: NonNullable<ReturnType<typeof getDef>>, grid: number): Point[][] {
  const size = objectSize(def, object.rotation ?? 0)
  const reach: Rect = { x: object.x - grid, y: object.y - grid, w: (size.w + 2) * grid, h: (size.h + 2) * grid }
  return routes.filter((route) => touches(routeBox(route), reach)).map((route) => route.pts)
}

export const PinLayer = React.memo(function PinLayer({
  objects,
  grid,
  detail,
  connected,
  contacts,
  selected,
  sheeted,
  routes,
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
  const metrics = { grid, boost: detail.textBoost, advanceEm: monoAdvanceEm() }
  const underDocked = namesUnderDocked(objects, contacts, metrics)
  return (
    <svg data-slot="pins" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      <KnockoutFades />
      {objects.map((object) => {
        const def = getDef(object.def)
        const names = detail.labels && !sheeted?.(object)
        const pins = objectPins(object, grid)
        const labels = names && def ? pinLabelById(pinLabels(def, orientationOf(object))) : undefined
        const numbered = detail.labels && def !== undefined && selected.has(object.id) && numbersItsPins(def)
        const underCaps = def ? pinsOnSwitchContacts(def) : undefined
        const labelled: Knockout[] = []
        if (labels) {
          for (const { key, pin, point } of pins) {
            const label = labels.get(pin.id)
            if (!label || contacts.has(key) || (pin.labelAt !== pin.side && !connected(key))) continue
            const origin = labelOrigin(label, detail.pinLabelSize)
            labelled.push({ ...label, at: { x: point.x + g(origin.x), y: point.y + g(origin.y) }, size: detail.pinLabelSize })
          }
        }
        const printed = names && def ? printedNameLayout(def, orientationOf(object)) : []
        const covered = printed.length ? underDocked(object) : undefined
        const printedOnField = printed.flatMap((name) => {
          if (covered?.has(name.shape)) return []
          const size = printedNameSize(name, detail.textBoost)
          const at = printedNameAt(name, size)
          return [{ name, at: { x: object.x + g(at.x), y: object.y + g(at.y) }, size }]
        })
        const crossing = printedOnField.length && routes ? routesOver(routes, object, def!, grid) : []
        const knocked: Knockout[] = crossing.length
          ? printedOnField.flatMap(({ name, at, size }) =>
              crossedBy(printedNameOnField(object, name, metrics), crossing) ? [{ id: name.id, text: name.shape.text, anchor: name.anchor, angle: name.angle, ground: name.ground, at, size }] : [],
            )
          : []
        return (
        <g key={object.id} data-pins={object.id}>
          {knocked.length > 0 && <LabelKnockouts items={knocked} grid={grid} />}
          {printedOnField.length > 0 && (
            <g data-printed-names="" className="pointer-events-none">
              {printedOnField.map(({ name, at, size }) => (
                <text
                  key={name.id}
                  x={at.x}
                  y={at.y}
                  fontSize={g(size)}
                  textAnchor={name.anchor}
                  dominantBaseline="middle"
                  textRendering="geometricPrecision"
                  transform={name.angle ? `rotate(${name.angle} ${at.x} ${at.y})` : undefined}
                  className={cn("stroke-none font-mono", name.shape.muted ? "fill-muted-foreground" : "fill-foreground")}
                >
                  {name.shape.text}
                </text>
              ))}
            </g>
          )}
          {labelled.length > 0 && <LabelKnockouts items={labelled} grid={grid} />}
          {pins.map(({ key, pin, point }) => {
            const live = connected(key)
            const contact = contacts.has(key)
            const color = live ? netColor?.(key) : undefined
            const label = labels?.get(pin.id)
            const origin = label && labelOrigin(label, detail.pinLabelSize)
            const numberSize = detail.pinLabelSize * PIN_NUMBER_SCALE
            const numberAt = numbered && !contact ? labelOrigin(pinNumberPlacement(pin), numberSize) : undefined
            const marker = pinMarker(def, pin.kind, live, contact, color)
            const bar = !contact && label && pin.inverted ? overbar(label, label.text, detail.pinLabelSize, monoAdvanceEm()) : undefined

            return (
              <g
                key={key}
                data-object={object.id}
                data-pin={pin.id}
                className="group/pin pointer-events-auto cursor-precise"
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
                {marker && !contact && underCaps?.has(pin.id) && <circle data-switch-contact="" cx={point.x} cy={point.y} r={g(SWITCH_CONTACT_CELLS)} className="pointer-events-none fill-foreground stroke-none" />}
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
                {bar && (
                  <line
                    data-overbar={pin.id}
                    x1={point.x + g(bar[0].x)}
                    y1={point.y + g(bar[0].y)}
                    x2={point.x + g(bar[1].x)}
                    y2={point.y + g(bar[1].y)}
                    strokeWidth={g(detail.pinLabelSize * OVERBAR_WEIGHT_EM)}
                    className="pointer-events-none stroke-foreground"
                  />
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
