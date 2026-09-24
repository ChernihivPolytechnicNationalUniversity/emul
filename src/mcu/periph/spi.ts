/**
 * SPI (RM0090 §28, RM0385 §32). One shifter, two flavours of the same register map: the F4
 * ("v1": DFF picks 8/16 bits, one-word holding registers) and the F7 ("v2": DS[3:0] picks 4–16
 * bits, 4-byte FIFOs on both sides, FRXTH, data packing on 16-bit accesses).
 *
 * Modelled: master and slave, CPOL/CPHA, MSB/LSB first, the baud prescaler, NSS as software
 * (SSM/SSI) or hardware (input in slave mode; SSOE output in master mode, NSSP pulses on v2),
 * TXE/RXNE/BSY/OVR/MODF with their interrupts, receive-only master mode. The master drives
 * SCK/MOSI and samples MISO on its pins; the slave samples SCK/MOSI/NSS and drives MISO while
 * selected, releasing it otherwise.
 *
 * Not modelled (reported through `unsupported`): bidirectional single-wire mode, CRC, TI
 * frame format, I²S. DMA requests (TXDMAEN/RXDMAEN) are level lines the DMA polls.
 *
 * Lazy like the timers and USARTs: the master's clock edges are events (see `Clocked`); the
 * slave only moves when a pin it listens to changes.
 */
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

export type SpiFlavour = "v1" | "v2"

export type SpiSpec = {
  name: string
  base: number
  apb: 1 | 2
  irq: number
}

export type SpiLine = "SCK" | "MOSI" | "MISO" | "NSS"

const regs = (flavour: SpiFlavour): RegDef[] => [
  { name: "CR1", offset: 0x00, rw: 0xffff },
  { name: "CR2", offset: 0x04, rw: flavour === "v1" ? 0xf7 : 0x7fff, reset: flavour === "v1" ? 0 : 0x0700 },
  { name: "SR", offset: 0x08, reset: 0x0002, rw: 0 },
  { name: "DR", offset: 0x0c, rw: 0xffff },
  { name: "CRCPR", offset: 0x10, reset: 7, rw: 0xffff },
  { name: "RXCRCR", offset: 0x14, rw: 0 },
  { name: "TXCRCR", offset: 0x18, rw: 0 },
  { name: "I2SCFGR", offset: 0x1c, rw: 0xfbf },
  { name: "I2SPR", offset: 0x20, reset: 2, rw: 0x3ff },
]

const CR1_CPHA = 1 << 0
const CR1_CPOL = 1 << 1
const CR1_MSTR = 1 << 2
const CR1_SPE = 1 << 6
const CR1_LSBFIRST = 1 << 7
const CR1_SSI = 1 << 8
const CR1_SSM = 1 << 9
const CR1_RXONLY = 1 << 10
const CR1_DFF = 1 << 11
const CR1_CRCEN = 1 << 13
const CR1_BIDIMODE = 1 << 15
const CR2_RXDMAEN = 1 << 0
const CR2_TXDMAEN = 1 << 1
const CR2_SSOE = 1 << 2
const CR2_NSSP = 1 << 3
const CR2_FRF = 1 << 4
const CR2_ERRIE = 1 << 5
const CR2_RXNEIE = 1 << 6
const CR2_TXEIE = 1 << 7
const CR2_FRXTH = 1 << 12
const SR_RXNE = 1 << 0
const SR_TXE = 1 << 1
const SR_MODF = 1 << 5
const SR_OVR = 1 << 6
const SR_BSY = 1 << 7

/** FIFO occupancy in bytes → FRLVL/FTLVL code (v2). */
const fifoLevel = (n: number) => (n === 0 ? 0 : n === 1 ? 1 : n === 2 ? 2 : 3)

/** A word in flight: what goes out, what has come in, and how many clock edges have passed. */
type Frame = { tx: number; rx: number; edge: number; bits: number }

export class Spi extends RegBlock implements Clocked {
  readonly spec: SpiSpec
  readonly flavour: SpiFlavour

  /** Transmit and receive FIFOs as words (v1: at most one entry each). */
  private txFifo: number[] = []
  private rxFifo: number[] = []
  /** Slave: the word already taken from the FIFO, waiting for the master's clock, or -1. */
  private shiftOut = -1
  private frame: Frame | null = null
  private ovr = false
  private modf = false
  /** OVR clears on DR read then SR read; MODF on SR read then CR1 write. */
  private ovrArmed = false
  private modfArmed = false
  /** Core cycles to the master's next SCK edge. */
  private due = Infinity
  private sckIn = false
  private mosiIn = false
  private misoIn = false
  private nssIn = true
  /** Levels this block drives (null: released). */
  private readonly out: Record<SpiLine, boolean | null> = { SCK: null, MOSI: null, MISO: null, NSS: null }

  private pclkHz = 16e6
  private hclkHz = 16e6

  onOut: (line: SpiLine, level: boolean | null) => void = () => {}
  raiseIrq: (irq: number) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  onActive: (on: boolean) => void = () => {}
  /** Modes the firmware turned on that the model lacks, by name. */
  onUnsupported: (what: string) => void = () => {}
  /** A DMA request line (TX: TXE with TXDMAEN, RX: RXNE with RXDMAEN) may have turned on. */
  onDmaRequest: (line: "tx" | "rx") => void = () => {}
  private active = false

  constructor(spec: SpiSpec, flavour: SpiFlavour) {
    super(spec.name, spec.base, 0x400, regs(flavour))
    this.spec = spec
    this.flavour = flavour
  }

  setClock(pclkHz: number, hclkHz: number) {
    this.pclkHz = pclkHz
    this.hclkHz = hclkHz
  }

  reset() {
    super.reset()
    if (!this.txFifo) return
    this.txFifo = []
    this.rxFifo = []
    this.shiftOut = -1
    this.frame = null
    this.ovr = this.modf = this.ovrArmed = this.modfArmed = false
    this.due = Infinity
    this.nssIn = true
    this.setActive(false)
    this.refreshOutputs()
  }

  // --- configuration ------------------------------------------------------------------------

  private cr1() {
    return this.regs[0]
  }
  private cr2() {
    return this.regs[1]
  }
  private enabled() {
    return (this.cr1() & CR1_SPE) !== 0
  }
  private master() {
    return (this.cr1() & CR1_MSTR) !== 0
  }
  private cpol() {
    return (this.cr1() & CR1_CPOL) !== 0
  }
  private cpha() {
    return (this.cr1() & CR1_CPHA) !== 0
  }
  private lsbFirst() {
    return (this.cr1() & CR1_LSBFIRST) !== 0
  }
  /** Bits per word. */
  private bits() {
    if (this.flavour === "v1") return this.cr1() & CR1_DFF ? 16 : 8
    const ds = (this.cr2() >>> 8) & 0xf
    return ds < 3 ? 8 : ds + 1
  }
  private bytesPerWord() {
    return this.bits() > 8 ? 2 : 1
  }
  private fifoBytes() {
    return this.flavour === "v1" ? this.bytesPerWord() : 4
  }
  /** Core cycles per half SCK period: SCK = pclk / 2^(BR+1). */
  private halfCycles() {
    const br = (this.cr1() >>> 3) & 7
    return (2 ** br * this.hclkHz) / this.pclkHz
  }
  /** Slave select as the slave sees it. */
  private selected() {
    return this.cr1() & CR1_SSM ? (this.cr1() & CR1_SSI) === 0 : !this.nssIn
  }

  // --- status -----------------------------------------------------------------------------

  private txBytes() {
    return this.txFifo.length * this.bytesPerWord()
  }
  private rxBytes() {
    return this.rxFifo.length * this.bytesPerWord()
  }
  private txe() {
    return this.flavour === "v1" ? this.txFifo.length === 0 : this.txBytes() <= 2
  }
  private rxne() {
    if (this.flavour === "v1") return this.rxFifo.length > 0
    return this.rxBytes() >= (this.cr2() & CR2_FRXTH ? 1 : 2)
  }
  private busy() {
    return this.frame !== null || (this.master() && this.enabled() && this.txFifo.length > 0)
  }
  private status() {
    return (
      (this.rxne() ? SR_RXNE : 0) |
      (this.txe() ? SR_TXE : 0) |
      (this.modf ? SR_MODF : 0) |
      (this.ovr ? SR_OVR : 0) |
      (this.busy() ? SR_BSY : 0) |
      (this.flavour === "v2" ? (fifoLevel(this.rxBytes()) << 9) | (fifoLevel(this.txBytes()) << 11) : 0)
    )
  }

  private checkIrq() {
    const cr2 = this.cr2()
    if ((cr2 & CR2_TXEIE && this.txe()) || (cr2 & CR2_RXNEIE && this.rxne()) || (cr2 & CR2_ERRIE && (this.ovr || this.modf))) this.raiseIrq(this.spec.irq)
    if (cr2 & CR2_TXDMAEN && this.txe()) this.onDmaRequest("tx")
    if (cr2 & CR2_RXDMAEN && this.rxne()) this.onDmaRequest("rx")
  }

  /** Level of a DMA request line, for the DMA controller. */
  dmaLevel(line: "tx" | "rx"): boolean {
    const cr2 = this.cr2()
    return line === "tx" ? (cr2 & CR2_TXDMAEN) !== 0 && this.enabled() && this.txe() : (cr2 & CR2_RXDMAEN) !== 0 && this.rxne()
  }

  // --- register file ------------------------------------------------------------------------

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    if ((offset & ~3) === 0x0c) return this.popRx(size)
    return super.read(offset, size)
  }
  /** DR shows the word at the head of the receive FIFO without popping it; SR without arming or clearing OVR/MODF. */
  peek(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    if ((offset & ~3) === 0x0c) return this.rxFifo[0] ?? 0
    return super.peek(offset, size)
  }
  protected peekValue(d: RegDef, current: number): number {
    return d.name === "SR" ? this.status() : this.onRead(d, current)
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    if ((offset & ~3) === 0x0c) this.pushTx(value, size)
    else super.write(offset, value, size)
    this.reschedule()
  }

  protected onRead(d: RegDef, current: number): number {
    if (d.name === "SR") {
      const v = this.status()
      if (this.ovrArmed) this.ovr = this.ovrArmed = false
      this.modfArmed = this.modf
      return v
    }
    return current
  }

  protected onWrite(d: RegDef, next: number, old: number): number | void {
    switch (d.name) {
      case "CR1": {
        this.regs[0] = next
        if (this.modfArmed) this.modf = this.modfArmed = false
        if (next & CR1_BIDIMODE && !(old & CR1_BIDIMODE)) this.onUnsupported(`${this.name} bidirectional mode`)
        if (next & CR1_CRCEN && !(old & CR1_CRCEN)) this.onUnsupported(`${this.name} CRC`)
        if (!(next & CR1_SPE) && old & CR1_SPE) this.stop()
        if (next & CR1_SPE && !(old & CR1_SPE) && this.modf) this.regs[0] &= ~CR1_SPE // MODF keeps it disabled
        this.refreshOutputs()
        this.checkModf()
        this.pump()
        this.checkIrq()
        return this.regs[0]
      }
      case "CR2":
        this.regs[1] = next
        if (next & CR2_FRF && !(old & CR2_FRF)) this.onUnsupported(`${this.name} TI frame format`)
        this.refreshOutputs()
        this.checkModf()
        this.checkIrq()
        return
      case "I2SCFGR":
        if (next & (1 << 11) && !(old & (1 << 11))) this.onUnsupported(`${this.name} I²S`)
        return
    }
  }

  /** Read DR: pop one word, or two packed 8-bit words on a 16-bit access (v2 data packing). */
  private popRx(size: 1 | 2 | 4): number {
    this.ovrArmed = true
    let v = this.rxFifo.length ? this.rxFifo.shift()! : 0
    if (this.flavour === "v2" && this.bits() <= 8 && size > 1 && this.rxFifo.length) v |= this.rxFifo.shift()! << 8
    this.checkIrq()
    return v
  }

  /** Write DR: queue one word, or two 8-bit words from a 16-bit access on v2. */
  private pushTx(value: number, size: 1 | 2 | 4) {
    const words = this.flavour === "v2" && this.bits() <= 8 && size > 1 ? [value & 0xff, (value >>> 8) & 0xff] : [value & 0xffff]
    for (const w of words) {
      if (this.txBytes() + this.bytesPerWord() > this.fifoBytes()) {
        if (this.flavour === "v1") this.txFifo[0] = w // overwrite the holding register, as the hardware does
        continue
      }
      this.txFifo.push(w)
    }
    this.pump()
    this.checkIrq()
  }

  // --- the shifter ----------------------------------------------------------------------------

  /** Bit `k` of a word in transmission order. */
  private bitOf(word: number, k: number, bits: number) {
    const index = this.lsbFirst() ? k : bits - 1 - k
    return ((word >>> index) & 1) === 1
  }
  private withBit(word: number, k: number, bits: number, level: boolean) {
    const index = this.lsbFirst() ? k : bits - 1 - k
    return level ? word | (1 << index) : word
  }

  /** Start whatever can start: a master frame, or the slave's next word into its shifter. */
  private pump() {
    if (!this.enabled()) return
    if (this.master()) {
      if (this.frame) return
      const rxonly = (this.cr1() & CR1_RXONLY) !== 0
      if (!this.txFifo.length && !rxonly) return
      const tx = this.txFifo.length ? this.txFifo.shift()! : 0
      this.frame = { tx, rx: 0, edge: 0, bits: this.bits() }
      if (!this.cpha()) this.drive("MOSI", this.bitOf(tx, 0, this.frame.bits))
      this.due = this.halfCycles()
      this.drive("NSS", this.nssOut())
      this.setActive(true)
    } else if (this.shiftOut < 0 && this.txFifo.length) {
      this.shiftOut = this.txFifo.shift()!
      this.idleMiso()
    }
  }

  /** Slave with CPHA = 0 shows the first bit as soon as it is selected and has a word. */
  private idleMiso() {
    if (this.master() || this.frame || !this.selected() || !this.enabled()) return
    if (!this.cpha()) this.drive("MISO", this.shiftOut >= 0 ? this.bitOf(this.shiftOut, 0, this.bits()) : false)
  }

  /** Master: one SCK edge. */
  private masterEdge() {
    const f = this.frame!
    f.edge++
    const leading = (f.edge & 1) === 1
    const sample = this.cpha() ? !leading : leading
    this.drive("SCK", leading ? !this.cpol() : this.cpol())
    if (sample) {
      const k = (f.edge - 1) >> 1
      f.rx = this.withBit(f.rx, k, f.bits, this.misoIn)
    } else {
      const k = this.cpha() ? (f.edge - 1) >> 1 : f.edge >> 1
      if (k < f.bits) this.drive("MOSI", this.bitOf(f.tx, k, f.bits))
    }
    if (f.edge === 2 * f.bits) {
      this.frame = null
      this.receive(f.rx)
      this.pump()
      if (!this.frame) {
        this.due = Infinity
        this.drive("NSS", this.nssOut())
        this.setActive(false)
      }
    }
  }

  /** Slave: the master's SCK moved. */
  private slaveEdge(level: boolean) {
    if (!this.enabled() || this.master() || !this.selected()) return
    const leading = level !== this.cpol()
    if (!this.frame) {
      if (!leading) return // trailing edge with nothing started: the tail of an aborted word
      this.frame = { tx: this.shiftOut >= 0 ? this.shiftOut : 0, rx: 0, edge: 0, bits: this.bits() }
      this.shiftOut = -1
      this.pump() // take the next word into the shifter as the FIFO drains
    }
    const f = this.frame
    f.edge++
    const sample = this.cpha() ? !leading : leading
    if (sample) {
      const k = (f.edge - 1) >> 1
      f.rx = this.withBit(f.rx, k, f.bits, this.mosiIn)
    } else {
      const k = this.cpha() ? (f.edge - 1) >> 1 : f.edge >> 1
      if (k < f.bits) this.drive("MISO", this.bitOf(f.tx, k, f.bits))
    }
    if (f.edge === 2 * f.bits) {
      this.frame = null
      this.receive(f.rx)
      this.pump()
      this.idleMiso()
    }
  }

  private receive(word: number) {
    if (this.rxBytes() + this.bytesPerWord() > this.fifoBytes()) {
      this.ovr = true
    } else this.rxFifo.push(word)
    this.checkIrq()
  }

  /** SPE cleared: whatever is in flight is dropped, the pins are released. */
  private stop() {
    this.frame = null
    this.due = Infinity
    this.setActive(false)
    if (this.master()) this.txFifo = []
  }

  // --- pins -------------------------------------------------------------------------------

  private nssOut(): boolean | null {
    const cr1 = this.cr1()
    if (!(cr1 & CR1_SPE) || !(cr1 & CR1_MSTR) || cr1 & CR1_SSM || !(this.cr2() & CR2_SSOE)) return null
    // NSS output: low while enabled, or pulsed high between words with NSSP (v2).
    return this.flavour === "v2" && this.cr2() & CR2_NSSP ? this.frame === null : false
  }

  private drive(line: SpiLine, level: boolean | null) {
    if (this.out[line] === level) return
    this.out[line] = level
    this.onOut(line, level)
  }

  /** Idle levels for the current mode; called on configuration changes. */
  private refreshOutputs() {
    if (!this.enabled()) {
      for (const line of ["SCK", "MOSI", "MISO", "NSS"] as const) this.drive(line, null)
      return
    }
    if (this.master()) {
      this.drive("MISO", null)
      if (!this.frame) this.drive("SCK", this.cpol())
      if (this.out.MOSI === null) this.drive("MOSI", false)
      this.drive("NSS", this.nssOut())
    } else {
      this.drive("SCK", null)
      this.drive("MOSI", null)
      this.drive("NSS", null)
      if (this.selected()) {
        if (this.out.MISO === null) this.drive("MISO", false)
        this.idleMiso()
      } else this.drive("MISO", null)
    }
  }

  /** Master with a hardware NSS input pulled low by someone else: mode fault. */
  private checkModf() {
    const cr1 = this.cr1()
    if (!(cr1 & CR1_SPE) || !(cr1 & CR1_MSTR)) return
    const nssLow = cr1 & CR1_SSM ? (cr1 & CR1_SSI) === 0 : !this.nssIn
    if (!nssLow || (!(cr1 & CR1_SSM) && this.cr2() & CR2_SSOE)) return
    this.modf = true
    this.regs[0] &= ~(CR1_SPE | CR1_MSTR)
    this.stop()
    this.refreshOutputs()
    this.checkIrq()
  }

  /** A pin this block listens to changed (the SoC syncs the block first). */
  pinEdge(line: SpiLine, level: boolean) {
    switch (line) {
      case "SCK":
        if (this.sckIn === level) return
        this.sckIn = level
        this.slaveEdge(level)
        return
      case "MOSI":
        this.mosiIn = level
        return
      case "MISO":
        this.misoIn = level
        return
      case "NSS":
        if (this.nssIn === level) return
        this.nssIn = level
        if (this.master()) {
          this.checkModf()
          return
        }
        if (!this.enabled() || this.cr1() & CR1_SSM) return
        if (level) {
          // Deselected: the word in flight is abandoned, MISO floats.
          if (this.frame) {
            this.shiftOut = this.frame.tx
            this.frame = null
          }
          this.drive("MISO", null)
        } else {
          this.drive("MISO", false)
          this.idleMiso()
        }
        return
    }
  }

  // --- clocking -------------------------------------------------------------------------------

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  tick(cycles: number) {
    if (!this.frame || !this.master()) return
    this.due -= cycles
    while (this.frame && this.due <= 0) {
      this.masterEdge()
      if (this.frame) this.due += this.halfCycles()
    }
  }

  cyclesUntilEvent(): number {
    return this.frame && this.master() ? Math.max(1, Math.ceil(this.due)) : Infinity
  }
}

// --- the STM32F4/F7 SPI set -----------------------------------------------------------------

export const SPI_SPECS: SpiSpec[] = [
  { name: "SPI1", base: 0x40013000, apb: 2, irq: 35 },
  { name: "SPI2", base: 0x40003800, apb: 1, irq: 36 },
  { name: "SPI3", base: 0x40003c00, apb: 1, irq: 51 },
  { name: "SPI4", base: 0x40013400, apb: 2, irq: 84 },
  { name: "SPI5", base: 0x40015000, apb: 2, irq: 85 },
  { name: "SPI6", base: 0x40015400, apb: 2, irq: 86 },
]

export type SpiPad = { port: number; pin: number; af: number; line: SpiLine }

/** Pads per line (DS9405 Table 12 / DS10916 Table 13); "PD6@5" marks a pad on a different AF. */
const PADS: Record<string, string> = {
  SPI1: "NSS PA4 PA15 PG10; SCK PA5 PB3 PG11; MISO PA6 PB4 PG9; MOSI PA7 PB5 PD7 @5",
  SPI2: "NSS PB9 PB12 PI0 PB4@7; SCK PB10 PB13 PD3 PI1 PA9; MISO PB14 PC2 PI2; MOSI PB15 PC3 PI3 PC1 @5",
  SPI3: "NSS PA4 PA15; SCK PB3 PC10; MISO PB4 PC11; MOSI PB5 PC12 PD6@5 @6",
  SPI4: "NSS PE4 PE11; SCK PE2 PE12; MISO PE5 PE13; MOSI PE6 PE14 @5",
  SPI5: "NSS PF6 PH5; SCK PF7 PH6; MISO PF8 PH7; MOSI PF9 PF11 @5",
  SPI6: "NSS PG8; SCK PG13; MISO PG12; MOSI PG14 @5",
}

export function spiPads(name: string): SpiPad[] {
  const spec = PADS[name]
  if (!spec) return []
  const at = spec.lastIndexOf("@")
  const body = spec.slice(0, at)
  const af = Number(spec.slice(at + 1))
  const out: SpiPad[] = []
  for (const group of body.split(";")) {
    const [tag, ...pads] = group.trim().split(/\s+/)
    for (const p of pads) {
      const pm = /^P([A-K])(\d+)(?:@(\d+))?$/.exec(p)!
      out.push({ port: "ABCDEFGHIJK".indexOf(pm[1]), pin: Number(pm[2]), af: pm[3] ? Number(pm[3]) : af, line: tag as SpiLine })
    }
  }
  return out
}
