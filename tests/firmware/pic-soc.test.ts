/**
 * The PIC16F628A around its core, each check from DS40044G (section, table or figure at the
 * check) or the Mid-Range Reference Manual DS33023A where the data sheet points to it: reset
 * values (Tables 14-6/14-7), the configuration word (Register 14-1), start-up timers (Table
 * 14-3, Table 17-7), the ports (§5), RB0/INT and the PORTB change interrupt (§14.5), the
 * interrupt gating (Figure 14-14), Timer0 and its prescaler (§6, DS33023A Figures 11-2…11-4),
 * the watchdog (§14.7), Sleep (§14.8), the dual-speed internal oscillator (§14.2.8) and
 * low-voltage programming on RB4 (§14.12).
 */
import { describe, expect, it } from "vitest"
import { PIC16F627, PIC16F628A, type PicProfile } from "@/mcu/pic/chip"
import { createPic } from "@/mcu/pic/parts"
import type { PicMcu } from "@/mcu/pic/mcu"
import * as A from "../lib/pic-asm"

// Register addresses (Tables 4-3…4-6).
const TMR0 = 0x01
const PORTA = 0x05
const PORTB = 0x06
const INTCON = 0x0b
const PIR1 = 0x0c
const T1CON = 0x10
const TMR2 = 0x11
const T2CON = 0x12
const CCP1CON = 0x17
const RCSTA = 0x18
const TXREG = 0x19
const RCREG = 0x1a
const CMCON = 0x1f
const OPTION = 0x81
const TRISA = 0x85
const TRISB = 0x86
const PIE1 = 0x8c
const PCON = 0x8e
const PR2 = 0x92
const TXSTA = 0x98
const SPBRG = 0x99
const EECON1 = 0x9c
const VRCON = 0x9f

// Configuration words (Register 14-1). Unimplemented bits 12–9 programmed as 1, as MPASM/gpasm emit them.
const CP_OFF = 0x3e00 | 0x0100 // CP = 1, CPD = 1
const LVP = 0x80
const BOREN = 0x40
const MCLRE = 0x20
const PWRTE_OFF = 0x08
const WDTE = 0x04
const FOSC = { LP: 0x00, XT: 0x01, HS: 0x02, EC: 0x03, INTOSC_IO: 0x10, INTOSC_CLKOUT: 0x11, RC_IO: 0x12, RC_CLKOUT: 0x13 }
/** __CONFIG _INTOSC_OSC_NOCLKOUT & _WDT_OFF & _PWRTE_OFF & _MCLRE_ON & _BOREN_OFF & _LVP_OFF */
const CONFIG = CP_OFF | MCLRE | PWRTE_OFF | FOSC.INTOSC_IO
const TCY = 1e-6 // INTOSC 4 MHz → 1 µs per instruction

const RA = (pin: number) => ({ port: 0, pin })
const RB = (pin: number) => ({ port: 1, pin })

/** A part running `words` from 0 (or `isr` at 0004h with `main` at 0010h) with no start-up delay. */
function part(words: number[], config = CONFIG, chip: PicProfile = PIC16F628A): PicMcu {
  const m = createPic(chip)
  m.program(words, config)
  return m
}
function withIsr(main: number[], isr: number[], config = CONFIG) {
  const words = new Array(0x40).fill(A.nop()[0])
  words.splice(0, 1, ...A.goto(0x10))
  words.splice(4, isr.length, ...isr)
  words.splice(0x10, main.length, ...main)
  return part(words, config)
}
/** Execute one instruction: returns W afterwards. */
function step(m: PicMcu) {
  m.cpu.run(m.cpu.cycles + 1)
  return m.cpu.w
}
/** Bank 1 on, a body, bank 0 back. */
const bank1 = (...body: number[][]) => A.prog(A.bsf(A.STATUS, A.RP0), ...body, A.bcf(A.STATUS, A.RP0))
const loop = (at: number) => A.goto(at)

describe("PIC16F628A reset values (Tables 14-6, 14-7)", () => {
  it("Power-on Reset", () => {
    const m = part(loop(0))
    const f = (a: number) => m.peekFile(a)
    expect(f(A.STATUS) & 0xf8).toBe(0x18)
    expect(f(A.PCLATH)).toBe(0)
    expect(f(INTCON) & 0xfe).toBe(0)
    expect(f(PIR1)).toBe(0)
    expect(f(T1CON)).toBe(0)
    expect(f(TMR2)).toBe(0)
    expect(f(T2CON)).toBe(0)
    expect(f(CCP1CON)).toBe(0)
    expect(f(RCSTA) & 0xfe).toBe(0)
    expect(f(TXREG)).toBe(0)
    expect(f(RCREG)).toBe(0)
    expect(f(CMCON)).toBe(0)
    expect(f(OPTION)).toBe(0xff)
    expect(f(TRISA)).toBe(0xff)
    expect(f(TRISB)).toBe(0xff)
    expect(f(PIE1)).toBe(0)
    // PCON ---- 1-0x: OSCF set, POR clear.
    expect(f(PCON) & 0x0e).toBe(0x08)
    expect(f(PR2)).toBe(0xff)
    expect(f(TXSTA)).toBe(0x02)
    expect(f(SPBRG)).toBe(0)
    expect(f(EECON1) & 0x07).toBe(0)
    expect(f(VRCON)).toBe(0)
    // PORTA xxxx 0000: RA<3:0> are comparator inputs after reset and read 0 (§5.1 note 2).
    expect(f(PORTA) & 0x0f).toBe(0)
    expect(m.lastReset).toBe("power-on")
  })

  it("MCLR Reset during normal operation: STATUS 000u uuuu, PCON ---- 1-uu, the rest to their reset values", () => {
    // Set POR (the program's "a power-on happened" bookkeeping), select bank 1, change OPTION and TRISB, spin.
    const m = part(A.prog(A.bsf(A.STATUS, A.RP0), A.bsf(PCON & 0x7f, 1), A.clrf(OPTION & 0x7f), A.clrf(TRISB & 0x7f), A.bsf(A.STATUS, A.C), loop(5)))
    m.runUntil(20 * TCY)
    expect(m.peekFile(PCON) & 0x02).toBe(0x02)
    m.setMclr(true)
    m.runUntil(m.time + 10 * TCY)
    m.setMclr(false)
    expect(m.lastReset).toBe("mclr")
    expect(m.peekFile(A.STATUS) & 0xe0).toBe(0)
    expect(m.peekFile(A.STATUS) & 0x19).toBe(0x19) // TO, PD unchanged (1) and C unchanged
    expect(m.peekFile(PCON) & 0x0a).toBe(0x0a) // POR stays 1
    expect([m.peekFile(OPTION), m.peekFile(TRISB)]).toEqual([0xff, 0xff])
    expect(m.cpu.pc).toBe(0)
  })

  it("MCLR Reset during Sleep: STATUS 0001 0uuu", () => {
    const m = part(A.prog(A.sleep(), loop(1)))
    m.runUntil(5 * TCY)
    expect(m.cpu.sleeping).toBe(true)
    m.setMclr(true)
    m.runUntil(m.time + 5 * TCY)
    m.setMclr(false)
    expect(m.peekFile(A.STATUS) & 0xf8).toBe(0x10)
  })
})

describe("PIC16F628A configuration word and start-up (Register 14-1, Table 14-3, Table 17-7)", () => {
  /** When the first instruction ran: the run's end less the cycles it took. */
  const firstInstruction = (config: number, feed?: { hz: number; kind: "crystal" | "clock" }) => {
    const m = createPic(PIC16F628A)
    if (feed) m.setClockFeed(feed)
    m.program(loop(0), config)
    m.runUntil(0.2)
    return m.time - m.cpu.cycles / m.hz
  }

  it("INTOSC with the PWRT enabled: 72 ms before the first instruction", () => {
    expect(firstInstruction(CONFIG & ~PWRTE_OFF)).toBeCloseTo(72e-3, 4)
  })
  it("INTOSC, RC and EC without the PWRT: no time-out at all", () => {
    expect(firstInstruction(CONFIG)).toBeCloseTo(0, 9)
    expect(firstInstruction(CP_OFF | MCLRE | PWRTE_OFF | FOSC.EC, { hz: 8e6, kind: "clock" })).toBeCloseTo(0, 9)
  })
  it("XT, HS and LP: the OST waits 1024 oscillator periods, after the PWRT when it is on", () => {
    expect(firstInstruction(CP_OFF | MCLRE | PWRTE_OFF | FOSC.XT, { hz: 4e6, kind: "crystal" })).toBeCloseTo(1024 / 4e6, 6)
    expect(firstInstruction(CP_OFF | MCLRE | PWRTE_OFF | FOSC.HS, { hz: 20e6, kind: "crystal" })).toBeCloseTo(1024 / 20e6, 6)
    expect(firstInstruction(CP_OFF | MCLRE | FOSC.XT, { hz: 4e6, kind: "crystal" })).toBeCloseTo(72e-3 + 1024 / 4e6, 5)
  })
  it("a crystal mode with nothing across OSC1/OSC2 never starts, and says so", () => {
    const m = createPic(PIC16F628A)
    m.program(loop(0), CP_OFF | MCLRE | PWRTE_OFF | FOSC.HS)
    m.runUntil(0.01)
    expect(m.cpu.instructions).toBe(0)
    expect(m.clockProblem()).toMatch(/crystal/)
  })
  it("runs at FOSC/4: 4 MHz INTOSC is one instruction per µs; a 20 MHz crystal five", () => {
    const m = part(loop(0))
    m.runUntil(1e-3)
    expect(m.cpu.cycles).toBeCloseTo(1000, -1)
    const h = createPic(PIC16F628A)
    h.setClockFeed({ hz: 20e6, kind: "crystal" })
    h.program(loop(0), CP_OFF | MCLRE | PWRTE_OFF | FOSC.HS)
    h.runUntil(1e-3 + 1024 / 20e6)
    expect(h.cpu.cycles).toBeCloseTo(5000, -1)
  })
  it("an image without a configuration word runs with the erased word 3FFFh: RC with CLKOUT, WDT and LVP on", () => {
    const m = createPic(PIC16F628A)
    m.program(loop(0))
    expect(m.config & 0x3fff).toBe(0x3fff)
  })
  it("MCLRE = 0 makes RA5 a digital input and ties MCLR to VDD", () => {
    const m = part(A.prog(A.movf(PORTA, 0), loop(1)), CONFIG & ~MCLRE)
    m.setWiredPads([0 * 16 + 5])
    m.setPad(RA(5), false)
    m.setMclr(true)
    m.runUntil(10 * TCY)
    expect(m.inReset).toBe(false)
    expect(m.cpu.instructions).toBeGreaterThan(0)
  })
})

describe("PIC16F628A brown-out reset (§14.4.4, Table 17-7 param 35, Table 14-6)", () => {
  it("with BOREN, VDD under VBOR for TBOR (100 µs) resets; a shorter dip may not; PCON.BOR reads 0 after it", () => {
    const m = part(A.prog(bank1(A.movlw(0x0b), A.movwf(PCON & 0x7f)), loop(4)), CONFIG | BOREN)
    m.runUntil(1e-3)
    expect(m.peekFile(PCON) & 0x03).toBe(0x03)
    m.setSupply(3.5)
    m.runUntil(m.time + 50e-6)
    m.setSupply(5)
    m.runUntil(m.time + 10e-6)
    expect(m.resets).toBe(0)
    m.setSupply(3.5)
    m.runUntil(m.time + 150e-6)
    m.setSupply(3.5)
    expect(m.inReset).toBe(true)
    m.setSupply(5)
    expect(m.lastReset).toBe("brown-out")
    // PCON ---- 1-u0 (Table 14-6): POR as the program left it, BOR cleared.
    expect(m.peekFile(PCON) & 0x0b).toBe(0x0a)
  })
})

describe("PIC16F628A ports (§5)", () => {
  it("TRISB = 0 drives the PORTB latch; reading PORTB reads the pins (§5.2)", () => {
    const m = part(A.prog(bank1(A.clrf(TRISB & 0x7f)), A.movlw(0xa5), A.movwf(PORTB), A.movf(PORTB, 0), loop(6)))
    m.runUntil(10 * TCY)
    for (let p = 0; p < 8; p++) expect(m.padDrive(RB(p)), `RB${p}`).toBe(0xa5 & (1 << p) ? "high" : "low")
    // Figure 5-16: a read right after the write sees the new level on an unloaded pin.
    expect(m.cpu.w).toBe(0xa5)
  })

  it("a read-modify-write latches the pin level of input pins (Example 5-2)", () => {
    // PORTB<7:6> inputs pulled high outside, latch 01pp pppp → BCF PORTB,7 (latch 01…), then make RB7/RB6 outputs.
    const m = part(A.prog(A.movlw(0x40), A.movwf(PORTB), A.bcf(PORTB, 7), bank1(A.bcf(TRISB & 0x7f, 7), A.bcf(TRISB & 0x7f, 6)), loop(7)))
    m.setWiredPads([16 + 6, 16 + 7])
    m.setPad(RB(6), true)
    m.setPad(RB(7), true)
    m.runUntil(3 * TCY)
    // After BCF PORTB,7 the latch is 10pp pppp? No: BCF read 11pp pppp from the pins, cleared bit 7 → 01pp pppp.
    m.runUntil(5 * TCY)
    // BCF TRISB,7 makes RB7 drive its latch (0); then BCF PORTB… the example's second BCF is on TRISB: RB6 drives 1.
    m.runUntil(10 * TCY)
    expect(m.padDrive(RB(7))).toBe("low")
    expect(m.padDrive(RB(6))).toBe("high")
  })

  it("RA<3:0> read 0 while the comparators own them (CMCON reset value), and as I/O after CMCON = 07h (§5.1, Example 5-1)", () => {
    const m = part(A.prog(A.movf(PORTA, 0), A.movwf(0x20), A.movlw(7), A.movwf(CMCON), A.movf(PORTA, 0), A.movwf(0x21), loop(6)))
    m.setWiredPads([0, 1, 2, 3])
    for (let p = 0; p < 4; p++) m.setPad(RA(p), true)
    m.runUntil(10 * TCY)
    expect(m.peekFile(0x20) & 0x0f).toBe(0)
    expect(m.peekFile(0x21) & 0x0f).toBe(0x0f)
  })

  it("RA4 is open drain: a 1 releases the pin, a 0 sinks (Table 5-1)", () => {
    const m = part(A.prog(A.movlw(7), A.movwf(CMCON), bank1(A.bcf(TRISA & 0x7f, 4)), A.bsf(PORTA, 4), loop(6)))
    m.runUntil(10 * TCY)
    expect(m.padDrive(RA(4))).toBe(null)
    const z = part(A.prog(A.movlw(7), A.movwf(CMCON), bank1(A.bcf(TRISA & 0x7f, 4)), A.bcf(PORTA, 4), loop(6)))
    z.runUntil(10 * TCY)
    expect(z.padDrive(RA(4))).toBe("low")
  })

  it("RA5 is input only: TRISA5 reads 1 and the pin never drives (Table 5-1, Example 5-1)", () => {
    const m = part(A.prog(A.movlw(7), A.movwf(CMCON), bank1(A.clrf(TRISA & 0x7f)), A.movlw(0xff), A.movwf(PORTA), loop(7)), CONFIG & ~MCLRE)
    m.runUntil(10 * TCY)
    expect(m.peekFile(TRISA) & 0x20).toBe(0x20)
    expect(m.padDrive(RA(5))).toBe(null)
    expect(m.padDrive(RA(3))).toBe("high")
  })

  it("RA6/RA7 belong to the oscillator in XT mode: they read 0 and ignore TRISA (§5.1 note 3)", () => {
    const m = createPic(PIC16F628A)
    m.setClockFeed({ hz: 4e6, kind: "crystal" })
    m.program(A.prog(bank1(A.clrf(TRISA & 0x7f)), A.movlw(0xc0), A.movwf(PORTA), A.movf(PORTA, 0), loop(6)), CP_OFF | MCLRE | PWRTE_OFF | FOSC.XT)
    m.runUntil(1e-3)
    expect(m.cpu.w & 0xc0).toBe(0)
    expect(m.padDrive(RA(6))).toBe(null)
    expect(m.padDrive(RA(7))).toBe(null)
    // INTOSC with I/O on both: they are port pins.
    const io = part(A.prog(bank1(A.clrf(TRISA & 0x7f)), A.movlw(0xc0), A.movwf(PORTA), loop(5)))
    io.runUntil(10 * TCY)
    expect([io.padDrive(RA(6)), io.padDrive(RA(7))]).toEqual(["high", "high"])
  })

  it("RA6 puts out CLKOUT (FOSC/4, half duty) with FOSC = 101 (Register 14-1, §14.2.7)", () => {
    const m = part(loop(0), CP_OFF | MCLRE | PWRTE_OFF | FOSC.INTOSC_CLKOUT)
    m.runUntil(100 * TCY)
    expect(m.clockOut(RA(6))).toBeCloseTo(1e6, 0)
    expect(m.clockOut(RA(7))).toBe(null)
  })

  it("PORTB weak pull-ups: on for inputs with RBPU = 0, off for outputs and on POR (§5.2)", () => {
    // PORTB's latch is unknown after power-on (Table 14-7): clear it first.
    const m = part(A.prog(A.clrf(PORTB), bank1(A.bcf(OPTION & 0x7f, 7), A.bcf(TRISB & 0x7f, 0)), loop(5)))
    expect(m.padDrive(RB(1))).toBe(null)
    m.runUntil(10 * TCY)
    expect(m.padDrive(RB(1))).toBe("pullup")
    expect(m.padDrive(RB(0))).toBe("low")
  })

  it("with LVP = 1 RB4 is the PGM pin: no pull-up, no I/O (§14.12, Figure 5-12)", () => {
    const m = part(A.prog(bank1(A.bcf(OPTION & 0x7f, 7), A.clrf(TRISB & 0x7f)), A.movlw(0xff), A.movwf(PORTB), loop(6)), CONFIG | LVP)
    m.setWiredPads([16 + 4])
    m.setPad(RB(4), false)
    m.runUntil(10 * TCY)
    expect(m.padDrive(RB(4))).toBe(null)
    expect(m.padDrive(RB(5))).toBe("high")
  })

  it("with LVP = 1 a high on RB4/PGM puts the part in Programming mode: it stops running (§14.12)", () => {
    const m = part(loop(0), CONFIG | LVP)
    m.setWiredPads([16 + 4])
    m.setPad(RB(4), false)
    m.runUntil(10 * TCY)
    const ran = m.cpu.cycles
    m.setPad(RB(4), true)
    m.runUntil(20 * TCY)
    expect(m.cpu.cycles - ran).toBeLessThan(2)
    expect(m.programmingMode).toBe(true)
  })
})

describe("PIC16F628A high-voltage Program/Verify entry (§14.11, DS41196G Table 5-1)", () => {
  it("VIHH (10.0–13.5 V) on MCLR/VPP with RB6/RB7 low stops the program; back under VDD the part restarts", () => {
    const m = part(loop(0))
    m.setWiredPads([16 + 6, 16 + 7])
    m.setPad(RB(6), false)
    m.setPad(RB(7), false)
    m.runUntil(10 * TCY)
    m.setMclrVoltage(12)
    const ran = m.cpu.cycles
    m.runUntil(30 * TCY)
    expect(m.programmingMode).toBe(true)
    expect(m.cpu.cycles - ran).toBeLessThan(2)
    // Back to VDD the part stays in Program/Verify; a programmer ends a session by taking MCLR low (decision D11).
    m.setMclrVoltage(5)
    m.runUntil(40 * TCY)
    expect(m.programmingMode).toBe(true)
    m.setMclrVoltage(0)
    m.runUntil(50 * TCY)
    m.setMclrVoltage(5)
    const before = m.cpu.cycles
    m.runUntil(60 * TCY)
    expect(m.programmingMode).toBe(false)
    expect(m.cpu.cycles - before).toBeGreaterThan(5)
  })

  it("a voltage between VDD and VIHH is not a programming entry; even with MCLRE = 0 VIHH still enters (MCLR/VPP keeps its HV detect, Figure 5-5)", () => {
    const m = part(loop(0))
    m.runUntil(10 * TCY)
    m.setMclrVoltage(8)
    m.runUntil(20 * TCY)
    expect(m.programmingMode).toBe(false)
    const n = part(loop(0), CONFIG & ~MCLRE)
    n.setMclrVoltage(12)
    n.runUntil(20 * TCY)
    expect(n.programmingMode).toBe(true)
  })

  it("rates MCLR and RA4 to 14 V, the other pins to VDD + 0.3 V (Absolute Maximum Ratings, §17.0)", () => {
    const m = part(loop(0))
    expect(m.chip.electrical.mclrMax).toBe(14)
    expect(m.chip.electrical.ra4Max).toBe(14)
    expect(m.chip.electrical.pinAboveVdd).toBe(0.3)
  })
})

describe("PIC16F628A RB0/INT and PORTB change (§14.5.1, §14.5.3, §5.2)", () => {
  it("INTF sets on the edge INTEDG selects: rising with INTEDG = 1, falling with 0", () => {
    for (const intedg of [1, 0]) {
      const m = part(intedg ? loop(0) : A.prog(bank1(A.bcf(OPTION & 0x7f, 6)), loop(3)))
      m.setWiredPads([16])
      m.setPad(RB(0), intedg ? false : true)
      m.runUntil(10 * TCY)
      m.setPad(RB(0), intedg ? true : false)
      m.runUntil(12 * TCY)
      expect(m.peekFile(INTCON) & 0x02, `INTEDG ${intedg}: the selected edge`).toBe(0x02)
      m.pokeFile(INTCON, 0)
      m.setPad(RB(0), intedg ? false : true)
      m.runUntil(14 * TCY)
      expect(m.peekFile(INTCON) & 0x02, `INTEDG ${intedg}: the other edge`).toBe(0)
    }
  })

  it("RBIF sets when an RB<7:4> input differs from the value latched at the last PORTB read; outputs are excluded", () => {
    // RB7 output, RB4–RB6 inputs; read PORTB once, then spin.
    const m = part(A.prog(bank1(A.bcf(TRISB & 0x7f, 7)), A.movf(PORTB, 0), loop(4)))
    m.setWiredPads([16 + 4, 16 + 5, 16 + 6, 16 + 7])
    for (const p of [4, 5, 6, 7]) m.setPad(RB(p), false)
    m.runUntil(10 * TCY)
    // Before the first read the latch held power-up garbage: whatever RBIF did then, clear it now the read has ended the mismatch.
    m.pokeFile(INTCON, 0)
    m.runUntil(11 * TCY)
    expect(m.peekFile(INTCON) & 1).toBe(0)
    m.setPad(RB(7), true) // an output: no mismatch counts
    m.runUntil(12 * TCY)
    expect(m.peekFile(INTCON) & 1).toBe(0)
    m.setPad(RB(5), true)
    m.runUntil(14 * TCY)
    expect(m.peekFile(INTCON) & 1).toBe(1)
    // The mismatch continues: clearing RBIF without a read of PORTB lets it set again.
    m.pokeFile(INTCON, 0)
    m.runUntil(16 * TCY)
    expect(m.peekFile(INTCON) & 1).toBe(1)
  })

  it("reading PORTB ends the mismatch, after which RBIF stays clear (§5.2 a, b)", () => {
    const m = part(A.prog(A.movf(PORTB, 0), loop(1)))
    m.setWiredPads([16 + 4])
    m.setPad(RB(4), false)
    m.runUntil(5 * TCY)
    m.setPad(RB(4), true)
    m.runUntil(6 * TCY)
    expect(m.peekFile(INTCON) & 1).toBe(1)
    m.readFile(PORTB)
    m.pokeFile(INTCON, 0)
    m.runUntil(10 * TCY)
    expect(m.peekFile(INTCON) & 1).toBe(0)
  })
})

describe("PIC16F628A interrupt gating (Figure 14-14)", () => {
  // ISR: INCF 0x70, clear all flags, RETFIE.
  const isr = A.prog(A.incf(0x70, 1), A.clrf(INTCON & 0x7f), A.bsf(INTCON, 7), A.return_())
  const count = (m: PicMcu) => m.peekFile(0x70)

  it("INTCON sources need their enable and GIE; peripheral (PIR1) sources also PEIE", () => {
    // INTE + GIE: an INT edge vectors.
    const m = withIsr(A.prog(A.clrf(0x70), A.movlw(0x90), A.movwf(INTCON), loop(0x13)), isr)
    m.setWiredPads([16])
    m.setPad(RB(0), false)
    m.runUntil(20 * TCY)
    m.setPad(RB(0), true)
    m.runUntil(40 * TCY)
    expect(count(m)).toBe(1)
    // INTE without GIE: the flag sets, nothing vectors.
    const n = withIsr(A.prog(A.clrf(0x70), A.movlw(0x10), A.movwf(INTCON), loop(0x13)), isr)
    n.setWiredPads([16])
    n.setPad(RB(0), false)
    n.runUntil(20 * TCY)
    n.setPad(RB(0), true)
    n.runUntil(40 * TCY)
    expect([count(n), n.peekFile(INTCON) & 2]).toEqual([0, 2])
  })

  it("an instruction clearing GIE: requests pending for the next cycle are ignored until GIE is set again (§14.5 note 2)", () => {
    const m = withIsr(A.prog(A.clrf(0x70), A.movlw(0xa0), A.movwf(INTCON), A.bcf(INTCON, 7), A.nop(), A.nop(), A.nop(), loop(0x17)), isr)
    // T0IE + GIE written in cycle 4; T0IF set by hand at the Q1 of cycle 5, the cycle BCF INTCON,GIE executes in:
    // the request would vector after it, but the BCF drops it (note 2).
    m.runUntil(5 * TCY)
    m.pokeFile(INTCON, m.peekFile(INTCON) | 0x04)
    m.runUntil(30 * TCY)
    expect(count(m)).toBe(0)
    expect(m.peekFile(INTCON) & 0x24).toBe(0x24)
  })
})

describe("PIC16F628A Timer0 (§6, DS33023A §11)", () => {
  it("increments every TCY; a write inhibits the next two increments (Figure 11-2)", () => {
    // OPTION = DFh: T0CS = 0 (TCY clock), PSA = 1 (prescaler on the WDT, TMR0 at 1:1). Then MOVLW 0x80, MOVWF TMR0, MOVF TMR0,W ×5.
    const m = part(A.prog(bank1(A.movlw(0xdf), A.movwf(OPTION & 0x7f)), A.movlw(0x80), A.movwf(TMR0), ...Array(5).fill(A.movf(TMR0, 0)), loop(11)))
    for (let i = 0; i < 6; i++) step(m)
    expect([step(m), step(m), step(m), step(m), step(m)]).toEqual([0x80, 0x80, 0x80, 0x81, 0x82])
  })

  it("with the prescaler at 1:2 a write clears it and holds TMR0 for 4 TMR0 clocks (Figure 11-3)", () => {
    const m = part(A.prog(bank1(A.movlw(0xd0), A.movwf(OPTION & 0x7f)), A.movlw(0x80), A.movwf(TMR0), ...Array(6).fill(A.movf(TMR0, 0)), loop(13)))
    for (let i = 0; i < 6; i++) step(m)
    expect([step(m), step(m), step(m), step(m), step(m), step(m)]).toEqual([0x80, 0x80, 0x80, 0x80, 0x81, 0x81])
  })

  it("sets T0IF in the cycle TMR0 rolls from FFh to 00h; the interrupt follows three cycles later (Figure 11-4)", () => {
    const isr = A.prog(A.movf(TMR0, 0), A.movwf(0x71), loop(6))
    // GIE + T0IE; TMR0 written FDh: it reads FDh, FDh, FDh, FEh, FFh, 00h on the following cycles.
    const m = withIsr(A.prog(bank1(A.movlw(0xdf), A.movwf(OPTION & 0x7f)), A.movlw(0xa0), A.movwf(INTCON), A.movlw(0xfd), A.movwf(TMR0), ...Array(8).fill(A.nop())), isr)
    m.runUntil(30 * TCY)
    // Written in cycle w: 00h from cycle w + 6, T0IF there; 0004h runs at w + 9 and reads FDh + 6 = 03h.
    expect(m.peekFile(0x71)).toBe(0x03)
  })

  it("counts T0CKI edges: rising with T0SE = 0, falling with T0SE = 1 (§6, Register 4-2)", () => {
    for (const t0se of [0, 1]) {
      const opt = 0xff & ~(t0se ? 0 : 0x10) // T0CS = 1, PSA = 1 (1:1)
      const m = part(A.prog(bank1(A.movlw(opt), A.movwf(OPTION & 0x7f)), A.clrf(TMR0), loop(5)))
      m.setWiredPads([4])
      m.setPad(RA(4), false)
      m.runUntil(10 * TCY)
      for (let i = 0; i < 5; i++) {
        m.setPad(RA(4), true)
        m.runUntil(m.time + 3 * TCY)
        m.setPad(RA(4), false)
        m.runUntil(m.time + 3 * TCY)
      }
      expect(m.peekFile(TMR0), `T0SE ${t0se}`).toBe(5)
    }
  })

  it("the prescaler divides T0CKI (1:4 → 3 counts from 12 edges)", () => {
    const m = part(A.prog(bank1(A.movlw(0xe1), A.movwf(OPTION & 0x7f)), A.clrf(TMR0), loop(5)))
    m.setWiredPads([4])
    m.setPad(RA(4), false)
    m.runUntil(10 * TCY)
    for (let i = 0; i < 12; i++) {
      m.setPad(RA(4), true)
      m.runUntil(m.time + 2 * TCY)
      m.setPad(RA(4), false)
      m.runUntil(m.time + 2 * TCY)
    }
    expect(m.peekFile(TMR0)).toBe(3)
  })

  it("stops in Sleep, so T0IF cannot wake the part (§6.1)", () => {
    const m = part(A.prog(A.movlw(0x20), A.movwf(INTCON), A.movlw(0xf0), A.movwf(TMR0), A.sleep(), A.movlw(0x77), loop(6)))
    m.runUntil(1e-3)
    expect(m.cpu.sleeping).toBe(true)
    expect(m.peekFile(TMR0)).toBeLessThan(0xf4)
  })
})

describe("PIC16F628A watchdog (§14.7, Table 17-7)", () => {
  it("times out after 18 ms without a postscaler and resets with TO = 0 (Table 14-6 WDT Reset: 0000 uuuu)", () => {
    // PSA = 0: the prescaler goes to Timer0, the WDT runs 1:1.
    const m = part(A.prog(bank1(A.bcf(OPTION & 0x7f, 3)), loop(3)), CONFIG | WDTE)
    m.runUntil(17e-3)
    expect(m.resets).toBe(0)
    m.runUntil(19e-3)
    expect(m.lastReset).toBe("wdt")
    expect(m.peekFile(A.STATUS) & 0x10).toBe(0)
  })

  it("with the prescaler as its postscaler at 1:128 the period is 2.3 s (§14.7.1)", () => {
    const m = part(loop(0), CONFIG | WDTE) // OPTION = FFh after reset: PSA = 1, PS = 111
    m.runUntil(2.2)
    expect(m.resets).toBe(0)
    m.runUntil(2.4)
    expect(m.lastReset).toBe("wdt")
  })

  it("CLRWDT keeps it from timing out", () => {
    const m = part(A.prog(bank1(A.bcf(OPTION & 0x7f, 3)), A.clrwdt(), loop(3)), CONFIG | WDTE)
    m.runUntil(50e-3)
    expect(m.resets).toBe(0)
  })

  it("in Sleep a time-out wakes the part and execution continues after SLEEP with TO = 0, PD = 0 (Table 14-6 WDT Wake-up)", () => {
    const m = part(A.prog(bank1(A.bcf(OPTION & 0x7f, 3)), A.sleep(), A.movlw(0x42), loop(5)), CONFIG | WDTE)
    m.runUntil(10e-3)
    expect(m.cpu.sleeping).toBe(true)
    m.runUntil(20e-3)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.resets).toBe(0)
    expect(m.cpu.w).toBe(0x42)
    expect(m.peekFile(A.STATUS) & 0x18).toBe(0)
  })

  it("does not run with WDTE = 0", () => {
    const m = part(loop(0), CONFIG)
    m.runUntil(3)
    expect(m.resets).toBe(0)
  })
})

describe("PIC16F628A Sleep (§14.8)", () => {
  it("wakes on RB0/INT with INTE set and GIE clear, and runs on in line (§14.8.1)", () => {
    const m = part(A.prog(A.movlw(0x10), A.movwf(INTCON), A.sleep(), A.movlw(0x33), loop(4)))
    m.setWiredPads([16])
    m.setPad(RB(0), false)
    m.runUntil(10 * TCY)
    expect(m.cpu.sleeping).toBe(true)
    m.setPad(RB(0), true)
    m.runUntil(30 * TCY)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.cpu.w).toBe(0x33)
    expect(m.peekFile(A.STATUS) & 0x18).toBe(0x10)
  })

  it("a crystal mode waits 1024 TOSC on wake-up; INTOSC a few µs (Table 14-3, Table 17-5 F14)", () => {
    for (const [config, feed, wait] of [
      [CP_OFF | MCLRE | PWRTE_OFF | FOSC.XT, { hz: 4e6, kind: "crystal" as const }, 1024 / 4e6],
      [CONFIG, undefined, 3e-6],
    ] as const) {
      const m = createPic(PIC16F628A)
      if (feed) m.setClockFeed(feed)
      m.program(A.prog(A.movlw(0x10), A.movwf(INTCON), A.sleep(), A.bsf(PORTB, 1), loop(4)), config)
      m.setWiredPads([16])
      m.setPad(RB(0), false)
      m.runUntil(1e-3)
      m.setPadAt(RB(0), true, 1e-3)
      // The pin edge and the first instruction after: t(RB1 written) − 1 ms ≈ the start-up wait (+ the instruction).
      m.runUntil(2e-3)
      expect(m.cpu.sleeping).toBe(false)
      expect(m.wokeAt! - 1e-3).toBeCloseTo(wait, 6)
    }
  })

  it("SLEEP completes as a NOP when an enabled flag is already set with GIE clear (§14.8.1 note)", () => {
    const m = part(A.prog(A.movlw(0x12), A.movwf(INTCON), A.sleep(), A.movlw(0x55), loop(4)))
    m.runUntil(10 * TCY)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.cpu.w).toBe(0x55)
    expect(m.peekFile(A.STATUS) & 0x18).toBe(0x18)
  })
})

describe("PIC16F628A dual-speed INTOSC (§14.2.8, Register 4-6, Table 17-4)", () => {
  it("OSCF = 0 slows the internal oscillator to 48 kHz; OSCF = 1 is 4 MHz again", () => {
    const m = part(A.prog(bank1(A.bcf(PCON & 0x7f, 3)), loop(3)))
    m.runUntil(1e-3)
    const c0 = m.cpu.cycles
    m.runUntil(101e-3)
    expect(m.cpu.cycles - c0).toBeCloseTo((0.1 * 48e3) / 4, -1)
  })

  it("the original PIC16F627 slows to 37 kHz (DS40300C §14.2.8)", () => {
    const m = part(A.prog(bank1(A.bcf(PCON & 0x7f, 3)), loop(3)), CONFIG, PIC16F627)
    m.runUntil(1e-3)
    const c0 = m.cpu.cycles
    m.runUntil(101e-3)
    expect(m.cpu.cycles - c0).toBeCloseTo((0.1 * 37e3) / 4, -1)
  })
})
