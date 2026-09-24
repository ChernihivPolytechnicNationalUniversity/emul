/**
 * USART/UART in asynchronous mode (RM0090 §30, RM0385 §31). One shifter, two register maps:
 * the F4 ("v1": SR/DR at the top) and the F7 ("v2": ISR/ICR/RDR/TDR). The chip profile picks.
 *
 * Modelled: baud from BRR with 16× and 8× oversampling, 8/9-bit words, even/odd parity, 1/2
 * stop bits, the transmit holding and shift registers with TXE/TC, receive with start-bit
 * detection and mid-bit sampling, RXNE, overrun, framing and parity errors, IDLE, and the
 * interrupts for all of them. TX drives its pin; RX samples its pin.
 *
 * Not modelled: synchronous clock output, hardware flow control (CTS/RTS), LIN, IrDA,
 * smartcard, half-duplex single wire, receiver wake-up, the F7 FIFO-less extras (RTOR,
 * auto-baud, swap, inversion). DMA requests (DMAT/DMAR) are level lines the DMA polls.
 *
 * Lazy like the timers: the SoC catches the shifter up on register access, on RX pin edges
 * and at its next bit boundary; see `Clocked`.
 */
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

export type UsartFlavour = "v1" | "v2"

export type UsartSpec = {
  name: string
  base: number
  apb: 1 | 2
  irq: number
}

const V1_REGS: RegDef[] = [
  { name: "SR", offset: 0x00, reset: 0x00c0, rw: 0 },
  { name: "DR", offset: 0x04, rw: 0x1ff },
  { name: "BRR", offset: 0x08, rw: 0xffff },
  { name: "CR1", offset: 0x0c, rw: 0xbfff },
  { name: "CR2", offset: 0x10, rw: 0x7fff },
  { name: "CR3", offset: 0x14, rw: 0x0fff },
  { name: "GTPR", offset: 0x18, rw: 0xffff },
]
const V2_REGS: RegDef[] = [
  { name: "CR1", offset: 0x00 },
  { name: "CR2", offset: 0x04 },
  { name: "CR3", offset: 0x08 },
  { name: "BRR", offset: 0x0c, rw: 0xffff },
  { name: "GTPR", offset: 0x10, rw: 0xffff },
  { name: "RTOR", offset: 0x14 },
  { name: "RQR", offset: 0x18, rw: 0 },
  { name: "ISR", offset: 0x1c, reset: 0x00c0, rw: 0 },
  { name: "ICR", offset: 0x20, rw: 0 },
  { name: "RDR", offset: 0x24, rw: 0 },
  { name: "TDR", offset: 0x28, rw: 0x1ff },
]

// Status bits, same positions in SR (v1) and ISR (v2).
const PE = 1 << 0
const FE = 1 << 1
const ORE = 1 << 3
const IDLE = 1 << 4
const RXNE = 1 << 5
const TC = 1 << 6
const TXE = 1 << 7
// CR1 bits shared by both maps (UE differs: bit 13 on v1, bit 0 on v2).
const CR1_RE = 1 << 2
const CR1_TE = 1 << 3
const CR1_IDLEIE = 1 << 4
const CR1_RXNEIE = 1 << 5
const CR1_TCIE = 1 << 6
const CR1_TXEIE = 1 << 7
const CR1_PEIE = 1 << 8
const CR1_PS = 1 << 9
const CR1_PCE = 1 << 10
const CR1_M = 1 << 12
const CR1_OVER8 = 1 << 15
const CR3_EIE = 1 << 0
const CR3_DMAR = 1 << 6
const CR3_DMAT = 1 << 7

export class Usart extends RegBlock implements Clocked {
  readonly spec: UsartSpec
  readonly flavour: UsartFlavour

  // Status lives outside the register file: v1 reads it through SR, v2 through ISR.
  private status = TXE | TC
  private rdr = 0
  /** Transmit holding register, or -1 when empty (TXE). */
  private tdr = -1
  /** Frame in the transmit shifter as bit levels (start, data, parity, stop), and the next bit to send. */
  private txFrame: boolean[] = []
  private txBit = 0
  /** Core cycles until the next transmit bit boundary. */
  private txDue = Infinity
  /** Receiver: -1 idle, else the index of the next bit to sample; `rxDue` cycles to its sample point. */
  private rxBit = -1
  private rxDue = Infinity
  private rxBits: boolean[] = []
  private rxLevel = true
  private rxIdleArmed = false

  private pclkHz = 16e6
  private hclkHz = 16e6

  /** TX pin level (null: not driven — TE or UE off). */
  onTx: (level: boolean | null) => void = () => {}
  raiseIrq: (irq: number) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  /** The SoC adds/removes the block from the clocked set when it has bits in flight. */
  onActive: (on: boolean) => void = () => {}
  /** A DMA request line (TX: TXE with DMAT, RX: RXNE with DMAR) turned on. */
  onDmaRequest: (line: "tx" | "rx") => void = () => {}
  private active = false
  private txLevel: boolean | null = null

  constructor(spec: UsartSpec, flavour: UsartFlavour) {
    super(spec.name, spec.base, 0x400, flavour === "v1" ? V1_REGS : V2_REGS)
    this.spec = spec
    this.flavour = flavour
  }

  setClock(pclkHz: number, hclkHz: number) {
    this.pclkHz = pclkHz
    this.hclkHz = hclkHz
  }

  reset() {
    super.reset()
    if (!this.txFrame) return
    this.status = TXE | TC
    this.rdr = 0
    this.tdr = -1
    this.txFrame = []
    this.txBit = 0
    this.txDue = Infinity
    this.rxBit = -1
    this.rxDue = Infinity
    this.rxLevel = true
    this.rxIdleArmed = false
    this.setActive(false)
    this.driveTx(null)
  }

  // --- configuration ------------------------------------------------------------------------

  private cr1() {
    return this.regs[(this.flavour === "v1" ? 0x0c : 0x00) >>> 2]
  }
  private cr2() {
    return this.regs[(this.flavour === "v1" ? 0x10 : 0x04) >>> 2]
  }
  private cr3() {
    return this.regs[(this.flavour === "v1" ? 0x14 : 0x08) >>> 2]
  }
  private enabled() {
    return (this.cr1() & (this.flavour === "v1" ? 1 << 13 : 1)) !== 0
  }
  /** Data bits per word: 7 (F7 M1), 8 or 9, before parity. */
  private wordBits() {
    const cr1 = this.cr1()
    if (this.flavour === "v2" && cr1 & (1 << 28)) return 7
    return cr1 & CR1_M ? 9 : 8
  }
  private parity(): "none" | "even" | "odd" {
    const cr1 = this.cr1()
    return cr1 & CR1_PCE ? (cr1 & CR1_PS ? "odd" : "even") : "none"
  }
  private stopBits() {
    const stop = (this.cr2() >>> 12) & 3
    return stop === 2 ? 2 : stop === 1 ? 0.5 : stop === 3 ? 1.5 : 1
  }
  /** Core cycles per bit from BRR; Infinity when the baud rate is not set. */
  private bitCycles() {
    const brr = this.regs[(this.flavour === "v1" ? 0x08 : 0x0c) >>> 2] & 0xffff
    const over8 = (this.cr1() & CR1_OVER8) !== 0
    let div: number
    if (this.flavour === "v1") div = over8 ? (brr & ~7) + ((brr & 7) << 1) : brr
    else div = over8 ? (brr & ~7) + ((brr & 7) << 1) : brr
    // baud = fck / div (16× oversampling) or 2·fck / div (8×): both give bit time = div / fck (or half).
    if (div < 16) return Infinity
    const bitSeconds = (over8 ? div / 2 : div) / this.pclkHz
    return bitSeconds * this.hclkHz
  }

  // --- register file ------------------------------------------------------------------------

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return super.read(offset, size)
  }
  peek(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    return super.peek(offset, size)
  }
  /** The received byte as it waits: reading DR for real clears RXNE. */
  protected peekValue(d: RegDef, current: number): number {
    return d.name === "DR" || d.name === "RDR" ? this.rdr : this.onRead(d, current)
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    super.write(offset, value, size)
    this.reschedule()
  }

  protected onRead(d: RegDef, current: number): number {
    switch (d.name) {
      case "SR":
        return this.status
      case "ISR":
        return this.status | (this.enabled() && this.cr1() & CR1_TE ? 1 << 21 : 0) | (this.enabled() && this.cr1() & CR1_RE ? 1 << 22 : 0) | (this.rxBit >= 0 ? 1 << 16 : 0)
      case "DR": // v1: reading DR clears RXNE (and the error flags together with a prior SR read)
      case "RDR": {
        const v = this.rdr
        this.status &= ~(RXNE | (d.name === "DR" ? PE | FE | ORE | IDLE : 0))
        return v
      }
      default:
        return current
    }
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "DR":
      case "TDR":
        this.loadTx(written & 0x1ff)
        return 0
      case "ICR":
        this.status &= ~(written & (PE | FE | ORE | IDLE | TC))
        return 0
      case "RQR":
        if (written & (1 << 3)) this.status &= ~RXNE // RXFRQ
        return 0
      case "SR":
        // v1: write-zero-to-clear on RXNE and TC (the rest through the DR sequence).
        this.status &= ~(~written & (RXNE | TC))
        return 0
      case "CR1":
      case "CR2":
      case "CR3":
      case "BRR":
        this.regs[d.offset >>> 2] = next >>> 0
        this.refresh(d.name === "CR1" ? next & ~old : 0)
        if (d.name === "CR3") {
          if (next & ~old & CR3_DMAT && this.status & TXE) this.onDmaRequest("tx")
          if (next & ~old & CR3_DMAR && this.status & RXNE) this.onDmaRequest("rx")
        }
        return
    }
  }

  /** Configuration changed: TX idle level, interrupt lines. */
  private refresh(newlyEnabled: number) {
    const cr1 = this.cr1()
    const txOn = this.enabled() && (cr1 & CR1_TE) !== 0
    if (!txOn) {
      this.driveTx(null)
    } else if (this.txFrame.length === 0) this.driveTx(true)
    if (!this.enabled() || !(cr1 & CR1_RE)) {
      this.rxBit = -1
      this.rxDue = Infinity
    }
    this.updateActive()
    // Enabling an interrupt whose flag is already up raises it (level-sensitive line).
    if (newlyEnabled) this.checkIrq()
  }

  private checkIrq() {
    const cr1 = this.cr1()
    const st = this.status
    if ((cr1 & CR1_TXEIE && st & TXE) || (cr1 & CR1_TCIE && st & TC) || (cr1 & CR1_RXNEIE && st & (RXNE | ORE)) || (cr1 & CR1_IDLEIE && st & IDLE) || (cr1 & CR1_PEIE && st & PE) || (this.cr3() & CR3_EIE && st & (FE | ORE)))
      this.raiseIrq(this.spec.irq)
  }
  private setFlag(bit: number) {
    if (this.status & bit) return
    this.status |= bit
    this.checkIrq()
    if (bit === TXE && this.cr3() & CR3_DMAT) this.onDmaRequest("tx")
    if (bit === RXNE && this.cr3() & CR3_DMAR) this.onDmaRequest("rx")
  }

  /** Level of a DMA request line, for the DMA controller. */
  dmaLevel(line: "tx" | "rx"): boolean {
    const cr3 = this.cr3()
    return line === "tx" ? (cr3 & CR3_DMAT) !== 0 && (this.status & TXE) !== 0 : (cr3 & CR3_DMAR) !== 0 && (this.status & RXNE) !== 0
  }

  // --- transmit -----------------------------------------------------------------------------

  private loadTx(data: number) {
    if (!this.enabled() || !(this.cr1() & CR1_TE)) return
    this.status &= ~TC
    if (this.txFrame.length === 0) {
      this.startFrame(data)
    } else {
      this.tdr = data
      this.status &= ~TXE
    }
    this.updateActive()
  }

  private startFrame(data: number) {
    const bits = this.wordBits()
    const parity = this.parity()
    const dataBits = parity === "none" ? bits : bits - 1
    const frame: boolean[] = [false]
    let ones = 0
    for (let i = 0; i < dataBits; i++) {
      const b = ((data >>> i) & 1) === 1
      if (b) ones++
      frame.push(b)
    }
    if (parity !== "none") frame.push(parity === "even" ? ones % 2 === 1 : ones % 2 === 0)
    const stop = this.stopBits()
    for (let i = 0; i < Math.ceil(stop); i++) frame.push(true)
    this.txFrame = frame
    this.txBit = 0
    this.txDue = this.bitCycles()
    this.driveTx(frame[0])
    // The holding register is free again as soon as the shifter has taken the word. TXE is a
    // level line: the interrupt and the DMA request are re-raised even if it never dropped.
    this.tdr = -1
    this.status |= TXE
    this.checkIrq()
    if (this.cr3() & CR3_DMAT) this.onDmaRequest("tx")
  }

  private driveTx(level: boolean | null) {
    if (this.txLevel === level) return
    this.txLevel = level
    this.onTx(level)
  }

  // --- receive ------------------------------------------------------------------------------

  /** The RX pad changed level (the SoC calls this after syncing the block). */
  rxEdge(level: boolean) {
    if (level === this.rxLevel) return
    this.rxLevel = level
    if (!this.enabled() || !(this.cr1() & CR1_RE)) return
    if (this.rxBit < 0 && !level) {
      // Start bit: sample the data bits at their centres, 1.5 bit times from this edge on.
      this.rxBit = 0
      this.rxBits = []
      this.rxDue = this.bitCycles() * 1.5
      this.rxIdleArmed = true
      this.updateActive()
    }
  }

  private rxFrameBits() {
    const bits = this.wordBits()
    return bits + (this.stopBits() >= 1 ? 1 : 0) // parity is inside the word; one stop bit is checked
  }

  private sampleRx() {
    this.rxBits.push(this.rxLevel)
    this.rxBit++
    if (this.rxBit < this.rxFrameBits()) {
      this.rxDue = this.bitCycles()
      return
    }
    // Frame complete: unpack.
    const bits = this.wordBits()
    const parity = this.parity()
    const dataBits = parity === "none" ? bits : bits - 1
    let data = 0
    let ones = 0
    for (let i = 0; i < dataBits; i++) {
      if (this.rxBits[i]) {
        data |= 1 << i
        ones++
      }
    }
    let flags = 0
    if (parity !== "none") {
      const p = this.rxBits[dataBits]
      if (p) ones++
      if ((parity === "even" && ones % 2 !== 0) || (parity === "odd" && ones % 2 !== 1)) flags |= PE
    }
    if (this.stopBits() >= 1 && !this.rxBits[bits]) flags |= FE
    if (this.status & RXNE) flags |= ORE
    else this.rdr = data
    this.rxBit = -1
    this.rxDue = Infinity
    // IDLE is flagged when the line stays high for a frame after the last stop bit.
    this.rxDue = this.rxIdleArmed ? this.bitCycles() * (bits + 1) : Infinity
    this.rxBit = -2
    this.status |= flags
    this.setFlag(RXNE)
    if (flags) this.checkIrq()
    this.updateActive()
  }

  // --- clocking -----------------------------------------------------------------------------

  private updateActive() {
    const on = this.txFrame.length > 0 || this.rxBit !== -1
    this.setActive(on)
  }
  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  tick(cycles: number) {
    if (this.txFrame.length) {
      this.txDue -= cycles
      while (this.txFrame.length && this.txDue <= 0) {
        this.txBit++
        if (this.txBit < this.txFrame.length) {
          this.driveTx(this.txFrame[this.txBit])
          this.txDue += this.bitCycles()
        } else {
          // Last stop bit done: next word or transmission complete.
          const carry = this.txDue
          this.txFrame = []
          if (this.tdr >= 0) {
            this.startFrame(this.tdr)
            this.txDue += carry
          } else {
            this.txDue = Infinity
            this.driveTx(true)
            this.setFlag(TC)
          }
        }
      }
    }
    if (this.rxBit !== -1) {
      this.rxDue -= cycles
      while (this.rxBit !== -1 && this.rxDue <= 0) {
        if (this.rxBit === -2) {
          // Idle line after a frame.
          this.rxBit = -1
          this.rxDue = Infinity
          if (this.rxLevel) this.setFlag(IDLE)
        } else {
          const carry = this.rxDue
          this.sampleRx()
          if (this.rxBit !== -1 && this.rxDue !== Infinity) this.rxDue += carry
        }
      }
    }
    this.updateActive()
  }

  cyclesUntilEvent(): number {
    const d = Math.min(this.txFrame.length ? this.txDue : Infinity, this.rxBit !== -1 ? this.rxDue : Infinity)
    return d === Infinity ? Infinity : Math.max(1, Math.ceil(d))
  }
}

// --- the STM32F4/F7 USART set ------------------------------------------------------------

export const USART_SPECS: UsartSpec[] = [
  { name: "USART1", base: 0x40011000, apb: 2, irq: 37 },
  { name: "USART2", base: 0x40004400, apb: 1, irq: 38 },
  { name: "USART3", base: 0x40004800, apb: 1, irq: 39 },
  { name: "UART4", base: 0x40004c00, apb: 1, irq: 52 },
  { name: "UART5", base: 0x40005000, apb: 1, irq: 53 },
  { name: "USART6", base: 0x40011400, apb: 2, irq: 71 },
  { name: "UART7", base: 0x40007800, apb: 1, irq: 82 },
  { name: "UART8", base: 0x40007c00, apb: 1, irq: 83 },
]

export type UsartPad = { port: number; pin: number; af: number; dir: "tx" | "rx" }

/** TX/RX pads (DS9405 Table 12 / DS10916 Table 13; the Nucleo-144 header map agrees). */
const PADS: Record<string, string> = {
  USART1: "TX PA9 PB6; RX PA10 PB7 @7",
  USART2: "TX PA2 PD5; RX PA3 PD6 @7",
  USART3: "TX PB10 PC10 PD8; RX PB11 PC11 PD9 @7",
  UART4: "TX PA0 PC10; RX PA1 PC11 @8",
  UART5: "TX PC12; RX PD2 @8",
  USART6: "TX PC6 PG14; RX PC7 PG9 @8",
  UART7: "TX PE8 PF7; RX PE7 PF6 @8",
  UART8: "TX PE1; RX PE0 @8",
}

export function usartPads(name: string): UsartPad[] {
  const spec = PADS[name]
  if (!spec) return []
  const [body, afText] = spec.split("@")
  const af = Number(afText)
  const out: UsartPad[] = []
  for (const group of body.split(";")) {
    const [tag, ...pads] = group.trim().split(/\s+/)
    for (const p of pads) {
      const pm = /^P([A-K])(\d+)$/.exec(p)!
      out.push({ port: "ABCDEFGHIJK".indexOf(pm[1]), pin: Number(pm[2]), af, dir: tag === "TX" ? "tx" : "rx" })
    }
  }
  return out
}
