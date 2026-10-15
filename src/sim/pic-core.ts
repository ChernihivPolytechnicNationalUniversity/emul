/**
 * A PIC16F62x as the simulation loop sees any core (`CoreHost`): run to a time, read the pads,
 * take the circuit's levels and voltages, report status. It runs in the loop's own thread, as
 * the AVR does: a 5 MIPS 8-bit core is a small share of a CPU thread.
 *
 * The part keeps its own power-on and brown-out logic and its MCLR input (the loop passes the
 * voltage on MCLR/VPP, which can also be the 13 V that enters Program/Verify mode); OSC1/OSC2
 * (RA7/RA6) take the place of HSE and T1OSI/T1OSO (RB7/RB6) of LSE.
 */
import { CpuHalt } from "@/mcu/faults"
import { fosc, type PicProfile } from "@/mcu/pic/chip"
import type { PicMcu } from "@/mcu/pic/mcu"
import { createPic } from "@/mcu/pic/parts"
import type { PadDrive } from "@/mcu/periph/gpio"
import type { ClockSource } from "@/mcu/periph/rcc"
import type { PadRef } from "@/mcu/pads"
import type { CoreDebugCommand, DebugStop, InspectReply, InspectRequest } from "@/debug/protocol"
import type { CoreHost, CoreStatus, OutEdge, PanelWiring } from "./core-host"

const RESET_LABEL = { "power-on": "power-on", "brown-out": "brown-out", mclr: "MCLR", "mclr-sleep": "MCLR in Sleep", wdt: "watchdog" } as const
const hex4 = (v: number) => v.toString(16).toUpperCase().padStart(4, "0")

export class PicCore implements CoreHost {
  readonly mcu: PicMcu
  readonly chip: PicProfile
  readonly sync = false
  readonly ready = true
  boot0 = false
  /** MCLR is read by the part itself (MCLRE, the HV detect): the loop never holds it in reset by that pin. */
  readonly resetPin = false
  private edges: OutEdge[] = []
  private meter = { cycles: 0, sleep: 0 }
  private statusMeter = { cycles: 0, sleep: 0 }
  private stepIdd: number | null = null

  constructor(chip: PicProfile) {
    this.chip = chip
    this.mcu = createPic(chip)
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
  get porThreshold() {
    return this.chip.electrical.por
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
  /** The configuration word from the component's field (hex), over the image's 2007h; a change reprograms the part. */
  configure(props: Record<string, string>) {
    const v = props.config?.trim()
    if (!v) return
    const n = parseInt(v.replace(/^0x/i, ""), 16)
    if (!Number.isInteger(n) || n < 0 || n > 0x3fff || n === this.mcu.config) return
    this.mcu.config = n
    if (this.loaded) this.mcu.powerOn()
  }
  reset() {
    this.mcu.powerOn()
    this.meter = { cycles: 0, sleep: 0 }
    this.statusMeter = { cycles: 0, sleep: 0 }
  }
  runOnBattery() {}
  halt(reason: string) {
    this.mcu.cpu.halted = new CpuHalt("fault", reason, this.mcu.cpu.pc)
  }
  /** OSC1/OSC2 (RA7/RA6) as HSE; T1OSI/T1OSO (RB7/RB6) as LSE. */
  setClockSources(hse: ClockSource | null, lse: ClockSource | null) {
    const feed = hse ? { hz: hse.hz, kind: hse.kind === "clock" ? ("clock" as const) : ("crystal" as const) } : null
    const now = this.mcu.clockFeed
    if (now?.kind !== "rc" && (now?.hz !== feed?.hz || now?.kind !== feed?.kind)) this.mcu.setClockFeed(feed)
    const t1 = lse ? { hz: lse.hz, kind: lse.kind === "clock" ? ("clock" as const) : ("crystal" as const), startup: lse.startup ?? 0 } : null
    const was = this.mcu.timer1.oscillator
    if (was?.hz !== t1?.hz || was?.kind !== t1?.kind) this.mcu.setT1Oscillator(t1)
  }
  /** The RC/ER network on RA7/OSC1 (FOSC = 11x), as the loop finds it in the circuit. */
  setRcNetwork(hz: number | null, erOhms: number | null) {
    if (this.chip.rcKind === "ER") {
      if (erOhms !== this.mcu.erOhms) this.mcu.setErResistor(erOhms)
      return
    }
    const now = this.mcu.clockFeed
    if (hz === null) {
      if (now?.kind === "rc") this.mcu.setClockFeed(null)
    } else if (now?.kind !== "rc" || now.hz !== hz) this.mcu.setClockFeed({ hz, kind: "rc" })
  }
  setResetVoltage(volts: number) {
    if (volts !== this.mcu.mclrVoltage) this.mcu.setMclrVoltage(volts)
  }
  inputThresholds(pad: PadRef, vdd: number) {
    return this.mcu.inputThresholds(pad, vdd)
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
    this.mcu.setAnalog(pad, volts)
  }
  setAnalogSource() {}
  setSupply(volts: number) {
    if (volts !== this.mcu.vdd) this.mcu.setSupply(volts)
  }
  setBattery() {}
  setReference() {}

  runUntil(end: number) {
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
  peekDuty(pad: PadRef, interval: number) {
    return this.mcu.peekDuty(pad, interval)
  }
  drainEdges() {
    this.collect()
    const out = this.edges
    this.edges = []
    return out
  }

  private current(meter: { cycles: number; sleep: number }): { current: number; asleep: number } {
    const cpu = this.mcu.cpu
    const cycles = cpu.cycles - meter.cycles
    const asleep = cycles > 0 ? Math.min(1, Math.max(0, (cpu.sleepCycles - meter.sleep) / cycles)) : cpu.sleeping ? 1 : 0
    meter.cycles = cpu.cycles
    meter.sleep = cpu.sleepCycles
    return { current: this.mcu.supplyCurrent(asleep), asleep }
  }
  supplyCurrent() {
    if (this.stepIdd !== null) {
      const v = this.stepIdd
      this.stepIdd = null
      return v
    }
    return this.current(this.meter).current
  }

  status(): CoreStatus {
    const m = this.mcu
    const { current, asleep } = this.current(this.statusMeter)
    const problem = m.clockProblem()
    return {
      running: m.running,
      halted: m.cpu.halted?.message ?? null,
      time: m.time,
      pc: m.cpu.pc,
      instructions: m.cpu.instructions,
      sysclk: m.firmware && !problem ? m.fosc : 0,
      faults: [],
      unmodelled: [...m.unmodelled].map(([block, hit]) => ({ block, ...hit })).sort((a, b) => b.reads + b.writes - (a.reads + a.writes)),
      resets: m.resets,
      lastReset: m.lastReset,
      backupKept: false,
      power: { mode: m.cpu.sleeping ? "stop" : "run", asleep, current, regulator: "main" },
      clock: { source: "HSI", pllSource: "HSI", sysclk: m.fosc, hse: null, lse: null, problems: problem ? [problem] : [] },
      debug: null,
      host: "in-process",
      labels: {
        clock: m.clockLabel(),
        power: m.programmingMode ? "Program/Verify mode" : m.cpu.sleeping ? "Sleep" : m.inReset ? "in reset" : "active",
        reset: m.lastReset ? RESET_LABEL[m.lastReset] : undefined,
        fuses: `config ${hex4(m.config)} (FOSC ${fosc(m.config).toString(2).padStart(3, "0")})`,
        noClock: "wire a crystal or resonator (with its load capacitors) across RA7/OSC1 and RA6/OSC2, drive OSC1 from an oscillator, or set FOSC in the configuration word to the internal oscillator",
      },
    }
  }

  capturePanel(_panel: PanelWiring) {
    return { frame: null, status: "no display controller on this MCU" }
  }
  dropPanel() {}
  debug(cmd: CoreDebugCommand) {
    const asked = cmd.op === "breakpoints" ? cmd.list.some((b) => b.enabled) : cmd.op === "step" || cmd.op === "resume"
    if (asked) this.mcu.feature("Debugger (breakpoints, stepping) on PIC")
  }
  readonly debugStop: DebugStop | null = null
  /** Data memory as file addresses 000h–1FFh, read without side effects. */
  inspect(req: InspectRequest): Promise<InspectReply> {
    const memory = (req.ranges ?? []).map((r) => {
      const bytes = new Uint8Array(r.size)
      const invalid: [number, number][] = []
      for (let i = 0; i < r.size; i++) {
        const a = r.addr + i
        if (a < 0x200) bytes[i] = this.mcu.peekFile(a)
        else invalid.push([a, a + 1])
      }
      return { addr: r.addr, bytes, invalid }
    })
    return Promise.resolve({ regs: null, memory, stop: null, time: this.mcu.time, halted: this.mcu.cpu.halted?.message ?? null })
  }
  dispose() {}
}
