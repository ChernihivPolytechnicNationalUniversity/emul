/**
 * AVR SPI (DS40002061B §19): master with the SCK divider of Table 19-5, slave clocked from the
 * SCK pin, the four data modes of Table 19-2, data order, the single-buffered transmitter and
 * double-buffered receiver, SPIF/WCOL and the master's SS input.
 *
 * A master transfer is planned when SPDR is written: SCK toggles every half period from the
 * cycle after the write, the first bit is out at once (CPHA = 0) or on the leading edge
 * (CPHA = 1), MISO is sampled on the sampling edges, SPIF rises after the sixteenth edge.
 * A slave follows the edges the circuit puts on SCK (through the pin synchronizer).
 */
import { Peripheral, type AvrBus } from "../io"
import type { AvrMcu } from "../mcu"
import type { PinOverride } from "../port"
import { syncEdge } from "./extint"

export type SpiSpec = {
  pins: { ss: [number, number]; mosi: [number, number]; miso: [number, number]; sck: [number, number] }
  vector: number
  prr: number
}

export class Spi extends Peripheral {
  readonly name = "SPI"
  private readonly mcu: AvrMcu
  readonly spec: SpiSpec
  spcr = 0
  private spi2x = false
  private spif = false
  private wcol = false
  /** SPSR was read with SPIF or WCOL set: the next SPDR access clears them. */
  private flagsSeen = false
  /** The byte being shifted out, and the receive buffer. */
  private shiftOut = 0
  private shiftIn = 0
  private received = 0
  private bits = 0
  // Master transfer in flight.
  private start = -1
  private half = 0
  private edgesDone = 0
  // Pin levels the block drives.
  private sck = false
  private mosi = false
  private miso = false

  constructor(bus: AvrBus, mcu: AvrMcu, spec: SpiSpec) {
    super(bus)
    this.mcu = mcu
    this.spec = spec
    const reg = (addr: number, name: string, read: () => number, write: (v: number, m: number) => void) =>
      bus.register(addr, {
        name,
        read: () => (bus.powerReduced(spec.prr) ? 0 : (this.sync(this.now), read())),
        write: (v, m) => {
          if (bus.powerReduced(spec.prr)) return
          this.sync(this.now)
          write(v, m)
          this.changed()
        },
      })
    reg(0x4c, "SPCR", () => this.spcr, (v) => this.writeSpcr(v))
    reg(0x4d, "SPSR", () => this.readSpsr(), (v, m) => (this.spi2x = ((v & m) | (this.spi2x ? 1 & ~m : 0)) !== 0))
    reg(0x4e, "SPDR", () => this.readSpdr(), (v) => this.writeSpdr(v))
    bus.irq.add({
      vector: spec.vector,
      pending: () => (this.spcr & 0x80) !== 0 && this.spif,
      acknowledge: () => {
        this.spif = false
      },
    })
    mcu.inputListeners.push((port, pin, level, cycle) => this.input(port, pin, level, cycle))
  }

  private get enabled() {
    return (this.spcr & 0x40) !== 0
  }
  private get isMaster() {
    return (this.spcr & 0x10) !== 0
  }
  private get cpol() {
    return (this.spcr & 0x08) !== 0
  }
  private get cpha() {
    return (this.spcr & 0x04) !== 0
  }
  private get lsbFirst() {
    return (this.spcr & 0x20) !== 0
  }
  /** SCK = fosc / divisor (Table 19-5). */
  private get divisor() {
    const spr = this.spcr & 3
    return this.spi2x ? [2, 8, 32, 64][spr] : [4, 16, 64, 128][spr]
  }
  private outBit() {
    const i = this.bits
    return this.lsbFirst ? ((this.shiftOut >> i) & 1) === 1 : ((this.shiftOut >> (7 - i)) & 1) === 1
  }
  private takeBit(level: boolean) {
    const i = this.bits
    if (level) this.shiftIn |= this.lsbFirst ? 1 << i : 0x80 >> i
    this.bits++
  }

  private writeSpcr(v: number) {
    const was = this.spcr
    this.spcr = v
    if (!this.enabled) this.start = -1
    if ((was ^ v) & 0x18 && this.enabled && !this.isMaster) this.sck = this.cpol
    if (this.enabled && this.isMaster && this.start < 0) this.sck = this.cpol
    this.checkSs(this.now)
  }
  private readSpsr() {
    if (this.spif || this.wcol) this.flagsSeen = true
    return (this.spif ? 0x80 : 0) | (this.wcol ? 0x40 : 0) | (this.spi2x ? 1 : 0)
  }
  private clearSeen() {
    if (!this.flagsSeen) return
    this.flagsSeen = false
    this.spif = false
    this.wcol = false
  }
  private readSpdr() {
    this.clearSeen()
    return this.received
  }
  private writeSpdr(v: number) {
    this.clearSeen()
    if (this.busy()) {
      this.wcol = true
      return
    }
    this.shiftOut = v & 0xff
    this.shiftIn = 0
    this.bits = 0
    if (!this.enabled) return
    if (this.isMaster) {
      this.start = this.now + 1
      this.half = this.divisor / 2
      this.edgesDone = 0
      if (!this.cpha) this.mosi = this.outBit()
    } else if (!this.cpha && this.selected()) this.miso = this.outBit()
  }
  private busy() {
    return this.isMaster ? this.start >= 0 : this.bits > 0 && this.selected()
  }

  reset() {
    this.spcr = 0
    this.spi2x = this.spif = this.wcol = this.flagsSeen = false
    this.shiftOut = this.shiftIn = this.received = this.bits = 0
    this.start = -1
    this.sck = this.mosi = this.miso = false
    this.due = Infinity
  }

  // --- master ---------------------------------------------------------------------------------

  /** Edges at start + k·half for k = 1…16: odd k leading, even k trailing. */
  override sync(cycle: number) {
    if (this.start < 0) return
    while (this.edgesDone < 16) {
      const k = this.edgesDone + 1
      const at = this.start + k * this.half
      if (at > cycle) return
      this.edgesDone = k
      const leading = k % 2 === 1
      this.sck = leading ? !this.cpol : this.cpol
      const sample = leading !== this.cpha
      if (sample) this.takeBit(this.misoIn())
      else if (this.bits < 8) this.mosi = this.outBit()
      if (k === 16) {
        this.finish()
        this.start = -1
      }
      this.mcu.pinsChangedAt(at)
    }
  }
  private misoIn() {
    const [p, b] = this.spec.pins.miso
    return this.mcu.ports.find((x) => x.index === p)!.di(b)
  }
  private finish() {
    this.received = this.shiftIn
    this.spif = true
    this.bits = 0
  }

  // --- slave and SS ------------------------------------------------------------------------------

  private pinLevel(pin: [number, number]) {
    return this.mcu.ports.find((x) => x.index === pin[0])!.di(pin[1])
  }
  private selected() {
    return !this.isMaster && this.enabled && !this.pinLevel(this.spec.pins.ss)
  }
  /** Master with SS as an input pulled low: another master took the bus (§19.3.2). */
  private checkSs(cycle: number) {
    if (!this.enabled || !this.isMaster) return
    const [p, b] = this.spec.pins.ss
    const port = this.mcu.ports.find((x) => x.index === p)!
    if ((port.ddr >> b) & 1) return
    if (port.di(b)) return
    this.spcr &= ~0x10
    this.spif = true
    this.start = -1
    void cycle
  }

  private input(port: number, pin: number, level: boolean, cycle: number) {
    const s = this.spec.pins
    if (!this.enabled) return
    const is = (q: [number, number]) => q[0] === port && q[1] === pin
    if (is(s.ss)) {
      this.sync(this.bus.cpu.cycles)
      if (this.isMaster) this.checkSs(cycle)
      else if (level) {
        // Deselected: the slave drops the partial byte (§19.3.1).
        this.bits = 0
        this.shiftIn = 0
      } else if (!this.cpha) this.miso = this.outBit()
      this.changed()
      return
    }
    if (is(s.sck) && !this.isMaster && this.selected()) {
      void syncEdge(cycle)
      const leading = level !== this.cpol
      const sample = leading !== this.cpha
      if (sample) {
        this.takeBit(this.pinLevel(s.mosi))
        if (this.bits === 8) this.finish()
      } else if (this.bits < 8) this.miso = this.outBit()
      this.changed()
    }
  }

  // --- pins (Tables 14-4, 14-5) -----------------------------------------------------------------

  sckOverride(o: PinOverride, portBit: boolean, pud: boolean) {
    if (!this.enabled) return
    if (this.isMaster) {
      o.pvoe = true
      o.pvov = this.sck
    } else this.input_(o, portBit, pud)
  }
  misoOverride(o: PinOverride, portBit: boolean, pud: boolean) {
    if (!this.enabled) return
    if (this.isMaster) this.input_(o, portBit, pud)
    else {
      o.pvoe = true
      o.pvov = this.miso
    }
  }
  mosiOverride(o: PinOverride, portBit: boolean, pud: boolean) {
    if (!this.enabled) return
    if (this.isMaster) {
      // PVOE = SPE·MSTR + OC2A ENABLE, PVOV = SPI MSTR OUTPUT + OC2A.
      o.pvov = (o.pvoe && o.pvov) || this.mosi
      o.pvoe = true
    } else this.input_(o, portBit, pud)
  }
  ssOverride(o: PinOverride, portBit: boolean, pud: boolean) {
    if (this.enabled && !this.isMaster) this.input_(o, portBit, pud)
  }
  private input_(o: PinOverride, portBit: boolean, pud: boolean) {
    o.puoe = true
    o.puov = portBit && !pud
    o.ddoe = true
    o.ddov = false
  }

  // --- scheduling ---------------------------------------------------------------------------------

  private changed() {
    this.bus.irq.update()
    this.bus.pinsChanged()
    this.plan()
  }
  private plan() {
    this.due = this.start >= 0 ? this.start + (this.edgesDone + 1) * this.half : Infinity
    this.bus.reschedule()
  }
  override service(cycle: number) {
    this.sync(cycle)
    this.bus.irq.update()
    this.plan()
  }
}
