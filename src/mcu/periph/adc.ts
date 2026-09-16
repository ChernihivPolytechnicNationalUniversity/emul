/**
 * ADC1–3 with their common block (RM0090 §13, RM0385 §15 — the same converter), and the
 * two-channel DAC (RM0090 §14).
 *
 * ADC: regular sequences (SQR1–3, up to 16 conversions, scan, continuous, discontinuous),
 * injected sequences (JSQR, offsets), software start and external triggers from timer
 * events, sampling times from SMPR, 6/8/10/12-bit resolution, alignment, EOC/EOCS, JEOC,
 * overrun, the analog watchdog, interrupts and DMA requests. The sample is the pad's net
 * voltage as the circuit solver has it, or the internal channels (VREFINT, temperature
 * sensor, VBAT). The ADC clock comes from PCLK2 through CCR.ADCPRE.
 *
 * DAC: DHR12R/L, DHR8, dual registers, DOR, software and timer triggers, DMA requests, the
 * output as a voltage the pad drives (buffer on/off makes no difference here).
 *
 * Not modelled (reported through `onUnsupported`): multi-ADC modes (CCR.MULTI), the
 * temperature sensor's real curve (fixed 25 °C), DAC noise/triangle wave generation.
 */
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"
import { WordPeripheral } from "../bus"

// --- ADC ---------------------------------------------------------------------------------------

const ADC_REGS: RegDef[] = [
  { name: "SR", offset: 0x00, rw: 0x3f },
  { name: "CR1", offset: 0x04, rw: 0x07c0ffff },
  { name: "CR2", offset: 0x08, rw: 0x7f7f0f03 },
  { name: "SMPR1", offset: 0x0c, rw: 0x07ffffff },
  { name: "SMPR2", offset: 0x10, rw: 0x3fffffff },
  { name: "JOFR1", offset: 0x14, rw: 0xfff },
  { name: "JOFR2", offset: 0x18, rw: 0xfff },
  { name: "JOFR3", offset: 0x1c, rw: 0xfff },
  { name: "JOFR4", offset: 0x20, rw: 0xfff },
  { name: "HTR", offset: 0x24, reset: 0xfff, rw: 0xfff },
  { name: "LTR", offset: 0x28, rw: 0xfff },
  { name: "SQR1", offset: 0x2c, rw: 0x00ffffff },
  { name: "SQR2", offset: 0x30, rw: 0x3fffffff },
  { name: "SQR3", offset: 0x34, rw: 0x3fffffff },
  { name: "JSQR", offset: 0x38, rw: 0x3fffff },
  { name: "JDR1", offset: 0x3c, rw: 0 },
  { name: "JDR2", offset: 0x40, rw: 0 },
  { name: "JDR3", offset: 0x44, rw: 0 },
  { name: "JDR4", offset: 0x48, rw: 0 },
  { name: "DR", offset: 0x4c, rw: 0 },
]
const SR_AWD = 1 << 0
const SR_EOC = 1 << 1
const SR_JEOC = 1 << 2
const SR_JSTRT = 1 << 3
const SR_STRT = 1 << 4
const SR_OVR = 1 << 5
const CR1_EOCIE = 1 << 5
const CR1_AWDIE = 1 << 6
const CR1_JEOCIE = 1 << 7
const CR1_SCAN = 1 << 8
const CR1_AWDSGL = 1 << 9
const CR1_JAUTO = 1 << 10
const CR1_DISCEN = 1 << 11
const CR1_JAWDEN = 1 << 22
const CR1_AWDEN = 1 << 23
const CR1_OVRIE = 1 << 26
const CR2_ADON = 1 << 0
const CR2_CONT = 1 << 1
const CR2_DMA = 1 << 8
const CR2_EOCS = 1 << 10
const CR2_ALIGN = 1 << 11
const CR2_JSWSTART = 1 << 22
const CR2_SWSTART = 1 << 30

/** Sampling cycles per SMPx code, and the successive-approximation cycles per resolution. */
const SAMPLE_CYCLES = [3, 15, 28, 56, 84, 112, 144, 480]
const CONVERT_CYCLES = [12, 10, 8, 6]

/** External trigger sources by EXTSEL (RM0090 table 46). */
export const ADC_EXT_TRIGGERS = ["TIM1_CH1", "TIM1_CH2", "TIM1_CH3", "TIM2_CH2", "TIM2_CH3", "TIM2_CH4", "TIM2_TRGO", "TIM3_CH1", "TIM3_TRGO", "TIM4_CH4", "TIM5_CH1", "TIM5_CH2", "TIM5_CH3", "TIM8_CH1", "TIM8_TRGO", "EXTI11"]
const ADC_JEXT_TRIGGERS = ["TIM1_CH4", "TIM1_TRGO", "TIM2_CH1", "TIM2_TRGO", "TIM3_CH2", "TIM3_CH4", "TIM4_CH1", "TIM4_CH2", "TIM4_CH3", "TIM4_TRGO", "TIM5_CH4", "TIM5_TRGO", "TIM8_CH2", "TIM8_CH3", "TIM8_CH4", "EXTI15"]

export type AdcChannel = { port: number; pin: number }

/** Channel → pad for ADC1/2 (DS9405 table 12); ADC3 differs on channels 4–9, 14, 15. */
const ADC12_PADS: (string | null)[] = ["PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7", "PB0", "PB1", "PC0", "PC1", "PC2", "PC3", "PC4", "PC5"]
const ADC3_PADS: (string | null)[] = ["PA0", "PA1", "PA2", "PA3", "PF6", "PF7", "PF8", "PF9", "PF10", "PF3", "PC0", "PC1", "PC2", "PC3", "PF4", "PF5"]

export function adcPad(adc: number, channel: number): AdcChannel | null {
  const name = (adc === 3 ? ADC3_PADS : ADC12_PADS)[channel]
  if (!name) return null
  return { port: "ABCDEFGHIJK".indexOf(name[1]), pin: Number(name.slice(2)) }
}

export class Adc extends RegBlock implements Clocked {
  readonly index: number
  private common: AdcCommon
  /** Regular group: index of the next conversion in SQR order (kept across discontinuous triggers), whether one is in progress, cycles to its end. */
  private regNext = 0
  private regBusy = false
  private due = Infinity
  /** Injected sequence in progress. */
  private injPos = -1
  private injDue = Infinity
  private dr = 0
  private jdr = [0, 0, 0, 0]
  private pclk2Hz = 16e6
  private hclkHz = 16e6
  private active = false

  raiseIrq: (irq: number) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  onActive: (on: boolean) => void = () => {}
  onUnsupported: (what: string) => void = () => {}
  onDmaRequest: () => void = () => {}
  /** Volts on a channel's pad, or null when nothing is known about it (reads as 0 V). */
  readVolts: (channel: number) => number | null = () => null
  vref = 3.3

  constructor(index: number, base: number, common: AdcCommon) {
    super(`ADC${index}`, base, 0x100, ADC_REGS)
    this.index = index
    this.common = common
  }

  setClock(pclk2Hz: number, hclkHz: number) {
    this.pclk2Hz = pclk2Hz
    this.hclkHz = hclkHz
  }

  reset() {
    super.reset()
    if (this.jdr === undefined) return
    this.regNext = 0
    this.regBusy = false
    this.injPos = -1
    this.due = this.injDue = Infinity
    this.dr = 0
    this.jdr = [0, 0, 0, 0]
    this.setActive(false)
  }

  // --- configuration ------------------------------------------------------------------------

  private cr1() {
    return this.regs[1]
  }
  private cr2() {
    return this.regs[2]
  }
  private resolutionBits() {
    return 12 - 2 * ((this.cr1() >>> 24) & 3)
  }
  /** Core cycles one conversion of `channel` takes. */
  private conversionCycles(channel: number) {
    const smpr = channel < 10 ? this.regs[0x10 >>> 2] >>> (channel * 3) : this.regs[0x0c >>> 2] >>> ((channel - 10) * 3)
    const adcCycles = SAMPLE_CYCLES[smpr & 7] + CONVERT_CYCLES[(this.cr1() >>> 24) & 3]
    const adcHz = this.pclk2Hz / (2 * (((this.common.ccr >>> 16) & 3) + 1))
    return (adcCycles * this.hclkHz) / adcHz
  }
  /** Regular sequence as channel numbers. */
  private regularSequence(): number[] {
    const len = ((this.regs[0x2c >>> 2] >>> 20) & 0xf) + 1
    const out: number[] = []
    for (let i = 0; i < len; i++) {
      const reg = i < 6 ? this.regs[0x34 >>> 2] : i < 12 ? this.regs[0x30 >>> 2] : this.regs[0x2c >>> 2]
      out.push((reg >>> ((i % 6) * 5)) & 0x1f)
    }
    return out
  }
  /** Injected sequence: JL+1 channels taken from the top of JSQR (JSQ4 is always last). */
  private injectedSequence(): number[] {
    const jsqr = this.regs[0x38 >>> 2]
    const len = ((jsqr >>> 20) & 3) + 1
    const out: number[] = []
    for (let i = 4 - len; i < 4; i++) out.push((jsqr >>> (i * 5)) & 0x1f)
    return out
  }
  /** External trigger name for the regular group, or null when EXTEN is off. */
  get regularTrigger(): string | null {
    const cr2 = this.cr2()
    return (cr2 >>> 28) & 3 ? ADC_EXT_TRIGGERS[(cr2 >>> 24) & 0xf] : null
  }
  get injectedTrigger(): string | null {
    const cr2 = this.cr2()
    return (cr2 >>> 20) & 3 ? ADC_JEXT_TRIGGERS[(cr2 >>> 16) & 0xf] : null
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
      case "DR":
        // Reading DR clears EOC.
        this.regs[0] &= ~SR_EOC
        return this.dr
      case "JDR1":
      case "JDR2":
      case "JDR3":
      case "JDR4":
        return this.jdr[Number(d.name[3]) - 1]
      default:
        return current
    }
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "SR":
        // Write-zero-to-clear.
        return (old & written) >>> 0
      case "CR2": {
        // SWSTART/JSWSTART are actions, read as 0 once taken.
        const v = (next & ~(CR2_SWSTART | CR2_JSWSTART)) >>> 0
        this.regs[2] = v
        if (!(v & CR2_ADON)) {
          if (old & CR2_ADON) this.stopAll()
          return v
        }
        if (written & CR2_SWSTART) this.startRegular()
        if (written & CR2_JSWSTART) this.startInjected()
        return v
      }
      case "CR1":
        this.regs[1] = next
        this.checkIrq()
        return
    }
  }

  private checkIrq() {
    const sr = this.regs[0]
    const cr1 = this.cr1()
    if ((cr1 & CR1_EOCIE && sr & SR_EOC) || (cr1 & CR1_JEOCIE && sr & SR_JEOC) || (cr1 & CR1_AWDIE && sr & SR_AWD) || (cr1 & CR1_OVRIE && sr & SR_OVR)) this.raiseIrq(18)
  }
  private flag(bits: number) {
    this.regs[0] |= bits
    this.checkIrq()
  }

  // --- conversions ------------------------------------------------------------------------------

  /** Trigger from a timer event / EXTI line: starts the group whose EXTSEL names it. */
  trigger(source: string) {
    if (!(this.cr2() & CR2_ADON)) return
    if (this.regularTrigger === source) this.startRegular()
    if (this.injectedTrigger === source) this.startInjected()
  }

  private startRegular() {
    if (this.regBusy) return
    this.flag(SR_STRT)
    const seq = this.regularSequence()
    if (this.regNext >= seq.length) this.regNext = 0
    this.regBusy = true
    this.due = this.conversionCycles(seq[this.regNext])
    this.setActive(true)
  }

  private startInjected() {
    if (this.injPos >= 0) return
    this.flag(SR_JSTRT)
    this.injPos = 0
    this.injDue = this.conversionCycles(this.injectedSequence()[0])
    this.setActive(true)
  }

  private stopAll() {
    this.regNext = 0
    this.regBusy = false
    this.injPos = -1
    this.due = this.injDue = Infinity
    this.setActive(false)
  }

  /** One sample of `channel`, converted at the current resolution. */
  private sample(channel: number): number {
    let volts: number
    if (channel === 16) volts = this.common.ccr & (1 << 23) ? 0.76 : 0 // temperature sensor at 25 °C
    else if (channel === 17) volts = this.common.ccr & (1 << 23) ? 1.21 : 0 // VREFINT
    else if (channel === 18) volts = this.common.ccr & (1 << 22) ? this.vref / 4 : 0 // VBAT/4 on F42x
    else volts = this.readVolts(channel) ?? 0
    const bits = this.resolutionBits()
    const full = (1 << bits) - 1
    return Math.max(0, Math.min(full, Math.round((volts / this.vref) * full)))
  }

  private aligned(value: number) {
    return this.cr2() & CR2_ALIGN ? (value << (16 - this.resolutionBits())) & 0xffff : value
  }

  private watchdog(channel: number, value: number, injected: boolean) {
    const cr1 = this.cr1()
    if (!(cr1 & (injected ? CR1_JAWDEN : CR1_AWDEN))) return
    if (cr1 & CR1_AWDSGL && (cr1 & 0x1f) !== channel) return
    if (value > (this.regs[0x24 >>> 2] & 0xfff) || value < (this.regs[0x28 >>> 2] & 0xfff)) this.flag(SR_AWD)
  }

  /** The regular conversion in progress finished. */
  private regularDone() {
    const seq = this.regularSequence()
    const channel = seq[this.regNext]
    const value = this.sample(channel)
    this.watchdog(channel, value, false)
    if (this.regs[0] & SR_EOC) this.flag(SR_OVR)
    this.dr = this.aligned(value)
    const cr1 = this.cr1()
    const cr2 = this.cr2()
    // Without SCAN only the first channel of the sequence is converted.
    const last = this.regNext === seq.length - 1 || !(cr1 & CR1_SCAN)
    this.regNext = last ? 0 : this.regNext + 1
    if (cr2 & CR2_EOCS || last) this.flag(SR_EOC)
    if (cr2 & CR2_DMA) this.onDmaRequest()
    if (!last) {
      // Discontinuous: DISCNUM conversions per trigger, then wait for the next one.
      if (cr1 & CR1_DISCEN && this.regNext % (((cr1 >>> 13) & 7) + 1) === 0) {
        this.regBusy = false
        this.due = Infinity
        return
      }
      this.due = this.conversionCycles(seq[this.regNext])
      return
    }
    if (cr1 & CR1_JAUTO) this.startInjected()
    if (cr2 & CR2_CONT) {
      this.due = this.conversionCycles(seq[0])
      return
    }
    this.regBusy = false
    this.due = Infinity
  }

  private injectedDone() {
    const seq = this.injectedSequence()
    const channel = seq[this.injPos]
    const value = this.sample(channel)
    this.watchdog(channel, value, true)
    const offset = this.regs[(0x14 + this.injPos * 4) >>> 2] & 0xfff
    this.jdr[this.injPos] = this.aligned(Math.max(0, value - offset))
    if (this.injPos < seq.length - 1) {
      this.injPos++
      this.injDue = this.conversionCycles(seq[this.injPos])
      return
    }
    this.injPos = -1
    this.injDue = Infinity
    this.flag(SR_JEOC)
  }

  // --- clocking -------------------------------------------------------------------------------

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  tick(cycles: number) {
    if (this.regBusy) {
      this.due -= cycles
      while (this.regBusy && this.due <= 0) {
        const carry = this.due
        this.regularDone()
        if (this.regBusy) this.due += carry
      }
    }
    if (this.injPos >= 0) {
      this.injDue -= cycles
      while (this.injPos >= 0 && this.injDue <= 0) {
        const carry = this.injDue
        this.injectedDone()
        if (this.injPos >= 0) this.injDue += carry
      }
    }
    if (!this.regBusy && this.injPos < 0) this.setActive(false)
  }

  cyclesUntilEvent(): number {
    const d = Math.min(this.regBusy ? this.due : Infinity, this.injPos >= 0 ? this.injDue : Infinity)
    return d === Infinity ? Infinity : Math.max(1, Math.ceil(d))
  }
}

/** The ADC common registers (CSR/CCR/CDR at 0x300). */
export class AdcCommon {
  ccr = 0
  onUnsupported: (what: string) => void = () => {}
  read(offset: number, adcs: Adc[]): number {
    switch (offset) {
      case 0x00: {
        // CSR: the three status registers' low bits side by side.
        let v = 0
        for (let i = 0; i < adcs.length; i++) v |= (adcs[i].get("SR") & 0x3f) << (i * 8)
        return v >>> 0
      }
      case 0x04:
        return this.ccr
      case 0x08:
        return adcs.length > 1 ? (adcs[0].get("DR") | (adcs[1].get("DR") << 16)) >>> 0 : 0
      default:
        return 0
    }
  }
  write(offset: number, value: number) {
    if (offset !== 0x04) return
    if (value & 0x1f && !(this.ccr & 0x1f)) this.onUnsupported("ADC multi-mode")
    this.ccr = value & 0x00c3ff1f
  }
  reset() {
    this.ccr = 0
  }
}

/** ADC1–3 and the common block share one 1 KB window; this routes by offset. */
export class AdcBlock extends WordPeripheral {
  readonly adcs: Adc[]
  readonly common: AdcCommon
  constructor(base: number, count: number) {
    super("ADC", base, 0x400)
    this.common = new AdcCommon()
    this.adcs = Array.from({ length: count }, (_, i) => new Adc(i + 1, base + i * 0x100, this.common))
  }
  reset() {
    this.common.reset()
    for (const a of this.adcs) a.reset()
  }
  readWord(offset: number): number {
    const i = offset >>> 8
    if (i === 3) return this.common.read(offset & 0xff, this.adcs)
    return this.adcs[i] ? this.adcs[i].read(offset & 0xff, 4) : 0
  }
  writeWord(offset: number, value: number): void {
    const i = offset >>> 8
    if (i === 3) this.common.write(offset & 0xff, value)
    else this.adcs[i]?.write(offset & 0xff, value, 4)
  }
}

// --- DAC ---------------------------------------------------------------------------------------

const DAC_REGS: RegDef[] = [
  { name: "CR", offset: 0x00, rw: 0x3fff3fff },
  { name: "SWTRIGR", offset: 0x04, rw: 0 },
  { name: "DHR12R1", offset: 0x08, rw: 0xfff },
  { name: "DHR12L1", offset: 0x0c, rw: 0xfff0 },
  { name: "DHR8R1", offset: 0x10, rw: 0xff },
  { name: "DHR12R2", offset: 0x14, rw: 0xfff },
  { name: "DHR12L2", offset: 0x18, rw: 0xfff0 },
  { name: "DHR8R2", offset: 0x1c, rw: 0xff },
  { name: "DHR12RD", offset: 0x20, rw: 0x0fff0fff },
  { name: "DHR12LD", offset: 0x24, rw: 0xfff0fff0 },
  { name: "DHR8RD", offset: 0x28, rw: 0xffff },
  { name: "DOR1", offset: 0x2c, rw: 0 },
  { name: "DOR2", offset: 0x30, rw: 0 },
  { name: "SR", offset: 0x34, rw: 0 },
]
/** Trigger sources by TSEL (RM0090 table 76). */
export const DAC_TRIGGERS = ["TIM6_TRGO", "TIM8_TRGO", "TIM7_TRGO", "TIM5_TRGO", "TIM2_TRGO", "TIM4_TRGO", "EXTI9", "SWTRIG"]
export const DAC_PADS = ["PA4", "PA5"]

export class Dac extends RegBlock {
  /** Holding and output registers per channel. */
  private dhr = [0, 0]
  private dor = [0, 0]
  vref = 3.3
  /** A channel's output voltage changed (or the channel turned on/off: null). */
  onOutput: (channel: number, volts: number | null) => void = () => {}
  onDmaRequest: (channel: number) => void = () => {}
  onUnsupported: (what: string) => void = () => {}

  constructor() {
    super("DAC", 0x40007400, 0x400, DAC_REGS)
  }

  reset() {
    super.reset()
    if (this.dor === undefined) return
    this.dhr = [0, 0]
    this.dor = [0, 0]
    this.onOutput(0, null)
    this.onOutput(1, null)
  }

  private enabled(ch: number) {
    return (this.regs[0] & (1 << (ch * 16))) !== 0
  }
  private triggered(ch: number) {
    return (this.regs[0] & (4 << (ch * 16))) !== 0
  }
  /** Trigger source name of a channel, or null. */
  triggerOf(ch: number): string | null {
    return this.enabled(ch) && this.triggered(ch) ? DAC_TRIGGERS[(this.regs[0] >>> (ch * 16 + 3)) & 7] : null
  }
  volts(ch: number): number | null {
    return this.enabled(ch) ? (this.dor[ch] / 4095) * this.vref : null
  }

  protected onRead(d: RegDef, current: number): number {
    switch (d.name) {
      case "DOR1":
        return this.dor[0]
      case "DOR2":
        return this.dor[1]
      case "DHR12R1":
        return this.dhr[0]
      case "DHR12R2":
        return this.dhr[1]
      default:
        return current
    }
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "CR":
        this.regs[0] = next
        for (let ch = 0; ch < 2; ch++) {
          const wave = (next >>> (ch * 16 + 6)) & 3
          if (wave && !((old >>> (ch * 16 + 6)) & 3)) this.onUnsupported(`DAC${ch + 1} ${wave === 1 ? "noise" : "triangle"} wave`)
          const on = (next >>> (ch * 16)) & 1
          if (on !== ((old >>> (ch * 16)) & 1)) {
            if (on && !this.triggered(ch)) this.dor[ch] = this.dhr[ch]
            this.onOutput(ch, this.volts(ch))
          }
        }
        return
      case "SWTRIGR":
        if (written & 1) this.trigger("SWTRIG", 0)
        if (written & 2) this.trigger("SWTRIG", 1)
        return 0
      case "DHR12R1":
        return this.load(0, written & 0xfff)
      case "DHR12L1":
        return this.load(0, (written >>> 4) & 0xfff)
      case "DHR8R1":
        return this.load(0, (written & 0xff) << 4)
      case "DHR12R2":
        return this.load(1, written & 0xfff)
      case "DHR12L2":
        return this.load(1, (written >>> 4) & 0xfff)
      case "DHR8R2":
        return this.load(1, (written & 0xff) << 4)
      case "DHR12RD":
        this.load(0, written & 0xfff)
        return this.load(1, (written >>> 16) & 0xfff)
      case "DHR12LD":
        this.load(0, (written >>> 4) & 0xfff)
        return this.load(1, (written >>> 20) & 0xfff)
      case "DHR8RD":
        this.load(0, (written & 0xff) << 4)
        return this.load(1, ((written >>> 8) & 0xff) << 4)
    }
  }

  /** A holding register written: without a trigger it goes straight to the output. */
  private load(ch: number, value: number): number {
    this.dhr[ch] = value
    if (this.enabled(ch) && !this.triggered(ch)) this.update(ch)
    return value
  }

  private update(ch: number) {
    if (this.dor[ch] === this.dhr[ch]) return
    this.dor[ch] = this.dhr[ch]
    this.onOutput(ch, this.volts(ch))
  }

  /** A trigger event by name (timer TRGO, EXTI line 9, software). */
  trigger(source: string, only?: number) {
    for (let ch = 0; ch < 2; ch++) {
      if (only !== undefined && only !== ch) continue
      if (this.triggerOf(ch) !== source) continue
      this.update(ch)
      if (this.regs[0] & (1 << (ch * 16 + 12))) this.onDmaRequest(ch)
    }
  }
}
