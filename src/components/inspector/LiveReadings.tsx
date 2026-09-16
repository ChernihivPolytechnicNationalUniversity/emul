import { cn } from "@/lib/utils"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import { getDef } from "@/schematic/registry"
import { rotatePin } from "@/schematic/geometry"
import type { PlacedObject } from "@/schematic/types"
import type { Reading } from "@/sim/engine"
import type { SimReadout } from "@/sim/use-simulation"
import { formatSI } from "@/sim/units"

type LiveReadingsProps = React.ComponentProps<"div"> & {
  object: PlacedObject
  sim: SimReadout
}

const KIND_LABEL: Record<Reading["kind"], string> = {
  R: "Resistor",
  C: "Capacitor",
  L: "Inductor",
  V: "Source",
  BAT: "Battery",
  XFMR: "Transformer",
  D: "Diode",
  Q: "Transistor",
  M: "MOSFET",
  SW: "Switch",
  GPIO: "Pin driver",
  REG: "Regulator",
}

/** Below this an element on a board counts as idle and is left out of the inspector. */
const IDLE_CURRENT = 1e-6

/** Live operating point of a selected component while the simulation runs. */
export function LiveReadings({ object, sim, className, ...props }: LiveReadingsProps) {
  const def = getDef(object.def)
  if (!def) return null
  // A board has dozens of internal elements; only the ones doing something are worth a card,
  // and its ground pins all read 0 V.
  const idle = (r: Reading) => def.hideIdle && Math.abs(r.rms ? r.rms.current : r.current) < IDLE_CURRENT
  const readings = sim.readings(object.id).filter((r) => !r.hidden && !idle(r))
  const pins = def.pins
    .filter((p) => !(def.hideIdle && p.kind === "gnd"))
    .map((p) => ({ pin: rotatePin(p, def, object.rotation), v: sim.ac ? sim.pinVoltageRms(object.id, p.id) : sim.pinVoltage(object.id, p.id) }))
    .filter((x) => x.v !== undefined)

  if (readings.length === 0 && pins.length === 0) {
    return (
      <div className={cn("text-xs text-muted-foreground", className)} {...props}>
        Not connected to a live circuit.
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-3", className)} {...props}>
      {readings.map((r, i) => (
        <ElementReading key={i} reading={r} title={readings.length > 1 ? `${KIND_LABEL[r.kind]} ${i + 1}` : KIND_LABEL[r.kind]} />
      ))}
      {pins.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">{sim.ac ? "Pin voltages (RMS)" : "Pin voltages"}</div>
          <Table className="text-xs">
            <TableBody>
              {pins.map(({ pin, v }) => (
                <TableRow key={pin.id} className="hover:bg-transparent">
                  <TableCell className="h-6 py-0 font-mono text-muted-foreground">{pin.label || pin.id}</TableCell>
                  <TableCell className="h-6 py-0 text-right font-mono tabular-nums">{formatSI(v!, "V")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function ElementReading({ reading: r, title }: { reading: Reading; title: string }) {
  // In AC circuits the instantaneous values swing every sample, so the readings show RMS instead.
  const rms = r.rms
  const iName = r.kind === "Q" ? "Ic" : r.kind === "M" ? "Id" : "Current"
  const vName = r.kind === "Q" ? "Vce" : r.kind === "M" ? "Vds" : r.kind === "D" ? "Vf" : "Voltage"
  const rows: [string, string][] = rms
    ? [
        [`${iName} (RMS)`, formatSI(rms.current, "A")],
        [`${vName} (RMS)`, formatSI(rms.voltage, "V")],
      ]
    : [
        [iName, formatSI(Math.abs(r.current), "A")],
        [vName, formatSI(r.voltage, "V")],
      ]
  if (r.kind !== "C" && r.kind !== "L") rows.push([rms ? "Power (avg)" : "Power", formatSI(rms ? rms.power : r.power, "W")])
  for (const [k, v] of Object.entries(r.extra ?? {})) rows.push([k, v])
  const charge = r.charge

  const load = r.load
  const tone = load === undefined ? "" : load >= 1 ? "text-destructive" : load >= 0.7 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 px-2.5 py-2">
      {load === undefined ? (
        <div className="text-xs font-medium">{title}</div>
      ) : (
        <Progress
          value={Math.min(100, load * 100)}
          className={cn(
            "gap-1",
            load >= 1 ? "[&_[data-slot=progress-indicator]]:bg-destructive" : load >= 0.7 && "[&_[data-slot=progress-indicator]]:bg-amber-500",
          )}
        >
          <ProgressLabel className="text-xs">{title}</ProgressLabel>
          <ProgressValue className={cn("text-xs", tone)}>{() => `${Math.round(load * 100)}% of rating`}</ProgressValue>
        </Progress>
      )}
      {charge !== undefined && (
        <Progress value={Math.min(100, charge * 100)} className={cn("gap-1", charge <= 0.1 && "[&_[data-slot=progress-indicator]]:bg-destructive")}>
          <ProgressLabel className="text-xs">Charge</ProgressLabel>
          <ProgressValue className="text-xs text-muted-foreground">{() => `${Math.round(charge * 100)} %`}</ProgressValue>
        </Progress>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-mono tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
