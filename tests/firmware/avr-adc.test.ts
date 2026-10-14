/**
 * ATmega328P ADC and analog comparator against DS40002061B §24 and §23: the conversion result
 * (§24.7) for each reference (Table 24-3) and the internal channels (Table 24-4, Table 24-2),
 * conversion and sample-and-hold timing (Table 24-1), left adjust and the ADCL/ADCH lock
 * (§24.9.3), buffered MUX changes (§24.5), free running and auto triggering (Table 24-6),
 * DIDR0, the noise reduction sleep mode (§24.6), and the comparator's inputs, interrupt modes
 * and input capture link (Tables 23-1, 23-2).
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"
import { ANALOG_PORT, padName, parsePad } from "@/mcu/pads"
import type { PadRef } from "@/mcu/pads"

const ADCL = 0x78
const ADCH = 0x79
const ADCSRA = 0x7a
const ADCSRB = 0x7b
const ADMUX = 0x7c
const DIDR0 = 0x7e
const ACSR = 0x50
const TIFR0 = 0x35
const TCCR0B = 0x45
const HZ = 16e6
const EN = 0x80
const SC = 0x40
const ATE = 0x20
const IF = 0x10

type Volts = (pad: PadRef, cycle: number) => number
function part(volts: Volts = () => 0): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { low: 0xff, high: 0x99, extended: 0xfd, lock: 0xff }
  m.setClockFeed({ hz: HZ, kind: "crystal" })
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.setSupply(5)
  m.analogRead = (pad) => volts(pad, m.cpu.cycles)
  m.runUntil(0.07)
  return m
}
const ch = (n: number): PadRef => ({ port: 2, pin: n }) // ADC0–5 are PC0–PC5

/** Start a conversion and run until ADSC clears; returns the cycles it took and the 10-bit result. */
function convert(m: AvrMcu, admux: number, adps = 7) {
  m.poke(ADMUX, admux)
  m.poke(ADCSRA, EN | SC | adps)
  const start = m.cpu.cycles
  for (let i = 0; i < 100000 && m.read(ADCSRA) & SC; i++) m.cpu.run(m.cpu.cycles + 1)
  const took = m.cpu.cycles - start
  const lo = m.read(ADCL)
  const hi = m.read(ADCH)
  return { took, value: admux & 0x20 ? (hi << 2) | (lo >> 6) : (hi << 8) | lo }
}

describe("conversion result: ADC = Vin·1024/Vref (§24.7, Tables 24-3, 24-4)", () => {
  it.each([
    [2.5, 0x40, 512],
    [1.234, 0x40, Math.floor((1.234 * 1024) / 5)],
    [5.0, 0x40, 1023],
    [0.5, 0xc0, Math.floor((0.5 * 1024) / 1.1)],
    [1.5, 0xc0, 1023],
  ])("Vin = %f V, ADMUX REFS = 0x%s → %i", (vin, refs, want) => {
    const m = part((pad) => (pad.port === 2 && pad.pin === 0 ? vin : 0))
    expect(convert(m, refs).value).toBe(want)
  })

  it("channels 6 and 7 are the analog-only ADC6/ADC7 pins of the 32-pin packages (Figure 1-1)", () => {
    const m = part((pad) => (pad.port === ANALOG_PORT ? (pad.pin === 6 ? 1.25 : pad.pin === 7 ? 3.75 : 0) : 0))
    expect(convert(m, 0x46).value).toBe(256)
    expect(convert(m, 0x47).value).toBe(768)
    expect(parsePad("ADC7")).toEqual({ port: ANALOG_PORT, pin: 7 })
    expect(padName({ port: ANALOG_PORT, pin: 6 })).toBe("ADC6")
  })

  it("AREF (REFS = 00) uses the voltage on the AREF pin", () => {
    const m = part((pad) => (pad.pin === 1 && pad.port === 2 ? 1.0 : 0))
    m.setReference(3.3)
    expect(convert(m, 0x01).value).toBe(Math.floor((1.0 * 1024) / 3.3))
  })

  it("channel 14 is the 1.1 V bandgap, channel 15 is GND", () => {
    const m = part()
    expect(convert(m, 0x4e).value).toBe(Math.floor((1.1 * 1024) / 5))
    expect(convert(m, 0x4f).value).toBe(0)
  })

  it("channel 8 is the temperature sensor: 314 mV at 25 °C against the 1.1 V reference (Table 24-2)", () => {
    const m = part()
    expect(convert(m, 0xc8).value).toBe(Math.floor((0.314 * 1024) / 1.1))
  })

  it("ADLAR left-adjusts: 512 reads ADCH = 0x80, ADCL = 0x00 (§24.9.3.2)", () => {
    const m = part(() => 2.5)
    convert(m, 0x60)
    expect(m.read(ADCH)).toBe(0x80)
    expect(m.read(ADCL)).toBe(0x00)
  })
})

describe("timing (§24.4, Table 24-1)", () => {
  it("the first conversion takes 25 ADC clocks, the next ones 13 (prescaler 128)", () => {
    const m = part(() => 1)
    const first = convert(m, 0x40).took
    const next = convert(m, 0x40).took
    // Plus up to one ADC clock waiting for the next rising edge after ADSC.
    expect(first).toBeGreaterThanOrEqual(25 * 128)
    expect(first).toBeLessThanOrEqual(26 * 128)
    expect(next).toBeGreaterThanOrEqual(13 * 128)
    expect(next).toBeLessThanOrEqual(14 * 128)
  })

  it("sample-and-hold is 1.5 ADC clocks after the start of a normal conversion", () => {
    const sampled = (switchAfterClocks: number) => {
      let switchAt = Infinity
      const m = part((_pad, c) => (c >= switchAt ? 4.0 : 1.0))
      convert(m, 0x40) // the 25-clock first conversion out of the way
      // ADEN has run since the first convert: ADC clock edges are every 128 cycles from its enable.
      m.poke(ADCSRA, EN | SC | 7)
      const writeCycle = m.cpu.cycles
      const enableEdge = (m as unknown as { adcClockBase(): number }).adcClockBase?.() ?? 0
      void enableEdge
      // The conversion starts at the first ADC clock edge after the write; find it by watching ADSC timing:
      // instead of peeking, bracket the S/H instant from the write with a margin of one ADC clock.
      switchAt = writeCycle + switchAfterClocks * 128
      for (let i = 0; i < 100000 && m.read(ADCSRA) & SC; i++) m.cpu.run(m.cpu.cycles + 1)
      return (m.read(ADCL) | (m.read(ADCH) << 8)) > 500
    }
    // Before the earliest possible S/H (1.5 clocks after a start at most 1 clock after the write): new value.
    expect(sampled(1.4)).toBe(true)
    // After the latest possible S/H (start 1 clock after the write + 1.5): old value.
    expect(sampled(2.6)).toBe(false)
  })

  it("free running (ADATE, ADTS = 0): a new conversion every 13 ADC clocks without touching ADSC", () => {
    const m = part(() => 1)
    convert(m, 0x40)
    m.poke(ADCSRB, 0)
    m.poke(ADCSRA, EN | SC | ATE | IF | 7)
    let count = 0
    // The first conversion starts on the next ADC clock edge (up to 128 cycles after ADSC).
    const until = m.cpu.cycles + 13 * 128 * 10 + 128 + 16
    while (m.cpu.cycles < until) {
      m.cpu.run(m.cpu.cycles + 16)
      if (m.read(ADCSRA) & IF) {
        count++
        m.poke(ADCSRA, EN | ATE | IF | 7)
      }
    }
    expect(count).toBe(10)
  })

  it("auto trigger on Timer0 overflow: one conversion per TOV0 rising edge (Table 24-6)", () => {
    const m = part(() => 1)
    convert(m, 0x40)
    m.poke(ADCSRB, 0x04)
    m.poke(ADCSRA, EN | ATE | IF | 2) // ADC clock fosc/4: a conversion is short next to the timer period
    m.poke(TCCR0B, 0x01) // TOV0 every 256 cycles, the first 257 cycles after the enable
    let conversions = 0
    const end = m.cpu.cycles + 4 * 256 + 200
    while (m.cpu.cycles < end) {
      m.cpu.run(m.cpu.cycles + 4)
      if (m.read(ADCSRA) & IF) {
        conversions++
        m.poke(ADCSRA, EN | ATE | IF | 2)
        m.poke(TIFR0, 0x01) // clear TOV0 so its next rise is an edge
      }
    }
    expect(conversions).toBe(4)
    // TOV0 left set: no edge, no conversion.
    m.cpu.run(m.cpu.cycles + 600)
    m.poke(ADCSRA, EN | ATE | IF | 2)
    m.cpu.run(m.cpu.cycles + 600)
    expect(m.read(ADCSRA) & IF).toBe(0)
  })
})

describe("data registers and channel changes", () => {
  it("after ADCL is read, a finished conversion does not update ADCL/ADCH until ADCH is read; ADIF still sets (§24.2)", () => {
    let v = 1.0
    const m = part(() => v)
    convert(m, 0x40)
    const lo = m.read(ADCL)
    v = 4.0
    m.poke(ADCSRA, EN | SC | IF | 7)
    m.cpu.run(m.cpu.cycles + 15 * 128)
    expect(m.read(ADCSRA) & IF).toBe(IF)
    const hi = m.read(ADCH)
    expect((hi << 8) | lo).toBe(Math.floor((1.0 * 1024) / 5))
  })

  it("a MUX change during a conversion applies to the next one (§24.5)", () => {
    const m = part((pad) => (pad.port === 2 ? [1.0, 4.0][pad.pin] ?? 0 : 0))
    convert(m, 0x40)
    m.poke(ADCSRA, EN | SC | IF | 7)
    m.cpu.run(m.cpu.cycles + 3 * 128)
    m.poke(ADMUX, 0x41)
    for (let i = 0; i < 100000 && m.read(ADCSRA) & SC; i++) m.cpu.run(m.cpu.cycles + 1)
    expect(m.read(ADCL) | (m.read(ADCH) << 8)).toBe(Math.floor((1.0 * 1024) / 5))
    expect(convert(m, 0x41).value).toBe(Math.floor((4.0 * 1024) / 5))
  })

  it("DIDR0 disables the digital input: PINC reads zero (§24.9.5)", () => {
    const m = part()
    m.setWiredPads([2 * 16 + 0])
    m.setPad(ch(0), true)
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(0x26) & 1).toBe(1)
    m.poke(DIDR0, 0x01)
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(0x26) & 1).toBe(0)
  })

  it("ADC Noise Reduction sleep starts a conversion and its interrupt wakes the part (§24.6)", () => {
    const m = part(() => 2.5)
    convert(m, 0x40)
    // Vector 22 (ADC) → INC r22 via the stub; main: SE + ADC noise mode, SEI, SLEEP, then BREAK.
    m.cpu.flash.fill(0x0000)
    m.cpu.flash.set([0x940c, 0x0040], 0)
    m.cpu.flash.set([0x940c, 0x0100], (22 - 1) * 2)
    m.cpu.flash.set([0x9563, 0x9518], 0x100) // INC r22; RETI
    m.cpu.flash.set([0xe003, 0xbf03, 0x9478, 0x9588, 0x9598], 0x40) // LDI r16,3; OUT SMCR,r16; SEI; SLEEP; BREAK
    m.cpu.invalidate()
    m.poke(ADCSRA, EN | 0x08 | 7) // ADIE, not converting
    m.cpu.pc = 0x40
    m.runUntil(m.time + 1e-3)
    expect(m.cpu.data[22]).toBe(1)
    expect(m.cpu.halted?.detail).toBe("break")
  })
})

describe("analog comparator (§23)", () => {
  it("ACO is set when AIN0 (PD6) is above AIN1 (PD7); ACBG puts the bandgap on the positive input", () => {
    let ain0 = 2.0
    const ain1 = 1.5
    const m = part((pad) => (pad.port === 3 && pad.pin === 6 ? ain0 : pad.port === 3 && pad.pin === 7 ? ain1 : 0))
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(ACSR) & 0x20).toBe(0x20)
    ain0 = 1.0
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(ACSR) & 0x20).toBe(0)
    m.poke(ACSR, 0x40) // ACBG: 1.1 V vs 1.5 V
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(ACSR) & 0x20).toBe(0)
  })

  it.each([
    [0b00, [true, true]],
    [0b10, [false, true]],
    [0b11, [true, false]],
  ])("ACIS = %i sets ACI on [rise, fall] = %j (Table 23-2)", (acis, want) => {
    let ain0 = 1.0
    const m = part((pad) => (pad.port === 3 && pad.pin === 6 ? ain0 : pad.port === 3 && pad.pin === 7 ? 1.5 : 0))
    m.poke(ACSR, acis)
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 4)
    m.poke(ACSR, 0x10 | acis)
    ain0 = 2.0
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 4)
    const rise = (m.read(ACSR) & 0x10) !== 0
    m.poke(ACSR, 0x10 | acis)
    ain0 = 1.0
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 4)
    const fall = (m.read(ACSR) & 0x10) !== 0
    expect([rise, fall]).toEqual(want)
  })

  it("ACME with the ADC off puts ADMUX's channel on the negative input (Table 23-1)", () => {
    const m = part((pad) => (pad.port === 3 && pad.pin === 6 ? 2.0 : pad.port === 3 && pad.pin === 7 ? 1.0 : pad.port === 2 && pad.pin === 3 ? 3.0 : 0))
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(ACSR) & 0x20).toBe(0x20)
    m.poke(ADMUX, 0x03)
    m.poke(ADCSRB, 0x40)
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(ACSR) & 0x20).toBe(0)
  })

  it("silicon erratum 2.4.1 (DS80000855C): ACME set while MUX3 = 1 turns the analog MUX off until ACME is cleared", () => {
    const m = part((pad) => (pad.port === 3 && pad.pin === 6 ? 2.0 : pad.port === 2 && pad.pin === 0 ? 3.0 : 0))
    m.poke(ADMUX, 0x08)
    m.poke(ADCSRB, 0x40) // erratum triggered
    m.poke(ADMUX, 0x00) // ADC0 = 3.0 V on the negative input… if the MUX were on
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(ACSR) & 0x20).toBe(0x20) // 2.0 V against a dead MUX, not against 3.0 V
    expect([...m.unmodelled.keys()].some((k) => k.includes("2.4.1"))).toBe(true)
    m.poke(ADCSRB, 0x00)
    m.poke(ADCSRB, 0x40) // MUX3 is clear now: the MUX works
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.read(ACSR) & 0x20).toBe(0)
  })

  it("ACIC routes the comparator to Timer1 input capture (§23.3.2)", () => {
    let ain0 = 1.0
    const m = part((pad) => (pad.port === 3 && pad.pin === 6 ? ain0 : pad.port === 3 && pad.pin === 7 ? 1.5 : 0))
    m.poke(0x81, 0x41) // TCCR1B: ICES1 rising, clk/1
    m.poke(ACSR, 0x04)
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 100)
    m.poke(0x36, 0x20)
    ain0 = 2.0
    m.analogChanged()
    m.cpu.run(m.cpu.cycles + 10)
    expect(m.read(0x36) & 0x20).toBe(0x20)
  })
})
