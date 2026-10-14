/**
 * ATmega328P Timer/Counter0, 1 and 2 against DS40002061B §15–18: output frequencies from the
 * mode equations, duty cycles and the extreme OCR values, flag timing (Figures 15-8…15-11,
 * 16-12), compare blocking by a TCNT write, OCR double buffering, force output compare, the
 * 16-bit TEMP register, input capture and the prescaler tables (15-9, 16-5, 18-9).
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"

// Data-space addresses (Register Summary).
const R = {
  TCCR0A: 0x44, TCCR0B: 0x45, TCNT0: 0x46, OCR0A: 0x47, OCR0B: 0x48, TIMSK0: 0x6e, TIFR0: 0x35,
  TCCR1A: 0x80, TCCR1B: 0x81, TCCR1C: 0x82, TCNT1L: 0x84, TCNT1H: 0x85, ICR1L: 0x86, ICR1H: 0x87, OCR1AL: 0x88, OCR1AH: 0x89, OCR1BL: 0x8a, OCR1BH: 0x8b, TIMSK1: 0x6f, TIFR1: 0x36,
  TCCR2A: 0xb0, TCCR2B: 0xb1, TCNT2: 0xb2, OCR2A: 0xb3, OCR2B: 0xb4, TIMSK2: 0x70, TIFR2: 0x37,
  GTCCR: 0x43, DDRB: 0x24, DDRD: 0x2a, PRR: 0x64,
}
const PD6 = { port: 3, pin: 6 } // OC0A
const PD5 = { port: 3, pin: 5 } // OC0B
const PB1 = { port: 1, pin: 1 } // OC1A
const PB2 = { port: 1, pin: 2 } // OC1B
const PB3 = { port: 1, pin: 3 } // OC2A
const PD3 = { port: 3, pin: 3 } // OC2B
const PB0 = { port: 1, pin: 0 } // ICP1
const HZ = 16e6

/**
 * A 328P at 16 MHz running a NOP sled (one cycle per instruction, so a test can step the
 * clock one cycle at a time), past its start-up, with every pad on the exact-time path.
 */
function part(): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { low: 0xff, high: 0xd9, extended: 0xfd, lock: 0xff }
  m.setClockFeed({ hz: HZ, kind: "crystal" })
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.runUntil(0.07)
  for (const port of [1, 2, 3]) for (let pin = 0; pin < 8; pin++) m.digitalWatch.add(port * 16 + pin)
  return m
}

/** Edges on one pad over `seconds`, from now. */
function edges(m: AvrMcu, pad: { port: number; pin: number }, seconds: number) {
  m.digitalOut.length = 0
  m.runUntil(m.time + seconds)
  return m.digitalOut.filter((e) => e.pad.port === pad.port && e.pad.pin === pad.pin)
}

/** Period and high time of a steady waveform, from its last full cycles. */
function waveform(m: AvrMcu, pad: { port: number; pin: number }, seconds: number) {
  const e = edges(m, pad, seconds)
  const rises = e.filter((x) => x.level === true).map((x) => x.time)
  const falls = e.filter((x) => x.level === false).map((x) => x.time)
  if (rises.length < 3) return { period: NaN, high: NaN, edges: e.length }
  const r1 = rises[rises.length - 2]
  const r2 = rises[rises.length - 1]
  const f = falls.find((t) => t > r1 && t < r2)!
  return { period: r2 - r1, high: f - r1, edges: e.length }
}

describe("Timer/Counter0 (§15)", () => {
  it("fast PWM, N = 64: f = fclk/(N·256) = 976.5625 Hz, high for OCR0A+1 of 256 ticks (§15.7.3)", () => {
    const m = part()
    m.poke(R.DDRD, 0x60)
    m.poke(R.OCR0A, 127)
    m.poke(R.TCCR0A, 0x83) // COM0A = 10, WGM = 3
    m.poke(R.TCCR0B, 0x03) // N = 64
    const w = waveform(m, PD6, 0.02)
    expect(w.period).toBeCloseTo(64 * 256 / HZ, 9)
    expect(w.high).toBeCloseTo(64 * 128 / HZ, 9)
  })

  it("fast PWM inverting (COM0B = 11) on OC0B: high for 255 − OCR0B ticks", () => {
    const m = part()
    m.poke(R.DDRD, 0x60)
    m.poke(R.OCR0B, 63)
    m.poke(R.TCCR0A, 0x33)
    m.poke(R.TCCR0B, 0x01)
    const w = waveform(m, PD5, 0.001)
    expect(w.period).toBeCloseTo(256 / HZ, 12)
    expect(w.high).toBeCloseTo((255 - 63) / HZ, 12)
  })

  it("fast PWM extremes: OCR0A = MAX is constantly high; OCR0A = 0 is a one-tick spike per 256 (§15.7.3)", () => {
    const m = part()
    m.poke(R.DDRD, 0x40)
    m.poke(R.OCR0A, 255)
    m.poke(R.TCCR0A, 0x83)
    m.poke(R.TCCR0B, 0x01)
    m.runUntil(m.time + 1e-4)
    expect(edges(m, PD6, 1e-3)).toHaveLength(0)
    expect(m.padDrive(PD6)).toBe("high")
    m.poke(R.OCR0A, 0)
    const w = waveform(m, PD6, 1e-3)
    expect(w.period).toBeCloseTo(256 / HZ, 12)
    expect(w.high).toBeCloseTo(1 / HZ, 12)
  })

  it("phase correct, N = 64: f = fclk/(N·510) = 490.196 Hz, duty OCR0A/255 (§15.7.4)", () => {
    const m = part()
    m.poke(R.DDRD, 0x40)
    m.poke(R.OCR0A, 100)
    m.poke(R.TCCR0A, 0x81) // COM0A = 10, WGM = 1
    m.poke(R.TCCR0B, 0x03)
    const w = waveform(m, PD6, 0.03)
    expect(w.period).toBeCloseTo(64 * 510 / HZ, 9)
    expect(w.high).toBeCloseTo(64 * 2 * 100 / HZ, 9)
  })

  it("phase correct extremes: OCR0A = 0 continuously low, MAX continuously high (§15.7.4)", () => {
    const m = part()
    m.poke(R.DDRD, 0x40)
    m.poke(R.OCR0A, 0)
    m.poke(R.TCCR0A, 0x81)
    m.poke(R.TCCR0B, 0x01)
    m.runUntil(m.time + 1e-4)
    expect(edges(m, PD6, 1e-3)).toHaveLength(0)
    expect(m.padDrive(PD6)).toBe("low")
    m.poke(R.OCR0A, 255)
    m.runUntil(m.time + 1e-4)
    expect(edges(m, PD6, 1e-3)).toHaveLength(0)
    expect(m.padDrive(PD6)).toBe("high")
  })

  it("CTC toggle: f = fclk/(2·N·(1+OCR0A)) (§15.7.2)", () => {
    const m = part()
    m.poke(R.DDRD, 0x40)
    m.poke(R.OCR0A, 99)
    m.poke(R.TCCR0A, 0x42) // COM0A = 01, WGM = 2
    m.poke(R.TCCR0B, 0x02) // N = 8
    const w = waveform(m, PD6, 0.005)
    expect(w.period).toBeCloseTo(2 * 8 * 100 / HZ, 10)
  })

  it("normal mode: TOV0 every 256 ticks, set as TCNT0 goes MAX → BOTTOM (Figure 15-8)", () => {
    const m = part()
    m.poke(R.TCNT0, 250)
    m.poke(R.TCCR0B, 0x01)
    // The write at cycle c takes effect for c+1; ticks then come every cycle.
    const c0 = m.cpu.cycles
    m.cpu.run(c0 + 5)
    expect(m.read(R.TIFR0) & 1).toBe(0)
    expect(m.read(R.TCNT0)).toBeGreaterThanOrEqual(254)
    m.cpu.run(c0 + 8)
    expect(m.read(R.TIFR0) & 1).toBe(1)
    expect(m.read(R.TCNT0)).toBeLessThan(5)
  })

  it("OCF0A is set on the timer clock after TCNT0 = OCR0A (Figure 15-10)", () => {
    const m = part()
    m.poke(R.OCR0A, 10)
    m.poke(R.TCNT0, 0)
    m.poke(R.TCCR0B, 0x01)
    // Poll cycle by cycle: the flag appears exactly when TCNT0 reads OCR0A + 1.
    let seen = -1
    for (let i = 0; i < 40 && seen < 0; i++) {
      m.cpu.run(m.cpu.cycles + 1)
      if (m.read(R.TIFR0) & 2) seen = m.read(R.TCNT0)
    }
    expect(seen).toBe(11)
  })

  it("a TCNT0 write blocks the compare match on the next timer clock (§15.5.2)", () => {
    const m = part()
    m.poke(R.OCR0A, 5)
    m.poke(R.TCCR0B, 0x01)
    m.poke(R.TCNT0, 5)
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(R.TIFR0) & 2).toBe(0)
    // One full turn later it matches as usual.
    m.cpu.run(m.cpu.cycles + 260)
    expect(m.read(R.TIFR0) & 2).toBe(2)
  })

  it("CTC: a TOP written below TCNT0 is missed — the counter runs to MAX, sets TOV0, wraps, then matches (§15.7.2)", () => {
    const m = part()
    m.poke(R.TCCR0A, 0x02)
    m.poke(R.OCR0A, 200)
    m.poke(R.TCCR0B, 0x01)
    m.cpu.run(m.cpu.cycles + 150)
    m.poke(R.OCR0A, 50)
    m.poke(R.TIFR0, 0x07)
    // TCNT0 ≈ 150 is past the new TOP: it runs on through 255 (about 106 ticks) before wrapping.
    m.cpu.run(m.cpu.cycles + 120)
    expect(m.read(R.TIFR0) & 1).toBe(1)
    expect(m.read(R.TIFR0) & 2).toBe(0)
    m.cpu.run(m.cpu.cycles + 50)
    expect(m.read(R.TIFR0) & 2).toBe(2)
  })

  it("fast PWM: an OCR0A write takes effect at BOTTOM, not at once (§15.5, Table 15-8)", () => {
    const m = part()
    m.poke(R.DDRD, 0x40)
    m.poke(R.OCR0A, 200)
    m.poke(R.TCCR0A, 0x83)
    m.poke(R.TCCR0B, 0x01)
    m.cpu.run(m.cpu.cycles + 256 * 3)
    // Mid-period (TCNT0 near 100): a new OCR0A of 50 must not cut this pulse short.
    for (let i = 0; i < 1000 && Math.abs(m.read(R.TCNT0) - 100) > 1; i++) m.cpu.run(m.cpu.cycles + 1)
    m.digitalOut.length = 0
    m.poke(R.OCR0A, 50)
    m.cpu.run(m.cpu.cycles + 3 * 256)
    const e = m.digitalOut.filter((x) => x.pad.pin === 6)
    // First fall at the old compare value 200, then pulses of 51 ticks.
    expect(e[0].level).toBe(false)
    expect(Math.round((e[0].time - m.cycleTime(m.cpu.cycles - 3 * 256)) * HZ)).toBeGreaterThan(95)
    const rise = e.find((x) => x.level === true)!
    const fall = e.find((x) => x.level === false && x.time > rise.time)!
    expect(Math.round((fall.time - rise.time) * HZ)).toBe(51)
  })

  it("FOC0A in normal mode acts on OC0A at once without setting OCF0A (§15.5.1)", () => {
    const m = part()
    m.poke(R.DDRD, 0x40)
    m.poke(R.TCCR0A, 0x40) // toggle
    m.poke(R.TCCR0B, 0x80) // FOC0A, timer stopped
    m.cpu.run(m.cpu.cycles + 2)
    expect(m.padDrive(PD6)).toBe("high")
    expect(m.read(R.TIFR0) & 2).toBe(0)
    expect(m.read(R.TCCR0B) & 0x80).toBe(0)
  })

  it("the prescaler runs free: with N = 8 the first count comes 1 to N+1 cycles after the enable (§17.2)", () => {
    const delays = new Set<number>()
    for (let skew = 0; skew < 8; skew++) {
      const m = part()
      m.cpu.run(m.cpu.cycles + skew)
      m.poke(R.TCCR0B, 0x02)
      const start = m.cpu.cycles
      for (let i = 0; i < 100 && m.read(R.TCNT0) === 0; i++) m.cpu.run(m.cpu.cycles + 1)
      delays.add(m.cpu.cycles - start)
    }
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(1)
      expect(d).toBeLessThanOrEqual(9)
    }
    // Every phase of the free-running prescaler shows up as a different delay.
    expect(delays.size).toBe(8)
  })

  it("PSRSYNC resets the shared prescaler: Timer0 and Timer1 with N = 8 count in step (§17.4.1)", () => {
    const m = part()
    m.poke(R.TCCR0B, 0x02)
    m.poke(R.TCCR1B, 0x02)
    m.poke(R.GTCCR, 0x81) // TSM + PSRSYNC: held
    m.poke(R.TCNT0, 0)
    m.poke(R.TCNT1H, 0)
    m.poke(R.TCNT1L, 0)
    m.cpu.run(m.cpu.cycles + 100)
    expect(m.read(R.TCNT0)).toBe(0)
    m.poke(R.GTCCR, 0x00)
    m.cpu.run(m.cpu.cycles + 8 * 20 + 3)
    const t0 = m.read(R.TCNT0)
    const t1 = m.read(R.TCNT1L)
    expect(t0).toBe(t1)
    expect(t0).toBeGreaterThanOrEqual(19)
  })

  it("external clock on T0 (PD4), rising edges, counts each edge 2.5–3.5 cycles later (§17.3)", () => {
    const m = part()
    m.setWiredPads([3 * 16 + 4])
    m.setPad({ port: 3, pin: 4 }, false)
    m.poke(R.TCCR0B, 0x07)
    for (let i = 0; i < 10; i++) {
      m.setPad({ port: 3, pin: 4 }, true)
      m.cpu.run(m.cpu.cycles + 5)
      m.setPad({ port: 3, pin: 4 }, false)
      m.cpu.run(m.cpu.cycles + 5)
    }
    expect(m.read(R.TCNT0)).toBe(10)
  })
})

describe("Timer/Counter1 (§16)", () => {
  it("16-bit access: high byte through TEMP on write, latched on low-byte read (§16.3)", () => {
    const m = part()
    m.poke(R.TCNT1H, 0x12)
    m.poke(R.TCNT1L, 0x34)
    expect(m.read(R.TCNT1L)).toBe(0x34)
    expect(m.read(R.TCNT1H)).toBe(0x12)
    m.poke(R.OCR1AH, 0xab)
    m.poke(R.OCR1AL, 0xcd)
    // OCR1A is read directly, not through TEMP.
    m.poke(R.TCNT1H, 0x55) // TEMP = 0x55
    expect(m.read(R.OCR1AH)).toBe(0xab)
    expect(m.read(R.OCR1AL)).toBe(0xcd)
  })

  it("TEMP is shared: a low-byte read between the two writes replaces the high byte written (§16.3)", () => {
    const m = part()
    m.poke(R.TCNT1H, 0x12)
    m.read(R.ICR1L) // latches ICR1H (0) into TEMP
    m.poke(R.TCNT1L, 0x34)
    expect(m.read(R.TCNT1L)).toBe(0x34)
    expect(m.read(R.TCNT1H)).toBe(0x00)
  })

  it("fast PWM 10-bit (mode 7), N = 64: f = fclk/(N·(1+TOP)) = 244.14 Hz (§16.9.3)", () => {
    const m = part()
    m.poke(R.DDRB, 0x06)
    m.poke(R.OCR1AH, 0x01)
    m.poke(R.OCR1AL, 0xff) // 511
    m.poke(R.TCCR1A, 0x83) // COM1A = 10, WGM11:10 = 11
    m.poke(R.TCCR1B, 0x0b) // WGM12, N = 64
    const w = waveform(m, PB1, 0.03)
    expect(w.period).toBeCloseTo(64 * 1024 / HZ, 9)
    expect(w.high).toBeCloseTo(64 * 512 / HZ, 9)
  })

  it("phase correct 8-bit (mode 1), N = 64 — what analogWrite uses on D9/D10: 490.196 Hz (§16.9.4)", () => {
    const m = part()
    m.poke(R.DDRB, 0x06)
    m.poke(R.OCR1BL, 64)
    m.poke(R.TCCR1A, 0x21) // COM1B = 10, WGM10
    m.poke(R.TCCR1B, 0x03)
    const w = waveform(m, PB2, 0.03)
    expect(w.period).toBeCloseTo((2 * 64 * 255) / HZ, 9)
    expect(w.high).toBeCloseTo((2 * 64 * 64) / HZ, 9)
  })

  it("fast PWM with ICR1 as TOP (mode 14), N = 8, ICR1 = 39999: 50 Hz servo frame, 1.5 ms pulse", () => {
    const m = part()
    m.poke(R.DDRB, 0x02)
    m.poke(R.TCCR1A, 0x82) // COM1A = 10, WGM11
    m.poke(R.TCCR1B, 0x1a) // WGM13:12, N = 8
    m.poke(R.ICR1H, 39999 >> 8)
    m.poke(R.ICR1L, 39999 & 0xff)
    m.poke(R.OCR1AH, 2999 >> 8)
    m.poke(R.OCR1AL, 2999 & 0xff)
    const w = waveform(m, PB1, 0.1)
    expect(w.period).toBeCloseTo(0.02, 9)
    expect(w.high).toBeCloseTo(1.5e-3, 9)
  })

  it("phase and frequency correct, ICR1 TOP (mode 8): f = fclk/(2·N·TOP) (§16.9.5)", () => {
    const m = part()
    m.poke(R.DDRB, 0x02)
    m.poke(R.TCCR1A, 0x80)
    m.poke(R.TCCR1B, 0x11) // WGM13, N = 1
    m.poke(R.ICR1H, 0)
    m.poke(R.ICR1L, 100)
    m.poke(R.OCR1AL, 25)
    const w = waveform(m, PB1, 2e-4)
    expect(w.period).toBeCloseTo(200 / HZ, 12)
    expect(w.high).toBeCloseTo(50 / HZ, 12)
  })

  it("CTC with OCR1A (mode 4): OCF1A sets as TCNT1 clears to BOTTOM (Figure 16-12)", () => {
    const m = part()
    m.poke(R.OCR1AH, 0)
    m.poke(R.OCR1AL, 9)
    m.poke(R.TCCR1B, 0x09) // WGM12, N = 1
    let seen = -1
    for (let i = 0; i < 40 && seen < 0; i++) {
      m.cpu.run(m.cpu.cycles + 1)
      if (m.read(R.TIFR1) & 2) seen = m.read(R.TCNT1L)
    }
    expect(seen).toBe(0)
  })

  it("input capture: ICR1 takes TCNT1 at the selected edge, ICF1 set; the noise canceler adds four cycles (§16.6)", () => {
    const capture = (icnc: boolean) => {
      const m = part()
      m.setWiredPads([PB0.port * 16 + PB0.pin])
      m.setPad(PB0, false)
      m.poke(R.TCCR1B, (icnc ? 0x80 : 0) | 0x40 | 0x01) // rising edge, N = 1
      m.cpu.run(m.cpu.cycles + 100)
      m.poke(R.TIFR1, 0x20)
      const tcntBefore = m.read(R.TCNT1L) | (m.read(R.TCNT1H) << 8)
      m.setPad(PB0, true)
      m.cpu.run(m.cpu.cycles + 20)
      const icr = m.read(R.ICR1L) | (m.read(R.ICR1H) << 8)
      return { flag: m.read(R.TIFR1) & 0x20, lag: icr - tcntBefore }
    }
    const plain = capture(false)
    const filtered = capture(true)
    expect(plain.flag).toBe(0x20)
    expect(filtered.flag).toBe(0x20)
    expect(filtered.lag - plain.lag).toBe(4)
  })

  it("input capture is off when ICR1 defines TOP (§16.11.2 ICES1)", () => {
    const m = part()
    m.setWiredPads([PB0.port * 16 + PB0.pin])
    m.setPad(PB0, false)
    m.poke(R.TCCR1A, 0x02)
    m.poke(R.TCCR1B, 0x58) // ICES1, WGM13:12 → mode 14, stopped
    m.setPad(PB0, true)
    m.cpu.run(m.cpu.cycles + 20)
    expect(m.read(R.TIFR1) & 0x20).toBe(0)
  })
})

describe("Timer/Counter2 (§18)", () => {
  it("phase correct, N = 64 (Table 18-9 CS = 100) on OC2A/OC2B: 490.196 Hz — analogWrite on D11/D3", () => {
    const m = part()
    m.poke(R.DDRB, 0x08)
    m.poke(R.DDRD, 0x08)
    m.poke(R.OCR2A, 128)
    m.poke(R.OCR2B, 32)
    m.poke(R.TCCR2A, 0xa1)
    m.poke(R.TCCR2B, 0x04)
    const a = waveform(m, PB3, 0.03)
    expect(a.period).toBeCloseTo((64 * 510) / HZ, 9)
    expect(a.high).toBeCloseTo((64 * 2 * 128) / HZ, 9)
    const b = waveform(m, PD3, 0.03)
    expect(b.high).toBeCloseTo((64 * 2 * 32) / HZ, 9)
  })

  it("prescaler N = 32 and 128 exist on Timer2 only (Table 18-9)", () => {
    const m = part()
    m.poke(R.TCCR2B, 0x03) // N = 32
    const c0 = m.cpu.cycles
    m.cpu.run(c0 + 32 * 100)
    expect(Math.abs(m.read(R.TCNT2) - 100)).toBeLessThanOrEqual(1)
  })
})

describe("power reduction (§10.9)", () => {
  it("PRTIM0 stops Timer0 and freezes its registers", () => {
    const m = part()
    m.poke(R.TCCR0B, 0x01)
    m.cpu.run(m.cpu.cycles + 50)
    m.poke(R.PRR, 0x20)
    const frozen = m.cpu.cycles
    m.cpu.run(frozen + 500)
    m.poke(R.PRR, 0x00)
    const v = m.read(R.TCNT0)
    // About 50 ticks before PRTIM0, none in the 500 cycles after it.
    expect(v).toBeGreaterThanOrEqual(48)
    expect(v).toBeLessThanOrEqual(52)
  })
})
