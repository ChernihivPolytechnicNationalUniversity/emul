/**
 * ADC1–3 with their common block (RM0090 §13, RM0385 §15 — the same converter), and the
 * two-channel DAC (RM0090 §14, RM0385 §16).
 *
 * ADC: regular sequences (SQR1–3, up to 16 conversions, scan, continuous, discontinuous),
 * injected sequences (JSQR, offsets), software start and external triggers from timer
 * events and EXTI lines by the chip's own EXTSEL/JEXTSEL tables, sampling times from SMPR,
 * 6/8/10/12-bit resolution, alignment, EOC/EOCS, JEOC, overrun, the analog watchdog,
 * interrupts and DMA requests, and the multi-ADC modes of CCR.MULTI with CDR and its DMA
 * modes. The sample is the pad's net voltage as the circuit solver has it, or the internal
 * channels (VREFINT, temperature sensor, VBAT), charged onto the sampling capacitor through
 * the source and with the chip's noise where its profile has them. The ADC clock comes from
 * PCLK2 through CCR.ADCPRE.
 *
 * DAC: DHR12R/L, DHR8, dual registers, DOR, software, timer and EXTI9 triggers, DMA
 * requests, noise (LFSR) and triangle wave generation, the output as a voltage the pad drives.
 */
import type { AdcProfile, DacProfile, NoiseMixture } from "../chip"
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"
import { WordPeripheral } from "../bus"

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
const CR1_JDISCEN = 1 << 12
const CR1_JAWDEN = 1 << 22
const CR1_AWDEN = 1 << 23
const CR1_OVRIE = 1 << 26
const CR2_ADON = 1 << 0
const CR2_CONT = 1 << 1
const CR2_DMA = 1 << 8
const CR2_DDS = 1 << 9
const CR2_EOCS = 1 << 10
const CR2_ALIGN = 1 << 11
const CR2_JSWSTART = 1 << 22
const CR2_SWSTART = 1 << 30
const CCR_DDS = 1 << 13
const CCR_VBATE = 1 << 22
const CCR_TSVREFE = 1 << 23
const HALF_WORD_BITS = 16
const BYTE_BITS = 8
const SIGN_BITS = 1

const SAMPLE_CYCLES = [3, 15, 28, 56, 84, 112, 144, 480]
const CONVERT_CYCLES = [12, 10, 8, 6]
const SAMPLING_WINDOW_LOSS_CYCLES = 0.5
const NOISE_FULL_SCALE = 4095
const INTERLEAVE_MIN_DELAY_CYCLES = 5
const INTERLEAVE_SAMPLING_GAP_CYCLES = 2

export type AdcChannel = { port: number; pin: number }

export type AdcSource = { volts: number; ohms: number; farads: number; throughDacBuffer: boolean }

const ADC12_PADS: (string | null)[] = ["PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7", "PB0", "PB1", "PC0", "PC1", "PC2", "PC3", "PC4", "PC5"]
const ADC3_PADS: (string | null)[] = ["PA0", "PA1", "PA2", "PA3", "PF6", "PF7", "PF8", "PF9", "PF10", "PF3", "PC0", "PC1", "PC2", "PC3", "PF4", "PF5"]

export function adcPad(adc: number, channel: number): AdcChannel | null {
  const name = (adc === 3 ? ADC3_PADS : ADC12_PADS)[channel]
  if (!name) return null
  return { port: "ABCDEFGHIJK".indexOf(name[1]), pin: Number(name.slice(2)) }
}

const ADC_PAD_KEYS = new Set([...ADC12_PADS, ...ADC3_PADS].flatMap((name) => (name ? ["ABCDEFGHIJK".indexOf(name[1]) * 16 + Number(name.slice(2))] : [])))

export function isAdcPad(port: number, pin: number): boolean {
  return ADC_PAD_KEYS.has(port * 16 + pin)
}

export class MixtureNoise {
  private a = 0
  private b = 0
  private c = 0
  private d = 0
  private readonly seed: number

  constructor(seed: number) {
    this.seed = seed >>> 0
    this.reseed()
  }

  reseed() {
    this.a = 0x9e3779b9
    this.b = 0x243f6a88
    this.c = 0xb7e15162
    this.d = this.seed
    for (let i = 0; i < 16; i++) this.uniform()
  }

  uniform(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return (t >>> 0) / 4294967296
  }

  private irwinHallNormal(): number {
    let sum = 0
    for (let i = 0; i < 12; i++) sum += this.uniform()
    return sum - 6
  }

  draw(mixture: NoiseMixture): number {
    let pick = this.uniform()
    let k = 0
    while (k < mixture.weights.length - 1 && pick >= mixture.weights[k]) {
      pick -= mixture.weights[k]
      k++
    }
    return mixture.sigmasLsb[k] * this.irwinHallNormal()
  }
}

export type SampleHold = { switchOhms: number; farads: number }

export function heldVolts(previous: number, source: { volts: number; ohms: number; farads: number }, hold: SampleHold, seconds: number): number {
  const error = previous - source.volts
  if (error === 0 || seconds <= 0) return previous
  const ga = 1 / hold.switchOhms
  const gs = source.ohms > 0 ? 1 / source.ohms : Infinity
  const ca = hold.farads
  const cp = source.farads
  if (!(cp > 0) || gs === Infinity) {
    if (gs === 0) return previous
    const tau = (Number.isFinite(gs) ? source.ohms + hold.switchOhms : hold.switchOhms) * ca
    return source.volts + error * Math.exp(-seconds / tau)
  }
  const m00 = -(gs + ga) / cp
  const m11 = -ga / ca
  const det = (gs * ga) / (cp * ca)
  const tr = m00 + m11
  const root = Math.sqrt(Math.max(0, tr * tr - 4 * det))
  const l2 = (tr - root) / 2
  const l1 = det / l2
  if (root <= 1e-12 * Math.abs(tr)) return source.volts + error * Math.exp(-seconds / ((source.ohms + hold.switchOhms) * ca))
  const e1 = Math.exp(l1 * seconds)
  const e2 = Math.exp(l2 * seconds)
  const remaining = (l1 * e2 - l2 * e1 + (e1 - e2) * m11) / (l1 - l2)
  return source.volts + error * remaining
}

export function rainMaxOhms(samplingCycles: number, adcHz: number, bits: number, hold: SampleHold): number {
  return (samplingCycles - SAMPLING_WINDOW_LOSS_CYCLES) / (adcHz * hold.farads * Math.log(2 ** (bits + 2))) - hold.switchOhms
}

type MultiKind = "independent" | "regular+injected" | "regular+alternate" | "injected" | "regular" | "interleaved" | "alternate"

const MULTI_KINDS: Record<number, MultiKind> = { 0: "independent", 1: "regular+injected", 2: "regular+alternate", 5: "injected", 6: "regular", 7: "interleaved", 9: "alternate" }

export class Adc extends RegBlock implements Clocked {
  readonly index: number
  private common: AdcCommon
  private readonly profile: AdcProfile
  private regNext = 0
  private regBusy = false
  private regInterrupted = false
  private due = Infinity
  private injPos = -1
  private injResume = 0
  private injDue = Infinity
  private startDue = Infinity
  private dr = 0
  private dmaRequestPending = false
  private dmaPastLastTransfer = false
  private jdr = [0, 0, 0, 0]
  private pclk2Hz = 16e6
  private hclkHz = 16e6
  private active = false
  private held = 0
  private readonly noise: MixtureNoise | null
  private readonly reported = new Set<string>()
  readonly converted = { regular: 0, injected: 0 }

  raiseIrq: (irq: number) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  onActive: (on: boolean) => void = () => {}
  onUnsupported: (what: string) => void = () => {}
  onDmaRequest: () => void = () => {}
  dmaTransfersLeft: () => number = () => Infinity
  readSource: (channel: number) => AdcSource | null = () => null
  vref = 3.3
  internal = { vrefint: 1.21, temperature: 0.76 }
  vbat = 3.3

  constructor(index: number, base: number, common: AdcCommon, profile: AdcProfile) {
    super(`ADC${index}`, base, 0x100, ADC_REGS)
    this.index = index
    this.common = common
    this.profile = profile
    this.noise = profile.noise ? new MixtureNoise(profile.noise.seed + index) : null
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
    this.regInterrupted = false
    this.injPos = -1
    this.injResume = 0
    this.due = this.injDue = this.startDue = Infinity
    this.dr = 0
    this.dmaRequestPending = false
    this.dmaPastLastTransfer = false
    this.jdr = [0, 0, 0, 0]
    this.held = 0
    this.noise?.reseed()
    this.reported.clear()
    this.converted.regular = this.converted.injected = 0
    this.setActive(false)
  }

  private cr1() {
    return this.regs[1]
  }
  private cr2() {
    return this.regs[2]
  }
  private resolutionBits() {
    return 12 - 2 * ((this.cr1() >>> 24) & 3)
  }
  private adcHz() {
    return this.pclk2Hz / (2 * (((this.common.ccr >>> 16) & 3) + 1))
  }
  private samplingCycles(channel: number) {
    const smpr = channel < 10 ? this.regs[0x10 >>> 2] >>> (channel * 3) : this.regs[0x0c >>> 2] >>> ((channel - 10) * 3)
    return SAMPLE_CYCLES[smpr & 7]
  }
  private conversionCycles(channel: number) {
    const adcCycles = this.samplingCycles(channel) + CONVERT_CYCLES[(this.cr1() >>> 24) & 3]
    return this.adcToCore(adcCycles)
  }
  private adcToCore(adcCycles: number) {
    return (adcCycles * this.hclkHz) / this.adcHz()
  }
  private regularSequence(): number[] {
    const len = ((this.regs[0x2c >>> 2] >>> 20) & 0xf) + 1
    const out: number[] = []
    for (let i = 0; i < len; i++) {
      const reg = i < 6 ? this.regs[0x34 >>> 2] : i < 12 ? this.regs[0x30 >>> 2] : this.regs[0x2c >>> 2]
      out.push((reg >>> ((i % 6) * 5)) & 0x1f)
    }
    return out
  }
  private injectedSequence(): number[] {
    const jsqr = this.regs[0x38 >>> 2]
    const len = ((jsqr >>> 20) & 3) + 1
    const out: number[] = []
    for (let i = 4 - len; i < 4; i++) out.push((jsqr >>> (i * 5)) & 0x1f)
    return out
  }
  get regularTrigger(): string | null {
    const cr2 = this.cr2()
    return (cr2 >>> 28) & 3 ? (this.profile.regularTriggers[(cr2 >>> 24) & 0xf] ?? null) : null
  }
  get injectedTrigger(): string | null {
    const cr2 = this.cr2()
    return (cr2 >>> 20) & 3 ? (this.profile.injectedTriggers[(cr2 >>> 16) & 0xf] ?? null) : null
  }
  get firstRegularChannel(): number {
    return this.regularSequence()[0]
  }

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return super.read(offset, size)
  }
  peek(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return super.peek(offset, size)
  }
  protected peekValue(d: RegDef, current: number): number {
    return d.name === "DR" ? this.dr : this.onRead(d, current)
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    super.write(offset, value, size)
    this.reschedule()
  }
  get data(): number {
    return this.dr
  }
  get overrunFlagged(): boolean {
    return (this.regs[0] & SR_OVR) !== 0
  }

  dataRead() {
    this.dmaRequestPending = false
    this.regs[0] &= ~SR_EOC
  }
  dmaRequested() {
    this.dmaRequestPending = true
  }
  dmaRequestDropped() {
    this.dmaRequestPending = false
  }

  protected onRead(d: RegDef, current: number): number {
    switch (d.name) {
      case "DR":
        this.dataRead()
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
        return (old & written) >>> 0
      case "CR2": {
        const v = (next & ~(CR2_SWSTART | CR2_JSWSTART)) >>> 0
        this.regs[2] = v
        if (old & CR2_DMA && !(v & CR2_DMA)) this.dmaPastLastTransfer = this.dmaRequestPending = false
        this.reportReservedTriggers(v)
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

  private report(what: string) {
    if (this.reported.has(what)) return
    this.reported.add(what)
    this.onUnsupported(what)
  }

  private reportReservedTriggers(cr2: number) {
    const extsel = (cr2 >>> 24) & 0xf
    const jextsel = (cr2 >>> 16) & 0xf
    if ((cr2 >>> 28) & 3 && this.profile.regularTriggers[extsel] == null) this.report(`ADC${this.index} EXTSEL ${extsel} is reserved on this chip: the regular group never triggers`)
    if ((cr2 >>> 20) & 3 && this.profile.injectedTriggers[jextsel] == null) this.report(`ADC${this.index} JEXTSEL ${jextsel} is reserved on this chip: the injected group never triggers`)
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

  trigger(source: string) {
    if (!(this.cr2() & CR2_ADON)) return
    if (this.regularTrigger === source) this.startRegular()
    if (this.injectedTrigger === source) this.startInjected()
  }

  private startRegular() {
    this.beginRegular()
    if (this.index === 1) this.common.masterStartedRegular(this)
  }

  beginRegular() {
    if (this.regBusy || !(this.cr2() & CR2_ADON) || this.overrunFlagged) return
    this.flag(SR_STRT)
    const seq = this.regularSequence()
    if (this.regNext >= seq.length) this.regNext = 0
    this.regBusy = true
    this.due = this.conversionCycles(seq[this.regNext])
    this.setActive(true)
  }

  beginRegularAfter(adcCycles: number) {
    if (this.regBusy || !(this.cr2() & CR2_ADON)) return
    this.startDue = this.adcToCore(adcCycles)
    this.setActive(true)
  }

  samplingCyclesOfNext(): number {
    const seq = this.regularSequence()
    return this.samplingCycles(seq[this.regNext < seq.length ? this.regNext : 0])
  }

  private startInjected() {
    if (this.index === 1 && this.common.masterStartedInjected(this)) return
    this.beginInjected()
  }

  beginInjected() {
    if (this.injPos >= 0 || !(this.cr2() & CR2_ADON)) return
    const seq = this.injectedSequence()
    if (this.injResume >= seq.length) this.injResume = 0
    this.flag(SR_JSTRT)
    if (this.regBusy) this.regInterrupted = true
    this.injPos = this.injResume
    this.injDue = this.conversionCycles(seq[this.injPos])
    this.setActive(true)
  }

  private stopAll() {
    this.regNext = 0
    this.regBusy = false
    this.regInterrupted = false
    this.injPos = -1
    this.injResume = 0
    this.due = this.injDue = this.startDue = Infinity
    this.setActive(false)
  }

  private source(channel: number): AdcSource {
    const internal = this.index === 1
    const tsvrefe = (this.common.ccr & CCR_TSVREFE) !== 0
    const vbate = (this.common.ccr & CCR_VBATE) !== 0
    const inside = (volts: number): AdcSource => ({ volts, ohms: 0, farads: 0, throughDacBuffer: false })
    // F40x: temperature on IN16, VBAT/2 on IN18; F42x/F7: both on IN18, VBAT/4 winning (RM0090 §13.3.3, §13.10, §13.11).
    if (this.profile.tempOnIn16) {
      if (channel === 16) return inside(internal && tsvrefe ? this.internal.temperature : 0)
      if (channel === 17) return inside(internal && tsvrefe ? this.internal.vrefint : 0)
      if (channel === 18) return inside(internal && vbate ? this.vbat / 2 : 0)
    }
    if (channel === 16) return inside(0)
    if (channel === 17) return inside(internal && tsvrefe ? this.internal.vrefint : 0)
    if (channel === 18) return inside(!internal ? 0 : vbate ? this.vbat / 4 : tsvrefe ? this.internal.temperature : 0)
    return this.readSource(channel) ?? inside(0)
  }

  private sample(channel: number): number {
    const src = this.source(channel)
    const hold = this.profile.sampleHold
    const settled = hold ? heldVolts(this.held, src, hold, (this.samplingCycles(channel) - SAMPLING_WINDOW_LOSS_CYCLES) / this.adcHz()) : src.volts
    this.held = settled
    const noise = this.profile.noise
    const lsb = this.vref / NOISE_FULL_SCALE
    const volts = noise && this.noise ? settled + this.noise.draw(src.throughDacBuffer ? noise.throughDacBuffer : noise.alone) * lsb : settled
    const bits = this.resolutionBits()
    const full = (1 << bits) - 1
    if (!(this.vref > 0)) return volts > 0 ? full : 0
    return Math.max(0, Math.min(full, Math.round((volts / this.vref) * full)))
  }

  private leftAlignedWidth() {
    return this.resolutionBits() === 6 ? BYTE_BITS : HALF_WORD_BITS
  }
  private regularAligned(value: number) {
    return this.cr2() & CR2_ALIGN ? (value << (this.leftAlignedWidth() - this.resolutionBits())) & 0xffff : value
  }
  private injectedAligned(signedValue: number) {
    const shift = this.cr2() & CR2_ALIGN ? this.leftAlignedWidth() - SIGN_BITS - this.resolutionBits() : 0
    return (signedValue << shift) & 0xffff
  }

  private watchdog(channel: number, value: number, injected: boolean) {
    const cr1 = this.cr1()
    if (!(cr1 & (injected ? CR1_JAWDEN : CR1_AWDEN))) return
    if (cr1 & CR1_AWDSGL && (cr1 & 0x1f) !== channel) return
    if (value > (this.regs[0x24 >>> 2] & 0xfff) || value < (this.regs[0x28 >>> 2] & 0xfff)) this.flag(SR_AWD)
  }

  private regularDone() {
    const seq = this.regularSequence()
    const channel = seq[this.regNext]
    const value = this.sample(channel)
    this.converted.regular++
    this.watchdog(channel, value, false)
    const lost = this.dataLost()
    this.dr = this.regularAligned(value)
    if (lost) {
      this.abortOnOverrun()
      return
    }
    const cr1 = this.cr1()
    const cr2 = this.cr2()
    const last = this.regNext === seq.length - 1 || !(cr1 & CR1_SCAN)
    this.regNext = last ? 0 : this.regNext + 1
    if (cr2 & CR2_EOCS || last) this.flag(SR_EOC)
    if (this.requestsDma()) this.requestDma()
    this.common.regularConverted(this)
    if (!last) {
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

  private requestsDma() {
    return (this.cr2() & CR2_DMA) !== 0 && !this.dmaPastLastTransfer
  }

  private dataLost() {
    return this.dmaRequestPending || ((this.cr2() & CR2_EOCS) !== 0 && (this.regs[0] & SR_EOC) !== 0)
  }

  private requestDma() {
    const isLastTransfer = this.dmaTransfersLeft() === 1
    this.dmaRequestPending = true
    this.onDmaRequest()
    if (isLastTransfer && !(this.cr2() & CR2_DDS)) this.dmaPastLastTransfer = true
  }

  private abortOnOverrun() {
    this.flag(SR_OVR)
    this.dmaRequestPending = false
    this.common.memberOverran(this)
    this.regNext = 0
    this.regBusy = false
    this.due = Infinity
  }

  private injectedDone() {
    const seq = this.injectedSequence()
    const channel = seq[this.injPos]
    const value = this.sample(channel)
    this.converted.injected++
    this.watchdog(channel, value, true)
    const offset = this.regs[(0x14 + this.injPos * 4) >>> 2] & 0xfff
    this.jdr[this.injPos] = this.injectedAligned(value - offset)
    if (this.injPos < seq.length - 1) {
      if (this.cr1() & CR1_JDISCEN) {
        this.injResume = this.injPos + 1
        this.injPos = -1
        this.injDue = Infinity
        this.resumeRegular()
        return
      }
      this.injPos++
      this.injDue = this.conversionCycles(seq[this.injPos])
      return
    }
    this.injPos = -1
    this.injResume = 0
    this.injDue = Infinity
    this.flag(SR_JEOC)
    this.resumeRegular()
  }

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  private resumeRegular() {
    if (!this.regInterrupted) return
    this.regInterrupted = false
    if (this.regBusy) this.due = this.conversionCycles(this.regularSequence()[this.regNext])
  }

  tick(cycles: number) {
    let regularCycles = cycles
    if (this.injPos >= 0) {
      this.injDue -= cycles
      regularCycles = 0
      while (this.injPos >= 0 && this.injDue <= 0) {
        const carry = this.injDue
        this.injectedDone()
        if (this.injPos >= 0) this.injDue += carry
        else regularCycles = -carry
      }
    }
    if (this.startDue !== Infinity) {
      this.startDue -= cycles
      if (this.startDue <= 0) {
        const carry = this.startDue
        this.startDue = Infinity
        this.beginRegular()
        if (this.regBusy) this.due += carry + cycles
      }
    }
    if (this.regBusy && this.injPos < 0) {
      this.due -= regularCycles
      while (this.regBusy && this.injPos < 0 && this.due <= 0) {
        const carry = this.due
        this.regularDone()
        if (this.regBusy) this.due += carry
      }
      if (this.injPos >= 0 && this.due < 0) this.due = 0
    }
    if (!this.regBusy && this.injPos < 0 && this.startDue === Infinity) this.setActive(false)
  }

  cyclesUntilEvent(): number {
    const d = Math.min(this.regBusy && this.injPos < 0 ? this.due : Infinity, this.injPos >= 0 ? this.injDue : Infinity, this.startDue)
    return d === Infinity ? Infinity : Math.max(1, Math.ceil(d))
  }
}

export class AdcCommon {
  ccr = 0
  adcs: Adc[] = []
  onUnsupported: (what: string) => void = () => {}
  onDmaRequest: () => void = () => {}
  dmaTransfersLeft: () => number = () => Infinity
  private alternateNext = 0
  private simultaneousDone = 0
  private pairFirst: Adc | null = null
  private readonly requested: Adc[][] = []
  private latest: Adc[] = []
  private dmaPastLastTransfer = false
  private readonly reported = new Set<string>()

  get kind(): MultiKind {
    return MULTI_KINDS[this.ccr & 0xf] ?? "independent"
  }
  private members(): Adc[] {
    if (this.kind === "independent") return []
    return this.adcs.slice(0, this.ccr & 0x10 ? 3 : 2)
  }
  private dmaMode() {
    return (this.ccr >>> 14) & 3
  }
  private dmaModeUnsupported(members: Adc[]) {
    return members.length === 2 && this.dmaMode() === 1
  }
  private regularTogether() {
    const k = this.kind
    return k === "regular" || k === "regular+injected" || k === "regular+alternate"
  }

  private report(what: string) {
    if (this.reported.has(what)) return
    this.reported.add(what)
    this.onUnsupported(what)
  }

  masterStartedRegular(master: Adc) {
    const members = this.members()
    if (this.regularTogether()) {
      for (const slave of members.slice(1)) {
        slave.sync()
        slave.beginRegular()
      }
      return
    }
    if (this.kind !== "interleaved") return
    const spacing = Math.max(INTERLEAVE_MIN_DELAY_CYCLES + ((this.ccr >>> 8) & 0xf), master.samplingCyclesOfNext() + INTERLEAVE_SAMPLING_GAP_CYCLES)
    members.slice(1).forEach((slave, i) => {
      slave.sync()
      slave.beginRegularAfter(spacing * (i + 1))
    })
  }

  masterStartedInjected(master: Adc): boolean {
    const members = this.members()
    const k = this.kind
    if (k === "injected" || k === "regular+injected") {
      master.beginInjected()
      for (const slave of members.slice(1)) {
        slave.sync()
        slave.beginInjected()
      }
      return true
    }
    if (k === "alternate" || k === "regular+alternate") {
      const target = members[this.alternateNext % members.length]
      this.alternateNext = (this.alternateNext + 1) % members.length
      target.sync()
      target.beginInjected()
      return true
    }
    return false
  }

  regularConverted(adc: Adc) {
    const mode = this.dmaMode()
    const members = this.members()
    if (!mode || !members.includes(adc)) return
    if (this.dmaModeUnsupported(members)) {
      this.report("ADC dual mode with CCR.DMA = 01: RM0385 does not support DMA mode 1 in dual mode, no request is issued")
      return
    }
    if (this.regularTogether()) {
      this.simultaneousDone |= 1 << adc.index
      const all = members.reduce((m, a) => m | (1 << a.index), 0)
      if ((this.simultaneousDone & all) !== all) return
      this.simultaneousDone = 0
      for (const a of members) this.push(a, mode)
      return
    }
    if (this.kind === "interleaved") this.push(adc, mode)
  }

  memberOverran(adc: Adc) {
    if (this.members().includes(adc)) this.requested.length = 0
  }

  private dropRequests() {
    for (const adc of this.members()) adc.dmaRequestDropped()
    this.requested.length = 0
  }

  private push(adc: Adc, mode: number) {
    if (mode === 1) {
      this.emit([adc])
      return
    }
    if (this.pairFirst === null) {
      this.pairFirst = adc
      return
    }
    const first = this.pairFirst
    this.pairFirst = null
    this.emit([first, adc])
  }

  private emit(from: Adc[]) {
    this.latest = from
    if (this.dmaPastLastTransfer || this.members().some((a) => a.overrunFlagged)) return
    const isLastTransfer = this.dmaTransfersLeft() - this.requested.length === 1
    this.requested.push(from)
    for (const adc of from) adc.dmaRequested()
    this.onDmaRequest()
    if (isLastTransfer && !(this.ccr & CCR_DDS)) this.dmaPastLastTransfer = true
  }

  private cdrWord([first, second]: Adc[]): number {
    if (!first) return 0
    if (!second) return first.data & 0xffff
    if (this.dmaMode() === 3) return ((second.data & 0xff) << 8) | (first.data & 0xff)
    return (((second.data & 0xffff) << 16) | (first.data & 0xffff)) >>> 0
  }

  private readCdr(peek: boolean): number {
    const next = this.requested[0]
    if (!next) return this.cdrWord(this.latest)
    if (!peek) {
      this.requested.shift()
      for (const adc of next) adc.dataRead()
    }
    return this.cdrWord(next)
  }

  read(offset: number, adcs: Adc[], peek = false): number {
    switch (offset) {
      case 0x00: {
        let v = 0
        for (let i = 0; i < adcs.length; i++) v |= (adcs[i].get("SR") & 0x3f) << (i * 8)
        return v >>> 0
      }
      case 0x04:
        return this.ccr
      case 0x08: {
        if (this.dmaMode()) return this.readCdr(peek)
        return adcs.length > 1 ? (adcs[0].data | (adcs[1].data << 16)) >>> 0 : 0
      }
      default:
        return 0
    }
  }
  write(offset: number, value: number) {
    if (offset !== 0x04) return
    const multi = value & 0x1f
    if (multi && (MULTI_KINDS[multi & 0xf] ?? "independent") === "independent") this.report(`ADC multi-mode MULTI = ${multi.toString(2).padStart(5, "0")} is reserved: the ADCs stay independent`)
    const regrouped = multi !== (this.ccr & 0x1f)
    const dmaOff = ((value >>> 14) & 3) === 0
    if (regrouped || dmaOff) this.dropRequests()
    if (regrouped) {
      this.alternateNext = 0
      this.simultaneousDone = 0
      this.pairFirst = null
    }
    this.ccr = value & 0x00c3ff1f
    if (dmaOff) this.dmaPastLastTransfer = false
  }
  reset() {
    this.ccr = 0
    this.alternateNext = 0
    this.simultaneousDone = 0
    this.pairFirst = null
    this.requested.length = 0
    this.latest = []
    this.dmaPastLastTransfer = false
    this.reported.clear()
  }
}

export class AdcBlock extends WordPeripheral {
  readonly adcs: Adc[]
  readonly common: AdcCommon
  constructor(base: number, count: number, profile: AdcProfile) {
    super("ADC", base, 0x400)
    this.common = new AdcCommon()
    this.adcs = Array.from({ length: count }, (_, i) => new Adc(i + 1, base + i * 0x100, this.common, profile))
    this.common.adcs = this.adcs
  }
  reset() {
    this.common.reset()
    for (const a of this.adcs) a.reset()
  }
  readWord(offset: number): number {
    const i = offset >>> 8
    if (i === 3) {
      for (const a of this.adcs) a.sync()
      return this.common.read(offset & 0xff, this.adcs)
    }
    return this.adcs[i] ? this.adcs[i].read(offset & 0xff, 4) : 0
  }
  peekWord(offset: number): number {
    const i = offset >>> 8
    if (i === 3) {
      for (const a of this.adcs) a.sync()
      return this.common.read(offset & 0xff, this.adcs, true)
    }
    return this.adcs[i] ? this.adcs[i].peek(offset & 0xff, 4) : 0
  }
  writeWord(offset: number, value: number): void {
    const i = offset >>> 8
    if (i === 3) {
      for (const a of this.adcs) a.sync()
      this.common.write(offset & 0xff, value)
    } else this.adcs[i]?.write(offset & 0xff, value, 4)
  }
}

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
export const DAC_TRIGGERS = ["TIM6_TRGO", "TIM8_TRGO", "TIM7_TRGO", "TIM5_TRGO", "TIM2_TRGO", "TIM4_TRGO", "EXTI9", "SWTRIG"]
export const DAC_PADS = ["PA4", "PA5"]
export const DAC_LFSR_PRELOAD = 0xaaa
const DAC_FULL = 4095
const WAVE_NONE = 0
const WAVE_NOISE = 1

export function lfsrNext(lfsr: number): number {
  const allZero = (lfsr & 0xfff) === 0 ? 1 : 0
  const feedback = (lfsr ^ (lfsr >>> 1) ^ (lfsr >>> 4) ^ (lfsr >>> 6) ^ allZero) & 1
  return ((lfsr >>> 1) | (feedback << 11)) & 0xfff
}

export class Dac extends RegBlock {
  private dhr = [0, 0]
  private dor = [0, 0]
  private lfsr = [DAC_LFSR_PRELOAD, DAC_LFSR_PRELOAD]
  private triangle = [0, 0]
  private rising = [true, true]
  private readonly profile: DacProfile
  private readonly reported = new Set<string>()
  vref = 3.3
  onOutput: (channel: number, volts: number | null) => void = () => {}
  onDmaRequest: (channel: number) => void = () => {}
  onUnsupported: (what: string) => void = () => {}

  constructor(profile: DacProfile = {}) {
    super("DAC", 0x40007400, 0x400, DAC_REGS)
    this.profile = profile
  }

  reset() {
    super.reset()
    if (this.dor === undefined) return
    this.dhr = [0, 0]
    this.dor = [0, 0]
    this.resetWave(0)
    this.resetWave(1)
    this.reported.clear()
    this.onOutput(0, null)
    this.onOutput(1, null)
  }

  private resetWave(ch: number) {
    this.lfsr[ch] = DAC_LFSR_PRELOAD
    this.triangle[ch] = 0
    this.rising[ch] = true
  }

  private field(ch: number) {
    return this.regs[0] >>> (ch * 16)
  }
  private enabled(ch: number) {
    return (this.field(ch) & 1) !== 0
  }
  private triggered(ch: number) {
    return (this.field(ch) & 4) !== 0
  }
  private wave(ch: number) {
    return (this.field(ch) >>> 6) & 3
  }
  private amplitudeBits(ch: number) {
    return Math.min(12, ((this.field(ch) >>> 8) & 0xf) + 1)
  }
  buffered(ch: number): boolean {
    return (this.field(ch) & 2) === 0
  }
  triggerOf(ch: number): string | null {
    return this.enabled(ch) && this.triggered(ch) ? DAC_TRIGGERS[(this.field(ch) >>> 3) & 7] : null
  }
  output(ch: number): number {
    return this.dor[ch]
  }
  volts(ch: number): number | null {
    if (!this.enabled(ch)) return null
    const fit = this.profile.buffered
    const reference = Math.max(0, this.vref)
    if (!fit || !this.buffered(ch)) return (this.dor[ch] / DAC_FULL) * reference
    const linear = ((fit.gain * this.dor[ch] + fit.offsetCodes) / DAC_FULL) * reference
    return Math.max(fit.floorVolts, Math.min(reference - fit.headroomVolts, linear))
  }
  setVref(volts: number) {
    this.vref = volts
    for (let ch = 0; ch < 2; ch++) if (this.enabled(ch)) this.onOutput(ch, this.volts(ch))
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
          const was = old >>> (ch * 16)
          const is = next >>> (ch * 16)
          if (((was >>> 6) & 3) !== WAVE_NONE && ((is >>> 6) & 3) === WAVE_NONE) this.resetWave(ch)
          const on = is & 1
          if (on && is & 2 && !this.reported.has(`buffer${ch}`)) {
            this.reported.add(`buffer${ch}`)
            this.onUnsupported(`DAC${ch + 1} with its output buffer off (BOFF${ch + 1}): the pad still drives through the buffered output's 100 Ω, not the datasheet's up to 15 kΩ`)
          }
          if (on !== (was & 1) || (on && (is & 2) !== (was & 2))) {
            if (on && !(was & 1) && !this.triggered(ch)) this.dor[ch] = this.dhr[ch]
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

  private load(ch: number, value: number): number {
    this.dhr[ch] = value
    if (this.enabled(ch) && !this.triggered(ch)) this.show(ch, value)
    return value
  }

  private show(ch: number, code: number) {
    if (this.dor[ch] === code) return
    this.dor[ch] = code
    this.onOutput(ch, this.volts(ch))
  }

  private waveCode(ch: number): number {
    const wave = this.wave(ch)
    if (wave === WAVE_NONE) return this.dhr[ch]
    const bits = this.amplitudeBits(ch)
    if (wave === WAVE_NOISE) {
      const masked = this.lfsr[ch] & ((1 << bits) - 1)
      this.lfsr[ch] = lfsrNext(this.lfsr[ch])
      return Math.min(DAC_FULL, this.dhr[ch] + masked)
    }
    const top = (1 << bits) - 1
    if (this.rising[ch]) {
      this.triangle[ch]++
      if (this.triangle[ch] >= top) {
        this.triangle[ch] = top
        this.rising[ch] = false
      }
    } else {
      this.triangle[ch]--
      if (this.triangle[ch] <= 0) {
        this.triangle[ch] = 0
        this.rising[ch] = true
      }
    }
    return Math.min(DAC_FULL, this.dhr[ch] + this.triangle[ch])
  }

  trigger(source: string, only?: number) {
    for (let ch = 0; ch < 2; ch++) {
      if (only !== undefined && only !== ch) continue
      if (this.triggerOf(ch) !== source) continue
      this.show(ch, this.waveCode(ch))
      if (this.regs[0] & (1 << (ch * 16 + 12))) this.onDmaRequest(ch)
    }
  }
}
