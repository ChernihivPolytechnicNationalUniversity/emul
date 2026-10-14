/**
 * Timer2 and CCP1 (DS40044G §8, §9; DS33023A §13, §14; checklist P2-077…P2-156, P9-064…P9-122).
 *
 * Timer2 counts FOSC/4 through a 1:1/1:4/1:16 prescaler from 00h up to PR2 and back to 00h on the
 * next increment; every postscale-th such reset sets TMR2IF. Counted lazily from an origin; the
 * resets ("period boundaries") are events, since TMR2IF and the PWM hang on them.
 *
 * CCP1: capture (TMR1 into CCPR1 on RB3 edges, ÷1/4/16), compare (against TMR1: set, clear,
 * interrupt only, special event) and PWM (Timer2's period, a 10-bit duty in TOSC·prescale, double
 * buffered into CCPR1H at each period boundary, the pin cleared at the duty's end to the TOSC).
 */
import { Peripheral, type PicBus } from "../io"

export interface Timer2Host {
  setTmr2if(cycle: number): void
  /** A period boundary (TMR2 = PR2 → 00h) at `cycle`: the PWM's period start. */
  onPeriod(cycle: number): void
}

export class Timer2 extends Peripheral {
  readonly name = "Timer2"
  private readonly host: Timer2Host
  t2con = 0
  pr2 = 0xff
  private base = 0
  private origin = 0
  private post = 0
  private frozen = false

  constructor(bus: PicBus, host: Timer2Host) {
    super(bus)
    this.host = host
  }
  get on() {
    return (this.t2con & 0x04) !== 0
  }
  private get prescale() {
    const p = this.t2con & 3
    return p === 0 ? 1 : p === 1 ? 4 : 16
  }
  get prescaleValue() {
    return this.prescale
  }
  private get postscale() {
    return ((this.t2con >> 3) & 0x0f) + 1
  }

  /** TMR2 = 00h, PR2 = FFh, T2CON = 00h, the pre/postscalers clear on every reset (§8, Table 14-7; D19 on P2-093). */
  reset() {
    this.t2con = 0
    this.pr2 = 0xff
    this.base = 0
    this.post = 0
    this.frozen = false
    this.origin = this.bus.cpu.cycles
    this.due = Infinity
  }

  /** Increments since the origin by cycle k. */
  private increments(k: number) {
    if (!this.on || this.frozen || k <= this.origin) return 0
    return Math.floor((k - this.origin) / this.prescale)
  }
  /** Increments from `base` to the next period boundary. */
  private toBoundary() {
    return this.base <= this.pr2 ? this.pr2 + 1 - this.base : 0x100 - this.base + this.pr2 + 1
  }
  /** TMR2 after n increments from `base`. */
  private after(n: number) {
    const L = this.pr2 + 1
    if (this.base <= this.pr2) return (this.base + n) % L
    const toZero = 0x100 - this.base
    return n < toZero ? this.base + n : (n - toZero) % L
  }
  value(k: number) {
    return this.after(this.increments(k)) & 0xff
  }
  /** The boundary after the next one is a full period of (PR2 + 1)·prescale cycles. */
  get periodCycles() {
    return (this.pr2 + 1) * this.prescale
  }
  /** Cycle of the next period boundary (TMR2 resets to 00h), or Infinity. */
  nextBoundary(): number {
    if (!this.on || this.frozen) return Infinity
    const n = this.toBoundary()
    return this.origin + n * this.prescale
  }

  private rebase(k: number) {
    const n = this.increments(k)
    if (n === 0) return
    // Boundaries passed here (between events) are already counted by `service`.
    this.base = this.after(n)
    this.origin += n * this.prescale
  }
  private plan() {
    this.due = this.nextBoundary()
  }
  service(cycle: number) {
    while (this.due <= cycle) {
      const b = this.due
      // At the boundary: TMR2 = 00h, the postscaler counts the match.
      this.base = 0
      this.origin = b
      this.post++
      if (this.post >= this.postscale) {
        this.post = 0
        this.host.setTmr2if(b)
      }
      this.host.onPeriod(b)
      this.plan()
    }
  }

  read(): number {
    return this.value(Math.floor(this.now))
  }
  /** A write to TMR2 clears both scalers (§8.1). */
  write(v: number) {
    const k = Math.floor(this.now)
    this.rebase(k)
    this.base = v & 0xff
    // The prescaler restarts from the write: the next increment comes `prescale` cycles on.
    this.origin = k
    this.post = 0
    this.plan()
    this.bus.reschedule()
  }
  /** A write to T2CON clears both scalers and leaves TMR2 (§8.1). */
  writeT2con(v: number) {
    const k = Math.floor(this.now)
    this.rebase(k)
    this.t2con = v & 0x7f
    this.origin = k
    this.post = 0
    this.plan()
    this.bus.reschedule()
  }
  writePr2(v: number) {
    const k = Math.floor(this.now)
    this.rebase(k)
    this.pr2 = v & 0xff
    this.plan()
    this.bus.reschedule()
  }
  /** Stopped in Sleep, the prescaler keeping its count (§8, DS33023A §13.7). */
  setClockRunning(running: boolean, cycle: number) {
    if (!running) {
      this.rebase(cycle)
      this.frozen = true
      this.due = Infinity
    } else if (this.frozen) {
      this.frozen = false
      this.origin = cycle
      this.plan()
    }
  }
}

export interface CcpHost {
  readonly timer1: { peekValue(): number; value(k: number): number; compareChanged(): void; async: boolean; on: boolean }
  readonly timer2: Timer2
  setCcp1if(cycle: number): void
  readonly asleep: boolean
  /** RB3's level now (for capture prescaler resets and the pin's own drive). */
  pinChanged(cycle: number): void
  /** The original part's compare erratum (DS80073F item 4; decision D61). */
  readonly compareErratum: boolean
}

export class Ccp1 extends Peripheral {
  readonly name = "CCP1"
  private readonly host: CcpHost
  ccp1con = 0
  ccpr1l = 0
  ccpr1h = 0
  /** The output latch the pin mux takes in compare and PWM modes (Figure 9-2, 9-3). */
  output = false
  /** PWM: the duty latched at the period start (CCPR1H:2 bits), in TOSC·prescale units. */
  private dutyLatched = 0
  private captureCount = 0
  /** PWM: cycle (fractional) the pin falls in the current period. */
  private fallAt = Infinity
  /** E2-004 (D61): iterations (a 1000↔1001 change, then a match) since CCP1CON<3> was clear; one under way; inverted. */
  private iterations = 0
  private changed = false
  private inverted = false

  constructor(bus: PicBus, host: CcpHost) {
    super(bus)
    this.host = host
  }
  get mode() {
    return this.ccp1con & 0x0f
  }
  get capture() {
    return this.mode >= 4 && this.mode <= 7
  }
  get compare() {
    return this.mode >= 8 && this.mode <= 11
  }
  get pwm() {
    return this.mode >= 12
  }
  /** The CCP drives RB3 through the mux (compare set/clear, PWM; TRISB<3> still enables it). */
  get drivesPin() {
    return this.mode === 8 || this.mode === 9 || this.pwm
  }
  get compareTarget(): number | null {
    return this.compare ? (this.ccpr1h << 8) | this.ccpr1l : null
  }
  get specialEvent() {
    return this.mode === 11
  }

  /** CCP1CON clears on every reset: the module off, the capture prescaler cleared (§9.1.4, Table 14-7). */
  reset(por: boolean) {
    this.ccp1con = 0
    if (por) {
      this.ccpr1l = Math.floor(this.bus.random() * 256)
      this.ccpr1h = Math.floor(this.bus.random() * 256)
    }
    this.output = false
    this.captureCount = 0
    this.fallAt = Infinity
    this.iterations = 0
    this.changed = false
    this.inverted = false
    this.due = Infinity
  }

  writeCon(v: number) {
    const was = this.mode
    this.ccp1con = v & 0x3f
    const mode = this.mode
    if (mode >= 1 && mode <= 3) this.bus.feature(`CCP1 mode ${mode.toString(2).padStart(4, "0")}: not described in DS40044G (P9-079) — run as off`)
    // The capture prescaler clears when the module leaves capture; switching between ÷1/4/16 keeps its count (§9.1.4).
    if (!this.capture) this.captureCount = 0
    // Clearing CCP1CON forces the output latch low (§9.2.1, §9.3 notes); a compare-output mode starts at the opposite
    // of its match level (DS33023A §14.4.1).
    if (mode === 0) this.output = false
    if (mode === 8 && was !== 8) this.output = false
    if (mode === 9 && was !== 9) this.output = true
    if (this.host.compareErratum) this.erratum(was, mode)
    if (this.pwm && !(was >= 12)) {
      this.output = false
      this.fallAt = Infinity
    }
    this.host.timer1.compareChanged()
    this.host.pinChanged(Math.ceil(this.now))
  }
  writeL(v: number) {
    this.ccpr1l = v & 0xff
    if (this.compare) this.host.timer1.compareChanged()
  }
  /** CCPR1H is read-only in PWM mode: it holds the latched duty (§9.3.2). */
  writeH(v: number) {
    if (this.pwm) return
    this.ccpr1h = v & 0xff
    if (this.compare) this.host.timer1.compareChanged()
  }

  /**
   * The original part's compare erratum (DS80073F item 4; D61): the third change between 1000 and 1001
   * since CCP1CON<3> was clear, each earlier one followed by a match, sets the latch at once to the
   * inverse of CCP1CON<0> and inverts every later match until CCP1CON<3> is cleared.
   */
  private erratum(was: number, mode: number) {
    if (!(mode & 8)) {
      this.iterations = 0
      this.changed = false
      this.inverted = false
      return
    }
    if (!((was === 8 && mode === 9) || (was === 9 && mode === 8))) return
    if (this.iterations >= 2 && !this.inverted) {
      this.inverted = true
      this.bus.feature("CCP compare: third change between 1000 and 1001 on the original PIC16F627/628 — the output latch inverts (errata DS80073F item 4, E2-004; decision D61)")
    }
    if (this.inverted) this.output = (mode & 1) === 0
    this.changed = true
  }

  /** A compare match at cycle c: CCP1IF, and the pin per the mode (§9.2). */
  onCompare(c: number) {
    this.host.setCcp1if(c)
    if (this.changed) {
      this.iterations++
      this.changed = false
    }
    if (this.mode === 8) this.output = !this.inverted
    else if (this.mode === 9) this.output = this.inverted
    else return
    this.host.pinChanged(c)
  }

  /** RB3 edge at fractional cycle e: the capture's edge detect and prescaler (§9.1). */
  pinEdge(level: boolean, e: number) {
    if (!this.capture) return
    const m = this.mode
    if (m === 4 ? level : !level) return
    this.captureCount++
    const every = m === 6 ? 4 : m === 7 ? 16 : 1
    if (this.captureCount % every !== 0) return
    const c = Math.ceil(e - 1e-9)
    // In Sleep the flag still sets but CCPR1 is not loaded (TMR1 stopped; DS33023A §14.3.3).
    if (!this.host.asleep) {
      const v = this.host.timer1.value(c)
      this.ccpr1l = v & 0xff
      this.ccpr1h = v >> 8
    }
    this.host.setCcp1if(c)
  }

  /** A Timer2 period boundary: PWM output set (unless duty 0), duty latched (§9.3.1). */
  onPeriod(b: number) {
    if (!this.pwm) return
    const duty = (this.ccpr1l << 2) | ((this.ccp1con >> 4) & 3)
    this.dutyLatched = duty
    this.ccpr1h = this.ccpr1l
    const t2 = this.host.timer2
    // The pin clears when TMR2:Q (or TMR2:prescaler bits) equals the duty: duty · TOSC · prescale = duty · prescale / 4 cycles.
    const span = (duty * t2.prescaleValue) / 4
    const level = duty > 0
    this.fallAt = level && span < t2.periodCycles ? b + span : Infinity
    if (this.output !== level) {
      this.output = level
      this.host.pinChanged(b)
    }
    this.due = this.fallAt === Infinity ? Infinity : Math.ceil(this.fallAt - 1e-9)
  }
  service(cycle: number) {
    if (this.fallAt <= cycle + 1e-9) {
      const at = this.fallAt
      this.fallAt = Infinity
      this.due = Infinity
      if (this.pwm && this.output) {
        this.output = false
        this.host.pinChanged(at)
      }
    }
  }
  /** The duty value in TOSC·prescale units latched now (inspector, tests). */
  get latchedDuty() {
    return this.dutyLatched
  }
}
