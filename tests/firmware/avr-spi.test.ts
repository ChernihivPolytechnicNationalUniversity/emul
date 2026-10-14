/**
 * ATmega328P SPI against DS40002061B §19: SCK rates (Table 19-5), the four data modes
 * (Table 19-2, Figures 19-3/19-4), data order, SPIF/WCOL and how they clear (§19.5.2), the
 * master's SS input (§19.3.2), slave reception and transmission (§19.2, §19.3.1), and the pin
 * directions SPI forces (Table 19-1).
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"

const SPCR = 0x4c
const SPSR = 0x4d
const SPDR = 0x4e
const DDRB = 0x24
const PORTB = 0x25
const SS = { port: 1, pin: 2 }
const MOSI = { port: 1, pin: 3 }
const MISO = { port: 1, pin: 4 }
const SCK = { port: 1, pin: 5 }
const HZ = 16e6
const key = (p: { port: number; pin: number }) => p.port * 16 + p.pin

function part(wired: { port: number; pin: number }[] = []): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { low: 0xff, high: 0xd9, extended: 0xfd, lock: 0xff }
  m.setClockFeed({ hz: HZ, kind: "crystal" })
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.setWiredPads(wired.map(key))
  for (const p of wired) m.setPad(p, true)
  m.runUntil(0.07)
  for (const p of [SS, MOSI, MISO, SCK]) m.digitalWatch.add(key(p))
  return m
}

/** Master on: SS, MOSI, SCK outputs (SS high), the given SPCR bits besides SPE|MSTR. */
function master(m: AvrMcu, spcr: number, spi2x = false) {
  m.poke(DDRB, 0x2c)
  m.poke(PORTB, 0x04)
  m.poke(SPSR, spi2x ? 1 : 0)
  m.poke(SPCR, 0x50 | spcr)
}

const edgesOf = (m: AvrMcu, p: { port: number; pin: number }) => m.digitalOut.filter((e) => e.pad.port === p.port && e.pad.pin === p.pin)
const levelAt = (edges: { level: boolean | null; time: number }[], t: number, initial: boolean) => {
  let l = initial
  for (const e of edges) if (e.time <= t) l = e.level === true
  return l
}

describe("master SCK rate (Table 19-5)", () => {
  const rows: [number, boolean, number][] = [
    [0, false, 4],
    [1, false, 16],
    [2, false, 64],
    [3, false, 128],
    [0, true, 2],
    [1, true, 8],
    [2, true, 32],
    [3, true, 64],
  ]
  it.each(rows)("SPR = %i, SPI2X = %s: SCK = fosc/%i", (spr, spi2x, div) => {
    const m = part()
    master(m, spr, spi2x)
    m.digitalOut.length = 0
    m.poke(SPDR, 0x00)
    m.runUntil(m.time + (20 * div) / HZ)
    const sck = edgesOf(m, SCK)
    expect(sck).toHaveLength(16)
    expect(sck[2].time - sck[0].time).toBeCloseTo(div / HZ, 12)
    expect(m.read(SPSR) & 0x80).toBe(0x80)
  })
})

describe("data modes (Table 19-2, Figures 19-3 and 19-4)", () => {
  it.each([0, 1, 2, 3])("mode %i: MOSI is stable at every sampling edge and carries the byte MSB first", (mode) => {
    const m = part()
    const cpol = (mode >> 1) & 1
    const cpha = mode & 1
    master(m, (cpol << 3) | (cpha << 2) | 1)
    m.digitalOut.length = 0
    const startLevel = m.padDrive(MOSI) === "high"
    m.poke(SPDR, 0xb4)
    m.runUntil(m.time + (20 * 16) / HZ)
    const sck = edgesOf(m, SCK)
    const mosi = edgesOf(m, MOSI)
    expect(sck).toHaveLength(16)
    // Idle level is CPOL; the sampling edge is the leading one for CPHA = 0, the trailing one for CPHA = 1.
    expect(sck[0].level).toBe(cpol === 0)
    const sampling = sck.filter((_, i) => i % 2 === cpha)
    const bits = sampling.map((e) => (levelAt(mosi, e.time, startLevel) ? 1 : 0))
    expect(bits).toEqual([1, 0, 1, 1, 0, 1, 0, 0])
    // No MOSI change coincides with a sampling edge.
    for (const s of sampling) for (const e of mosi) expect(Math.abs(e.time - s.time)).toBeGreaterThan(0.4 / HZ)
  })

  it("DORD = 1 sends the LSB first", () => {
    const m = part()
    master(m, 0x20 | 1)
    m.digitalOut.length = 0
    const startLevel = m.padDrive(MOSI) === "high"
    m.poke(SPDR, 0xb4)
    m.runUntil(m.time + (20 * 16) / HZ)
    const sampling = edgesOf(m, SCK).filter((_, i) => i % 2 === 0)
    const bits = sampling.map((e) => (levelAt(edgesOf(m, MOSI), e.time, startLevel) ? 1 : 0))
    expect(bits).toEqual([0, 0, 1, 0, 1, 1, 0, 1])
  })
})

describe("flags (§19.5.2)", () => {
  it("SPIF clears by reading SPSR with SPIF set and then accessing SPDR", () => {
    const m = part()
    master(m, 0)
    m.poke(SPDR, 0x12)
    m.runUntil(m.time + 64 / HZ)
    expect(m.read(SPSR) & 0x80).toBe(0x80)
    m.read(SPDR)
    expect(m.read(SPSR) & 0x80).toBe(0)
  })

  it("SPDR written mid-transfer sets WCOL and the byte is not sent", () => {
    const m = part()
    master(m, 3) // fosc/128: a long transfer
    m.digitalOut.length = 0
    m.poke(SPDR, 0x00)
    m.cpu.run(m.cpu.cycles + 50)
    m.poke(SPDR, 0xff)
    expect(m.read(SPSR) & 0x40).toBe(0x40)
    m.runUntil(m.time + (10 * 128) / HZ)
    expect(edgesOf(m, MOSI).filter((e) => e.level === true)).toHaveLength(0)
  })

  it("master receives MISO on the sampling edges", () => {
    const m = part([MISO])
    m.setPad(MISO, true)
    master(m, 0)
    m.poke(SPDR, 0x00)
    m.runUntil(m.time + 64 / HZ)
    m.read(SPSR)
    expect(m.read(SPDR)).toBe(0xff)
  })
})

describe("SS (§19.3)", () => {
  it("a master whose SS is an input pulled low turns slave and sets SPIF (§19.3.2)", () => {
    const m = part([SS])
    m.setPad(SS, true)
    m.poke(DDRB, 0x28) // SS input
    m.poke(SPCR, 0x50)
    expect(m.read(SPCR) & 0x10).toBe(0x10)
    m.setPad(SS, false)
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(SPCR) & 0x10).toBe(0)
    expect(m.read(SPSR) & 0x80).toBe(0x80)
  })

  it("an SS output does not affect the master", () => {
    const m = part()
    master(m, 0)
    m.poke(PORTB, 0x00)
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(SPCR) & 0x10).toBe(0x10)
  })
})

describe("slave (§19.2, §19.3.1, Table 19-1)", () => {
  /** Clock one byte into a mode-0 slave from outside at `period` per bit; returns MISO as sampled by us. */
  function clockIn(m: AvrMcu, byte: number, period: number) {
    let t = m.time + 2e-6
    m.runUntil(t)
    m.setPadAt(SS, false, t)
    const out: number[] = []
    for (let i = 7; i >= 0; i--) {
      t += period / 2
      m.runUntil(t)
      m.setPadAt(MOSI, ((byte >> i) & 1) === 1, t)
      t += period / 2
      m.runUntil(t)
      m.setPadAt(SCK, true, t) // sample (rising, mode 0)
      out.push(m.padDrive(MISO) === "high" ? 1 : 0)
      t += period / 2
      m.runUntil(t)
      m.setPadAt(SCK, false, t)
    }
    t += period
    m.runUntil(t)
    return out
  }

  it("receives a byte clocked in by a master, sets SPIF, and shifts SPDR out on MISO", () => {
    const m = part([SS, MOSI, SCK])
    m.setPad(SCK, false)
    m.poke(DDRB, 0x10) // MISO output
    m.poke(SPCR, 0x40) // SPE, slave, mode 0
    m.poke(SPDR, 0x96)
    const miso = clockIn(m, 0x3c, 2e-6)
    expect(m.read(SPSR) & 0x80).toBe(0x80)
    expect(m.read(SPDR)).toBe(0x3c)
    expect(miso).toEqual([1, 0, 0, 1, 0, 1, 1, 0])
  })

  it("SCK, MOSI and SS are inputs in slave mode whatever DDRB says; MISO is the user's (Table 19-1)", () => {
    const m = part()
    m.poke(DDRB, 0x3c)
    m.poke(SPCR, 0x40)
    m.cpu.run(m.cpu.cycles + 2)
    expect(["high", "low"]).not.toContain(m.padDrive(SCK))
    expect(["high", "low"]).not.toContain(m.padDrive(MOSI))
    expect(["high", "low"]).not.toContain(m.padDrive(SS))
  })

  it("SS high in the middle of a byte resets the slave: a whole new byte is needed (§19.3.1)", () => {
    const m = part([SS, MOSI, SCK])
    m.setPad(SCK, false)
    m.poke(SPCR, 0x40)
    let t = m.time + 2e-6
    m.runUntil(t)
    m.setPadAt(SS, false, t)
    for (let i = 0; i < 4; i++) {
      t += 1e-6
      m.runUntil(t)
      m.setPadAt(SCK, true, t)
      t += 1e-6
      m.runUntil(t)
      m.setPadAt(SCK, false, t)
    }
    t += 1e-6
    m.runUntil(t)
    m.setPadAt(SS, true, t)
    m.runUntil(t + 1e-6)
    clockIn(m, 0x81, 2e-6)
    expect(m.read(SPSR) & 0x80).toBe(0x80)
    expect(m.read(SPDR)).toBe(0x81)
  })
})
