import type { AfMap } from "../chip"
import { RegBlock, type RegDef } from "./regblock"

export type TimKind = "advanced" | "gp32" | "gp16" | "gp2" | "gp1" | "basic"

export type TimVersion = "v1" | "v2"

export type TimSpec = {
  name: string
  base: number
  kind: TimKind
  apb: 1 | 2
  rccBit: number
  irq: number | { brk: number; up: number; trg: number; cc: number }
}

export type TimPad = { port: number; pin: number; af: number; channel: number; complementary?: boolean }

export type TimAuxLine = "ETR" | "BKIN" | "BKIN2"

export type TimAuxPad = { port: number; pin: number; af: number; line: TimAuxLine }

export const TIM_LINE = { TI1: 0, TI2: 1, TI3: 2, TI4: 3, ETR: 4, BKIN: 5, BKIN2: 6 } as const

const LINES = 7

const REG = { CR1: 0, CR2: 1, SMCR: 2, DIER: 3, SR: 4, EGR: 5, CCMR1: 6, CCMR2: 7, CCER: 8, CNT: 9, PSC: 10, ARR: 11, RCR: 12, CCR1: 13, CCR4: 16, BDTR: 17, DCR: 18, DMAR: 19, OR: 20, CCMR3: 21, CCR5: 22, CCR6: 23 } as const

const CR1_CEN = 1
const CR1_UDIS = 2
const CR1_URS = 4
const CR1_OPM = 8
const CR1_DIR = 16
const CR1_CMS = 0x60
const CR1_ARPE = 0x80
const CR1_UIFREMAP = 1 << 11
const CR2_CCPC = 1
const CR2_CCDS = 1 << 3
const CR2_TI1S = 1 << 7
const SR_UIF = 1
const SR_TIF = 1 << 6
const SR_BIF = 1 << 7
const SR_B2IF = 1 << 8
const SR_CC5IF = 1 << 16
const SR_FLAGS_V1 = 0x1fff
const SR_FLAGS_V2 = 0x31fff
const DIER_UIE = 1
const DIER_TIE = 1 << 6
const DIER_BIE = 1 << 7
const SMCR_ECE = 1 << 14
const SMCR_ETP = 1 << 15
const BDTR_DTG = 0xff
const BDTR_LOCK = 0x300
const BDTR_OSSI = 1 << 10
const BDTR_OSSR = 1 << 11
const BDTR_BKE = 1 << 12
const BDTR_BKP = 1 << 13
const BDTR_AOE = 1 << 14
const BDTR_MOE = 1 << 15
const BDTR_BK2E = 1 << 24
const BDTR_BK2P = 1 << 25
const BDTR_LOCKED_AT_1 = BDTR_DTG | BDTR_BKE | BDTR_BKP | BDTR_AOE | (0xf << 16) | (0xf << 20) | BDTR_BK2E | BDTR_BK2P
const BDTR_LOCKED_AT_2 = BDTR_LOCKED_AT_1 | BDTR_OSSI | BDTR_OSSR
const CR2_OIS = 0x5ff00
const CCR5_GROUPING = 0xe0000000
const EGR_UG = 1
const EGR_COMG = 1 << 5
const EGR_TG = 1 << 6
const EGR_BG = 1 << 7
const EGR_B2G = 1 << 8

const SLAVE = { off: 0, encoderTi1: 1, encoderTi2: 2, encoderBoth: 3, reset: 4, gated: 5, trigger: 6, externalClock: 7, resetTrigger: 8 } as const
const TRIGGER = { ti1Edge: 4, ti1: 5, ti2: 6, etr: 7 } as const
const MASTER = { reset: 0, enable: 1, update: 2, comparePulse: 3, oc1Ref: 4 } as const
const OC = { frozen: 0, active: 1, inactive: 2, toggle: 3, forcedInactive: 4, forcedActive: 5, pwm1: 6, pwm2: 7 } as const
const CAPTURE = { output: 0, direct: 1, indirect: 2, trc: 3 } as const

const FILTER_SAMPLING: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [2, 6],
  [2, 8],
  [4, 6],
  [4, 8],
  [8, 6],
  [8, 8],
  [16, 5],
  [16, 6],
  [16, 8],
  [32, 5],
  [32, 6],
  [32, 8],
]

const DTS_TICKS = [1, 2, 4, 4]

function deadTimeUnits(dtg: number) {
  if ((dtg & 0x80) === 0) return dtg & 0x7f
  if ((dtg & 0xc0) === 0x80) return (64 + (dtg & 0x3f)) * 2
  if ((dtg & 0xe0) === 0xc0) return (32 + (dtg & 0x1f)) * 8
  return (32 + (dtg & 0x1f)) * 16
}

function registersOf(spec: TimSpec, version: TimVersion): RegDef[] {
  const extended = version === "v2" && spec.kind === "advanced"
  const defs: RegDef[] = [
    { name: "CR1", offset: 0x00, rw: version === "v2" ? 0xbff : 0x3ff },
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
    { name: "RCR", offset: 0x30, rw: extended ? 0xffff : 0xff },
    { name: "CCR1", offset: 0x34 },
    { name: "CCR2", offset: 0x38 },
    { name: "CCR3", offset: 0x3c },
    { name: "CCR4", offset: 0x40 },
    { name: "BDTR", offset: 0x44 },
    { name: "DCR", offset: 0x48 },
    { name: "DMAR", offset: 0x4c },
    { name: "OR", offset: 0x50 },
  ]
  if (extended) defs.push({ name: "CCMR3", offset: 0x54 }, { name: "CCR5", offset: 0x58 }, { name: "CCR6", offset: 0x5c })
  return defs
}

type Timed = { level: boolean; at: number } | null
type Listener = (level: boolean, lag: number) => void
type CounterAnchor = { k: number; cnt: number; down: boolean; div: number; phase: number; moving: boolean }

const COUNTER_ANCHORS = 16
export type TimSignal = "TRGO" | "OC"

export class Tim extends RegBlock {
  readonly spec: TimSpec
  readonly version: TimVersion
  readonly channels: number
  readonly compares: number
  readonly is32: boolean
  private readonly mask: number
  private readonly advanced: boolean
  private readonly hasSlave: boolean
  private readonly hasEncoderAndEtr: boolean
  private readonly hasMaster: boolean
  private readonly extended: boolean

  cnt = 0
  private pscCnt = 0
  private pscShadow = 0
  private arrShadow = 0
  private rcrCnt = 0
  private readonly ccrShadow = [0, 0, 0, 0, 0, 0]
  private readonly ref = [false, false, false, false, false, false]
  private readonly outLevel: (boolean | null)[] = [null, null, null, null, null, null, null, null]
  private readonly icCount = [0, 0, 0, 0]
  private readonly pad = [false, false, false, false]
  private readonly raw: boolean[] = new Array<boolean>(LINES).fill(false)
  private readonly filtered: boolean[] = new Array<boolean>(LINES).fill(false)
  private readonly pending: Timed[] = new Array<Timed>(LINES).fill(null)
  private readonly deadP: Timed[] = [null, null, null, null]
  private readonly deadN: Timed[] = [null, null, null, null]
  private etrLevel = false
  private etrRises = 0
  private readonly itr = [false, false, false, false]
  private trgi = false
  private trgo = false
  private trgo2 = false
  private breakOn = false
  private break2On = false
  private break2Latched = false
  private lockFrozen = false
  private lockLevel = 0
  private readonly reported = new Set<string>()
  private ktime = 0
  private nowK = 0
  private lastEventK = -Infinity
  private readonly anchors: CounterAnchor[] = Array.from({ length: COUNTER_ANCHORS }, () => ({ k: 0, cnt: 0, down: false, div: 1, phase: 0, moving: false }))
  private anchorStart = 0
  private anchorCount = 0
  private acc = 0
  running = false
  private active = false
  private counting = false
  eventLag = 0

  private timHz = 16e6
  private hclkHz = 16e6
  private readonly listeners: Record<TimSignal, Listener[]> = { TRGO: [], OC: [] }

  raiseIrq: (irq: number) => void = () => {}
  onDmaRequest: (event: string) => void = () => {}
  onEvent: (event: string) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  onOutput: (index: number, level: boolean | null) => void = () => {}
  onRunning: (on: boolean) => void = () => {}
  onUnsupported: (what: string) => void = () => {}
  readLine: (line: number) => boolean | null = () => null
  clockOn: () => boolean = () => true

  setClock(timHz: number, hclkHz: number) {
    this.timHz = timHz
    this.hclkHz = hclkHz
  }

  constructor(spec: TimSpec, version: TimVersion = "v1") {
    super(spec.name, spec.base, 0x400, registersOf(spec, version))
    this.spec = spec
    this.version = version
    this.channels = spec.kind === "basic" ? 0 : spec.kind === "gp2" ? 2 : spec.kind === "gp1" ? 1 : 4
    this.advanced = spec.kind === "advanced"
    this.extended = this.advanced && version === "v2"
    this.compares = this.extended ? 6 : this.channels
    this.is32 = spec.kind === "gp32"
    this.mask = this.is32 ? 0xffffffff : 0xffff
    this.hasSlave = spec.kind === "advanced" || spec.kind === "gp32" || spec.kind === "gp16" || spec.kind === "gp2"
    this.hasEncoderAndEtr = spec.kind === "advanced" || spec.kind === "gp32" || spec.kind === "gp16"
    this.hasMaster = spec.kind === "advanced" || spec.kind === "gp32" || spec.kind === "gp16" || spec.kind === "basic"
    this.reset()
  }

  reset() {
    super.reset()
    if (!this.ccrShadow) return
    this.regs[REG.ARR] = this.mask >>> 0
    this.cnt = 0
    this.pscCnt = 0
    this.pscShadow = 0
    this.arrShadow = this.mask
    this.rcrCnt = 0
    this.ccrShadow.fill(0)
    this.ref.fill(false)
    this.icCount.fill(0)
    this.pad.fill(false)
    this.raw.fill(false)
    this.filtered.fill(false)
    this.pending.fill(null)
    this.deadP.fill(null)
    this.deadN.fill(null)
    this.etrLevel = false
    this.etrRises = 0
    this.itr.fill(false)
    this.trgi = false
    this.trgo = false
    this.trgo2 = false
    this.breakOn = false
    this.break2On = false
    this.break2Latched = false
    this.lockFrozen = false
    this.lockLevel = 0
    this.reported.clear()
    this.acc = 0
    this.lastEventK = -Infinity
    this.eventLag = 0
    this.running = false
    this.counting = false
    this.anchorCount = 0
    this.anchor()
    this.refreshActive()
    this.releaseOutputs()
  }

  clockChanged() {
    this.refreshActive()
    if (this.clockOn()) for (let line = 0; line < LINES; line++) this.resampleLine(line)
  }

  private resampleLine(line: number) {
    const level = this.readLine(line)
    if (level !== null) this.input(line, level)
  }

  listen(signal: TimSignal, listener: Listener) {
    this.listeners[signal].push(listener)
  }

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return this.clockOn() ? super.read(offset, size) : 0
  }
  peek(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return this.clockOn() ? super.peek(offset, size) : 0
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    if (!this.clockOn()) return
    super.write(offset, value, size)
    this.reschedule()
  }

  protected onRead(d: RegDef, current: number): number {
    const i = d.offset >>> 2
    if (i === REG.CNT) return this.counterRegister()
    if (i === REG.EGR) return 0
    if (i === REG.DMAR) this.unsupported("DMA burst (DCR/DMAR)")
    const ch = i - REG.CCR1
    if (ch >= 0 && ch < this.channels && this.isInput(ch)) this.regs[REG.SR] &= ~(2 << ch)
    return current
  }

  protected peekValue(d: RegDef, current: number): number {
    const i = d.offset >>> 2
    if (i === REG.CNT) return this.counterRegister()
    if (i === REG.EGR) return 0
    return current
  }

  private counterRegister() {
    const uif = this.regs[REG.CR1] & CR1_UIFREMAP && this.regs[REG.SR] & SR_UIF ? 0x80000000 : 0
    return (this.cnt | uif) >>> 0
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    const i = d.offset >>> 2
    switch (i) {
      case REG.CR1:
        return this.writeCr1(next, old)
      case REG.CR2:
        return this.writeCr2(next, old)
      case REG.SMCR:
        this.regs[i] = next >>> 0
        this.writeSmcr(next)
        return
      case REG.SR:
        return (old & written & (this.version === "v2" ? SR_FLAGS_V2 : SR_FLAGS_V1)) >>> 0
      case REG.EGR:
        this.writeEgr(written)
        return 0
      case REG.CNT:
        this.cnt = (written & this.mask) >>> 0
        this.lastEventK = this.ktime
        this.anchor()
        this.refreshOutputs()
        return
      case REG.ARR:
        if ((this.regs[REG.CR1] & CR1_ARPE) === 0) {
          this.arrShadow = (next & this.mask) >>> 0
          this.anchor()
        }
        return (next & this.mask) >>> 0
      case REG.PSC:
        return
      case REG.CCMR1:
      case REG.CCMR2:
      case REG.CCMR3: {
        const value = this.lockedCcmr(i, next, old)
        this.regs[i] = value
        this.checkOutputModes(i, value, old)
        this.resyncLines()
        this.refreshOutputs()
        return value
      }
      case REG.CCER: {
        const value = this.lockedCcer(next, old)
        this.regs[i] = value
        for (let ch = 0; ch < this.channels; ch++) if (!(value & (1 << (ch * 4)))) this.icCount[ch] = 0
        this.resyncLines()
        this.refreshOutputs()
        return value
      }
      case REG.BDTR: {
        const value = this.writeBdtr(next, old)
        this.regs[i] = value
        this.resyncLines()
        this.checkBreaks()
        this.refreshOutputs()
        return this.regs[i]
      }
      case REG.DIER:
        this.regs[i] = next >>> 0
        this.checkLines(next & ~old)
        return
      case REG.DCR:
        if (next & 0x1f1f) this.unsupported("DMA burst (DCR/DMAR)")
        return
      case REG.DMAR:
        this.unsupported("DMA burst (DCR/DMAR)")
        return
      case REG.OR:
        if (next) this.unsupported("input remap (OR)")
        return
      case REG.CCR5:
        if (next & CCR5_GROUPING) this.unsupported("combined 3-phase PWM (CCR5 GC5Cx)")
        return this.writeCcr(4, next, old)
      case REG.CCR6:
        return this.writeCcr(5, next, old)
    }
    if (i >= REG.CCR1 && i <= REG.CCR4) return this.writeCcr(i - REG.CCR1, next, old)
  }

  private writeCr1(next: number, old: number) {
    let value = next
    if (this.isEncoder() || value & CR1_CMS) value = (value & ~CR1_DIR) | (old & CR1_DIR)
    this.regs[REG.CR1] = value >>> 0
    if ((value & CR1_ARPE) === 0) this.arrShadow = (this.regs[REG.ARR] & this.mask) >>> 0
    const cen = (value & CR1_CEN) !== 0
    if (cen !== this.running) {
      if (cen) this.resyncLines()
      this.running = cen
      this.recount()
      this.refreshActive()
    }
    this.anchor()
    if ((value & (CR1_DIR | CR1_CMS)) !== (old & (CR1_DIR | CR1_CMS))) this.refreshOutputs()
    return value >>> 0
  }

  private writeCr2(next: number, old: number) {
    let value = next
    if (this.advanced && this.lockLevel >= 1) value = (value & ~CR2_OIS) | (old & CR2_OIS)
    this.regs[REG.CR2] = value >>> 0
    if (this.advanced && value & CR2_CCPC && !(old & CR2_CCPC)) this.unsupported("commutation (CR2.CCPC, COM event)")
    if ((value ^ old) & CR2_TI1S) this.resyncLines()
    this.refreshTrgo()
    this.refreshOutputs()
    return value >>> 0
  }

  private writeSmcr(next: number) {
    if (!this.hasSlave) return
    const sms = this.slaveMode()
    const ts = (next >>> 4) & 7
    if (!this.hasEncoderAndEtr && ((sms >= SLAVE.encoderTi1 && sms <= SLAVE.encoderBoth) || ts === TRIGGER.etr || next & (SMCR_ECE | 0xff00))) this.unsupported("SMCR mode this timer does not have")
    if (sms > SLAVE.resetTrigger) this.unsupported("reserved SMCR.SMS code")
    this.resyncLines()
    this.trgi = this.trgiLevel()
    this.recount()
    this.refreshActive()
    this.refreshTrgo()
  }

  private writeEgr(written: number) {
    if (written & EGR_UG) this.update(true)
    for (let ch = 0; ch < this.channels; ch++) if (written & (2 << ch)) this.ccEvent(ch, true)
    if (written & EGR_COMG && this.advanced) this.unsupported("commutation (CR2.CCPC, COM event)")
    if (written & EGR_TG) this.flag(SR_TIF, DIER_TIE, this.irqOf("trg"))
    if (this.advanced && written & EGR_BG) this.breakEvent(false)
    if (this.extended && written & EGR_B2G) this.breakEvent(true)
  }

  private writeCcr(ch: number, next: number, old: number) {
    if (ch >= this.compares) return old
    if (ch < this.channels && this.isInput(ch)) return old
    const value = ch === 4 ? next >>> 0 : (next & this.mask) >>> 0
    if (!this.preload(ch)) {
      this.ccrShadow[ch] = (value & this.mask) >>> 0
      this.refreshOutputs()
    }
    return value
  }

  private writeBdtr(next: number, old: number) {
    if (!this.advanced) return next >>> 0
    let value = next >>> 0
    if (this.lockFrozen) value = (value & ~BDTR_LOCK) | (old & BDTR_LOCK)
    else this.lockFrozen = true
    if (this.lockLevel >= 1) {
      const locked = this.lockLevel >= 2 ? BDTR_LOCKED_AT_2 : BDTR_LOCKED_AT_1
      value = (value & ~locked) | (old & locked)
    }
    this.lockLevel = (value & BDTR_LOCK) >>> 8
    if (!this.extended) value &= 0xffff | (0xf << 16)
    if (value & BDTR_MOE && (this.breakOn || this.break2On)) value &= ~BDTR_MOE
    if (value & BDTR_MOE && !(old & BDTR_MOE)) this.break2Latched = false
    return value >>> 0
  }

  private lockedCcmr(i: number, next: number, old: number) {
    if (!this.advanced || this.lockLevel < 3 || i === REG.CCMR3) return next >>> 0
    let value = next
    for (const half of [0, 1]) {
      if (this.isInputMode(old, half)) continue
      const keep = (0xf8 << (half * 8)) | (1 << (16 + half * 8))
      value = (value & ~keep) | (old & keep)
    }
    return value >>> 0
  }

  private isInputMode(ccmr: number, half: number) {
    return ((ccmr >>> (half * 8)) & 3) !== 0
  }

  private lockedCcer(next: number, old: number) {
    if (!this.advanced || this.lockLevel < 2) return next >>> 0
    let value = next
    for (let ch = 0; ch < this.channels; ch++) {
      if (this.isInput(ch)) continue
      const keep = 0xa << (ch * 4)
      value = (value & ~keep) | (old & keep)
    }
    return value >>> 0
  }

  private checkOutputModes(i: number, value: number, old: number) {
    if (this.version !== "v2") return
    for (const half of [0, 1]) {
      const ch = (i - REG.CCMR1) * 2 + half
      if (ch >= this.compares) continue
      if (i !== REG.CCMR3 && this.isInputMode(value, half)) continue
      const extended = (value >>> (16 + half * 8)) & 1
      if (extended && !((old >>> (16 + half * 8)) & 1)) this.unsupported("retriggerable one-pulse, combined or asymmetric PWM (OCxM ≥ 8)")
      if ((value >>> (half * 8)) & 0x80 && !((old >>> (half * 8)) & 0x80)) this.unsupported("OCxREF clear (OCxCE)")
    }
  }

  private unsupported(what: string) {
    if (this.reported.has(what)) return
    this.reported.add(what)
    this.onUnsupported(`${this.spec.name} ${what}`)
  }

  private irqOf(which: "up" | "cc" | "trg" | "brk"): number {
    const irq = this.spec.irq
    return typeof irq === "number" ? irq : irq[which]
  }

  private flag(bits: number, enable: number, irq: number) {
    this.regs[REG.SR] |= bits
    const dier = this.regs[REG.DIER]
    if (dier & enable) this.raiseIrq(irq)
    const kind = enable === DIER_UIE ? "UP" : enable === DIER_TIE ? "TRIG" : enable === DIER_BIE ? "BRK" : `CH${Math.log2(enable)}`
    const channelDma = enable > DIER_UIE && enable < DIER_TIE
    if (dier & (enable << 8) && !(channelDma && this.regs[REG.CR2] & CR2_CCDS)) this.onDmaRequest(kind)
    if (enable === DIER_UIE && this.regs[REG.CR2] & CR2_CCDS)
      for (let ch = 0; ch < this.channels; ch++) if (dier & (1 << (9 + ch))) this.onDmaRequest(`CH${ch + 1}`)
    this.onEvent(kind)
  }

  private checkLines(enabled: number) {
    const sr = this.regs[REG.SR]
    if (enabled & sr & DIER_UIE) this.raiseIrq(this.irqOf("up"))
    if (enabled & sr & 0x1e) this.raiseIrq(this.irqOf("cc"))
    if (enabled & sr & DIER_TIE) this.raiseIrq(this.irqOf("trg"))
    if (this.advanced && enabled & DIER_BIE && sr & (SR_BIF | SR_B2IF)) this.raiseIrq(this.irqOf("brk"))
  }

  private ccmr(ch: number) {
    const reg = this.regs[ch < 2 ? REG.CCMR1 : ch < 4 ? REG.CCMR2 : REG.CCMR3]
    return ch & 1 ? reg >>> 8 : reg
  }
  private captureSource(ch: number) {
    return ch < 4 ? this.ccmr(ch) & 3 : CAPTURE.output
  }
  private isInput(ch: number) {
    return this.captureSource(ch) !== CAPTURE.output
  }
  private preload(ch: number) {
    return (this.ccmr(ch) & 8) !== 0
  }
  private ocMode(ch: number) {
    const reg = this.regs[ch < 2 ? REG.CCMR1 : ch < 4 ? REG.CCMR2 : REG.CCMR3]
    const mode = (this.ccmr(ch) >>> 4) & 7
    if (this.version !== "v2" || !((reg >>> (16 + (ch & 1) * 8)) & 1)) return mode
    return mode & 1 ? OC.pwm2 : OC.pwm1
  }
  private ccer() {
    return this.regs[REG.CCER]
  }
  private ccEnabled(ch: number) {
    return (this.ccer() & (1 << (ch * 4))) !== 0
  }
  private ccPolarity(ch: number) {
    return (this.ccer() & (2 << (ch * 4))) !== 0
  }
  private ccnEnabled(ch: number) {
    return ch < 3 && (this.ccer() & (4 << (ch * 4))) !== 0
  }
  private ccnPolarity(ch: number) {
    return (this.ccer() & (8 << (ch * 4))) !== 0
  }
  private countingDown() {
    return (this.regs[REG.CR1] & CR1_DIR) !== 0
  }
  private slaveMode() {
    if (!this.hasSlave) return SLAVE.off
    const smcr = this.regs[REG.SMCR]
    return (smcr & 7) | (this.version === "v2" ? (smcr >>> 13) & 8 : 0)
  }
  private triggerSelect() {
    return (this.regs[REG.SMCR] >>> 4) & 7
  }
  private externalClock2() {
    return this.hasEncoderAndEtr && (this.regs[REG.SMCR] & SMCR_ECE) !== 0
  }
  private isEncoder() {
    const sms = this.slaveMode()
    return this.hasEncoderAndEtr && sms >= SLAVE.encoderTi1 && sms <= SLAVE.encoderBoth
  }
  private dtsTicks() {
    return DTS_TICKS[(this.regs[REG.CR1] >>> 8) & 3]
  }

  private recount() {
    const sms = this.slaveMode()
    const external = this.isEncoder() || sms === SLAVE.externalClock || this.externalClock2()
    this.counting = this.running && !external && (sms !== SLAVE.gated || this.trgi)
    this.anchor()
    this.refreshEnableTrgo()
  }

  private anchorAt(index: number) {
    return this.anchors[(this.anchorStart + index) % COUNTER_ANCHORS]
  }

  private anchor() {
    while (this.anchorCount && this.anchorAt(this.anchorCount - 1).k >= this.ktime) this.anchorCount--
    if (this.anchorCount === COUNTER_ANCHORS) {
      this.anchorStart = (this.anchorStart + 1) % COUNTER_ANCHORS
      this.anchorCount--
    }
    const a = this.anchorAt(this.anchorCount++)
    a.k = this.ktime
    a.cnt = this.cnt
    a.down = this.countingDown()
    a.div = this.pscShadow + 1
    a.phase = this.pscCnt
    a.moving = this.counting && this.arrShadow !== 0
  }

  private counterEnabled() {
    return this.running && (this.slaveMode() !== SLAVE.gated || this.trgi)
  }

  private hasTimed() {
    for (const p of this.pending) if (p) return true
    for (const p of this.deadP) if (p) return true
    for (const p of this.deadN) if (p) return true
    return false
  }

  private refreshActive() {
    const want = this.clockOn() && (this.running || this.hasTimed())
    if (want === this.active) return
    this.active = want
    if (want) {
      this.acc = 0
      this.nowK = Math.max(this.nowK, this.ktime)
    } else this.nowK = this.ktime
    this.onRunning(want)
  }

  tick(cycles: number) {
    if (!this.active) return
    this.acc += cycles * this.timHz
    const hclk = this.hclkHz
    const n = Math.floor(this.acc / hclk)
    this.acc -= n * hclk
    const target = this.ktime + n
    this.nowK = target + this.acc / hclk
    this.runTo(target)
    this.eventLag = 0
  }

  cyclesUntilEvent(): number {
    if (!this.active) return Infinity
    const k = Math.min(this.kernelTicksToCounterEvent(), this.nextTimedK() - this.ktime)
    if (k === Infinity) return Infinity
    return Math.max(1, Math.ceil((Math.max(k, 0) * this.hclkHz - this.acc) / this.timHz))
  }

  private kernelTicksToCounterEvent() {
    if (!this.counting || this.arrShadow === 0) return Infinity
    const div = this.pscShadow + 1
    return (this.ticksToEvent() - 1) * div + Math.max(1, div - this.pscCnt)
  }

  private nextTimedK() {
    let next = Infinity
    for (const p of this.pending) if (p && p.at < next) next = p.at
    for (const p of this.deadP) if (p && p.at < next) next = p.at
    for (const p of this.deadN) if (p && p.at < next) next = p.at
    return next
  }

  private ticksToEvent(): number {
    const cr1 = this.regs[REG.CR1]
    const arr = this.arrShadow
    const down = (cr1 & CR1_DIR) !== 0
    const center = (cr1 & CR1_CMS) !== 0
    let d = center ? (down ? this.cnt : arr - this.cnt) : down ? this.cnt + 1 : arr - this.cnt + 1
    if (d < 1) d = 1
    for (let ch = 0; ch < this.compares; ch++) {
      if (this.isInput(ch)) continue
      const ccr = this.ccrShadow[ch]
      const dc = down ? this.cnt - ccr : ccr - this.cnt
      if (dc > 0 && dc < d) d = dc
    }
    return d
  }

  private runTo(target: number) {
    for (;;) {
      const timed = this.nextTimedK()
      const counter = this.ktime + this.kernelTicksToCounterEvent()
      if (Math.min(timed, counter) > target) {
        this.idle(target - this.ktime)
        return
      }
      if (counter <= timed) {
        const d = this.ticksToEvent()
        this.ktime = counter
        this.pscCnt = 0
        this.lagTo(counter)
        this.land(d)
      } else {
        this.idle(timed - this.ktime)
        this.lagTo(timed)
        this.takeTimed(timed)
      }
    }
  }

  private idle(kernelTicks: number) {
    if (kernelTicks <= 0) return
    this.ktime += kernelTicks
    if (!this.counting) return
    const div = this.pscShadow + 1
    const total = this.pscCnt + kernelTicks
    const ticks = Math.floor(total / div)
    this.pscCnt = total - ticks * div
    if (ticks && this.arrShadow !== 0) this.cnt = this.countingDown() ? this.cnt - ticks : this.cnt + ticks
  }

  private lagTo(k: number) {
    this.eventLag = Math.max(0, (this.nowK - k) / this.timHz)
  }

  private takeTimed(at: number) {
    for (let line = 0; line < LINES; line++) {
      const p = this.pending[line]
      if (!p || p.at !== at) continue
      this.pending[line] = null
      this.filteredEdge(line, p.level, at)
      this.refreshActive()
      return
    }
    for (let ch = 0; ch < 4; ch++) {
      const p = this.deadP[ch]
      if (p && p.at === at) {
        this.deadP[ch] = null
        this.drivePin(ch * 2, p.level)
      }
      const n = this.deadN[ch]
      if (n && n.at === at) {
        this.deadN[ch] = null
        this.drivePin(ch * 2 + 1, n.level)
      }
    }
    this.refreshActive()
  }

  private land(d: number) {
    const cr1 = this.regs[REG.CR1]
    const arr = this.arrShadow
    const down = (cr1 & CR1_DIR) !== 0
    const center = (cr1 & CR1_CMS) !== 0
    this.lastEventK = this.ktime
    if (center) {
      if (down) {
        this.cnt -= d
        if (this.cnt <= 0) {
          this.cnt = 0
          this.regs[REG.CR1] &= ~CR1_DIR
          this.overflow()
        }
      } else {
        this.cnt += d
        if (this.cnt >= arr) {
          this.cnt = arr
          this.regs[REG.CR1] |= CR1_DIR
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
    const flagged = this.compareFlagsWhileCounting(this.countingDown())
    for (let ch = 0; ch < this.compares; ch++) {
      if (this.isInput(ch) || this.cnt !== this.ccrShadow[ch]) continue
      if (flagged) this.ccEvent(ch, false)
      else this.compareRef(ch)
    }
    this.anchor()
    this.refreshOutputs()
  }

  private compareFlagsWhileCounting(down: boolean) {
    const cms = (this.regs[REG.CR1] & CR1_CMS) >>> 5
    return cms === 0 || cms === 3 || (cms === 1) === down
  }

  private step(ticks: number) {
    if (this.arrShadow === 0) return
    while (ticks > 0) {
      const d = this.ticksToEvent()
      if (ticks < d) {
        this.cnt = this.countingDown() ? this.cnt - ticks : this.cnt + ticks
        return
      }
      ticks -= d
      this.land(d)
    }
  }

  private overflow() {
    if (this.advanced && this.rcrCnt > 0) {
      this.rcrCnt--
      return
    }
    this.update(false)
  }

  private update(software: boolean) {
    const cr1 = this.regs[REG.CR1]
    const blocked = (cr1 & CR1_UDIS) !== 0
    if (!blocked) {
      this.pscShadow = this.regs[REG.PSC] & 0xffff
      this.arrShadow = (this.regs[REG.ARR] & this.mask) >>> 0
      this.rcrCnt = this.regs[REG.RCR]
      for (let ch = 0; ch < this.compares; ch++) {
        if (this.isInput(ch) || !this.preload(ch)) continue
        this.ccrShadow[ch] = (this.regs[ch < 4 ? REG.CCR1 + ch : REG.CCR5 + ch - 4] & this.mask) >>> 0
      }
      if (this.advanced && this.regs[REG.BDTR] & BDTR_AOE && !this.breakOn && !this.break2On) {
        this.regs[REG.BDTR] |= BDTR_MOE
        this.break2Latched = false
      }
    }
    if (software) {
      this.cnt = cr1 & CR1_DIR && (cr1 & CR1_CMS) === 0 ? this.arrShadow : 0
      this.pscCnt = 0
      this.lastEventK = this.ktime
      this.anchor()
    }
    if (cr1 & CR1_OPM && !software) {
      this.regs[REG.CR1] &= ~CR1_CEN
      this.running = false
      this.recount()
      this.refreshActive()
    }
    if (!blocked) {
      if (software) this.masterPulse(MASTER.reset)
      this.masterPulse(MASTER.update)
      if (!(software && cr1 & CR1_URS)) this.flag(SR_UIF, DIER_UIE, this.irqOf("up"))
    }
    if (software) this.refreshOutputs()
  }

  private ccEvent(ch: number, software: boolean) {
    if (ch >= 4) {
      this.regs[REG.SR] |= SR_CC5IF << (ch - 4)
      this.compareRef(ch)
      return
    }
    const bit = 2 << ch
    const input = this.isInput(ch)
    if (input && this.regs[REG.SR] & bit) this.regs[REG.SR] |= bit << 8
    this.flag(bit, bit, this.irqOf("cc"))
    if (ch === 0) this.masterPulse(MASTER.comparePulse)
    if (input) {
      if (software) this.regs[REG.CCR1 + ch] = this.cnt >>> 0
      return
    }
    if (!software) this.compareRef(ch)
  }

  private compareRef(ch: number) {
    switch (this.ocMode(ch)) {
      case OC.active:
        this.setRef(ch, true)
        break
      case OC.inactive:
        this.setRef(ch, false)
        break
      case OC.toggle:
        this.setRef(ch, !this.ref[ch])
        break
    }
  }

  private setRef(ch: number, level: boolean) {
    if (this.ref[ch] === level) return
    this.ref[ch] = level
    if (ch === 0) for (const l of this.listeners.OC) l(level, this.eventLag)
    if (!this.hasMaster) return
    const mms = (this.regs[REG.CR2] >>> 4) & 7
    if (mms >= MASTER.oc1Ref && ch === mms - MASTER.oc1Ref) this.setTrgo(level)
    if (this.extended) this.refChangedForTrgo2(ch, level)
  }

  private refChangedForTrgo2(ch: number, level: boolean) {
    const mms2 = (this.regs[REG.CR2] >>> 20) & 15
    if (mms2 >= 4 && mms2 <= 9) {
      if (ch === mms2 - 4) this.setTrgo2(level)
      return
    }
    const rising = level
    const fire =
      (mms2 === 10 && ch === 3) ||
      (mms2 === 11 && ch === 5) ||
      (mms2 === 12 && rising && (ch === 3 || ch === 5)) ||
      (mms2 === 13 && ((ch === 3 && rising) || (ch === 5 && !rising))) ||
      (mms2 === 14 && rising && (ch === 4 || ch === 5)) ||
      (mms2 === 15 && ((ch === 4 && rising) || (ch === 5 && !rising)))
    if (fire) {
      this.setTrgo2(true)
      this.setTrgo2(false)
    }
  }

  private masterPulse(event: number) {
    if (!this.hasMaster) return
    if (((this.regs[REG.CR2] >>> 4) & 7) === event) {
      this.setTrgo(true)
      this.setTrgo(false)
    }
    if (this.extended && ((this.regs[REG.CR2] >>> 20) & 15) === event) {
      this.setTrgo2(true)
      this.setTrgo2(false)
    }
  }

  private setTrgo(level: boolean) {
    if (this.trgo === level) return
    this.trgo = level
    if (level) this.onEvent("TRGO")
    for (const l of this.listeners.TRGO) l(level, this.eventLag)
  }

  private setTrgo2(level: boolean) {
    if (this.trgo2 === level) return
    this.trgo2 = level
    if (level) this.onEvent("TRGO2")
  }

  private refreshEnableTrgo() {
    if (!this.hasMaster) return
    if (((this.regs[REG.CR2] >>> 4) & 7) === MASTER.enable) this.setTrgo(this.counterEnabled())
    if (this.extended && ((this.regs[REG.CR2] >>> 20) & 15) === MASTER.enable) this.setTrgo2(this.counterEnabled())
  }

  private refreshTrgo() {
    if (!this.hasMaster) return
    const mms = (this.regs[REG.CR2] >>> 4) & 7
    this.setTrgo(mms === MASTER.enable ? this.counterEnabled() : mms >= MASTER.oc1Ref ? this.ref[mms - MASTER.oc1Ref] : false)
    if (!this.extended) return
    const mms2 = (this.regs[REG.CR2] >>> 20) & 15
    this.setTrgo2(mms2 === MASTER.enable ? this.counterEnabled() : mms2 >= 4 && mms2 <= 9 ? this.ref[mms2 - 4] : false)
  }

  private refreshOutputs() {
    if (!this.compares) return
    const down = this.countingDown()
    for (let ch = 0; ch < this.compares; ch++) {
      if (this.isInput(ch)) {
        if (ch < this.channels) this.drive(ch, null, null, false, false)
        continue
      }
      const ccr = this.ccrShadow[ch]
      switch (this.ocMode(ch)) {
        case OC.forcedInactive:
          this.setRef(ch, false)
          break
        case OC.forcedActive:
          this.setRef(ch, true)
          break
        case OC.pwm1:
          this.setRef(ch, down ? this.cnt <= ccr : this.cnt < ccr)
          break
        case OC.pwm2:
          this.setRef(ch, down ? this.cnt > ccr : this.cnt >= ccr)
          break
      }
      if (ch < this.channels) this.output(ch)
    }
  }

  private output(ch: number) {
    const ref = this.ref[ch]
    const p = this.ccPolarity(ch)
    if (!this.advanced) {
      this.drive(ch, this.ccEnabled(ch) ? ref !== p : null, null, false, false)
      return
    }
    const e = this.ccEnabled(ch)
    const ne = this.ccnEnabled(ch)
    const np = this.ccnPolarity(ch)
    const bdtr = this.regs[REG.BDTR]
    if (bdtr & BDTR_MOE) {
      const ossr = (bdtr & BDTR_OSSR) !== 0
      if (e && ne) this.drive(ch, ref !== p, !ref !== np, ref, !ref)
      else if (e) this.drive(ch, ref !== p, ossr ? np : null, false, false)
      else if (ne) this.drive(ch, ossr ? p : null, ref !== np, false, false)
      else this.drive(ch, null, null, false, false)
      return
    }
    if (!(bdtr & BDTR_OSSI) || (!e && !ne)) {
      this.drive(ch, null, null, false, false)
      return
    }
    if (this.break2Latched) {
      this.drive(ch, p, np, false, false)
      return
    }
    const cr2 = this.regs[REG.CR2]
    const idleP = ((cr2 >>> (8 + ch * 2)) & 1) === 1
    const idleN = ((cr2 >>> (9 + ch * 2)) & 1) === 1
    this.drive(ch, idleP, idleN, idleP !== p, idleN !== np, p, np)
  }

  private drive(ch: number, level: boolean | null, levelN: boolean | null, delayP: boolean, delayN: boolean, interimP = this.ccPolarity(ch), interimN = this.ccnPolarity(ch)) {
    const dt = this.advanced ? deadTimeUnits(this.regs[REG.BDTR] & BDTR_DTG) * this.dtsTicks() : 0
    this.side(ch, 0, level, delayP && dt > 0, interimP, dt)
    if (this.advanced) this.side(ch, 1, levelN, delayN && dt > 0, interimN, dt)
  }

  private side(ch: number, n: 0 | 1, level: boolean | null, delay: boolean, interim: boolean, dt: number) {
    const dead = n ? this.deadN : this.deadP
    const index = ch * 2 + n
    const pending = dead[ch]
    if (!delay || level === null) {
      if (pending) {
        dead[ch] = null
        this.refreshActive()
      }
      this.drivePin(index, level)
      return
    }
    if (pending && pending.level === level) return
    if (!pending && this.outLevel[index] === level) return
    dead[ch] = { level, at: this.ktime + dt }
    this.drivePin(index, interim)
    this.refreshActive()
  }

  private drivePin(index: number, level: boolean | null) {
    if (this.outLevel[index] === level) return
    this.outLevel[index] = level
    this.onOutput(index, level)
  }

  private releaseOutputs() {
    for (let i = 0; i < 8; i++) {
      if (this.outLevel[i] !== null) {
        this.outLevel[i] = null
        this.onOutput(i, null)
      }
    }
  }

  private breakEvent(second: boolean) {
    this.regs[REG.BDTR] &= ~BDTR_MOE
    if (second) this.break2Latched = true
    this.flag(second ? SR_B2IF : SR_BIF, DIER_BIE, this.irqOf("brk"))
    this.refreshOutputs()
  }

  private breakActive(line: number) {
    const bdtr = this.regs[REG.BDTR]
    if (line === TIM_LINE.BKIN) return (bdtr & BDTR_BKE) !== 0 && this.filtered[line] === ((bdtr & BDTR_BKP) !== 0)
    return this.extended && (bdtr & BDTR_BK2E) !== 0 && this.filtered[line] === ((bdtr & BDTR_BK2P) !== 0)
  }

  private checkBreaks() {
    if (!this.advanced) return
    const on = this.breakActive(TIM_LINE.BKIN)
    const on2 = this.breakActive(TIM_LINE.BKIN2)
    const rose = on && !this.breakOn
    const rose2 = on2 && !this.break2On
    this.breakOn = on
    this.break2On = on2
    if (rose2) this.breakEvent(true)
    if (rose) this.breakEvent(false)
  }

  private resyncLines() {
    for (let ch = 0; ch < 4; ch++) this.pad[ch] = this.readLine(ch) ?? false
    for (let line = 0; line < 4; line++) this.settleLine(line, this.tiLevel(line))
    this.settleLine(TIM_LINE.BKIN, this.readLine(TIM_LINE.BKIN) ?? false)
    this.settleLine(TIM_LINE.BKIN2, this.readLine(TIM_LINE.BKIN2) ?? false)
    const smcr = this.regs[REG.SMCR]
    this.etrLevel = (this.readLine(TIM_LINE.ETR) ?? false) !== ((smcr & SMCR_ETP) !== 0)
    if (((smcr >>> 12) & 3) === 0) this.settleLine(TIM_LINE.ETR, this.etrLevel)
    this.trgi = this.trgiLevel()
  }

  private settleLine(line: number, level: boolean) {
    if (this.pending[line]) return
    this.raw[line] = level
    this.filtered[line] = level
  }

  private tiLevel(line: number) {
    if (line === 0 && this.regs[REG.CR2] & CR2_TI1S) return (Number(this.pad[0]) ^ Number(this.pad[1]) ^ Number(this.pad[2])) === 1
    return this.pad[line]
  }

  captureInput(ch: number, level: boolean, ago = 0) {
    this.input(ch, level, ago)
  }

  input(line: number, level: boolean, ago = 0) {
    if ((line < 4 && line >= this.channels) || !this.clockOn()) return
    const lag = this.eventLag
    if (!this.active) this.nowK = this.ktime
    const at = this.nowK - ago * this.timHz
    if (line === TIM_LINE.ETR) this.etrInput(level, at)
    else if (line < 4) {
      this.pad[line] = level
      if (line < 3) this.tiInput(0, at)
      if (line > 0) this.tiInput(line, at)
    } else if (this.advanced) this.rawEdge(line, level, at)
    this.eventLag = lag
  }

  private tiInput(line: number, at: number) {
    const level = this.tiLevel(line)
    if (this.tiUsed(line)) this.rawEdge(line, level, at)
    else this.settleLine(line, level)
  }

  private tiUsed(line: number) {
    for (let ch = 0; ch < this.channels; ch++) {
      const source = this.captureSource(ch)
      if ((source === CAPTURE.direct && ch === line) || (source === CAPTURE.indirect && (ch ^ 1) === line)) return true
    }
    if (!this.hasSlave || line > 1) return false
    if (this.isEncoder()) return true
    const ts = this.triggerSelect()
    return line === 0 ? ts === TRIGGER.ti1Edge || ts === TRIGGER.ti1 : ts === TRIGGER.ti2
  }

  itrInput(index: number, level: boolean, lag: number) {
    if (this.itr[index] === level) return
    this.itr[index] = level
    if (!this.hasSlave || !this.clockOn()) return
    const saved = this.eventLag
    if (!this.active) this.nowK = this.ktime
    const at = this.nowK - lag * this.timHz
    if (this.triggerSelect() === index) this.trgiChange(level, false, at)
    this.eventLag = saved
  }

  private etrInput(level: boolean, at: number) {
    if (!this.hasEncoderAndEtr) return
    const smcr = this.regs[REG.SMCR]
    const polarized = level !== ((smcr & SMCR_ETP) !== 0)
    if (polarized === this.etrLevel) return
    this.etrLevel = polarized
    const prescaler = (smcr >>> 12) & 3
    if (prescaler === 0) {
      this.rawEdge(TIM_LINE.ETR, polarized, at)
      return
    }
    if (!polarized) return
    this.etrRises++
    this.rawEdge(TIM_LINE.ETR, ((this.etrRises >>> (prescaler - 1)) & 1) === 1, at)
  }

  private filterOf(line: number): readonly [number, number] | null {
    let code = 0
    if (line < 4) code = line < this.channels && this.isInput(line) ? (this.ccmr(line) >>> 4) & 15 : 0
    else if (line === TIM_LINE.ETR) code = (this.regs[REG.SMCR] >>> 8) & 15
    else if (line === TIM_LINE.BKIN) code = (this.regs[REG.BDTR] >>> 16) & 15
    else code = (this.regs[REG.BDTR] >>> 20) & 15
    if (code === 0) return null
    const [divider, samples] = FILTER_SAMPLING[code]
    return [divider === 0 ? 1 : divider * this.dtsTicks(), samples]
  }

  private rawEdge(line: number, level: boolean, at: number) {
    if (this.raw[line] === level) return
    this.raw[line] = level
    const filter = this.filterOf(line)
    if (!filter) {
      this.pending[line] = null
      this.filteredEdge(line, level, at)
      this.refreshActive()
      return
    }
    if (this.pending[line]) {
      this.pending[line] = null
      this.refreshActive()
    }
    if (level === this.filtered[line]) return
    const [period, samples] = filter
    const due = Math.ceil(at / period) * period + (samples - 1) * period
    if (due <= this.ktime) {
      this.filteredEdge(line, level, due)
      return
    }
    this.pending[line] = { level, at: due }
    this.refreshActive()
  }

  private filteredEdge(line: number, level: boolean, at: number) {
    if (this.filtered[line] === level) return
    this.filtered[line] = level
    this.lagTo(at)
    if (line < 4) this.tiEdge(line, level, at)
    else if (line === TIM_LINE.ETR) this.etrEdge(level, at)
    else this.checkBreaks()
  }

  private inverted(ch: number) {
    return ((this.ccer() >>> (ch * 4)) & 0xa) === 2
  }
  private bothEdges(ch: number) {
    return ((this.ccer() >>> (ch * 4)) & 0xa) === 0xa
  }

  private tiEdge(ti: number, level: boolean, at: number) {
    for (let ch = 0; ch < this.channels; ch++) {
      const source = this.captureSource(ch)
      if (source !== CAPTURE.direct && source !== CAPTURE.indirect) continue
      if ((source === CAPTURE.direct ? ch : ch ^ 1) !== ti) continue
      if (this.bothEdges(ch) || level !== this.inverted(ch)) this.captureEdge(ch, at)
    }
    if (!this.hasSlave) return
    if (this.isEncoder() && ti < 2) this.encoderEdge(ti, at)
    const ts = this.triggerSelect()
    if (ts === TRIGGER.ti1Edge && ti === 0) this.triggerEvent(at)
    else if ((ts === TRIGGER.ti1 && ti === 0) || (ts === TRIGGER.ti2 && ti === 1)) this.trgiChange(level !== this.inverted(ti), this.bothEdges(ti), at)
  }

  private etrEdge(level: boolean, at: number) {
    if (level && this.externalClock2() && !this.isEncoder()) this.externalTick(at)
    if (this.hasSlave && this.triggerSelect() === TRIGGER.etr) this.trgiChange(level, false, at)
  }

  private trgiLevel() {
    const ts = this.triggerSelect()
    if (ts < 4) return this.itr[ts]
    if (ts === TRIGGER.ti1) return this.filtered[0] !== this.inverted(0)
    if (ts === TRIGGER.ti2) return this.filtered[1] !== this.inverted(1)
    if (ts === TRIGGER.etr) return this.filtered[TIM_LINE.ETR]
    return false
  }

  private trgiChange(level: boolean, both: boolean, at: number) {
    if (this.trgi === level) return
    this.trgi = level
    if (this.slaveMode() === SLAVE.gated) {
      this.backdate(at, () => {
        this.recount()
        this.flag(SR_TIF, DIER_TIE, this.irqOf("trg"))
      })
      return
    }
    if (level || both) this.triggerEvent(at)
  }

  private triggerEvent(at: number) {
    const ts = this.triggerSelect()
    if (ts < 4 || ts === TRIGGER.ti1Edge)
      for (let ch = 0; ch < this.channels; ch++) if (this.captureSource(ch) === CAPTURE.trc) this.captureEdge(ch, at)
    const sms = this.slaveMode()
    if (sms < SLAVE.reset || sms === SLAVE.gated || sms > SLAVE.resetTrigger) return
    this.lagTo(at)
    switch (sms) {
      case SLAVE.reset:
        this.backdate(at, () => this.update(true))
        break
      case SLAVE.trigger:
        if (!this.running) this.backdate(at, () => this.start())
        break
      case SLAVE.resetTrigger:
        this.backdate(at, () => {
          this.update(true)
          if (!this.running) this.start()
        })
        break
      case SLAVE.externalClock:
        if (!this.externalClock2()) this.externalTick(at)
        break
    }
    this.lagTo(at)
    this.flag(SR_TIF, DIER_TIE, this.irqOf("trg"))
  }

  private start() {
    this.regs[REG.CR1] |= CR1_CEN
    this.running = true
    this.recount()
    this.refreshActive()
  }

  private externalTick(at: number) {
    if (!this.counterEnabled()) return
    this.prescaledTick(at)
  }

  private prescaledTick(at: number) {
    const div = this.pscShadow + 1
    if (++this.pscCnt < div) return
    this.pscCnt = 0
    this.lagTo(at)
    this.step(1)
  }

  private encoderEdge(ti: number, at: number) {
    const a = this.filtered[0] !== this.ccPolarity(0)
    const b = this.filtered[1] !== this.ccPolarity(1)
    const up = ti === 0 ? (a ? !b : b) : b ? a : !a
    if (up) this.regs[REG.CR1] &= ~CR1_DIR
    else this.regs[REG.CR1] |= CR1_DIR
    const sms = this.slaveMode()
    if ((ti === 0 && sms === SLAVE.encoderTi2) || (ti === 1 && sms === SLAVE.encoderTi1)) return
    if (this.running) this.prescaledTick(at)
  }

  private captureEdge(ch: number, at: number) {
    if (!this.ccEnabled(ch)) return
    const psc = (this.ccmr(ch) >>> 2) & 3
    if (++this.icCount[ch] < 1 << psc) return
    this.icCount[ch] = 0
    this.regs[REG.CCR1 + ch] = this.counterAt(at) >>> 0
    this.lagTo(at)
    this.ccEvent(ch, false)
  }

  private ticksSince(at: number) {
    const div = this.pscShadow + 1
    const lastTick = this.ktime - this.pscCnt
    if (lastTick <= at) return 0
    return Math.ceil((lastTick - at) / div)
  }

  private counterAt(at: number) {
    if (!this.counting || at >= this.ktime) return this.cnt
    let i = this.anchorCount - 1
    while (i > 0 && this.anchorAt(i).k > at) i--
    const a = this.anchorAt(i)
    if (!a.moving || a.k > at) return a.cnt
    const ticks = Math.floor((at - a.k + a.phase) / a.div)
    return a.down ? a.cnt - ticks : a.cnt + ticks
  }

  private backdate(at: number, change: () => void) {
    const now = this.ktime
    const from = Math.max(Math.floor(at), this.lastEventK)
    if (!(from < now)) {
      change()
      return
    }
    if (this.counting) {
      const div = this.pscShadow + 1
      const ticks = this.ticksSince(from)
      const lastTick = now - this.pscCnt - ticks * div
      this.cnt = this.countingDown() ? this.cnt + ticks : this.cnt - ticks
      this.pscCnt = from - lastTick
    }
    this.ktime = from
    change()
    this.runTo(now)
  }
}

const ITR_SOURCES: Record<string, readonly [string, string, string, string]> = {
  TIM1: ["TIM5", "TIM2", "TIM3", "TIM4"],
  TIM8: ["TIM1", "TIM2", "TIM4", "TIM5"],
  TIM2: ["TIM1", "TIM8", "TIM3", "TIM4"],
  TIM3: ["TIM1", "TIM2", "TIM5", "TIM4"],
  TIM4: ["TIM1", "TIM2", "TIM3", "TIM8"],
  TIM5: ["TIM2", "TIM3", "TIM4", "TIM8"],
  TIM9: ["TIM2", "TIM3", "TIM10_OC", "TIM11_OC"],
  TIM12: ["TIM4", "TIM5", "TIM13_OC", "TIM14_OC"],
}

export function itrSources(name: string): readonly string[] {
  return ITR_SOURCES[name] ?? []
}

export function connectTimers(tims: Tim[]) {
  const byName = new Map(tims.map((t) => [t.spec.name, t]))
  for (const slave of tims)
    itrSources(slave.spec.name).forEach((source, index) => {
      const [name, signal] = source.endsWith("_OC") ? [source.slice(0, -3), "OC" as const] : [source, "TRGO" as const]
      byName.get(name)?.listen(signal, (level, lag) => {
        slave.sync()
        slave.itrInput(index, level, lag)
      })
    })
}

export const TIM_SPECS: TimSpec[] = [
  { name: "TIM1", base: 0x40010000, kind: "advanced", apb: 2, rccBit: 0, irq: { brk: 24, up: 25, trg: 26, cc: 27 } },
  { name: "TIM2", base: 0x40000000, kind: "gp32", apb: 1, rccBit: 0, irq: 28 },
  { name: "TIM3", base: 0x40000400, kind: "gp16", apb: 1, rccBit: 1, irq: 29 },
  { name: "TIM4", base: 0x40000800, kind: "gp16", apb: 1, rccBit: 2, irq: 30 },
  { name: "TIM5", base: 0x40000c00, kind: "gp32", apb: 1, rccBit: 3, irq: 50 },
  { name: "TIM6", base: 0x40001000, kind: "basic", apb: 1, rccBit: 4, irq: 54 },
  { name: "TIM7", base: 0x40001400, kind: "basic", apb: 1, rccBit: 5, irq: 55 },
  { name: "TIM8", base: 0x40010400, kind: "advanced", apb: 2, rccBit: 1, irq: { brk: 43, up: 44, trg: 45, cc: 46 } },
  { name: "TIM9", base: 0x40014000, kind: "gp2", apb: 2, rccBit: 16, irq: 24 },
  { name: "TIM10", base: 0x40014400, kind: "gp1", apb: 2, rccBit: 17, irq: 25 },
  { name: "TIM11", base: 0x40014800, kind: "gp1", apb: 2, rccBit: 18, irq: 26 },
  { name: "TIM12", base: 0x40001800, kind: "gp2", apb: 1, rccBit: 6, irq: 43 },
  { name: "TIM13", base: 0x40001c00, kind: "gp1", apb: 1, rccBit: 7, irq: 44 },
  { name: "TIM14", base: 0x40002000, kind: "gp1", apb: 1, rccBit: 8, irq: 45 },
]

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

const AUX_PADS: Record<string, string> = {
  TIM1: "ETR PA12 PE7; BKIN PA6 PB12 PE15; BKIN2 PE6 @1",
  TIM2: "ETR PA0 PA5 PA15 @1",
  TIM3: "ETR PD2 @2",
  TIM4: "ETR PE0 @2",
  TIM8: "ETR PA0 PI3; BKIN PA6 PI4; BKIN2 PA8 PI1 @3",
}

function parsePads(spec: string | undefined) {
  if (!spec) return []
  const [body, afText] = spec.split("@")
  const af = Number(afText)
  const out: { tag: string; port: number; pin: number; af: number }[] = []
  for (const group of body.split(";")) {
    const [tag, ...pads] = group.trim().split(/\s+/)
    for (const p of pads) {
      const pm = /^P([A-K])(\d+)$/.exec(p)!
      out.push({ tag, port: "ABCDEFGHIJK".indexOf(pm[1]), pin: Number(pm[2]), af })
    }
  }
  return out
}

export function timPads(name: string): TimPad[] {
  return parsePads(PADS[name]).map(({ tag, port, pin, af }) => {
    const m = /^CH(\d)(n?)$/.exec(tag)!
    return { port, pin, af, channel: Number(m[1]) - 1, complementary: m[2] === "n" }
  })
}

export function timAuxPads(name: string, map: AfMap): TimAuxPad[] {
  return parsePads(AUX_PADS[name])
    .filter(({ tag }) => tag !== "BKIN2" || map === "f74x")
    .map(({ tag, port, pin, af }) => ({ port, pin, af, line: tag as TimAuxLine }))
}
