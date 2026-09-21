import * as React from "react"
import { FlameIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { objectSize } from "@/schematic/geometry"
import { getDef, partInitial } from "@/schematic/registry"
import { partKey, type BodyShape, type Damage, type Fill, type PartDef, type PartState, type PlacedObject, type Rotation } from "@/schematic/types"
import { LED_COLORS } from "@/schematic/components/basic"
import type { DisplayFrame } from "@/sim/use-simulation"
import { useObjectReadings, useObjectSim, type SimStore } from "@/sim/sim-store"
import type { FieldDetail } from "./detail"
import { formatSI } from "@/sim/units"
import { fixedText } from "./symbol-raster"

const FILL: Record<Fill, string> = {
  board: "fill-card stroke-border",
  zone: "fill-muted stroke-border",
  chip: "fill-foreground stroke-foreground",
  connector: "fill-secondary stroke-border",
  foreground: "fill-foreground stroke-foreground",
  none: "fill-none stroke-border",
  grip: "fill-transparent stroke-none",
}

/** Stroke width of symbol paths in world px (stays visible at 50%). */
const SYMBOL_STROKE = 2

/** Named LED colours resolve to CSS; anything else is passed through. */
const resolveColor = (c: string) => LED_COLORS[c]?.css ?? c

/** Replace "{key}" with object props, falling back to definition defaults. */
function template(text: string, props: Record<string, string>) {
  return text.replace(/\{(\w+)\}/g, (_, k: string) => props[k] ?? "")
}

export type PinPointerHandler = (e: React.PointerEvent<SVGElement>, objectId: string, pinId: string) => void

export type BodyPointerHandler = (e: React.PointerEvent<SVGSVGElement>, objectId: string) => void

type ComponentViewProps = {
  object: PlacedObject
  grid: number
  detail: FieldDetail
  sheeted: boolean
  selected: boolean
  parts: Record<string, PartState>
  sim: SimStore
  onBodyPointerDown: BodyPointerHandler
  onBodyPointerMove: BodyPointerHandler
  onBodyPointerUp: BodyPointerHandler
  onBodyContextMenu: (objectId: string) => void
  onPartChange: (objectId: string, partId: string, patch: PartState) => void
}

/** Generic renderer: draws any ComponentDef from its body shapes, pins and parts. */
export const ComponentView = React.memo(function ComponentView({
  object,
  grid,
  detail,
  sheeted,
  selected,
  parts,
  sim,
  onBodyPointerDown,
  onBodyPointerMove,
  onBodyPointerUp,
  onBodyContextMenu,
  onPartChange,
}: ComponentViewProps) {
  const live = useObjectSim(sim, object.id)
  const def = getDef(object.def)
  if (!def) return null
  const w = def.width * grid
  const h = def.height * grid
  const g = (v: number) => v * grid
  const props = { ...def.defaults, ...object.props }
  if (def.derive) Object.assign(props, def.derive(props))
  const rotation: Rotation = object.rotation ?? 0
  const damage: Damage | undefined = live.damage
  // The SVG keeps the unrotated size and is rotated around its center; offset it so the
  // rotated box lands exactly on the object's (rotated) bounds.
  const box = objectSize(def, rotation)
  const left = object.x + (box.w * grid - w) / 2
  const top = object.y + (box.h * grid - h) / 2

  return (
    <svg
      data-slot="component"
      data-selected={selected || undefined}
      data-damaged={damage ? "" : undefined}
      className={cn(
        "absolute cursor-move overflow-visible select-none",
        "[&>.body]:data-selected:drop-shadow-[0_0_0_2px_var(--primary)]",
      )}
      style={{ left, top, width: w, height: h, transform: rotation ? `rotate(${rotation}deg)` : undefined }}
      strokeWidth={1}
      viewBox={`0 0 ${w} ${h}`}
      onPointerDown={(e) => onBodyPointerDown(e, object.id)}
      onPointerMove={(e) => onBodyPointerMove(e, object.id)}
      onPointerUp={(e) => onBodyPointerUp(e, object.id)}
      onPointerCancel={(e) => onBodyPointerUp(e, object.id)}
      onContextMenu={() => onBodyContextMenu(object.id)}
    >
      {damage && <title>{`${props.ref ?? def.name} burnt: ${damage.reason}`}</title>}
      <g className={cn("body", damage && "opacity-50 saturate-0")}>
        {def.body.map((s, i) => (
          <Shape key={i} shape={s} g={g} grid={grid} labels={detail.labels} boost={detail.textBoost} sheeted={sheeted} props={props} rotation={rotation} />
        ))}
      </g>
      {selected && (
        <rect
          x={0}
          y={0}
          width={w}
          height={h}
          rx={g(0.6)}
          className="fill-primary/5 stroke-primary"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      )}
      <g className="parts">
        {detail.pins && def.parts.map((p) => {
          const key = partKey(object.id, p.id)
          const simulated = live.parts[key]
          return (
            <Part
              key={p.id}
              part={p.type === "led" ? { ...p, color: resolveColor(template(p.color, props)) } : p}
              g={g}
              state={simulated ?? parts[key] ?? partInitial(def, p.id)}
              level={p.type === "display" ? (live.live ? (p.backlight ? (live.parts[partKey(object.id, p.backlight)]?.level ?? 0) : 1) : 0) : simulated?.level}
              display={p.type === "display" ? live.display : undefined}
              onChange={simulated ? undefined : (patch) => onPartChange(object.id, p.id, patch)}
            />
          )
        })}
      </g>
      {def.meter && detail.labels && <Meter def={def} objectId={object.id} sim={sim} live={live.live} g={g} rotation={rotation} />}
      {damage && (
        <g pointerEvents="none">
          <rect x={0} y={0} width={w} height={h} rx={g(0.6)} className="fill-destructive/15 stroke-destructive" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray={`${g(0.25)} ${g(0.25)}`} />
          <FlameIcon
            x={w / 2 - g(0.6)}
            y={h / 2 - g(0.6)}
            width={g(1.2)}
            height={g(1.2)}
            className="fill-destructive/20 stroke-destructive"
            strokeWidth={1.5}
            transform={rotation ? `rotate(${-rotation} ${w / 2} ${h / 2})` : undefined}
          />
        </g>
      )}
    </svg>
  )
})

/**
 * A meter's live readout: the operating point of one of its model elements (voltage across,
 * current through, power), formatted with an SI prefix, RMS in an AC circuit. The text is
 * counter-rotated so it stays upright whichever way the meter is turned. "—" before the run.
 */
function Meter({
  def,
  objectId,
  sim,
  live,
  g,
  rotation,
}: {
  def: NonNullable<ReturnType<typeof getDef>>
  objectId: string
  sim: SimStore
  live: boolean
  g: (v: number) => number
  rotation: Rotation
}) {
  const readings = useObjectReadings(sim, objectId)
  const m = def.meter!
  const x = g(m.x)
  const y = g(m.y)
  let text = "—"
  if (live) {
    const r = readings.find((v) => v.element === (m.element ?? 0))
    if (r) {
      const val = m.read === "voltage" ? (r.rms ? r.rms.voltage : r.voltage) : m.read === "current" ? (r.rms ? r.rms.current : r.current) : r.rms ? r.rms.power : r.power
      text = formatSI(val, m.unit, 3)
    }
  }
  return (
    <text
      x={x}
      y={y}
      fontSize={g(m.size ?? 0.4)}
      textAnchor="middle"
      className="fill-foreground stroke-none font-mono tabular-nums"
      pointerEvents="none"
      transform={rotation ? `rotate(${-rotation} ${x} ${y})` : undefined}
    >
      {text}
    </text>
  )
}

function Shape({
  shape,
  g,
  grid,
  labels,
  boost,
  sheeted,
  props,
  rotation,
}: {
  shape: BodyShape
  g: (v: number) => number
  grid: number
  labels: boolean
  boost: number
  sheeted: boolean
  props: Record<string, string>
  rotation: Rotation
}) {
  if (shape.type === "text" && (!labels || (sheeted && fixedText(shape.text)))) return null
  switch (shape.type) {
    case "path":
      return (
        <path
          d={shape.d}
          transform={`scale(${grid})`}
          vectorEffect="non-scaling-stroke"
          strokeWidth={SYMBOL_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(
            shape.fill ? FILL[shape.fill] : "fill-none",
            shape.muted ? "stroke-muted-foreground" : "stroke-foreground",
          )}
        />
      )
    case "rect":
      return (
        <rect
          x={g(shape.x)}
          y={g(shape.y)}
          width={g(shape.w)}
          height={g(shape.h)}
          rx={g(shape.rx ?? 0)}
          vectorEffect="non-scaling-stroke"
          className={FILL[shape.fill ?? "none"]}
        />
      )
    case "circle":
      return <circle cx={g(shape.cx)} cy={g(shape.cy)} r={g(shape.r)} vectorEffect="non-scaling-stroke" className={FILL[shape.fill ?? "none"]} />
    case "text":
      return (
        <text
          x={g(shape.x)}
          y={g(shape.y)}
          fontSize={g((shape.size ?? 0.4) * boost)}
          textAnchor={shape.anchor ?? "middle"}
          dominantBaseline="middle"
          // Counter-rotate so labels stay readable whatever the component's rotation.
          transform={`rotate(${(shape.rotate ?? 0) - rotation} ${g(shape.x)} ${g(shape.y)})`}
          className={cn(
            "stroke-none font-sans",
            shape.inverse ? "fill-background" : shape.muted ? "fill-muted-foreground" : "fill-foreground",
          )}
        >
          {template(shape.text, props)}
        </text>
      )
  }
}

/**
 * A display panel: the frame the simulation composed, drawn on a canvas inside the SVG,
 * scaled by the backlight; the pointer on it is a touch with panel coordinates.
 */
function DisplayPanel({ part, g, level, display, onChange }: { part: Extract<PartDef, { type: "display" }>; g: (v: number) => number; level: number; display: DisplayFrame | undefined; onChange?: (patch: PartState) => void }) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const drawn = React.useRef(-1)
  React.useEffect(() => {
    const c = canvas.current
    if (!c) return
    const ctx = c.getContext("2d")
    if (!ctx) return
    if (!display || !display.frame) {
      if (drawn.current !== -1) ctx.clearRect(0, 0, c.width, c.height)
      drawn.current = -1
      return
    }
    if (display.seq === drawn.current) return
    drawn.current = display.seq
    ctx.putImageData(new ImageData(display.frame as unknown as Uint8ClampedArray<ArrayBuffer>, display.width, display.height), 0, 0)
  }, [display])
  // Panel pixel under the pointer. Measured through the component's SVG: Chrome reports a
  // canvas inside a scaled foreignObject at its unscaled size, so its own rect is useless.
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const svg = e.currentTarget.closest("svg")
    const r = (svg ?? e.currentTarget).getBoundingClientRect()
    const vw = svg?.viewBox.baseVal.width || r.width
    const vh = svg?.viewBox.baseVal.height || r.height
    const wx = ((e.clientX - r.left) / r.width) * vw
    const wy = ((e.clientY - r.top) / r.height) * vh
    return { x: ((wx - g(part.x)) / g(part.w)) * part.width, y: ((wy - g(part.y)) / g(part.h)) * part.height }
  }
  return (
    <foreignObject x={g(part.x)} y={g(part.y)} width={g(part.w)} height={g(part.h)}>
      <div className="relative h-full w-full bg-black" style={{ cursor: onChange ? "crosshair" : undefined }}>
        <canvas
          ref={canvas}
          width={part.width}
          height={part.height}
          className="block h-full w-full"
          style={{ opacity: level, imageRendering: "auto" }}
          onPointerDown={(e) => {
            e.stopPropagation()
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch {
              // A synthetic pointer cannot be captured; the press still counts.
            }
            onChange?.({ pressed: true, ...at(e) })
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) onChange?.({ pressed: true, ...at(e) })
          }}
          onPointerUp={(e) => onChange?.({ pressed: false, ...at(e) })}
          onPointerCancel={() => onChange?.({ pressed: false })}
        />
      </div>
    </foreignObject>
  )
}

function Part({
  part,
  g,
  state,
  level,
  display,
  onChange,
}: {
  part: PartDef
  g: (v: number) => number
  state: PartState
  /** 0..1 brightness from the simulation; undefined when not simulated. */
  level?: number
  /** The frame a display shows. */
  display?: DisplayFrame
  /** Undefined while the simulation owns this part. */
  onChange?: (patch: PartState) => void
}) {
  const cx = g(part.x)
  const cy = g(part.y)
  const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation()
  const title = `${part.label}${"mcu" in part && part.mcu ? ` · ${part.mcu}` : ""}`

  if (part.type === "display") return <DisplayPanel part={part} g={g} level={level ?? 0} display={display} onChange={onChange} />

  if (part.type === "led") {
    const glow = level ?? (state.on ? 1 : 0)
    if (part.style === "glow") {
      return glow > 0 ? (
        <circle cx={cx} cy={cy} r={g(0.9)} fill={part.color} opacity={0.15 + 0.45 * glow} stroke="none" pointerEvents="none" />
      ) : null
    }
    return (
      <g
        className={cn(onChange && "cursor-pointer")}
        onPointerDown={stop}
        onClick={(e) => {
          stop(e)
          onChange?.({ on: !state.on })
        }}
      >
        <title>{title}</title>
        {glow > 0 && <circle cx={cx} cy={cy} r={g(0.7)} fill={part.color} opacity={0.1 + 0.3 * glow} stroke="none" />}
        <rect
          x={cx - g(0.35)}
          y={cy - g(0.25)}
          width={g(0.7)}
          height={g(0.5)}
          rx={g(0.08)}
          fill={part.color}
          opacity={0.35 + 0.65 * glow}
          className="stroke-foreground/50"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <text x={cx} y={cy + g(0.65)} fontSize={g(0.28)} textAnchor="middle" className="fill-muted-foreground stroke-none font-mono">
          {part.label}
        </text>
      </g>
    )
  }

  if (part.type === "switch") {
    const x2 = cx + g(part.span)
    const angle = state.on ? 0 : -28
    return (
      <g
        className="cursor-pointer"
        onPointerDown={stop}
        onClick={(e) => {
          stop(e)
          onChange?.({ on: !state.on })
        }}
      >
        <title>{title}</title>
        <circle cx={cx} cy={cy} r={g(0.12)} className="fill-foreground stroke-none" />
        <circle cx={x2} cy={cy} r={g(0.12)} className="fill-foreground stroke-none" />
        <line
          x1={cx}
          y1={cy}
          x2={x2}
          y2={cy}
          transform={`rotate(${angle} ${cx} ${cy})`}
          className="stroke-foreground transition-transform"
          strokeWidth={SYMBOL_STROKE}
          strokeLinecap="round"
        />
        {/* hit area */}
        <rect x={cx - g(0.3)} y={cy - g(1)} width={g(part.span) + g(0.6)} height={g(1.3)} className="fill-transparent stroke-none" />
      </g>
    )
  }

  if (part.type === "usb") {
    // Connector body with the cable plugged in (or not). The cable leaves toward `side`.
    const dir = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }[part.side]
    const w = g(2.4)
    const h = g(1.2)
    const plugged = !!state.on
    const cx2 = cx + dir[0] * g(1.9)
    const cy2 = cy + dir[1] * g(1.4)
    return (
      <g
        className="cursor-pointer"
        onPointerDown={stop}
        onClick={(e) => {
          stop(e)
          onChange?.({ on: !state.on })
        }}
      >
        <title>{`${title}: click to ${plugged ? "unplug" : "plug in"}`}</title>
        <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={g(0.15)} className="fill-neutral-300 stroke-foreground/50 dark:fill-neutral-600" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <rect x={cx - w / 2 + g(0.3)} y={cy - h / 2 + g(0.3)} width={w - g(0.6)} height={h - g(0.6)} className="fill-neutral-500 stroke-none dark:fill-neutral-800" />
        {plugged && (
          <>
            <rect x={cx - g(0.9)} y={cy - g(0.45)} width={g(1.8)} height={g(0.9)} rx={g(0.1)} className="fill-neutral-700 stroke-none dark:fill-neutral-300" />
            <rect
              x={Math.min(cx, cx2) - (dir[1] ? g(0.9) : 0)}
              y={Math.min(cy, cy2) - (dir[0] ? g(0.9) : 0)}
              width={dir[0] ? Math.abs(cx2 - cx) : g(1.8)}
              height={dir[1] ? Math.abs(cy2 - cy) : g(1.8)}
              rx={g(0.3)}
              className="fill-neutral-700 stroke-none dark:fill-neutral-300"
            />
            <line
              x1={cx2}
              y1={cy2}
              x2={cx2 + dir[0] * g(6)}
              y2={cy2 + dir[1] * g(6)}
              className="stroke-neutral-700 dark:stroke-neutral-300"
              strokeWidth={g(0.3)}
              strokeLinecap="round"
            />
          </>
        )}
        <text x={cx} y={cy + h / 2 + g(0.45)} fontSize={g(0.3)} textAnchor="middle" className={cn("stroke-none font-mono", plugged ? "fill-foreground" : "fill-muted-foreground")}>
          {plugged ? "USB" : "USB (unplugged)"}
        </text>
        {/* generous hit area */}
        <rect x={cx - w} y={cy - h} width={w * 2} height={h * 2} className="fill-transparent stroke-none" />
      </g>
    )
  }

  if (part.type === "logic") {
    // A logic-level box: reads 1 or 0, click flips it.
    const half = g(0.7)
    return (
      <g
        className="cursor-pointer"
        onPointerDown={stop}
        onClick={(e) => {
          stop(e)
          onChange?.({ on: !state.on })
        }}
      >
        <title>{title}</title>
        <rect
          x={cx - half}
          y={cy - half}
          width={half * 2}
          height={half * 2}
          rx={g(0.15)}
          className={cn("stroke-foreground/60 transition-colors", state.on ? "fill-orange-500" : "fill-background")}
          strokeWidth={SYMBOL_STROKE}
        />
        <text
          x={cx}
          y={cy + g(0.02)}
          fontSize={g(0.9)}
          textAnchor="middle"
          dominantBaseline="middle"
          className={cn("pointer-events-none stroke-none font-mono font-semibold", state.on ? "fill-white" : "fill-foreground")}
        >
          {state.on ? "1" : "0"}
        </text>
      </g>
    )
  }

  const size = part.size ?? 1.6
  const half = g(size / 2)
  return (
    <g
      className="cursor-pointer"
      onPointerDown={(e) => {
        stop(e)
        e.currentTarget.setPointerCapture(e.pointerId)
        onChange?.({ pressed: true })
      }}
      onPointerUp={() => onChange?.({ pressed: false })}
      onPointerCancel={() => onChange?.({ pressed: false })}
    >
      <title>{title}</title>
      <rect
        x={cx - half}
        y={cy - half}
        width={half * 2}
        height={half * 2}
        rx={g(0.15)}
        className="fill-secondary stroke-border"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={cx}
        cy={cy}
        r={half * (state.pressed ? 0.52 : 0.62)}
        className={cn("stroke-foreground/40", part.id === "RESET" ? "fill-neutral-800" : "fill-blue-500")}
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {part.label && (
        <text x={cx} y={cy + half + g(0.4)} fontSize={g(0.28)} textAnchor="middle" className="fill-muted-foreground stroke-none font-mono">
          {part.label}
        </text>
      )}
    </g>
  )
}
