/**
 * General-purpose, advanced and basic timers (RM0090 §13–16, RM0385 §25–28): TIM1/8
 * (advanced), TIM2/5 (32-bit), TIM3/4 (16-bit, 4 channels), TIM9/12 (2 channels), TIM10/11/
 * 13/14 (1 channel), TIM6/7 (basic, no channels).
 *
 * Modelled: prescaler, up/down/center-aligned counting, auto-reload with preload, repetition
 * counter, update event and interrupt, one-pulse mode, output compare in every OCxM mode with
 * preload and polarity, complementary outputs gated by MOE, input capture with edge select and
 * prescaler, the capture/compare interrupts, software events through EGR.
 *
 * Not modelled: slave/trigger modes (SMCR), encoder interface, DMA burst (DCR/DMAR), dead-time and
 * break, input filters, external clock modes. Writes to those fields are kept but have no
 * effect.
 *
 * The timer counts kernel-clock ticks; the core hands it HCLK cycles and it converts with a
 * phase accumulator, so a timer at 2×PCLK stays exact over long runs.
 */
import { RegBlock, type RegDef } from "./regblock"

export type TimKind = "advanced" | "gp32" | "gp16" | "gp2" | "gp1" | "basic"

export type TimSpec = {
  name: string
  base: number
  kind: TimKind
  /** APB bus the timer sits on: decides the kernel clock. */
  apb: 1 | 2
  /** NVIC lines: one global line, or the split set of an advanced timer. */
  irq: number | { brk: number; up: number; trg: number; cc: number }
}

/** Where a channel output may appear: a pad in AF mode with this AF number. */
export type TimPad = { port: number; pin: number; af: number; channel: number; complementary?: boolean }

const REGS: RegDef[] = [
  { name: "CR1", offset: 0x00, rw: 0x3ff },
  { name: "CR2", offset: 0x04 },
  { name: "SMCR", offset: 0x08 },
  { name: "DIER", offset: 0x0c, rw: 0x7fff },
  { name: "SR", offset: 0x10, rw: 0 },
  { name: "EGR", offset: 0x14, rw: 0 },
  { name: "CCMR1", offset: 0x18 },
  { name: "CCMR2", offset: 0x1c },
  { name: "CCER", offset: 0x20 },
  { name: "CNT", offset: 0x24, rw: 0 },
  { name: "PSC", offset: 0x28, rw: 0xffff },
  { name: "ARR", offset: 0x2c },
  { name: "RCR", offset: 0x30, rw: 0xff },
  { name: "CCR1", offset: 0x34 },
  { name: "CCR2", offset: 0x38 },
  { name: "CCR3", offset: 0x3c },
  { name: "CCR4", offset: 0x40 },
  { name: "BDTR", offset: 0x44 },
  { name: "DCR", offset: 0x48 },
  { name: "DMAR", offset: 0x4c },
  { name: "OR", offset: 0x50 },
]

const CR1_CEN = 1
const CR1_UDIS = 2
const CR1_URS = 4
const CR1_OPM = 8
const CR1_DIR = 16
const CR1_CMS = 0x60
const CR1_ARPE = 0x80
const SR_UIF = 1
const DIER_UIE = 1
const DIER_TIE = 1 << 6
const BDTR_MOE = 1 << 15

export class Tim extends RegBlock {
  readonly spec: TimSpec
  readonly channels: number
  readonly is32: boolean
  private readonly mask: number

  // Counter state lives outside the register file: CNT/ARR/PSC/CCR have shadows.
  cnt = 0
  private pscCnt = 0
  private pscShadow = 0
  private arrShadow: number
  private rcrCnt = 0
  private readonly ccrShadow = [0, 0, 0, 0]
  /** OCxREF per channel (before polarity). */
  private readonly ref = [false, false, false, false]
  /** Last level driven per channel output and complementary output; null when released. */
  private readonly outLevel: (boolean | null)[] = [null, null, null, null, null, null, null, null]
  /** Input capture prescaler counters and last sampled input levels. */
  private readonly icCount = [0, 0, 0, 0]
  private readonly inLevel = [false, false, false, false]
  /** Phase accumulator of the HCLK → kernel clock conversion, in HCLK·Hz units. */
  private acc = 0
  /** Whether the counter is enabled (mirrors CR1.CEN, kept for the hot path). */
  running = false

  /** Kernel clock and core clock in Hz; the SoC pushes new values when RCC changes them. */
  private timHz = 16e6
  private hclkHz = 16e6
  /** Raise a NVIC line. */
  raiseIrq: (irq: number) => void = () => {}
  /** An event with its DMA enable bit set: "UP", "CH1".."CH4", "TRIG". */
  onDmaRequest: (event: string) => void = () => {}
  /** Every event ("UP", "CH1".."CH4", "TRIG"), and "TRGO" when CR2.MMS routes one to the trigger output. */
  onEvent: (event: string) => void = () => {}
  /** Bring the counter up to the present before a register is touched (the SoC ticks it lazily). */
  sync: () => void = () => {}
  /** The next event may have moved: the SoC recomputes when to look again. */
  reschedule: () => void = () => {}
  /** Drive (or release with `level === null`) a channel output; `index` = channel*2 + (complementary ? 1 : 0). */
  onOutput: (index: number, level: boolean | null) => void = () => {}
  /** CEN changed: the SoC adds/removes the timer from the clocked set. */
  onRunning: (on: boolean) => void = () => {}

  setClock(timHz: number, hclkHz: number) {
    this.timHz = timHz
    this.hclkHz = hclkHz
  }

  constructor(spec: TimSpec) {
    super(spec.name, spec.base, 0x400, REGS)
    this.spec = spec
    this.channels = spec.kind === "basic" ? 0 : spec.kind === "gp2" ? 2 : spec.kind === "gp1" ? 1 : 4
    this.is32 = spec.kind === "gp32"
    this.mask = this.is32 ? 0xffffffff : 0xffff
    this.arrShadow = this.mask
    this.regs[0x2c >>> 2] = this.mask >>> 0
  }

  reset() {
    super.reset()
    // RegBlock's constructor resets before our fields exist; the constructor finishes the job.
    if (!this.ccrShadow) return
    this.cnt = 0
    this.pscCnt = 0
    this.pscShadow = 0
    this.arrShadow = this.mask
    this.regs[0x2c >>> 2] = this.arrShadow >>> 0
    this.rcrCnt = 0
    this.ccrShadow.fill(0)
    this.ref.fill(false)
    this.icCount.fill(0)
    this.inLevel.fill(false)
    this.acc = 0
    if (this.running) {
      this.running = false
      this.onRunning(false)
    }
    this.releaseOutputs()
  }

  // --- register file ------------------------------------------------------------------------

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return super.read(offset, size)
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    super.write(offset, value, size)
    this.reschedule()
  }

  protected onRead(d: RegDef, current: number): number {
    switch (d.name) {
      case "CNT":
        return this.cnt >>> 0
      case "EGR":
        return 0
      default:
        return current
    }
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "CR1": {
        const cen = (next & CR1_CEN) !== 0
        if (cen !== this.running) {
          this.running = cen
          this.onRunning(cen)
        }
        if ((next & CR1_ARPE) === 0) this.arrShadow = this.regs[0x2c >>> 2] & this.mask
        if ((next & (CR1_DIR | CR1_CMS)) !== (old & (CR1_DIR | CR1_CMS))) this.refreshOutputs()
        return
      }
      case "SR":
        // Write-zero-to-clear on the flag bits; the rest is read-only.
        return (old & written & 0x1fff) >>> 0
      case "EGR":
        if (written & 1) this.update(true)
        for (let ch = 0; ch < this.channels; ch++) if (written & (2 << ch)) this.ccEvent(ch, true)
        if (written & (1 << 6)) this.flag(1 << 6, DIER_TIE, this.irqOf("trg"))
        return 0
      case "CNT":
        this.cnt = written & this.mask
        this.refreshOutputs()
        return
      case "ARR":
        if ((this.regs[0] & CR1_ARPE) === 0) this.arrShadow = next & this.mask
        return next & this.mask
      case "PSC":
        // Loaded into the shadow at the next update event (or UG).
        return
      case "CCR1":
      case "CCR2":
      case "CCR3":
      case "CCR4": {
        const ch = (d.offset - 0x34) >>> 2
        if (ch >= this.channels) return old
        if (this.isInput(ch)) return old // read-only in capture mode
        if (!this.preload(ch)) {
          this.ccrShadow[ch] = next & this.mask
          this.refreshOutputs()
        }
        return next & this.mask
      }
      case "CCMR1":
      case "CCMR2":
      case "CCER":
      case "BDTR":
        // Store first, then re-derive the outputs from the new configuration.
        this.regs[d.offset >>> 2] = next >>> 0
        this.refreshOutputs()
        return
      case "DIER":
        // Enabling an interrupt whose flag is already up raises it at once (the line is level-sensitive).
        this.regs[d.offset >>> 2] = next >>> 0
        this.checkLines(next & ~old)
        return
    }
  }

  private irqOf(which: "up" | "cc" | "trg" | "brk"): number {
    const irq = this.spec.irq
    return typeof irq === "number" ? irq : irq[which]
  }

  /** Set SR flags and raise the matching interrupt line if enabled in DIER. */
  private flag(bits: number, enable: number, irq: number) {
    this.regs[0x10 >>> 2] |= bits
    if (this.regs[0x0c >>> 2] & enable) this.raiseIrq(irq)
    const kind = enable === DIER_UIE ? "UP" : enable === DIER_TIE ? "TRIG" : `CH${Math.log2(enable)}`
    // The same events are DMA requests when their DIER xDE bits are set (8 = UDE, 9..12 = CCxDE, 14 = TDE).
    if (this.regs[0x0c >>> 2] & (enable << 8)) this.onDmaRequest(kind)
    this.onEvent(kind)
    // Master mode (CR2.MMS): update or OCxREF/CC1 compare pulse on the trigger output.
    const mms = (this.regs[1] >>> 4) & 7
    if ((mms === 2 && kind === "UP") || (mms === 3 && kind === "CH1") || (mms >= 4 && kind === `CH${mms - 3}`)) this.onEvent("TRGO")
  }
  private checkLines(enabled: number) {
    const sr = this.regs[0x10 >>> 2]
    if (enabled & sr & DIER_UIE) this.raiseIrq(this.irqOf("up"))
    if (enabled & sr & 0x1e) this.raiseIrq(this.irqOf("cc"))
    if (enabled & sr & DIER_TIE) this.raiseIrq(this.irqOf("trg"))
  }

  // --- channel configuration ----------------------------------------------------------------

  private ccmr(ch: number) {
    const reg = this.regs[(ch < 2 ? 0x18 : 0x1c) >>> 2]
    return ch & 1 ? reg >>> 8 : reg
  }
  private isInput(ch: number) {
    return (this.ccmr(ch) & 3) !== 0
  }
  private preload(ch: number) {
    return (this.ccmr(ch) & 8) !== 0
  }
  private ocMode(ch: number) {
    return (this.ccmr(ch) >>> 4) & 7
  }
  private ccer() {
    return this.regs[0x20 >>> 2]
  }
  private ccEnabled(ch: number) {
    return (this.ccer() & (1 << (ch * 4))) !== 0
  }
  private ccPolarity(ch: number) {
    return (this.ccer() & (2 << (ch * 4))) !== 0
  }
  private ccnEnabled(ch: number) {
    return (this.ccer() & (4 << (ch * 4))) !== 0
  }
  private ccnPolarity(ch: number) {
    return (this.ccer() & (8 << (ch * 4))) !== 0
  }
  private outputsAllowed() {
    return this.spec.kind !== "advanced" || (this.regs[0x44 >>> 2] & BDTR_MOE) !== 0
  }
  private countingDown() {
    const cr1 = this.regs[0]
    return (cr1 & CR1_CMS) === 0 ? (cr1 & CR1_DIR) !== 0 : (cr1 & CR1_DIR) !== 0
  }

  // --- counting -----------------------------------------------------------------------------
  //
  // The counter is never stepped one tick at a time: a timer at 180 MHz with no prescaler
  // would cost a call per core cycle. Instead the distance to the next event (overflow or a
  // compare match) is computed and the counter jumps there; outputs only change at events.

  /** Advance by `cycles` core clocks. */
  tick(cycles: number) {
    if (!this.running) return
    this.acc += cycles * this.timHz
    const hclk = this.hclkHz
    if (this.acc < hclk) return
    const n = Math.floor(this.acc / hclk)
    this.acc -= n * hclk
    // Prescaler: one counter tick every PSC+1 kernel clocks.
    const div = this.pscShadow + 1
    this.pscCnt += n
    if (this.pscCnt < div) return
    const ticks = Math.floor(this.pscCnt / div)
    this.pscCnt -= ticks * div
    this.advance(ticks)
  }

  /** Core clocks until the next counter event, for sleep skipping. */
  cyclesUntilEvent(): number {
    if (!this.running) return Infinity
    const kernel = this.ticksToEvent() * (this.pscShadow + 1) - this.pscCnt
    return Math.max(1, Math.ceil((kernel * this.hclkHz - this.acc) / this.timHz))
  }

  /** Counter ticks until the next overflow/underflow or compare match (≥ 1). */
  private ticksToEvent(): number {
    const cr1 = this.regs[0]
    const arr = this.arrShadow
    const down = (cr1 & CR1_DIR) !== 0
    const center = (cr1 & CR1_CMS) !== 0
    // Wrap: in edge mode the tick that leaves ARR (or 0); in center mode the tick that reaches it.
    let d = center ? (down ? this.cnt : arr - this.cnt) : down ? this.cnt + 1 : arr - this.cnt + 1
    if (d < 1) d = 1
    for (let ch = 0; ch < this.channels; ch++) {
      if (this.isInput(ch)) continue
      const ccr = this.ccrShadow[ch]
      const dc = down ? this.cnt - ccr : ccr - this.cnt
      if (dc > 0 && dc < d) d = dc
    }
    return d
  }

  /** Move the counter `ticks` ticks, taking every event on the way. */
  private advance(ticks: number) {
    while (ticks > 0 && this.running) {
      const d = this.ticksToEvent()
      const cr1 = this.regs[0]
      const down = (cr1 & CR1_DIR) !== 0
      if (ticks < d) {
        this.cnt = down ? this.cnt - ticks : this.cnt + ticks
        return
      }
      ticks -= d
      const arr = this.arrShadow
      const center = (cr1 & CR1_CMS) !== 0
      // Land on the event.
      if (center) {
        if (down) {
          this.cnt -= d
          if (this.cnt <= 0) {
            this.cnt = 0
            this.regs[0] &= ~CR1_DIR
            this.overflow()
          }
        } else {
          this.cnt += d
          if (this.cnt >= arr) {
            this.cnt = arr
            this.regs[0] |= CR1_DIR
            this.overflow()
          }
        }
      } else if (down) {
        this.cnt -= d
        if (this.cnt < 0) {
          this.cnt = arr
          this.overflow()
        }
      } else {
        this.cnt += d
        if (this.cnt > arr) {
          this.cnt = 0
          this.overflow()
        }
      }
      for (let ch = 0; ch < this.channels; ch++) if (!this.isInput(ch) && this.cnt === this.ccrShadow[ch]) this.ccEvent(ch, false)
      this.refreshOutputs()
    }
  }

  /** Counter wrapped: repetition counter, then the update event. */
  private overflow() {
    if (this.spec.kind === "advanced" && this.rcrCnt > 0) {
      this.rcrCnt--
      return
    }
    this.update(false)
  }

  /** Update event: shadows load, UIF, one-pulse stop. `software` = from EGR.UG. */
  private update(software: boolean) {
    const cr1 = this.regs[0]
    this.pscShadow = this.regs[0x28 >>> 2] & 0xffff
    this.arrShadow = this.regs[0x2c >>> 2] & this.mask
    this.rcrCnt = this.regs[0x30 >>> 2] & 0xff
    for (let ch = 0; ch < this.channels; ch++) if (!this.isInput(ch) && this.preload(ch)) this.ccrShadow[ch] = this.regs[(0x34 + ch * 4) >>> 2] & this.mask
    if (software) {
      this.cnt = cr1 & CR1_DIR && (cr1 & CR1_CMS) === 0 ? this.arrShadow : 0
      this.pscCnt = 0
    }
    if (cr1 & CR1_OPM && !software) {
      this.regs[0] &= ~CR1_CEN
      this.running = false
      this.onRunning(false)
    }
    if (cr1 & CR1_UDIS) return
    // URS: software updates do not flag when only overflow is allowed to.
    if (software && cr1 & CR1_URS) return
    this.flag(SR_UIF, DIER_UIE, this.irqOf("up"))
  }

  /** Capture/compare event on a channel: flag, interrupt, and the output-compare action. */
  private ccEvent(ch: number, software: boolean) {
    const bit = 2 << ch
    const sr = this.regs[0x10 >>> 2]
    if (sr & bit) this.regs[0x10 >>> 2] |= bit << 8 // overcapture
    this.flag(bit, bit, this.irqOf("cc"))
    if (this.isInput(ch)) {
      if (software) this.regs[(0x34 + ch * 4) >>> 2] = this.cnt >>> 0
      return
    }
    switch (this.ocMode(ch)) {
      case 1:
        this.ref[ch] = true
        break
      case 2:
        this.ref[ch] = false
        break
      case 3:
        this.ref[ch] = !this.ref[ch]
        break
    }
  }

  // --- outputs ------------------------------------------------------------------------------

  /** Re-derive every OCxREF that depends on CNT (PWM, forced modes) and push the pin levels. */
  private refreshOutputs() {
    if (!this.channels) return
    const down = this.countingDown()
    for (let ch = 0; ch < this.channels; ch++) {
      if (this.isInput(ch)) {
        this.drive(ch, null, null)
        continue
      }
      switch (this.ocMode(ch)) {
        case 4:
          this.ref[ch] = false
          break
        case 5:
          this.ref[ch] = true
          break
        case 6: // PWM 1: active while CNT < CCR (up) / CNT <= CCR (down)
          this.ref[ch] = down ? this.cnt <= this.ccrShadow[ch] : this.cnt < this.ccrShadow[ch]
          break
        case 7: // PWM 2: the inverse
          this.ref[ch] = down ? this.cnt > this.ccrShadow[ch] : this.cnt >= this.ccrShadow[ch]
          break
      }
      const allowed = this.outputsAllowed()
      const out = allowed && this.ccEnabled(ch) ? this.ref[ch] !== this.ccPolarity(ch) : null
      const outN = allowed && this.spec.kind === "advanced" && this.ccnEnabled(ch) ? !this.ref[ch] !== this.ccnPolarity(ch) : null
      this.drive(ch, out, outN)
    }
  }

  private drive(ch: number, level: boolean | null, levelN: boolean | null) {
    if (this.outLevel[ch * 2] !== level) {
      this.outLevel[ch * 2] = level
      this.onOutput(ch * 2, level)
    }
    if (this.outLevel[ch * 2 + 1] !== levelN) {
      this.outLevel[ch * 2 + 1] = levelN
      this.onOutput(ch * 2 + 1, levelN)
    }
  }

  private releaseOutputs() {
    for (let i = 0; i < 8; i++) {
      if (this.outLevel[i] !== null) {
        this.outLevel[i] = null
        this.onOutput(i, null)
      }
    }
  }

  // --- input capture ------------------------------------------------------------------------

  /** A pad mapped to channel `ch` changed level (the SoC routes pin changes here). */
  captureInput(ch: number, level: boolean) {
    if (ch >= this.channels || !this.isInput(ch)) return
    const was = this.inLevel[ch]
    this.inLevel[ch] = level
    if (was === level) return
    const rising = level
    const pol = (this.ccer() >>> (ch * 4)) & 0xa // CCxP (bit 1), CCxNP (bit 3)
    const want = pol === 0 ? rising : pol === 2 ? !rising : true // 00 rising, 01 falling, 11 both
    if (!want || !this.ccEnabled(ch) || !this.running) return
    const psc = (this.ccmr(ch) >>> 2) & 3
    if (++this.icCount[ch] < 1 << psc) return
    this.icCount[ch] = 0
    this.regs[(0x34 + ch * 4) >>> 2] = this.cnt >>> 0
    this.ccEvent(ch, false)
  }
}

// --- the STM32F4/F7 timer set -------------------------------------------------------------

export const TIM_SPECS: TimSpec[] = [
  { name: "TIM1", base: 0x40010000, kind: "advanced", apb: 2, irq: { brk: 24, up: 25, trg: 26, cc: 27 } },
  { name: "TIM2", base: 0x40000000, kind: "gp32", apb: 1, irq: 28 },
  { name: "TIM3", base: 0x40000400, kind: "gp16", apb: 1, irq: 29 },
  { name: "TIM4", base: 0x40000800, kind: "gp16", apb: 1, irq: 30 },
  { name: "TIM5", base: 0x40000c00, kind: "gp32", apb: 1, irq: 50 },
  { name: "TIM6", base: 0x40001000, kind: "basic", apb: 1, irq: 54 },
  { name: "TIM7", base: 0x40001400, kind: "basic", apb: 1, irq: 55 },
  { name: "TIM8", base: 0x40010400, kind: "advanced", apb: 2, irq: { brk: 43, up: 44, trg: 45, cc: 46 } },
  { name: "TIM9", base: 0x40014000, kind: "gp2", apb: 2, irq: 24 },
  { name: "TIM10", base: 0x40014400, kind: "gp1", apb: 2, irq: 25 },
  { name: "TIM11", base: 0x40014800, kind: "gp1", apb: 2, irq: 26 },
  { name: "TIM12", base: 0x40001800, kind: "gp2", apb: 1, irq: 43 },
  { name: "TIM13", base: 0x40001c00, kind: "gp1", apb: 1, irq: 44 },
  { name: "TIM14", base: 0x40002000, kind: "gp1", apb: 1, irq: 45 },
]

/**
 * Channel pads (DS9405 Table 12 / DS10916 Table 13 alternate-function map; the F4 and F7
 * agree on every timer pin). "PA8:1" = PA8 with AF1. `n` marks a complementary output.
 */
const PADS: Record<string, string> = {
  TIM1: "CH1 PA8 PE9; CH2 PA9 PE11; CH3 PA10 PE13; CH4 PA11 PE14; CH1n PA7 PB13 PE8; CH2n PB0 PB14 PE10; CH3n PB1 PB15 PE12 @1",
  TIM2: "CH1 PA0 PA5 PA15; CH2 PA1 PB3; CH3 PA2 PB10; CH4 PA3 PB11 @1",
  TIM3: "CH1 PA6 PB4 PC6; CH2 PA7 PB5 PC7; CH3 PB0 PC8; CH4 PB1 PC9 @2",
  TIM4: "CH1 PB6 PD12; CH2 PB7 PD13; CH3 PB8 PD14; CH4 PB9 PD15 @2",
  TIM5: "CH1 PA0 PH10; CH2 PA1 PH11; CH3 PA2 PH12; CH4 PA3 PI0 @2",
  TIM8: "CH1 PC6 PI5; CH2 PC7 PI6; CH3 PC8 PI7; CH4 PC9 PI2; CH1n PA5 PA7 PH13; CH2n PB0 PB14 PH14; CH3n PB1 PB15 PH15 @3",
  TIM9: "CH1 PA2 PE5; CH2 PA3 PE6 @3",
  TIM10: "CH1 PB8 PF6 @3",
  TIM11: "CH1 PB9 PF7 @3",
  TIM12: "CH1 PB14 PH6; CH2 PB15 PH9 @9",
  TIM13: "CH1 PA6 PF8 @9",
  TIM14: "CH1 PA7 PF9 @9",
}

export function timPads(name: string): TimPad[] {
  const spec = PADS[name]
  if (!spec) return []
  const [body, afText] = spec.split("@")
  const af = Number(afText)
  const out: TimPad[] = []
  for (const group of body.split(";")) {
    const [tag, ...pads] = group.trim().split(/\s+/)
    const m = /^CH(\d)(n?)$/.exec(tag)!
    const channel = Number(m[1]) - 1
    const complementary = m[2] === "n"
    for (const p of pads) {
      const pm = /^P([A-K])(\d+)$/.exec(p)!
      out.push({ port: "ABCDEFGHIJK".indexOf(pm[1]), pin: Number(pm[2]), af, channel, complementary })
    }
  }
  return out
}
