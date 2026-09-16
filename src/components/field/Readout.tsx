import { XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { resolvePin } from "@/schematic/geometry"
import { pinName } from "@/schematic/registry"
import type { PinRef, PlacedObject, Wire } from "@/schematic/types"
import type { ProbeReading } from "@/sim/engine"
import type { SimReadout } from "@/sim/use-simulation"
import { formatSI } from "@/sim/units"
import type { ProbePoint } from "./use-measure"

/** What the cursor is over. Components have the inspector; these two have nowhere else to show. */
export type HoverTarget = { kind: "pin"; ref: PinRef } | { kind: "wire"; id: string }

type Row = [label: string, value: string]

/** Distance from the cursor to the card, and the room a card needs before it flips over. */
const GAP = 14
const CARD_W = 240
const CARD_H = 150

/** Live values for whatever the cursor is over, floating next to it. */
export function FieldReadout({
  target,
  x,
  y,
  objects,
  wires,
  sim,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  target: HoverTarget
  /** Cursor position in client coordinates. */
  x: number
  y: number
  objects: PlacedObject[]
  wires: Wire[]
  sim: SimReadout
}) {
  const content = target.kind === "pin" ? pinContent(target.ref, objects, sim) : wireContent(target.id, objects, wires, sim)
  if (!content) return null
  const { title, rows, note } = content
  const flipX = x + GAP + CARD_W > window.innerWidth
  const flipY = y + GAP + CARD_H > window.innerHeight

  return (
    <div
      data-slot="field-readout"
      className={cn(
        "pointer-events-none fixed z-50 w-max max-w-60 rounded-md border bg-popover/95 px-2.5 py-1.5 text-popover-foreground shadow-md backdrop-blur-sm",
        className,
      )}
      style={{
        left: flipX ? undefined : x + GAP,
        right: flipX ? window.innerWidth - x + GAP : undefined,
        top: flipY ? undefined : y + GAP,
        bottom: flipY ? window.innerHeight - y + GAP : undefined,
      }}
      {...props}
    >
      <div className="text-xs font-medium">{title}</div>
      {rows.length > 0 && <Values rows={rows} className="mt-1" />}
      {note && <div className="mt-1 max-w-56 text-[0.6875rem] leading-tight text-muted-foreground">{note}</div>}
    </div>
  )
}

function Values({ rows, className }: { rows: Row[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs", className)}>
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right font-mono tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function pinContent(ref: PinRef, objects: PlacedObject[], sim: SimReadout) {
  const found = resolvePin(objects, ref, 1)
  if (!found) return null
  const { obj, def, pin } = found
  const rows: Row[] = []
  if (sim.live) {
    const v = sim.ac ? sim.pinVoltageRms(ref.object, ref.pin) : sim.pinVoltage(ref.object, ref.pin)
    const i = sim.pinCurrent(ref.object, ref.pin)
    if (v !== undefined) rows.push([sim.ac ? "V (RMS)" : "V", formatSI(v, "V")])
    // Sign is the current into the component; the magnitude is what a meter in the lead would read.
    if (i !== undefined) rows.push(["I", formatSI(Math.abs(i), "A")])
    if (v === undefined) rows.push(["V", "not on a live net"])
  }
  const note = [pin.mcu, pin.signal && pin.signal !== pin.label ? pin.signal : undefined, pin.fn, pin.connector ? `${pin.connector} pin ${pin.connectorPin}` : undefined, pin.note]
    .filter(Boolean)
    .join(" · ")
  const owner = obj.props?.ref || def.name
  return { title: pin.label ? `${owner} · ${pin.label}` : owner, rows, note }
}

function wireContent(id: string, objects: PlacedObject[], wires: Wire[], sim: SimReadout) {
  const wire = wires.find((w) => w.id === id)
  if (!wire) return null
  const from = pinName(objects, wire.from)
  const to = pinName(objects, wire.to)
  const rows: Row[] = []
  if (sim.live) {
    const i = sim.wireCurrent.get(id)
    const v = sim.ac ? sim.pinVoltageRms(wire.from.object, wire.from.pin) : sim.pinVoltage(wire.from.object, wire.from.pin)
    if (i !== undefined) rows.push(["I", formatSI(Math.abs(i), "A")])
    if (v !== undefined) rows.push([sim.ac ? "V (RMS)" : "V", formatSI(v, "V")])
    else rows.push(["V", "not on a live net"])
  }
  // Wire current is signed from `from` to `to`; the arrow says where it actually goes.
  const i = sim.wireCurrent.get(id) ?? 0
  const flow = !sim.live || Math.abs(i) < 1e-9 ? `${from} — ${to}` : i > 0 ? `${from} → ${to}` : `${to} → ${from}`
  return { title: "Wire", rows, note: flow }
}

/** The probe's own panel: what it is across, and what it reads. */
export function ProbeReadout({
  tips,
  reading,
  sim,
  onClear,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  tips: { a: ProbePoint | null; b: ProbePoint | null }
  reading: (ProbeReading & { live: boolean }) | undefined
  sim: SimReadout
  onClear: () => void
}) {
  if (!tips.a) return null
  const across = `${tips.a.label} → ${tips.b ? tips.b.label : "ground"}`
  const rows: Row[] = []
  let note: string | undefined
  if (!sim.live) note = "Run the simulation to read the probe."
  else if (!reading?.live) note = "One of the tips is not on a live net."
  else {
    rows.push(["ΔV", formatSI(reading.v, "V")])
    if (sim.ac) {
      rows.push(["RMS", formatSI(reading.rms, "V")])
      rows.push(["Average", formatSI(reading.avg, "V")])
      rows.push(["Peak-peak", formatSI(reading.max - reading.min, "V")])
    } else if (reading.max - reading.min > Math.max(1e-6, 0.01 * Math.abs(reading.v))) {
      // A DC circuit that still swings — a flasher, a switching load — is worth showing as a range.
      rows.push(["Swing", `${formatSI(reading.min, "V")} … ${formatSI(reading.max, "V")}`])
      rows.push(["Average", formatSI(reading.avg, "V")])
    }
    if (!tips.b) note = "Click a second point to measure across it."
  }

  return (
    <div
      data-slot="probe-readout"
      className={cn("w-56 rounded-md border bg-card/95 px-2.5 py-2 text-card-foreground shadow-md backdrop-blur-sm", className)}
      {...props}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">Probe</div>
          <div className="truncate font-mono text-[0.6875rem] text-muted-foreground">{across}</div>
        </div>
        <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1 shrink-0" onClick={onClear} aria-label="Clear probe">
          <XIcon />
        </Button>
      </div>
      {rows.length > 0 && <Values rows={rows} className="mt-1.5" />}
      {note && <div className="mt-1.5 text-[0.6875rem] leading-tight text-muted-foreground">{note}</div>}
    </div>
  )
}
