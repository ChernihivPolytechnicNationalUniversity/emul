/**
 * The original PIC16F627/628's Rev. A silicon against its errata DS80073F (rows E2-001…E2-006 of
 * docs/pic16-checklist.md; decisions D58, D59, D61, D62): what the part does that DS40300C does not say.
 */
import { describe, expect, it } from "vitest"
import { PIC16F628, PIC16F628A, type PicProfile } from "@/mcu/pic/chip"
import { createPic } from "@/mcu/pic/parts"
import * as A from "../lib/pic-asm"

const CONFIG = 0x3e00 | 0x0100 | 0x20 | 0x08 | 0x10
const TCY = 1e-6
const RA = (pin: number) => ({ port: 0, pin })
const RB = (pin: number) => ({ port: 1, pin })
const bank1 = (...body: number[][]) => A.prog(A.bsf(A.STATUS, A.RP0), ...body, A.bcf(A.STATUS, A.RP0))
function part(chip: PicProfile, body: number[], config = CONFIG) {
  const m = createPic(chip)
  m.program(A.prog(body, A.goto(body.length)), config)
  return m
}

describe("TRISB reads the pins' direction (E2-001; D58)", () => {
  it("the original part reads 1 for RB6/RB7 taken by the Timer1 oscillator although the latch holds 0; the A part reads the latch", () => {
    // TRISB = 00h, then T1OSCEN: RB6/RB7 no longer drive.
    const body = A.prog(bank1(A.clrf(0x86 & 0x7f)), A.movlw(0x08), A.movwf(0x10))
    const o = part(PIC16F628, body)
    o.runUntil(20 * TCY)
    expect(o.readFile(0x86)).toBe(0xc0)
    const a = part(PIC16F628A, body)
    a.runUntil(20 * TCY)
    expect(a.readFile(0x86)).toBe(0x00)
  })
})

describe("MCLR with LVP (E2-005; D62)", () => {
  it("with LVP set, MCLRE = 0 still leaves RA5 as MCLR on the original part, not on the A part", () => {
    const cfg = (CONFIG & ~0x20) | 0x80
    for (const [chip, resets] of [
      [PIC16F628, true],
      [PIC16F628A, false],
    ] as const) {
      const m = part(chip, A.prog(A.nop()), cfg)
      m.runUntil(50 * TCY)
      m.setMclr(true)
      m.runUntil(m.time + 20 * TCY)
      expect(m.inReset, chip.name).toBe(resets)
    }
  })
})

describe("comparator mode 001 (E2-002; D59)", () => {
  function cmp(cis: boolean, volts: number[]) {
    const m = part(PIC16F628, A.prog(A.movlw(cis ? 0x09 : 0x01), A.movwf(0x1f)))
    m.setWiredPads([0, 1, 2, 3])
    volts.forEach((v, i) => m.setAnalog(RA(i), v))
    m.runUntil(20 * TCY)
    return m
  }
  it("CIS = 0 works as on the A part: C1 = RA2 vs RA0, C2 = RA2 vs RA1", () => {
    const m = cmp(false, [1.0, 3.0, 2.0, 2.5])
    expect(m.peekFile(0x1f) >> 6).toBe(0b01)
  })
  it("CIS = 1: C1 is not defined — it keeps its last output — and the use is reported", () => {
    const m = cmp(true, [1.0, 3.0, 2.0, 2.5])
    const was = (m.peekFile(0x1f) >> 6) & 1
    m.setAnalog(RA(3), 0.5)
    m.runUntil(m.time + 10 * TCY)
    expect((m.peekFile(0x1f) >> 6) & 1).toBe(was)
    expect([...m.unmodelled.keys()].join()).toMatch(/E2-002|AN3/)
  })
})

describe("CCP compare, third change between 1000 and 1001 (E2-004; D61)", () => {
  /** A part whose CCP1 compares against TMR1 (1:1, running); CCPR1 = 0100h; mode set by poking. */
  function compare(chip: PicProfile) {
    const m = part(chip, A.prog(A.movlw(0x01), A.movwf(0x16), A.clrf(0x15), bank1(A.bcf(0x86 & 0x7f, 3)), A.movlw(0x01), A.movwf(0x10)))
    m.runUntil(20 * TCY)
    return m
  }
  /** Set CCP1CON, then let TMR1 come round to the match (clear it first). */
  function cycle(m: ReturnType<typeof compare>, mode: number) {
    m.pokeFile(0x17, mode)
    const before = m.ccpOutput
    m.pokeFile(0x0e, 0)
    m.pokeFile(0x0f, 0)
    m.runUntil(m.time + 300 * TCY)
    return { before, after: m.ccpOutput }
  }
  it("on the original part the third change flips the latch at once and inverts every later match; the A part does not", () => {
    const o = compare(PIC16F628)
    expect(cycle(o, 0x08)).toEqual({ before: false, after: true })
    expect(cycle(o, 0x09)).toEqual({ before: true, after: false })
    expect(cycle(o, 0x08)).toEqual({ before: false, after: true })
    // Third change: the latch goes at once to the inverse of CCP1CON<0> (1 → 0), and the match now sets it.
    expect(cycle(o, 0x09)).toEqual({ before: false, after: true })
    expect([...o.unmodelled.keys()].join()).toMatch(/E2-004/)
    // Clearing CCP1CON<3> ends it.
    o.pokeFile(0x17, 0x00)
    expect(cycle(o, 0x09)).toEqual({ before: true, after: false })
    const a = compare(PIC16F628A)
    for (const mode of [0x08, 0x09, 0x08]) cycle(a, mode)
    expect(cycle(a, 0x09)).toEqual({ before: true, after: false })
  })
})

void RB
