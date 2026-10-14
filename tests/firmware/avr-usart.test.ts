/**
 * ATmega328P USART0 in asynchronous mode against DS40002061B §20: baud rates and their errors
 * (Table 20-1 equations, Table 20-7 at 16 MHz), frame formats and parity (§20.4, Figure 20-4),
 * transmitter flags (§20.6.3), receiver sampling and majority vote (§20.8, Figures 20-5/20-6),
 * error flags and the two-character FIFO (§20.7.4), the receiver's tolerance to baud rate
 * error (Table 20-2), multi-processor mode (§20.9).
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"

const UCSR0A = 0xc0
const UCSR0B = 0xc1
const UCSR0C = 0xc2
const UBRR0L = 0xc4
const UBRR0H = 0xc5
const UDR0 = 0xc6
const TXD = { port: 3, pin: 1 }
const RXD = { port: 3, pin: 0 }
const HZ = 16e6

function part(): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { low: 0xff, high: 0xd9, extended: 0xfd, lock: 0xff }
  m.setClockFeed({ hz: HZ, kind: "crystal" })
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.setWiredPads([RXD.port * 16 + RXD.pin])
  m.setPad(RXD, true)
  m.runUntil(0.07)
  m.digitalWatch.add(TXD.port * 16 + TXD.pin)
  return m
}

function setup(m: AvrMcu, ubrr: number, opts: { u2x?: boolean; c?: number; b?: number } = {}) {
  m.poke(UBRR0H, ubrr >> 8)
  m.poke(UBRR0L, ubrr & 0xff)
  m.poke(UCSR0A, opts.u2x ? 0x02 : 0)
  m.poke(UCSR0C, opts.c ?? 0x06) // 8N1
  m.poke(UCSR0B, opts.b ?? 0x18) // RXEN, TXEN
}

/** TXD edges from now over `seconds`. */
function txEdges(m: AvrMcu, seconds: number) {
  m.digitalOut.length = 0
  m.runUntil(m.time + seconds)
  return m.digitalOut.filter((e) => e.pad.port === TXD.port && e.pad.pin === TXD.pin)
}

/** Decode one frame from TXD edges: the line level at the middle of each bit after the start edge. */
function bitsOf(edges: { level: boolean | null; time: number }[], bitTime: number, count: number): number[] {
  const start = edges.find((e) => e.level === false)!.time
  const levelAt = (t: number) => {
    let level = true
    for (const e of edges) if (e.time <= t) level = e.level !== false
    return level ? 1 : 0
  }
  return Array.from({ length: count }, (_, i) => levelAt(start + (i + 0.5) * bitTime))
}

const byteBits = (v: number, n = 8) => Array.from({ length: n }, (_, i) => (v >> i) & 1)
const parity = (bits: number[], odd: boolean) => (bits.reduce((a, b) => a ^ b, 0) ^ (odd ? 1 : 0))

/** Run with RXD driven by a frame starting `lead` seconds from now, until the frame is over. */
function receive(m: AvrMcu, baud: number, bits: number[], lead = 20e-6) {
  // Exact-time edges are delivered as the core reaches them: queue them, then run past the frame.
  const t0 = m.time + lead
  const edges: { t: number; level: boolean }[] = []
  let t = t0
  let prev = 1
  for (const b of [0, ...bits, 1]) {
    if (b !== prev) edges.push({ t, level: b === 1 })
    prev = b
    t += 1 / baud
  }
  for (const e of edges) {
    m.runUntil(e.t)
    m.setPadAt(RXD, e.level, e.t)
  }
  m.runUntil(t + 2 / baud)
}

describe("baud rate generator (Table 20-1, Table 20-7 at fosc = 16 MHz)", () => {
  const rows: [string, number, boolean, number][] = [
    // [nominal, UBRR, U2X, table error %]
    ["9600", 103, false, 0.2],
    ["57.6k", 16, false, 2.1],
    ["115.2k", 8, false, -3.5],
    ["115.2k", 16, true, 2.1],
    ["250k", 3, false, 0.0],
    ["0.5M", 3, true, 0.0],
  ]
  it.each(rows)("%s with UBRR = %i, U2X = %s: bit time gives the table's %f % error", (nominal, ubrr, u2x, err) => {
    const m = part()
    setup(m, ubrr, { u2x })
    const want = { "9600": 9600, "57.6k": 57600, "115.2k": 115200, "250k": 250000, "0.5M": 500000 }[nominal]!
    m.poke(UDR0, 0x55)
    const bit = (u2x ? 8 : 16) * (ubrr + 1) / HZ
    const e = txEdges(m, 12 * bit)
    // 0x55 8N1: start + alternating bits: ten edges one bit apart.
    expect(e.length).toBeGreaterThanOrEqual(9)
    const measured = (e[e.length - 1].time - e[0].time) / (e.length - 1)
    expect(measured).toBeCloseTo(bit, 12)
    const error = (1 / measured / want - 1) * 100
    expect(Math.round(error * 10) / 10).toBeCloseTo(err, 5)
  })
})

describe("frames and flags (§20.4, §20.6)", () => {
  it("8E2: start, data LSB first, even parity, two stop bits (Figure 20-4, §20.4.1)", () => {
    const m = part()
    setup(m, 15, { c: 0x2e }) // UPM = 10 (even), USBS = 1, UCSZ = 011
    m.poke(UDR0, 0xa7)
    const bit = 16 * 16 / HZ
    const bits = bitsOf(txEdges(m, 14 * bit), bit, 12)
    const data = byteBits(0xa7)
    expect(bits).toEqual([0, ...data, parity(data, false), 1, 1])
  })

  it("5O1: five data bits, odd parity; the upper bits written to UDR0 are ignored (§20.6.1)", () => {
    const m = part()
    setup(m, 15, { c: 0x30 }) // UPM = 11 (odd), UCSZ = 000
    m.poke(UDR0, 0xf3)
    const bit = 16 * 16 / HZ
    const bits = bitsOf(txEdges(m, 10 * bit), bit, 8)
    const data = byteBits(0x13, 5)
    expect(bits).toEqual([0, ...data, parity(data, true), 1])
  })

  it("9-bit characters take the ninth bit from TXB8 (§20.6.2)", () => {
    const m = part()
    setup(m, 15, { c: 0x06, b: 0x1d }) // UCSZ2 + TXB8
    m.poke(UDR0, 0x00)
    const bit = 16 * 16 / HZ
    const bits = bitsOf(txEdges(m, 12 * bit), bit, 11)
    expect(bits).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1])
  })

  it("UDRE clears when UDR0 is written and sets when the byte moves to the shift register; TXC after the last stop bit (§20.6.3)", () => {
    const m = part()
    setup(m, 15)
    expect(m.read(UCSR0A) & 0x60).toBe(0x20) // UDRE set, TXC clear
    m.poke(UDR0, 0x41)
    // The shift register is idle, so the byte moves within one bit time and UDRE comes back.
    m.cpu.run(m.cpu.cycles + 16 * 16 + 2)
    expect(m.read(UCSR0A) & 0x20).toBe(0x20)
    expect(m.read(UCSR0A) & 0x40).toBe(0)
    m.cpu.run(m.cpu.cycles + 11 * 16 * 16)
    expect(m.read(UCSR0A) & 0x40).toBe(0x40)
    m.poke(UCSR0A, 0x40) // TXC clears by writing one
    expect(m.read(UCSR0A) & 0x40).toBe(0)
  })

  it("two bytes written back to back go out without a gap between the frames", () => {
    const m = part()
    setup(m, 15)
    m.poke(UDR0, 0x00)
    m.poke(UDR0, 0x00)
    const bit = 16 * 16 / HZ
    const e = txEdges(m, 25 * bit)
    // 0x00 8N1 twice: low 9 bits, high 1 (stop), low 9, high: four edges, the stop exactly one bit long.
    expect(e.map((x) => x.level)).toEqual([false, true, false, true])
    expect(e[2].time - e[1].time).toBeCloseTo(bit, 12)
  })

  it("TXEN hands PD1 to the transmitter: output, idle high (Table 14-11)", () => {
    const m = part()
    expect(m.padDrive(TXD)).toBe(null)
    setup(m, 15)
    m.cpu.run(m.cpu.cycles + 2)
    expect(m.padDrive(TXD)).toBe("high")
  })
})

describe("receiver (§20.7, §20.8)", () => {
  it("receives 8N1 at 9600 (UBRR 103): RXC set, UDR0 gives the byte, RXC clears", () => {
    const m = part()
    setup(m, 103)
    receive(m, 9600, [...byteBits(0x5a), 1])
    expect(m.read(UCSR0A) & 0x80).toBe(0x80)
    expect(m.read(UCSR0A) & 0x1c).toBe(0)
    expect(m.read(UDR0)).toBe(0x5a)
    expect(m.read(UCSR0A) & 0x80).toBe(0)
  })

  it("a zero stop bit sets FE (§20.7.4)", () => {
    const m = part()
    setup(m, 103)
    receive(m, 9600, [...byteBits(0x33), 0])
    expect(m.read(UCSR0A) & 0x10).toBe(0x10)
    expect(m.read(UDR0)).toBe(0x33)
  })

  it("a wrong parity bit sets UPE (§20.7.5)", () => {
    const m = part()
    setup(m, 103, { c: 0x26 }) // even parity
    const data = byteBits(0x07)
    receive(m, 9600, [...data, parity(data, false) ^ 1, 1])
    expect(m.read(UCSR0A) & 0x04).toBe(0x04)
  })

  it("buffer of two plus the shift register: a fourth frame is lost and DOR shows before the data runs out (§20.7.4)", () => {
    // Which buffered frame carries DOR is not spelled out; what is: frames 1–3 are kept, the
    // fourth is lost, and DOR tells of it while frames remain to be read.
    const m = part()
    setup(m, 103)
    for (const b of [1, 2, 3, 4]) receive(m, 9600, [...byteBits(b), 1])
    const got: number[] = []
    let dor = false
    while (m.read(UCSR0A) & 0x80) {
      dor ||= (m.read(UCSR0A) & 0x08) !== 0
      got.push(m.read(UDR0))
    }
    expect(got).toEqual([1, 2, 3])
    expect(dor).toBe(true)
  })

  it("majority vote: a glitch on one of the three centre samples does not change the bit (§20.8.2)", () => {
    const m = part()
    setup(m, 103)
    const bit = 1 / 9600
    const t0 = m.time + 20e-6
    // 0xFF: start bit, then a high line; a 1/16-bit low glitch at the centre of bit 3.
    m.runUntil(t0)
    m.setPadAt(RXD, false, t0)
    m.runUntil(t0 + bit)
    m.setPadAt(RXD, true, t0 + bit)
    const g = t0 + 4.5 * bit - bit / 32
    m.runUntil(g)
    m.setPadAt(RXD, false, g)
    m.runUntil(g + bit / 16)
    m.setPadAt(RXD, true, g + bit / 16)
    m.runUntil(t0 + 12 * bit)
    expect(m.read(UDR0)).toBe(0xff)
  })

  it("a low spike shorter than half a bit is rejected as a start bit (§20.8.1)", () => {
    const m = part()
    setup(m, 103)
    const bit = 1 / 9600
    const t0 = m.time + 20e-6
    m.runUntil(t0)
    m.setPadAt(RXD, false, t0)
    m.runUntil(t0 + bit / 4)
    m.setPadAt(RXD, true, t0 + bit / 4)
    m.runUntil(t0 + 12 * bit)
    expect(m.read(UCSR0A) & 0x80).toBe(0)
  })

  it("tolerates the data rate error Table 20-2 allows for 8 data bits (−4.5…+4.5 %), not much more", () => {
    const ok = (ratio: number) => {
      // UBRR 103 at 16 MHz is 9615 bps; the sender runs at ratio × that.
      const m = part()
      setup(m, 103)
      const rx = HZ / 16 / 104
      receive(m, rx * ratio, [...byteBits(0x81), 1])
      const a = m.read(UCSR0A)
      return (a & 0x80) !== 0 && (a & 0x10) === 0 && m.read(UDR0) === 0x81
    }
    expect(ok(0.96)).toBe(true)
    expect(ok(1.04)).toBe(true)
    expect(ok(0.9)).toBe(false)
    expect(ok(1.1)).toBe(false)
  })

  it("disabling the receiver flushes the buffer (§20.7.7)", () => {
    const m = part()
    setup(m, 103)
    receive(m, 9600, [...byteBits(9), 1])
    expect(m.read(UCSR0A) & 0x80).toBe(0x80)
    m.poke(UCSR0B, 0x08)
    expect(m.read(UCSR0A) & 0x80).toBe(0)
  })

  it("multi-processor mode drops data frames, keeps address frames (9-bit, ninth bit = 1) (§20.9)", () => {
    const m = part()
    setup(m, 103, { c: 0x06, b: 0x1c })
    m.poke(UCSR0A, 0x01) // MPCM
    receive(m, 9600, [...byteBits(0x10), 0, 1]) // data frame
    expect(m.read(UCSR0A) & 0x80).toBe(0)
    receive(m, 9600, [...byteBits(0x22), 1, 1]) // address frame
    expect(m.read(UCSR0A) & 0x80).toBe(0x80)
    expect(m.read(UCSR0B) & 0x02).toBe(0x02) // RXB8
    expect(m.read(UDR0)).toBe(0x22)
  })
})
