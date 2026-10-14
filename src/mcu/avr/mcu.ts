/**
 * An AVR microcontroller assembled from a chip profile: the core, the I/O ports, the system
 * control registers and the peripheral blocks, with the clock system, resets, sleep modes and
 * fuses of the data sheet (DS40002061B §9 clock, §10 power management, §11 reset, §27–28
 * boot loader and fuses). The simulation loop drives it the way it drives an STM32: run to
 * a time, read what the pads drive, report what the circuit puts on them.
 */
import { CpuHalt, emulatorError } from "../faults"
import { EM_AVR, parseFirmware, type Firmware } from "../elf"
import type { PadDrive } from "../periph/gpio"
import type { PadRef } from "../pads"
import { AvrCpu, type AvrSystem } from "./cpu"
import type { AvrProfile } from "./chip"
import { Interrupts, type AvrBus, type Peripheral, type RegisterHooks } from "./io"
import { Port } from "./port"
import { SREG, SREG_I } from "./sreg"

export type AvrResetCause = "power-on" | "external" | "brown-out" | "watchdog"

/** MCUSR flags by reset source (§11.9.1). */
const MCUSR_FLAG: Record<AvrResetCause, number> = { "power-on": 0x01, external: 0x02, "brown-out": 0x04, watchdog: 0x08 }

export type SleepMode = "idle" | "adc-noise" | "power-down" | "power-save" | "standby" | "extended-standby"
/** SMCR.SM2:0 → mode (Table 10-2); 100 and 101 are reserved. */
const SLEEP_MODES: (SleepMode | null)[] = ["idle", "adc-noise", "power-down", "power-save", null, null, "standby", "extended-standby"]

/** Clock source by CKSEL3:0 (Table 9-1). */
export type ClockKind = "low-power-crystal" | "full-swing-crystal" | "low-frequency-crystal" | "internal-128k" | "internal-rc" | "external" | "reserved"
export function clockKind(cksel: number): ClockKind {
  if (cksel >= 8) return "low-power-crystal"
  if (cksel >= 6) return "full-swing-crystal"
  if (cksel >= 4) return "low-frequency-crystal"
  return (["external", "reserved", "internal-rc", "internal-128k"] as const)[cksel]
}

/** What feeds XTAL1/XTAL2: a crystal between them or a clock into XTAL1 (from the circuit). */
export type AvrClockFeed = { hz: number; kind: "crystal" | "clock" } | null

/**
 * Start-up timing from the fuses (Tables 9-4, 9-6, 9-10, 9-12, 9-14, 9-16): oscillator
 * cycles from Power-down/Power-save, and the additional delay from reset as CK plus a
 * watchdog-oscillator time-out (Table 9-2: 0, 4.1 ms or 65 ms at VCC = 5 V). The additional
 * delay is 19 CK, not the data sheet's 14 (4 for the low-frequency crystal): Silicon Errata and
 * Data Sheet Clarification DS80000855C §3.1.1–3.1.6. With RSTDISBL programmed the 0 ms options
 * become 4 ms (same notes).
 */
export function startupTiming(cksel: number, sut: number, rstdisbl = false): { wakeCk: number; resetCk: number; timeout: number } {
  const T4 = 4.1e-3
  const T65 = 65e-3
  const kind = clockKind(cksel)
  if (kind === "low-power-crystal" || kind === "full-swing-crystal") {
    const code = ((cksel & 1) << 2) | sut
    // CKSEL0:SUT1:0 → ceramic 258 CK (000, 001), ceramic 1K CK (010, 011, 100), crystal 16K CK (101, 110, 111)
    const rows: [number, number][] = [
      [258, T4],
      [258, T65],
      [1024, 0],
      [1024, T4],
      [1024, T65],
      [16384, 0],
      [16384, T4],
      [16384, T65],
    ]
    const [wakeCk, timeout] = rows[code]
    return { wakeCk, resetCk: 19, timeout }
  }
  if (kind === "low-frequency-crystal") {
    const timeout = [0, T4, T65, 0][sut]
    return { wakeCk: cksel & 1 ? 32768 : 1024, resetCk: 19, timeout }
  }
  // Internal RC, 128 kHz and external clock: 6 CK, 19 CK + 0 / 4.1 / 65 ms (the 128 kHz table says 4 and 64 ms).
  let timeout = kind === "internal-128k" ? [0, 4e-3, 64e-3, 0][sut] : [0, T4, T65, 0][sut]
  if (rstdisbl && sut === 0) timeout = 4e-3
  return { wakeCk: 6, resetCk: 19, timeout }
}

export type AvrFuses = { low: number; high: number; extended: number; lock: number }

export class AvrMcu implements AvrBus, AvrSystem {
  readonly chip: AvrProfile
  readonly cpu: AvrCpu
  readonly irq: Interrupts
  readonly ports: Port[] = []
  /** Ports by PadRef port index (A = 0, B = 1, …). */
  private readonly portByIndex: (Port | undefined)[] = []
  readonly peripherals: Peripheral[] = []
  readonly eeprom: Uint8Array
  fuses: AvrFuses
  firmware: Firmware | null = null
  firmwareName = ""

  /** Simulated time at the start of the current slice, s, and the core cycle it began at. */
  time = 0
  private sliceCycle = 0
  private sliceTime = 0
  /** Undivided clock source frequency, Hz, and the CLKPR division. */
  private sourceHz = 8e6
  private division = 1
  clockFeed: AvrClockFeed = null
  /** The core is held in reset until this time (start-up delay, RESET pin low). */
  private resetUntil = 0
  private resetPinLow = false
  resets = 0
  lastReset: AvrResetCause | null = null

  // System control registers.
  private mcusr = 0
  private mcucr = 0
  private smcr = 0
  private prr = 0
  private clkpr = 0
  private osccal: number
  private spmcsr = 0
  private spmArmedUntil = -1
  /** Page erase/write in progress until this time (s); SPMEN reads one meanwhile. */
  private spmBusyUntil = 0
  /** SPMCSR as the core sees it now. */
  get spmcsrValue(): number {
    let v = this.spmcsr
    const busy = this.now < this.spmBusyUntil
    if (!busy && this.cpu.at >= this.spmArmedUntil) v &= ~0x3f
    if (busy) v |= 0x01
    return v
  }
  get mcusrValue() {
    return this.mcusr
  }
  /** SPM finished at once (buffer fill, RWW enable): SPMEN and the operation bits clear. */
  spmDone(rwwReady = false) {
    this.spmcsr &= ~0x3f
    if (rwwReady) this.spmcsr &= ~0x40
    this.spmArmedUntil = -1
  }
  /** A page erase/write started; RWWSB stays set until RWWSRE when the RWW section is the one programmed. */
  spmStarted(until: number, rww: boolean) {
    this.spmBusyUntil = until
    this.spmcsr = (this.spmcsr & ~0x3f) | (rww ? 0x40 : 0)
    this.spmArmedUntil = -1
  }
  /** A page erase or write is in progress (blocks EEPROM writes, §8.6.3). */
  get selfProgramming() {
    return this.now < this.spmBusyUntil
  }
  /** Total page erase/write time so far, s. */
  get selfProgramBusyTime() {
    return (this.peripherals.find((p) => p.name === "SPM") as unknown as { busyTime: number } | undefined)?.busyTime ?? 0
  }
  /** Cycles until which a timed-sequence enable bit stays open (CLKPCE, IVCE, BODSE). */
  private clkpceUntil = -1
  private ivceUntil = -1
  private bodseUntil = -1
  private bodsUntil = -1
  sleepMode: SleepMode | null = null

  /** AVCC/VCC, V, as the circuit supplies it. */
  vcc = 5
  /** Voltage on the AREF pin, V, or null when nothing drives it. */
  aref: number | null = null
  /** Die temperature, °C (the temperature sensor channel). */
  temperature = 25
  /** The voltage on a pad as the circuit last solved it; null when the pad is not part of the circuit. */
  analogRead: (pad: PadRef) => number | null = (pad) => {
    const d = this.padDrive(pad)
    return d === "high" || d === "pullup" ? this.vcc : d === "low" ? 0 : null
  }
  /** Blocks that compare analog levels continuously (the comparator) re-evaluate when the circuit's voltages change. */
  readonly analogListeners: (() => void)[] = []
  /**
   * The supply changed. Below the power-on threshold the part is in power-on reset (VPOT,
   * Table 29-11: 1.4 V rising, 1.3 V falling); with BODLEVEL programmed, below VBOT − VHYST/2
   * it is in brown-out reset until VCC climbs above VBOT + VHYST/2, then the time-out runs
   * (§11.3, §11.5, Tables 29-11/29-12).
   */
  setSupply(volts: number) {
    const was = this.vcc
    this.vcc = volts
    const e = this.chip.electrical
    if (this.porHeld) {
      if (volts >= e.por.rising) {
        this.porHeld = false
        this.reset("power-on")
      }
    } else if (volts < e.por.falling) {
      this.porHeld = true
      for (const p of this.ports) p.reset()
    } else {
      const vbot = e.bod[this.fuses.extended & 7]
      if (vbot !== undefined) {
        if (!this.bodHeld && volts < vbot - e.bodHysteresis / 2) {
          this.bodHeld = true
          this.mcusr |= MCUSR_FLAG["brown-out"]
          for (const p of this.ports) p.reset()
        } else if (this.bodHeld && volts > vbot + e.bodHysteresis / 2) {
          this.bodHeld = false
          const t = this.time
          this.reset("brown-out")
          const st = startupTiming(this.fuses.low & 0x0f, (this.fuses.low >> 4) & 3, !(this.fuses.high & 0x80))
          this.resetUntil = t + st.timeout + st.resetCk / this.sourceHz
        }
      }
    }
    if (volts !== was) this.analogChanged()
  }
  /** Held in power-on reset (VCC below VPOT) or brown-out reset. */
  private porHeld = false
  private bodHeld = false
  setReference(volts: number | null) {
    this.aref = volts
  }
  analogChanged() {
    for (const f of this.analogListeners) f()
  }

  /** Edges on watched pads, stamped with their exact time (the digital fast path out). */
  readonly digitalOut: { pad: PadRef; level: boolean | null; time: number }[] = []
  readonly digitalWatch = new Set<number>()
  yieldOnOutput = false
  /** I/O addresses no block answers at, by block name: what the firmware touched that is not modelled. */
  readonly unmodelled = new Map<string, { reads: number; writes: number }>()
  private readonly blockOf: Map<number, string>
  /** A watchdog or brown-out asked for a reset; the run loop performs it at the end of the instruction. */
  private resetRequest: AvrResetCause | null = null

  constructor(chip: AvrProfile, blocks: Map<number, string> = new Map()) {
    this.chip = chip
    this.blockOf = blocks
    this.cpu = new AvrCpu(chip.flashBytes, chip.ramEnd, this)
    this.irq = new Interrupts(this.cpu)
    this.eeprom = new Uint8Array(chip.eepromBytes).fill(0xff)
    this.fuses = { ...chip.factoryFuses }
    this.osccal = chip.osccal
    for (let a = 0x20; a < 0x100; a++) {
      this.cpu.ioRead[a] = (x) => this.unhandled(x, false)
      this.cpu.ioWrite[a] = (x) => {
        this.unhandled(x, true)
      }
    }
    this.cpu.ioRead[SREG] = (x) => this.cpu.data[x]
    this.cpu.ioWrite[SREG] = (x, v) => {
      this.cpu.data[x] = v
    }
    for (const a of [0x5d, 0x5e]) {
      this.cpu.ioRead[a] = (x) => this.cpu.data[x]
      this.cpu.ioWrite[a] = (x, v) => {
        this.cpu.data[x] = v
      }
    }
    for (const spec of chip.ports) {
      const index = spec.letter.charCodeAt(0) - 65
      const port = new Port(spec.letter, index, spec.mask)
      this.ports.push(port)
      this.portByIndex[index] = port
      port.onDrive = (pin, drive, cycle) => this.padChanged(index, pin, drive, cycle)
      port.onInput = (pin, level, cycle) => {
        for (const l of this.inputListeners) l(index, pin, level, cycle)
      }
      this.register(spec.pin, { name: `PIN${spec.letter}`, read: () => port.readPin(this.cpu.at), write: (v, m) => port.writePin(v, m, this.cpu.at) })
      this.register(spec.pin + 1, { name: `DDR${spec.letter}`, read: () => port.ddr, write: (v) => port.writeDdr(v, this.cpu.at) })
      this.register(spec.pin + 2, { name: `PORT${spec.letter}`, read: () => port.port, write: (v) => port.writePort(v, this.cpu.at) })
    }
    this.systemRegisters()
    this.reset("power-on")
  }

  // --- AvrBus ------------------------------------------------------------------------------

  get hz(): number {
    return this.sourceHz / this.division
  }
  register(addr: number, hooks: RegisterHooks) {
    const { read, write } = hooks
    this.cpu.ioRead[addr] = read ? () => read() & 0xff : () => 0
    this.cpu.ioWrite[addr] = write ? (_a, v, m) => write(v, m) : () => {}
    this.names.set(addr, hooks.name)
  }
  /** Blocks that listen to pin inputs (DI): port index, pin, level, cycle of the change (fractional for outside edges). */
  readonly inputListeners: ((port: number, pin: number, level: boolean, cycle: number) => void)[] = []
  /** Port by its letter. */
  port(letter: string): Port {
    return this.ports.find((p) => p.letter === letter)!
  }
  /** Whether the I/O clock runs (not in a sleep mode deeper than Idle). */
  get ioClock(): boolean {
    return this.sleepMode === null || this.sleepMode === "idle"
  }
  /** Register names by address, for the inspector. */
  readonly names = new Map<number, string>()
  reschedule() {
    let due = Infinity
    for (const p of this.peripherals) if (p.due < due) due = p.due
    this.cpu.nextEventCycle = due
  }
  pinsChanged() {
    this.pinsChangedAt(this.cpu.at + 1)
  }
  /** Re-evaluate every pin's overrides; changes take effect at `cycle` (a timer tick's edge). */
  pinsChangedAt(cycle: number) {
    for (const p of this.ports) p.refresh(cycle)
  }
  powerReduced(bit: number): boolean {
    return (this.prr & (1 << bit)) !== 0
  }

  /** Add a block: it hooks its registers and interrupt sources in its constructor. */
  attach<T extends Peripheral>(p: T): T {
    this.peripherals.push(p)
    return p
  }

  /** A modelled block was put in a mode the emulator does not model: reported with the unmodelled blocks. */
  feature(what: string) {
    const hit = this.unmodelled.get(what) ?? { reads: 0, writes: 0 }
    hit.writes++
    this.unmodelled.set(what, hit)
  }

  private unhandled(addr: number, write: boolean): number {
    const name = this.blockOf.get(addr) ?? `I/O 0x${addr.toString(16).padStart(2, "0")}`
    const hit = this.unmodelled.get(name) ?? { reads: 0, writes: 0 }
    if (write) hit.writes++
    else hit.reads++
    this.unmodelled.set(name, hit)
    return 0
  }

  // --- system control registers -------------------------------------------------------------

  private systemRegisters() {
    // GPIOR0–2 are plain storage (§8.6.4).
    for (const [addr, name] of [
      [0x3e, "GPIOR0"],
      [0x4a, "GPIOR1"],
      [0x4b, "GPIOR2"],
    ] as const) {
      this.register(addr, {
        name,
        read: () => this.cpu.data[addr],
        write: (v, m) => {
          this.cpu.data[addr] = (this.cpu.data[addr] & ~m) | (v & m)
        },
      })
    }
    // MCUSR: flags cleared by writing zero (§11.9.1).
    this.register(0x54, { name: "MCUSR", read: () => this.mcusr, write: (v, m) => (this.mcusr = (this.mcusr & ~m) | (v & m & 0x0f)) })
    this.register(0x53, { name: "SMCR", read: () => this.smcr, write: (v, m) => (this.smcr = ((this.smcr & ~m) | (v & m)) & 0x0f) })
    this.register(0x55, { name: "MCUCR", read: () => this.mcucr | (this.cpu.at < this.bodsUntil ? 0x40 : 0), write: (v, m) => this.writeMcucr((this.mcucr & ~m) | (v & m)) })
    this.register(0x64, { name: "PRR", read: () => this.prr, write: (v, m) => this.writePrr(((this.prr & ~m) | (v & m)) & 0xef) })
    this.register(0x61, { name: "CLKPR", read: () => this.clkpr | (this.cpu.at < this.clkpceUntil ? 0x80 : 0), write: (v) => this.writeClkpr(v) })
    this.register(0x66, { name: "OSCCAL", read: () => this.osccal, write: (v) => this.writeOsccal(v) })
    this.register(0x57, {
      name: "SPMCSR",
      read: () => this.spmcsrValue,
      write: (v) => {
        // RWWSB is read-only; SPMEN with the operation bits stays armed for four cycles (§27.9.1).
        this.spmcsr = (v & 0xbf) | (this.spmcsr & 0x40)
        this.spmArmedUntil = this.cpu.at + 4
      },
    })
  }

  /** IVSEL/IVCE and BODS/BODSE timed sequences, PUD (§10.11.2, §12.5). */
  private writeMcucr(v: number) {
    const at = this.cpu.at
    // IVCE: writing it one opens a four-cycle window; IVSEL changes only inside it with IVCE written zero.
    if (v & 0x01) {
      this.ivceUntil = at + 4
      v &= ~0x02 | (this.mcucr & 0x02)
    } else if (at < this.ivceUntil) {
      this.ivceUntil = -1
    } else v = (v & ~0x02) | (this.mcucr & 0x02)
    // BODS: write BODS and BODSE one, then within four cycles BODS one and BODSE zero; BODS reads back for three cycles.
    if ((v & 0x60) === 0x60) {
      this.bodseUntil = at + 4
      v &= ~0x40
    } else if (v & 0x40 && at < this.bodseUntil) {
      this.bodsUntil = at + 3
      this.bodseUntil = -1
    }
    this.mcucr = (v & 0x33) | (at < this.bodseUntil ? 0x20 : 0)
    this.cpu.vectorBase = this.mcucr & 0x02 ? this.bootStart : 0
    const pud = (this.mcucr & 0x10) !== 0
    for (const p of this.ports) if (p.pud !== pud) {
      p.pud = pud
      p.refresh(at + 1)
    }
  }

  private writePrr(v: number) {
    const at = this.cpu.at
    const changed = v ^ this.prr
    this.prr = v
    if (changed) for (const p of this.peripherals) p.setClockRunning(this.domainRunning(p), at)
  }

  /** CLKPCE opens a four-cycle window for CLKPS (§9.12.2, Table 9-17). */
  private writeClkpr(v: number) {
    const at = this.cpu.at
    if (v === 0x80) {
      if (at >= this.clkpceUntil) this.clkpceUntil = at + 4
      return
    }
    if (v & 0x80 || at >= this.clkpceUntil) return
    this.clkpceUntil = -1
    const cs = v & 0x0f
    if (cs > 8) return // reserved
    this.clkpr = cs
    this.setDivision(1 << cs)
  }

  private writeOsccal(v: number) {
    this.osccal = v & 0xff
    if (clockKind(this.fuses.low & 0x0f) === "internal-rc") this.setSource(this.rcHz())
  }

  /**
   * Calibrated RC frequency for an OSCCAL value. The factory value gives 8.0 MHz; the data sheet
   * gives the tuning range only as graphs (§35.10), so the slope here is linear across each
   * half (CAL7 picks the range, CAL6:0 tunes it) — accurate at the factory value.
   */
  private rcHz(): number {
    const f = 8e6
    const step = this.osccal - this.chip.osccal
    return f * (1 + step * 0.004)
  }

  // --- clock --------------------------------------------------------------------------------

  /** The undivided source the fuses select, as the circuit feeds it (null: nothing oscillates). */
  private sourceFromFuses(): number | null {
    const kind = clockKind(this.fuses.low & 0x0f)
    switch (kind) {
      case "internal-rc":
        return this.rcHz()
      case "internal-128k":
        return 128e3
      case "external":
        return this.clockFeed?.kind === "clock" ? this.clockFeed.hz : null
      case "reserved":
        return null
      default:
        // Crystal oscillators need a crystal (or resonator) across XTAL1/XTAL2; an external clock on XTAL1 also drives the amplifier.
        return this.clockFeed ? this.clockFeed.hz : null
    }
  }
  /** Why the core does not run, when the selected clock source gets nothing from the circuit. */
  clockProblem(): string | null {
    const kind = clockKind(this.fuses.low & 0x0f)
    if (this.sourceFromFuses() !== null) return null
    if (kind === "reserved") return "CKSEL selects a reserved clock option"
    if (kind === "external") return "fuses select an external clock on XTAL1, and nothing drives it"
    return `fuses select a ${kind.replace(/-/g, " ")} oscillator, and there is no crystal on XTAL1/XTAL2`
  }
  setClockFeed(feed: AvrClockFeed) {
    this.clockFeed = feed
    const hz = this.sourceFromFuses()
    if (hz !== null) this.setSource(hz)
  }

  private setSource(hz: number) {
    if (hz === this.sourceHz) return
    this.rebase()
    this.sourceHz = hz
    this.clockMoved()
  }
  private setDivision(d: number) {
    if (d === this.division) return
    this.rebase()
    this.division = d
    this.clockMoved()
  }
  /** Close the current slice at the present cycle, so time keeps counting at the old rate up to here. */
  private rebase() {
    this.time = this.cycleTime(this.cpu.cycles)
    this.sliceTime = this.time
    this.sliceCycle = this.cpu.cycles
  }
  private clockMoved() {
    for (const p of this.peripherals) p.clockChanged(this.cpu.cycles)
    this.reschedule()
    this.cpu.stop = true
  }

  /** Simulated time of a core cycle in the current slice. */
  cycleTime(cycle: number): number {
    return this.sliceTime + (cycle - this.sliceCycle) / this.hz
  }
  /** Core cycle of a simulated time. */
  timeCycle(t: number): number {
    return this.sliceCycle + (t - this.sliceTime) * this.hz
  }
  get now(): number {
    return this.cycleTime(this.cpu.cycles)
  }

  // --- reset ----------------------------------------------------------------------------------

  get bootStart(): number {
    return this.chip.bootStart[(this.fuses.high >> 1) & 3]
  }

  /**
   * A reset source went active and inactive again: I/O registers to their initial values,
   * MCUSR records the source (power-on clears the others), and the core waits out the
   * start-up delay from the fuses before the first instruction.
   */
  reset(cause: AvrResetCause = "power-on") {
    this.resets = cause === "power-on" ? 0 : this.resets + 1
    this.lastReset = cause
    this.mcusr = cause === "power-on" ? MCUSR_FLAG["power-on"] : this.mcusr | MCUSR_FLAG[cause]
    this.mcucr = 0
    this.smcr = 0
    this.prr = 0
    this.spmcsr = 0
    this.osccal = this.chip.osccal
    this.clkpceUntil = this.ivceUntil = this.bodseUntil = this.bodsUntil = -1
    this.sleepMode = null
    this.resetRequest = null
    // CKDIV8 programmed (bit 7 = 0) → CLKPS = 0011 (§9.12.2).
    this.clkpr = this.fuses.low & 0x80 ? 0 : 3
    const t = this.time
    const hz = this.sourceFromFuses()
    this.sourceHz = hz ?? this.sourceHz
    this.division = 1 << this.clkpr
    const pc = this.fuses.high & 1 ? 0 : this.bootStart
    this.cpu.reset(pc)
    this.sliceCycle = 0
    this.sliceTime = t
    this.time = t
    for (const p of this.ports) p.reset()
    for (const p of this.peripherals) p.reset()
    this.reschedule()
    const { resetCk, timeout } = startupTiming(this.fuses.low & 0x0f, (this.fuses.low >> 4) & 3, !(this.fuses.high & 0x80))
    // From power-on the oscillator also needs its start-up cycles; the delay counter adds 14 CK (Table 9-4 etc.).
    const wake = cause === "power-on" ? startupTiming(this.fuses.low & 0x0f, (this.fuses.low >> 4) & 3).wakeCk : 0
    this.resetUntil = t + timeout + (resetCk + wake) / (this.sourceHz || 1)
    this.irq.update()
  }

  /** Load firmware into flash (and the .eeprom/.fuse/.lock sections an avr-gcc ELF carries). */
  load(data: ArrayBuffer, name = "") {
    const fw = parseFirmware(data, name, [EM_AVR])
    this.cpu.flash.fill(0xffff)
    for (const s of fw.segments) {
      if (s.addr < 0x800000) {
        for (let i = 0; i < s.data.length; i++) {
          const a = s.addr + i
          if (a >= this.chip.flashBytes) throw new Error(`image does not fit the ${this.chip.flashBytes / 1024} KB flash (0x${a.toString(16)})`)
          const w = a >> 1
          this.cpu.flash[w] = a & 1 ? (this.cpu.flash[w] & 0x00ff) | (s.data[i] << 8) : (this.cpu.flash[w] & 0xff00) | s.data[i]
        }
      } else if (s.addr >= 0x810000 && s.addr < 0x820000) {
        this.eeprom.set(s.data.subarray(0, this.chip.eepromBytes - (s.addr - 0x810000)), s.addr - 0x810000)
      } else if (s.addr >= 0x820000 && s.addr < 0x830000) {
        const f = [...s.data]
        if (f.length > 0) this.fuses.low = f[0]
        if (f.length > 1) this.fuses.high = f[1]
        if (f.length > 2) this.fuses.extended = f[2]
      } else if (s.addr >= 0x830000 && s.addr < 0x840000) {
        if (s.data.length) this.fuses.lock = s.data[0]
      }
    }
    this.cpu.invalidate()
    this.firmware = fw
    this.firmwareName = name
    this.time = 0
    this.reset("power-on")
  }

  /** RESET pin level (unless RSTDISBL makes it PC6): low holds the core in reset, the rising edge starts the time-out. */
  setResetPin(low: boolean) {
    if (!(this.fuses.high & 0x80)) return
    if (low === this.resetPinLow) return
    this.resetPinLow = low
    if (!low) {
      const t = this.time
      this.reset("external")
      const st = startupTiming(this.fuses.low & 0x0f, (this.fuses.low >> 4) & 3, false)
      this.resetUntil = t + st.timeout + st.resetCk / this.sourceHz
    } else for (const p of this.ports) p.reset()
  }

  /** A watchdog or brown-out reset: done at the end of the current instruction. */
  requestReset(cause: AvrResetCause) {
    this.resetRequest = cause
    this.cpu.stop = true
  }

  // --- running -------------------------------------------------------------------------------

  get running() {
    return this.firmware !== null && this.cpu.halted === null
  }
  get inReset() {
    return this.resetPinLow || this.porHeld || this.bodHeld || this.time < this.resetUntil
  }

  /** Advance until simulated time `end`. Returns false once the core has halted. */
  runUntil(end: number): boolean {
    if (!this.running) return false
    try {
      while (this.time < end) {
        if (this.resetPinLow || this.porHeld || this.bodHeld) {
          this.time = end
          break
        }
        if (this.time < this.resetUntil) {
          // Held in reset: no clock counts, nothing runs.
          const t = Math.min(end, this.resetUntil)
          this.time = t
          this.sliceTime = t
          this.sliceCycle = this.cpu.cycles
          // Blocks timed in seconds (watchdog, EEPROM) re-plan in cycles now that the clock counts again.
          if (t >= this.resetUntil) for (const p of this.peripherals) p.clockChanged(this.cpu.cycles)
          this.reschedule()
          continue
        }
        const hz = this.hz
        if (this.sourceFromFuses() === null) {
          this.time = end
          break
        }
        const cycles = Math.max(1, Math.round((end - this.time) * hz))
        const target = this.cpu.cycles + Math.min(cycles, 20000)
        this.sliceTime = this.time
        this.sliceCycle = this.cpu.cycles
        this.cpu.run(target)
        this.time = this.cycleTime(this.cpu.cycles)
        if (this.cpu.halted) return false
        if (this.resetRequest) {
          const cause = this.resetRequest
          this.reset(cause)
          continue
        }
        if (this.cpu.stop) {
          this.cpu.stop = false
          if (this.yieldOnOutput && this.digitalOut.length) return true
        }
      }
    } catch (e) {
      if (!(e instanceof CpuHalt)) this.cpu.halted = emulatorError(e, this.cpu.opPc * 2)
      return false
    }
    return true
  }

  // --- AvrSystem (what the core asks) --------------------------------------------------------

  takeInterrupt(): number {
    return this.irq.take()
  }
  sleep(): boolean {
    if (!(this.smcr & 1)) return false
    const mode = SLEEP_MODES[(this.smcr >> 1) & 7]
    if (!mode) return false
    this.enterSleep(mode)
    return true
  }
  canWake(): boolean {
    return this.irq.wakePending()
  }
  wakeCycles(): number {
    const mode = this.sleepMode
    const bod = this.bodOffInSleep && (this.fuses.extended & 7) !== 7 ? Math.ceil(60e-6 * this.hz) : 0
    this.bodOffInSleep = false
    this.leaveSleep()
    if (bod) return bod + this.wakeFor(mode)
    return this.wakeFor(mode)
  }
  private wakeFor(mode: SleepMode | null): number {
    if (mode === "power-down" || mode === "power-save") {
      const { wakeCk } = startupTiming(this.fuses.low & 0x0f, (this.fuses.low >> 4) & 3)
      return Math.ceil(wakeCk / this.division)
    }
    if (mode === "standby" || mode === "extended-standby") return 6
    return 0
  }
  watchdogReset() {
    this.watchdog?.restart()
  }
  /** Set by the watchdog block when it attaches. */
  watchdog: { restart(): void } | null = null
  spm(z: number, r1r0: number): number {
    return this.selfProgram?.(z, r1r0) ?? 0
  }
  /** Set by the self-programming block when it attaches. */
  selfProgram: ((z: number, r1r0: number) => number) | null = null
  lpm(byteAddr: number): number {
    // SPMEN with SIGRD reads the signature row, with BLBSET the fuse and lock bits (§27.8.7, §27.8.9, Table 27-5).
    const sel = this.spmcsrValue & 0x29
    if (sel === 0x21 || sel === 0x09) {
      this.spmcsr &= ~0x29
      if (sel === 0x21) return [this.chip.signature[0], this.chip.osccal, this.chip.signature[1], 0xff, this.chip.signature[2]][byteAddr & 0x1f] ?? 0
      return [this.fuses.low, this.fuses.lock, this.fuses.extended, this.fuses.high][byteAddr & 3]
    }
    const w = this.cpu.flash[(byteAddr >> 1) & this.cpu.pcMask]
    return byteAddr & 1 ? w >> 8 : w & 0xff
  }
  service() {
    const c = this.cpu.cycles
    for (const p of this.peripherals) if (p.due <= c) p.service(c)
    this.reschedule()
  }

  // --- sleep ---------------------------------------------------------------------------------

  /** Whether a block's clock runs in the current sleep mode (Table 10-1); PRR is the block's own business. */
  private domainRunning(p: Peripheral): boolean {
    return p.runsIn(this.sleepMode)
  }
  /** BOD switched off for this sleep by BODS (§10.2): the wake-up then waits ~60 µs for it to come back. */
  bodOffInSleep = false
  private enterSleep(mode: SleepMode) {
    const at = this.cpu.cycles
    this.sleepMode = mode
    this.bodOffInSleep = at < this.bodsUntil && mode !== "idle" && mode !== "adc-noise"
    for (const p of this.peripherals) p.onSleep(mode, at)
    for (const p of this.peripherals) p.setClockRunning(this.domainRunning(p), at)
    // Input buffers are clamped in Power-down, Power-save and the Standby modes (§14.2.5).
    const clamp = mode !== "idle" && mode !== "adc-noise"
    if (clamp) for (const p of this.ports) {
      p.sleepClamp = true
      p.refresh(at)
    }
  }
  private leaveSleep() {
    const at = this.cpu.cycles
    this.sleepMode = null
    for (const p of this.ports)
      if (p.sleepClamp) {
        p.sleepClamp = false
        p.refresh(at)
      }
    for (const p of this.peripherals) p.setClockRunning(this.domainRunning(p), at)
  }

  // --- pads ------------------------------------------------------------------------------------

  /** Whether a timer's waveform drives a pin (OCnx connected): its duty is averaged for the circuit. */
  dutySource: (port: number, pin: number) => boolean = () => false
  /** High-time accounting of timer-driven pads since the last `takeDuty`. */
  private readonly duty = new Map<number, { level: boolean; since: number; high: number }>()
  private trackDuty(key: number, port: number, pin: number, drive: PadDrive, cycle: number) {
    if (!this.dutySource(port, pin) || (drive !== "high" && drive !== "low")) {
      this.duty.delete(key)
      return
    }
    const t = this.cycleTime(cycle)
    const d = this.duty.get(key)
    const level = drive === "high"
    if (!d) {
      this.duty.set(key, { level, since: t, high: 0 })
      return
    }
    if (d.level) d.high += t - d.since
    d.since = t
    d.level = level
  }
  dutyPads(): IterableIterator<number> {
    return this.duty.keys()
  }
  /** Fraction of the last `interval` a timer-driven pad was high; null when no timer drives it. */
  takeDuty(p: PadRef, interval: number): number | null {
    const d = this.duty.get(p.port * 16 + p.pin)
    if (!d) return null
    const now = this.now
    if (d.level) d.high += now - d.since
    d.since = now
    const v = interval > 0 ? Math.min(1, d.high / interval) : d.level ? 1 : 0
    d.high = 0
    return v
  }

  /**
   * Typical supply current, A (Table 29-8): active and idle scale with the clock (given at 5 V,
   * taken proportional to VCC as CMOS switching current is); the deep sleep modes use the
   * Power-down and Power-save figures (3 V), with the watchdog's share when it runs.
   */
  supplyCurrent(asleep: number): number {
    const e = this.chip.electrical.idd
    const mhz = this.hz / 1e6
    const scale = this.vcc / 5
    const active = e.activePerMHz * mhz * scale
    const m = this.sleepMode
    let sleeping = e.idlePerMHz * mhz * scale
    if (m && m !== "idle" && m !== "adc-noise") {
      const wdt = this.watchdogRunning?.() ?? false
      sleeping = m === "power-save" || m === "extended-standby" ? e.powerSave : wdt ? e.powerDownWdt : e.powerDown
    }
    if (!this.running || this.inReset) return active
    return active * (1 - asleep) + sleeping * asleep
  }
  watchdogRunning: (() => boolean) | null = null

  /** The clock for the inspector: source and rate. */
  clockLabel(): string {
    const kind = clockKind(this.fuses.low & 0x0f)
    const div = this.division > 1 ? ` ÷ ${this.division}` : ""
    const src =
      kind === "internal-rc" ? "internal RC" : kind === "internal-128k" ? "internal 128 kHz" : kind === "external" ? "external clock" : this.clockFeed?.kind === "clock" ? "clock on XTAL1" : "crystal"
    return `${src}${div}`
  }

  private padChanged(port: number, pin: number, drive: PadDrive, cycle: number) {
    const key = port * 16 + pin
    this.trackDuty(key, port, pin, drive, cycle)
    if (!this.digitalWatch.has(key)) return
    const level = drive === "high" ? true : drive === "low" ? false : null
    this.digitalOut.push({ pad: { port, pin }, level, time: this.cycleTime(cycle) })
    if (this.yieldOnOutput) this.cpu.stop = true
  }
  hasPad(p: PadRef): boolean {
    const port = this.portByIndex[p.port]
    return !!port && p.pin >= 0 && p.pin < 8 && (port.mask & (1 << p.pin)) !== 0
  }
  padDrive(p: PadRef): PadDrive {
    if (!this.hasPad(p)) return null
    // Pins tri-state while a reset is active (§14.2.1); the registers already read their reset values.
    return this.portByIndex[p.port]!.drive[p.pin]
  }
  setPad(p: PadRef, level: boolean, sampledUnder?: PadDrive) {
    if (!this.hasPad(p)) return
    this.portByIndex[p.port]!.setExternal(p.pin, level, this.cpu.cycles, sampledUnder)
  }
  /** A level at an exact simulated time (now or in the past; the loop delivers in order). */
  setPadAt(p: PadRef, level: boolean, time: number) {
    if (!this.hasPad(p)) return
    const cycle = Math.min(this.cpu.cycles, this.timeCycle(time))
    this.portByIndex[p.port]!.setExternal(p.pin, level, cycle, undefined)
  }
  setWiredPads(keys: Iterable<number>) {
    const masks = new Map<number, number>()
    for (const k of keys) masks.set(k >>> 4, (masks.get(k >>> 4) ?? 0) | (1 << (k & 15)))
    for (const p of this.ports) {
      p.sensed = masks.get(p.index) ?? 0
      p.refresh(this.cpu.cycles)
    }
  }
  padVersion(): number {
    let v = 0
    for (const p of this.ports) v += p.version
    return v
  }

  /** The current I/O view of the data space, for tests and the inspector (reads have no side effects). */
  peek(addr: number): number {
    return this.cpu.data[addr]
  }
  /** Store to data space as the core would (tests). */
  poke(addr: number, v: number) {
    this.cpu.at = this.cpu.cycles
    this.cpu.write(addr, v)
  }
  /** Read data space as the core would (tests). */
  read(addr: number): number {
    this.cpu.at = this.cpu.cycles
    return this.cpu.read(addr)
  }
  get globalInterrupts() {
    return (this.cpu.data[SREG] & SREG_I) !== 0
  }
}
