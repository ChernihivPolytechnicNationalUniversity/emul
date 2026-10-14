/**
 * ATmega328P Timer/Counter2 clocked asynchronously from a 32.768 kHz crystal on TOSC1/TOSC2
 * against DS40002061B §18.9–18.11: the count runs on the timer oscillator whatever the system
 * clock does; TCNT2/OCR2x/TCCR2x writes go through temporary registers latched after two
 * rising TOSC1 edges, with the ASSR busy flags; the compare is off while TCNT2/OCR2x are being
 * written (the sleep-before-OCR2AUB trap); interrupt flags are synchronized a timer cycle late;
 * TCNT2 reads stale right after a wake-up; the oscillator stops in Power-down; TOSC1/2 take
 * PB6/PB7 (§14.3.2), PRTIM2 does not stop the asynchronous timer (§10.11.3).
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"
import { brk, ldi, lds, out, prog, rjmp, sei, sleep } from "../lib/avr-asm"

const R = { TCCR2A: 0xb0, TCCR2B: 0xb1, TCNT2: 0xb2, OCR2A: 0xb3, OCR2B: 0xb4, ASSR: 0xb6, TIMSK2: 0x70, TIFR2: 0x37, GTCCR: 0x43, PRR: 0x64, CLKPR: 0x61, DDRB: 0x24, PORTB: 0x25, PINB: 0x23 }
const SMCR = 0x53
const PB3 = { port: 1, pin: 3 } // OC2A
const PB6 = { port: 1, pin: 6 } // TOSC1
const F = 32768
const T = 1 / F

/** Program words: the COMPA (vector 8) and OVF (vector 10) entries, a sleep routine, an idle loop. */
const COMPA = 14
const OVF = 18
const SLEEPS = 0x40
const IDLE = 0x50

/** A 328P on its internal 8 MHz RC oscillator with a 32.768 kHz crystal across TOSC1/TOSC2. */
function part(feed: { hz: number; kind: "crystal" | "clock" } | null = { hz: F, kind: "crystal" }, low = 0xe2): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { low, high: 0x99, extended: 0xfd, lock: 0xff }
  m.setClockFeed(feed)
  m.cpu.flash.fill(0x0000)
  m.cpu.flash.set(rjmp(-1), IDLE)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.runUntil(0.07)
  m.cpu.pc = IDLE
  for (let pin = 0; pin < 8; pin++) m.digitalWatch.add(16 + pin)
  return m
}

/** AS2 set and the timer configured the safe way (§18.9): write, then wait for the busy flags. */
function asyncTimer(m: AvrMcu, tccrA: number, tccrB: number, ocrA = 0, tcnt = 0) {
  m.poke(R.ASSR, 0x20)
  m.poke(R.TCNT2, tcnt)
  m.poke(R.OCR2A, ocrA)
  m.poke(R.TCCR2A, tccrA)
  m.poke(R.TCCR2B, tccrB)
  m.runUntil(m.time + 3 * T)
  expect(m.read(R.ASSR) & 0x1f).toBe(0)
  m.poke(R.TIFR2, 0x07)
}

/** Sleep in `mode` (SMCR value) with interrupts on; the vectors hold BREAK, so a wake-up halts the core there. */
function sleepNow(m: AvrMcu, smcr: number, isr: number[] = brk()) {
  m.cpu.flash.set(isr, COMPA)
  m.cpu.flash.set(isr, OVF)
  m.cpu.flash.set(prog(ldi(16, smcr), out(SMCR - 0x20, 16), sei(), sleep(), rjmp(-1)), SLEEPS)
  m.cpu.invalidate()
  m.cpu.pc = SLEEPS
}

function edges(m: AvrMcu, pad: { port: number; pin: number }, seconds: number) {
  m.digitalOut.length = 0
  m.runUntil(m.time + seconds)
  return m.digitalOut.filter((e) => e.pad.port === pad.port && e.pad.pin === pad.pin)
}

describe("asynchronous Timer/Counter2 (§18.9)", () => {
  it("CTC toggle on OC2A counts TOSC1: f = 32768/(2·N·(1+OCR2A)), unchanged when CLKPR divides the system clock", () => {
    const m = part()
    m.poke(R.DDRB, 0x08)
    asyncTimer(m, 0x42, 0x01, 127) // COM2A = 01 toggle, WGM = 2 (CTC), N = 1
    const period = (2 * 128) / F
    let e = edges(m, PB3, 0.1).filter((x) => x.level)
    expect(e[e.length - 1].time - e[e.length - 2].time).toBeCloseTo(period, 7)
    m.poke(R.CLKPR, 0x80)
    m.poke(R.CLKPR, 0x03) // system clock ÷ 8 = 1 MHz
    e = edges(m, PB3, 0.1).filter((x) => x.level)
    expect(e[e.length - 1].time - e[e.length - 2].time).toBeCloseTo(period, 7)
  })

  it("N = 128 overflows once a second: the real-time-counter set-up (§18.10)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x05)
    const t0 = m.time
    let first = NaN
    for (let t = t0; t < t0 + 2.5; t += 1e-3) {
      m.runUntil(t)
      if (m.read(R.TIFR2) & 1) {
        if (isNaN(first)) first = m.time
        m.poke(R.TIFR2, 1)
        if (m.time - first > 0.5) {
          expect(m.time - first).toBeCloseTo(1, 2)
          return
        }
      }
    }
    throw new Error("no second overflow")
  })

  it("register writes set the ASSR busy flag and latch after two rising TOSC1 edges; OCR2x/TCCR2x read the temporary register (§18.11.8)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x00)
    const cases: [number, number][] = [
      [R.TCNT2, 0x10],
      [R.OCR2A, 0x08],
      [R.OCR2B, 0x04],
      [R.TCCR2A, 0x02],
      [R.TCCR2B, 0x01],
    ]
    for (const [addr, ub] of cases) {
      m.runUntil(m.time + 0.37 * T) // a phase that is not on an edge
      m.poke(addr, addr === R.TCCR2B ? 0x00 : 0x55 & (addr === R.TCCR2A ? 0xf3 : 0xff))
      expect(m.read(R.ASSR) & 0x1f).toBe(ub)
      if (addr !== R.TCNT2) expect(m.read(addr)).toBe(addr === R.TCCR2A ? 0x51 : addr === R.TCCR2B ? 0 : 0x55)
      m.runUntil(m.time + 1.0 * T) // one rising edge: still busy
      expect(m.read(R.ASSR) & ub).toBe(ub)
      m.runUntil(m.time + 1.0 * T) // the second rising edge latched it
      expect(m.read(R.ASSR) & ub).toBe(0)
    }
  })

  it("TCNT2 reads the counter: a written value shows only once latched", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x00, 0, 7)
    m.poke(R.TCNT2, 0x80)
    expect(m.read(R.TCNT2)).toBe(7)
    m.runUntil(m.time + 2.1 * T)
    expect(m.read(R.TCNT2)).toBe(0x80)
  })

  it("synchronous mode has no busy flags: writes take effect at once", () => {
    const m = part()
    m.poke(R.OCR2A, 0x33)
    m.poke(R.TCNT2, 0x44)
    expect(m.read(R.ASSR)).toBe(0)
    expect(m.read(R.TCNT2)).toBe(0x44)
  })

  it("interrupt flags are synchronized a timer cycle late: TCNT2 has advanced by one when TOV2 is first seen (§18.9)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x01, 0, 0xf0)
    let sawZeroWithoutFlag = false
    for (let i = 0; i < 20000; i++) {
      m.runUntil(m.time + 0.1 * T)
      const flag = m.read(R.TIFR2) & 1
      const n = m.read(R.TCNT2)
      if (n === 0 && !flag) sawZeroWithoutFlag = true
      if (flag) {
        expect(sawZeroWithoutFlag).toBe(true)
        expect(n).toBeGreaterThanOrEqual(1)
        return
      }
    }
    throw new Error("TOV2 never set")
  })

  it("wakes the part from Power-save on overflow (Table 10-1)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x07, 0, 250) // N = 1024: 6 ticks to the overflow = 0.1875 s
    m.poke(R.TIMSK2, 0x01)
    sleepNow(m, 0x07) // Power-save
    m.runUntil(m.time + 0.15)
    expect(m.cpu.sleeping).toBe(true)
    m.runUntil(m.time + 0.06)
    expect(m.cpu.halted?.detail).toBe("break")
    expect(m.cpu.opPc).toBe(OVF)
  })

  it("wakes the part from ADC Noise Reduction mode on overflow — asynchronous mode only (Table 10-1 note 2)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x07, 0, 250)
    m.poke(R.TIMSK2, 0x01)
    sleepNow(m, 0x03) // ADC Noise Reduction
    m.runUntil(m.time + 0.25)
    expect(m.cpu.halted?.detail).toBe("break")
  })

  it("the timer oscillator stops in Power-down: no wake-up from Timer2 (§18.9, Table 10-1)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x07, 0, 250)
    m.poke(R.TIMSK2, 0x01)
    sleepNow(m, 0x05) // Power-down
    m.runUntil(m.time + 1)
    expect(m.cpu.sleeping).toBe(true)
    expect(m.cpu.halted).toBe(null)
  })

  it("sleeping before OCR2AUB clears: the compare stays off and the part never wakes (§18.9)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x07, 0, 0)
    m.poke(R.TIMSK2, 0x02)
    m.poke(R.OCR2A, 20)
    sleepNow(m, 0x07)
    m.runUntil(m.time + 3)
    expect(m.cpu.sleeping).toBe(true)
    expect(m.read(R.ASSR) & 0x08).toBe(0x08)
  })

  it("…and waiting for OCR2AUB first, the compare match wakes it", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x07, 0, 0)
    m.poke(R.TIMSK2, 0x02)
    m.poke(R.OCR2A, 20)
    m.runUntil(m.time + 2.1 * T)
    expect(m.read(R.ASSR) & 0x08).toBe(0)
    sleepNow(m, 0x07)
    m.runUntil(m.time + 1)
    expect(m.cpu.halted?.detail).toBe("break")
    expect(m.cpu.opPc).toBe(COMPA)
  })

  it("right after a wake-up TCNT2 reads the value from before the sleep until the next rising TOSC1 edge (§18.9)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x07, 0, 250)
    m.poke(R.TIMSK2, 0x01)
    const before = m.read(R.TCNT2)
    expect(before).toBeGreaterThanOrEqual(250)
    m.cpu.data[17] = 0xaa
    sleepNow(m, 0x07, prog(lds(17, R.TCNT2), rjmp(-1)))
    m.runUntil(m.time + 0.25)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.cpu.data[17]).toBe(before) // read in the interrupt routine, a few cycles after the wake-up
    expect(m.read(R.TCNT2)).toBeLessThan(4) // the counter itself is past the overflow
  })

  it("PRTIM2 stops Timer2 in synchronous mode only (§10.11.3)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x01)
    m.poke(R.PRR, 0x40)
    const a = m.read(R.TCNT2)
    m.runUntil(m.time + 20 * T)
    expect((m.read(R.TCNT2) - a) & 0xff).toBeGreaterThanOrEqual(19)
  })

  it("PSRASY written in asynchronous mode reads one until the prescaler has been reset (§18.11.9)", () => {
    const m = part()
    asyncTimer(m, 0x00, 0x07)
    m.poke(R.GTCCR, 0x02)
    expect(m.read(R.GTCCR) & 0x02).toBe(0x02)
    m.runUntil(m.time + 1.1 * T)
    expect(m.read(R.GTCCR) & 0x02).toBe(0)
  })

  it("AS2 takes PB6/PB7 for the oscillator: the port no longer drives TOSC1 and PINB6 reads 0 (§14.3.2)", () => {
    const m = part()
    m.poke(R.DDRB, 0x40)
    m.poke(R.PORTB, 0x40)
    expect(m.padDrive(PB6)).toBe("high")
    m.poke(R.ASSR, 0x20)
    m.runUntil(m.time + 1e-6)
    expect(m.padDrive(PB6)).toBe(null)
    expect(m.read(R.PINB) & 0xc0).toBe(0)
  })

  it("EXCLK: an external clock on TOSC1 counts; a crystal does not, the crystal oscillator only runs with EXCLK = 0 (§18.11.8)", () => {
    const clocked = part({ hz: F, kind: "clock" })
    clocked.poke(R.ASSR, 0x40)
    asyncTimer(clocked, 0x00, 0x01)
    clocked.poke(R.ASSR, 0x60)
    const a = clocked.read(R.TCNT2)
    clocked.runUntil(clocked.time + 50 * T)
    expect((clocked.read(R.TCNT2) - a) & 0xff).toBeGreaterThan(40)

    const crystal = part()
    crystal.poke(R.ASSR, 0x60)
    crystal.poke(R.TCCR2B, 0x01)
    crystal.runUntil(crystal.time + 50 * T)
    expect(crystal.read(R.TCNT2)).toBe(0)
  })

  it("with a crystal clocking the system the XTAL pins are not TOSC: AS2 leaves the timer without a clock, reported as such", () => {
    const m = part({ hz: 16e6, kind: "crystal" }, 0xff)
    m.poke(R.ASSR, 0x20)
    m.poke(R.TCCR2B, 0x01)
    m.runUntil(m.time + 0.01)
    expect(m.read(R.TCNT2)).toBe(0)
    expect([...m.unmodelled.keys()].some((k) => k.includes("TOSC"))).toBe(true)
  })
})
