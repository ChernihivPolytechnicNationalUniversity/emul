import type { EepromSnapshot } from "@/sim/digital"
import type { ClockStatus, PowerStatus } from "@/mcu/stm32f429"
import * as React from "react"
import { CodeIcon, CpuIcon, FlameIcon, RotateCcwIcon, RotateCwIcon, Trash2Icon, TriangleAlertIcon, UploadIcon, XIcon } from "lucide-react"
import { bytesToBase64 } from "@/lib/bytes"
import { cn } from "@/lib/utils"
import { chipById } from "@/mcu/chip"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { getDef } from "@/schematic/registry"
import type { Damage, PlacedObject, PropField } from "@/schematic/types"
import type { ClockSource } from "@/mcu/periph/rcc"
import type { SimReadout } from "@/sim/use-simulation"
import { formatSI, SI_PREFIXES, UNIT_PREFIXES, joinValue, splitValue } from "@/sim/units"

/** "Run", "Sleep 97 %" (share of the time in WFI), "Stop (low-power regulator)", "Standby". */
function powerLabel(p: PowerStatus): string {
  switch (p.mode) {
    case "stop":
      return `Stop (${p.regulator} regulator)`
    case "standby":
      return "Standby"
    default:
      return p.asleep >= 0.995 ? "Sleep" : p.asleep < 0.005 ? "Run" : `Sleep ${Math.round(p.asleep * 100)} %`
  }
}
import { LiveReadings } from "./LiveReadings"

/** "PLL ← HSE 8 MHz clock", "HSI": the system clock source and what feeds the oscillator it hangs on. */
function clockLabel(c: ClockStatus): string {
  const src = (s: ClockSource | null) => (s ? `${formatSI(s.hz, "Hz", 4)} ${s.kind === "crystal" ? "crystal" : s.kind === "clock" ? "clock" : "bench"}` : "none")
  if (c.source === "HSE") return `HSE ${src(c.hse)}`
  if (c.source === "PLL") return `PLL ← ${c.pllSource === "HSE" ? `HSE ${src(c.hse)}` : "HSI"}`
  return "HSI 16 MHz"
}

type InspectorProps = Omit<React.ComponentProps<typeof Card>, "onChange"> & {
  /** Currently selected objects; the panel edits a single one. */
  selected: PlacedObject[]
  /** Burnt components from the running simulation. */
  damage: Record<string, Damage>
  sim: SimReadout
  onChange: (id: string, patch: Record<string, string>) => void
  /** Text typed into a serial terminal. */
  onSerial?: (id: string, text: string) => void
  /** Open the code panel on this board or chip. */
  onCode?: (id: string) => void
  onRotate: (delta: 45 | -45) => void
  onDelete: () => void
}

export function Inspector({ selected, damage, sim, onChange, onSerial, onCode, onRotate, onDelete, className, ...props }: InspectorProps) {
  if (selected.length === 0) return null
  const object = selected.length === 1 ? selected[0] : null
  const def = object && getDef(object.def)

  return (
    <Card data-slot="inspector" className={cn("max-h-[calc(100%-1.5rem)] w-72 gap-4 overflow-y-auto py-4 shadow-md", className)} {...props}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{def ? def.name : `${selected.length} components`}</CardTitle>
        {def?.description && <CardDescription>{def.description}</CardDescription>}
        <CardAction>
          <ButtonGroup>
            <Button variant="ghost" size="icon-sm" onClick={() => onRotate(-45)} aria-label="Rotate 45° counter-clockwise">
              <RotateCcwIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => onRotate(45)} aria-label="Rotate 45° clockwise">
              <RotateCwIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label="Delete" className="text-destructive">
              <Trash2Icon />
            </Button>
          </ButtonGroup>
        </CardAction>
      </CardHeader>
      {object && def && (
        <CardContent className="flex flex-col gap-4 px-4">
          {damage[object.id] && (
            <Alert variant="destructive">
              <FlameIcon />
              <AlertTitle>{damage[object.id].fatal ? "Burnt out" : "Damaged"}</AlertTitle>
              <AlertDescription>
                {[damage[object.id], ...(damage[object.id].also ?? [])].map((d, i) => (
                  <span key={i}>
                    {d.reason}: now {d.fail === "short" ? "a short circuit" : "an open circuit"}.{" "}
                  </span>
                ))}
                {damage[object.id].fatal ? "The part is dead; fix the circuit and run again." : "The rest of the part still works; fix the circuit and run again."}
              </AlertDescription>
            </Alert>
          )}
          {def.chip && <FirmwarePanel object={object} chip={chipById(def.chip)?.name ?? "STM32"} sim={sim} onChange={onChange} onCode={onCode} />}
          {def.id === "serial-terminal" && <TerminalPanel object={object} sim={sim} onSend={(text) => onSerial?.(object.id, text)} />}
          {def.id === "eeprom-24c" && <EepromPanel object={object} sim={sim} />}
          {sim.live && !damage[object.id]?.fatal && <LiveReadings object={object} sim={sim} />}
          <FieldGroup className="gap-4">
            {def.prefix && (
              <PropEditor
                field={{ key: "ref", label: "Designator", type: "text", placeholder: `${def.prefix}1` }}
                value={object.props?.ref ?? ""}
                onChange={(v) => onChange(object.id, { ref: v })}
              />
            )}
            {def.fields?.map((f) => (
              <PropEditor
                key={f.key}
                field={f}
                value={object.props?.[f.key] ?? def.defaults?.[f.key] ?? ""}
                onChange={(v) => onChange(object.id, { [f.key]: v })}
              />
            ))}
          </FieldGroup>
        </CardContent>
      )}
    </Card>
  )
}

function PropEditor({ field, value, onChange }: { field: PropField; value: string; onChange: (v: string) => void }) {
  const id = React.useId()
  switch (field.type) {
    case "text":
      return (
        <Field>
          <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
          <Input id={id} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} className="h-8" />
        </Field>
      )
    case "quantity": {
      const { number, prefix } = splitValue(value)
      const invalid = value.trim() !== "" && number === ""
      // A stored prefix outside the unit's usual range is still offered, so it can be read back.
      const prefixes = UNIT_PREFIXES[field.unit] ?? SI_PREFIXES
      const options = (prefixes.includes(prefix) ? prefixes : [prefix, ...prefixes]).map((p) => ({
        value: p,
        label: `${p}${field.unit}`,
      }))
      return (
        <Field data-invalid={invalid || undefined}>
          <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
          <InputGroup className="h-8">
            <InputGroupInput
              id={id}
              inputMode="decimal"
              value={number}
              placeholder={field.placeholder}
              aria-invalid={invalid || undefined}
              onChange={(e) => onChange(joinValue(e.target.value, prefix, field.unit))}
            />
            <InputGroupAddon align="inline-end" className="pr-0">
              <Select
                value={prefix}
                items={options}
                onValueChange={(p) => p !== null && onChange(joinValue(number, String(p), field.unit))}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={`Unit for ${field.label}`}
                  className="h-7 min-w-16 justify-end gap-1 rounded-l-none border-0 bg-transparent px-2 shadow-none tabular-nums dark:bg-transparent"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InputGroupAddon>
          </InputGroup>
          {invalid && <FieldError>Enter a number.</FieldError>}
        </Field>
      )
    }
    case "select":
      return (
        <Field>
          <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
          <Select
            value={value}
            items={field.options.map((o) => ({ value: o.value, label: o.label }))}
            onValueChange={(v) => v !== null && onChange(String(v))}
          >
            <SelectTrigger id={id} size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {field.options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )
    case "range": {
      const n = Number(value)
      return (
        <Field>
          <div className="flex items-center justify-between">
            <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
            <FieldDescription className="tabular-nums">
              {Number.isFinite(n) ? n : field.min}
              {field.unit ? ` ${field.unit}` : ""}
            </FieldDescription>
          </div>
          <Slider
            id={id}
            min={field.min}
            max={field.max}
            step={field.step}
            value={Number.isFinite(n) ? n : field.min}
            onValueChange={(v) => onChange(String(Array.isArray(v) ? v[0] : v))}
          />
        </Field>
      )
    }
  }
}

/**
 * Firmware for the board's MCU: an ELF/HEX/BIN straight from the toolchain, kept in the
 * document so a saved schematic carries its program. While the simulation runs, the panel
 * shows where the core is.
 */
/**
 * Serial terminal: what came in on RX, and a line to send out on TX. Enter sends the line with
 * CR LF, the way a PC terminal does.
 */
function TerminalPanel({ object, sim, onSend }: { object: PlacedObject; sim: SimReadout; onSend: (text: string) => void }) {
  const [line, setLine] = React.useState("")
  const box = React.useRef<HTMLPreElement>(null)
  const term = sim.terminal(object.id)
  const text = term?.text ?? ""
  React.useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Terminal · {object.props?.baud ?? "115200"} 8N1</span>
        {term && term.framingErrors > 0 && <span className="text-destructive">{term.framingErrors} framing errors</span>}
      </div>
      <pre ref={box} className="h-40 overflow-auto rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all">
        {text || <span className="text-muted-foreground">{sim.live ? "Nothing received yet." : "Run the simulation to see what arrives."}</span>}
      </pre>
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          if (!sim.live) return
          onSend(line + "\r\n")
          setLine("")
        }}
      >
        <Input value={line} onChange={(e) => setLine(e.target.value)} placeholder="Type and press Enter" className="h-7 font-mono text-xs" disabled={!sim.live} />
        <Button type="submit" size="sm" variant="outline" className="h-7" disabled={!sim.live}>
          Send
        </Button>
      </form>
    </div>
  )
}

/** Hex dump of a 24Cxx's contents, straight from the model. */
function EepromPanel({ object, sim }: { object: PlacedObject; sim: SimReadout }) {
  const snap = sim.digital(object.id) as EepromSnapshot | undefined
  const rows: string[] = []
  if (snap) {
    const width = 8 // fits the inspector's width with the ASCII column
    for (let a = 0; a < snap.size; a += width) {
      const chunk = snap.bytes.slice(a, a + width)
      const hex = chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ")
      const ascii = chunk.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·")).join("")
      rows.push(`${a.toString(16).padStart(4, "0")}  ${hex.padEnd(width * 3 - 1)}  ${ascii}`)
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {object.props?.value ?? "24C02"} · address 0x{(snap?.address ?? 0x50).toString(16)}
          {snap ? ` · ${snap.writes} bytes written` : ""}
        </span>
        {snap && snap.busyUntil > sim.time && <span className="text-muted-foreground">write cycle…</span>}
      </div>
      <pre className="h-48 overflow-auto rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[10.5px] leading-snug">
        {rows.length ? rows.join("\n") : <span className="text-muted-foreground">Run the simulation to see the contents.</span>}
      </pre>
    </div>
  )
}

function FirmwarePanel({ object, chip, sim, onChange, onCode }: { object: PlacedObject; chip: string; sim: SimReadout; onChange: InspectorProps["onChange"]; onCode?: (id: string) => void }) {
  const input = React.useRef<HTMLInputElement>(null)
  const name = object.props?.firmware
  const data = object.props?.firmwareData
  const size = data ? Math.floor((data.length * 3) / 4) : 0
  const status = sim.mcu(object.id)

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    // An image from elsewhere: not built from this project (the debugger then asks for its sources).
    onChange(object.id, { firmware: file.name, firmwareData: bytesToBase64(bytes), firmwareBuild: "" })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">Firmware</div>
        <input ref={input} type="file" accept=".elf,.hex,.bin,.axf,.out" className="hidden" onChange={onFile} />
        <ButtonGroup>
          {onCode && (
            <Button variant="outline" size="xs" onClick={() => onCode(object.id)} title="Source code (⌘J)">
              <CodeIcon />
              Code…
            </Button>
          )}
          <Button variant="outline" size="xs" onClick={() => input.current?.click()}>
            <UploadIcon />
            {data ? "Replace" : "Load…"}
          </Button>
          {data && (
            <Button variant="outline" size="icon-xs" aria-label="Remove firmware" onClick={() => onChange(object.id, { firmware: "", firmwareData: "", firmwareBuild: "" })}>
              <XIcon />
            </Button>
          )}
        </ButtonGroup>
      </div>
      {data ? (
        <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 px-2.5 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-mono">
            <CpuIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">{formatSI(size, "B", 3)}</span>
          </div>
          {status && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              <dt className="text-muted-foreground">Core</dt>
              <dd className={cn("text-right font-mono", (status.halted || !status.powered) && "text-destructive")}>{!status.powered ? "no power" : status.halted ? "halted" : status.running ? "running" : "stopped"}</dd>
              <dt className="text-muted-foreground">SYSCLK</dt>
              <dd className="text-right font-mono tabular-nums" title="System clock source; HSE/LSE come from the crystal or oscillator wired to the OSC pins (a board brings its own)">
                {status.sysclk ? `${formatSI(status.sysclk, "Hz", 4)} · ${clockLabel(status.clock)}` : "—"}
              </dd>
              <dt className="text-muted-foreground">PC</dt>
              <dd className="text-right font-mono tabular-nums">0x{status.pc.toString(16).padStart(8, "0")}</dd>
              <dt className="text-muted-foreground">Time</dt>
              <dd className="text-right font-mono tabular-nums">{formatSI(status.time, "s", 4)}</dd>
              <dt className="text-muted-foreground">Instructions</dt>
              <dd className="text-right font-mono tabular-nums">{status.instructions.toLocaleString()}</dd>
              <dt className="text-muted-foreground">Runs</dt>
              <dd
                className="text-right font-mono"
                title={
                  status.host === "worker (pipelined)"
                    ? "The core runs on its own CPU thread one step (20 µs) ahead of the circuit solver: pad and pin levels cross with 20 µs of latency"
                    : status.host === "worker (in step)"
                      ? "The core runs on its own CPU thread, waiting for the solver each step while a digital part on its nets answers its edges"
                      : "The core runs in the solver's thread (no cross-origin isolation, or in lockstep with another core on a shared net)"
                }
              >
                {status.host}
              </dd>
              {status.running && status.powered && (
                <>
                  <dt className="text-muted-foreground">Power</dt>
                  <dd className="text-right font-mono tabular-nums" title="Datasheet typical for the mode and clock, not a measurement of what the code does">
                    {powerLabel(status.power)} · ≈{formatSI(status.power.current, "A", 2)}
                  </dd>
                </>
              )}
              {status.resets > 0 && (
                <>
                  <dt className="text-muted-foreground">Resets</dt>
                  <dd className="text-right font-mono tabular-nums">
                    {status.resets} · last by {status.lastReset === "iwdg" ? "IWDG" : status.lastReset === "wwdg" ? "WWDG" : status.lastReset === "standby" ? "Standby exit" : "software"}
                  </dd>
                </>
              )}
              {status.backupKept && (
                <>
                  <dt className="text-muted-foreground">Backup domain</dt>
                  <dd className="text-right">kept on VBAT through the last power cut</dd>
                </>
              )}
              {status.halted && (
                <>
                  <dt className="text-muted-foreground">Reason</dt>
                  <dd className="text-right font-mono break-all text-destructive">{status.halted}</dd>
                </>
              )}
            </dl>
          )}
          {!status && <div className="text-muted-foreground">Runs when the simulation starts. Pins driven by the program replace the manual drives.</div>}
        </div>
      ) : null}
      {data && status && status.clock.problems.length > 0 ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>No clock</AlertTitle>
          <AlertDescription>
            {status.clock.problems.join("; ")}. The program is waiting for an oscillator that cannot start — wire a crystal across OSC_IN/OSC_OUT (an
            oscillator module into OSC_IN for bypass mode), or it times out into its error handler.
          </AlertDescription>
        </Alert>
      ) : null}
      {data && status && status.unmodelled.length > 0 ? (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Not modelled</AlertTitle>
          <AlertDescription>
            The program uses {status.unmodelled.map((u) => u.block).join(", ")}, which the emulator does not have yet. A missing block reads as zero and
            drives no pins; a missing mode of a modelled block is ignored. Code waiting on either will time out or spin.
          </AlertDescription>
        </Alert>
      ) : null}
      {!data && <div className="text-xs text-muted-foreground">No program: the MCU pins float. Load an .elf, .hex or .bin built for the {chip}.</div>}
    </div>
  )
}
