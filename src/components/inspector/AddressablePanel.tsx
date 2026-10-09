import { TriangleAlertIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import type { AddressableSnapshot } from "@/sim/addressable/chain"
import type { SimReadout } from "@/sim/use-simulation"
import { formatSI } from "@/sim/units"
import { cn } from "@/lib/utils"

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`

/** What the chips of an addressable-LED part latched, what they draw, and what the data looked like to them. */
export function AddressablePanel({ objectId, sim }: { objectId: string; sim: SimReadout }) {
  const snap = sim.digital(objectId) as AddressableSnapshot | undefined
  if (!snap) return <div className="text-xs text-muted-foreground">Run the simulation to see what the chips latch.</div>
  const low = snap.dinHigh !== null && snap.dinHigh < snap.vih
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Supply</dt>
        <dd className={cn("text-right font-mono tabular-nums", !snap.powered && "text-destructive")}>
          {formatSI(snap.vdd, "V", 3)} · {snap.burnt ? "burnt" : snap.powered ? formatSI(snap.current, "A", 3) : "off"}
        </dd>
        <dt className="text-muted-foreground">Input</dt>
        <dd className={cn("text-right font-mono tabular-nums", low && "text-destructive")} title="Highest level the data input was seen at, against the chip's VIH">
          {snap.input}
          {snap.dinHigh !== null && ` · high ${formatSI(snap.dinHigh, "V", 3)} / VIH ${formatSI(snap.vih, "V", 3)}`}
        </dd>
        <dt className="text-muted-foreground">Frames</dt>
        <dd className="text-right font-mono tabular-nums">
          {snap.frames} · last {snap.lastBits} bits{snap.passed ? ` · ${snap.passed} passed on` : ""}
        </dd>
      </dl>
      {!snap.powered && !snap.burnt && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Supply too low</AlertTitle>
          <AlertDescription>
            The {snap.part} gets {formatSI(snap.vdd, "V", 3)} and needs at least {formatSI(snap.supplyMin, "V", 3)} (its datasheet minimum): the chip is off, takes no data and lights
            nothing.
          </AlertDescription>
        </Alert>
      )}
      {low && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Data below VIH</AlertTitle>
          <AlertDescription>
            The data line goes up to {formatSI(snap.dinHigh!, "V", 3)}, the {snap.part} needs {formatSI(snap.vih, "V", 3)} (its datasheet VIH): {snap.ignored} pulses ignored.
            Shift the level up (a 74AHCT125, or an open-drain pin with a pull-up to the LED supply), run the LEDs from a lower supply, or use a revision with a
            lower VIH (WS2812B-V5: 2.7 V).
          </AlertDescription>
        </Alert>
      )}
      {snap.notes.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Mode</AlertTitle>
          <AlertDescription>{snap.notes.join("; ")}</AlertDescription>
        </Alert>
      )}
      {snap.faults.length > 0 && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Timing out of datasheet limits</AlertTitle>
          <AlertDescription>
            <ul className="font-mono tabular-nums">
              {snap.faults.map((f) => (
                <li key={f.rule}>
                  {f.rule}: {formatSI(f.last, f.rule.startsWith("clock") ? "Hz" : "s", 3)} (limit {formatSI(f.limit, f.rule.startsWith("clock") ? "Hz" : "s", 3)}) ×{f.count}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {snap.header.length > 0 && (
        <div className="font-mono text-[10.5px] text-muted-foreground" title="Current gain of each channel, from the frame header every chip reads and passes on">
          gain {snap.header.map((f) => `${f.channel} ${f.value}/${2 ** f.bits - 1}`).join("  ")}
        </div>
      )}
      <div className="max-h-56 overflow-auto rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[10.5px] leading-snug">
        {snap.words.map((fields, chip) => (
          <div key={chip} className="flex items-center gap-2">
            <span className="w-6 text-right text-muted-foreground">{chip}</span>
            {snap.colors.length > 0 && <span className="size-2.5 shrink-0 rounded-sm border" style={{ background: snap.colors[chip] ? hex(snap.colors[chip]) : undefined }} />}
            <span className="truncate">
              {fields.map((f) => `${f.role === "gain" ? `${f.channel}·gain` : f.channel} ${f.value.toString(16).padStart(Math.ceil(f.bits / 4), "0")}`).join("  ")}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
