/**
 * DMA1/DMA2 (RM0090 §10, RM0385 §8 — the same controller): 8 streams each, 8 request
 * channels per stream, peripheral↔memory and memory↔memory, increments, data sizes,
 * circular mode, half/complete flags and interrupts.
 *
 * Requests: a peripheral whose request line is level-type (USART TXE/RXNE, SPI TXE/RXNE)
 * is asked for its level when the stream starts and after every transfer; pulse-type sources
 * (timer update/compare events) count requests. One transfer every few AHB cycles, so a
 * 100-byte USART transmit paces itself on TXE as on the hardware.
 *
 * Not modelled (reported through `onUnsupported`): the FIFO (data lands as in direct mode),
 * bursts, double-buffer mode, peripheral flow control, PSIZE ≠ MSIZE packing (the value is
 * widened or truncated instead).
 */
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

export type DmaSpec = { name: string; base: number; irqs: number[] }

/** Request routing: `table[stream][channel]` names the source(s), "/"-separated (RM0090 tables 42/43). */
export type DmaRequestTable = string[][]

const CR_EN = 1 << 0
const CR_HTIE = 1 << 3
const CR_TCIE = 1 << 4
const CR_PFCTRL = 1 << 5
const CR_CIRC = 1 << 8
const CR_PINC = 1 << 9
const CR_MINC = 1 << 10
const CR_DBM = 1 << 18
const CR_TEIE = 1 << 2
const F_TEIF = 1 << 3
const F_HTIF = 1 << 4
const F_TCIF = 1 << 5

/** Flag positions of stream `s` inside LISR/HISR. */
const flagShift = (s: number) => [0, 6, 16, 22][s & 3]

const CYCLES_PER_TRANSFER = 4

type Stream = {
  index: number
  /** Latched at EN for circular reload. */
  ndtr0: number
  par0: number
  m0ar0: number
  /** Working pointers and count. */
  par: number
  m0ar: number
  ndtr: number
  /** Pulse requests not yet served. */
  requests: number
  source: string
}

export class Dma extends RegBlock implements Clocked {
  readonly spec: DmaSpec
  private readonly table: DmaRequestTable
  private readonly streams: Stream[] = []
  private isr = [0, 0]

  raiseIrq: (irq: number) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  onActive: (on: boolean) => void = () => {}
  onUnsupported: (what: string) => void = () => {}
  /** Bus access for the transfers. */
  readBus: (addr: number, size: 1 | 2 | 4) => number = () => 0
  writeBus: (addr: number, value: number, size: 1 | 2 | 4) => void = () => {}
  /** Whether a level-type source is asserting its request right now (null: a pulse source or unknown). */
  levelOf: (source: string) => boolean | null = () => null
  private active = false

  constructor(spec: DmaSpec, table: DmaRequestTable) {
    const defs: RegDef[] = [
      { name: "LISR", offset: 0x00, rw: 0 },
      { name: "HISR", offset: 0x04, rw: 0 },
      { name: "LIFCR", offset: 0x08, rw: 0 },
      { name: "HIFCR", offset: 0x0c, rw: 0 },
    ]
    for (let s = 0; s < 8; s++) {
      const b = 0x10 + 0x18 * s
      defs.push({ name: `S${s}CR`, offset: b, rw: 0x0fefffff }, { name: `S${s}NDTR`, offset: b + 4, rw: 0xffff }, { name: `S${s}PAR`, offset: b + 8 }, { name: `S${s}M0AR`, offset: b + 12 }, { name: `S${s}M1AR`, offset: b + 16 }, { name: `S${s}FCR`, offset: b + 20, reset: 0x21, rw: 0x87 })
    }
    super(spec.name, spec.base, 0x400, defs)
    this.spec = spec
    this.table = table
    for (let s = 0; s < 8; s++) this.streams.push({ index: s, ndtr0: 0, par0: 0, m0ar0: 0, par: 0, m0ar: 0, ndtr: 0, requests: 0, source: "" })
  }

  reset() {
    super.reset()
    if (!this.streams) return
    this.isr = [0, 0]
    for (const s of this.streams) {
      s.ndtr = s.ndtr0 = 0
      s.requests = 0
      s.source = ""
    }
    this.setActive(false)
  }

  // --- registers ------------------------------------------------------------------------------

  private cr(s: number) {
    return this.regs[(0x10 + 0x18 * s) >>> 2]
  }

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return super.read(offset, size)
  }
  peek(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return super.peek(offset, size)
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    super.write(offset, value, size)
    this.reschedule()
  }

  protected onRead(d: RegDef, current: number): number {
    if (d.name === "LISR") return this.isr[0]
    if (d.name === "HISR") return this.isr[1]
    const m = /^S(\d)NDTR$/.exec(d.name)
    if (m) return this.streams[Number(m[1])].ndtr
    return current
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    if (d.name === "LIFCR" || d.name === "HIFCR") {
      this.isr[d.name === "LIFCR" ? 0 : 1] &= ~written
      return 0
    }
    const m = /^S(\d)(CR|NDTR|FCR)$/.exec(d.name)
    if (!m) return
    const s = this.streams[Number(m[1])]
    if (m[2] === "NDTR") {
      s.ndtr = next & 0xffff
      return
    }
    if (m[2] === "FCR") {
      if (next & 4 && !(old & 4)) this.onUnsupported(`${this.name} FIFO mode`)
      return
    }
    // CR: EN 0→1 starts the stream; 1→0 aborts it, leaving the count where it was.
    if (next & CR_EN) {
      if (next & CR_DBM && !(old & CR_DBM)) this.onUnsupported(`${this.name} double-buffer mode`)
      if (next & CR_PFCTRL && !(old & CR_PFCTRL)) this.onUnsupported(`${this.name} peripheral flow control`)
      if (next & ((3 << 21) | (3 << 23)) && !(old & ((3 << 21) | (3 << 23)))) this.onUnsupported(`${this.name} bursts`)
    }
    if (next & CR_EN && !(old & CR_EN)) return this.start(s, next)
    if (!(next & CR_EN)) s.requests = 0
    return
  }

  /** EN set: latch the addresses and count; the stream runs while EN reads back as 1. */
  private start(s: Stream, cr: number): number {
    const b = (0x10 + 0x18 * s.index) >>> 2
    s.ndtr0 = s.ndtr = this.regs[b + 1] & 0xffff
    s.par0 = s.par = this.regs[b + 2]
    s.m0ar0 = s.m0ar = this.regs[b + 3]
    s.source = this.table[s.index]?.[(cr >>> 25) & 7] ?? ""
    s.requests = 0
    if (s.ndtr === 0) return cr & ~CR_EN
    this.regs[b] = cr
    this.poll(s)
    this.setActive(true)
    return cr
  }

  /** Refresh a level-type source's request. */
  private poll(s: Stream) {
    const dir = (this.cr(s.index) >>> 6) & 3
    if (dir === 2) return
    let level: boolean | null = null
    for (const src of s.source.split("/")) {
      const l = this.levelOf(src)
      if (l !== null) level = level || l
    }
    if (level === true) s.requests = Math.max(s.requests, 1)
    else if (level === false) s.requests = 0
  }

  /** A pulse-type source (timer event) or a level source turning on: one request for its streams. */
  request(source: string) {
    let any = false
    for (const s of this.streams) {
      const cr = this.cr(s.index)
      if (!(cr & CR_EN) || s.ndtr === 0 || !s.source.split("/").includes(source)) continue
      const level = this.levelOf(source)
      if (level === null) s.requests++
      else if (level) s.requests = Math.max(s.requests, 1)
      any = true
    }
    if (any) this.setActive(true)
  }

  /** Whether any enabled stream has something to move. */
  private busy() {
    for (const s of this.streams) {
      const cr = this.cr(s.index)
      if (!(cr & CR_EN) || s.ndtr === 0) continue
      if (((cr >>> 6) & 3) === 2 || s.requests > 0) return true
    }
    return false
  }

  // --- transfers ------------------------------------------------------------------------------

  private transfer(s: Stream) {
    const b = (0x10 + 0x18 * s.index) >>> 2
    const cr = this.regs[b]
    const dir = (cr >>> 6) & 3
    const psize = (1 << ((cr >>> 11) & 3)) as 1 | 2 | 4
    const msize = (1 << ((cr >>> 13) & 3)) as 1 | 2 | 4
    try {
      if (dir === 0) {
        // Peripheral → memory.
        const v = this.readBus(s.par, psize)
        this.writeBus(s.m0ar, v, msize)
      } else if (dir === 1) {
        const v = this.readBus(s.m0ar, msize)
        this.writeBus(s.par, v, psize)
      } else {
        // Memory → memory: PAR is the source, M0AR the destination.
        const v = this.readBus(s.par, psize)
        this.writeBus(s.m0ar, v, msize)
      }
    } catch {
      // An address nothing answers: transfer error, stream disabled.
      this.flag(s, F_TEIF, CR_TEIE)
      this.regs[b] &= ~CR_EN
      s.requests = 0
      return
    }
    if (cr & CR_PINC) s.par += psize
    if (cr & CR_MINC) s.m0ar += msize
    s.ndtr--
    if (s.requests > 0) s.requests--
    const half = s.ndtr0 >>> 1
    if (s.ndtr === s.ndtr0 - half && half > 0) this.flag(s, F_HTIF, CR_HTIE)
    if (s.ndtr === 0) {
      this.flag(s, F_TCIF, CR_TCIE)
      if (cr & CR_CIRC) {
        s.ndtr = s.ndtr0
        s.par = s.par0
        s.m0ar = s.m0ar0
      } else {
        this.regs[b] &= ~CR_EN
        s.requests = 0
        return
      }
    }
    this.poll(s)
  }

  private flag(s: Stream, bit: number, enable: number) {
    const half = s.index >> 2
    this.isr[half] |= bit << flagShift(s.index)
    if (this.cr(s.index) & enable) this.raiseIrq(this.spec.irqs[s.index])
  }

  // --- clocking -------------------------------------------------------------------------------

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }
  private budget = 0

  tick(cycles: number) {
    this.budget += cycles
    while (this.budget >= CYCLES_PER_TRANSFER) {
      let moved = false
      for (const s of this.streams) {
        const cr = this.cr(s.index)
        if (!(cr & CR_EN) || s.ndtr === 0) continue
        if (((cr >>> 6) & 3) === 2 || s.requests > 0) {
          this.transfer(s)
          moved = true
          this.budget -= CYCLES_PER_TRANSFER
          if (this.budget < CYCLES_PER_TRANSFER) break
        }
      }
      if (!moved) break
    }
    if (!this.busy()) {
      this.budget = 0
      this.setActive(false)
    }
  }

  cyclesUntilEvent(): number {
    return this.busy() ? Math.max(1, CYCLES_PER_TRANSFER - this.budget) : Infinity
  }
}

// --- the STM32F4/F7 controllers ---------------------------------------------------------------

export const DMA_SPECS: DmaSpec[] = [
  { name: "DMA1", base: 0x40026000, irqs: [11, 12, 13, 14, 15, 16, 17, 47] },
  { name: "DMA2", base: 0x40026400, irqs: [56, 57, 58, 59, 60, 68, 69, 70] },
]

// [stream][channel] → request source (RM0090 tables 42 and 43; "" = none).
export const DMA1_REQUESTS: DmaRequestTable = [
  ["SPI3_RX", "I2C1_RX", "TIM4_CH1", "I2S3_EXT_RX", "UART5_RX", "UART8_TX", "TIM5_CH3/TIM5_UP", ""],
  ["", "", "", "TIM2_UP/TIM2_CH3", "USART3_RX", "UART7_TX", "TIM5_CH4/TIM5_TRIG", "TIM6_UP"],
  ["SPI3_RX", "TIM7_UP", "I2S3_EXT_RX", "I2C3_RX", "UART4_RX", "TIM3_CH4/TIM3_UP", "TIM5_CH1", "I2C2_RX"],
  ["SPI2_RX", "", "TIM4_CH2", "I2S2_EXT_RX", "USART3_TX", "UART7_RX", "TIM5_CH4/TIM5_TRIG", "I2C2_RX"],
  ["SPI2_TX", "TIM7_UP", "I2S2_EXT_TX", "I2C3_TX", "UART4_TX", "TIM3_CH1/TIM3_TRIG", "TIM5_CH2", "USART3_TX"],
  ["SPI3_TX", "I2C1_RX", "I2S3_EXT_TX", "TIM2_CH1", "USART2_RX", "TIM3_CH2", "", "DAC1"],
  ["", "I2C1_TX", "TIM4_UP", "TIM2_CH2/TIM2_CH4", "USART2_TX", "UART8_RX", "TIM5_UP", "DAC2"],
  ["SPI3_TX", "I2C1_TX", "TIM4_CH3", "TIM2_UP/TIM2_CH4", "UART5_TX", "TIM3_CH3", "", "I2C2_TX"],
]
export const DMA2_REQUESTS: DmaRequestTable = [
  ["ADC1", "", "ADC3", "SPI1_RX", "SPI4_RX", "", "TIM1_TRIG", ""],
  ["", "DCMI", "ADC3", "", "SPI4_TX", "USART6_RX", "TIM1_CH1", "TIM8_UP"],
  ["TIM8_CH1/TIM8_CH2/TIM8_CH3", "ADC2", "", "SPI1_RX", "USART1_RX", "USART6_RX", "TIM1_CH2", "TIM8_CH1"],
  ["", "ADC2", "SPI5_RX", "SPI1_TX", "SDIO", "SPI4_RX", "TIM1_CH1", "TIM8_CH2"],
  ["ADC1", "", "SPI5_TX", "", "", "SPI4_TX", "TIM1_CH4/TIM1_TRIG/TIM1_COM", "TIM8_CH3"],
  ["", "SPI6_TX", "CRYP_OUT", "SPI1_TX", "USART1_RX", "", "TIM1_UP", "SPI5_RX"],
  ["TIM1_CH1/TIM1_CH2/TIM1_CH3", "SPI6_RX", "CRYP_IN", "", "SDIO", "USART6_TX", "TIM1_CH3", "SPI5_TX"],
  ["", "DCMI", "HASH_IN", "", "USART1_TX", "USART6_TX", "", "TIM8_CH4/TIM8_TRIG/TIM8_COM"],
]
