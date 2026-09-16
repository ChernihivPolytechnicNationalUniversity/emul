import { cn } from "@/lib/utils"
import { DIR, objectPins, type Direction } from "@/schematic/geometry"
import type { PinKind, PlacedObject } from "@/schematic/types"
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

const LABEL_OFFSET = 0.45

type PinLayerProps = {
  objects: PlacedObject[]
  grid: number
  hairline: number
  connectedPins: ReadonlySet<string>
  /** Pins that touch another pin; they are drawn as a junction dot, without a label. */
  contactPins: ReadonlySet<string>
  onPinPointerDown: PinPointerHandler
  onPinPointerMove: PinPointerHandler
  onPinPointerUp: PinPointerHandler
}

/**
 * Every pin of every component, drawn in world coordinates above the wires.
 *
 * Pins live here rather than inside each component's SVG so that a pin lying on a wire stays
 * both visible and clickable: the wire layer paints on top of the components and claims a hit
 * area five times its own width, which would otherwise swallow the pin underneath it.
 */
export function PinLayer({
  objects,
  grid,
  hairline,
  connectedPins,
  contactPins,
  onPinPointerDown,
  onPinPointerMove,
  onPinPointerUp,
}: PinLayerProps) {
  const g = (v: number) => v * grid
  return (
    <svg data-slot="pins" className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
      {objects.map((object) =>
        objectPins(object, grid).map(({ key, pin, point }) => {
          const connected = connectedPins.has(key)
          const contact = contactPins.has(key)
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
              {/* generous hit area; a bare node's pin sits in the middle of its body, so it keeps
                  to its own dot and the body around it stays there to drag the node by */}
              <circle cx={point.x} cy={point.y} r={g(pin.stub === 0 ? 0.22 : 0.45)} className="fill-transparent stroke-none" />
              <circle
                cx={point.x}
                cy={point.y}
                r={g(contact ? 0.26 : pin.kind === "nc" ? 0.14 : 0.2)}
                className={cn(
                  "stroke-foreground/60 transition-[r] group-hover/pin:stroke-primary",
                  contact ? "fill-foreground" : PIN_FILL[pin.kind],
                  connected && !contact && "stroke-primary",
                )}
                strokeWidth={connected ? hairline * 2 : hairline}
              />
              {/* Two pins on one point draw one dot between them; their labels would overlap, and
                  the joint is the node, not either terminal. The names stay in the readout. */}
              {!contact && (
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
        }),
      )}
    </svg>
  )
}
