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
 * I²S (RM0090 §28.4, F4 SPI2/SPI3 = I2S2/I2S3 only, §28.2.2): I2SMOD switches the block over,
 * I2SE enables it. Master transmit and master receive; Philips, MSB-justified, LSB-justified and
 * PCM short/long frame (§28.4.3); DATLEN 16/24/32 with CHLEN 16/32 and the two-halfword DR
 * sequence for 24/32-bit data (Figures 265–278); CKPOL. The bit clock comes from I2SxCLK (the
 * PLLI2S R output, read through the SoC's `i2sClock` hook) through I2SDIV/ODD and, with MCKOE, the
 * fixed /8 or /4 stage (§28.4.4, Figure 282). CK (SCK pad), WS (NSS pad) and SD (MOSI pad) are
 * driven edge by edge, each edge one `Clocked` event stamped with its exact time; the receiver
 * samples SD on the CK edge opposite the shifting one. TXE, RXNE, CHSIDE, BSY, OVR with
 * TXEIE/RXNEIE/ERRIE and the TXDMAEN/RXDMAEN request lines (§28.4.7–§28.4.10).
 * The one deliberate deviation: MCK (256 × Fs, §28.4.1) is not toggled — that would be ~12 M
 * events per second — the MCK pad is held high while MCKOE and I2SE are set in master mode, and
 * `mckHz()` gives the frequency it stands for, so a codec model can read its master clock.
 *
 * Not modelled (reported through `onUnsupported`): bidirectional single-wire mode, CRC, TI frame
 * format; in I²S: slave transmit/receive (and with it UDR and FRE, which only a slave sets,
 * §28.4.8), full duplex through I2S2ext/I2S3ext (§28.4.2; the ext blocks are not mapped), the
 * external I2S_CKIN clock (RCC_CFGR.I2SSRC = 1, reported by the RCC), I2SDIV 0/1 (forbidden,
 * §28.5.9: no clock), DATLEN = 11 (not allowed), I²S on the F7 (v2) blocks. DMA requests
 * (TXDMAEN/RXDMAEN) are level lines the DMA polls.
 *
 * Lazy like the timers and USARTs: the master's clock edges are events (see `Clocked`); the
 * slave only moves when a pin it listens to changes.
 */
import type { AfMap } from "../chip"
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

export type SpiFlavour = "v1" | "v2"

export type SpiSpec = {
  name: string
  base: number
  apb: 1 | 2
  irq: number
}

/** SPI lines; in I²S mode CK is SCK, WS is NSS, SD is MOSI (§28.4.1), and MCK is its own pad. */
export type SpiLine = "SCK" | "MOSI" | "MISO" | "NSS" | "MCK"

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
const SR_CHSIDE = 1 << 2
// SPI_I2SCFGR / SPI_I2SPR (§28.5.8, §28.5.9)
const I2SCFGR_I2SMOD = 1 << 11
const I2SCFGR_I2SE = 1 << 10
const I2SCFGR_PCMSYNC = 1 << 7
const I2SCFGR_CKPOL = 1 << 3
const I2SPR_ODD = 1 << 8
const I2SPR_MCKOE = 1 << 9
const STD_PHILIPS = 0
const STD_LSB = 2
const STD_PCM = 3

/**
 * One halfword of a channel: its first bit slot within the channel and the bits of the 16 that go
 * on the wire (the rest forced to 0, §28.4.3).
 */
type I2sSegment = { at: number; mask: number }

/** A running I²S master: the configuration it started with and where it is in the frame. */
type I2sRun = {
  tx: boolean
  std: number
  pcmLong: boolean
  ckpol: boolean
  /** Bits per channel (per word in PCM). */
  ch: number
  /** Slots per frame: two channels, or one word in PCM. */
  frame: number
  /** 1 when SD runs one CK behind WS (Philips, PCM short frame), else 0. */
  delay: number
  segs: I2sSegment[]
  /** Pin slot since the start; the edge within it (0: before the sampling edge, 1: after). */
  slot: number
  half: number
  shift: number
  rx: number
}

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
  private readonly out: Record<SpiLine, boolean | null> = { SCK: null, MOSI: null, MISO: null, NSS: null, MCK: null }

  private pclkHz = 16e6
  private hclkHz = 16e6

  // I²S state (§28.4): the 16-bit Tx/Rx buffers, the frame engine, CHSIDE.
  private i2s: I2sRun | null = null
  private i2sTx = 0
  private i2sTxFull = false
  private i2sRx = 0
  private i2sRxFull = false
  private chside = false
  /** Lag of the edge being driven behind "now", in seconds (edges caught up late by `tick`). */
  private lag = 0

  /** A line changed; `lag`: how long ago, in seconds (0 = now). */
  onOut: (line: SpiLine, level: boolean | null, lag: number) => void = () => {}
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
  /** I2SxCLK in Hz (RM0090 §28.4.4, Figure 282): the PLLI2S R output, or 0. Set by the SoC. */
  i2sClock: () => number = () => 0

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
    this.i2s = null
    this.i2sTxFull = this.i2sRxFull = this.chside = false
    this.i2sTx = this.i2sRx = 0
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
    // I²S: TXE is reset while I2SE is off (§28.4.7). UDR (bit 3) is never set: slave-only, not modelled.
    if (this.i2sMode()) return this.i2sOn() && !this.i2sTxFull
    return this.flavour === "v1" ? this.txFifo.length === 0 : this.txBytes() <= 2
  }
  private rxne() {
    if (this.i2sMode()) return this.i2sRxFull
    if (this.flavour === "v1") return this.rxFifo.length > 0
    return this.rxBytes() >= (this.cr2() & CR2_FRXTH ? 1 : 2)
  }
  private busy() {
    return this.frame !== null || (this.master() && this.enabled() && this.txFifo.length > 0)
  }
  private status() {
    if (this.i2sMode())
      // BSY: set through master transmission, kept low in master receive (§28.4.7). UDR and FRE
      // are slave-only (§28.4.8) and the slave modes are not modelled, so they stay 0.
      return (this.rxne() ? SR_RXNE : 0) | (this.txe() ? SR_TXE : 0) | (this.chside ? SR_CHSIDE : 0) | (this.ovr ? SR_OVR : 0) | (this.i2s?.tx ? SR_BSY : 0)
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
    // ERRIE covers OVR and MODF in SPI mode, OVR (and the unmodelled UDR/FRE) in I²S mode (§28.5.2).
    if ((cr2 & CR2_TXEIE && this.txe()) || (cr2 & CR2_RXNEIE && this.rxne()) || (cr2 & CR2_ERRIE && (this.ovr || this.modf))) this.raiseIrq(this.spec.irq)
    if (cr2 & CR2_TXDMAEN && this.txe()) this.onDmaRequest("tx")
    if (cr2 & CR2_RXDMAEN && this.rxne()) this.onDmaRequest("rx")
  }

  /** Level of a DMA request line, for the DMA controller. */
  dmaLevel(line: "tx" | "rx"): boolean {
    const cr2 = this.cr2()
    // I²S DMA works exactly as in SPI mode (§28.4.10): the requests follow TXE and RXNE.
    const on = this.i2sMode() ? this.i2sOn() : this.enabled()
    return line === "tx" ? (cr2 & CR2_TXDMAEN) !== 0 && on && this.txe() : (cr2 & CR2_RXDMAEN) !== 0 && this.rxne()
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
    if ((offset & ~3) === 0x0c) return this.i2sMode() ? this.i2sRx : (this.rxFifo[0] ?? 0)
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
      // OVR: a DR read then an SR read (§28.4.8, same as SPI mode).
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
        if (this.i2sMode()) return next // SPI_CR1 is not used in I²S mode (§28.4.1)
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
        this.regs[7] = next
        this.i2sConfig(next, old)
        return this.regs[7]
    }
  }

  /** Read DR: pop one word, or two packed 8-bit words on a 16-bit access (v2 data packing). */
  private popRx(size: 1 | 2 | 4): number {
    this.ovrArmed = true
    if (this.i2sMode()) {
      // On overrun the buffer keeps the older, correctly received halfword (§28.4.8).
      this.i2sRxFull = false
      this.checkIrq()
      return this.i2sRx
    }
    let v = this.rxFifo.length ? this.rxFifo.shift()! : 0
    if (this.flavour === "v2" && this.bits() <= 8 && size > 1 && this.rxFifo.length) v |= this.rxFifo.shift()! << 8
    this.checkIrq()
    return v
  }

  /** Write DR: queue one word, or two 8-bit words from a 16-bit access on v2. */
  private pushTx(value: number, size: 1 | 2 | 4) {
    if (this.i2sMode()) {
      // One 16-bit buffer (§28.5.4); a write over a full buffer replaces it, as in SPI mode on v1.
      this.i2sTx = value & 0xffff
      this.i2sTxFull = true
      this.i2sStart()
      this.checkIrq()
      return
    }
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
    this.onOut(line, level, this.lag)
  }

  /** Idle levels for the current mode; called on configuration changes. */
  private refreshOutputs() {
    if (this.i2sMode()) {
      this.i2sOutputs()
      return
    }
    this.drive("MCK", null)
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
    if (this.i2sMode()) {
      // Master only: SD is the one input (the receiver); CK and WS are this block's outputs.
      if (line === "MOSI") this.mosiIn = level
      return
    }
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


  // --- I²S (RM0090 §28.4) ---------------------------------------------------------------------

  /** I²S exists on the F4's SPI2 and SPI3 (I2S2, I2S3, §28.2.2). */
  private i2sCapable() {
    return this.flavour === "v1" && (this.spec.name === "SPI2" || this.spec.name === "SPI3")
  }
  /** I2SMOD set on a block that has I²S. */
  i2sMode() {
    return this.i2sCapable() && (this.regs[7] & I2SCFGR_I2SMOD) !== 0
  }
  private i2sOn() {
    return (this.regs[7] & I2SCFGR_I2SE) !== 0
  }
  /** I2SCFG: 2 master transmit, 3 master receive (0/1 slave, not modelled). */
  private i2sCfg() {
    return (this.regs[7] >>> 8) & 3
  }
  private i2sMaster() {
    return this.i2sCfg() >= 2
  }
  /** Bits per channel: CHLEN only counts with DATLEN = 16-bit, otherwise 32 (§28.5.8). */
  private i2sChannelBits() {
    const cfg = this.regs[7]
    return ((cfg >>> 1) & 3) === 0 && !(cfg & 1) ? 16 : 32
  }

  /** Bit clock CK in Hz (§28.4.4): I2SxCLK / (2·I2SDIV + ODD), and / 8 (16-bit) or / 4 (32-bit channel) more with MCKOE. 0 with no clock. */
  ckHz(): number {
    if (!this.i2sMode() || !this.i2sMaster()) return 0
    const pr = this.regs[8]
    const div = pr & 0xff
    const clk = this.i2sClock()
    if (div < 2 || clk <= 0) return 0
    const d = 2 * div + (pr & I2SPR_ODD ? 1 : 0)
    return pr & I2SPR_MCKOE ? clk / (d * (this.i2sChannelBits() === 16 ? 8 : 4)) : clk / d
  }
  /** Audio sampling frequency Fs = CK / (2 × channel bits), the RM's formulas (§28.4.4). */
  fsHz(): number {
    return this.ckHz() / (2 * this.i2sChannelBits())
  }
  /**
   * Master clock in Hz: 256 × Fs (§28.4.1) while it is output (I²S master, MCKOE, I2SE), else 0.
   * The MCK pad itself is only held high (see the header): a board model reads this instead.
   */
  mckHz(): number {
    return this.i2sOn() && this.regs[8] & I2SPR_MCKOE ? 256 * this.fsHz() : 0
  }
  /** Core cycles per half CK period. Decision: ODD dividers get two equal halves (the RM's "reshaping stage" is not specified). */
  private i2sHalfCycles() {
    const ck = this.ckHz()
    return ck > 0 ? this.hclkHz / (2 * ck) : Infinity
  }

  /** I2SCFGR written: report what is not modelled, start or stop. */
  private i2sConfig(next: number, old: number) {
    if (!(next & I2SCFGR_I2SMOD)) {
      if (old & I2SCFGR_I2SMOD) this.i2sStop()
      this.refreshOutputs()
      return
    }
    if (!this.i2sCapable()) {
      if (!(old & I2SCFGR_I2SMOD)) this.onUnsupported(`${this.name} I²S`)
      return
    }
    const wasOn = (old & I2SCFGR_I2SMOD) !== 0 && (old & I2SCFGR_I2SE) !== 0
    if (next & I2SCFGR_I2SE && !wasOn) {
      if (!this.i2sMaster()) this.onUnsupported(`${this.name} I²S slave mode`)
      if (((next >>> 1) & 3) === 3) this.onUnsupported(`${this.name} I²S DATLEN = 11 (not allowed)`)
      if ((this.regs[8] & 0xff) < 2) this.onUnsupported(`${this.name} I²S I2SDIV < 2 (forbidden)`)
    }
    // Off: TXE reads 0 (§28.4.7); a halfword already written stays in the buffer for the next start.
    if (!(next & I2SCFGR_I2SE)) this.i2sStop()
    this.refreshOutputs() // the steady levels first, so a frame starting now begins with an edge
    if (next & I2SCFGR_I2SE && !this.i2s) this.i2sStart()
    this.checkIrq()
  }

  /** Start the master if it can: receive at once, transmit on the first halfword (§28.4.5). */
  private i2sStart() {
    if (this.i2s || !this.i2sMode() || !this.i2sOn() || !this.i2sMaster()) return
    const tx = this.i2sCfg() === 2
    if (tx && !this.i2sTxFull) return
    const cfg = this.regs[7]
    const std = (cfg >>> 4) & 3
    const datlen = (cfg >>> 1) & 3
    const ch = this.i2sChannelBits()
    const pcmLong = std === STD_PCM && (cfg & I2SCFGR_PCMSYNC) !== 0
    // Halfwords per channel and the bits each puts on the wire (§28.4.3, Figures 265–278).
    const lsb = std === STD_LSB
    let segs: I2sSegment[]
    if (datlen === 0) segs = [{ at: ch === 32 && lsb ? 16 : 0, mask: 0xffff }]
    else if (datlen === 1) segs = lsb ? [{ at: 0, mask: 0x00ff }, { at: 16, mask: 0xffff }] : [{ at: 0, mask: 0xffff }, { at: 16, mask: 0xff00 }]
    else segs = [{ at: 0, mask: 0xffff }, { at: 16, mask: 0xffff }]
    this.i2s = {
      tx,
      std,
      pcmLong,
      ckpol: (cfg & I2SCFGR_CKPOL) !== 0,
      ch,
      frame: std === STD_PCM ? ch : 2 * ch,
      delay: std === STD_PHILIPS || (std === STD_PCM && !pcmLong) ? 1 : 0,
      segs,
      slot: 0,
      half: 0,
      shift: 0,
      rx: 0,
    }
    this.chside = false
    this.drive("SCK", this.i2s.ckpol)
    this.i2sEnterSlot()
    this.due = this.i2sHalfCycles()
    this.setActive(true)
  }

  /**
   * I2SE cleared. Decision: the frame stops at once and the pads are released; the RM asks
   * software to wait for TXE = 1 / BSY = 0 or the right RXNE first (§28.4.5), so a cut-off
   * frame is the firmware's doing.
   */
  private i2sStop() {
    this.i2s = null
    this.due = Infinity
    this.setActive(false)
  }

  /** Pad levels outside a running frame. */
  private i2sOutputs() {
    const on = this.i2sOn() && this.i2sMaster()
    this.drive("MISO", null) // I2Sx_ext_SD: full duplex not modelled
    // MCK: held high in place of the 256·Fs clock (the documented deviation).
    this.drive("MCK", on && this.regs[8] & I2SPR_MCKOE ? true : null)
    if (!on) {
      for (const line of ["SCK", "MOSI", "NSS"] as const) this.drive(line, null)
      return
    }
    const cfg = this.regs[7]
    if (this.i2s) return
    this.drive("SCK", (cfg & I2SCFGR_CKPOL) !== 0)
    // Decision (undocumented): before the first frame WS rests at the level that ends a frame, so
    // the first channel starts with an edge — high for Philips, low for the others (the levels
    // §28.4.8 has a slave resynchronise on).
    this.drive("NSS", ((cfg >>> 4) & 3) === STD_PHILIPS)
    this.drive("MOSI", this.i2sCfg() === 2 ? (this.out.MOSI ?? false) : null)
  }

  /** WS in a pin slot (§28.4.3): Philips low = left; MSB/LSB justified high = left; PCM a 1-CK or 13-CK pulse. */
  private wsLevel(r: I2sRun, slot: number) {
    const p = slot % r.frame
    if (r.std === STD_PHILIPS) return p >= r.ch
    if (r.std === STD_PCM) return r.pcmLong ? p < 13 : p === 0
    return p < r.ch
  }

  /** Where a pin slot falls in the data: channel, bit within the channel, or null in the lead-in slot. */
  private dataPos(r: I2sRun, slot: number) {
    const d = slot - r.delay
    if (d < 0) return null
    const p = d % r.frame
    return { channel: r.std === STD_PCM ? 0 : Math.floor(p / r.ch), bit: p % r.ch }
  }

  /** A new slot begins (on the shifting CK edge): WS, and for a transmitter the next SD bit. */
  private i2sEnterSlot() {
    const r = this.i2s!
    this.drive("NSS", this.wsLevel(r, r.slot))
    if (!r.tx) return
    const pos = this.dataPos(r, r.slot)
    let bit = false
    if (pos) {
      const k = r.segs.findIndex((g) => pos.bit >= g.at && pos.bit < g.at + 16)
      if (k >= 0) {
        const g = r.segs[k]
        if (pos.bit === g.at) {
          // The halfword moves from the buffer to the shift register as its first bit goes out;
          // TXE is set and CHSIDE names the channel the next write is for (§28.4.5).
          // Decision (undocumented): an empty buffer in master mode reloads its stale content (no UDR, §28.4.8).
          r.shift = this.i2sTx & g.mask
          this.i2sTxFull = false
          const nextChannel = k + 1 < r.segs.length ? pos.channel : r.std === STD_PCM ? 0 : pos.channel ^ 1
          this.chside = nextChannel === 1
          this.checkIrq()
        }
        bit = ((r.shift >>> (15 - (pos.bit - g.at))) & 1) === 1
      }
    }
    this.drive("MOSI", bit)
  }

  /** The sampling CK edge: a receiver shifts in SD; a full halfword goes to the buffer (§28.4.5). */
  private i2sSample() {
    const r = this.i2s!
    if (r.tx) return
    const pos = this.dataPos(r, r.slot)
    if (!pos) return
    const g = r.segs.find((x) => pos.bit >= x.at && pos.bit < x.at + 16)
    if (!g) return
    r.rx = ((r.rx << 1) | (this.mosiIn ? 1 : 0)) & 0xffff
    if (pos.bit !== g.at + 15) return
    if (this.i2sRxFull) this.ovr = true // the new halfword is lost (§28.4.8)
    else {
      this.i2sRx = r.rx & g.mask
      this.i2sRxFull = true
      this.chside = r.std !== STD_PCM && pos.channel === 1 // CHSIDE: meaningless in PCM (§28.5.3)
    }
    this.checkIrq()
  }

  /** One CK edge: the leading one (away from the steady state) samples, the trailing one shifts (Figure 264, CKPOL inverts both). */
  private i2sEdge() {
    const r = this.i2s!
    if (r.half === 0) {
      r.half = 1
      this.drive("SCK", !r.ckpol)
      this.i2sSample()
    } else {
      r.half = 0
      this.drive("SCK", r.ckpol)
      r.slot++
      // Keep the counter bounded: only the slot within the frame and the lead-in matter.
      if (r.slot >= 2 * r.frame) r.slot -= r.frame
      this.i2sEnterSlot()
    }
  }

  // --- clocking -------------------------------------------------------------------------------

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  tick(cycles: number) {
    if (this.i2s) {
      this.due -= cycles
      while (this.i2s && this.due <= 0) {
        this.lag = -this.due / this.hclkHz
        this.i2sEdge()
        this.due += this.i2sHalfCycles()
      }
      this.lag = 0
      return
    }
    if (!this.frame || !this.master()) return
    this.due -= cycles
    while (this.frame && this.due <= 0) {
      this.masterEdge()
      if (this.frame) this.due += this.halfCycles()
    }
  }

  cyclesUntilEvent(): number {
    if (this.i2s) return Math.max(1, Math.ceil(this.due))
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

/** Pads per line (DS9405 Table 12); "PD6@5" marks a pad on a different AF. */
const F42X_PADS: Record<string, string> = {
  SPI1: "NSS PA4 PA15 PG10; SCK PA5 PB3 PG11; MISO PA6 PB4 PG9; MOSI PA7 PB5 PD7 @5",
  SPI2: "NSS PB9 PB12 PI0 PB4@7; SCK PB10 PB13 PD3 PI1 PA9; MISO PB14 PC2 PI2; MOSI PB15 PC3 PI3 PC1 @5",
  SPI3: "NSS PA4 PA15; SCK PB3 PC10; MISO PB4 PC11; MOSI PB5 PC12 PD6@5 @6",
  SPI4: "NSS PE4 PE11; SCK PE2 PE12; MISO PE5 PE13; MOSI PE6 PE14 @5",
  SPI5: "NSS PF6 PH5; SCK PF7 PH6; MISO PF8 PH7; MOSI PF9 PF11 @5",
  SPI6: "NSS PG8; SCK PG13; MISO PG12; MOSI PG14 @5",
}

const DS10916_REV5_PADS: Record<string, string> = {
  SPI1: "NSS PA4 PA15; SCK PA5 PB3; MISO PA6 PB4; MOSI PA7 PB5 @5",
  SPI2: "NSS PB9 PB12 PI0 PB4@7; SCK PB10 PB13 PD3 PI1 PA9; MISO PB14 PC2 PI2; MOSI PB15 PC3 PI3 PC1 @5",
  SPI3: "NSS PA4 PA15; SCK PB3 PC10; MISO PB4 PC11; MOSI PB5 PC12 PD6@5 PB2@7 @6",
  SPI4: "NSS PE4 PE11; SCK PE2 PE12; MISO PE5 PE13; MOSI PE6 PE14 @5",
  SPI5: "NSS PF6 PH5; SCK PF7 PH6; MISO PF8 PH7; MOSI PF9 PF11 @5",
  SPI6: "NSS PG8; SCK PG13; MISO PG12; MOSI PG14 @5",
}

/** F405/F407 (DS8626 Rev 12 Table 9): SPI1–3 only, no SPI1 on port G, no SPI2 on PC1/PD3/PA9/PB4, no SPI3 on PD6. */
const DS8626_REV12_PADS: Record<string, string> = {
  SPI1: "NSS PA4 PA15; SCK PA5 PB3; MISO PA6 PB4; MOSI PA7 PB5 @5",
  SPI2: "NSS PB9 PB12 PI0; SCK PB10 PB13 PI1; MISO PB14 PC2 PI2; MOSI PB15 PC3 PI3 @5",
  SPI3: "NSS PA4 PA15; SCK PB3 PC10; MISO PB4 PC11; MOSI PB5 PC12 @6",
}

const PADS: Record<AfMap, Record<string, string>> = { f40x: DS8626_REV12_PADS, f42x: F42X_PADS, f74x: DS10916_REV5_PADS }

export function spiPads(name: string, map: AfMap): SpiPad[] {
  const spec = PADS[map][name]
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

export type I2sLine = "CK" | "WS" | "SD" | "MCK"
export type I2sPad = { port: number; pin: number; af: number; line: I2sLine }

/**
 * MCK pads: I2S2_MCK PC6 AF5, I2S3_MCK PC7 AF6 (DS8626 Rev 12 Table 9; the same pads and AFs in
 * DS9405 for the F42x). None on the F7 map: I²S is not modelled on the v2 blocks.
 */
const I2S_MCK: Record<AfMap, Record<string, SpiPad[]>> = {
  f40x: { SPI2: [{ port: 2, pin: 6, af: 5, line: "MCK" }], SPI3: [{ port: 2, pin: 7, af: 6, line: "MCK" }] },
  f42x: { SPI2: [{ port: 2, pin: 6, af: 5, line: "MCK" }], SPI3: [{ port: 2, pin: 7, af: 6, line: "MCK" }] },
  f74x: {},
}

/** Pads the SoC wires to an SPI beyond `spiPads`: the I²S master clock. */
export function i2sMckPads(name: string, map: AfMap): SpiPad[] {
  return I2S_MCK[map][name] ?? []
}

/**
 * The I²S signals of an SPI block: CK, WS and SD are its SCK, NSS and MOSI pads (RM0090 §28.4.1;
 * DS8626 Table 9 lists them as "SPI2_SCK/I2S2_CK" and so on), plus MCK. Empty where the block has
 * no I²S (SPI1/4/5/6, the F7 map).
 */
export function i2sPads(name: string, map: AfMap): I2sPad[] {
  if (map === "f74x" || (name !== "SPI2" && name !== "SPI3")) return []
  const as: Partial<Record<SpiLine, I2sLine>> = { SCK: "CK", NSS: "WS", MOSI: "SD", MCK: "MCK" }
  return [...spiPads(name, map), ...i2sMckPads(name, map)].filter((p) => as[p.line]).map((p) => ({ port: p.port, pin: p.pin, af: p.af, line: as[p.line]! }))
}
