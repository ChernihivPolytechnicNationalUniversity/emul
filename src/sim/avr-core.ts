/**
 * An AVR microcontroller as the simulation loop sees any core (`CoreHost`): run to a time, read
 * the pads, take the circuit's levels and voltages, report status. It runs in the loop's own
 * thread; the AVR is light enough (one 16 MHz 8-bit core is a few percent of a CPU thread)
 * that a worker of its own buys nothing yet.
 */
import { CpuHalt } from "@/mcu/faults"
import type { AvrProfile } from "@/mcu/avr/chip"
import { createAvr } from "@/mcu/avr/parts"
import type { AvrMcu, SleepMode } from "@/mcu/avr/mcu"
import type { PadDrive } from "@/mcu/periph/gpio"
import type { ClockSource } from "@/mcu/periph/rcc"
import type { PadRef } from "@/mcu/pads"
import type { CoreDebugCommand, DebugStop, InspectReply, InspectRequest } from "@/debug/protocol"
import type { CoreHost, CoreStatus, OutEdge, PanelWiring } from "./core-host"

const SLEEP_LABEL: Record<SleepMode, string> = {
  idle: "Idle",
  "adc-noise": "ADC Noise Reduction",
  "power-down": "Power-down",
  "power-save": "Power-save",
  standby: "Standby",
  "extended-standby": "Extended Standby",
}
const hex = (v: number) => v.toString(16).toUpperCase().padStart(2, "0")
const RESET_LABEL = { "power-on": "power-on", external: "RESET pin", "brown-out": "brown-out", watchdog: "watchdog" } as const

export class AvrCore implements CoreHost {
  readonly mcu: AvrMcu
  readonly chip: AvrProfile
  readonly sync = false
  readonly ready = true
  boot0 = false
  private edges: OutEdge[] = []
  private readonly analog = new Map<number, number>()
  private analogDirty = false
  /** Supply-current meter: core cycles and sleep cycles at the last read. */
  private meter = { cycles: 0, sleep: 0 }
  private statusMeter = { cycles: 0, sleep: 0 }

  constructor(chip: AvrProfile) {
    this.chip = chip
    this.mcu = createAvr(chip)
    this.mcu.analogRead = (pad) => {
      const v = this.analog.get(pad.port * 16 + pad.pin)
      return v === undefined ? null : v
    }
  }

  get loaded() {
    return this.mcu.firmware !== null
  }
  get halted() {
    return this.mcu.cpu.halted !== null
  }
  get running() {
    return this.mcu.running
  }
  get time() {
    return this.mcu.time
  }
  /** RESET is the reset pin unless RSTDISBL made it PC6 or debugWIRE made it the dW line (§25.5, Table 28-7). */
  get resetPin() {
    return (this.mcu.fuses.high & 0x80) !== 0 && !this.mcu.debugWire
  }
  get porThreshold() {
    return this.chip.electrical.por.falling
  }
  get yieldOnOutput() {
    return this.mcu.yieldOnOutput
  }
  set yieldOnOutput(v: boolean) {
    this.mcu.yieldOnOutput = v
  }

  load(data: ArrayBuffer, name: string) {
    try {
      this.mcu.load(data, name)
    } catch (e) {
      this.mcu.firmware = null
      this.mcu.cpu.halted = new CpuHalt("fault", `cannot load firmware: ${(e as Error).message}`, 0)
    }
  }
  /**
   * Fuse bytes from the component's fields (hex); empty fields keep what the image's .fuse
   * section or the factory set. A change is a reprogramming: the part restarts with them.
   */
  configure(props: Record<string, string>) {
    // The silicon revision picks the errata that apply (DS80000855C); it takes effect at once.
    const rev = props.revision
    if (rev && this.mcu.chip.revisions.includes(rev) && rev !== this.mcu.revision) {
      this.mcu.revision = rev
      if (this.loaded) this.reset()
    }
    const f = this.mcu.fuses
    const next = { ...f }
    const parse = (v: string | undefined) => {
      if (!v) return null
      const n = parseInt(v.trim().replace(/^0x/i, ""), 16)
      return Number.isInteger(n) && n >= 0 && n <= 0xff ? n : null
    }
    next.low = parse(props.fuseLow) ?? f.low
    next.high = parse(props.fuseHigh) ?? f.high
    next.extended = parse(props.fuseExtended) ?? f.extended
    if (next.low === f.low && next.high === f.high && next.extended === f.extended) return
    this.mcu.fuses = next
    if (this.loaded) this.reset()
  }
  /** The loop releases reset: a power-on (supply came up) or the RESET pin going high (supply kept). */
  reset(opts: { backup?: boolean; supplyKept?: boolean } = {}) {
    this.mcu.time = 0
    this.mcu.reset(opts.supplyKept ? "external" : "power-on")
    this.meter = { cycles: 0, sleep: 0 }
    this.statusMeter = { cycles: 0, sleep: 0 }
  }
  runOnBattery() {}
  halt(reason: string) {
    this.mcu.cpu.halted = new CpuHalt("fault", reason, this.mcu.cpu.pc * 2)
  }
  /** XTAL1/XTAL2 take the place of HSE; there is no LSE pair on the 328P (TOSC shares the XTAL pins). */
  setClockSources(hse: ClockSource | null) {
    const feed = hse ? { hz: hse.hz, kind: hse.kind === "clock" ? ("clock" as const) : ("crystal" as const) } : null
    const now = this.mcu.clockFeed
    if (now?.hz !== feed?.hz || now?.kind !== feed?.kind) this.mcu.setClockFeed(feed)
  }
  setDigitalWatch(keys: Iterable<number>) {
    this.mcu.digitalWatch.clear()
    for (const k of keys) this.mcu.digitalWatch.add(k)
  }
  setPads(keys: Iterable<number>) {
    this.mcu.setWiredPads(keys)
  }
  setPad(pad: PadRef, level: boolean, sampledUnder?: PadDrive) {
    this.mcu.setPad(pad, level, sampledUnder)
  }
  setReadback() {}
  setPadAt(pad: PadRef, level: boolean, time: number) {
    this.mcu.setPadAt(pad, level, time)
  }
  setAnalog(pad: PadRef, volts: number) {
    const key = pad.port * 16 + pad.pin
    if (this.analog.get(key) === volts) return
    this.analog.set(key, volts)
    this.analogDirty = true
  }
  setAnalogSource() {}
  setSupply(volts: number) {
    this.mcu.setSupply(volts)
  }
  setBattery() {}
  setReference(volts: number) {
    this.mcu.setReference(volts)
  }

  runUntil(end: number) {
    if (this.analogDirty) {
      this.analogDirty = false
      this.mcu.analogChanged()
    }
    const ok = this.mcu.runUntil(end)
    this.collect()
    return ok
  }
  private collect() {
    if (this.mcu.digitalOut.length) {
      this.edges.push(...this.mcu.digitalOut)
      this.mcu.digitalOut.length = 0
    }
  }
  runSteps(time: number, base: number, dt: number, n: number, version: number, idd: number, quiet: () => boolean, step: () => void) {
    if (!this.running || this.padVersion() !== version) return 0
    let t = time
    for (let k = 1; ; k++) {
      const end = t + dt - base
      this.runUntil(end)
      const load = this.supplyCurrent()
      if (k >= n || !this.running || this.time < end || this.edges.length !== 0 || this.padVersion() !== version || load !== idd || !quiet()) {
        this.stepIdd = load
        return k
      }
      step()
      t += dt
    }
  }
  private stepIdd: number | null = null

  padDrive(pad: PadRef) {
    return this.mcu.padDrive(pad)
  }
  padVersion() {
    return this.mcu.padVersion()
  }
  dutyPads() {
    return this.mcu.dutyPads()
  }
  takeDuty(pad: PadRef, interval: number) {
    return this.mcu.takeDuty(pad, interval)
  }
  drainEdges() {
    this.collect()
    const out = this.edges
    this.edges = []
    return out
  }

  /** Typical supply current (Table 29-8) for the time awake and asleep since the last read. */
  private current(meter: { cycles: number; sleep: number }, keep: boolean): { current: number; asleep: number } {
    const cpu = this.mcu.cpu
    const cycles = cpu.cycles - meter.cycles
    const asleep = cycles > 0 ? Math.min(1, (cpu.sleepCycles - meter.sleep) / cycles) : this.mcu.sleepMode ? 1 : 0
    if (!keep) {
      meter.cycles = cpu.cycles
      meter.sleep = cpu.sleepCycles
    }
    return { current: this.mcu.supplyCurrent(asleep), asleep }
  }
  supplyCurrent() {
    if (this.stepIdd !== null) {
      const v = this.stepIdd
      this.stepIdd = null
      return v
    }
    return this.current(this.meter, false).current
  }

  status(): CoreStatus {
    const m = this.mcu
    const { current, asleep } = this.current(this.statusMeter, false)
    const problem = m.clockProblem()
    return {
      running: m.running,
      halted: m.cpu.halted?.message ?? null,
      time: m.time,
      pc: m.cpu.pc * 2,
      instructions: m.cpu.instructions,
      sysclk: m.firmware && !problem ? m.hz : 0,
      faults: [],
      unmodelled: [...m.unmodelled].map(([block, hit]) => ({ block, ...hit })).sort((a, b) => b.reads + b.writes - (a.reads + a.writes)),
      resets: m.resets,
      lastReset: m.lastReset,
      backupKept: false,
      power: { mode: m.sleepMode ? (m.sleepMode === "idle" || m.sleepMode === "adc-noise" ? "sleep" : "stop") : "run", asleep, current, regulator: "main" },
      clock: { source: "HSI", pllSource: "HSI", sysclk: m.hz, hse: null, lse: null, problems: problem ? [problem] : [] },
      debug: null,
      host: "in-process",
      labels: {
        clock: m.clockLabel(),
        power: m.sleepMode ? SLEEP_LABEL[m.sleepMode] : "active",
        reset: m.lastReset ? RESET_LABEL[m.lastReset] : undefined,
        fuses: `L:${hex(m.fuses.low)} H:${hex(m.fuses.high)} E:${hex(m.fuses.extended)}${m.fuses.lock !== 0xff ? ` lock:${hex(m.fuses.lock)}` : ""}`,
        noClock: problem?.includes("erratum")
          ? "the errata give no work-around — program the fuses for another clock source"
          : "wire a crystal (with its two load capacitors) across XTAL1/XTAL2, drive XTAL1 from an oscillator, or program the fuses for the internal RC oscillator",
      },
    }
  }

  capturePanel(_panel: PanelWiring) {
    return { frame: null, status: "no display controller on this MCU" }
  }
  dropPanel() {}
  /** The debugger speaks ARM (registers, DWARF for Cortex-M): not available for AVR yet. */
  debug(cmd: CoreDebugCommand) {
    // The editor sends its (often empty) breakpoint list and fault catch with every load: only a real request is a gap.
    const asked = cmd.op === "breakpoints" ? cmd.list.some((b) => b.enabled) : cmd.op === "step" || cmd.op === "resume"
    if (asked) this.mcu.feature("Debugger (breakpoints, stepping) on AVR")
  }
  readonly debugStop: DebugStop | null = null
  inspect(req: InspectRequest): Promise<InspectReply> {
    const data = this.mcu.cpu.data
    const memory = (req.ranges ?? []).map((r) => {
      const bytes = new Uint8Array(r.size)
      const invalid: [number, number][] = []
      for (let i = 0; i < r.size; i++) {
        const a = r.addr + i
        if (a < data.length) bytes[i] = data[a]
        else invalid.push([a, a + 1])
      }
      return { addr: r.addr, bytes, invalid }
    })
    return Promise.resolve({ regs: null, memory, stop: null, time: this.mcu.time, halted: this.mcu.cpu.halted?.message ?? null })
  }
  dispose() {}
}
