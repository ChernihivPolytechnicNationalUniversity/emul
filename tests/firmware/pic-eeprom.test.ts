/**
 * PIC16F628A data EEPROM against DS40044G §13 and DS33023A §7 (rows P3-171…P3-206, P8-088…P8-101 of
 * docs/pic16-checklist.md; decisions D33–D37 there). INTOSC 4 MHz: TCY = 1 µs.
 */
import { describe, expect, it } from "vitest"
import { PIC16F627A, PIC16F628A, PIC16F648A, type PicProfile } from "@/mcu/pic/chip"
import type { PicMcu } from "@/mcu/pic/mcu"
import { createPic } from "@/mcu/pic/parts"
import * as A from "../lib/pic-asm"

const INTCON = 0x0b
const PIR1 = 0x0c
const PIE1 = 0x8c
const EEDATA = 0x9a
const EEADR = 0x9b
const EECON1 = 0x9c
const EECON2 = 0x9d
const EEIF = 0x80
const WRERR = 0x08
const WREN = 0x04
const WR = 0x02
const CONFIG = 0x3e00 | 0x0100 | 0x20 | 0x08 | 0x10 // INTOSC I/O, no WDT/PWRT/BOR/LVP
const BOREN = 0x40
const TCY = 1e-6
const f = (a: number) => a & 0x7f
const spin = (at: number) => A.goto(at)

function part(words: number[], opts: { chip?: PicProfile; config?: number; cells?: [number, number][] } = {}) {
  const m = createPic(opts.chip ?? PIC16F628A)
  m.program(A.prog(words, spin(words.length)), opts.config ?? CONFIG)
  for (const [a, v] of opts.cells ?? []) m.eeprom[a] = v
  return m
}
/** Bank 1, EEADR/EEDATA loaded, WREN set; then `seq` (by default the exact unlock and WR, Example 13-2); then `after`. */
function writer(addr: number, data: number, seq?: number[], after: number[] = []) {
  const unlock = seq ?? A.prog(A.movlw(0x55), A.movwf(f(EECON2)), A.movlw(0xaa), A.movwf(f(EECON2)), A.bsf(f(EECON1), 1))
  return A.prog(A.bsf(A.STATUS, A.RP0), A.movlw(addr), A.movwf(f(EEADR)), A.movlw(data), A.movwf(f(EEDATA)), A.bsf(f(EECON1), 2), unlock, after)
}
const eecon1 = (m: PicMcu) => m.peekFile(EECON1)

describe("data EEPROM registers (Register 13-1…13-3, Table 13-1)", () => {
  it("EECON1 resets to ---- x000; EECON2 reads 0; EEDATA/EEADR keep their value over an MCLR reset (P3-177, P3-178, P3-183, P3-192)", () => {
    const m = part(A.prog(A.bsf(A.STATUS, A.RP0), A.movlw(0x12), A.movwf(f(EEADR)), A.movlw(0x34), A.movwf(f(EEDATA))))
    expect(eecon1(m) & 0x07).toBe(0)
    expect(eecon1(m) & 0xf0).toBe(0)
    m.runUntil(10 * TCY)
    expect(m.readFile(EECON2)).toBe(0)
    m.setMclr(true)
    m.runUntil(m.time + 5 * TCY)
    m.setMclr(false)
    expect([m.peekFile(EEADR), m.peekFile(EEDATA)]).toEqual([0x12, 0x34])
  })

  it("a read: RD set, the byte is in EEDATA for the next instruction; RD reads back 0 (P3-190, P3-193, Example 13-1)", () => {
    const m = part(A.prog(A.bsf(A.STATUS, A.RP0), A.movlw(0x05), A.movwf(f(EEADR)), A.bsf(f(EECON1), 0), A.movf(f(EEDATA), 0)), { cells: [[5, 0xa5]] })
    m.runUntil(10 * TCY)
    expect(m.cpu.w).toBe(0xa5)
    expect(eecon1(m) & 1).toBe(0)
  })

  it("the HEX image's 2100h data is the EEPROM's content (DS41196G §3.9, P7-108)", () => {
    const m = part([], { cells: [[0x7f, 0x42]] })
    expect(m.eeprom[0x7f]).toBe(0x42)
    expect(m.eeprom.length).toBe(128)
    expect(createPic(PIC16F648A).eeprom.length).toBe(256)
  })
})

describe("data EEPROM write (§13.4, Example 13-2)", () => {
  it("the exact sequence writes the byte in 4 ms (D122 typ); WR clears and EEIF sets at the end (P3-189, P3-191, P3-200; D36)", () => {
    const m = part(writer(0x10, 0x5a), { cells: [[0x10, 0xff]] })
    m.runUntil(20 * TCY)
    expect(eecon1(m) & WR).toBe(WR)
    m.runUntil(3.9e-3)
    expect(eecon1(m) & WR).toBe(WR)
    expect(m.eeprom[0x10]).toBe(0xff)
    expect(m.peekFile(PIR1) & EEIF).toBe(0)
    m.runUntil(4.1e-3)
    expect(eecon1(m) & (WR | WRERR)).toBe(0)
    expect(m.peekFile(PIR1) & EEIF).toBe(EEIF)
    expect(m.eeprom[0x10]).toBe(0x5a)
  })

  it("with WREN clear WR does not set and nothing is written (P3-198, P3-188)", () => {
    const seq = A.prog(A.bcf(f(EECON1), 2), A.movlw(0x55), A.movwf(f(EECON2)), A.movlw(0xaa), A.movwf(f(EECON2)), A.bsf(f(EECON1), 1))
    const m = part(writer(0x10, 0x5a, seq), { cells: [[0x10, 0xff]] })
    m.runUntil(20 * TCY)
    expect(eecon1(m) & WR).toBe(0)
    m.runUntil(6e-3)
    expect(m.eeprom[0x10]).toBe(0xff)
  })

  it("one cycle too many inside the sequence and no write starts (P3-196, P3-197; D35)", () => {
    for (const seq of [
      A.prog(A.movlw(0x55), A.movwf(f(EECON2)), A.nop(), A.movlw(0xaa), A.movwf(f(EECON2)), A.bsf(f(EECON1), 1)),
      A.prog(A.movlw(0x55), A.movwf(f(EECON2)), A.movlw(0xaa), A.movwf(f(EECON2)), A.nop(), A.bsf(f(EECON1), 1)),
      A.prog(A.movlw(0xaa), A.movwf(f(EECON2)), A.movlw(0x55), A.movwf(f(EECON2)), A.bsf(f(EECON1), 1)),
      A.prog(A.movlw(0x55), A.movwf(f(EECON2)), A.movlw(0xab), A.movwf(f(EECON2)), A.bsf(f(EECON1), 1)),
    ]) {
      const m = part(writer(0x10, 0x5a, seq), { cells: [[0x10, 0xff]] })
      m.runUntil(6e-3)
      expect(m.eeprom[0x10]).toBe(0xff)
      expect(m.peekFile(PIR1) & EEIF).toBe(0)
    }
  })

  it("WREN cleared after WR is set does not stop the write; WR cannot be cleared by software (P3-184, P3-199)", () => {
    const m = part(writer(0x10, 0x5a, undefined, A.prog(A.bcf(f(EECON1), 2), A.bcf(f(EECON1), 1))), { cells: [[0x10, 0xff]] })
    m.runUntil(30 * TCY)
    expect(eecon1(m) & (WR | WREN)).toBe(WR)
    m.runUntil(5e-3)
    expect(m.eeprom[0x10]).toBe(0x5a)
  })

  it("EEADR and EEDATA are latched by WR; a read during the write returns the old byte (D35, D36)", () => {
    const after = A.prog(A.movlw(0x11), A.movwf(f(EEDATA)), A.movlw(0x20), A.movwf(f(EEADR)), A.movlw(0x10), A.movwf(f(EEADR)), A.bsf(f(EECON1), 0), A.movf(f(EEDATA), 0))
    const m = part(writer(0x10, 0x5a, undefined, after), { cells: [[0x10, 0xc3], [0x20, 0x77]] })
    m.runUntil(40 * TCY)
    expect(m.cpu.w).toBe(0xc3)
    m.runUntil(5e-3)
    expect([m.eeprom[0x10], m.eeprom[0x20]]).toEqual([0x5a, 0x77])
  })

  it("an MCLR reset during the write sets WRERR, clears WR and keeps EEDATA/EEADR (P3-185, P3-187, P8-093; D34, D36)", () => {
    const m = part(writer(0x10, 0x5a), { cells: [[0x10, 0xff]] })
    m.runUntil(1e-3)
    m.setMclr(true)
    m.runUntil(m.time + 10 * TCY)
    m.setMclr(false)
    expect(eecon1(m) & (WRERR | WR | WREN)).toBe(WRERR)
    expect([m.peekFile(EEADR), m.peekFile(EEDATA)]).toEqual([0x10, 0x5a])
    // The program writes again after the reset and the write completes: WRERR clears.
    m.runUntil(m.time + 5e-3)
    expect(eecon1(m) & WRERR).toBe(0)
    expect(m.eeprom[0x10]).toBe(0x5a)
  })

  it("a brown-out reset during the write sets WRERR too (Register 13-3; D34)", () => {
    const m = part(writer(0x10, 0x5a), { config: CONFIG | BOREN, cells: [[0x10, 0xff]] })
    m.runUntil(1e-3)
    expect(eecon1(m) & WR).toBe(WR)
    m.setSupply(3.0)
    m.runUntil(m.time + 0.5e-3)
    m.setSupply(5.0)
    expect(m.lastReset).toBe("brown-out")
    expect(eecon1(m) & (WRERR | WR)).toBe(WRERR)
  })

  it("the write runs on in Sleep and EEIF wakes the part (§14.8.1; D36)", () => {
    const after = A.prog(A.bsf(f(PIE1), 7), A.bcf(A.STATUS, A.RP0), A.movlw(0x40), A.movwf(INTCON), A.sleep(), A.movlw(0x42))
    const m = part(writer(0x10, 0x5a, undefined, after), { cells: [[0x10, 0xff]] })
    m.runUntil(1e-3)
    expect(m.cpu.sleeping).toBe(true)
    m.runUntil(5e-3)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.cpu.w).toBe(0x42)
    expect(m.eeprom[0x10]).toBe(0x5a)
  })

  it("the data survive a power cycle; WREN is clear after power-up (P1-054, P3-202)", () => {
    const m = part(writer(0x10, 0x5a), { cells: [[0x10, 0xff]] })
    m.runUntil(5e-3)
    m.setSupply(0)
    m.runUntil(m.time + 1e-3)
    m.setSupply(5)
    expect(m.lastReset).toBe("power-on")
    expect(m.eeprom[0x10]).toBe(0x5a)
    expect(eecon1(m) & WREN).toBe(0)
  })
})

describe("data EEPROM size and wear (§13.1, §13.7)", () => {
  it("PIC16F627A/628A: EEADR<7> is not decoded, 80h reaches 00h, and the use is reported (P3-179, P3-180; D33)", () => {
    const m = part(writer(0x80, 0x5a), { chip: PIC16F627A, cells: [[0, 0xff]] })
    m.runUntil(5e-3)
    expect(m.eeprom[0]).toBe(0x5a)
    expect([...m.unmodelled.keys()].join()).toMatch(/EEADR/)
  })

  it("PIC16F648A: all 256 bytes (P3-172, P3-179)", () => {
    const m = part(writer(0x80, 0x5a), { chip: PIC16F648A, cells: [[0, 0xff], [0x80, 0xff]] })
    m.runUntil(5e-3)
    expect([m.eeprom[0], m.eeprom[0x80]]).toEqual([0xff, 0x5a])
    expect(m.unmodelled.size).toBe(0)
  })

  it("a byte past the D120 endurance minimum is reported; the write still lands (D37)", () => {
    const m = part(writer(0x10, 0x5a), { cells: [[0x10, 0xff]] })
    m.dataEeprom.wear[0x10] = 100_000
    m.runUntil(5e-3)
    expect(m.eeprom[0x10]).toBe(0x5a)
    expect([...m.unmodelled.keys()].join()).toMatch(/endurance/)
  })

  it("a write with VDD under the operating range leaves a half-done byte and is reported (D121; D36)", () => {
    const m = part(writer(0x10, 0x00), { cells: [[0x10, 0xff]] })
    m.runUntil(1e-3)
    m.setSupply(2.5)
    m.runUntil(5e-3)
    expect([...m.unmodelled.keys()].join()).toMatch(/VDRW|data EEPROM write/)
  })
})
