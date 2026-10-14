/**
 * ATmega328P USART0 in synchronous mode and in Master SPI mode against DS40002061B §20.3–20.4
 * and §21: XCK as output (master: fosc/(2·(UBRR+1)), Table 20-1) or input (slave, through a
 * two-cycle synchronizer, §20.3.3); data changed on one XCK edge and sampled on the other as
 * UCPOL selects (Figure 20-3, Table 20-12); MSPIM's four SPI modes, data order, double-buffered
 * transmitter and receive buffer with the error flags reading zero (Tables 21-2, §21.6); the
 * XCK pin is driven only when DDRD4 makes it an output (Table 14-10: PVOE = UMSEL).
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
const DDRD = 0x2a
const RXD = { port: 3, pin: 0 }
const TXD = { port: 3, pin: 1 }
const XCK = { port: 3, pin: 4 }
const HZ = 16e6
const CYCLE = 1 / HZ
const key = (p: { port: number; pin: number }) => p.port * 16 + p.pin

function part(wired: { port: number; pin: number }[] = [RXD]): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { low: 0xff, high: 0xd9, extended: 0xfd, lock: 0xff }
  m.setClockFeed({ hz: HZ, kind: "crystal" })
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.setWiredPads(wired.map(key))
  for (const p of wired) m.setPad(p, p === XCK ? false : true)
  m.runUntil(0.07)
  m.digitalWatch.add(key(TXD))
  m.digitalWatch.add(key(XCK))
  return m
}

type Edge = { pad: { port: number; pin: number }; level: boolean | null; time: number }
const of = (edges: Edge[], p: { port: number; pin: number }) => edges.filter((e) => e.pad.port === p.port && e.pad.pin === p.pin)
/** Level of a pad just before time t, from its edges (`initial` before the first). */
function levelBefore(edges: Edge[], t: number, initial: boolean): boolean {
  let level = initial
  for (const e of edges) if (e.time < t - CYCLE / 4) level = e.level !== false
  return level
}
/** Run `seconds` and return every watched edge. */
function record(m: AvrMcu, seconds: number): Edge[] {
  m.digitalOut.length = 0
  m.runUntil(m.time + seconds)
  return [...m.digitalOut]
}

const msbFirst = (v: number) => Array.from({ length: 8 }, (_, i) => (v >> (7 - i)) & 1)
const lsbFirst = (v: number, n = 8) => Array.from({ length: n }, (_, i) => (v >> i) & 1)

describe("USART in Master SPI mode (§21)", () => {
  /** MSPIM with XCK an output: UBRR is written after TXEN, as §21.5.1 asks. */
  function mspim(m: AvrMcu, c: number, ubrr: number, b = 0x18) {
    m.poke(UBRR0H, 0)
    m.poke(UBRR0L, 0)
    m.poke(DDRD, 0x10)
    m.poke(UCSR0C, 0xc0 | c)
    m.poke(UCSR0B, b)
    m.poke(UBRR0H, ubrr >> 8)
    m.poke(UBRR0L, ubrr & 0xff)
  }

  it.each([
    [0, false, "rising"],
    [1, false, "falling"],
    [2, true, "falling"],
    [3, true, "rising"],
  ] as const)("SPI mode %i: XCK idles %s, eight clocks, TxD valid at each %s sample edge, MSB first (Table 21-2)", (mode, idleHigh, sampleEdge) => {
    const m = part()
    const ucpha = mode & 1
    const ucpol = mode >> 1
    mspim(m, (ucpha << 1) | ucpol, 3) // fosc/8 = 2 MHz
    m.runUntil(m.time + 2e-6)
    expect(m.padDrive(XCK)).toBe(idleHigh ? "high" : "low")
    m.poke(UDR0, 0xa5)
    const e = record(m, 10e-6)
    const xck = of(e, XCK)
    const samples = xck.filter((x) => x.level === (sampleEdge === "rising"))
    expect(samples).toHaveLength(8)
    expect(xck).toHaveLength(16)
    // 2·(UBRR+1) cycles per bit.
    expect(samples[1].time - samples[0].time).toBeCloseTo(8 * CYCLE, 12)
    const tx = of(e, TXD)
    expect(samples.map((s) => (levelBefore(tx, s.time, true) ? 1 : 0))).toEqual(msbFirst(0xa5))
    expect(m.padDrive(XCK)).toBe(idleHigh ? "high" : "low")
    expect(m.read(UCSR0A) & 0x40).toBe(0x40) // TXC
  })

  it("UDORD = 1 sends LSB first", () => {
    const m = part()
    mspim(m, 0x04, 3)
    m.poke(UDR0, 0x31)
    const e = record(m, 10e-6)
    const samples = of(e, XCK).filter((x) => x.level === true)
    expect(samples.map((s) => (levelBefore(of(e, TXD), s.time, true) ? 1 : 0))).toEqual(lsbFirst(0x31))
  })

  it("baud rate fosc/(2·(UBRR+1)) (Table 21-1): UBRR = 7 gives 1 MHz", () => {
    const m = part()
    mspim(m, 0, 7)
    m.poke(UDR0, 0xff)
    const rises = of(record(m, 20e-6), XCK).filter((x) => x.level === true)
    expect(rises).toHaveLength(8)
    expect(rises[7].time - rises[0].time).toBeCloseTo(7e-6, 12)
  })

  it("the transmitter is double buffered: a second byte written while the first shifts follows without a gap, TXC after both (§21.7)", () => {
    const m = part()
    mspim(m, 0, 3)
    m.poke(UDR0, 0x0f)
    expect(m.read(UCSR0A) & 0x20).toBe(0x20) // UDRE: the byte moved on into the shift register
    m.poke(UDR0, 0xf0)
    m.runUntil(m.time + 3e-6)
    expect(m.read(UCSR0A) & 0x40).toBe(0)
    const e = record(m, 10e-6)
    const rises = of(e, XCK).filter((x) => x.level === true)
    expect(rises.length).toBeGreaterThan(8)
    const all = [...rises]
    for (let i = 1; i < all.length; i++) expect(all[i].time - all[i - 1].time).toBeCloseTo(8 * CYCLE, 12)
    expect(m.read(UCSR0A) & 0x40).toBe(0x40)
  })

  it("receives on RxD at the sample edge, as an SPI slave drives it; FE, DOR and UPE read zero (§21.6)", () => {
    const m = part()
    mspim(m, 0, 7) // mode 0: slave sets up on falling edges (and before the first clock)
    const send = msbFirst(0x6c)
    let n = 0
    m.setPad(RXD, send[n++] === 1)
    m.poke(UDR0, 0x00)
    let xck = m.padDrive(XCK)
    for (let i = 0; i < 400; i++) {
      m.runUntil(m.time + CYCLE)
      const now = m.padDrive(XCK)
      if (xck === "high" && now === "low" && n < 8) m.setPad(RXD, send[n++] === 1)
      xck = now
    }
    expect(m.read(UCSR0A) & 0x9c).toBe(0x80)
    expect(m.read(UDR0)).toBe(0x6c)
    expect(m.read(UCSR0A) & 0x80).toBe(0)
  })

  it("without DDRD4 the XCK clock does not reach the pin (Table 14-10: DDOE = 0)", () => {
    const m = part()
    mspim(m, 0, 3)
    m.poke(DDRD, 0x00)
    m.poke(UDR0, 0x55)
    const e = record(m, 10e-6)
    expect(of(e, XCK)).toHaveLength(0)
    expect(m.padDrive(XCK)).toBe(null)
  })
})

describe("USART in synchronous mode (§20.3.4)", () => {
  it("master, UCPOL = 0: XCK = fosc/(2·(UBRR+1)); TxD changes on rising edges and is valid at the falling ones (Figure 20-3)", () => {
    const m = part()
    m.poke(DDRD, 0x10)
    m.poke(UBRR0L, 7) // 1 MHz
    m.poke(UCSR0C, 0x46) // UMSEL = 01, 8N1, UCPOL = 0
    m.poke(UCSR0B, 0x08)
    m.runUntil(m.time + 5e-6)
    m.poke(UDR0, 0x55)
    const e = record(m, 20e-6)
    const xck = of(e, XCK)
    const rises = xck.filter((x) => x.level === true)
    expect(rises[1].time - rises[0].time).toBeCloseTo(1e-6, 12)
    const tx = of(e, TXD)
    // Every TxD change lands on a rising XCK edge.
    for (const t of tx) expect(rises.some((r) => Math.abs(r.time - t.time) < CYCLE / 2)).toBe(true)
    const start = tx.find((x) => x.level === false)!.time
    const falls = xck.filter((x) => x.level === false && x.time > start).slice(0, 10)
    expect(falls.map((f) => (levelBefore(tx, f.time + CYCLE / 2, true) ? 1 : 0))).toEqual([0, ...lsbFirst(0x55), 1])
  })

  it("master, UCPOL = 1: TxD changes on falling edges and is valid at the rising ones", () => {
    const m = part()
    m.poke(DDRD, 0x10)
    m.poke(UBRR0L, 7)
    m.poke(UCSR0C, 0x47)
    m.poke(UCSR0B, 0x08)
    m.runUntil(m.time + 5e-6)
    m.poke(UDR0, 0xa3)
    const e = record(m, 20e-6)
    const xck = of(e, XCK)
    const falls = xck.filter((x) => x.level === false)
    const tx = of(e, TXD)
    for (const t of tx) expect(falls.some((f) => Math.abs(f.time - t.time) < CYCLE / 2)).toBe(true)
    const start = tx.find((x) => x.level === false)!.time
    const rises = xck.filter((x) => x.level === true && x.time > start).slice(0, 10)
    expect(rises.map((r) => (levelBefore(tx, r.time + CYCLE / 2, true) ? 1 : 0))).toEqual([0, ...lsbFirst(0xa3), 1])
  })

  it("master receive: RxD sampled at the falling XCK edges, the frame framed by start and stop bits", () => {
    const m = part()
    m.poke(DDRD, 0x10)
    m.poke(UBRR0L, 7)
    m.poke(UCSR0C, 0x46)
    m.poke(UCSR0B, 0x10) // RXEN only: the master clock runs for the receiver too
    const frame = [1, 1, 0, ...lsbFirst(0x9e), 1, 1]
    let n = 0
    let xck = m.padDrive(XCK)
    for (let i = 0; i < 16 * 20; i++) {
      m.runUntil(m.time + CYCLE)
      const now = m.padDrive(XCK)
      if (xck === "low" && now === "high" && n < frame.length) m.setPad(RXD, frame[n++] === 1)
      xck = now
    }
    expect(n).toBe(frame.length)
    expect(m.read(UCSR0A) & 0x9c).toBe(0x80)
    expect(m.read(UDR0)).toBe(0x9e)
  })

  it("slave receive: an external XCK clocks the receiver, a missing stop bit sets FE", () => {
    const m = part([RXD, XCK])
    m.poke(UCSR0C, 0x46)
    m.poke(UCSR0B, 0x10)
    const clockFrame = (bits: number[]) => {
      // 250 kHz XCK: data set up while XCK is low, before the rising edge; sampled at the falling edge.
      for (const b of bits) {
        m.runUntil(m.time + 1e-6)
        m.setPad(RXD, b === 1)
        m.runUntil(m.time + 1e-6)
        m.setPad(XCK, true)
        m.runUntil(m.time + 2e-6)
        m.setPad(XCK, false)
      }
    }
    clockFrame([1, 0, ...lsbFirst(0x5a), 1, 1])
    expect(m.read(UCSR0A) & 0x9c).toBe(0x80)
    expect(m.read(UDR0)).toBe(0x5a)
    clockFrame([0, ...lsbFirst(0x11), 0, 1])
    expect(m.read(UCSR0A) & 0x90).toBe(0x90)
    expect(m.read(UDR0)).toBe(0x11)
  })

  it("slave transmit: TxD follows the rising XCK edge 2–3 cycles late through the synchronizer (§20.3.3)", () => {
    const m = part([RXD, XCK])
    m.poke(UCSR0C, 0x46)
    m.poke(UCSR0B, 0x08)
    m.poke(UDR0, 0x00)
    const rises: number[] = []
    for (let i = 0; i < 12; i++) {
      m.runUntil(m.time + 2e-6)
      rises.push(m.time)
      m.setPad(XCK, true)
      m.runUntil(m.time + 2e-6)
      m.setPad(XCK, false)
    }
    const tx = of(m.digitalOut, TXD)
    const fall = tx.find((x) => x.level === false)!
    const d = Math.min(...rises.map((r) => fall.time - r).filter((x) => x >= 0))
    expect(d).toBeGreaterThanOrEqual(2 * CYCLE - 1e-12)
    expect(d).toBeLessThanOrEqual(3 * CYCLE + 1e-12)
  })
})
