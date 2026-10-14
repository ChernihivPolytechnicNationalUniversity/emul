/**
 * PIC16F628A comparators and voltage reference against DS40044G §10, §11 and the PDF's Figure 10-1
 * (rows P3-001…P3-072, P9-180…P9-218 of docs/pic16-checklist.md; decisions D21–D23 there).
 */
import { describe, expect, it } from "vitest"
import { PIC16F627, PIC16F628A, type PicProfile } from "@/mcu/pic/chip"
import { createPic } from "@/mcu/pic/parts"
import * as A from "../lib/pic-asm"

const PORTA = 0x05
const INTCON = 0x0b
const PIR1 = 0x0c
const CMCON = 0x1f
const TRISA = 0x85
const PIE1 = 0x8c
const VRCON = 0x9f
const CONFIG = 0x3e00 | 0x0100 | 0x20 | 0x08 | 0x10
const TCY = 1e-6
const RA = (pin: number) => ({ port: 0, pin })
const bank1 = (...body: number[][]) => A.prog(A.bsf(A.STATUS, A.RP0), ...body, A.bcf(A.STATUS, A.RP0))

/** A part whose program sets CMCON (and whatever `extra` does) and spins; RA0–RA4 at the given volts. */
function part(cmcon: number, volts: number[], extra: number[] = [], chip: PicProfile = PIC16F628A) {
  const m = createPic(chip)
  const body = A.prog(extra, A.movlw(cmcon), A.movwf(CMCON))
  m.program(A.prog(body, A.goto(body.length)), CONFIG)
  m.setWiredPads([0, 1, 2, 3, 4])
  volts.forEach((v, i) => {
    m.setAnalog(RA(i), v)
    m.setPad(RA(i), v > 2.5)
  })
  m.runUntil(20 * TCY)
  return m
}
const outs = (m: ReturnType<typeof part>) => m.peekFile(CMCON) >> 6

describe("comparator modes (Figure 10-1)", () => {
  it("100, two independent comparators: C1 = RA3 vs RA0, C2 = RA2 vs RA1; COUT = 1 when VIN+ > VIN- (Register 10-1)", () => {
    // RA0 1.0, RA1 3.0, RA2 2.0, RA3 2.5 → C1: 2.5 > 1.0 → 1; C2: 2.0 > 3.0? no → 0.
    expect(outs(part(0x04, [1.0, 3.0, 2.0, 2.5]))).toBe(0b01)
    expect(outs(part(0x04, [3.0, 1.0, 2.0, 2.5]))).toBe(0b10)
  })

  it("CnINV inverts the outputs (Register 10-1 bits 5:4)", () => {
    expect(outs(part(0x04 | 0x30, [1.0, 3.0, 2.0, 2.5]))).toBe(0b10)
  })

  it("011, a common reference on RA2: C1 = RA2 vs RA0, C2 = RA2 vs RA1; RA3 is a digital input (PDF Figure 10-1)", () => {
    const m = part(0x03, [1.0, 3.0, 2.0, 4.5], A.movf(PORTA, 0))
    expect(outs(m)).toBe(0b01)
    m.pokeFile(0x20, 0)
    expect(m.readFile(PORTA) & 0x0f).toBe(0x08)
  })

  it("110 drives C1 out on RA3 (CMOS) and C2 out on RA4 (open drain); TRISA still enables them (§10.5)", () => {
    // C1 = RA2 (2.0) vs RA0 (1.0) → 1; C2 = RA2 vs RA1 (3.0) → 0.
    const m = part(0x06, [1.0, 3.0, 2.0, 0, 0], bank1(A.movlw(0xe7), A.movwf(TRISA & 0x7f)))
    expect(outs(m)).toBe(0b01)
    expect(m.padDrive(RA(3))).toBe("high")
    expect(m.padDrive(RA(4))).toBe("low")
    const off = part(0x06, [1.0, 3.0, 2.0, 0, 0])
    expect([off.padDrive(RA(3)), off.padDrive(RA(4))]).toEqual([null, null])
    // C2 high → RA4 released (open drain).
    const c2 = part(0x06, [1.0, 1.5, 2.0, 0, 0], bank1(A.movlw(0xe7), A.movwf(TRISA & 0x7f)))
    expect(c2.padDrive(RA(4))).toBe(null)
  })

  it("101, one comparator: C1 off and reading 0, RA0/RA3 digital; C2 = RA2 vs RA1", () => {
    const m = part(0x05, [4.5, 1.0, 2.0, 4.5])
    expect(outs(m)).toBe(0b10)
    expect(m.readFile(PORTA) & 0x0f).toBe(0x09)
  })

  it("001, three inputs: C1 VIN- = RA0 or RA3 by CIS, both VIN+ on RA2, no outputs on the pins (Figure 10-1; decision D21)", () => {
    expect(outs(part(0x01, [1.0, 3.0, 2.0, 2.5]))).toBe(0b01)
    expect(outs(part(0x09, [1.0, 3.0, 2.0, 2.5]))).toBe(0b00)
    const m = part(0x01, [1.0, 3.0, 2.0, 2.5], bank1(A.movlw(0xe7), A.movwf(TRISA & 0x7f)))
    expect(m.padDrive(RA(3))).not.toBe("high")
  })

  it("010, four inputs against VREF: CIS picks RA0/RA1 or RA3/RA2 (§10.3.2, Register 10-1)", () => {
    // VREF on, low range, VR = 12 → 12/24 · 5 = 2.5 V.
    const vref = bank1(A.movlw(0xac), A.movwf(VRCON & 0x7f))
    // CIS = 0: C1 = 2.5 vs RA0 (1.0) → 1, C2 = 2.5 vs RA1 (3.0) → 0. CIS = 1: C1 vs RA3 (3.0) → 0, C2 vs RA2 (1.0) → 1.
    expect(outs(part(0x02, [1.0, 3.0, 1.0, 3.0], vref))).toBe(0b01)
    expect(outs(part(0x0a, [1.0, 3.0, 1.0, 3.0], vref))).toBe(0b10)
  })

  it("000 (reset) and 111 (off): both read 0; RA0–RA3 read 0 in 000 and as digital inputs in 111", () => {
    const r = part(0x00, [1.0, 3.0, 4.0, 4.5])
    expect(outs(r)).toBe(0)
    expect(r.readFile(PORTA) & 0x0f).toBe(0)
    const o = part(0x07, [1.0, 3.0, 4.0, 4.5])
    expect(outs(o)).toBe(0)
    expect(o.readFile(PORTA) & 0x0f).toBe(0x0e)
  })

  it("C1OUT and C2OUT are read-only", () => {
    const m = part(0x04, [1.0, 3.0, 2.0, 2.5])
    m.pokeFile(CMCON, 0xc4)
    expect(outs(m)).toBe(0b01)
  })
})

describe("comparator interrupt (§10.6)", () => {
  it("CMIF sets on an output change; the mismatch keeps setting it until CMCON is read (§10.6 a/b)", () => {
    const m = part(0x04, [1.0, 3.0, 2.0, 2.5], A.movf(CMCON, 0))
    m.pokeFile(PIR1, 0)
    m.readFile(CMCON)
    m.setAnalog(RA(3), 0.5)
    m.runUntil(m.time + 5 * TCY)
    expect(m.peekFile(PIR1) & 0x40).toBe(0x40)
    m.pokeFile(PIR1, 0)
    m.runUntil(m.time + 5 * TCY)
    expect(m.peekFile(PIR1) & 0x40).toBe(0x40)
    m.readFile(CMCON)
    m.pokeFile(PIR1, 0)
    m.runUntil(m.time + 5 * TCY)
    expect(m.peekFile(PIR1) & 0x40).toBe(0)
  })

  it("the comparators keep working in Sleep and their interrupt wakes the part (§10.7)", () => {
    const m = createPic(PIC16F628A)
    const body = A.prog(A.movlw(0x04), A.movwf(CMCON), A.movf(CMCON, 0), A.bcf(PIR1, 6), bank1(A.bsf(PIE1 & 0x7f, 6)), A.bsf(INTCON, 6), A.sleep(), A.movlw(0x42))
    m.program(A.prog(body, A.goto(body.length)), CONFIG)
    m.setWiredPads([0, 1, 2, 3])
    for (const [i, v] of [1.0, 3.0, 2.0, 2.5].entries()) m.setAnalog(RA(i), v)
    m.runUntil(30 * TCY)
    expect(m.cpu.sleeping).toBe(true)
    m.setAnalog(RA(3), 0.5)
    m.runUntil(m.time + 30 * TCY)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.cpu.w).toBe(0x42)
  })

  it("a reset puts CMCON back to 000 (§10.8)", () => {
    const m = part(0x07, [1.0, 3.0, 4.0, 4.5])
    m.setMclr(true)
    m.runUntil(m.time + 5 * TCY)
    m.setMclr(false)
    expect(m.peekFile(CMCON)).toBe(0)
  })

  it("mode 001 is defective on the original PIC16F627 (DS40300C Figure 9-1): reported, outputs held at 0 (decision D22)", () => {
    const m = part(0x01, [1.0, 3.0, 2.0, 2.5], [], PIC16F627)
    expect(outs(m)).toBe(0)
    expect([...m.unmodelled.keys()].join()).toMatch(/defective/)
  })
})

describe("voltage reference (§11)", () => {
  /** VREF volts the module makes with VRCON = v at VDD 5 V. */
  const vref = (v: number) => {
    const m = part(0x07, [0, 0, 0, 0], bank1(A.movlw(v), A.movwf(VRCON & 0x7f), A.bsf(TRISA & 0x7f, 2)))
    return m
  }

  it("Example 11-1: VRCON = A6h at VDD = 5 V gives 1.25 V", () => {
    expect(vref(0xa6).vrefVolts()).toBeCloseTo(1.25, 6)
  })

  it("both ranges, every tap, against the equations and DS33023A Table 19-1 (P9-180)", () => {
    const low = [0.0, 0.21, 0.42, 0.63, 0.83, 1.04, 1.25, 1.46, 1.67, 1.88, 2.08, 2.29, 2.5, 2.71, 2.92, 3.13]
    const high = [1.25, 1.41, 1.56, 1.72, 1.88, 2.03, 2.19, 2.34, 2.5, 2.66, 2.81, 2.97, 3.13, 3.28, 3.44, 3.59]
    for (let vr = 0; vr < 16; vr++) {
      expect(vref(0xa0 | vr).vrefVolts(), `low ${vr}`).toBeCloseTo(low[vr], 1)
      expect(vref(0x80 | vr).vrefVolts(), `high ${vr}`).toBeCloseTo(high[vr], 1)
      expect(vref(0xa0 | vr).vrefVolts()).toBeCloseTo((vr / 24) * 5, 9)
      expect(vref(0x80 | vr).vrefVolts()).toBeCloseTo(5 / 4 + (vr / 32) * 5, 9)
    }
  })

  it("VROE puts VREF on RA2 when TRISA<2> = 1, through the ladder's resistance (§11, Figure 11-1, D312 R = 2 kΩ)", () => {
    const m = vref(0xe6)
    expect(m.padDrive(RA(2))).toBeCloseTo(1.25, 6)
    // Low range, tap 6 of 24 R: 6R ∥ 18R = 4.5 R = 9 kΩ.
    expect(m.vrefOutput()!.ohms).toBeCloseTo(9000, 0)
    const off = vref(0xa6)
    expect(off.padDrive(RA(2))).toBe(null)
  })

  it("VREN = 0 powers it down: nothing on RA2 (decision D23)", () => {
    const m = vref(0x66)
    expect(m.padDrive(RA(2))).toBe(null)
  })

  it("a reset clears VRCON (§11.4)", () => {
    const m = vref(0xe6)
    m.setMclr(true)
    m.runUntil(m.time + 5 * TCY)
    m.setMclr(false)
    expect(m.peekFile(VRCON)).toBe(0)
  })
})
