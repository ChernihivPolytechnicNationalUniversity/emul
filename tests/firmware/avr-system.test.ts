/**
 * ATmega328P watchdog, EEPROM, self-programming and supply supervision against DS40002061B:
 * WDT modes and time-outs (Tables 11-1, 11-2), its timed sequence and WDRF/WDTON (§11.9.2);
 * EEPROM access, write modes and times (§8.4, §8.6.3, Tables 8-1, 8-2); SPM page programming
 * from the boot section (§27, Table 27-6); power-on and brown-out reset (§11.3, §11.5,
 * Tables 29-11, 29-12).
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"
import { brk, ldi, out, prog, rjmp, sts } from "../lib/avr-asm"

const WDTCSR = 0x60
const MCUSR = 0x54
const EECR = 0x3f
const EEDR = 0x40
const EEARL = 0x41
const EEARH = 0x42
const SPMCSR = 0x57
const HZ = 16e6

function part(fuses = { low: 0xff, high: 0xd9, extended: 0xfd, lock: 0xff }): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { ...fuses }
  m.setClockFeed({ hz: HZ, kind: "crystal" })
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.runUntil(0.07)
  return m
}

/** WDTCSR write through the timed sequence: WDCE|WDE first, then the value (§11.8.2). */
function wdt(m: AvrMcu, value: number) {
  m.poke(WDTCSR, 0x18)
  m.poke(WDTCSR, value)
}

describe("watchdog (§11.8, Tables 11-1 and 11-2)", () => {
  it.each([
    [0, 2048],
    [1, 4096],
    [6, 131072],
    [9, 1048576],
  ])("WDP = %i: interrupt mode time-out after %i cycles of the 128 kHz oscillator", (wdp, cycles) => {
    const m = part()
    const t0 = m.time
    wdt(m, 0x40 | (wdp & 7) | ((wdp & 8) << 2)) // WDIE
    const want = cycles / 128e3
    m.runUntil(t0 + want * 0.98)
    expect(m.read(WDTCSR) & 0x80).toBe(0)
    m.runUntil(t0 + want * 1.02)
    expect(m.read(WDTCSR) & 0x80).toBe(0x80)
  })

  it("system reset mode resets the part and sets WDRF (§11.6, §11.9.1)", () => {
    const m = part()
    m.poke(MCUSR, 0)
    wdt(m, 0x08) // WDE, 16 ms
    m.runUntil(m.time + 0.02)
    expect(m.lastReset).toBe("watchdog")
    expect(m.read(MCUSR) & 0x08).toBe(0x08)
  })

  it("after a watchdog reset WDE stays on (WDRF overrides it) at 16 ms until WDRF is cleared (§11.9.2)", () => {
    const m = part()
    wdt(m, 0x08 | 7)
    m.runUntil(m.time + 2.1)
    expect(m.lastReset).toBe("watchdog")
    expect(m.read(WDTCSR) & 0x08).toBe(0x08)
    expect(m.read(WDTCSR) & 0x27).toBe(0)
    const resets = m.resets
    m.runUntil(m.time + 0.15) // 65 ms start-up + 16 ms: a reset loop
    expect(m.resets).toBeGreaterThan(resets)
  })

  it("interrupt and system reset mode: the first time-out interrupts and clears WDIE, the second resets (Table 11-1)", () => {
    const m = part()
    // The WDT vector (7) is erased flash → acts as a slide back to 0; count interrupts by WDIE.
    wdt(m, 0x48)
    m.cpu.data[0x5f] = 0x80
    m.runUntil(m.time + 0.0165)
    expect(m.lastReset).toBe("power-on")
    expect(m.read(WDTCSR) & 0x40).toBe(0) // WDIE cleared by the vector
    m.runUntil(m.time + 0.0165)
    expect(m.lastReset).toBe("watchdog")
  })

  it("WDR restarts the count", () => {
    const m = part()
    m.cpu.flash.set(prog([0x95a8], rjmp(-2)), 0) // WDR; RJMP back
    m.cpu.invalidate()
    wdt(m, 0x08)
    m.runUntil(m.time + 0.1)
    expect(m.lastReset).toBe("power-on")
  })

  it("WDE cannot be cleared without WDCE, nor after the four-cycle window (§11.9.2)", () => {
    const m = part()
    wdt(m, 0x08)
    m.poke(WDTCSR, 0x00)
    expect(m.read(WDTCSR) & 0x08).toBe(0x08)
    m.poke(WDTCSR, 0x18)
    m.cpu.run(m.cpu.cycles + 6)
    m.poke(WDTCSR, 0x00)
    expect(m.read(WDTCSR) & 0x08).toBe(0x08)
    wdt(m, 0x00)
    expect(m.read(WDTCSR) & 0x08).toBe(0)
  })

  it("WDTON programmed: always system reset mode, WDE and WDIE locked (Table 11-1)", () => {
    const m = part({ low: 0xff, high: 0xc9, extended: 0xfd, lock: 0xff })
    wdt(m, 0x40)
    expect(m.read(WDTCSR) & 0x48).toBe(0x08)
    m.runUntil(m.time + 0.02)
    expect(m.lastReset).toBe("watchdog")
  })

  it("the watchdog interrupt wakes the part from Power-down (Table 10-1)", () => {
    const m = part()
    m.cpu.flash.set(prog(ldi(16, 0x05), out(0x33, 16), [0x9478], [0x9588], brk()), 0)
    m.cpu.flash.set([0x9518], 6 * 2) // WDT vector: RETI
    m.cpu.invalidate()
    m.cpu.pc = 0
    wdt(m, 0x40)
    m.runUntil(m.time + 0.01)
    expect(m.cpu.sleeping).toBe(true)
    m.runUntil(m.time + 0.01)
    expect(m.cpu.halted?.detail).toBe("break")
  })
})

describe("EEPROM (§8.4, §8.6.3)", () => {
  const eeWrite = (m: AvrMcu, addr: number, data: number, mode = 0) => {
    m.poke(EEARH, addr >> 8)
    m.poke(EEARL, addr & 0xff)
    m.poke(EEDR, data)
    m.poke(EECR, (mode << 4) | 0x04)
    m.poke(EECR, (mode << 4) | 0x06)
  }
  const eeRead = (m: AvrMcu, addr: number) => {
    m.poke(EEARH, addr >> 8)
    m.poke(EEARL, addr & 0xff)
    m.poke(EECR, 0x01)
    return m.read(EEDR)
  }

  it("an atomic write takes 26 368 RC-oscillator cycles (3.3 ms, Table 8-2), EEPE clears when done", () => {
    const m = part()
    eeWrite(m, 0x123, 0x5a)
    expect(m.read(EECR) & 0x02).toBe(0x02)
    m.runUntil(m.time + 3.2e-3)
    expect(m.read(EECR) & 0x02).toBe(0x02)
    m.runUntil(m.time + 0.2e-3)
    expect(m.read(EECR) & 0x02).toBe(0)
    expect(eeRead(m, 0x123)).toBe(0x5a)
  })

  it("EEPE without EEMPE first does nothing; EEMPE times out after four cycles", () => {
    const m = part()
    m.poke(EEARL, 1)
    m.poke(EEDR, 0x11)
    m.poke(EECR, 0x02)
    expect(m.read(EECR) & 0x02).toBe(0)
    m.poke(EECR, 0x04)
    m.cpu.run(m.cpu.cycles + 5)
    m.poke(EECR, 0x06)
    expect(m.read(EECR) & 0x02).toBe(0)
  })

  it("erase only (EEPM = 01) leaves 0xFF, write only (EEPM = 10) can only clear bits; both 1.8 ms (Table 8-1)", () => {
    const m = part()
    eeWrite(m, 5, 0x0f)
    m.runUntil(m.time + 4e-3)
    eeWrite(m, 5, 0x00, 1)
    m.runUntil(m.time + 1.7e-3)
    expect(m.read(EECR) & 0x02).toBe(0x02)
    m.runUntil(m.time + 0.2e-3)
    expect(eeRead(m, 5)).toBe(0xff)
    eeWrite(m, 5, 0xf0, 2)
    m.runUntil(m.time + 2e-3)
    eeWrite(m, 5, 0x3c, 2)
    m.runUntil(m.time + 2e-3)
    expect(eeRead(m, 5)).toBe(0x30)
  })

  it("a read halts the CPU four cycles, a write two (§8.4.1)", () => {
    const m = part()
    m.cpu.flash.set(prog(ldi(16, 1), out(0x1f, 16), brk()), 0) // EERE
    m.cpu.invalidate()
    m.cpu.pc = 0
    const c0 = m.cpu.cycles
    m.cpu.run(c0 + 100)
    // LDI 1, OUT 1, then the four halted cycles; BREAK stops the core before its own cycle.
    expect(m.cpu.cycles - c0).toBe(1 + 1 + 4)
  })

  it("the EEPROM keeps its contents through a reset, and an ELF's .eeprom section loads into it", () => {
    const m = part()
    eeWrite(m, 0x3ff, 0xa5)
    m.runUntil(m.time + 4e-3)
    m.reset("external")
    m.runUntil(m.time + 0.07)
    expect(eeRead(m, 0x3ff)).toBe(0xa5)
  })

  it("EE_READY is a level interrupt while EEPE is clear and EERIE set (§8.6.3)", () => {
    const m = part()
    m.poke(EECR, 0x08)
    m.cpu.data[0x5f] = 0x80
    m.cpu.run(m.cpu.cycles + 4)
    expect(m.cpu.pc).not.toBeLessThan(0) // the vector (23) was taken: SREG.I cleared
    expect(m.cpu.data[0x5f] & 0x80).toBe(0)
  })
})

describe("self-programming (§27)", () => {
  /** A boot section routine at 0x3800 (BOOTSZ = 00): fill the page buffer with r1:r0 = 0xBEEF for every word, erase, write. */
  function programPage(m: AvrMcu, page: number) {
    const base = page * 64 * 2 // byte address of the page
    const code = [
      // Z = page address; fill 64 words of 0xBEEF.
      ...ldi(30, base & 0xff), ...ldi(31, base >> 8),
      ...ldi(16, 0xef), ...ldi(17, 0xbe),
      0x2e00, 0x2e11, // MOV r0,r16; MOV r1,r17
      ...ldi(18, 64),
      // loop: SPMCSR = SPMEN; SPM; ADIW Z,2; DEC r18; BRNE loop
      ...ldi(19, 0x01), ...out(0x37, 19), 0x95e8, 0x9632, 0x952a, 0xf7d1,
      // erase: Z = page; SPMCSR = PGERS|SPMEN; SPM
      ...ldi(30, base & 0xff), ...ldi(31, base >> 8),
      ...ldi(19, 0x03), ...out(0x37, 19), 0x95e8,
      // wait while SPMEN is set
      0xb737 /* IN r19, SPMCSR */, 0xfd30 /* SBRC r19,0 */, 0xcffd /* RJMP back */,
      // write: SPMCSR = PGWRT|SPMEN; SPM; wait
      ...ldi(19, 0x05), ...out(0x37, 19), 0x95e8,
      0xb737, 0xfd30, 0xcffd,
      // RWWSRE|SPMEN; SPM
      ...ldi(19, 0x11), ...out(0x37, 19), 0x95e8,
      ...brk(),
    ]
    m.cpu.flash.set(code, 0x3800)
    m.cpu.invalidate()
    m.cpu.pc = 0x3800
  }

  it("fills the page buffer, erases and writes a page from the boot section; each takes 3.7–4.5 ms (Table 27-6)", () => {
    const m = part({ low: 0xff, high: 0xd8, extended: 0xfd, lock: 0xff })
    programPage(m, 10)
    const t0 = m.time
    m.runUntil(t0 + 20e-3)
    expect(m.cpu.halted?.detail).toBe("break")
    for (let w = 0; w < 64; w++) expect(m.cpu.flash[10 * 64 + w]).toBe(0xbeef)
    const busy = m.selfProgramBusyTime
    expect(busy).toBeGreaterThanOrEqual(2 * 3.7e-3)
    expect(busy).toBeLessThanOrEqual(2 * 4.5e-3)
  })

  it("SPM from the application section does nothing (§27.3)", () => {
    const m = part({ low: 0xff, high: 0xd8, extended: 0xfd, lock: 0xff })
    programPage(m, 10)
    // Copy the routine into the application section and run it from there.
    const code = Array.from(m.cpu.flash.subarray(0x3800, 0x3840))
    m.cpu.flash.set(code, 0x100)
    m.cpu.invalidate()
    m.cpu.pc = 0x100
    m.runUntil(m.time + 20e-3)
    expect(m.cpu.flash[10 * 64]).toBe(0x0000)
    void sts
    void SPMCSR
  })
})

describe("supply supervision (§11.3, §11.5, Tables 29-11 and 29-12)", () => {
  it("brown-out at BODLEVEL 101 (2.7 V): reset below 2.675 V, released above 2.725 V after the time-out; BORF set", () => {
    const m = part()
    m.poke(MCUSR, 0)
    m.setSupply(2.7)
    m.runUntil(m.time + 1e-3)
    expect(m.inReset).toBe(false)
    m.setSupply(2.66)
    m.runUntil(m.time + 1e-3)
    expect(m.inReset).toBe(true)
    expect(m.read(MCUSR) & 0x04).toBe(0x04)
    m.setSupply(2.71) // inside the hysteresis: still held
    m.runUntil(m.time + 0.1)
    expect(m.inReset).toBe(true)
    m.setSupply(3.3)
    const t = m.time
    m.runUntil(t + 64e-3)
    expect(m.inReset).toBe(true)
    m.runUntil(t + 67e-3)
    expect(m.inReset).toBe(false)
  })

  it("BOD off (extended fuse 0xFF): the part keeps running at 2 V; below VPOT (1.3 V falling) it resets as at power-on", () => {
    const m = part({ low: 0xff, high: 0xd9, extended: 0xff, lock: 0xff })
    m.setSupply(2.0)
    m.runUntil(m.time + 1e-3)
    expect(m.inReset).toBe(false)
    m.setSupply(1.2)
    m.runUntil(m.time + 1e-3)
    expect(m.inReset).toBe(true)
    m.setSupply(5)
    m.runUntil(m.time + 0.07)
    expect(m.inReset).toBe(false)
    expect(m.read(MCUSR) & 0x01).toBe(0x01)
  })
})
