/**
 * ATmega328P lock bits and debugWIRE against DS40002061B §25, §27.5, §27.8.7, §28.1 and the
 * instruction set manual's BREAK (DS40002198C §6.13): the boot lock bits stop SPM writing and
 * LPM reading across the section boundary and hold off interrupts whose vectors sit in the
 * other section; BLBSET programs lock bits from the boot loader, never erases them; BREAK
 * stops the core only with debugWIRE on (DWEN programmed, no lock bit programmed), else it is a
 * NOP; with debugWIRE on the RESET pin is the dW line and an external reset does nothing.
 */
import { describe, expect, it } from "vitest"
import { createAtmega328p } from "@/mcu/avr/atmega328p"
import type { AvrMcu } from "@/mcu/avr/mcu"
import { brk, ldi, lpm, out, prog, rjmp, sei, spm, sts } from "../lib/avr-asm"

const SPMCSR_IO = 0x37
const MCUCR = 0x55
const TIMSK0 = 0x6e
const TCCR0B = 0x45
const DWDR = 0x51
/** Boot section start (BOOTSZ = 00), word address (Table 27-7). */
const BOOT = 0x3800
const APP = 0x100
/** mov r0, r16 */
const movR0R16 = () => [0x2e00]

function part(lock = 0xff, high = 0xd9): AvrMcu {
  const m = createAtmega328p()
  m.fuses = { low: 0xff, high, extended: 0xfd, lock }
  m.setClockFeed({ hz: 16e6, kind: "crystal" })
  m.cpu.flash.fill(0x0000)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  m.runUntil(0.07)
  return m
}
function runAt(m: AvrMcu, at: number, words: number[], seconds = 1e-4) {
  m.cpu.flash.set(words, at)
  m.cpu.invalidate()
  m.cpu.pc = at
  m.runUntil(m.time + seconds)
}

describe("boot lock bits (§27.5, Tables 27-2/27-3)", () => {
  it("BLBSET from the boot section programs lock bits; a later SPM cannot erase them (§27.8.7)", () => {
    const m = part()
    runAt(m, BOOT, prog(ldi(16, 0xef), movR0R16(), ldi(17, 0x09), out(SPMCSR_IO, 17), spm(), ldi(16, 0xff), movR0R16(), ldi(17, 0x09), out(SPMCSR_IO, 17), spm(), rjmp(-1)))
    expect(m.fuses.lock).toBe(0xef)
    // Read back through LPM with BLBSET, Z = 0x0001 (§27.8.9).
    runAt(m, BOOT + 0x40, prog(ldi(30, 1), ldi(31, 0), ldi(17, 0x09), out(SPMCSR_IO, 17), lpm(18), rjmp(-1)))
    expect(m.cpu.data[18]).toBe(0xef)
  })

  it("BLBSET from the application section does nothing: SPM only runs in the boot loader (§27.3)", () => {
    const m = part()
    runAt(m, APP, prog(ldi(16, 0xc0), movR0R16(), ldi(17, 0x09), out(SPMCSR_IO, 17), spm(), rjmp(-1)))
    expect(m.fuses.lock).toBe(0xff)
  })

  /** Boot code: fill the page buffer with 0x1234 and write the page at word `page`. */
  const writePage = (page: number) =>
    prog(
      ldi(16, 0x34), movR0R16(), // r0 = 0x34
      ldi(16, 0x12), [0x2e10], // mov r1, r16
      ldi(30, 0), ldi(31, 0), ldi(17, 0x01), out(SPMCSR_IO, 17), spm(), // buffer word 0
      ldi(30, (page * 2) & 0xff), ldi(31, (page * 2) >> 8), ldi(17, 0x05), out(SPMCSR_IO, 17), spm(), // page write
      rjmp(-1),
    )

  it("BLB01 programmed (BLB0 mode 2): SPM cannot write the application section", () => {
    const open = part()
    open.cpu.flash.fill(0xffff, 0x1000, 0x1040)
    runAt(open, BOOT, writePage(0x1000), 0.01)
    expect(open.cpu.flash[0x1000]).toBe(0x1234)

    const locked = part(0xfb)
    locked.cpu.flash.fill(0xffff, 0x1000, 0x1040)
    runAt(locked, BOOT, writePage(0x1000), 0.01)
    expect(locked.cpu.flash[0x1000]).toBe(0xffff)
  })

  it("BLB11 programmed (BLB1 mode 2): SPM cannot write the boot section", () => {
    const m = part(0xef)
    m.cpu.flash.fill(0xffff, 0x3f00, 0x3f40)
    runAt(m, BOOT, writePage(0x3f00), 0.01)
    expect(m.cpu.flash[0x3f00]).toBe(0xffff)
  })

  it("BLB02 programmed (BLB0 mode 4): LPM from the boot loader cannot read the application section; the block is reported", () => {
    const read = (lock: number) => {
      const m = part(lock)
      m.cpu.flash[0x200] = 0xbeef
      runAt(m, BOOT, prog(ldi(30, 0x00), ldi(31, 0x04), lpm(18), rjmp(-1)))
      return m
    }
    expect(read(0xff).cpu.data[18]).toBe(0xef)
    const m = read(0xf7)
    expect(m.cpu.data[18]).not.toBe(0xef)
    expect([...m.unmodelled.keys()].some((k) => k.includes("LPM"))).toBe(true)
  })

  it("BLB12 programmed (BLB1 mode 4): LPM from the application cannot read the boot section, the application itself stays readable", () => {
    const m = part(0xdf)
    m.cpu.flash[0x3a00] = 0xbeef
    m.cpu.flash[0x200] = 0xcafe
    runAt(m, APP, prog(ldi(30, 0x00), ldi(31, 0x74), lpm(18), ldi(30, 0x00), ldi(31, 0x04), lpm(19), rjmp(-1)))
    expect(m.cpu.data[18]).not.toBe(0xef)
    expect(m.cpu.data[19]).toBe(0xfe)
  })

  /** Timer0 overflow pending with vectors moved to the boot section (IVSEL); its vector sets r20. */
  function overflowWithBootVectors(lock: number, at: number) {
    const m = part(lock)
    m.cpu.flash.set(prog(ldi(20, 0x55), rjmp(-1)), BOOT + 16 * 2)
    m.poke(MCUCR, 0x01)
    m.poke(MCUCR, 0x02)
    m.poke(TIMSK0, 0x01)
    m.poke(TCCR0B, 0x01)
    runAt(m, at, prog(sei(), rjmp(-1)), 1e-3)
    return m.cpu.data[20]
  }
  it("BLB02 programmed with the vectors in the boot section: interrupts are held off while the application runs (Table 27-2 mode 3/4)", () => {
    expect(overflowWithBootVectors(0xff, APP)).toBe(0x55)
    expect(overflowWithBootVectors(0xf7, APP)).not.toBe(0x55)
    expect(overflowWithBootVectors(0xf7, BOOT + 0x100)).toBe(0x55)
  })

  it("BLB12 programmed with the vectors in the application section: interrupts are held off while the boot loader runs (Table 27-3 mode 3/4)", () => {
    const m = part(0xdf)
    m.cpu.flash.set(prog(ldi(20, 0x55), rjmp(-1)), 16 * 2)
    m.poke(TIMSK0, 0x01)
    m.poke(TCCR0B, 0x01)
    runAt(m, BOOT + 0x100, prog(sei(), rjmp(-1)), 1e-3)
    expect(m.cpu.data[20]).not.toBe(0x55)
  })
})

describe("debugWIRE (§25) and BREAK (ISA §6.13)", () => {
  const DWEN = 0x99 // high fuse 0xD9 with DWEN (bit 6) programmed

  it("BREAK stops the core when debugWIRE is on", () => {
    const m = part(0xff, DWEN)
    expect(m.debugWire).toBe(true)
    runAt(m, APP, prog(brk(), ldi(16, 0x42), rjmp(-1)))
    expect(m.cpu.halted?.detail).toBe("break")
    expect(m.cpu.data[16]).not.toBe(0x42)
  })

  it("BREAK is a NOP with DWEN unprogrammed", () => {
    const m = part(0xff, 0xd9)
    expect(m.debugWire).toBe(false)
    runAt(m, APP, prog(brk(), ldi(16, 0x42), rjmp(-1)))
    expect(m.cpu.halted).toBe(null)
    expect(m.cpu.data[16]).toBe(0x42)
  })

  it("BREAK is a NOP on a locked device even with DWEN programmed (debugWIRE needs the lock bits unprogrammed)", () => {
    const m = part(0xfe, DWEN)
    expect(m.debugWire).toBe(false)
    runAt(m, APP, prog(brk(), ldi(16, 0x42), rjmp(-1)))
    expect(m.cpu.halted).toBe(null)
    expect(m.cpu.data[16]).toBe(0x42)
  })

  it("with debugWIRE on, pulling RESET low does not reset the part: the pin is the dW line (§25.5)", () => {
    const m = part(0xff, DWEN)
    const resets = m.resets
    m.setResetPin(true)
    m.runUntil(m.time + 1e-3)
    m.setResetPin(false)
    m.runUntil(m.time + 0.1)
    expect(m.resets).toBe(resets)
    expect(m.lastReset).toBe("power-on")
  })

  it("DWDR is a read/write register (§25.6.1)", () => {
    const m = part(0xff, DWEN)
    runAt(m, APP, prog(ldi(16, 0xa7), sts(DWDR, 16), rjmp(-1)))
    expect(m.read(DWDR)).toBe(0xa7)
  })
})
