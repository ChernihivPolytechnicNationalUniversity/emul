/**
 * ATmega328P system level, against the data sheet (DS40002061B): pin configurations and the
 * synchronizer (§14.2), reset sources and start-up delays (§9.2, Tables 9-2/9-4/9-12, §11),
 * the clock prescaler (§9.11–9.12), sleep enable (§10.11.1), signature bytes (§27.8.9, §28.3).
 */
import { describe, expect, it } from "vitest"
import { ATMEGA328P } from "@/mcu/avr/chip"
import { AvrMcu } from "@/mcu/avr/mcu"
import { brk, in_, ldi, lpm, nop, out, prog, rjmp, sbi, sleep, spm, sts } from "../lib/avr-asm"

const PINB = 0x03
const DDRB = 0x04
const PORTB = 0x05
const MCUCR = 0x35
const SMCR = 0x33
const SPMCSR = 0x37

/** A 328P with the program at 0: Arduino clock fuses (16 MHz crystal), BOOTRST unprogrammed. */
/** DWEN unprogrammed: RESET is the reset pin (with debugWIRE on it is the dW line, §25.5). */
const NO_DW = { low: 0xff, high: 0xd9, extended: 0xfd, lock: 0xff }
/** DWEN programmed in the default fuses: debugWIRE on, so BREAK stops the core and ends a test (ISA §6.13). */
function mcu(words: number[], fuses = { low: 0xff, high: 0x99, extended: 0xfd, lock: 0xff }) {
  const m = new AvrMcu(ATMEGA328P)
  m.fuses = { ...fuses }
  m.setClockFeed({ hz: 16e6, kind: "crystal" })
  m.cpu.flash.fill(0xffff)
  m.cpu.flash.set(words, 0)
  m.cpu.invalidate()
  m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
  m.reset("power-on")
  return m
}
/** Run until the program hits BREAK (or the time is up). */
function untilBreak(m: AvrMcu, seconds = 1) {
  m.runUntil(seconds)
  return m.cpu.halted?.detail
}

describe("I/O ports (§14.2, Table 14-1)", () => {
  const cases: [number, number, boolean, string | null][] = [
    [0, 0, false, null],
    [0, 1, false, "pullup"],
    [0, 1, true, null],
    [1, 0, false, "low"],
    [1, 1, false, "high"],
    [1, 0, true, "low"],
    [1, 1, true, "high"],
  ]
  it.each(cases)("DDxn=%i PORTxn=%i PUD=%s → %s", (dd, port, pud, want) => {
    const m = mcu(prog(ldi(16, pud ? 0x10 : 0), out(MCUCR, 16), ldi(16, port << 3), out(PORTB, 16), ldi(16, dd << 3), out(DDRB, 16), brk()))
    expect(untilBreak(m)).toBe("break")
    expect(m.padDrive({ port: 1, pin: 3 })).toBe(want)
  })

  it("writing one to PINxn toggles PORTxn, whatever DDxn is (§14.2.2)", () => {
    const m = mcu(prog(ldi(16, 0x0f), out(PORTB, 16), ldi(16, 0x3c), out(PINB, 16), in_(17, PORTB), sbi(PINB, 7), in_(18, PORTB), brk()))
    untilBreak(m)
    expect(m.cpu.data[17]).toBe(0x33)
    expect(m.cpu.data[18]).toBe(0xb3)
  })

  it("a value written to PORTx reads back from PINx only after one more cycle (Figure 14-4)", () => {
    const m = mcu(prog(ldi(16, 0xff), out(DDRB, 16), ldi(17, 0x0f), out(PORTB, 17), in_(18, PINB), nop(), in_(19, PINB), brk()))
    untilBreak(m)
    expect(m.cpu.data[18]).toBe(0x00) // out PORTB; in PINB → still the old value
    expect(m.cpu.data[19]).toBe(0x0f) // with a nop in between → the new one
  })

  it("an external edge reaches PINx within 0.5–1.5 clocks (Figure 14-3)", () => {
    // in r16, PINB at word 0 executes in cycle 0 after the start-up; then a loop of reads.
    const m = mcu(prog(in_(16, PINB), in_(17, PINB), in_(18, PINB), brk()))
    m.setWiredPads([1 * 16 + 0])
    m.setPad({ port: 1, pin: 0 }, false)
    m.runUntil(0.07) // through the 65 ms start-up, stops at a slice end before the program
    // Fresh look: run the core by hand, cycle by cycle, with the edge 0.7 cycles before the second read.
    const m2 = mcu(prog(in_(16, PINB), in_(17, PINB), in_(18, PINB), brk()))
    m2.setWiredPads([16])
    m2.setPad({ port: 1, pin: 0 }, false)
    m2.cpu.run(0) // nothing yet
    m2.ports[0].setExternal(0, true, 0.3) // edge at cycle 0.3: read in cycle 1 samples at 0.5 → sees it
    m2.cpu.run(3)
    expect([m2.cpu.data[16], m2.cpu.data[17], m2.cpu.data[18]]).toEqual([0, 1, 1])
    const m3 = mcu(prog(in_(16, PINB), in_(17, PINB), in_(18, PINB), brk()))
    m3.setWiredPads([16])
    m3.setPad({ port: 1, pin: 0 }, false)
    m3.ports[0].setExternal(0, true, 0.7) // edge at 0.7: the read in cycle 1 samples at 0.5 → misses it, cycle 2 sees it
    m3.cpu.run(3)
    expect([m3.cpu.data[16], m3.cpu.data[17], m3.cpu.data[18]]).toEqual([0, 0, 1])
  })

  it("pins are tri-stated while reset is active and come up as inputs (§14.2.1, §11.1)", () => {
    const m = mcu(prog(ldi(16, 0xff), out(DDRB, 16), out(PORTB, 16), rjmp(-1)), NO_DW)
    m.runUntil(0.1)
    expect(m.padDrive({ port: 1, pin: 0 })).toBe("high")
    m.setResetPin(true)
    expect(m.padDrive({ port: 1, pin: 0 })).toBe(null)
  })

  it("PC7 does not exist on the 328P (PORTC is 7 bits)", () => {
    const m = mcu(prog(ldi(16, 0xff), out(0x08, 16), in_(17, 0x08), brk()))
    untilBreak(m)
    expect(m.cpu.data[17]).toBe(0x7f)
  })
})

describe("reset and start-up (§9.2, §11)", () => {
  /** Time the first instruction runs: a program that stores the time-stamp counter is overkill — use the core's own cycle count. */
  function firstInstructionTime(fuses: { low: number; high: number; extended: number; lock: number }, feed: { hz: number; kind: "crystal" | "clock" } | null) {
    const m = new AvrMcu(ATMEGA328P)
    m.fuses = fuses
    m.setClockFeed(feed)
    m.cpu.flash.fill(0)
    m.cpu.invalidate()
    m.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
    m.reset("power-on")
    let t = 0
    while (m.cpu.cycles === 0 && t < 0.2) {
      t += 1e-5
      m.runUntil(t)
    }
    // The first slice starts exactly where the reset is released.
    return m.cycleTime(0)
  }

  // The additional delay from reset is 19 CK, not the data sheet's 14: errata DS80000855C §3.1.
  it("Arduino fuses (low 0xFF: crystal 8–16 MHz, CKSEL0=1, SUT=11): 16K CK + 19 CK + 65 ms (Tables 9-2, 9-4; DS80000855C §3.1.1)", () => {
    const t = firstInstructionTime({ low: 0xff, high: 0xda, extended: 0xfd, lock: 0xff }, { hz: 16e6, kind: "crystal" })
    expect(t).toBeCloseTo(65e-3 + (16384 + 19) / 16e6, 9)
  })

  it("factory fuses (low 0x62: internal 8 MHz RC, SUT=10, CKDIV8): 6 CK start-up + 19 CK + 65 ms, then 1 MHz (Table 9-12, §9.2.1–9.2.2; DS80000855C §3.1.4)", () => {
    const t = firstInstructionTime({ low: 0x62, high: 0x99, extended: 0xff, lock: 0xff }, null)
    // From reset the start-up time and the additional delay add up (§9.2.2); CK are cycles of the undivided 8 MHz source.
    expect(t).toBeCloseTo(65e-3 + (6 + 19) / 8e6, 9)
    const m = new AvrMcu(ATMEGA328P)
    expect(m.hz).toBe(1e6)
  })

  it("CLKPR resets to 0011 with CKDIV8 programmed and 0000 without (§9.12.2)", () => {
    const a = mcu(prog(brk()), { low: 0x7f, high: 0xda, extended: 0xfd, lock: 0xff })
    expect(a.read(0x61)).toBe(0x03)
    const b = mcu(prog(brk()))
    expect(b.read(0x61)).toBe(0x00)
  })

  it("a crystal fuse with no crystal in the circuit: the part does not run", () => {
    const m = mcu(prog(brk()))
    m.setClockFeed(null)
    m.reset("power-on")
    m.runUntil(0.2)
    expect(m.cpu.halted).toBeNull()
    expect(m.cpu.instructions).toBe(0)
    expect(m.clockProblem()).toMatch(/no crystal/)
  })

  it("MCUSR: power-on sets PORF only; an external reset adds EXTRF; writing zero clears (§11.9.1)", () => {
    const m = mcu(prog(rjmp(-1)), NO_DW)
    expect(m.read(0x54)).toBe(0x01)
    m.runUntil(0.1)
    m.setResetPin(true)
    m.setResetPin(false)
    expect(m.read(0x54)).toBe(0x03)
    m.poke(0x54, 0)
    expect(m.read(0x54)).toBe(0)
  })

  it("RSTDISBL programmed turns the 0 ms option (SUT = 00, internal RC) into 4 ms (DS80000855C §3.1.4 note 1)", () => {
    const t = firstInstructionTime({ low: 0xc2, high: 0x59, extended: 0xff, lock: 0xff }, null)
    expect(t).toBeCloseTo(4e-3 + (6 + 19) / 8e6, 9)
  })

  it("an external reset holds the core for the time-out after RESET rises (§11.4)", () => {
    const m = mcu(prog(rjmp(-1)), NO_DW)
    m.runUntil(0.1)
    m.setResetPin(true)
    m.runUntil(0.2)
    m.setResetPin(false)
    const before = m.cpu.instructions
    m.runUntil(0.2 + 64e-3)
    expect(m.cpu.instructions).toBe(before)
    m.runUntil(0.2 + 66e-3)
    expect(m.cpu.instructions).toBeGreaterThan(before)
  })
})

describe("clock prescaler (§9.11, §9.12.2, Table 9-17)", () => {
  const CLKPR = 0x61
  it("needs CLKPCE written alone first, then CLKPS within four cycles", () => {
    const m = mcu(prog(ldi(16, 0x80), ldi(17, 0x02), sts(CLKPR, 16), sts(CLKPR, 17), brk()))
    untilBreak(m)
    expect(m.hz).toBe(4e6)
  })
  it("a CLKPS write without the enable sequence is ignored", () => {
    const m = mcu(prog(ldi(17, 0x02), sts(CLKPR, 17), brk()))
    untilBreak(m)
    expect(m.hz).toBe(16e6)
  })
  it("too late: the window closes four cycles after CLKPCE", () => {
    const m = mcu(prog(ldi(16, 0x80), ldi(17, 0x02), sts(CLKPR, 16), nop(), nop(), nop(), sts(CLKPR, 17), brk()))
    untilBreak(m)
    expect(m.hz).toBe(16e6)
  })
  it("reserved division codes are ignored", () => {
    const m = mcu(prog(ldi(16, 0x80), ldi(17, 0x09), sts(CLKPR, 16), sts(CLKPR, 17), brk()))
    untilBreak(m)
    expect(m.hz).toBe(16e6)
  })
})

describe("sleep (§10.11.1)", () => {
  it("SLEEP with SE clear does nothing", () => {
    const m = mcu(prog(sleep(), brk()))
    expect(untilBreak(m)).toBe("break")
  })
  it("SLEEP with SE set and no wake-up source stays asleep", () => {
    const m = mcu(prog(ldi(16, 0x05), out(SMCR, 16), sleep(), brk()))
    m.runUntil(0.2)
    expect(m.cpu.halted).toBeNull()
    expect(m.cpu.sleeping).toBe(true)
    expect(m.sleepMode).toBe("power-down")
  })
})

describe("signature row (§27.8.9, Table 28-15)", () => {
  it("SIGRD + SPMEN then LPM reads 0x1E 0x95 0x0F", () => {
    // Z = 0, 2, 4 in turn: LPM after setting SPMCSR = SIGRD|SPMEN each time.
    const m = mcu(
      prog(
        ldi(30, 0), ldi(31, 0), ldi(16, 0x21), out(SPMCSR, 16), lpm(20),
        ldi(30, 2), out(SPMCSR, 16), lpm(21),
        ldi(30, 4), out(SPMCSR, 16), lpm(22),
        brk(),
      ),
    )
    untilBreak(m)
    expect([m.cpu.data[20], m.cpu.data[21], m.cpu.data[22]]).toEqual([0x1e, 0x95, 0x0f])
  })
  void spm
})
