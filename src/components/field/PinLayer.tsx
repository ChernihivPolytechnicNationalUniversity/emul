import * as React from "react"
import { cn } from "@/lib/utils"
import { DIR, objectPins, type Direction } from "@/schematic/geometry"
import type { PinKind, PlacedObject } from "@/schematic/types"
import type { FieldDetail } from "./detail"
import type { PinPointerHandler } from "./ComponentView"

const PIN_FILL: Record<PinKind, string> = {
  power: "fill-red-500",
  gnd: "fill-neutral-700 dark:fill-neutral-300",
  analog: "fill-amber-500",
  digital: "fill-background",
  node: "fill-foreground",
  nc: "fill-muted",
}

const ANCHOR: Record<Direction, "start" | "middle" | "end"> = {
  left: "end",
  right: "start",
  top: "middle",
  bottom: "middle",
  "top-left": "end",
  "bottom-left": "end",
  "top-right": "start",
  "bottom-right": "start",
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

const LABEL_OFFSET = 0.45

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
      {objects.map((object) => {
        const names = detail.labels && !sheeted?.(object)
        return (
        <g key={object.id} data-pins={object.id}>
          {objectPins(object, grid).map(({ key, pin, point }) => {
            const live = connected(key)
            const contact = contacts.has(key)
            const color = live ? netColor?.(key) : undefined
            const dir = DIR[pin.labelAt as Direction]
            const label = { x: point.x + dir.x * g(LABEL_OFFSET), y: point.y + dir.y * g(LABEL_OFFSET) }

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
                <circle
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
                />
                {!contact && names && (
                  <text
                    x={label.x}
                    y={label.y}
                    fontSize={g(0.3)}
                    textAnchor={ANCHOR[pin.labelAt as Direction]}
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
