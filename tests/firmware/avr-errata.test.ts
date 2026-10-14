/**
 * ATmega328P silicon revisions and the errata that depend on them (DS80000855C §1–2): 2.2.1
 * (Rev. D: the 32 kHz oscillator does not work as the system clock and is inaccurate as the
 * asynchronous timer's), 2.4.1 (every revision: ACME set while MUX3 = 1 turns the analog MUX
 * off). Erratum 2.3.1 (Rev. A, B, TWI) is tested with the TWI.
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"

function part(revision: string, low: number, feed: { hz: number; kind: "crystal" | "clock" } | null): AvrMcu {
  const m = createAtmega328p()
  m.revision = revision
  m.fuses = { low, high: 0x99, extended: 0xfd, lock: 0xff }
  m.setClockFeed(feed)
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  return m
}
const reported = (m: AvrMcu, s: string) => [...m.unmodelled.keys()].some((k) => k.includes(s))

describe("silicon revisions", () => {
  it("the ATmega328P comes in Rev. A, B and D (C never released); the model defaults to the current D", () => {
    const m = createAtmega328p()
    expect(m.chip.revisions).toEqual(["A", "B", "D"])
    expect(m.revision).toBe("D")
  })
})

describe("erratum 2.2.1: unstable 32 kHz oscillator (Rev. D)", () => {
  const LFXTAL = 0xe5 // CKSEL 0101: low-frequency crystal, SUT 10
  const XTAL32 = { hz: 32768, kind: "crystal" as const }

  it("Rev. D: the low-frequency crystal oscillator does not clock the system", () => {
    const m = part("D", LFXTAL, XTAL32)
    m.runUntil(3)
    expect(m.cpu.instructions).toBe(0)
    expect(m.clockProblem()).toMatch(/2\.2\.1/)
  })

  it("Rev. B: the same fuses and crystal run the core at 32.768 kHz", () => {
    const m = part("B", LFXTAL, XTAL32)
    m.runUntil(3)
    expect(m.cpu.instructions).toBeGreaterThan(30000)
  })

  it("Rev. D: the asynchronous timer on the 32 kHz crystal is reported inaccurate; Rev. B is not", () => {
    for (const [rev, want] of [
      ["D", true],
      ["B", false],
    ] as const) {
      const m = part(rev, 0xe2, XTAL32)
      m.runUntil(0.1)
      m.poke(0xb6, 0x20)
      expect(reported(m, "2.2.1")).toBe(want)
    }
  })
})

describe("erratum 2.4.1: ACME with MUX3 set turns the analog MUX off (every revision)", () => {
  it.each(["A", "B", "D"])("Rev. %s", (rev) => {
    const m = part(rev, 0xe2, null)
    m.runUntil(0.1)
    m.poke(0x7c, 0x08) // ADMUX: MUX3
    m.poke(0x7b, 0x40) // ADCSRB: ACME
    expect(reported(m, "2.4.1")).toBe(true)
  })
})
