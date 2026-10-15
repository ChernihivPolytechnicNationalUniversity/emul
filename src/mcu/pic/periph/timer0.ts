/**
 * Timer0, its 8-bit prescaler and the watchdog that shares it (DS40044G §6, §14.7, Figure 6-1;
 * DS33023A §11, Figures 11-2…11-5; checklist P2-001…, P4-170…, P9-001…).
 *
 * The prescaler is one 8-bit counter: with PSA = 0 it divides Timer0's clock by 2^(PS+1), with
 * PSA = 1 it divides the watchdog's time-outs by 2^PS and Timer0 counts 1:1 (Register 4-2).
 *
 * Timer mode is counted lazily from an origin cycle: TMR0 read in instruction cycle k is
 * base + ⌊(k − origin) / P⌋. A write in cycle w loads base, clears the prescaler and inhibits the
 * next two increments, so origin = w + 3 (Figure 11-2: reads NT0, NT0, NT0, NT0+1; Figure 11-3 at
 * 1:2: NT0 four times, then NT0+1). T0IF sets in the cycle TMR0 reads 00h (Figure 11-4).
 *
 * Counter mode counts T0CKI edges: through the asynchronous prescaler, then synchronised on Q2/Q4,
 * the increment lands 3 TOSC after the sampling point — 3 to 5 TOSC after the edge, inside the
 * reference manual's 3–7 TOSC (Figure 11-5 note 1; decision in docs/pic16-checklist.md).
 * Timer0 is shut off in Sleep (§6.1).
 */
import { Peripheral, type PicBus } from "../io"

export interface Timer0Host {
  /** OPTION_REG. */
  readonly option: number
  /** T0IF sets at `cycle`. */
  setT0if(cycle: number): void
  /** The level of RA4/T0CKI (its Schmitt input). */
  t0cki(): boolean
}

export class Timer0 extends Peripheral {
  readonly name = "Timer0"
  private readonly host: Timer0Host
  /** TMR0 at `origin` and the prescaler's zero point (timer mode). */
  private base = 0
  private origin = 0
  /** Counter mode: increments still to land, by fractional cycle. */
  private readonly pending: number[] = []
  private edges = 0
  /** The core clock stopped (Sleep) at this cycle; Timer0 is frozen meanwhile. */
  private frozenAt: number | null = null

  constructor(bus: PicBus, host: Timer0Host) {
    super(bus)
    this.host = host
  }

  private get counter() {
    return (this.host.option & 0x20) !== 0
  }
  /** Timer0's divisor: 1 with the prescaler on the WDT, else 2^(PS+1). */
  private get divisor() {
    const o = this.host.option
    return o & 0x08 ? 1 : 2 << (o & 7)
  }

  reset(por: boolean) {
    // TMR0: xxxx xxxx at power-on, unchanged by other resets (Table 14-7).
    if (por) this.base = Math.floor(this.bus.random() * 256)
    else this.base = this.value(this.bus.cpu.cycles)
    this.origin = 0
    this.pending.length = 0
    this.edges = 0
    this.frozenAt = null
    this.plan(0)
  }

  /** TMR0 as read in instruction cycle k. */
  value(k: number): number {
    if (this.counter) {
      this.apply(k)
      return this.base & 0xff
    }
    const at = this.frozenAt ?? k
    if (at < this.origin) return this.base & 0xff
    return (this.base + Math.floor((at - this.origin) / this.divisor)) & 0xff
  }
  read(): number {
    return this.value(Math.floor(this.now))
  }
  /** A write in the current instruction: TMR0 loaded, prescaler cleared, two increments inhibited (§6.0, §6.3). */
  write(v: number) {
    const w = Math.floor(this.now)
    this.base = v & 0xff
    this.origin = w + 3
    this.pending.length = 0
    this.edges = 0
    this.plan(w)
    this.bus.reschedule()
  }

  /**
   * OPTION is about to change at cycle c: TMR0 keeps its count; the new divisor counts from c (the
   * prescaler's phase across a ratio change is not documented beyond "may cause an unintended
   * device Reset" with the WDT, §6.3.1).
   */
  optionChanging(c: number) {
    if (!this.counter) {
      this.base = this.value(c)
      this.origin = Math.max(c, this.origin)
    } else this.apply(c)
  }
  optionChanged(c: number) {
    this.plan(c)
  }
  /** A T0CKI level change at fractional cycle e. */
  pinEdge(level: boolean, e: number) {
    if (!this.counter || this.frozenAt !== null) return
    const rising = (this.host.option & 0x10) === 0
    if (level !== rising) return
    this.edges++
    if (this.edges % this.divisor !== 0) return
    // Synchronised on the next Q2 or Q4 (k + 0.25, k + 0.75), the increment lands 3 TOSC later.
    const sample = Math.ceil((e - 0.25) * 2) / 2 + 0.25
    const land = sample + 0.75
    if (land < this.origin) return
    this.pending.push(land)
    this.plan(e)
    this.bus.reschedule()
  }

  /** Counter mode: apply the increments landed by cycle k. */
  private apply(k: number) {
    while (this.pending.length && this.pending[0] <= k + 0.25) {
      const t = this.pending.shift()!
      this.base = (this.base + 1) & 0xff
      if (this.base === 0) this.host.setT0if(Math.ceil(t))
    }
  }

  /** Next event: the overflow in timer mode, the next landing increment in counter mode. */
  private plan(c: number) {
    if (this.frozenAt !== null) {
      this.due = Infinity
      return
    }
    if (this.counter) {
      this.due = this.pending.length ? Math.ceil(this.pending[0] - 0.25) : Infinity
      return
    }
    const P = this.divisor
    const from = Math.max(c, this.origin)
    const done = Math.floor((from - this.origin) / P)
    const now = (this.base + done) & 0xff
    // Increments still needed to roll over to 00h, then the cycle the last one is counted in.
    const left = 256 - now
    this.due = this.origin + (done + left) * P
  }

  sync(cycle: number) {
    if (this.counter) {
      this.apply(cycle)
      this.plan(cycle)
      return
    }
    while (this.due <= cycle) {
      this.host.setT0if(this.due)
      this.plan(this.due)
    }
  }

  setClockRunning(running: boolean, cycle: number) {
    if (!running) {
      if (this.frozenAt !== null) return
      this.sync(cycle)
      if (!this.counter && cycle >= this.origin) {
        this.base = this.value(cycle)
        this.origin = cycle
      }
      this.frozenAt = cycle
      this.pending.length = 0
      this.due = Infinity
    } else if (this.frozenAt !== null) {
      // Resume where it stopped: the timer saw no clocks while asleep.
      const pastInhibit = Math.max(0, this.origin - this.frozenAt)
      this.frozenAt = null
      if (!this.counter) this.origin = cycle + pastInhibit
      this.plan(cycle)
    }
  }
}

export interface WdtHost {
  readonly option: number
  /** The configuration word's WDTE. */
  readonly enabled: boolean
  readonly asleep: boolean
  /** Time-out awake: a device reset; asleep: a wake-up (§14.7). */
  timeout(asleep: boolean): void
}

/**
 * The watchdog: its own RC oscillator, 18 ms typical per time-out (Table 17-7 param 31), counted in
 * seconds so it keeps time through Sleep and clock changes; the postscaler (PSA = 1) counts 2^PS of
 * them. CLRWDT, SLEEP and a wake-up from Sleep clear both (§14.7.1, §14.8.1).
 */
export class Watchdog extends Peripheral {
  readonly name = "WDT"
  override readonly domain = "own" as const
  private readonly host: WdtHost
  private readonly period: number
  /** Simulated time the count started from. */
  private start = 0

  constructor(bus: PicBus, host: WdtHost, period: number) {
    super(bus)
    this.host = host
    this.period = period
  }

  private get postscale() {
    const o = this.host.option
    return o & 0x08 ? 1 << (o & 7) : 1
  }
  get timeoutAt(): number {
    return this.start + this.period * this.postscale
  }

  reset() {
    this.start = this.bus.cycleTime(this.bus.cpu.cycles)
    this.plan()
  }
  clear(cycle = this.now) {
    this.start = this.bus.cycleTime(cycle)
    this.plan()
  }
  plan() {
    if (!this.host.enabled) {
      this.due = Infinity
      return
    }
    this.due = Math.max(this.bus.cpu.cycles, Math.ceil(this.bus.timeCycle(this.timeoutAt) - 1e-9))
  }
  clockChanged() {
    this.plan()
  }
  sync(cycle: number) {
    if (this.due > cycle) return
    const asleep = this.host.asleep
    this.start = this.bus.cycleTime(cycle)
    this.plan()
    this.host.timeout(asleep)
  }
}
