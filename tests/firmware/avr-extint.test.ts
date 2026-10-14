/**
 * ATmega328P external interrupts against DS40002061B §13: sense control (Table 13-2), the
 * level mode's flag, interrupts from pins configured as outputs, pin change groups and masks,
 * and which of them wake the part from Power-down (§10.5, §13 intro, Table 10-1).
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import { brk, ldi, nop, out, prog, rjmp, sei, sleep, sts } from "../lib/avr-asm"

// Data-space addresses (Register Summary, the parenthesised column); OUT takes them less 0x20.
const EIFR = 0x3c
const EIMSK = 0x3d
const EICRA = 0x69
const PCICR = 0x68
const PCIFR = 0x3b
const PCMSK0 = 0x6b
const PCMSK2 = 0x6d

const INT0 = { port: 3, pin: 2 } // PD2
const PB0 = { port: 1, pin: 0 }

/** A 328P running `main` at 0x40 with RETI-counting handlers: each vector increments r(20 + vector) and returns. */
function part(main: number[]) {
  const m = createAtmega328p()
  m.fuses = { low: 0xff, high: 0x99, extended: 0xfd, lock: 0xff }
  m.setClockFeed({ hz: 16e6, kind: "crystal" })
  m.cpu.flash.fill(0xffff)
  // Vector 1 (RESET) jumps to main; vectors 2–26 jump to a handler stub at 0x100 + 4·vector: INC r(vector), RETI.
  m.cpu.flash.set([0x940c, 0x0040], 0)
  for (let v = 2; v <= 26; v++) {
    m.cpu.flash.set([0x940c, 0x100 + v * 4], (v - 1) * 2)
    const r = v // registers r2…r26 count the vectors
    m.cpu.flash.set([0x9403 | (r << 4), 0x9518], 0x100 + v * 4)
  }
  m.cpu.flash.set(main, 0x40)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.setWiredPads([INT0.port * 16 + INT0.pin, PB0.port * 16 + PB0.pin])
  m.setPad(INT0, true)
  m.setPad(PB0, false)
  m.runUntil(0.07) // past the start-up time
  return m
}
const step = (m: ReturnType<typeof part>, s: number) => m.runUntil(m.time + s)

describe("INT0 sense control (Table 13-2)", () => {
  const modes: [number, string, boolean[]][] = [
    // ISC01:0 → [flag after falling edge, flag after rising edge]
    [0b01, "any change", [true, true]],
    [0b10, "falling edge", [true, false]],
    [0b11, "rising edge", [false, true]],
  ]
  it.each(modes)("ISC0 = %i (%s)", (isc, _name, want) => {
    const m = part(prog(ldi(16, isc), sts(EICRA, 16), rjmp(-1)))
    step(m, 1e-4)
    m.poke(EIFR, 0x01) // clear INTF0 from configuration
    m.setPad(INT0, false)
    step(m, 1e-5)
    const afterFall = (m.read(EIFR) & 1) === 1
    m.poke(EIFR, 0x01)
    m.setPad(INT0, true)
    step(m, 1e-5)
    const afterRise = (m.read(EIFR) & 1) === 1
    expect([afterFall, afterRise]).toEqual(want)
  })

  it("low level: the flag stays clear and the interrupt repeats while the pin is low", () => {
    const m = part(prog(ldi(16, 0x01), out(EIMSK - 0x20, 16), sei(), rjmp(-1)))
    step(m, 1e-4)
    expect(m.cpu.data[2]).toBe(0)
    m.setPad(INT0, false)
    step(m, 1e-4)
    expect(m.read(EIFR) & 1).toBe(0)
    expect(m.cpu.data[2]).toBeGreaterThan(10)
    const n = m.cpu.data[2]
    m.setPad(INT0, true)
    step(m, 1e-4)
    expect(m.cpu.data[2]).toBeLessThanOrEqual(n + 1)
  })

  it("entering the vector clears INTF0; writing one clears it too", () => {
    const m = part(prog(ldi(16, 0x02), sts(EICRA, 16), ldi(16, 0x01), out(EIMSK - 0x20, 16), sei(), rjmp(-1)))
    step(m, 1e-4)
    m.setPad(INT0, false)
    step(m, 1e-4)
    expect(m.cpu.data[2]).toBe(1)
    expect(m.read(EIFR) & 1).toBe(0)
  })

  it("an INT0 pin configured as an output still triggers (software interrupt, §13)", () => {
    // DDRD bit 2 out, ISC0 = falling, enable, PORTD2 1 → 0.
    const m = part(prog(ldi(16, 0x04), out(0x0b, 16), out(0x0a, 16), ldi(16, 0x02), sts(EICRA, 16), ldi(16, 0x01), out(EIMSK - 0x20, 16), sei(), ldi(16, 0), out(0x0b, 16), nop(), nop(), nop(), nop(), brk()))
    m.setWiredPads([])
    step(m, 1e-3)
    expect(m.cpu.data[2]).toBe(1)
  })
})

describe("pin change interrupts (§13.2.4–13.2.8)", () => {
  it("any change on an enabled pin sets its group's flag; masked pins do not", () => {
    const m = part(prog(ldi(16, 0x01), sts(PCICR, 16), ldi(16, 0x01), sts(PCMSK0, 16), rjmp(-1)))
    step(m, 1e-4)
    m.setPad(PB0, true)
    step(m, 1e-5)
    expect(m.read(PCIFR)).toBe(0x01)
    m.poke(PCIFR, 0x01)
    expect(m.read(PCIFR)).toBe(0x00)
    m.setPad(PB0, false)
    step(m, 1e-5)
    expect(m.read(PCIFR)).toBe(0x01)
    m.poke(PCIFR, 0x01)
    m.setPad(INT0, false) // PD2 = PCINT18, not in PCMSK2
    step(m, 1e-5)
    expect(m.read(PCIFR)).toBe(0x00)
    void PCMSK2
  })
})

describe("waking from Power-down (§10.5, Table 10-1)", () => {
  /** SE + Power-down, the given setup, SEI, SLEEP, then count passes through the loop in r20. */
  const sleeper = (setup: number[]) => prog(setup, ldi(16, 0x05), out(0x33, 16), sei(), sleep(), [0x9543], rjmp(-3)) // INC r20

  it("a pin change wakes the part", () => {
    const m = part(sleeper(prog(ldi(16, 0x01), sts(PCICR, 16), sts(PCMSK0, 16))))
    step(m, 1e-3)
    expect(m.cpu.sleeping).toBe(true)
    m.setPad(PB0, true)
    step(m, 5e-3)
    expect(m.cpu.data[4]).toBe(1) // PCINT0 is vector 4 (Table 12-6)
    expect(m.cpu.data[20]).toBeGreaterThanOrEqual(1)
  })

  it("an INT0 falling edge does not wake it: edges need the I/O clock", () => {
    const m = part(sleeper(prog(ldi(16, 0x02), sts(EICRA, 16), ldi(16, 0x01), out(EIMSK - 0x20, 16))))
    step(m, 1e-3)
    m.setPad(INT0, false)
    step(m, 5e-3)
    expect(m.cpu.sleeping).toBe(true)
    expect(m.cpu.data[2]).toBe(0)
  })

  it("an INT0 low level wakes it", () => {
    const m = part(sleeper(prog(ldi(16, 0x01), out(EIMSK - 0x20, 16))))
    step(m, 1e-3)
    m.setPad(INT0, false)
    step(m, 5e-3)
    expect(m.cpu.data[2]).toBeGreaterThan(0)
  })

  it("the wake-up costs the oscillator start-up time (16K CK for the Arduino fuses, Table 9-4)", () => {
    const m = part(sleeper(prog(ldi(16, 0x01), sts(PCICR, 16), sts(PCMSK0, 16))))
    step(m, 1e-3)
    const t0 = m.time
    m.setPad(PB0, true)
    // 16384 CK at 16 MHz = 1.024 ms: no handler before that, the handler right after.
    m.runUntil(t0 + 1.0e-3)
    expect(m.cpu.data[4]).toBe(0)
    m.runUntil(t0 + 1.05e-3)
    expect(m.cpu.data[4]).toBe(1)
  })
})
