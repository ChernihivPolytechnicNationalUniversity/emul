/**
 * AVR TWI (I²C) unit (DS40002061B §22): master transmitter/receiver with the bit rate generator
 * (SCL = fCPU / (16 + 2·TWBR·4^TWPS)), slave receiver/transmitter with address match (TWAR,
 * TWAMR, general call), the status codes of Tables 22-2…22-6, TWINT stretching SCL low, and
 * the pins as open drain (Table 14-7: DDOV = "pull low", PVOV = 0).
 *
 * The master runs as a sequence (a generator) that waits either for a number of cycles or
 * for SCL to really go high, so a slave stretching the clock holds it back as on the bus.
 * The slave follows the edges the circuit puts on SCL and SDA.
 */
import { Peripheral, type AvrBus } from "../io"
import type { AvrMcu } from "../mcu"
import type { PinOverride } from "../port"

export type TwiSpec = { pins: { sda: [number, number]; scl: [number, number] }; vector: number; prr: number }

type Wait = { cycles: number } | { sclHigh: true } | { busFree: true }

const TWINT = 0x80
const TWEA = 0x40
const TWSTA = 0x20
const TWSTO = 0x10
const TWWC = 0x08
const TWEN = 0x04
const TWIE = 0x01

export class Twi extends Peripheral {
  readonly name = "TWI"
  override readonly domain = "none" as const
  private readonly mcu: AvrMcu
  readonly spec: TwiSpec
  twbr = 0
  twps = 0
  status = 0xf8
  twdr = 0xff
  twar = 0xfe
  twamr = 0
  twcr = 0
  /** Lines this unit pulls low. */
  private sclLow = false
  private sdaLow = false
  /** A START was seen on the bus and no STOP yet. */
  private busBusy = false
  // Master sequence.
  private seq: Generator<Wait, void, void> | null = null
  private wait: Wait | null = null
  private waitUntil = 0
  // Slave state.
  /** off: TWEA clear (not listening); idle: waiting for a START; then the phases of a transfer addressed to us. */
  private slave: "off" | "idle" | "addr" | "rx" | "tx" | "ack" | "hold" = "off"
  private slaveRole: "rx" | "tx" | "gc" | null = null
  private bits = 0
  private shift = 0
  private lastTxAck = false
  private lastByte = false

  constructor(bus: AvrBus, mcu: AvrMcu, spec: TwiSpec) {
    super(bus)
    this.mcu = mcu
    this.spec = spec
    const reg = (addr: number, name: string, read: () => number, write: (v: number, m: number) => void) =>
      bus.register(addr, {
        name,
        read: () => (bus.powerReduced(spec.prr) ? 0 : read()),
        write: (v, m) => {
          if (bus.powerReduced(spec.prr)) return
          write(v, m)
          this.changed()
        },
      })
    reg(0xb8, "TWBR", () => this.twbr, (v) => (this.twbr = v))
    reg(0xb9, "TWSR", () => (this.twcr & TWINT ? this.status : 0xf8) | this.twps, (v) => (this.twps = v & 3))
    reg(0xba, "TWAR", () => this.twar, (v) => (this.twar = v))
    reg(0xbb, "TWDR", () => this.twdr, (v) => this.writeTwdr(v))
    reg(0xbc, "TWCR", () => this.twcr & ~0x02, (v, m) => this.writeTwcr(v, m))
    reg(0xbd, "TWAMR", () => this.twamr, (v) => (this.twamr = v & 0xfe))
    bus.irq.add({ vector: spec.vector, pending: () => (this.twcr & (TWIE | TWINT)) === (TWIE | TWINT) })
    mcu.inputListeners.push((port, pin, level, cycle) => this.input(port, pin, level, cycle))
  }

  private get half() {
    // SCL period 16 + 2·TWBR·4^TWPS cycles, split into equal low and high times.
    return (16 + 2 * this.twbr * 4 ** this.twps) / 2
  }
  private sclIn() {
    return this.pin(this.spec.pins.scl)
  }
  private sdaIn() {
    return this.pin(this.spec.pins.sda)
  }
  private pin(p: [number, number]) {
    return this.mcu.ports.find((x) => x.index === p[0])!.di(p[1])
  }

  private writeTwdr(v: number) {
    if (!(this.twcr & TWINT)) {
      this.twcr |= TWWC
      return
    }
    this.twcr &= ~TWWC
    this.twdr = v
    this.twdrAt = this.mcu.cycleTime(this.now)
  }
  /** Time of the last TWDR write by the CPU, s. */
  private twdrAt = -Infinity
  /** Erratum 2.3.1: the first data bit reaches SDA late, at this cycle. */
  private lateSda: number | null = null

  private writeTwcr(v: number, m: number) {
    v = (this.twcr & ~m) | (v & m)
    const clearInt = (v & TWINT) !== 0 && (m & TWINT) !== 0
    const wasEnabled = (this.twcr & TWEN) !== 0
    // TWINT clears by writing one; TWWC is read-only; the rest follow the write.
    this.twcr = (this.twcr & (TWINT | TWWC)) | (v & (TWEA | TWSTA | TWSTO | TWEN | TWIE))
    if (!(this.twcr & TWEN)) {
      // Switched off: every transfer stops, the lines are released (§22.9.2).
      this.seq = null
      this.wait = null
      this.slave = "off"
      this.sclLow = this.sdaLow = false
      this.twcr &= ~(TWSTA | TWSTO)
      this.bus.pinsChanged()
      return
    }
    if (!wasEnabled || this.slave === "off" || this.slave === "idle") this.slave = this.twcr & TWEA ? (this.busBusy ? "idle" : "idle") : "off"
    if (clearInt && this.twcr & TWINT) {
      this.twcr &= ~TWINT
      this.resume()
    } else if (!(this.twcr & TWINT) && this.twcr & TWSTA && !this.seq && this.slave !== "hold") this.begin(this.start(false))
  }

  /** TWINT was cleared: the next step depends on where the unit stopped. */
  private resume() {
    const c = this.twcr
    if (this.seq) return
    const masterStates = [0x08, 0x10, 0x18, 0x20, 0x28, 0x30, 0x40, 0x48, 0x50, 0x58, 0x38]
    if (masterStates.includes(this.status)) {
      if (this.status === 0x38) {
        // Arbitration lost: release; START again when the bus is free if TWSTA.
        this.sclLow = this.sdaLow = false
        this.bus.pinsChanged()
        if (c & TWSTA) this.begin(this.start(false))
        return
      }
      if (c & TWSTO) {
        this.begin(this.stop(Boolean(c & TWSTA)))
        return
      }
      if (c & TWSTA) {
        this.begin(this.start(true))
        return
      }
      const reading = this.status === 0x40 || this.status === 0x50
      if (reading) this.begin(this.receiveByte())
      else if (this.status !== 0x48 && this.status !== 0x58) this.begin(this.sendByte(this.status === 0x08 || this.status === 0x10))
      return
    }
    // Slave: TWSTO recovers from an error (bus released, not addressed).
    if (c & TWSTO) {
      this.twcr &= ~TWSTO
      this.slave = c & TWEA ? "idle" : "off"
      this.sclLow = this.sdaLow = false
      this.bus.pinsChanged()
      return
    }
    if (this.slave === "hold") {
      this.sclLow = false
      if (this.slaveRole === "tx") {
        this.lastByte = (c & TWEA) === 0
        this.shift = this.twdr
        this.bits = 0
        this.slave = "tx"
        const low = (this.shift & 0x80) === 0
        // Silicon erratum 2.3.1 (Rev. A, B, above 2 MHz): the first bit after the ACK can reach SDA
        // after SCL is released — a false START. The errata gives no figures; the TWDR → SDA path is
        // taken as one 2 MHz cycle (500 ns), so TWCR written sooner after TWDR (only possible above
        // 2 MHz) lets SCL go first, and the work-around (a delay between the two writes) avoids it.
        const ready = this.twdrAt + 0.5e-6
        if (low && this.mcu.hasErratum("2.3.1") && this.bus.hz > 2e6 && ready > this.mcu.cycleTime(this.now + 1)) {
          this.sdaLow = false
          this.lateSda = this.mcu.timeCycle(ready)
          this.mcu.feature(`TWI: silicon erratum 2.3.1 — slave data set up after SCL was released (false START); delay TWCR after TWDR (Rev. ${this.mcu.revision})`)
          this.plan()
        } else this.sdaLow = low
      } else if (this.status === 0xa0 || this.status === 0x88 || this.status === 0x98 || this.status === 0xc0 || this.status === 0xc8) {
        this.slave = c & TWEA ? "idle" : "off"
      } else {
        this.slave = "rx"
        this.bits = 0
        this.shift = 0
      }
      this.bus.pinsChanged()
    }
    if (c & TWSTA && !this.seq) this.begin(this.start(false))
  }

  private interrupt(status: number) {
    this.status = status
    this.twcr |= TWINT
    this.bus.irq.update()
  }

  reset() {
    this.lateSda = null
    this.twdrAt = -Infinity
    this.twbr = this.twps = 0
    this.status = 0xf8
    this.twdr = 0xff
    this.twar = 0xfe
    this.twamr = 0
    this.twcr = 0
    this.sclLow = this.sdaLow = false
    this.busBusy = false
    this.seq = null
    this.wait = null
    this.slave = "off"
    this.slaveRole = null
    this.due = Infinity
  }

  // --- master sequences --------------------------------------------------------------------------

  private *start(repeated: boolean): Generator<Wait, void, void> {
    if (repeated) {
      // From SCL low: release SDA, then SCL, then pull SDA low while SCL is high.
      this.drive(this.sclLow, false)
      yield { cycles: this.half }
      this.drive(false, false)
      yield { sclHigh: true }
      yield { cycles: this.half }
    } else {
      if (this.busBusy) yield { busFree: true }
    }
    this.drive(false, true)
    yield { cycles: this.half }
    this.drive(true, true)
    this.busBusy = true
    this.interrupt(repeated ? 0x10 : 0x08)
  }

  private *sendByte(address: boolean): Generator<Wait, void, void> {
    const byte = this.twdr
    for (let i = 7; i >= 0; i--) {
      const one = ((byte >> i) & 1) === 1
      this.drive(true, !one)
      yield { cycles: this.half }
      this.drive(false, !one)
      yield { sclHigh: true }
      yield { cycles: this.half }
      if (one && !this.sdaIn()) {
        // Someone else pulls SDA low: arbitration lost (§22.8).
        this.drive(false, false)
        this.interrupt(0x38)
        return
      }
      this.drive(true, !one)
    }
    this.drive(true, false)
    yield { cycles: this.half }
    this.drive(false, false)
    yield { sclHigh: true }
    yield { cycles: this.half }
    const ack = !this.sdaIn()
    this.drive(true, false)
    const read = address && (byte & 1) === 1
    this.interrupt(address ? (read ? (ack ? 0x40 : 0x48) : ack ? 0x18 : 0x20) : ack ? 0x28 : 0x30)
  }

  private *receiveByte(): Generator<Wait, void, void> {
    const ack = (this.twcr & TWEA) !== 0
    let v = 0
    for (let i = 0; i < 8; i++) {
      this.drive(true, false)
      yield { cycles: this.half }
      this.drive(false, false)
      yield { sclHigh: true }
      yield { cycles: this.half }
      v = (v << 1) | (this.sdaIn() ? 1 : 0)
      this.drive(true, false)
    }
    this.twdr = v
    this.drive(true, ack)
    yield { cycles: this.half }
    this.drive(false, ack)
    yield { sclHigh: true }
    yield { cycles: this.half }
    this.drive(true, false)
    this.interrupt(ack ? 0x50 : 0x58)
  }

  private *stop(thenStart: boolean): Generator<Wait, void, void> {
    this.drive(true, true)
    yield { cycles: this.half }
    this.drive(false, true)
    yield { sclHigh: true }
    yield { cycles: this.half }
    this.drive(false, false)
    this.busBusy = false
    this.twcr &= ~TWSTO
    this.status = 0xf8
    if (thenStart) {
      yield { cycles: this.half }
      yield* this.start(false)
    }
  }

  private drive(scl: boolean, sda: boolean) {
    if (scl === this.sclLow && sda === this.sdaLow) return
    this.sclLow = scl
    this.sdaLow = sda
    this.mcu.pinsChangedAt(this.bus.cpu.cycles)
  }

  private begin(seq: Generator<Wait, void, void>) {
    this.seq = seq
    this.wait = null
    this.step(this.bus.cpu.cycles)
  }

  private stepping = false
  private again = false
  /** Run the master sequence as far as it can go at `cycle` (a line it drives may echo back meanwhile). */
  private step(cycle: number) {
    if (this.stepping) {
      this.again = true
      return
    }
    this.stepping = true
    try {
      do {
        this.again = false
        this.advance(cycle)
      } while (this.again)
    } finally {
      this.stepping = false
    }
    this.plan()
  }
  private advance(cycle: number) {
    while (this.seq) {
      const w = this.wait
      if (w) {
        if ("cycles" in w) {
          if (cycle < this.waitUntil) break
        } else if ("sclHigh" in w) {
          if (!this.sclIn()) break
        } else if (this.busBusy) break
        this.wait = null
      }
      const r = this.seq.next()
      if (r.done) {
        this.seq = null
        break
      }
      this.wait = r.value
      if ("cycles" in r.value) this.waitUntil = cycle + r.value.cycles
    }
  }

  // --- the bus -------------------------------------------------------------------------------------

  private input(port: number, pin: number, level: boolean, cycle: number) {
    if (!(this.twcr & TWEN)) return
    const isScl = port === this.spec.pins.scl[0] && pin === this.spec.pins.scl[1]
    const isSda = port === this.spec.pins.sda[0] && pin === this.spec.pins.sda[1]
    if (!isScl && !isSda) return
    if (isSda && this.sclIn()) {
      // START (SDA falls) or STOP (SDA rises) while SCL is high.
      if (!level) this.onStart()
      else this.onStop()
    } else if (isScl) {
      if (level) this.sclRise()
      else this.sclFall()
    }
    if (this.seq) this.step(Math.ceil(cycle))
  }

  private onStart() {
    this.busBusy = true
    if (this.seq) return // our own START
    if (this.slave === "rx" || (this.slave === "hold" && this.slaveRole === "rx")) {
      this.slave = "hold"
      this.interrupt(0xa0)
      return
    }
    if (this.slave !== "off") {
      this.slave = "addr"
      this.addressing = true
      this.bits = 0
      this.shift = 0
    }
  }
  private onStop() {
    this.busBusy = false
    if (this.seq) return
    if (this.slave === "rx") {
      this.slave = "hold"
      this.interrupt(0xa0)
      return
    }
    if (this.slave !== "off" && this.slave !== "hold") this.slave = this.twcr & TWEA ? "idle" : "off"
    if (this.twcr & TWSTA && !this.seq && !(this.twcr & TWINT)) this.begin(this.start(false))
  }

  private sclRise() {
    if (this.seq) return
    if (this.slave === "addr" || this.slave === "rx") {
      if (this.bits < 8) {
        this.shift = (this.shift << 1) | (this.sdaIn() ? 1 : 0)
        this.bits++
      }
    } else if (this.slave === "ack" && this.slaveRole === "tx") {
      this.lastTxAck = !this.sdaIn()
    }
  }

  private sclFall() {
    if (this.seq) return
    switch (this.slave) {
      case "addr":
        if (this.bits === 8) {
          const addr = this.shift >> 1
          const mine = ((addr ^ (this.twar >> 1)) & ~(this.twamr >> 1) & 0x7f) === 0
          const gc = addr === 0 && (this.twar & 1) === 1 && (this.shift & 1) === 0
          if ((mine || gc) && this.twcr & TWEA) {
            this.slaveRole = gc ? "gc" : this.shift & 1 ? "tx" : "rx"
            this.slave = "ack"
            this.drive(false, true)
          } else {
            // Not us: wait for the next START.
            this.bits = 0
            this.slave = "idle"
          }
        }
        break
      case "rx":
        if (this.bits === 8) {
          this.twdr = this.shift & 0xff
          const ack = (this.twcr & TWEA) !== 0
          this.slave = "ack"
          this.lastTxAck = ack
          this.drive(false, ack)
        }
        break
      case "tx":
        this.bits++
        if (this.bits < 8) this.drive(false, ((this.shift >> (7 - this.bits)) & 1) === 0)
        else {
          this.drive(false, false)
          this.slave = "ack"
        }
        break
      case "ack": {
        // End of the ACK clock: report and hold SCL low while TWINT is set.
        this.drive(true, false)
        this.slave = "hold"
        const addressPhase = this.bits === 8 && this.lastStatusWasAddress()
        if (this.slaveRole === "tx") {
          if (addressPhase) this.interrupt(0xa8)
          else this.interrupt(this.lastTxAck ? (this.lastByte ? 0xc8 : 0xb8) : 0xc0)
        } else if (addressPhase) this.interrupt(this.slaveRole === "gc" ? 0x70 : 0x60)
        else {
          const ack = this.lastTxAck
          this.interrupt(this.slaveRole === "gc" ? (ack ? 0x90 : 0x98) : ack ? 0x80 : 0x88)
        }
        this.bits = 0
        this.shift = 0
        break
      }
    }
  }
  /** Whether the ACK just clocked belonged to the address byte (no data byte yet in this transfer). */
  private addressing = true
  private lastStatusWasAddress() {
    const was = this.addressing
    this.addressing = false
    return was
  }

  // --- pins, scheduling -------------------------------------------------------------------------------

  /** Table 14-7: with TWEN the pin is an input with its PORT pull-up, driven low when the unit pulls it. */
  override(o: PinOverride, which: "scl" | "sda", portBit: boolean, pud: boolean) {
    if (!(this.twcr & TWEN)) return
    o.puoe = true
    o.puov = portBit && !pud
    o.ddoe = true
    o.ddov = which === "scl" ? this.sclLow : this.sdaLow
    o.pvoe = true
    o.pvov = false
  }

  private changed() {
    this.bus.irq.update()
    this.bus.pinsChanged()
    this.plan()
  }
  private plan() {
    this.due = Math.min(this.seq && this.wait && "cycles" in this.wait ? this.waitUntil : Infinity, this.lateSda === null ? Infinity : Math.ceil(this.lateSda))
    this.bus.reschedule()
  }
  override service(cycle: number) {
    if (this.lateSda !== null && cycle >= this.lateSda) {
      const at = this.lateSda
      this.lateSda = null
      if (this.slave === "tx" && this.bits === 0) {
        this.sdaLow = true
        this.mcu.pinsChangedAt(at)
      }
      this.plan()
    }
    this.step(cycle)
    this.bus.irq.update()
  }
}
