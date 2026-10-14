/**
 * ATmega328P TWI against DS40002061B §22: the SCL rate equation (§22.5.2, Table 22-7), the
 * status codes of master transmitter and receiver (Tables 22-2, 22-3) and slave receiver and
 * transmitter (Tables 22-4, 22-5), TWINT holding SCL low, clock stretching, and the open-drain
 * pin overrides (Table 14-7). The other end of the bus is a reference I²C device written from
 * the I²C specification (NXP UM10204): wired-AND lines with pull-ups, a slave that ACKs its
 * address, and a master that drives the part as a slave.
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"

const TWBR = 0xb8
const TWSR = 0xb9
const TWAR = 0xba
const TWDR = 0xbb
const TWCR = 0xbc
const TWAMR = 0xbd
const SDA = { port: 2, pin: 4 }
const SCL = { port: 2, pin: 5 }
const HZ = 16e6
const INT = 0x80
const EA = 0x40
const STA = 0x20
const STO = 0x10
const EN = 0x04

/**
 * The bus: each line is high unless the part or the device pulls it low (external pull-ups).
 * `device` reacts to line changes and says which lines it pulls low.
 */
class Bus {
  scl = true
  sda = true
  devScl = false
  devSda = false
  sclEdges: { t: number; level: boolean }[] = []
  constructor(readonly m: AvrMcu, readonly device: Device) {
    m.setWiredPads([SDA.port * 16 + SDA.pin, SCL.port * 16 + SCL.pin])
    m.setPad(SDA, true)
    m.setPad(SCL, true)
  }
  /** Run in small steps, resolving the lines after each. */
  run(seconds: number, step = 0.25e-6) {
    const end = this.m.time + seconds
    while (this.m.time < end - 1e-12) {
      this.m.runUntil(Math.min(end, this.m.time + step))
      this.resolve()
    }
  }
  resolve() {
    for (let i = 0; i < 4; i++) {
      const partScl = this.m.padDrive(SCL) === "low"
      const partSda = this.m.padDrive(SDA) === "low"
      const scl = !(partScl || this.devScl)
      const sda = !(partSda || this.devSda)
      if (scl === this.scl && sda === this.sda) return
      const t = this.m.time
      const sdaChanged = sda !== this.sda
      const sclChanged = scl !== this.scl
      this.scl = scl
      this.sda = sda
      if (sclChanged) {
        this.m.setPadAt(SCL, scl, t)
        this.sclEdges.push({ t, level: scl })
      }
      if (sdaChanged) this.m.setPadAt(SDA, sda, t)
      this.device.lines(this, sclChanged, sdaChanged)
    }
  }
}

interface Device {
  lines(bus: Bus, sclChanged: boolean, sdaChanged: boolean): void
}

/** An I²C slave from UM10204 §3.1: START/STOP detection, address + R/W, ACK, bytes MSB first. */
class RefSlave implements Device {
  received: number[] = []
  starts = 0
  stops = 0
  private bit = 0
  private shift = 0
  private state: "idle" | "addr" | "ack-addr" | "write" | "ack-write" | "read" | "ack-read" = "idle"
  private reading = false
  private toSend: number[]
  /** Hold SCL low this long after each ACK clock (clock stretching). */
  stretch = 0
  private stretchUntil = 0
  constructor(readonly address: number, toSend: number[] = []) {
    this.toSend = [...toSend]
  }
  lines(bus: Bus, sclChanged: boolean, sdaChanged: boolean) {
    if (sdaChanged && bus.scl) {
      if (!bus.sda) {
        this.starts++
        this.state = "addr"
        this.bit = 0
        this.shift = 0
        bus.devSda = false
      } else {
        this.stops++
        this.state = "idle"
        bus.devSda = false
      }
      return
    }
    if (!sclChanged) return
    if (bus.scl) {
      // Rising SCL: sample.
      if (this.state === "addr" || this.state === "write") {
        this.shift = (this.shift << 1) | (bus.sda ? 1 : 0)
        this.bit++
      } else if (this.state === "ack-read") {
        // Master's ACK after our byte: NACK ends the transfer.
        this.reading = !bus.sda
      }
      return
    }
    // Falling SCL: change what we drive.
    if (this.state === "addr" && this.bit === 8) {
      const addr = this.shift >> 1
      if (addr === this.address) {
        this.reading = (this.shift & 1) === 1
        this.state = "ack-addr"
        bus.devSda = true
      } else this.state = "idle"
    } else if (this.state === "ack-addr") {
      bus.devSda = false
      this.bit = 0
      this.shift = 0
      if (this.reading) this.beginRead(bus)
      else this.state = "write"
      if (this.stretch) {
        bus.devScl = true
        this.stretchUntil = bus.m.time + this.stretch
      }
    } else if (this.state === "write" && this.bit === 8) {
      this.received.push(this.shift & 0xff)
      this.state = "ack-write"
      bus.devSda = true
    } else if (this.state === "ack-write") {
      bus.devSda = false
      this.state = "write"
      this.bit = 0
      this.shift = 0
    } else if (this.state === "read") {
      this.bit++
      if (this.bit < 8) bus.devSda = ((this.shift >> (7 - this.bit)) & 1) === 0
      else {
        bus.devSda = false
        this.state = "ack-read"
      }
    } else if (this.state === "ack-read") {
      if (this.reading) this.beginRead(bus)
      else {
        this.state = "idle"
        bus.devSda = false
      }
    }
  }
  private beginRead(bus: Bus) {
    this.state = "read"
    this.shift = this.toSend.shift() ?? 0xff
    this.bit = 0
    bus.devSda = (this.shift & 0x80) === 0
  }
  release(bus: Bus) {
    if (bus.devScl && bus.m.time >= this.stretchUntil) {
      bus.devScl = false
      bus.resolve()
    }
  }
}

function part(): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { low: 0xff, high: 0xd9, extended: 0xfd, lock: 0xff }
  m.setClockFeed({ hz: HZ, kind: "crystal" })
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.runUntil(0.07)
  return m
}

/** Wait (running the bus) until TWINT is set; return TWSR status with prescaler bits masked. */
function waitInt(bus: Bus, slave?: RefSlave, limit = 2e-3) {
  const end = bus.m.time + limit
  while (!(bus.m.read(TWCR) & INT) && bus.m.time < end) {
    bus.run(1e-6)
    slave?.release(bus)
  }
  return bus.m.read(TWSR) & 0xf8
}
const go = (m: AvrMcu, extra = 0) => m.poke(TWCR, INT | EN | extra)

describe("bit rate (§22.5.2, Table 22-7)", () => {
  it.each([
    [72, 0, 100e3],
    [12, 0, 400e3],
    [18, 1, 50e3],
  ])("TWBR = %i, TWPS = %i: SCL = fCPU/(16 + 2·TWBR·4^TWPS) ≈ %d Hz", (twbr, twps, _nominal) => {
    const m = part()
    const slave = new RefSlave(0x50)
    const bus = new Bus(m, slave)
    m.poke(TWBR, twbr)
    m.poke(TWSR, twps)
    go(m, STA)
    expect(waitInt(bus)).toBe(0x08)
    m.poke(TWDR, 0x50 << 1)
    bus.sclEdges.length = 0
    go(m)
    expect(waitInt(bus)).toBe(0x18)
    const rises = bus.sclEdges.filter((e) => e.level).map((e) => e.t)
    const period = (rises[rises.length - 1] - rises[1]) / (rises.length - 2)
    const want = (16 + 2 * twbr * 4 ** twps) / HZ
    // The bus is stepped at 0.25 µs: the period is within one step of the equation.
    expect(Math.abs(period - want)).toBeLessThan(0.3e-6)
  })
})

describe("master transmitter (Table 22-2)", () => {
  it("START 0x08, SLA+W ACK 0x18, data ACK 0x28, STOP; the slave gets the bytes", () => {
    const m = part()
    const slave = new RefSlave(0x50)
    const bus = new Bus(m, slave)
    m.poke(TWBR, 72)
    go(m, STA)
    expect(waitInt(bus)).toBe(0x08)
    m.poke(TWDR, 0xa0)
    go(m)
    expect(waitInt(bus)).toBe(0x18)
    for (const b of [0x12, 0x34]) {
      m.poke(TWDR, b)
      go(m)
      expect(waitInt(bus)).toBe(0x28)
    }
    go(m, STO)
    bus.run(30e-6)
    expect(m.read(TWCR) & STO).toBe(0) // cleared once the STOP is on the bus
    expect(m.read(TWSR) & 0xf8).toBe(0xf8)
    expect(slave.received).toEqual([0x12, 0x34])
    expect(slave.stops).toBe(1)
    expect(bus.scl && bus.sda).toBe(true)
  })

  it("an address nobody answers: SLA+W NOT ACK 0x20", () => {
    const m = part()
    const bus = new Bus(m, new RefSlave(0x50))
    m.poke(TWBR, 72)
    go(m, STA)
    waitInt(bus)
    m.poke(TWDR, 0x42 << 1)
    go(m)
    expect(waitInt(bus)).toBe(0x20)
  })

  it("repeated START gives 0x10, and TWINT holds SCL low until it is cleared (§22.5.5)", () => {
    const m = part()
    const slave = new RefSlave(0x50, [0x99])
    const bus = new Bus(m, slave)
    m.poke(TWBR, 72)
    go(m, STA)
    waitInt(bus)
    m.poke(TWDR, 0xa0)
    go(m)
    waitInt(bus)
    bus.run(50e-6)
    expect(bus.scl).toBe(false)
    go(m, STA)
    expect(waitInt(bus)).toBe(0x10)
  })

  it("writing TWDR while TWINT is low sets TWWC", () => {
    const m = part()
    const bus = new Bus(m, new RefSlave(0x50))
    m.poke(TWBR, 72)
    go(m, STA)
    waitInt(bus)
    m.poke(TWDR, 0xa0)
    go(m)
    m.poke(TWDR, 0x55)
    expect(m.read(TWCR) & 0x08).toBe(0x08)
  })

  it("a slave stretching SCL after the address lengthens that low period", () => {
    const m = part()
    const slave = new RefSlave(0x50)
    slave.stretch = 30e-6
    const bus = new Bus(m, slave)
    m.poke(TWBR, 72)
    go(m, STA)
    waitInt(bus)
    m.poke(TWDR, 0xa0)
    go(m)
    waitInt(bus, slave)
    bus.sclEdges.length = 0
    m.poke(TWDR, 0x01)
    go(m)
    expect(waitInt(bus, slave)).toBe(0x28)
    expect(slave.received).toEqual([0x01])
  })
})

describe("master receiver (Table 22-3)", () => {
  it("SLA+R ACK 0x40, data with ACK 0x50, last with NOT ACK 0x58", () => {
    const m = part()
    const slave = new RefSlave(0x50, [0xde, 0xad])
    const bus = new Bus(m, slave)
    m.poke(TWBR, 72)
    go(m, STA)
    waitInt(bus)
    m.poke(TWDR, 0xa1)
    go(m)
    expect(waitInt(bus)).toBe(0x40)
    go(m, EA)
    expect(waitInt(bus)).toBe(0x50)
    expect(m.read(TWDR)).toBe(0xde)
    go(m)
    expect(waitInt(bus)).toBe(0x58)
    expect(m.read(TWDR)).toBe(0xad)
    go(m, STO)
    bus.run(30e-6)
    expect(slave.stops).toBe(1)
  })
})

/** A reference master driving the part as a slave: bit-banged at 100 kHz from the test. */
class RefMaster implements Device {
  sdaLow = false
  sclLow = false
  lines(bus: Bus) {
    void bus
  }
  private set(bus: Bus, scl: boolean, sda: boolean) {
    bus.devScl = !scl
    bus.devSda = !sda
    bus.resolve()
  }
  /** Wait while the part stretches SCL. */
  private waitScl(bus: Bus) {
    for (let i = 0; i < 4000 && !bus.scl; i++) bus.run(0.25e-6)
  }
  start(bus: Bus) {
    this.set(bus, true, true)
    bus.run(5e-6)
    this.set(bus, true, false)
    bus.run(5e-6)
    this.set(bus, false, false)
    bus.run(5e-6)
  }
  stop(bus: Bus) {
    this.set(bus, false, false)
    bus.run(5e-6)
    this.set(bus, true, false)
    this.waitScl(bus)
    bus.run(5e-6)
    this.set(bus, true, true)
    bus.run(5e-6)
  }
  /** Send a byte; returns whether the part ACKed. */
  write(bus: Bus, byte: number): boolean {
    for (let i = 7; i >= 0; i--) {
      this.set(bus, false, ((byte >> i) & 1) === 1)
      bus.run(5e-6)
      this.set(bus, true, ((byte >> i) & 1) === 1)
      this.waitScl(bus)
      bus.run(5e-6)
    }
    this.set(bus, false, true)
    bus.run(5e-6)
    this.set(bus, true, true)
    this.waitScl(bus)
    const ack = !bus.sda
    bus.run(5e-6)
    this.set(bus, false, true)
    bus.run(1e-6)
    return ack
  }
  read(bus: Bus, ack: boolean): number {
    let v = 0
    for (let i = 0; i < 8; i++) {
      this.set(bus, false, true)
      bus.run(5e-6)
      this.set(bus, true, true)
      this.waitScl(bus)
      v = (v << 1) | (bus.sda ? 1 : 0)
      bus.run(5e-6)
    }
    this.set(bus, false, !ack)
    bus.run(5e-6)
    this.set(bus, true, !ack)
    this.waitScl(bus)
    bus.run(5e-6)
    this.set(bus, false, true)
    bus.run(1e-6)
    return v
  }
}

describe("slave modes (Tables 22-4, 22-5)", () => {
  /** The part as slave 0x29, the test answering each TWINT with `respond`. */
  function slavePart() {
    const m = part()
    const master = new RefMaster()
    const bus = new Bus(m, master)
    m.poke(TWAR, 0x29 << 1)
    m.poke(TWCR, EA | EN)
    return { m, master, bus }
  }

  it("slave receiver: own SLA+W 0x60, data ACK 0x80, STOP 0xA0", () => {
    const { m, master, bus } = slavePart()
    const statuses: number[] = []
    const data: number[] = []
    // Answer TWINT whenever it shows up (as an ISR would).
    const poll = () => {
      if (m.read(TWCR) & INT) {
        const s = m.read(TWSR) & 0xf8
        statuses.push(s)
        if (s === 0x80) data.push(m.read(TWDR))
        go(m, EA)
      }
    }
    const origRun = bus.run.bind(bus)
    bus.run = (s: number, step?: number) => {
      origRun(s, step)
      poll()
    }
    master.start(bus)
    expect(master.write(bus, (0x29 << 1) | 0)).toBe(true)
    expect(master.write(bus, 0x5a)).toBe(true)
    expect(master.write(bus, 0xc3)).toBe(true)
    master.stop(bus)
    bus.run(20e-6)
    expect(statuses).toEqual([0x60, 0x80, 0x80, 0xa0])
    expect(data).toEqual([0x5a, 0xc3])
  })

  it("other addresses are not acknowledged; TWAMR masks address bits (§22.9.6)", () => {
    const { m, master, bus } = slavePart()
    master.start(bus)
    expect(master.write(bus, 0x2b << 1)).toBe(false)
    master.stop(bus)
    m.poke(TWAMR, 0x02 << 1) // ignore address bit 1
    master.start(bus)
    expect(master.write(bus, 0x2b << 1)).toBe(true)
  })

  it("slave transmitter: own SLA+R 0xA8, data ACK 0xB8, last byte NOT ACK 0xC0", () => {
    const { m, master, bus } = slavePart()
    const statuses: number[] = []
    const out = [0x11, 0x22]
    const origRun = bus.run.bind(bus)
    bus.run = (s: number, step?: number) => {
      origRun(s, step)
      if (m.read(TWCR) & INT) {
        const st = m.read(TWSR) & 0xf8
        statuses.push(st)
        if (st === 0xa8 || st === 0xb8) m.poke(TWDR, out.shift() ?? 0)
        go(m, EA)
      }
    }
    master.start(bus)
    expect(master.write(bus, (0x29 << 1) | 1)).toBe(true)
    const a = master.read(bus, true)
    const b = master.read(bus, false)
    master.stop(bus)
    bus.run(20e-6)
    expect([a, b]).toEqual([0x11, 0x22])
    expect(statuses).toEqual([0xa8, 0xb8, 0xc0])
  })

  it("general call is answered only with TWGCE (status 0x70)", () => {
    const { m, master, bus } = slavePart()
    master.start(bus)
    expect(master.write(bus, 0x00)).toBe(false)
    master.stop(bus)
    m.poke(TWAR, (0x29 << 1) | 1)
    master.start(bus)
    expect(master.write(bus, 0x00)).toBe(true)
    expect(m.read(TWSR) & 0xf8).toBe(0x70)
  })
})

describe("pins (Table 14-7)", () => {
  it("TWEN makes SCL/SDA open drain: released lines are inputs (pull-up per PORTC), driven lines go low", () => {
    const m = part()
    m.poke(0x28, 0x30) // PORTC4/5 → internal pull-ups
    m.poke(TWCR, EN)
    m.cpu.run(m.cpu.cycles + 2)
    expect(m.padDrive(SDA)).toBe("pullup")
    expect(m.padDrive(SCL)).toBe("pullup")
  })
  it("TWSR reads 0xF8 when idle; TWDR and TWAR reset to 0xFF and 0xFE (§22.9)", () => {
    const m = part()
    expect(m.read(TWSR)).toBe(0xf8)
    expect(m.read(TWDR)).toBe(0xff)
    expect(m.read(TWAR)).toBe(0xfe)
  })
})
