/**
 * AVR Timer/Counter (8- and 16-bit), one class for Timer/Counter0, 1 and 2 of the ATmega328P
 * (DS40002061B §15, §16, §18) configured by a spec: register addresses, the waveform mode
 * table, clock select decoding, output-compare channels and pins, input capture.
 *
 * The counter is a synchronous state machine stepped by the timer clock (clkTn, a one-cycle
 * enable from the prescaler or the Tn edge detector). On each tick the comparator result for
 * the value TCNT held during the tick before decides what happens: an event belonging to a
 * value V (compare match, TOP, BOTTOM, MAX) takes place on the tick that leaves V — flags set,
 * OCnx changes, TCNT clears or turns, buffered OCR registers load (Figures 15-8…15-11, 16-12;
 * "TOP replaced by BOTTOM" for the bottom events).
 *
 * The model is lazy: it is brought up to date when its registers are touched, a pin it
 * listens to changes, or the next tick that does something comes due. Ticks between events
 * are counted arithmetically.
 */
import { Peripheral, type AvrBus } from "../io"
import type { AvrMcu } from "../mcu"
import type { PinOverride } from "../port"
import { syncEdge } from "./extint"

export type WgmKind = "normal" | "ctc" | "fast" | "pc" | "pfc"
export type Wgm = { kind: WgmKind; top: number | "ocra" | "icr"; update: "immediate" | "top" | "bottom"; tov: "max" | "top" | "bottom" } | null

/**
 * A free-running prescaler: divisor N's ticks fall on the system clock edges where the
 * prescaler's count since its last reset is a multiple of N (§17.2, §18.10). It stops with
 * the clock that drives it; a reset (PSRSYNC/PSRASY, or a system reset) restarts the count.
 */
export class Prescaler {
  /** Edge the count started from. */
  base = 0
  /** Held in reset (TSM with PSRSYNC/PSRASY set): no prescaled tick comes. */
  held = false
  private stoppedAt: number | null = null
  reset(edge: number) {
    this.base = edge
  }
  stop(edge: number) {
    if (this.stoppedAt === null) this.stoppedAt = edge
  }
  resume(edge: number) {
    if (this.stoppedAt === null) return
    this.base += edge - this.stoppedAt
    this.stoppedAt = null
  }
  /** First tick edge of divisor `n` strictly after `edge`. */
  next(n: number, edge: number): number {
    if (n === 1) return Math.floor(edge) + 1
    const k = Math.floor((edge - this.base) / n) + 1
    return this.base + k * n
  }
}

export type ClockSelect = { kind: "stop" } | { kind: "div"; n: number } | { kind: "ext"; rising: boolean }

export type TimerSpec = {
  name: string
  bits: 8 | 16
  regs: { tccrA: number; tccrB: number; tccrC?: number; tcnt: number; ocrA: number; ocrB: number; icr?: number; timsk: number; tifr: number }
  modes: Wgm[]
  /** Decode CSn2:0. */
  clock: (cs: number) => ClockSelect
  vectors: { capt?: number; compA: number; compB: number; ovf: number }
  /** OCnA, OCnB pins; Tn and ICPn pins as [port index, pin]. */
  pins: { ocA: [number, number]; ocB: [number, number]; t?: [number, number]; icp?: [number, number] }
  /** Modes in which COMnA = 01 toggles OCnA (TOP from OCRnA, or ICR1 in fast PWM). */
  toggleA: number[]
  /** PRR bit that stops this block. */
  prr: number
  /** Keeps counting in Power-save (Timer/Counter2). */
  powerSave?: boolean
  prescaler: Prescaler
  /**
   * Asynchronous operation (Timer/Counter2, §18.9): the ASSR address and the timer oscillator's
   * frequency for an EXCLK setting (null: nothing oscillates on TOSC1), and whether the TOSC pins
   * are taken by the system oscillator.
   */
  async?: { assr: number; tosc: (exclk: boolean) => number | null; conflict: () => boolean }
}

/** ASSR update-busy bits by register (§18.11.8). */
const UB = { tcnt: 0x10, ocrA: 0x08, ocrB: 0x04, tccrA: 0x02, tccrB: 0x01 } as const
type AsyncReg = keyof typeof UB

type Channel = { ocr: number; buf: number; oc: boolean }

export class TimerCounter extends Peripheral {
  readonly name: string
  readonly spec: TimerSpec
  private readonly mcu: AvrMcu
  private readonly max: number
  tccrA = 0
  tccrB = 0
  tcnt = 0
  icr = 0
  timsk = 0
  tifr = 0
  private temp = 0
  private dir = 1
  readonly ch: [Channel, Channel] = [
    { ocr: 0, buf: 0, oc: false },
    { ocr: 0, buf: 0, oc: false },
  ]
  /** All ticks at edges up to and including this one are applied. */
  private synced = 0
  /** Edge of the tick whose compare matches a TCNT write blocks. */
  private blockAt = -1
  /** The tick clock is stopped (sleep, PRR) since this edge, or running (null). */
  private clockStopped: number | null = null
  /** External clock: edges of pending ticks (from the Tn pin, after synchronizer and edge detector). */
  private readonly extTicks: number[] = []
  /** Input capture: edges at which ICR takes TCNT, with the level that triggered them. */
  private readonly captures: number[] = []
  /** Earliest edge at which a counter clock may tick (a CS write takes effect for the next cycle). */
  private enabledFrom = 0
  /** ASSR: EXCLK, AS2 (§18.11.8). */
  assr = 0
  /** Writes waiting in their temporary register for the second rising TOSC1 edge (index), or, stalled, the edges still to come. */
  private pending: { reg: AsyncReg; v: number; at: number }[] = []
  /** The latching needs clkI/O: in Power-save and ADC Noise Reduction it waits (§18.9). */
  private stalled = false
  /** Interrupt flags on their way through the synchronizer: the time they become visible, s. */
  private late: { at: number; bits: number }[] = []
  /** TOSC1 edge index of the last tick applied. */
  private lastIdx = -Infinity
  /** After a wake-up TCNT2 reads the value from before the sleep until this time, s (§18.9). */
  private frozenUntil = -1
  private frozenTcnt = 0
  private io = true
  /** TOSC1 edge index the asynchronous prescaler counts from (PSRASY). */
  asyBase = 0
  /** Flags other blocks watch (ADC auto trigger, by TIFR bit): the timer plans events for them even with interrupts off. */
  watchFlags: () => number = () => 0
  /** Called when TIFR bits rise (from 0) at a tick's edge. */
  readonly onFlags: ((bits: number, edge: number) => void)[] = []
  private raise(bits: number, edge: number) {
    const rising = bits & ~this.tifr
    this.tifr |= bits
    if (rising) for (const f of this.onFlags) f(rising, edge)
  }

  constructor(bus: AvrBus, mcu: AvrMcu, spec: TimerSpec) {
    super(bus)
    this.mcu = mcu
    this.spec = spec
    this.name = spec.name
    this.max = spec.bits === 8 ? 0xff : 0xffff
    const r = spec.regs
    const reg = (addr: number, name: string, read: () => number, write: (v: number, m: number) => void) =>
      bus.register(addr, {
        name,
        read: () => (this.reduced ? 0 : (this.sync(this.now), read())),
        write: (v, m) => {
          if (this.reduced) return
          this.sync(this.now + 1)
          write(v, m)
          this.changed()
        },
      })
    reg(r.tccrA, `TCCR${this.n}A`, () => this.temp8("tccrA") ?? this.tccrA, (v) => (this.async ? this.defer("tccrA", v & 0xf3) : (this.tccrA = v & 0xf3)))
    reg(r.tccrB, `TCCR${this.n}B`, () => this.temp8("tccrB") ?? this.tccrB, (v) => (this.async ? this.defer("tccrB", v) : this.writeB(v)))
    if (r.tccrC !== undefined) reg(r.tccrC, `TCCR${this.n}C`, () => 0, (v) => this.force(v >> 6))
    if (spec.bits === 8) {
      reg(r.tcnt, `TCNT${this.n}`, () => this.readTcnt8(), (v) => (this.async ? this.defer("tcnt", v) : this.writeTcnt(v)))
      reg(r.ocrA, `OCR${this.n}A`, () => this.temp8("ocrA") ?? this.ch[0].buf, (v) => (this.async ? this.defer("ocrA", v) : this.writeOcr(0, v)))
      reg(r.ocrB, `OCR${this.n}B`, () => this.temp8("ocrB") ?? this.ch[1].buf, (v) => (this.async ? this.defer("ocrB", v) : this.writeOcr(1, v)))
    } else {
      // 16-bit: the high byte goes through TEMP on writes; a low-byte read latches the high byte in TEMP (§16.3).
      reg(r.tcnt, `TCNT${this.n}L`, () => ((this.temp = this.tcnt >> 8), this.tcnt & 0xff), (v) => this.writeTcnt((this.temp << 8) | v))
      reg(r.tcnt + 1, `TCNT${this.n}H`, () => this.temp, (v) => (this.temp = v))
      reg(r.icr!, `ICR${this.n}L`, () => ((this.temp = this.icr >> 8), this.icr & 0xff), (v) => this.writeIcr((this.temp << 8) | v))
      reg(r.icr! + 1, `ICR${this.n}H`, () => this.temp, (v) => (this.temp = v))
      // OCR1x read straight, not through TEMP (§16.7).
      reg(r.ocrA, `OCR${this.n}AL`, () => this.ch[0].buf & 0xff, (v) => this.writeOcr(0, (this.temp << 8) | v))
      reg(r.ocrA + 1, `OCR${this.n}AH`, () => this.ch[0].buf >> 8, (v) => (this.temp = v))
      reg(r.ocrB, `OCR${this.n}BL`, () => this.ch[1].buf & 0xff, (v) => this.writeOcr(1, (this.temp << 8) | v))
      reg(r.ocrB + 1, `OCR${this.n}BH`, () => this.ch[1].buf >> 8, (v) => (this.temp = v))
    }
    reg(r.timsk, `TIMSK${this.n}`, () => this.timsk, (v) => (this.timsk = v & (spec.vectors.capt ? 0x27 : 0x07)))
    reg(r.tifr, `TIFR${this.n}`, () => this.tifr, (v, m) => (this.tifr &= ~(v & m)))
    const flag = (bit: number, vector: number | undefined) => {
      if (vector === undefined) return
      bus.irq.add({
        vector,
        pending: () => (this.tifr & this.timsk & bit) !== 0,
        acknowledge: () => {
          this.sync(this.bus.cpu.cycles)
          this.tifr &= ~bit
          // With the flag clear the timer is watched again: plan its next event, or an interrupt
          // that only the flag enables (TOV0 in Arduino's millis()) fires once and never again.
          this.plan()
        },
        wakes: () => this.runsIn(this.mcu.sleepMode),
      })
    }
    flag(0x20, spec.vectors.capt)
    flag(0x02, spec.vectors.compA)
    flag(0x04, spec.vectors.compB)
    flag(0x01, spec.vectors.ovf)
    if (spec.async)
      bus.register(spec.async.assr, {
        name: "ASSR",
        read: () => (this.sync(this.now), this.assr | this.busy()),
        write: (v, m) => this.writeAssr((this.assr & ~m) | (v & m)),
      })
    mcu.inputListeners.push((port, pin, level, cycle) => this.input(port, pin, level, cycle))
  }

  private get n() {
    return this.spec.name.slice(-1)
  }

  // --- configuration ---------------------------------------------------------------------------

  private get wgm(): number {
    const lo = this.tccrA & 3
    return this.spec.bits === 8 ? lo | ((this.tccrB >> 1) & 4) : lo | ((this.tccrB >> 1) & 0x0c)
  }
  private get mode(): Wgm {
    return this.spec.modes[this.wgm]
  }
  private get top(): number {
    const m = this.mode
    if (!m) return this.max
    return m.top === "ocra" ? this.ch[0].ocr : m.top === "icr" ? this.icr : m.top
  }
  private get clock(): ClockSelect {
    return this.spec.clock(this.tccrB & 7)
  }

  private writeB(v: number, at = this.now + 1) {
    const before = this.tccrB & 7
    // FOCnx are strobes on Timer0/2 (bits 7:6), always read as zero (§15.9.2).
    if (this.spec.regs.tccrC === undefined) {
      this.tccrB = v & 0x0f
      if (v & 0xc0) this.force(v >> 6)
    } else this.tccrB = v & 0xdf
    if ((this.tccrB & 7) !== before) {
      this.enabledFrom = at
      this.extTicks.length = 0
    }
  }
  private writeTcnt(v: number, at = this.now + 1) {
    // A CPU write has priority over the count in its cycle and blocks the compare on the next tick (§15.5.2).
    this.tcnt = v & this.max
    const next = this.nextTickAfter(at)
    this.blockAt = next === Infinity ? -1 : next
  }
  private writeOcr(c: number, v: number) {
    v &= this.max
    const m = this.mode
    // Fixed-TOP PWM modes mask the unused high bits (§16.9.4).
    if (m && typeof m.top === "number" && m.kind !== "normal") v &= m.top
    this.ch[c].buf = v
    if (!m || m.update === "immediate") this.ch[c].ocr = v
  }
  private writeIcr(v: number) {
    // ICR1 is writable only in modes that use it as TOP (§16.6).
    if (this.mode?.top === "icr") this.icr = v & this.max
  }
  /** FOCnx: a compare match on the waveform generator only, non-PWM modes (§15.5.1). */
  private force(bits: number) {
    const m = this.mode
    if (!m || (m.kind !== "normal" && m.kind !== "ctc")) return
    for (let c = 0; c < 2; c++) if (bits & (2 >> c)) this.nonPwmAction(c)
    this.bus.pinsChanged()
  }

  reset() {
    this.tccrA = this.tccrB = this.tcnt = this.icr = this.timsk = this.tifr = this.temp = 0
    this.dir = 1
    for (const c of this.ch) {
      c.ocr = c.buf = 0
      c.oc = false
    }
    this.synced = this.bus.cpu.cycles
    this.blockAt = -1
    this.enabledFrom = 0
    this.extTicks.length = 0
    this.captures.length = 0
    this.clockStopped = null
    this.assr = 0
    this.pending = []
    this.late = []
    this.stalled = false
    this.lastIdx = -Infinity
    this.frozenUntil = -1
    this.io = true
    this.asyBase = 0
    this.due = Infinity
  }

  /**
   * Timer0/1 stop with clkI/O. Timer/Counter2 on the synchronous clock also keeps counting in
   * Power-save and Extended Standby: the main clock stays on for it there (§10.6).
   */
  override runsIn(mode: string | null): boolean {
    // The timer oscillator runs in every mode but Power-down and Standby (§18.9, Table 10-1 note 2).
    if (this.async) return mode !== "power-down" && mode !== "standby"
    if (this.spec.powerSave) return mode === null || mode === "idle" || mode === "power-save" || mode === "extended-standby"
    return mode === null || mode === "idle"
  }

  override setClockRunning(running: boolean, cycle: number) {
    const io = this.mcu.ioClock
    if (io !== this.io) {
      this.io = io
      if (this.async) this.ioChanged(io, cycle)
    }
    const on = running && !this.reduced
    if (!on) {
      if (this.clockStopped === null) {
        this.sync(cycle)
        this.clockStopped = cycle
      }
    } else if (this.clockStopped !== null) {
      this.clockStopped = null
      this.synced = Math.max(this.synced, cycle)
    }
    this.changed()
  }

  // --- asynchronous operation (§18.9) ---------------------------------------------------------

  /** AS2: clocked from the timer oscillator on TOSC1. */
  get async(): boolean {
    return this.spec.async !== undefined && (this.assr & 0x20) !== 0
  }
  /** PRTIM2 shuts the timer down in synchronous mode only (§10.11.3). */
  private get reduced(): boolean {
    return this.bus.powerReduced(this.spec.prr) && !this.async
  }
  private get toscHz(): number | null {
    return this.spec.async?.tosc((this.assr & 0x40) !== 0) ?? null
  }
  /** Index of the last rising TOSC1 edge at or before a cycle (edge k at k / f, s). */
  private toscIndex(cycle: number): number {
    return Math.floor(this.mcu.cycleTime(cycle) * this.toscHz! + 1e-7)
  }
  private toscCycle(k: number): number {
    return this.mcu.timeCycle(k / this.toscHz!)
  }
  /** Index of the TOSC1 edge at a cycle that falls on one. */
  toscIndexOf(cycle: number): number {
    return Math.round(this.mcu.cycleTime(cycle) * this.toscHz!)
  }
  /** Cycle of the first rising TOSC1 edge after `cycle`, or null when the oscillator does not run. */
  nextToscEdge(cycle: number): number | null {
    if (!this.async || !this.toscHz || this.clockStopped !== null) return null
    return this.toscCycle(this.toscIndex(cycle) + 1)
  }

  private writeAssr(v: number) {
    const was = this.async
    this.sync(this.now + 1)
    this.assr = v & 0x60
    if (this.async !== was) {
      // Writes in flight are lost with the clock they wait for (the data sheet warns of corruption).
      this.pending = []
      this.late = []
      this.lastIdx = -Infinity
      this.enabledFrom = this.now + 1
      this.io = this.mcu.ioClock
      if (this.async && this.spec.async!.conflict())
        this.mcu.feature(`${this.name}: AS2 with the system clock on XTAL1/XTAL2 — TOSC1/TOSC2 are the system oscillator's pins, the timer gets no clock`)
      else if (this.async && this.toscHz && this.bus.hz <= 4 * this.toscHz)
        this.mcu.feature(`${this.name}: the CPU clock must be more than four times the timer oscillator (§18.9) — the register synchronization failing below that is not modelled`)
      if (this.async && !this.spec.async!.conflict() && this.mcu.hasErratum("2.2.1"))
        this.mcu.feature(`${this.name}: silicon erratum 2.2.1 — the 32 kHz timer oscillator is inaccurate on Rev. ${this.mcu.revision} by an amount the errata does not give; counted exactly here`)
    }
    this.changed()
  }
  /** A write into a temporary register: it reaches the timer on the second rising TOSC1 edge (§18.9). */
  private defer(reg: AsyncReg, v: number) {
    this.pending = this.pending.filter((p) => p.reg !== reg)
    if (this.toscHz) this.pending.push({ reg, v, at: this.stalled ? 2 : this.toscIndex(this.now) + 2 })
    else this.pending.push({ reg, v, at: Infinity })
  }
  private busy(): number {
    let b = 0
    for (const p of this.pending) b |= UB[p.reg]
    return b
  }
  /** OCR2x and TCCR2x read their temporary register (§18.11.8). */
  private temp8(reg: AsyncReg): number | undefined {
    const p = this.pending.find((x) => x.reg === reg)
    if (!p) return undefined
    return reg === "tccrB" ? p.v & 0x0f : p.v
  }
  private readTcnt8(): number {
    if (this.async && this.mcu.now < this.frozenUntil) return this.frozenTcnt
    return this.tcnt
  }
  private latch(p: { reg: AsyncReg; v: number }, at: number) {
    switch (p.reg) {
      case "tcnt":
        return this.writeTcnt(p.v, at)
      case "ocrA":
        return this.writeOcr(0, p.v)
      case "ocrB":
        return this.writeOcr(1, p.v)
      case "tccrA":
        this.tccrA = p.v
        return
      case "tccrB":
        return this.writeB(p.v, at)
    }
  }
  /** clkI/O stops (Power-save, ADC Noise Reduction…) or runs again. */
  private ioChanged(io: boolean, cycle: number) {
    if (!this.toscHz) return
    const k = this.toscIndex(cycle)
    if (!io) {
      this.sync(cycle)
      this.frozenTcnt = this.tcnt
      for (const p of this.pending) p.at -= k
      this.stalled = true
    } else {
      // The TCNT2 read synchronizer catches up on the next rising TOSC1 edge.
      this.frozenUntil = (k + 1) / this.toscHz
      if (this.stalled) for (const p of this.pending) p.at += k
      this.stalled = false
    }
  }
  /** Earliest pending latch or flag synchronization, as a cycle. */
  private asyncEvent(): number {
    if (!this.async) return Infinity
    let at = Infinity
    for (const f of this.late) at = Math.min(at, this.mcu.timeCycle(f.at))
    if (!this.stalled && this.toscHz && this.clockStopped === null) for (const p of this.pending) if (p.at !== Infinity) at = Math.min(at, this.toscCycle(p.at))
    return at
  }
  private runAsync(edge: number) {
    const t = this.mcu.cycleTime(edge) + 1e-12
    const due = this.late.filter((f) => f.at <= t)
    if (due.length) {
      this.late = this.late.filter((f) => f.at > t)
      for (const f of due) this.raise(f.bits, edge)
    }
    if (this.stalled || !this.toscHz || this.clockStopped !== null) return
    const now = this.toscIndex(edge)
    const ready = this.pending.filter((p) => p.at <= now)
    if (!ready.length) return
    this.pending = this.pending.filter((p) => p.at > now)
    for (const p of ready) this.latch(p, edge)
    this.bus.pinsChanged()
  }
  /** A flag from a tick: in asynchronous mode it shows a timer cycle plus three CPU cycles later (§18.9). */
  private flag(bits: number, edge: number) {
    if (!this.async) return this.raise(bits, edge)
    const k = Math.round(this.mcu.cycleTime(edge) * this.toscHz!)
    this.late.push({ at: (k + 1) / this.toscHz! + 3 / this.bus.hz, bits })
  }
  /** The compare is off while TCNT2 or OCR2x is being written (§18.9). */
  private get compareOff(): boolean {
    return this.async && this.pending.some((p) => p.reg === "tcnt" || p.reg === "ocrA" || p.reg === "ocrB")
  }

  // --- the tick -------------------------------------------------------------------------------

  /** Edge of the first tick after `edge`, or Infinity when nothing clocks the counter. */
  private nextTickAfter(edge: number): number {
    if (this.clockStopped !== null) return Infinity
    const cs = this.clock
    const from = Math.max(edge, this.enabledFrom)
    if (this.async) {
      if (!this.toscHz || cs.kind !== "div" || (this.spec.prescaler.held && cs.n > 1)) return Infinity
      const kMin = Math.max(this.toscIndex(from), this.lastIdx) + 1
      let k = kMin
      if (cs.n > 1) {
        const kb = this.asyBase
        k = kb + Math.ceil((kMin - kb) / cs.n) * cs.n
      }
      return this.toscCycle(k)
    }
    if (cs.kind === "div") return this.spec.prescaler.held && cs.n > 1 ? Infinity : this.spec.prescaler.next(cs.n, from)
    if (cs.kind === "ext") return this.extTicks.find((e) => e > edge) ?? Infinity
    return Infinity
  }

  /** Apply every tick at an edge ≤ `edge`, and captures (and asynchronous latches and flags) up to it. */
  override sync(edge: number) {
    edge = Math.floor(edge)
    while (this.synced < edge) {
      const tick = this.nextTickAfter(this.synced)
      const capture = this.captures.length ? this.captures[0] : Infinity
      const other = this.asyncEvent()
      const next = Math.min(tick, capture, other)
      // Asynchronous edges are fractional cycles: one within rounding of `edge` belongs to it.
      if (next > edge + 1e-6) {
        this.synced = edge
        break
      }
      if (other < tick && other <= capture) {
        this.runAsync(other)
        this.synced = Math.max(this.synced, other)
        continue
      }
      if (capture <= tick) {
        this.captures.shift()
        this.icr = this.tcnt
        this.raise(0x20, capture)
        if (capture < tick) {
          this.synced = capture
          continue
        }
      }
      // Run of ticks with nothing happening: jump over them in one go.
      const free = this.quietTicks()
      const cs = this.clock
      if (free > 1 && cs.kind === "div" && this.blockAt < tick) {
        if (this.async) {
          const idx = Math.round(this.mcu.cycleTime(tick) * this.toscHz!)
          const limit = this.toscIndex(Math.min(edge, other - 0.5, capture - 1))
          const k = Math.min(Math.floor((limit - idx) / cs.n) + 1, free - 1)
          if (k > 0) {
            this.tcnt = (this.tcnt + this.dir * k) & this.max
            this.lastIdx = idx + (k - 1) * cs.n
            this.synced = Math.max(this.synced, this.toscCycle(this.lastIdx))
            continue
          }
        } else {
          const step = cs.n
          const last = Math.min(edge, tick + (free - 2) * step, capture - 1)
          const k = Math.floor((last - tick) / step) + 1
          if (k > 0 && k < free) {
            this.tcnt = (this.tcnt + this.dir * k) & this.max
            this.synced = tick + (k - 1) * step
            continue
          }
        }
      }
      this.tick(tick)
      this.synced = tick
      if (this.async) {
        this.lastIdx = Math.round(this.mcu.cycleTime(tick) * this.toscHz!)
        if (other <= tick) this.runAsync(tick)
      }
      if (cs.kind === "ext") {
        const i = this.extTicks.indexOf(tick)
        if (i >= 0) this.extTicks.splice(i, 1)
      }
    }
  }

  /** Ticks from now until (and including) the next one that does something. */
  private quietTicks(): number {
    const v = this.tcnt
    const m = this.mode
    const cands = [this.ch[0].ocr, this.ch[1].ocr, this.top, 0, this.max]
    let best = Infinity
    for (const c of cands) {
      const d = this.dir > 0 || !m || (m.kind !== "pc" && m.kind !== "pfc") ? (c - v + this.max + 1) & this.max : (v - c + this.max + 1) & this.max
      if (d < best) best = d
    }
    return best + 1
  }

  private tick(edge: number) {
    const m = this.mode
    const v = this.tcnt
    const written = edge === this.blockAt
    if (written) this.blockAt = -1
    const blocked = written || this.compareOff
    let pins = false
    if (!m) {
      this.tcnt = (v + 1) & this.max
      return
    }
    const top = this.top
    const matches = [!blocked && v === this.ch[0].ocr, !blocked && v === this.ch[1].ocr]
    switch (m.kind) {
      case "normal":
      case "ctc": {
        for (let c = 0; c < 2; c++)
          if (matches[c]) {
            this.flag(2 << c, edge)
            pins = this.nonPwmAction(c) || pins
          }
        if (m.kind === "ctc" && v === top && !blocked) {
          this.tcnt = 0
          if (m.top === "icr") this.flag(0x20, edge)
        } else this.tcnt = (v + 1) & this.max
        if (v === this.max) this.flag(1, edge)
        break
      }
      case "fast": {
        const atTop = v === top && !blocked
        for (let c = 0; c < 2; c++) {
          if (!matches[c]) continue
          this.flag(2 << c, edge)
          const com = this.com(c)
          if (com === 1 && c === 0 && this.spec.toggleA.includes(this.wgm)) {
            this.ch[0].oc = !this.ch[0].oc
            pins = true
          } else if (com >= 2 && this.ch[c].ocr !== top) {
            // Non-inverting clears, inverting sets on the match; OCR = TOP is ignored here (Table 15-3 note).
            this.ch[c].oc = com === 3
            pins = true
          }
        }
        if (atTop) {
          this.tcnt = 0
          if (m.tov === "top" || (m.tov === "max" && v === this.max)) this.flag(1, edge)
          if (m.top === "icr") this.flag(0x20, edge)
          for (let c = 0; c < 2; c++) {
            this.ch[c].ocr = this.ch[c].buf
            const com = this.com(c)
            // BOTTOM: set (non-inverting) or clear (inverting).
            if (com >= 2) {
              this.ch[c].oc = com === 2
              pins = true
            }
          }
        } else this.tcnt = (v + 1) & this.max
        break
      }
      case "pc":
      case "pfc": {
        const up = this.dir > 0
        for (let c = 0; c < 2; c++) {
          if (!matches[c]) continue
          this.flag(2 << c, edge)
          const com = this.com(c)
          if (com === 1 && c === 0 && this.spec.toggleA.includes(this.wgm)) {
            this.ch[0].oc = !this.ch[0].oc
            pins = true
          } else if (com >= 2 && !(v === top && this.ch[c].ocr === top)) {
            // A match at BOTTOM counts as up-counting (OCR = 0 gives a steady low, §15.7.4).
            const upMatch = up || v === 0
            this.ch[c].oc = upMatch ? com === 3 : com === 2
            pins = true
          }
        }
        if (up && v === top && !blocked) {
          this.dir = -1
          this.tcnt = (v - 1) & this.max
          if (m.top === "icr") this.flag(0x20, edge)
          if (m.top === "ocra" && !matches[0]) this.flag(0x02, edge)
          if (m.update === "top") for (const ch of this.ch) ch.ocr = ch.buf
          // At TOP the output is what an up-counting match leaves, unless OCR = TOP (then the down-counting result):
          // the transition "without compare match" that keeps the pulse symmetric around BOTTOM (§15.7.4).
          for (let c = 0; c < 2; c++) {
            const com = this.com(c)
            if (com < 2) continue
            const level = this.ch[c].ocr === this.top ? com === 2 : com === 3
            if (this.ch[c].oc !== level) {
              this.ch[c].oc = level
              pins = true
            }
          }
        } else if (!up && v === 0) {
          this.dir = 1
          this.tcnt = 1
          this.flag(1, edge)
          if (m.update === "bottom") for (const ch of this.ch) ch.ocr = ch.buf
        } else this.tcnt = (v + this.dir) & this.max
        break
      }
    }
    if (pins) this.mcu.pinsChangedAt(edge)
  }

  private com(c: number) {
    return (this.tccrA >> (c === 0 ? 6 : 4)) & 3
  }
  private nonPwmAction(c: number): boolean {
    const com = this.com(c)
    if (com === 0) return false
    this.ch[c].oc = com === 1 ? !this.ch[c].oc : com === 3
    return true
  }

  // --- pins -------------------------------------------------------------------------------------

  /** Port override for OCnA/OCnB (Figure 15-4): PVOE when the channel is connected in this mode, PVOV = OCnx. */
  ocOverride(c: number, o: PinOverride) {
    const com = this.com(c)
    if (com === 0) return
    const m = this.mode
    if (com === 1 && m && m.kind !== "normal" && m.kind !== "ctc" && !(c === 0 && this.spec.toggleA.includes(this.wgm))) return
    o.pvoe = true
    o.pvov = this.ch[c].oc
  }
  /** Channels that drive a pin with a waveform (the loop averages their duty). */
  drivesPin(c: number): boolean {
    const o = { pvoe: false } as PinOverride
    this.ocOverride(c, o)
    return o.pvoe
  }

  private input(port: number, pin: number, level: boolean, cycle: number) {
    const s = this.spec
    if (s.pins.t && port === s.pins.t[0] && pin === s.pins.t[1]) {
      const cs = this.clock
      // The Tn pin is synchronized, then edge-detected: the count follows 2.5–3.5 cycles after the edge (§17.3).
      if (cs.kind === "ext" && level === cs.rising) {
        this.extTicks.push(syncEdge(cycle) + 2)
        this.changed()
      }
    }
    if (s.pins.icp && port === s.pins.icp[0] && pin === s.pins.icp[1] && s.vectors.capt !== undefined && !this.captureFromComparator()) {
      if (this.mode?.top === "icr") return
      const ices = (this.tccrB & 0x40) !== 0
      if (level !== ices) return
      // Same synchronizer and edge detector as Tn; the noise canceler adds four cycles (§16.6.1, §16.6.2).
      const delay = this.tccrB & 0x80 ? 4 : 0
      this.captures.push(syncEdge(cycle) + 2 + delay)
      this.changed()
    }
  }

  /** The analog comparator's output as the capture source (ACSR.ACIC): an edge at `cycle` (§16.6.1). */
  comparatorEdge(level: boolean, cycle: number) {
    if (this.mode?.top === "icr") return
    if (level !== ((this.tccrB & 0x40) !== 0)) return
    const delay = this.tccrB & 0x80 ? 4 : 0
    this.captures.push(syncEdge(cycle) + 2 + delay)
    this.changed()
  }
  /** Whether the comparator, not ICP1, feeds input capture (ACSR.ACIC). */
  captureFromComparator: () => boolean = () => false

  // --- scheduling -------------------------------------------------------------------------------

  /** Something changed: work out when the next tick that matters comes (if anything watches it). */
  private changed() {
    // Only the dual-slope modes count down: a mode change out of phase correct PWM on the way
    // down leaves the counter counting up from where it stood (Normal, CTC and fast PWM count up).
    const m = this.mode
    if (!m || (m.kind !== "pc" && m.kind !== "pfc")) this.dir = 1
    this.bus.irq.update()
    this.bus.pinsChanged()
    this.plan()
  }
  private plan() {
    let due = Math.min(this.captures.length ? this.captures[0] : Infinity, this.asyncEvent())
    const watching = ((this.timsk | this.watchFlags()) & ~this.tifr) !== 0 || this.drivesPin(0) || this.drivesPin(1) || this.extTicks.length > 0
    if (watching) {
      const first = this.nextTickAfter(this.synced)
      if (first !== Infinity) {
        const cs = this.clock
        const q = this.blockAt >= 0 ? 1 : this.quietTicks()
        if (this.async && cs.kind === "div") due = Math.min(due, this.toscCycle(Math.round(this.mcu.cycleTime(first) * this.toscHz!) + (q - 1) * cs.n))
        else due = Math.min(due, cs.kind === "div" ? first + (q - 1) * cs.n : first)
      }
    }
    // Asynchronous edges fall between CPU cycles: the event is handled on the cycle after.
    this.due = Math.ceil(due - 1e-6)
    this.bus.reschedule()
  }
  override service(cycle: number) {
    this.sync(cycle)
    this.bus.irq.update()
    this.plan()
  }
  override clockChanged(cycle: number) {
    this.sync(cycle)
    this.plan()
  }
}

/**
 * GTCCR (§17.4.1, §18.11): PSRSYNC resets the Timer0/1 prescaler, PSRASY the Timer2 one; with
 * TSM set the written reset bits stay set and hold the prescalers until TSM is cleared, so the
 * timers start counting together.
 */
export class Gtccr extends Peripheral {
  readonly name = "GTCCR"
  private tsm = false
  private psr = 0
  private readonly sync01: Prescaler
  private readonly asy: Prescaler
  private readonly timers: TimerCounter[]
  /** The asynchronous timer: its prescaler resets on a TOSC1 edge, PSRASY reads one until then. */
  private readonly asyTimer: TimerCounter | undefined
  private psrasyUntil = -1
  constructor(bus: AvrBus, sync01: Prescaler, asy: Prescaler, timers: TimerCounter[]) {
    super(bus)
    this.sync01 = sync01
    this.asy = asy
    this.timers = timers
    this.asyTimer = timers.find((t) => t.spec.async)
    bus.register(0x43, {
      name: "GTCCR",
      read: () => (this.tsm ? 0x80 | this.psr : this.now < this.psrasyUntil ? 0x02 : 0),
      write: (v, m) => this.write((this.value() & ~m) | (v & m)),
    })
  }
  private value() {
    return (this.tsm ? 0x80 : 0) | this.psr
  }
  private write(v: number) {
    const edge = this.now + 1
    for (const t of this.timers) t.sync(edge)
    this.tsm = (v & 0x80) !== 0
    this.psr = this.tsm ? v & 0x03 : 0
    if (v & 0x01) this.sync01.reset(edge)
    if (v & 0x02) {
      this.asy.reset(edge)
      const t2 = this.asyTimer
      const at = t2?.nextToscEdge(edge)
      if (t2 && at != null) {
        t2.asyBase = t2.toscIndexOf(at)
        this.psrasyUntil = at
      }
    }
    this.sync01.held = this.tsm && (this.psr & 1) !== 0
    this.asy.held = this.tsm && (this.psr & 2) !== 0
    // Released: the count starts from this edge.
    if (!this.sync01.held && v & 0x01) this.sync01.reset(edge)
    for (const t of this.timers) t.clockChanged(edge)
  }
  reset() {
    this.psrasyUntil = -1
    this.tsm = false
    this.psr = 0
    this.sync01.held = this.asy.held = false
    this.sync01.reset(0)
    this.asy.reset(0)
  }
  override setClockRunning(running: boolean, cycle: number) {
    if (running) {
      this.sync01.resume(cycle)
    } else this.sync01.stop(cycle)
  }
}
