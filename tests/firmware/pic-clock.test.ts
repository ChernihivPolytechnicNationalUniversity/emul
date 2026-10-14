/**
 * Clock limits and the original PIC16F627/628's own points (checklist P5-018…P5-020, P5-160…P5-175,
 * P6-001…P6-034; decisions D38–D43): the voltage–frequency region, the oscillator modes' ranges, the
 * ordering grades, the ER oscillator and the Timer1 crystal.
 */
import { describe, expect, it } from "vitest"
import {
  PIC16F627,
  PIC16F627_04,
  PIC16F628,
  PIC16F628A,
  PIC16F648A,
  PIC16LF627,
  PIC16LF628A,
  erFrequency,
  maxFosc,
  type PicProfile,
} from "@/mcu/pic/chip"
import { createPic } from "@/mcu/pic/parts"
import * as A from "../lib/pic-asm"

const MCLRE = 0x20
const NO_PWRT = 0x08
const BASE = 0x3e00 | 0x0100 | MCLRE | NO_PWRT
const HS = BASE | 0x02
const XT = BASE | 0x01
const LP = BASE
const EC = BASE | 0x03
const INTOSC = BASE | 0x10
const RC = BASE | 0x13

function part(chip: PicProfile, config: number, feed?: { hz: number; kind: "crystal" | "clock" | "rc" }, vdd = 5) {
  const m = createPic(chip)
  if (feed) m.setClockFeed(feed)
  m.program(A.prog(A.goto(0)), config)
  m.setSupply(vdd)
  m.runUntil(1e-3)
  return m
}
const reports = (m: ReturnType<typeof part>) => [...m.unmodelled.keys()].join("\n")

describe("voltage–frequency region (Figures 17-1…17-3, read from the PDF; D38)", () => {
  it("F parts: 10 MHz at 3.0 V, 20 MHz from 4.5 V, linear between; nothing under 3.0 V", () => {
    expect(maxFosc(PIC16F628A, 5.0)).toBe(20e6)
    expect(maxFosc(PIC16F628A, 4.5)).toBe(20e6)
    expect(maxFosc(PIC16F628A, 3.75)).toBeCloseTo(15e6, 0)
    expect(maxFosc(PIC16F628A, 3.0)).toBe(10e6)
    expect(maxFosc(PIC16F628A, 2.9)).toBe(0)
  })

  it("LF parts: 4 MHz from 2.0 to 3.0 V, then as the F part", () => {
    expect(maxFosc(PIC16LF628A, 2.0)).toBe(4e6)
    expect(maxFosc(PIC16LF628A, 2.9)).toBe(4e6)
    expect(maxFosc(PIC16LF628A, 3.0)).toBe(10e6)
    expect(maxFosc(PIC16LF628A, 1.9)).toBe(0)
  })

  it("the original's grades: PIC16F627-04 and PIC16LF627 stop at 4 MHz, PIC16F627(-20) at 20 MHz (Table 4-1, ordering; P6-034)", () => {
    expect(maxFosc(PIC16F627, 5.0)).toBe(20e6)
    expect(maxFosc(PIC16F627_04, 5.0)).toBe(4e6)
    expect(maxFosc(PIC16LF627, 5.0)).toBe(4e6)
    expect(maxFosc(PIC16LF627, 2.0)).toBe(4e6)
  })

  it("20 MHz at 3.3 V runs and is reported; 20 MHz at 5 V is not", () => {
    const low = part(PIC16F628A, HS, { hz: 20e6, kind: "crystal" }, 3.3)
    expect(low.cpu.cycles).toBeGreaterThan(0)
    expect(reports(low)).toMatch(/Figure 17-1/)
    expect(reports(part(PIC16F628A, HS, { hz: 20e6, kind: "crystal" }))).toBe("")
  })

  it("the PIC16F627-04 on a 20 MHz crystal runs and is reported against its grade", () => {
    const m = part(PIC16F627_04, HS, { hz: 20e6, kind: "crystal" })
    expect(m.hz).toBe(5e6)
    expect(reports(m)).toMatch(/-04/)
    expect(reports(part(PIC16F627_04, INTOSC))).toBe("")
    expect(reports(part(PIC16F627_04, XT, { hz: 4e6, kind: "crystal" }))).toBe("")
  })

  it("an LF part at 2.5 V on INTOSC is in range; the F part at 2.5 V is not (D001)", () => {
    expect(reports(part(PIC16LF628A, INTOSC, undefined, 2.5))).toBe("")
    expect(reports(part(PIC16F628A, INTOSC, undefined, 2.5))).toMatch(/operating range/)
  })
})

describe("oscillator mode ranges (Table 17-4; D38)", () => {
  it("LP over 200 kHz, XT over 4 MHz or a crystal under 100 kHz, HS crystal under 1 MHz, EC over 20 MHz, RC over 4 MHz are reported", () => {
    expect(reports(part(PIC16F628A, LP, { hz: 32768, kind: "crystal" }))).toBe("")
    expect(reports(part(PIC16F628A, LP, { hz: 1e6, kind: "crystal" }))).toMatch(/LP/)
    expect(reports(part(PIC16F628A, XT, { hz: 8e6, kind: "crystal" }))).toMatch(/XT/)
    expect(reports(part(PIC16F628A, XT, { hz: 32768, kind: "crystal" }))).toMatch(/XT/)
    expect(reports(part(PIC16F628A, XT, { hz: 32768, kind: "clock" }))).toBe("")
    expect(reports(part(PIC16F628A, HS, { hz: 500e3, kind: "crystal" }))).toMatch(/HS/)
    expect(reports(part(PIC16F628A, HS, { hz: 500e3, kind: "clock" }))).toBe("")
    expect(reports(part(PIC16F628A, EC, { hz: 24e6, kind: "clock" }))).toMatch(/EC/)
    expect(reports(part(PIC16F628A, RC, { hz: 6e6, kind: "rc" }))).toMatch(/RC/)
  })
})

describe("ER oscillator of the original part (DS40300C §14.2.4, Table 14-3; D39)", () => {
  it("Table 14-3: 1k 10 MHz, 10k 7.4 MHz, 47k 3 MHz, 100k 1.6 MHz, 470k 300 kHz, 1M 200 kHz", () => {
    for (const [r, f] of [
      [1e3, 10e6],
      [10e3, 7.4e6],
      [47e3, 3e6],
      [100e3, 1.6e6],
      [470e3, 300e3],
      [1e6, 200e3],
    ])
      expect(erFrequency(r)).toBeCloseTo(f, 0)
  })

  it("past 1 MΩ it keeps falling, and stops under 10 kHz", () => {
    expect(erFrequency(2e6)!).toBeLessThan(200e3)
    expect(erFrequency(2e6)!).toBeGreaterThan(10e3)
    expect(erFrequency(1e9)).toBe(null)
  })

  it("the resistor sets the clock; outside 10k–1M it is reported; a stopped oscillator is a clock problem", () => {
    const m = createPic(PIC16F628)
    m.program(A.prog(A.goto(0)), RC)
    m.setErResistor(100e3)
    expect(m.fosc).toBeCloseTo(1.6e6, 0)
    expect(reports(m)).toBe("")
    m.setErResistor(4.7e3)
    expect(reports(m)).toMatch(/10 kΩ/)
    m.setErResistor(1e9)
    expect(m.fosc).toBe(0)
    expect(m.clockProblem()).toMatch(/stop/)
  })
})

describe("the original part's registers and memory (P6-001, P6-025, P6-027; D41)", () => {
  it("128 bytes of EEPROM, 224 bytes of RAM and no bank-2 RAM past 14Fh", () => {
    const m = createPic(PIC16F627)
    expect(m.eeprom.length).toBe(128)
    m.program(A.prog(A.goto(0)), INTOSC)
    m.pokeFile(0x14f, 0x5a)
    m.pokeFile(0x150, 0x5a)
    expect([m.peekFile(0x14f), m.peekFile(0x150)]).toEqual([0x5a, 0])
    expect(createPic(PIC16F648A).eeprom.length).toBe(256)
  })

  it("TRISA5 reads 1 and RCSTA<3> (ADEN) is a R/W-0 bit, as on the A part", () => {
    const m = part(PIC16F627, INTOSC)
    expect(m.readFile(0x85) & 0x20).toBe(0x20)
    expect(m.peekFile(0x18) & 0x08).toBe(0)
    m.pokeFile(0x18, 0x08)
    expect(m.peekFile(0x18) & 0x08).toBe(0x08)
  })
})

describe("Timer1 crystal (§7.6; D42)", () => {
  it("the A part is rated for 32.768 kHz; a 100 kHz crystal runs and is reported", () => {
    const m = part(PIC16F628A, INTOSC)
    m.setT1Oscillator({ hz: 32768, kind: "crystal", startup: 0 })
    expect(reports(m)).toBe("")
    m.setT1Oscillator({ hz: 100e3, kind: "crystal", startup: 0 })
    expect(reports(m)).toMatch(/Timer1/)
  })

  it("the original part takes up to 200 kHz", () => {
    const m = part(PIC16F627, INTOSC)
    m.setT1Oscillator({ hz: 200e3, kind: "crystal", startup: 0 })
    expect(reports(m)).toBe("")
    m.setT1Oscillator({ hz: 300e3, kind: "crystal", startup: 0 })
    expect(reports(m)).toMatch(/Timer1/)
  })
})

describe("the original part's start-up and oscillator behaviour (P6-005, P6-009, P6-013, P6-024)", () => {
  it("BODEN forces the 72 ms power-up timer on, whatever PWRTE says; the A part does not (DS40300C Register 14-1 note 1)", () => {
    const BODEN = 0x40
    for (const [chip, held] of [
      [PIC16F627, true],
      [PIC16F628A, false],
    ] as const) {
      const m = createPic(chip)
      m.program(A.prog(A.movlw(0x42), A.goto(1)), INTOSC | BODEN)
      m.runUntil(60e-3)
      expect(m.cpu.w === 0x42, chip.name).toBe(!held)
      m.runUntil(80e-3)
      expect(m.cpu.w).toBe(0x42)
    }
  })

  it("ER mode keeps the dual speed: OSCF = 0 is the fixed 37 kHz, OSCF = 1 the resistor's frequency (§14.3, PCON note 1)", () => {
    const m = createPic(PIC16F628)
    m.setErResistor(100e3)
    // BSF STATUS,RP0; BCF PCON,OSCF; spin.
    m.program(A.prog(A.bsf(A.STATUS, A.RP0), A.bcf(0x0e, 3), A.goto(2)), RC)
    expect(m.fosc).toBeCloseTo(1.6e6, 0)
    m.runUntil(1e-3)
    expect(m.fosc).toBe(37e3)
  })

  it("PCON after power-on: OSCF = 1, POR = 0 (---- 1-0x, Register 3-6)", () => {
    const m = part(PIC16F627, INTOSC)
    expect(m.peekFile(0x8e) & 0x0a).toBe(0x08)
  })

  it("no oscillator start-up after Sleep in INTRC mode (Table 14-4 '—'); the A part's INTOSC takes F14's 3 µs at 5 V", () => {
    for (const [chip, wait] of [
      [PIC16F627, 0],
      [PIC16F628A, 3e-6],
    ] as const) {
      const m = createPic(chip)
      // INTE, SLEEP, then a spin; RB0 rises at 100 µs.
      m.program(A.prog(A.movlw(0x10), A.movwf(0x0b), A.sleep(), A.goto(3)), INTOSC)
      m.setWiredPads([16])
      m.setPad({ port: 1, pin: 0 }, false)
      m.setPadAt({ port: 1, pin: 0 }, true, 100e-6)
      m.runUntil(200e-6)
      expect(m.wokeAt! - 100e-6, chip.name).toBeCloseTo(wait, 6)
    }
  })
})
