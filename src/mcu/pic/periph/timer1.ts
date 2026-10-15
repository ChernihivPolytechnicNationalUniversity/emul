/**
 * Timer1 (DS40044G §7, DS33023A §12; checklist P2-036…P2-076, P9-030…P9-063): 16 bits in
 * TMR1H:TMR1L, a 1:1–1:8 prescaler, three clocks — FOSC/4 (timer), the Timer1 oscillator on
 * RB7/RB6 (T1OSCEN) or rising edges on RB6/T1CKI — counted synchronously (after the prescaler,
 * stopped in Sleep while the prescaler keeps counting) or asynchronously (counting in Sleep, its
 * overflow a wake-up source). CCP1 compares against it and its special event resets it.
 *
 * Counted lazily: the increments since `origin` follow from the clock — cycles at FOSC/4, the
 * crystal's ticks, or the counted pin edges — and events are planned for the overflow and the
 * compare match. A synchronised external increment lands one TCY after its edge (the sampling on
 * Q2/Q4 plus the hand-over, inside param 48's 2–7 TOSC; decision D18 in docs/pic16-checklist.md).
 */
import { Peripheral, type PicBus } from "../io"

/** The crystal on T1OSI/T1OSO: its frequency and how long it takes to start (from the circuit's crystal). */
export type T1Oscillator = { hz: number; kind: "crystal" | "clock"; startup: number } | null

export interface Timer1Host {
  setTmr1if(cycle: number): void
  /** RB6/T1CKI's level (Schmitt input). */
  t1cki(): boolean
  readonly asleep: boolean
  /** CCP1 compares against TMR1 (modes 10xx): the 16-bit value, and what a match does. */
  readonly compareTarget: number | null
  onCompare(cycle: number): void
  /** The match also resets TMR1 on the next Timer1 clock (special event, mode 1011). */
  readonly specialEvent: boolean
}

export class Timer1 extends Peripheral {
  readonly name = "Timer1"
  private readonly host: Timer1Host
  t1con = 0
  private base = 0
  /** Timer mode: the cycle increments are counted from. Crystal: the tick index they are counted from. */
  private origin = 0
  private originTick = 0
  /** Pin-clocked counter: edges into the prescaler, increments landed and still to land (cycles). */
  private edges = 0
  private readonly pending: number[] = []
  /** Frozen: TMR1ON clear, or a synchronous count in Sleep (the prescaler phase kept as `frozenRem`). */
  private frozen = true
  private frozenTick = 0
  private frozenRem = 0
  oscillator: T1Oscillator = null
  /** When the oscillator was last enabled (s), for its start-up time. */
  private oscOnAt = 0
  /** The special event fired: the next increment loads 0000h instead (§9.2.4). */
  private resetNext = false

  constructor(bus: PicBus, host: Timer1Host) {
    super(bus)
    this.host = host
  }

  get on() {
    return (this.t1con & 0x01) !== 0
  }
  get external() {
    return (this.t1con & 0x02) !== 0
  }
  get async() {
    return this.external && (this.t1con & 0x04) !== 0
  }
  get oscEnabled() {
    return (this.t1con & 0x08) !== 0
  }
  private get prescale() {
    return 1 << ((this.t1con >> 4) & 3)
  }
  /** The clock in use: FOSC/4, the oscillator's ticks, or RB6 edges. */
  private get clock(): "cycles" | "crystal" | "pin" {
    if (!this.external) return "cycles"
    return this.oscEnabled ? "crystal" : "pin"
  }

  reset(por: boolean) {
    // TMR1H:TMR1L are never reset (x on POR, §7.6); T1CON clears on POR and BOR only (the SoC calls `brownOut`).
    if (por) {
      this.base = Math.floor(this.bus.random() * 0x10000)
      this.t1con = 0
    } else this.base = this.value(this.bus.cpu.cycles)
    this.frozen = true
    this.edges = 0
    this.pending.length = 0
    this.resetNext = false
    this.restart(this.bus.cpu.cycles)
  }
  brownOut() {
    this.t1con = 0
    this.restart(this.bus.cpu.cycles)
  }

  // --- the crystal's ticks -------------------------------------------------------------------------

  /** Ticks of the Timer1 oscillator by simulated time t (tick i at start + i/f), 0 while it starts. */
  private tickIndex(t: number): number {
    const o = this.oscillator
    if (!o || !this.oscEnabled) return 0
    const start = this.oscOnAt + o.startup
    return t <= start ? 0 : Math.floor((t - start) * o.hz)
  }
  private tickCycle(i: number): number {
    const o = this.oscillator!
    return this.bus.timeCycle(this.oscOnAt + o.startup + i / o.hz)
  }
  /** Synchronised increments land one TCY after their tick; asynchronous ones at once (D18). */
  private get syncDelay() {
    return this.async ? 0 : 1
  }

  // --- counting ------------------------------------------------------------------------------

  /** Increments since the origin, by cycle k. */
  private increments(k: number): number {
    if (this.frozen) return 0
    const P = this.prescale
    switch (this.clock) {
      case "cycles":
        return k <= this.origin ? 0 : Math.floor((k - this.origin) / P)
      case "crystal": {
        if (!this.oscillator) return 0
        const t = this.bus.cycleTime(k - this.syncDelay)
        return Math.max(0, Math.floor((this.tickIndex(t) - this.originTick) / P))
      }
      default:
        this.land(k)
        return 0
    }
  }
  /** The cycle the n-th increment from the origin lands in (Infinity when it never will). */
  private incrementCycle(n: number): number {
    if (this.frozen || n <= 0) return Infinity
    const P = this.prescale
    switch (this.clock) {
      case "cycles":
        return this.origin + n * P
      case "crystal":
        if (!this.oscillator) return Infinity
        return this.tickCycle(this.originTick + n * P) + this.syncDelay
      default:
        return Infinity
    }
  }
  /** Pin-clocked increments landed by cycle k. */
  private land(k: number) {
    while (this.pending.length && this.pending[0] <= k + 1e-9) {
      const at = this.pending.shift()!
      this.step(Math.ceil(at - 1e-9))
    }
  }
  /** One increment at cycle c: the special event's reset, the overflow, the compare match. */
  private step(c: number) {
    if (this.resetNext) {
      this.resetNext = false
      // At CCPR1 = FFFFh the reset is also the overflow: TMR1IF sets as well (DS33023A §14.7 Q5).
      if (this.base === 0xffff) this.host.setTmr1if(c)
      this.base = 0
    } else {
      this.base = (this.base + 1) & 0xffff
      if (this.base === 0) this.host.setTmr1if(c)
    }
    this.checkMatch(c)
  }
  private checkMatch(c: number) {
    const t = this.host.compareTarget
    if (t !== null && this.base === t && !this.async) {
      if (this.host.specialEvent) this.resetNext = true
      this.host.onCompare(c)
    }
  }

  /** TMR1 as it reads in cycle k. */
  value(k: number): number {
    if (this.clock === "pin") {
      this.land(k)
      return this.base
    }
    return (this.base + this.increments(k)) & 0xffff
  }

  /** Move the origin to the present: the count so far goes into `base`. */
  private rebase(k: number) {
    if (this.clock === "pin") {
      this.land(k)
      return
    }
    const n = this.increments(k)
    this.base = (this.base + n) & 0xffff
    if (this.clock === "cycles") this.origin = this.origin + n * this.prescale
    else this.originTick = this.originTick + n * this.prescale
  }
  /** The prescaler cleared and counting restarted at cycle k (a write, a mode change). */
  private restart(k: number) {
    this.frozen = !this.on || (this.host.asleep && !this.async)
    // The prescaler restarts from here: the next increment comes `prescale` clocks on.
    this.origin = k
    this.originTick = this.tickIndex(this.bus.cycleTime(k))
    this.edges = 0
    this.plan(k)
  }

  /** Plan the next overflow or compare match. */
  private plan(k: number) {
    if (this.clock === "pin") {
      this.due = this.pending.length ? Math.ceil(this.pending[0] - 1e-9) : Infinity
      return
    }
    let n = 0x10000 - this.base
    const t = this.host.compareTarget
    if (t !== null && !this.async) {
      const toMatch = (t - this.base) & 0xffff
      if (toMatch > 0 && toMatch < n) n = toMatch
    }
    if (this.resetNext) n = 1
    let due = this.incrementCycle(n)
    if (due < k) due = k
    this.due = due === Infinity ? Infinity : Math.ceil(due - 1e-9)
  }

  sync(cycle: number) {
    if (this.clock === "pin") {
      this.land(cycle)
      this.plan(cycle)
      return
    }
    // Step through every planned event up to the cycle (an overflow and matches may both come).
    for (let guard = 0; guard < 4 && this.due <= cycle; guard++) {
      const k = this.due
      const n = this.increments(k)
      if (n <= 0) break
      // Everything but the last increment up to k is silent; the last one is the planned event.
      this.base = (this.base + n - 1) & 0xffff
      if (this.clock === "cycles") this.origin += n * this.prescale
      else this.originTick += n * this.prescale
      this.step(k)
      this.plan(k)
    }
    this.plan(cycle)
  }

  // --- registers -----------------------------------------------------------------------------

  readL(): number {
    return this.value(Math.floor(this.now)) & 0xff
  }
  readH(): number {
    return this.value(Math.floor(this.now)) >> 8
  }
  peekValue(): number {
    return this.value(this.bus.cpu.cycles)
  }
  /** A write clears the prescaler and wins over a coinciding special-event reset (§7.5, §7.7). */
  write(high: boolean, v: number) {
    const k = Math.floor(this.now)
    this.rebase(k)
    this.base = high ? (this.base & 0x00ff) | (v << 8) : (this.base & 0xff00) | v
    this.resetNext = false
    this.pending.length = 0
    this.restart(k)
    this.bus.reschedule()
  }
  writeT1con(v: number) {
    const k = Math.floor(this.now)
    this.rebase(k)
    const was = this.t1con
    this.t1con = v & 0x3f
    if ((was ^ this.t1con) & 0x08 && this.oscEnabled) this.oscOnAt = this.bus.cycleTime(k)
    this.restartKeepingPhase(k, was)
    this.bus.pinsChanged()
    this.bus.reschedule()
  }
  /** A T1CON write that changes nothing about the clock keeps the prescaler's phase. */
  private restartKeepingPhase(k: number, was: number) {
    if ((was ^ this.t1con) & 0x3f) this.restart(k)
    else this.plan(k)
  }

  /** The circuit's crystal on RB6/RB7 changed. */
  setOscillator(o: T1Oscillator) {
    const k = this.bus.cpu.cycles
    this.rebase(k)
    this.oscillator = o
    this.restart(k)
  }

  /** RB6/T1CKI level change at fractional cycle e (counter mode on the pin). */
  pinEdge(level: boolean, e: number) {
    if (this.clock !== "pin" || !this.on || !level) return
    const asleep = this.host.asleep
    this.edges++
    if (this.edges % this.prescale !== 0) return
    // Synchronised: lands one TCY later and not at all in Sleep (the prescaler counted the edge); asynchronous: at once.
    if (!this.async && asleep) return
    this.pending.push(this.async ? e : e + this.syncDelay)
    this.plan(Math.floor(e))
    this.bus.reschedule()
  }

  setClockRunning(running: boolean, cycle: number) {
    // Only the synchronous count stops in Sleep; its prescaler keeps the phase (§7.2).
    if (this.async || !this.on) return
    if (!running) {
      this.rebase(cycle)
      this.frozenTick = this.tickIndex(this.bus.cycleTime(cycle))
      this.frozenRem = this.clock === "crystal" ? (this.frozenTick - this.originTick) % this.prescale : 0
      this.frozen = true
      this.due = Infinity
    } else if (this.frozen) {
      this.frozen = false
      this.origin = cycle + 1
      if (this.clock === "crystal") {
        const now = this.tickIndex(this.bus.cycleTime(cycle))
        this.originTick = now - ((this.frozenRem + now - this.frozenTick) % this.prescale)
      }
      this.plan(cycle)
    }
  }
  clockChanged(cycle: number) {
    this.plan(cycle)
  }
  /** CCP1 changed what it compares against. */
  compareChanged() {
    const k = Math.floor(this.now)
    this.rebase(k)
    this.plan(k)
    this.bus.reschedule()
  }
  /** Whether the oscillator mode has no crystal to run from (for the inspector). */
  get oscillatorMissing(): boolean {
    return this.oscEnabled && this.external && !this.oscillator
  }
}
