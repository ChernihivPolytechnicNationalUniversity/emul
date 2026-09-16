/**
 * I²C (RM0090 §27, RM0385 §30) in master mode. One bit engine under two register maps: the
 * F4 ("v1": CR1 START/STOP/ACK/POS, SR1/SR2 with the read-to-clear sequences, CCR timing)
 * and the F7 ("v2": CR2 with SADD/NBYTES/AUTOEND/RELOAD, ISR/ICR, TXDR/RXDR, TIMINGR).
 *
 * Modelled: START/repeated START/STOP, 7-bit addressing, byte transmit and receive with
 * ACK/NACK, SCL from the timing registers with the master waiting for SCL to actually rise
 * (so a stretching slave — or a missing pull-up — holds it, as it does on the bench), the
 * v1 clock stretching on BTF/ADDR and the v2 stretching on TC/TCR, the flags and interrupts
 * a polling or interrupt-driven driver looks at.
 *
 * Not modelled (reported through `onUnsupported`): slave mode of the MCU itself, 10-bit
 * addresses, SMBus/PEC, DMA, general call, the v1 dual address.
 *
 * SCL/SDA are open-drain: the block drives low or releases; the resolved bus level comes
 * back in through `pinEdge`, which also lets it see a slave holding SDA low for ACK.
 */
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

export type I2cFlavour = "v1" | "v2"

export type I2cSpec = {
  name: string
  base: number
  irqEvent: number
  irqError: number
}

export type I2cLine = "SCL" | "SDA"

const V1_REGS: RegDef[] = [
  { name: "CR1", offset: 0x00, rw: 0xffff },
  { name: "CR2", offset: 0x04, rw: 0x1fff },
  { name: "OAR1", offset: 0x08, rw: 0xfcff },
  { name: "OAR2", offset: 0x0c, rw: 0xff },
  { name: "DR", offset: 0x10, rw: 0xff },
  { name: "SR1", offset: 0x14, rw: 0 },
  { name: "SR2", offset: 0x18, rw: 0 },
  { name: "CCR", offset: 0x1c, rw: 0xcfff },
  { name: "TRISE", offset: 0x20, reset: 2, rw: 0x3f },
  { name: "FLTR", offset: 0x24, rw: 0x1f },
]
const V2_REGS: RegDef[] = [
  { name: "CR1", offset: 0x00 },
  { name: "CR2", offset: 0x04, rw: 0x07ffffff },
  { name: "OAR1", offset: 0x08, rw: 0x8fff },
  { name: "OAR2", offset: 0x0c, rw: 0x8ffe },
  { name: "TIMINGR", offset: 0x10 },
  { name: "TIMEOUTR", offset: 0x14 },
  { name: "ISR", offset: 0x18, reset: 1, rw: 0 },
  { name: "ICR", offset: 0x1c, rw: 0 },
  { name: "PECR", offset: 0x20, rw: 0 },
  { name: "RXDR", offset: 0x24, rw: 0 },
  { name: "TXDR", offset: 0x28, rw: 0xff },
]

// v1 bits
const V1_CR1_PE = 1 << 0
const V1_CR1_SMBUS = 1 << 1
const V1_CR1_ENGC = 1 << 6
const V1_CR1_START = 1 << 8
const V1_CR1_STOP = 1 << 9
const V1_CR1_ACK = 1 << 10
const V1_CR1_POS = 1 << 11
const V1_CR1_SWRST = 1 << 15
const V1_CR2_ITERREN = 1 << 8
const V1_CR2_ITEVTEN = 1 << 9
const V1_CR2_ITBUFEN = 1 << 10
const V1_CR2_DMAEN = 1 << 11
const SR1_SB = 1 << 0
const SR1_ADDR = 1 << 1
const SR1_BTF = 1 << 2
const SR1_STOPF = 1 << 4
const SR1_RXNE = 1 << 6
const SR1_TXE = 1 << 7
const SR1_BERR = 1 << 8
const SR1_ARLO = 1 << 9
const SR1_AF = 1 << 10
const SR1_OVR = 1 << 11
const SR2_MSL = 1 << 0
const SR2_BUSY = 1 << 1
const SR2_TRA = 1 << 2
// v2 bits
const V2_CR1_PE = 1 << 0
const V2_CR1_TXIE = 1 << 1
const V2_CR1_RXIE = 1 << 2
const V2_CR1_NACKIE = 1 << 4
const V2_CR1_STOPIE = 1 << 5
const V2_CR1_TCIE = 1 << 6
const V2_CR1_ERRIE = 1 << 7
const V2_CR1_DMA = (1 << 14) | (1 << 15)
const V2_CR1_SMBUS = (1 << 20) | (1 << 21) | (1 << 22) | (1 << 23)
const V2_CR2_RD_WRN = 1 << 10
const V2_CR2_ADD10 = 1 << 11
const V2_CR2_START = 1 << 13
const V2_CR2_STOP = 1 << 14
const V2_CR2_NACK = 1 << 15
const V2_CR2_RELOAD = 1 << 24
const V2_CR2_AUTOEND = 1 << 25
const V2_CR2_PECBYTE = 1 << 26
const ISR_TXE = 1 << 0
const ISR_TXIS = 1 << 1
const ISR_RXNE = 1 << 2
const ISR_NACKF = 1 << 4
const ISR_STOPF = 1 << 5
const ISR_TC = 1 << 6
const ISR_TCR = 1 << 7
const ISR_BERR = 1 << 8
const ISR_ARLO = 1 << 9
const ISR_OVR = 1 << 10
const ISR_BUSY = 1 << 15

/** What the bit engine is doing. */
type Op =
  | { kind: "start"; repeated: boolean }
  | { kind: "byte"; dir: "tx" | "rx"; data: number; bit: number; ack: boolean }
  | { kind: "stop" }

export class I2c extends RegBlock implements Clocked {
  readonly spec: I2cSpec
  readonly flavour: I2cFlavour

  // --- bit engine ---
  private op: Op | null = null
  /** The next micro-step and core cycles until it; `awaitScl` runs instead when SCL rises. */
  private next: (() => void) | null = null
  private due = Infinity
  private awaitScl: (() => void) | null = null
  private sclOut = true
  private sdaOut = true
  private sclIn = true
  private sdaIn = true
  /** Bus owned (between START and STOP). */
  private busy = false
  private transmitter = false
  private pclkHz = 16e6
  private hclkHz = 16e6

  // --- v1 state ---
  private sr1 = 0
  private dr = -1
  private drData = 0
  /** Byte received and waiting while DR is still full (SCL stretched). */
  private held = -1
  private addrArmed = false
  private stopfArmed = false
  /** ACK to send for the next received byte when POS is set. */
  private ackNext = true
  private pendingStart = false
  private pendingStop = false

  // --- v2 state ---
  private isr = ISR_TXE
  private txdr = -1
  private rxdr = 0
  private nbytesLeft = 0
  private rxnePending = -1

  onOut: (line: I2cLine, level: boolean) => void = () => {}
  raiseIrq: (irq: number) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  onActive: (on: boolean) => void = () => {}
  onUnsupported: (what: string) => void = () => {}
  private active = false

  constructor(spec: I2cSpec, flavour: I2cFlavour) {
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
    if (this.sclOut === undefined) return // called from the base constructor, before our fields exist
    this.op = null
    this.next = null
    this.awaitScl = null
    this.due = Infinity
    this.busy = false
    this.transmitter = false
    this.sr1 = 0
    this.dr = -1
    this.held = -1
    this.addrArmed = this.stopfArmed = false
    this.ackNext = true
    this.pendingStart = this.pendingStop = false
    this.isr = ISR_TXE
    this.txdr = -1
    this.rxdr = 0
    this.nbytesLeft = 0
    this.rxnePending = -1
    this.drive("SCL", true)
    this.drive("SDA", true)
    this.setActive(false)
  }

  // --- configuration ------------------------------------------------------------------------

  private enabled() {
    return (this.regs[0] & 1) !== 0
  }
  /** SCL low and high periods in core cycles. */
  private timing(): { low: number; high: number } {
    const scale = this.hclkHz / this.pclkHz
    if (this.flavour === "v1") {
      const ccr = this.regs[0x1c >>> 2]
      const div = Math.max(1, ccr & 0xfff)
      if (ccr & 0x8000) {
        // Fast mode: 2:1 or 16:9 low:high.
        return ccr & 0x4000 ? { low: 9 * div * scale, high: 16 * div * scale } : { low: 2 * div * scale, high: div * scale }
      }
      return { low: div * scale, high: div * scale }
    }
    const t = this.regs[0x10 >>> 2]
    const presc = ((t >>> 28) & 0xf) + 1
    const scll = (t & 0xff) + 1
    const sclh = ((t >>> 8) & 0xff) + 1
    return { low: presc * scll * scale, high: presc * sclh * scale }
  }

  // --- register file ------------------------------------------------------------------------

  read(offset: number, size: 1 | 2 | 4): number {
    this.sync()
    const v = super.read(offset, size)
    this.reschedule()
    return v
  }
  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    super.write(offset, value, size)
    this.reschedule()
  }

  protected onRead(d: RegDef, current: number): number {
    switch (d.name) {
      case "SR1":
        if (this.sr1 & SR1_ADDR) this.addrArmed = true
        if (this.sr1 & SR1_STOPF) this.stopfArmed = true
        return this.sr1
      case "SR2": {
        if (this.addrArmed && this.sr1 & SR1_ADDR) {
          this.sr1 &= ~SR1_ADDR
          this.addrArmed = false
          this.afterAddrCleared()
        }
        return (this.busy ? SR2_BUSY | SR2_MSL : 0) | (this.transmitter && this.busy ? SR2_TRA : 0)
      }
      case "DR": {
        const v = this.drData
        if (this.sr1 & SR1_RXNE) this.v1DrRead()
        return v
      }
      case "ISR":
        return this.isr | (this.busy ? ISR_BUSY : 0)
      case "RXDR": {
        const v = this.rxdr
        if (this.isr & ISR_RXNE) this.v2RxdrRead()
        return v
      }
      default:
        return current
    }
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    if (this.flavour === "v1") return this.v1Write(d, next, old, written)
    return this.v2Write(d, next, old, written)
  }

  // --- v1 front-end -------------------------------------------------------------------------

  private v1Write(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "CR1": {
        if (written & V1_CR1_SWRST) {
          this.reset()
          return 0
        }
        if (next & V1_CR1_SMBUS && !(old & V1_CR1_SMBUS)) this.onUnsupported(`${this.name} SMBus`)
        if (next & V1_CR1_ENGC && !(old & V1_CR1_ENGC)) this.onUnsupported(`${this.name} general call`)
        if (this.stopfArmed) {
          this.sr1 &= ~SR1_STOPF
          this.stopfArmed = false
        }
        // START and STOP are requests: they read back as set until acted on.
        const value = (next & ~(V1_CR1_START | V1_CR1_STOP)) >>> 0
        this.regs[0] = value | (this.pendingStart ? V1_CR1_START : 0) | (this.pendingStop ? V1_CR1_STOP : 0)
        if (!(next & V1_CR1_PE)) {
          if (old & V1_CR1_PE) this.abort()
          return this.regs[0]
        }
        if (written & V1_CR1_START && !this.pendingStart) {
          this.pendingStart = true
          this.regs[0] |= V1_CR1_START
          this.kick()
        }
        if (written & V1_CR1_STOP && !this.pendingStop) {
          this.pendingStop = true
          this.regs[0] |= V1_CR1_STOP
          this.kick()
        }
        return this.regs[0]
      }
      case "CR2":
        if (next & V1_CR2_DMAEN && !(old & V1_CR2_DMAEN)) this.onUnsupported(`${this.name} DMA`)
        this.regs[1] = next
        this.v1CheckIrq()
        return
      case "OAR1":
        if (next & (1 << 15)) this.onUnsupported(`${this.name} 10-bit addressing`)
        if (next & 0xfe) this.onUnsupported(`${this.name} slave mode (own address)`)
        return
      case "SR1":
        // Write-zero-to-clear error flags.
        this.sr1 &= ~(~written & (SR1_BERR | SR1_ARLO | SR1_AF | SR1_OVR))
        return 0
      case "DR":
        this.v1DrWrite(written & 0xff)
        return 0
    }
  }

  private v1CheckIrq() {
    if (this.flavour !== "v1") return
    const cr2 = this.regs[1]
    const sr1 = this.sr1
    if (cr2 & V1_CR2_ITEVTEN && (sr1 & (SR1_SB | SR1_ADDR | SR1_BTF | SR1_STOPF) || (cr2 & V1_CR2_ITBUFEN && sr1 & (SR1_TXE | SR1_RXNE))))
      this.raiseIrq(this.spec.irqEvent)
    if (cr2 & V1_CR2_ITERREN && sr1 & (SR1_BERR | SR1_ARLO | SR1_AF | SR1_OVR)) this.raiseIrq(this.spec.irqError)
  }
  private v1Set(bits: number) {
    const before = this.sr1
    this.sr1 |= bits
    if (this.sr1 !== before) this.v1CheckIrq()
  }

  private v1DrWrite(byte: number) {
    if (!this.enabled()) return
    this.sr1 &= ~SR1_BTF
    if (this.sr1 & SR1_SB) {
      // Address after START: bit 0 picks the direction.
      this.sr1 &= ~SR1_SB
      this.transmitter = (byte & 1) === 0
      this.startByte("tx", byte, true)
      return
    }
    if (!this.busy) return
    // Data byte: the shifter takes it now if idle (stretched or between bytes), else it waits in DR.
    if (this.op === null && this.transmitter) {
      this.sr1 |= SR1_TXE
      this.startByte("tx", byte)
    } else {
      this.dr = byte
      this.sr1 &= ~SR1_TXE
    }
  }

  private v1DrRead() {
    this.sr1 &= ~(SR1_RXNE | SR1_BTF)
    if (this.held >= 0) {
      // The byte the shifter was holding moves into DR; clocking resumes.
      this.drData = this.held
      this.held = -1
      this.sr1 |= SR1_RXNE
      this.resumeRx()
    }
    this.v1CheckIrq()
  }

  /** ADDR cleared: the transfer proper begins (v1). */
  private afterAddrCleared() {
    if (this.transmitter) {
      if (this.dr >= 0) {
        const b = this.dr
        this.dr = -1
        this.sr1 |= SR1_TXE
        this.startByte("tx", b)
      } else this.sr1 |= SR1_TXE
      this.v1CheckIrq()
    } else {
      this.ackNext = (this.regs[0] & V1_CR1_ACK) !== 0
      this.startByte("rx", 0)
    }
  }

  /** Something was requested while the engine is idle: START, STOP, or data. */
  private kick() {
    if (this.op !== null || !this.enabled()) return
    if (this.pendingStop && this.busy) {
      this.pendingStop = false
      this.regs[0] &= ~V1_CR1_STOP
      this.beginOp({ kind: "stop" })
      return
    }
    if (this.pendingStart) {
      // A START while the address is still awaited makes no sense; it waits for the byte.
      if (this.flavour === "v1" && this.sr1 & SR1_SB) return
      this.pendingStart = false
      this.regs[0] &= ~V1_CR1_START
      this.beginOp({ kind: "start", repeated: this.busy })
    }
  }

  // --- v2 front-end -------------------------------------------------------------------------

  private v2Write(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "CR1":
        if (next & V2_CR1_DMA && !(old & V2_CR1_DMA)) this.onUnsupported(`${this.name} DMA`)
        if (next & V2_CR1_SMBUS && !(old & V2_CR1_SMBUS)) this.onUnsupported(`${this.name} SMBus`)
        this.regs[0] = next
        if (!(next & V2_CR1_PE) && old & V2_CR1_PE) {
          this.abort()
          this.isr = ISR_TXE
        }
        this.v2CheckIrq()
        return
      case "CR2": {
        if (next & V2_CR2_ADD10 && !(old & V2_CR2_ADD10)) this.onUnsupported(`${this.name} 10-bit addressing`)
        if (next & V2_CR2_PECBYTE) this.onUnsupported(`${this.name} PEC`)
        this.regs[1] = (next & ~(V2_CR2_START | V2_CR2_STOP)) >>> 0
        if (!this.enabled()) return this.regs[1]
        // NBYTES written while TCR is up: the transfer goes on with the new count.
        if (this.isr & ISR_TCR && !(written & V2_CR2_START) && ((next >>> 16) & 0xff) !== ((old >>> 16) & 0xff)) this.v2Reload((next >>> 16) & 0xff)
        if (written & V2_CR2_START) {
          this.nbytesLeft = (next >>> 16) & 0xff
          this.transmitter = (next & V2_CR2_RD_WRN) === 0
          this.isr &= ~(ISR_TC | ISR_TCR)
          this.pendingStart = true
          this.regs[1] |= V2_CR2_START
          this.kick()
        }
        if (written & V2_CR2_STOP && this.busy) {
          this.isr &= ~(ISR_TC | ISR_TCR)
          this.pendingStop = true
          this.regs[1] |= V2_CR2_STOP
          this.kick()
        }
        return this.regs[1]
      }
      case "OAR1":
        if (next & (1 << 15)) this.onUnsupported(`${this.name} slave mode (own address)`)
        return
      case "ICR":
        this.isr &= ~(written & (ISR_NACKF | ISR_STOPF | ISR_BERR | ISR_ARLO | ISR_OVR))
        return 0
      case "TXDR":
        this.v2TxdrWrite(written & 0xff)
        return 0
    }
  }

  private v2CheckIrq() {
    if (this.flavour !== "v2") return
    const cr1 = this.regs[0]
    const isr = this.isr
    if ((cr1 & V2_CR1_TXIE && isr & ISR_TXIS) || (cr1 & V2_CR1_RXIE && isr & ISR_RXNE) || (cr1 & V2_CR1_NACKIE && isr & ISR_NACKF) || (cr1 & V2_CR1_STOPIE && isr & ISR_STOPF) || (cr1 & V2_CR1_TCIE && isr & (ISR_TC | ISR_TCR)))
      this.raiseIrq(this.spec.irqEvent)
    if (cr1 & V2_CR1_ERRIE && isr & (ISR_BERR | ISR_ARLO | ISR_OVR)) this.raiseIrq(this.spec.irqError)
  }
  private v2Set(bits: number) {
    const before = this.isr
    this.isr |= bits
    if (this.isr !== before) this.v2CheckIrq()
  }

  private v2TxdrWrite(byte: number) {
    this.isr &= ~(ISR_TXE | ISR_TXIS)
    if (this.op === null && this.busy && this.transmitter && this.nbytesLeft > 0 && !(this.isr & (ISR_TC | ISR_TCR))) {
      this.isr |= ISR_TXE
      this.startByte("tx", byte)
    } else this.txdr = byte
  }

  private v2RxdrRead() {
    this.isr &= ~ISR_RXNE
    if (this.rxnePending >= 0) {
      this.rxdr = this.rxnePending
      this.rxnePending = -1
      this.isr |= ISR_RXNE
    } else if (this.held >= 0) {
      this.rxdr = this.held
      this.held = -1
      this.isr |= ISR_RXNE
      this.resumeRx()
    }
    this.v2CheckIrq()
  }

  /** v2: the address was acknowledged, or a data byte finished: what next? */
  private v2Continue() {
    if (this.nbytesLeft === 0) {
      const cr2 = this.regs[1]
      if (cr2 & V2_CR2_RELOAD) {
        this.v2Set(ISR_TCR)
      } else if (cr2 & V2_CR2_AUTOEND) {
        this.beginOp({ kind: "stop" })
      } else {
        this.v2Set(ISR_TC)
      }
      return
    }
    if (this.transmitter) {
      if (this.txdr >= 0) {
        const b = this.txdr
        this.txdr = -1
        this.isr |= ISR_TXE
        this.startByte("tx", b)
      } else {
        this.v2Set(ISR_TXIS | ISR_TXE)
      }
    } else this.startByte("rx", 0)
  }

  /** v2: NBYTES reloaded while TCR is up. */
  private v2Reload(nbytes: number) {
    this.nbytesLeft = nbytes
    this.isr &= ~ISR_TCR
    this.v2Continue()
  }

  // --- the bit engine ----------------------------------------------------------------------

  private drive(line: I2cLine, level: boolean) {
    if (line === "SCL") {
      if (this.sclOut === level) return
      this.sclOut = level
    } else {
      if (this.sdaOut === level) return
      this.sdaOut = level
    }
    this.onOut(line, level)
  }

  private after(cycles: number, fn: () => void) {
    this.next = fn
    this.due = Math.max(1, cycles)
    this.setActive(true)
  }

  /** Release SCL and continue once it really is high (a slave may hold it). */
  private releaseScl(fn: () => void) {
    this.drive("SCL", true)
    if (this.sclIn) fn()
    else {
      this.awaitScl = fn
      this.setActive(true)
    }
  }

  private beginOp(op: Op) {
    this.op = op
    const { low, high } = this.timing()
    switch (op.kind) {
      case "start":
        if (op.repeated) {
          // SCL is low after the last byte: release SDA, then SCL, then pull SDA down.
          this.after(low / 2, () => {
            this.drive("SDA", true)
            this.after(low / 2, () =>
              this.releaseScl(() =>
                this.after(high / 2, () => {
                  this.drive("SDA", false)
                  this.after(high / 2, () => this.startDone())
                }),
              ),
            )
          })
        } else {
          this.drive("SDA", false)
          this.after(high, () => this.startDone())
        }
        return
      case "byte":
        this.after(low / 2, () => this.bitSetup())
        return
      case "stop":
        this.after(low / 2, () => {
          this.drive("SDA", false)
          this.after(low / 2, () =>
            this.releaseScl(() =>
              this.after(high / 2, () => {
                this.drive("SDA", true)
                this.stopDone()
              }),
            ),
          )
        })
        return
    }
  }

  private startDone() {
    this.drive("SCL", false)
    this.busy = true
    this.op = null
    this.next = null
    this.due = Infinity
    if (this.flavour === "v1") {
      this.v1Set(SR1_SB)
    } else {
      // v2 sends the address by itself.
      const cr2 = this.regs[1]
      const addr = ((cr2 >>> 1) & 0x7f) << 1
      this.startByte("tx", addr | (cr2 & V2_CR2_RD_WRN ? 1 : 0), true)
    }
    this.setActive(this.op !== null)
  }

  /** The byte in flight is the address (its ACK sets ADDR / NACKF rather than the data flags). */
  private isAddress = false
  private startByte(dir: "tx" | "rx", data: number, address = false) {
    this.isAddress = address
    this.beginOp({ kind: "byte", dir, data, bit: 0, ack: false })
  }

  /** SCL is low: put the bit (or the ACK) on SDA, then raise SCL. */
  private bitSetup() {
    const op = this.op as Extract<Op, { kind: "byte" }>
    const { low } = this.timing()
    if (op.bit < 8) {
      if (op.dir === "tx") this.drive("SDA", ((op.data >>> (7 - op.bit)) & 1) === 1)
      else this.drive("SDA", true)
    } else if (op.dir === "rx") {
      // Our ACK for the byte just received.
      const ack =
        this.flavour === "v1"
          ? this.regs[0] & V1_CR1_POS
            ? this.ackNext
            : (this.regs[0] & V1_CR1_ACK) !== 0
          : (this.nbytesLeft > 1 || (this.regs[1] & V2_CR2_RELOAD) !== 0) && !(this.regs[1] & V2_CR2_NACK)
      if (this.flavour === "v1") this.ackNext = (this.regs[0] & V1_CR1_ACK) !== 0
      op.ack = ack
      this.drive("SDA", !ack)
    } else this.drive("SDA", true)
    this.after(low / 2, () => this.releaseScl(() => this.bitHigh()))
  }

  /** SCL is high: sample SDA, then bring SCL low and move on. */
  private bitHigh() {
    const op = this.op as Extract<Op, { kind: "byte" }>
    const { high } = this.timing()
    if (op.bit < 8) {
      if (op.dir === "rx" && this.sdaIn) op.data |= 1 << (7 - op.bit)
    } else if (op.dir === "tx") op.ack = !this.sdaIn
    this.after(high, () => {
      this.drive("SCL", false)
      op.bit++
      if (op.bit < 9) this.after(this.timing().low / 2, () => this.bitSetup())
      else this.byteDone(op)
    })
  }

  private byteDone(op: Extract<Op, { kind: "byte" }>) {
    this.op = null
    this.next = null
    this.due = Infinity
    // SCL is low: let go of SDA (the last data bit, or our ACK).
    this.drive("SDA", true)
    if (this.flavour === "v1") this.v1ByteDone(op)
    else this.v2ByteDone(op)
    if (this.op === null) {
      this.kick()
      if (this.op === null) this.setActive(this.awaitScl !== null)
    }
  }

  private v1ByteDone(op: Extract<Op, { kind: "byte" }>) {
    if (this.isAddress) {
      this.isAddress = false
      if (op.ack) {
        this.v1Set(SR1_ADDR)
      } else {
        this.v1Set(SR1_AF)
      }
      return
    }
    if (op.dir === "tx") {
      if (!op.ack) {
        this.v1Set(SR1_AF)
        return
      }
      if (this.dr >= 0 && !this.pendingStop && !this.pendingStart) {
        const b = this.dr
        this.dr = -1
        this.sr1 |= SR1_TXE
        this.startByte("tx", b)
        this.v1CheckIrq()
      } else {
        this.v1Set(SR1_TXE | SR1_BTF)
      }
      return
    }
    // Received a byte.
    if (this.sr1 & SR1_RXNE) {
      this.held = op.data
      this.v1Set(SR1_BTF)
      return
    }
    this.drData = op.data
    this.v1Set(SR1_RXNE)
    // After our NACK (or with a STOP/START pending) the clock stays low until told what next.
    if (op.ack && !this.pendingStop && !this.pendingStart) this.startByte("rx", 0)
  }

  private v2ByteDone(op: Extract<Op, { kind: "byte" }>) {
    if (this.isAddress) {
      this.isAddress = false
      if (!op.ack) {
        this.v2Set(ISR_NACKF)
        this.beginOp({ kind: "stop" })
        return
      }
      this.v2Continue()
      return
    }
    this.nbytesLeft--
    if (op.dir === "tx") {
      if (!op.ack) {
        this.v2Set(ISR_NACKF)
        this.beginOp({ kind: "stop" })
        return
      }
      this.v2Continue()
      return
    }
    if (this.isr & ISR_RXNE) {
      this.held = op.data
      return
    }
    this.rxdr = op.data
    this.v2Set(ISR_RXNE)
    this.v2Continue()
  }

  /** DR/RXDR was read while a byte was held: continue receiving. */
  private resumeRx() {
    if (this.op !== null || !this.busy) return
    if (this.flavour === "v1") {
      if (!this.pendingStop && !this.pendingStart) this.startByte("rx", 0)
    } else this.v2Continue()
  }

  private stopDone() {
    this.op = null
    this.next = null
    this.due = Infinity
    this.busy = false
    this.transmitter = false
    this.dr = -1
    this.txdr = -1
    this.held = -1
    if (this.flavour === "v1") {
      this.sr1 &= ~(SR1_TXE | SR1_BTF)
      this.v1CheckIrq()
    } else {
      this.regs[1] &= ~(V2_CR2_STOP | V2_CR2_START)
      this.isr = (this.isr & ~(ISR_TC | ISR_TCR | ISR_TXIS)) | ISR_TXE
      this.v2Set(ISR_STOPF)
    }
    this.kick()
    if (this.op === null) this.setActive(false)
  }

  /** PE cleared: drop everything and release the bus. */
  private abort() {
    this.op = null
    this.next = null
    this.awaitScl = null
    this.due = Infinity
    this.busy = false
    this.pendingStart = this.pendingStop = false
    this.regs[0] &= ~(V1_CR1_START | V1_CR1_STOP)
    this.sr1 = 0
    this.dr = -1
    this.held = -1
    this.drive("SCL", true)
    this.drive("SDA", true)
    this.setActive(false)
  }

  // --- pins -------------------------------------------------------------------------------

  /** Resolved bus level of a line changed. */
  pinEdge(line: I2cLine, level: boolean) {
    if (line === "SDA") {
      this.sdaIn = level
      return
    }
    this.sclIn = level
    if (level && this.awaitScl) {
      const fn = this.awaitScl
      this.awaitScl = null
      fn()
    }
  }

  // --- clocking -------------------------------------------------------------------------------

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  tick(cycles: number) {
    if (!this.next) return
    this.due -= cycles
    while (this.next && this.due <= 0) {
      const fn = this.next
      const carry = this.due
      this.next = null
      this.due = Infinity
      fn()
      if (this.next) this.due += carry
    }
  }

  cyclesUntilEvent(): number {
    return this.next ? Math.max(1, Math.ceil(this.due)) : Infinity
  }
}

// --- the STM32F4/F7 I²C set -----------------------------------------------------------------

export const I2C_SPECS: I2cSpec[] = [
  { name: "I2C1", base: 0x40005400, irqEvent: 31, irqError: 32 },
  { name: "I2C2", base: 0x40005800, irqEvent: 33, irqError: 34 },
  { name: "I2C3", base: 0x40005c00, irqEvent: 72, irqError: 73 },
  { name: "I2C4", base: 0x40006000, irqEvent: 95, irqError: 96 },
]

export type I2cPad = { port: number; pin: number; af: number; line: I2cLine }

/** Pads per line (DS9405 Table 12 / DS10916 Table 13), AF4 unless marked. */
const PADS: Record<string, string> = {
  I2C1: "SCL PB6 PB8; SDA PB7 PB9 @4",
  I2C2: "SCL PB10 PF1 PH4; SDA PB11 PF0 PH5 PB3@9 @4",
  I2C3: "SCL PA8 PH7; SDA PC9 PH8 PB4@9 @4",
  I2C4: "SCL PD12 PF14 PH11; SDA PD13 PF15 PH12 @4",
}

export function i2cPads(name: string): I2cPad[] {
  const spec = PADS[name]
  if (!spec) return []
  const at = spec.lastIndexOf("@")
  const body = spec.slice(0, at)
  const af = Number(spec.slice(at + 1))
  const out: I2cPad[] = []
  for (const group of body.split(";")) {
    const [tag, ...pads] = group.trim().split(/\s+/)
    for (const p of pads) {
      const pm = /^P([A-K])(\d+)(?:@(\d+))?$/.exec(p)!
      out.push({ port: "ABCDEFGHIJK".indexOf(pm[1]), pin: Number(pm[2]), af: pm[3] ? Number(pm[3]) : af, line: tag as I2cLine })
    }
  }
  return out
}
