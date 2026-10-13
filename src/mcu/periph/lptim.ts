import type { LptimProfile } from "../chip"
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

const REGS: RegDef[] = [
  { name: "ISR", offset: 0x00, rw: 0 },
  { name: "ICR", offset: 0x04, rw: 0x7f },
  { name: "IER", offset: 0x08, rw: 0x7f },
  { name: "CFGR", offset: 0x0c, rw: 0x01feeedf },
  { name: "CR", offset: 0x10, rw: 7 },
  { name: "CMP", offset: 0x14, rw: 0xffff },
  { name: "ARR", offset: 0x18, reset: 1, rw: 0xffff },
  { name: "CNT", offset: 0x1c, rw: 0 },
]

const CKSEL = 1
const TIMOUT = 1 << 19
const WAVE = 1 << 20
const WAVPOL = 1 << 21
const PRELOAD = 1 << 22
const COUNTMODE = 1 << 23
const ENC = 1 << 24
const CMPM = 1
const ARRM = 2
const EXTTRIG = 4
const CMPOK = 8
const ARROK = 16
const UP = 32
const DOWN = 64
type Input = { raw: boolean; level: boolean; remaining: number }
type RegisterTransfer = { value: number; remaining: number; buffered: number | null }
export type LptimInput = "IN1" | "IN2" | "ETR"
const PAD_INPUTS: readonly LptimInput[] = ["IN1", "IN2", "ETR"]

export class Lptim extends RegBlock implements Clocked {
  private hclkHz = 16e6
  private kernelHz = 0
  private accessible = false
  private operational = true
  private phase = 0
  private prescale = 0
  private enableDelay = 0
  private startDelay = 0
  private armed = false
  private running = false
  private continuous = false
  private completed = false
  private down = false
  private waveform = false
  private output = false
  private arr = 1
  private cmp = 0
  private readonly inputs: Input[] = Array.from({ length: 3 }, () => ({ raw: false, level: false, remaining: 0 }))
  private readonly transfers: RegisterTransfer[] = Array.from({ length: 2 }, () => ({ value: 0, remaining: 0, buffered: null }))
  eventLag = 0
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  onActive: (on: boolean) => void = () => {}
  onOutput: (level: boolean, lag: number) => void = () => {}
  raiseIrq: (irq: number) => void = () => {}
  onWakeupEvent: () => void = () => {}
  onUnsupported: (what: string) => void = () => {}
  readInput: (signal: LptimInput) => boolean | null = () => null
  readonly spec: LptimProfile

  constructor(spec: LptimProfile) {
    super("LPTIM1", spec.base, 0x400, REGS)
    this.spec = spec
  }

  reset() {
    super.reset()
    if (!this.inputs) return
    this.disable()
    this.arr = 1
    this.cmp = 0
    this.accessible = false
    this.kernelHz = 0
    this.operational = true
    this.drive()
  }

  setClock(kernelHz: number, hclkHz: number, accessible: boolean, operational = true) {
    this.kernelHz = kernelHz
    this.hclkHz = hclkHz
    this.accessible = accessible
    this.operational = operational
    this.updateActive()
  }

  get level() {
    return this.output
  }

  private get cfgr() {
    return this.regs[3]
  }

  private get enabled() {
    return (this.regs[4] & 1) !== 0
  }

  private get divider() {
    return 1 << ((this.cfgr >>> 9) & 7)
  }

  private get internalCounting() {
    return !(this.cfgr & (CKSEL | COUNTMODE | ENC))
  }

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return this.accessible && size === 4 && !(offset & 3) ? super.read(offset, size) : 0
  }

  peek(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return this.accessible && size === 4 && !(offset & 3) ? super.peek(offset, size) : 0
  }

  write(offset: number, value: number, size: 1 | 2 | 4) {
    this.sync()
    if (!this.accessible || size !== 4 || (offset & 3)) return
    super.write(offset, value, size)
    this.updateActive()
    this.reschedule()
  }

  protected onWrite(d: RegDef, next: number, old: number): number | void {
    switch (d.name) {
      case "ICR":
        this.regs[0] &= ~next
        return 0
      case "CFGR":
        if (this.enabled) return old
        this.regs[3] = next
        this.samplePads()
        this.drive()
        return next
      case "IER":
        return this.enabled ? old : next
      case "CR":
        this.regs[4] = next & 1
        if (!(next & 1)) this.disable()
        else if (!(old & 1)) {
          this.enableDelay = 2
          this.phase = 0
          this.samplePads()
          this.reportConfiguration()
        } else if (next & 6) {
          this.continuous = (next & 4) !== 0
          this.armed = true
          if (!this.running && !this.startDelay && !((this.cfgr >>> 17) & 3)) {
            this.completed = false
            this.begin(3)
          }
        }
        return next & 1
      case "CMP":
      case "ARR": {
        if (!this.enabled) return old
        const transfer = this.transfers[d.name === "CMP" ? 0 : 1]
        if (transfer.remaining) return old
        transfer.value = next
        transfer.remaining = 3
        return next
      }
    }
  }

  private reportConfiguration() {
    const select = (this.cfgr >>> 13) & 7
    if (((this.cfgr >>> 17) & 3) && select >= 3) this.onUnsupported(`LPTIM1 trigger ${select < 6 ? `RTC_TAMP${select - 2}_OUT (RTC tamper is not modelled)` : `${select} is reserved`}`)
    if (this.cfgr & ENC && (this.cfgr & CKSEL || this.divider !== 1)) this.onUnsupported("LPTIM1 encoder requires an internal clock and PRESC /1")
    if (this.cfgr & COUNTMODE && !(this.cfgr & CKSEL) && this.divider !== 1) this.onUnsupported("LPTIM1 COUNTMODE requires PRESC /1")
    if (this.cfgr & CKSEL && ((this.cfgr >>> 1) & 3) >= 2) this.onUnsupported("LPTIM1 external kernel clock requires a single active edge")
  }

  private samplePads() {
    PAD_INPUTS.forEach((signal, index) => {
      if (signal === "ETR" && (this.cfgr >>> 13) & 7) return
      const input = this.inputs[index]
      input.raw = input.level = this.readInput(signal) ?? false
      input.remaining = 0
    })
  }

  private disable() {
    this.enableDelay = this.startDelay = this.prescale = this.phase = 0
    this.armed = this.running = this.continuous = this.completed = this.down = this.waveform = false
    this.regs[7] = 0
    for (const input of this.inputs) {
      input.remaining = 0
      input.level = input.raw
    }
    for (const transfer of this.transfers) {
      transfer.remaining = 0
      transfer.buffered = null
    }
    this.drive()
    this.onActive(false)
  }

  private flag(bits: number) {
    this.regs[0] |= bits
    if (!(bits & this.regs[2])) return
    this.raiseIrq(this.spec.irq)
    this.onWakeupEvent()
  }

  private drive() {
    const next = this.waveform !== !!(this.cfgr & WAVPOL)
    if (next === this.output) return
    this.output = next
    this.onOutput(next, this.eventLag)
  }

  private begin(delay: number) {
    this.running = false
    this.startDelay = delay
    this.regs[7] = this.prescale = 0
    this.waveform = false
    this.drive()
  }

  pinEdge(signal: "IN1" | "IN2" | "ETR", level: boolean) {
    if (signal === "ETR") {
      this.triggerEdge(0, level)
      return
    }
    this.inputEdge(signal === "IN1" ? 0 : 1, level)
  }

  triggerEdge(source: number, level: boolean) {
    if (source !== ((this.cfgr >>> 13) & 7)) return
    this.inputEdge(2, level)
  }

  private inputEdge(index: number, level: boolean) {
    const input = this.inputs[index]
    if (input.raw === level) return
    input.raw = level
    if (!this.enabled || !this.accessible || !this.operational) {
      input.level = level
      input.remaining = 0
      return
    }
    const filter = (this.cfgr >>> (index === 2 ? 6 : 3)) & 3
    const sampled = index !== 2 && !(this.cfgr & CKSEL) && !!(this.cfgr & (COUNTMODE | ENC))
    input.remaining = level === input.level ? 0 : filter ? 1 << filter : sampled ? 1 : 0
    if (!input.remaining && input.level !== level) this.acceptInput(index)
    this.updateActive()
    this.reschedule()
  }

  private acceptInput(index: number) {
    const input = this.inputs[index]
    input.level = input.raw
    if (index === 2) {
      const polarity = (this.cfgr >>> 17) & 3
      if (!polarity || !this.activeEdge(polarity - 1, input.level) || !this.armed || this.enableDelay) return
      if (this.completed && this.cfgr & WAVE) return
      if ((this.running || this.startDelay) && !(this.cfgr & TIMOUT)) return
      this.flag(EXTTRIG)
      this.begin(2 * this.divider)
      return
    }
    const polarity = (this.cfgr >>> 1) & 3
    if (!this.activeEdge(polarity, input.level)) return
    if (this.cfgr & CKSEL) {
      if (index === 0 && polarity < 2) this.advanceKernel(1)
      return
    }
    if (!this.running || !this.kernelHz) return
    if (this.cfgr & ENC) {
      if (this.divider !== 1 || !this.continuous) return
      const down = index === 0 ? input.level === this.inputs[1].level : input.level !== this.inputs[0].level
      if (down !== this.down) {
        this.down = down
        this.flag(down ? DOWN : UP)
      }
      this.countEncoder(down)
    } else if (index === 0 && this.cfgr & COUNTMODE && this.divider === 1) this.advanceCounter(1)
  }

  private activeEdge(polarity: number, level: boolean) {
    return polarity === 2 || (polarity === 0 && level) || (polarity === 1 && !level)
  }

  private countEncoder(down: boolean) {
    const count = this.regs[7]
    this.regs[7] = down ? count === 0 ? this.arr : count - 1 : count >= this.arr ? 0 : count + 1
    if (this.regs[7] === this.cmp) this.flag(CMPM)
    if (this.regs[7] === this.arr) this.flag(ARRM)
    if ((down && count === 0) || (!down && count >= this.arr)) this.applyPreload()
    this.waveform = this.regs[7] > this.cmp
    this.drive()
  }

  private transferRegisters(ticks: number) {
    this.transfers.forEach((transfer, index) => {
      if (!transfer.remaining) return
      transfer.remaining = Math.max(0, transfer.remaining - ticks)
      if (transfer.remaining) return
      if (this.cfgr & PRELOAD && this.running) transfer.buffered = transfer.value
      else if (index === 0) this.cmp = transfer.value
      else this.arr = transfer.value
      this.flag(index === 0 ? CMPOK : ARROK)
    })
  }

  private applyPreload() {
    this.transfers.forEach((transfer, index) => {
      if (transfer.buffered === null) return
      if (index === 0) this.cmp = transfer.buffered
      else this.arr = transfer.buffered
      transfer.buffered = null
    })
  }

  private counterTicksUntilEvent() {
    const count = this.regs[7]
    let next = count > this.arr ? 0x10000 - count : this.arr + 1 - count
    for (const boundary of [this.cmp, this.cmp + 1, this.arr]) if (boundary > count && boundary <= this.arr) next = Math.min(next, boundary - count)
    return Math.max(1, next)
  }

  private advanceCounter(ticks: number) {
    while (ticks > 0 && this.running) {
      const take = Math.min(ticks, this.counterTicksUntilEvent())
      const count = this.regs[7] + take
      ticks -= take
      if (count > this.arr || count > 0xffff) {
        this.regs[7] = 0
        this.applyPreload()
        if (!(this.cfgr & WAVE)) this.waveform = false
        if (!this.continuous) {
          this.running = false
          this.completed = true
        }
      } else {
        this.regs[7] = count
        if (count === this.arr) this.flag(ARRM)
        if (count > this.cmp) this.waveform = true
      }
      if (this.regs[7] === this.cmp) this.flag(CMPM)
      this.drive()
    }
  }

  private kernelTicksUntilEvent() {
    let next = Infinity
    for (const transfer of this.transfers) if (transfer.remaining) next = Math.min(next, transfer.remaining)
    if (this.enableDelay) next = Math.min(next, this.enableDelay)
    else if (this.startDelay) next = Math.min(next, this.startDelay)
    else if (this.running && (this.internalCounting || this.cfgr & CKSEL)) next = Math.min(next, this.counterTicksUntilEvent() * this.divider - this.prescale)
    return next
  }

  private advanceKernel(ticks: number) {
    const wasEnabling = this.enableDelay > 0
    const wasStarting = this.startDelay > 0
    if (wasEnabling) this.enableDelay = Math.max(0, this.enableDelay - ticks)
    else if (wasStarting) {
      this.startDelay = Math.max(0, this.startDelay - ticks)
      if (!this.startDelay) {
        this.running = true
        this.applyPreload()
      }
    } else if (this.running && (this.internalCounting || this.cfgr & CKSEL)) {
      this.prescale += ticks
      const count = Math.floor(this.prescale / this.divider)
      this.prescale %= this.divider
      this.advanceCounter(count)
    }
    this.transferRegisters(ticks)
  }

  private ticksUntilEvent() {
    let next = this.cfgr & CKSEL ? Infinity : this.kernelTicksUntilEvent()
    for (const input of this.inputs) if (input.remaining) next = Math.min(next, input.remaining)
    return next
  }

  tick(cycles: number) {
    if (!this.enabled || !this.accessible || !this.operational || !this.kernelHz) return
    this.phase += cycles * this.kernelHz / this.hclkHz
    let ticks = Math.floor(this.phase + 1e-10)
    this.phase -= ticks
    while (ticks > 0) {
      const take = Math.min(ticks, this.ticksUntilEvent())
      ticks -= take
      this.eventLag = (ticks + this.phase) / this.kernelHz
      if (!(this.cfgr & CKSEL)) this.advanceKernel(take)
      for (const [index, input] of this.inputs.entries()) {
        if (!input.remaining) continue
        input.remaining = Math.max(0, input.remaining - take)
        if (!input.remaining) this.acceptInput(index)
      }
    }
    this.eventLag = 0
    this.updateActive()
  }

  cyclesUntilEvent() {
    if (!this.enabled || !this.accessible || !this.operational || !this.kernelHz) return Infinity
    return Math.max(1, Math.ceil((this.ticksUntilEvent() - this.phase) * this.hclkHz / this.kernelHz - 1e-9))
  }

  private updateActive() {
    this.onActive(this.cyclesUntilEvent() !== Infinity)
  }
}
