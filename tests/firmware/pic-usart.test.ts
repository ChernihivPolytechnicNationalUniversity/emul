/**
 * PIC16F628A USART against DS40044G §12 and DS33023A §18 (rows P3-073…P3-170, P9-123…P9-176 of
 * docs/pic16-checklist.md; decisions D24–D32 there). INTOSC 4 MHz: TCY = 1 µs, TOSC = 0.25 µs.
 */
import { describe, expect, it } from "vitest"
import { PIC16F628A, type PicProfile } from "@/mcu/pic/chip"
import type { PicMcu } from "@/mcu/pic/mcu"
import { createPic } from "@/mcu/pic/parts"
import * as A from "../lib/pic-asm"

const PORTB = 0x06
const INTCON = 0x0b
const PIR1 = 0x0c
const RCSTA = 0x18
const TXREG = 0x19
const RCREG = 0x1a
const OPTION = 0x81
const TRISB = 0x86
const PIE1 = 0x8c
const TXSTA = 0x98
const SPBRG = 0x99
const TXIF = 0x10
const RCIF = 0x20
// TXSTA bits (Register 12-1).
const CSRC = 0x80
const TX9 = 0x40
const TXEN = 0x20
const SYNC = 0x10
const BRGH = 0x04
const TRMT = 0x02
const TX9D = 0x01
// RCSTA bits (Register 12-2).
const SPEN = 0x80
const RX9 = 0x40
const SREN = 0x20
const CREN = 0x10
const ADEN = 0x08
const FERR = 0x04
const OERR = 0x02
const RX9D = 0x01
const CONFIG = 0x3e00 | 0x0100 | 0x20 | 0x08 | 0x10 // INTOSC I/O, no WDT/PWRT/BOR/LVP
const HS = 0x3e00 | 0x0100 | 0x20 | 0x08 | 0x02
const TCY = 1e-6
const RB = (pin: number) => ({ port: 1, pin })
const bank1 = (...body: number[][]) => A.prog(A.bsf(A.STATUS, A.RP0), ...body, A.bcf(A.STATUS, A.RP0))
const sled = (at: number, n = 200) => A.prog(...Array(n).fill(A.nop()), A.goto(at))
const nops = (n: number) => A.prog(...Array(n).fill(A.nop()))

/**
 * SPBRG at cycle 2 (its write lands at 2.75), TXSTA at 4 (4.75), RCSTA at 7 (7.75); `body` from cycle 8
 * on, then a NOP sled. Pull-ups off; RB1/RB2 inputs (TRISB = FFh after reset).
 */
function part(spbrg: number, txsta: number, rcsta: number, body: number[] = [], opts: { config?: number; hz?: number; chip?: PicProfile } = {}) {
  const m = createPic(opts.chip ?? PIC16F628A)
  if (opts.hz) m.setClockFeed({ hz: opts.hz, kind: "crystal" })
  const head = A.prog(bank1(A.movlw(spbrg), A.movwf(SPBRG & 0x7f), A.movlw(txsta), A.movwf(TXSTA & 0x7f)), A.movlw(rcsta), A.movwf(RCSTA))
  const prog = A.prog(head, body)
  m.program(A.prog(prog, sled(prog.length)), opts.config ?? CONFIG)
  return m
}
/** Edges a PORTB pad puts out, with their times in TCY. */
function watch(m: PicMcu, pin: number) {
  m.digitalWatch.add(16 + pin)
  const seen: { level: boolean | null; t: number }[] = []
  return () => {
    for (const d of m.digitalOut) if (d.pad.port === 1 && d.pad.pin === pin) seen.push({ level: d.level, t: d.time / TCY })
    const rest = m.digitalOut.filter((d) => !(d.pad.port === 1 && d.pad.pin === pin))
    m.digitalOut.splice(0, m.digitalOut.length, ...rest)
    return seen
  }
}
/** The level of a watched pad at t (TCY), `idle` before its first edge. */
const levelAt = (edges: { level: boolean | null; t: number }[], t: number, idle: boolean | null = null) => {
  let l = idle
  for (const e of edges) if (e.t <= t) l = e.level
  return l
}
/** Decode an async frame from the edges: start at the first falling edge after `from`, `bits` data bits, bit time `tb` TCY. */
function frame(edges: { level: boolean | null; t: number }[], tb: number, bits = 8, from = 0) {
  const start = edges.find((e, i) => e.t >= from && e.level === false && i > 0 && edges[i - 1].level === true)
  if (!start) return null
  let v = 0
  for (let k = 0; k < bits; k++) if (levelAt(edges, start.t + (k + 1.5) * tb)) v |= 1 << k
  const stop = levelAt(edges, start.t + (bits + 1.5) * tb)
  return { start: start.t, value: v, stop }
}
/** Queue an async frame on RB1 from time t0 (s), `tb` s per bit: start, data LSb first, stop. */
function send(m: PicMcu, t0: number, tb: number, value: number, bits = 8, stop = true) {
  const levels = [false]
  for (let k = 0; k < bits; k++) levels.push(((value >> k) & 1) === 1)
  levels.push(stop)
  levels.forEach((l, k) => m.setPadAt(RB(1), l, t0 + k * tb))
  if (!stop) m.setPadAt(RB(1), true, t0 + (bits + 2) * tb)
  else m.setPadAt(RB(1), true, t0 + (bits + 1) * tb)
}
function rxPart(spbrg: number, txsta: number, rcsta: number, body: number[] = []) {
  const m = part(spbrg, txsta, rcsta, body)
  m.setWiredPads([16 + 1])
  m.setPad(RB(1), true)
  return m
}

describe("USART registers (Register 12-1, 12-2, Table 12-2)", () => {
  it("reset values: TXSTA 0000 -010, RCSTA 0000 000x, SPBRG/TXREG/RCREG 00h; TXIF and RCIF clear (P3-076, P3-085, P3-094, D27)", () => {
    const m = createPic(PIC16F628A)
    m.program(A.prog(A.goto(0)), CONFIG)
    expect(m.peekFile(TXSTA)).toBe(0x02)
    expect(m.peekFile(RCSTA) & 0xfe).toBe(0x00)
    expect(m.peekFile(SPBRG)).toBe(0)
    expect(m.peekFile(TXREG)).toBe(0)
    expect(m.peekFile(RCREG)).toBe(0)
    expect(m.peekFile(PIR1) & (TXIF | RCIF)).toBe(0)
    expect(m.unmodelled.size).toBe(0)
  })

  it("TRMT, FERR, OERR, RX9D and TXSTA<3> are read-only; TXIF and RCIF cannot be written (P3-075, P3-084, P3-115, P3-129)", () => {
    const m = part(25, 0, 0)
    m.runUntil(10 * TCY)
    m.pokeFile(TXSTA, 0xff)
    expect(m.peekFile(TXSTA)).toBe(0xf7)
    m.pokeFile(TXSTA, 0x00)
    expect(m.peekFile(TXSTA)).toBe(0x02)
    m.pokeFile(RCSTA, 0xff)
    expect(m.peekFile(RCSTA) & 0x06).toBe(0)
    m.pokeFile(RCSTA, 0)
    m.pokeFile(PIR1, 0xff)
    expect(m.peekFile(PIR1) & (TXIF | RCIF)).toBe(0)
  })

  it("a reset clears TXSTA, RCSTA and SPBRG (Table 12-2)", () => {
    const m = part(25, TXEN | BRGH, SPEN | CREN)
    m.runUntil(20 * TCY)
    expect(m.peekFile(SPBRG)).toBe(25)
    m.setMclr(true)
    m.runUntil(m.time + 5 * TCY)
    m.setMclr(false)
    expect([m.peekFile(TXSTA), m.peekFile(RCSTA) & 0xfe, m.peekFile(SPBRG)]).toEqual([0x02, 0, 0])
  })
})

describe("baud rate generator (§12.1, Table 12-1)", () => {
  /** Bit time in TCY of a 0x00 frame (start + 8 zeros = one low stretch of 9 bits). */
  function bitTime(spbrg: number, brgh: boolean, hz?: number) {
    const m = part(spbrg, TXEN | (brgh ? BRGH : 0), SPEN, A.prog(A.clrf(TXREG)), hz ? { config: HS, hz } : {})
    const edges = watch(m, 2)
    const tcy = hz ? 4 / hz : TCY
    m.runUntil(2e-3 + 12 * 16 * (spbrg + 1) * tcy)
    const e = edges().filter((x) => x.level !== null)
    const fall = e.findIndex((x, i) => i > 0 && x.level === false && e[i - 1].level === true)
    // Times are in µs (t / TCY): back to TCY of this clock.
    return ((e[fall + 1].t - e[fall].t) * TCY) / tcy / 9
  }

  it("async BRGH = 0: FOSC/(64(X+1)); BRGH = 1: FOSC/(16(X+1)) (P3-096, P9-130)", () => {
    // In TCY: 16(X+1) and 4(X+1).
    for (const x of [0, 1, 25, 51]) {
      expect(bitTime(x, false)).toBeCloseTo(16 * (x + 1), 6)
      expect(bitTime(x, true)).toBeCloseTo(4 * (x + 1), 6)
    }
  })

  it("Example 12-1: FOSC 16 MHz, SPBRG 25, BRGH = 0 → 9615 baud (+0.16 %) (P3-097, P9-131)", () => {
    const tb = bitTime(25, false, 16e6) * (4 / 16e6)
    expect(1 / tb).toBeCloseTo(9615.38, 1)
  })

  it("Table 12-5 at 20 MHz, BRGH = 1: SPBRG 129 → 9615, SPBRG 10 → 113 636, SPBRG 0 → 1 250 000 (P3-107)", () => {
    for (const [x, baud] of [
      [129, 9615.38],
      [10, 113636.36],
      [0, 1250000],
    ]) {
      const tb = bitTime(x, true, 20e6) * (4 / 20e6)
      expect(1 / tb).toBeCloseTo(baud, 0)
    }
  })

  it("Table 12-4 at 4 MHz, BRGH = 0: SPBRG 25 → 2404 baud; HIGH (SPBRG 0) 62 500 (P3-105; D24)", () => {
    expect(1 / (bitTime(25, false) * TCY)).toBeCloseTo(2403.85, 1)
    expect(1 / (bitTime(0, false) * TCY)).toBeCloseTo(62500, 0)
  })
})

describe("asynchronous transmitter (§12.2.1, DS33023A §18.4.1)", () => {
  it("TXEN sets TXIF; a TXREG write clears it and the TSR load sets it one TCY later; TRMT is low for the whole frame (P3-114…P3-117, P9-145; D27)", () => {
    // SPBRG 0, BRGH = 1: 4 TCY a bit, ticks from 2.75. TXEN set at 9.75, TXREG written at 12.75, start bit at 14.75.
    const m = part(0, BRGH, SPEN, A.prog(bank1(A.bsf(TXSTA & 0x7f, 5)), A.movlw(0x55), A.movwf(TXREG)))
    m.runUntil(9 * TCY)
    expect(m.peekFile(PIR1) & TXIF).toBe(0)
    m.runUntil(11 * TCY)
    expect(m.peekFile(PIR1) & TXIF).toBe(TXIF)
    m.runUntil(13 * TCY)
    expect(m.peekFile(PIR1) & TXIF).toBe(0)
    expect(m.peekFile(TXSTA) & TRMT).toBe(0)
    m.runUntil(15 * TCY)
    expect(m.peekFile(PIR1) & TXIF).toBe(TXIF)
    m.runUntil(54 * TCY)
    expect(m.peekFile(TXSTA) & TRMT).toBe(0)
    m.runUntil(56 * TCY)
    expect(m.peekFile(TXSTA) & TRMT).toBe(TRMT)
  })

  it("a frame: start bit, 8 data bits LSb first, stop bit, at the BRG's bit clock (P3-109, P3-119, P9-136; D27)", () => {
    // SPBRG 25, BRGH = 1 at 4 MHz: 104 TCY a bit, ticks from the SPBRG write at 2.75.
    const m = part(25, TXEN | BRGH, SPEN, A.prog(A.movlw(0xa7), A.movwf(TXREG)))
    const edges = watch(m, 2)
    m.runUntil(1300 * TCY)
    const e = edges()
    expect(e[0].level).toBe(true) // TX idles high once TXEN and SPEN are set
    const f = frame(e, 104)!
    expect(f.value).toBe(0xa7)
    expect(f.stop).toBe(true)
    expect(f.start).toBeGreaterThanOrEqual(9.75)
    expect(f.start).toBeLessThan(9.75 + 104)
    expect((f.start - 2.75) % 104).toBeCloseTo(0, 6)
  })

  it("back to back: the second word waits in TXREG with TXIF low and its start bit follows the first stop bit (P3-120, P9-146)", () => {
    const m = part(0, TXEN | BRGH, SPEN, A.prog(A.movlw(0x0f), A.movwf(TXREG), A.movlw(0xf0), A.movwf(TXREG)))
    const edges = watch(m, 2)
    m.runUntil(14 * TCY)
    expect(m.peekFile(PIR1) & TXIF).toBe(0)
    m.runUntil(120 * TCY)
    const e = edges()
    const a = frame(e, 4)!
    const b = frame(e, 4, 8, a.start + 39)!
    expect([a.value, b.value]).toEqual([0x0f, 0xf0])
    expect(b.start - a.start).toBeCloseTo(40, 6)
    expect(m.peekFile(PIR1) & TXIF).toBe(TXIF)
    expect(m.peekFile(TXSTA) & TRMT).toBe(TRMT)
  })

  it("9 bits: TX9D goes out as bit 8; a TX9D set after the TXREG write misses the word (P3-122, P9-144)", () => {
    const good = part(0, TXEN | TX9 | BRGH | TX9D, SPEN, A.prog(A.movlw(0x01), A.movwf(TXREG)))
    const ge = watch(good, 2)
    good.runUntil(80 * TCY)
    expect(frame(ge(), 4, 9)!.value).toBe(0x101)
    const late = part(0, TXEN | TX9 | BRGH, SPEN, A.prog(A.movlw(0x01), A.movwf(TXREG), bank1(A.bsf(TXSTA & 0x7f, 0))))
    const le = watch(late, 2)
    late.runUntil(80 * TCY)
    expect(frame(le(), 4, 9)!.value).toBe(0x001)
  })

  it("clearing TXEN aborts the frame and releases the TX pin (P3-121, P9-143; D27, D28)", () => {
    const m = part(25, TXEN | BRGH, SPEN, A.prog(A.movlw(0x00), A.movwf(TXREG), nops(150), bank1(A.bcf(TXSTA & 0x7f, 5))))
    m.runUntil(140 * TCY)
    expect(m.padDrive(RB(2))).toBe("low")
    m.runUntil(400 * TCY)
    expect(m.padDrive(RB(2))).toBe(null)
    expect(m.peekFile(TXSTA) & TRMT).toBe(TRMT)
    expect(m.peekFile(PIR1) & TXIF).toBe(0)
  })

  it("TXREG loaded before TXEN is sent once TXEN is set (P3-119, D27)", () => {
    const m = part(0, BRGH, SPEN, A.prog(A.movlw(0x3c), A.movwf(TXREG), bank1(A.bsf(TXSTA & 0x7f, 5))))
    const edges = watch(m, 2)
    m.runUntil(80 * TCY)
    expect(frame(edges(), 4)!.value).toBe(0x3c)
  })

  it("the asynchronous transmitter stops in Sleep and finishes the frame after the wake-up (P3-112, P9-137; D30)", () => {
    // Bit time 104 TCY, start bit at 106.75; SLEEP at ~313 inside the 0x00 frame's low stretch; RB0/INT wakes the part at 2 ms.
    const m = part(25, TXEN | BRGH, SPEN, A.prog(A.movlw(0x10), A.movwf(INTCON), A.movlw(0x00), A.movwf(TXREG), nops(300), A.sleep()))
    m.setWiredPads([16])
    m.setPad(RB(0), false)
    const edges = watch(m, 2)
    m.setPadAt(RB(0), true, 2e-3)
    m.runUntil(4e-3)
    const e = edges().filter((x) => x.level !== null)
    const fall = e.findIndex((x, i) => i > 0 && x.level === false && e[i - 1].level === true)
    const low = e[fall + 1].t - e[fall].t
    expect(low).toBeGreaterThan(9 * 104 + 1500)
  })
})

describe("asynchronous receiver (§12.2.2, DS33023A §18.4.2/§18.4.3)", () => {
  const TB = 104e-6 // 9615 baud at SPBRG 25, BRGH = 1
  it("receives a frame: RCREG, RCIF, FERR = 0; reading RCREG clears RCIF (P3-127…P3-129, P9-148)", () => {
    const m = rxPart(25, BRGH, SPEN | CREN)
    send(m, 50e-6, 1 / 9600, 0xc5)
    m.runUntil(1.5e-3)
    expect(m.peekFile(PIR1) & RCIF).toBe(RCIF)
    expect(m.peekFile(RCSTA) & FERR).toBe(0)
    expect(m.readFile(RCREG)).toBe(0xc5)
    expect(m.peekFile(PIR1) & RCIF).toBe(0)
  })

  it("RCIF comes at the stop bit's third sample: x16 clock 9 of the stop bit (D25, D26)", () => {
    // x16 tick = 6.5 TCY from 2.75; start edge at 101 µs → first tick 106.75 → done 106.75 + 152 · 6.5 = 1094.75.
    const m = rxPart(25, BRGH, SPEN | CREN)
    send(m, 101e-6, TB, 0x00)
    m.runUntil(1093 * TCY)
    expect(m.peekFile(PIR1) & RCIF).toBe(0)
    m.runUntil(1096 * TCY)
    expect(m.peekFile(PIR1) & RCIF).toBe(RCIF)
  })

  it("three samples, majority vote: a glitch over one sample does not flip the bit (P3-101, P9-155; D25)", () => {
    const m = rxPart(25, BRGH, SPEN | CREN)
    // 0x00 sent from 101 µs; bit 3 spans [101 + 4·104, +104); its samples at 106.75 + (64 + 6..8)·6.5 µs.
    send(m, 101e-6, TB, 0x00)
    const s7 = (106.75 + (16 * 4 + 6) * 6.5) * TCY
    m.setPadAt(RB(1), true, s7 - 1e-6)
    m.setPadAt(RB(1), false, s7 + 1e-6)
    m.runUntil(1.5e-3)
    expect(m.readFile(RCREG)).toBe(0x00)
  })

  it("a sender 3 % fast is still read (§18.8 Q1)", () => {
    const m = rxPart(25, BRGH, SPEN | CREN)
    send(m, 50e-6, TB / 1.03, 0x96)
    m.runUntil(1.5e-3)
    expect(m.readFile(RCREG)).toBe(0x96)
  })

  it("a low stop bit sets FERR with the word (P3-133, P9-128)", () => {
    const m = rxPart(25, BRGH, SPEN | CREN)
    send(m, 50e-6, TB, 0x5a, 8, false)
    m.runUntil(1.5e-3)
    expect(m.peekFile(RCSTA) & FERR).toBe(FERR)
    expect(m.readFile(RCREG)).toBe(0x5a)
  })

  it("a glitch shorter than the start bit's samples is not a start bit (D26)", () => {
    const m = rxPart(25, BRGH, SPEN | CREN)
    m.setPadAt(RB(1), false, 100e-6)
    m.setPadAt(RB(1), true, 110e-6)
    m.runUntil(2e-3)
    expect(m.peekFile(PIR1) & RCIF).toBe(0)
  })

  it("the FIFO holds two words; a third sets OERR and is lost; OERR stops the receiver until CREN is cleared (P3-130…P3-132, P9-149, P9-150; D29)", () => {
    const m = rxPart(25, BRGH, SPEN | CREN)
    for (const [i, v] of [0x11, 0x22, 0x33, 0x44].entries()) send(m, 50e-6 + i * 11 * TB, TB, v)
    m.runUntil(50e-6 + 44 * TB + 100e-6)
    expect(m.peekFile(RCSTA) & OERR).toBe(OERR)
    expect(m.readFile(RCREG)).toBe(0x11)
    expect(m.peekFile(PIR1) & RCIF).toBe(RCIF)
    expect(m.readFile(RCREG)).toBe(0x22)
    expect(m.peekFile(PIR1) & RCIF).toBe(0)
    // OERR still set: a new word does not get in.
    const t = m.time
    send(m, t + 50e-6, TB, 0x55)
    m.runUntil(t + 50e-6 + 12 * TB)
    expect(m.peekFile(PIR1) & RCIF).toBe(0)
    // CREN cleared and set again: OERR clears and words come in.
    m.pokeFile(RCSTA, SPEN)
    expect(m.peekFile(RCSTA) & OERR).toBe(0)
    m.pokeFile(RCSTA, SPEN | CREN)
    const u = m.time
    send(m, u + 50e-6, TB, 0x66)
    m.runUntil(u + 50e-6 + 12 * TB)
    expect(m.readFile(RCREG)).toBe(0x66)
  })

  it("RX9D and FERR travel with each word: RCSTA shows the head of the FIFO (P3-134, P9-151; D29)", () => {
    const m = rxPart(25, BRGH, SPEN | CREN | RX9)
    send(m, 50e-6, TB, 0x1aa, 9)
    send(m, 50e-6 + 12 * TB, TB, 0x055, 9, false)
    m.runUntil(50e-6 + 26 * TB)
    expect(m.peekFile(RCSTA) & (RX9D | FERR)).toBe(RX9D)
    expect(m.readFile(RCREG)).toBe(0xaa)
    expect(m.peekFile(RCSTA) & (RX9D | FERR)).toBe(FERR)
    expect(m.readFile(RCREG)).toBe(0x55)
  })

  it("address detection: with RX9 and ADEN only words with bit 8 set get in; with ADEN cleared all do (P3-137…P3-143, Figures 12-5…12-7)", () => {
    const m = rxPart(25, BRGH, SPEN | CREN | RX9 | ADEN)
    send(m, 50e-6, TB, 0x012, 9) // data: dropped
    send(m, 50e-6 + 12 * TB, TB, 0x134, 9) // address
    m.runUntil(50e-6 + 24 * TB)
    expect(m.peekFile(PIR1) & RCIF).toBe(RCIF)
    expect(m.readFile(RCREG)).toBe(0x34)
    expect(m.peekFile(PIR1) & RCIF).toBe(0)
    send(m, 50e-6 + 24 * TB, TB, 0x056, 9)
    m.runUntil(50e-6 + 36 * TB)
    expect(m.peekFile(PIR1) & RCIF).toBe(0)
    m.pokeFile(RCSTA, SPEN | CREN | RX9)
    send(m, 50e-6 + 36 * TB, TB, 0x078, 9)
    m.runUntil(50e-6 + 48 * TB)
    expect(m.readFile(RCREG)).toBe(0x78)
  })

  it("nothing is received with CREN or SPEN clear (P3-086, P3-127)", () => {
    for (const rc of [SPEN, CREN]) {
      const m = rxPart(25, BRGH, rc)
      send(m, 50e-6, TB, 0x42)
      m.runUntil(1.5e-3)
      expect(m.peekFile(PIR1) & RCIF).toBe(0)
    }
  })

  it("RCIE with PEIE wakes the part; the asynchronous receiver is stopped in Sleep, so a word sent then is not received (P3-112)", () => {
    const body = A.prog(bank1(A.bsf(PIE1 & 0x7f, 5)), A.movlw(0x40), A.movwf(INTCON), A.sleep(), A.movlw(0x42))
    const m = rxPart(25, BRGH, SPEN | CREN, body)
    send(m, 100e-6, TB, 0x42)
    m.runUntil(2e-3)
    expect(m.cpu.sleeping).toBe(true)
    expect(m.peekFile(PIR1) & RCIF).toBe(0)
  })

  it("the original PIC16F627 receives with the same sampling (P6-043; D25)", async () => {
    const { PIC16F627 } = await import("@/mcu/pic/chip")
    const m = createPic(PIC16F627)
    const head = A.prog(bank1(A.movlw(25), A.movwf(SPBRG & 0x7f), A.movlw(BRGH), A.movwf(TXSTA & 0x7f)), A.movlw(SPEN | CREN), A.movwf(RCSTA))
    m.program(A.prog(head, sled(head.length)), CONFIG)
    m.setWiredPads([17])
    m.setPad(RB(1), true)
    send(m, 50e-6, TB, 0x81)
    m.runUntil(1.5e-3)
    expect(m.readFile(RCREG)).toBe(0x81)
  })
})

describe("synchronous master (§12.4, DS33023A §18.5)", () => {
  /** CK rises and falls of a watched RB2, data levels of RB1 at the falls. */
  function clocks(ck: { level: boolean | null; t: number }[]) {
    const first = ck.findIndex((e) => e.level === true)
    const run = first < 0 ? [] : ck.slice(first)
    return { rises: run.filter((e) => e.level === true).map((e) => e.t), falls: run.filter((e) => e.level === false).map((e) => e.t) }
  }

  it("transmits: 8 clocks of (SPBRG + 1) TCY, CK idling low, each bit out at a rising edge and stable at the falling edge (P3-146…P3-148, P9-162, Figure 12-8; D30)", () => {
    // SPBRG 3: 4 TCY a bit; TXEN set at 4.75 starts the BRG; TXREG written at 9.75.
    const m = part(3, CSRC | SYNC | TXEN, SPEN, A.prog(A.movlw(0x96), A.movwf(TXREG)))
    const ck = watch(m, 2)
    const dt = watch(m, 1)
    m.runUntil(60 * TCY)
    const c = clocks(ck())
    const d = dt()
    expect(c.rises.length).toBe(8)
    expect(c.falls.length).toBe(8)
    expect(c.rises[0]).toBeCloseTo(12.75, 6)
    for (let i = 0; i < 8; i++) {
      expect(c.rises[i]).toBeCloseTo(12.75 + 4 * i, 6)
      expect(c.falls[i]).toBeCloseTo(14.75 + 4 * i, 6)
    }
    let v = 0
    c.falls.forEach((t, i) => {
      if (levelAt(d, t)) v |= 1 << i
    })
    expect(v).toBe(0x96)
    expect(m.peekFile(TXSTA) & TRMT).toBe(TRMT)
    expect(m.padDrive(RB(2))).toBe("low")
  })

  it("two words go out back to back with no gap (P3-155, P9-167)", () => {
    const m = part(3, CSRC | SYNC | TXEN, SPEN, A.prog(A.movlw(0x01), A.movwf(TXREG), A.movlw(0x80), A.movwf(TXREG)))
    const ck = watch(m, 2)
    m.runUntil(100 * TCY)
    const c = clocks(ck())
    expect(c.rises.length).toBe(16)
    for (let i = 1; i < 16; i++) expect(c.rises[i] - c.rises[i - 1]).toBeCloseTo(4, 6)
  })

  it("SREN receives one word: 8 clocks, DT sampled at the falling edges, SREN clears itself, RCIF sets (P3-156…P3-158, P9-172, Figure 12-10)", () => {
    // First run: where the clocks come (SREN set at 9.75 from an all-clear BRG).
    const body = A.prog(A.movlw(SPEN | SREN), A.movwf(RCSTA))
    const probe = part(3, CSRC | SYNC, SPEN, body)
    const ck = watch(probe, 2)
    probe.runUntil(60 * TCY)
    const c = clocks(ck())
    expect(c.rises.length).toBe(8)
    expect(c.rises[0]).toBeCloseTo(9.75, 6)
    // Second run: DT changes at each rising edge to the bits of 0x5c.
    const m = part(3, CSRC | SYNC, SPEN, body)
    m.setWiredPads([17])
    m.setPad(RB(1), false)
    c.rises.forEach((t, i) => m.setPadAt(RB(1), ((0x5c >> i) & 1) === 1, t * TCY))
    m.runUntil(60 * TCY)
    expect(m.peekFile(RCSTA) & SREN).toBe(0)
    expect(m.peekFile(PIR1) & RCIF).toBe(RCIF)
    expect(m.readFile(RCREG)).toBe(0x5c)
  })

  it("CREN receives continuously until it is cleared (P3-157)", () => {
    const m = part(3, CSRC | SYNC, SPEN, A.prog(A.movlw(SPEN | CREN), A.movwf(RCSTA)))
    const ck = watch(m, 2)
    m.runUntil(200 * TCY)
    expect(clocks(ck()).rises.length).toBeGreaterThan(40)
    expect(m.peekFile(RCSTA) & OERR).toBe(OERR)
  })

  it("SREN during a transmission aborts it and lets DT go; after the word SREN clears and DT is driven again (P3-151, P3-152, P9-165, P9-166; D31)", () => {
    // TXREG at 9.75 loads a word for 12.75; SREN at 11.75 drops it; 8 receive clocks from the next tick (12.75).
    const m = part(3, CSRC | SYNC | TXEN, SPEN, A.prog(A.movlw(0xff), A.movwf(TXREG), A.movlw(SPEN | SREN), A.movwf(RCSTA)))
    m.runUntil(11 * TCY)
    expect(m.peekFile(TXSTA) & TRMT).toBe(0)
    expect(m.padDrive(RB(1))).not.toBe(null)
    m.runUntil(20 * TCY)
    expect(m.padDrive(RB(1))).toBe(null)
    expect(m.peekFile(TXSTA) & TRMT).toBe(TRMT)
    m.runUntil(60 * TCY)
    expect(m.peekFile(RCSTA) & SREN).toBe(0)
    expect(m.peekFile(PIR1) & RCIF).toBe(RCIF)
    expect(m.padDrive(RB(1))).not.toBe(null)
  })

  it("clearing TXEN, CREN and SREN releases CK and DT (P3-150, P9-164)", () => {
    const m = part(3, CSRC | SYNC | TXEN, SPEN, A.prog(A.movlw(0xff), A.movwf(TXREG), nops(60), bank1(A.bcf(TXSTA & 0x7f, 5))))
    m.runUntil(30 * TCY)
    expect(m.padDrive(RB(1))).not.toBe(null)
    m.runUntil(120 * TCY)
    expect(m.padDrive(RB(1))).toBe(null)
    expect(m.padDrive(RB(2))).toBe(null)
  })
})

describe("synchronous slave (§12.5, DS33023A §18.6)", () => {
  /** An external clock on RB2: `n` periods of 2·half seconds from t0, rising first. */
  function clockIn(m: PicMcu, t0: number, n: number, half: number) {
    for (let i = 0; i < n; i++) {
      m.setPadAt(RB(2), true, t0 + 2 * i * half)
      m.setPadAt(RB(2), false, t0 + (2 * i + 1) * half)
    }
  }

  it("receives on an outside clock, in Sleep too, and RCIF wakes the part (P3-164, P3-168, P9-175)", () => {
    const body = A.prog(bank1(A.bsf(PIE1 & 0x7f, 5)), A.movlw(0x40), A.movwf(INTCON), A.sleep(), A.movlw(0x42))
    const m = part(0, SYNC, SPEN | CREN, body)
    m.setWiredPads([17, 18])
    m.setPad(RB(1), false)
    m.setPad(RB(2), false)
    m.runUntil(50 * TCY)
    expect(m.cpu.sleeping).toBe(true)
    // 0xa3: DT set before each rise, sampled at the fall.
    for (let i = 0; i < 8; i++) m.setPadAt(RB(1), ((0xa3 >> i) & 1) === 1, 100e-6 + 2 * i * 10e-6 - 2e-6)
    clockIn(m, 100e-6, 8, 10e-6)
    m.runUntil(400e-6)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.cpu.w).toBe(0x42)
    expect(m.readFile(RCREG)).toBe(0xa3)
  })

  it("transmits on an outside clock; in Sleep the second word waits in TXREG and its move to the TSR sets TXIF and wakes the part (P3-165, P9-174)", () => {
    const body = A.prog(
      bank1(A.bsf(PIE1 & 0x7f, 4)),
      A.movlw(0x40),
      A.movwf(INTCON),
      A.movlw(0x6b),
      A.movwf(TXREG),
      A.movlw(0x00),
      A.movwf(TXREG),
      A.sleep(),
      A.movlw(0x42),
    )
    const m = part(0, SYNC | TXEN, SPEN, body)
    m.setWiredPads([18])
    m.setPad(RB(2), false)
    const dt = watch(m, 1)
    m.runUntil(50 * TCY)
    expect(m.cpu.sleeping).toBe(true)
    expect(m.peekFile(PIR1) & TXIF).toBe(0)
    clockIn(m, 100e-6, 8, 10e-6)
    m.runUntil(400e-6)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.cpu.w).toBe(0x42)
    const d = dt()
    let v = 0
    for (let i = 0; i < 8; i++) if (levelAt(d, 100 + 20 * i + 10)) v |= 1 << i
    expect(v).toBe(0x6b)
  })
})

describe("USART pins (§12.0, Figures 5-9/5-10)", () => {
  it("SPEN with TRISB<2:1> = 1: the USART decides the pins, the weak pull-ups go off (P3-074, P1-234, P1-235; D28)", () => {
    // RBPU = 0: pull-ups on; SPEN set later.
    const m = part(0, 0, 0, A.prog(bank1(A.movlw(0x7f), A.movwf(OPTION & 0x7f)), A.movlw(SPEN), A.movwf(RCSTA)))
    m.runUntil(12 * TCY)
    expect([m.padDrive(RB(1)), m.padDrive(RB(2))]).toEqual(["pullup", "pullup"])
    m.runUntil(20 * TCY)
    expect([m.padDrive(RB(1)), m.padDrive(RB(2))]).toEqual([null, null])
    expect(m.padDrive(RB(3))).toBe("pullup")
  })

  it("with SPEN clear RB1/RB2 are port pins (P3-086)", () => {
    const m = part(0, TXEN, 0, A.prog(bank1(A.movlw(0xf9), A.movwf(TRISB & 0x7f)), A.movlw(0x02), A.movwf(PORTB)))
    m.runUntil(20 * TCY)
    expect([m.padDrive(RB(1)), m.padDrive(RB(2))]).toEqual(["high", "low"])
  })

  it("SPEN with a TRISB<2:1> bit left 0 is reported (§12.0; D28)", () => {
    const m = part(0, TXEN, 0, A.prog(bank1(A.movlw(0xfb), A.movwf(TRISB & 0x7f)), A.movlw(SPEN), A.movwf(RCSTA)))
    m.runUntil(20 * TCY)
    expect(m.padDrive(RB(2))).toBe("high")
    expect([...m.unmodelled.keys()].join()).toMatch(/TRISB/)
  })
})
