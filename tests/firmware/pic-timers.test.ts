/**
 * PIC16F628A Timer1, Timer2 and CCP1, each check from DS40044G §7–§9 or DS33023A §12–§14 (rows
 * P2-036…P2-156 and P9-030…P9-122 of docs/pic16-checklist.md; decisions D17–D20 there).
 */
import { describe, expect, it } from "vitest"
import { PIC16F628A, PIC16F648A, type PicProfile } from "@/mcu/pic/chip"
import { createPic } from "@/mcu/pic/parts"
import type { PicMcu } from "@/mcu/pic/mcu"
import * as A from "../lib/pic-asm"

const PORTB = 0x06
const INTCON = 0x0b
const PIR1 = 0x0c
const TMR1L = 0x0e
const TMR1H = 0x0f
const T1CON = 0x10
const TMR2 = 0x11
const T2CON = 0x12
const CCPR1L = 0x15
const CCPR1H = 0x16
const CCP1CON = 0x17
const TRISB = 0x86
const PIE1 = 0x8c
const PR2 = 0x92
const MCLRE = 0x20
const BOREN = 0x40
const CONFIG = 0x3e00 | 0x0100 | MCLRE | 0x08 | 0x10 // INTOSC I/O, no WDT/PWRT/BOR/LVP
const HS20 = 0x3e00 | 0x0100 | MCLRE | 0x08 | 0x02 // HS crystal
const TCY = 1e-6

const RB = (pin: number) => ({ port: 1, pin })
const bank1 = (...body: number[][]) => A.prog(A.bsf(A.STATUS, A.RP0), ...body, A.bcf(A.STATUS, A.RP0))
const loop = (at: number) => A.goto(at)
/** A run of NOPs and a jump back: every cycle is an instruction boundary the test can stop on. */
const sled = (at: number, n = 200) => A.prog(...Array(n).fill(A.nop()), A.goto(at))

function part(words: number[], config = CONFIG, chip: PicProfile = PIC16F628A) {
  const m = createPic(chip)
  if (config === HS20) m.setClockFeed({ hz: 20e6, kind: "crystal" })
  m.program(words, config)
  return m
}
const tmr1 = (m: PicMcu) => m.peekFile(TMR1L) | (m.peekFile(TMR1H) << 8)
/** Edges a pad puts out, with their times. */
function watch(m: PicMcu, pin: number) {
  m.digitalWatch.add(16 + pin)
  return () => {
    const e = m.digitalOut.filter((d) => d.pad.port === 1 && d.pad.pin === pin).map((d) => ({ level: d.level, time: d.time }))
    m.digitalOut.length = 0
    return e
  }
}

describe("Timer1 (§7, DS33023A §12)", () => {
  it("counts FOSC/4 through the 1:1–1:8 prescaler; overflow FFFFh → 0000h sets TMR1IF (P2-036…P2-043)", () => {
    // TMR1 = 0, T1CON = 31h: 1:8, timer mode, on.
    const m = part(A.prog(A.clrf(TMR1L), A.clrf(TMR1H), A.movlw(0x31), A.movwf(T1CON), loop(4)))
    m.runUntil(5 * TCY + 65535 * 8 * TCY - 2 * TCY)
    expect(m.peekFile(PIR1) & 1).toBe(0)
    m.runUntil(5 * TCY + 65536 * 8 * TCY + 2 * TCY)
    expect(m.peekFile(PIR1) & 1).toBe(1)
    expect(tmr1(m)).toBe(0)
  })

  it("increments by one per TCY at 1:1, reads back what was written, and stops with TMR1ON = 0", () => {
    const m = part(A.prog(A.movlw(0x12), A.movwf(TMR1H), A.movlw(0x34), A.movwf(TMR1L), A.movlw(0x01), A.movwf(T1CON), loop(6)))
    m.runUntil(6 * TCY)
    const a = tmr1(m)
    m.runUntil(106 * TCY)
    expect(tmr1(m) - a).toBe(100)
    expect(a).toBeGreaterThanOrEqual(0x1234)
    m.pokeFile(T1CON, 0)
    const b = tmr1(m)
    m.runUntil(200 * TCY)
    expect(tmr1(m)).toBe(b)
  })

  it("a write to TMR1L or TMR1H clears the prescaler (§7.7, P2-072)", () => {
    // 1:8; TMR1L written every 4 TCY: the prescaler never reaches 8, TMR1 never moves.
    const m = part(A.prog(A.movlw(0x31), A.movwf(T1CON), A.clrf(TMR1H), A.clrf(TMR1L), A.clrf(TMR1L), A.clrf(TMR1L), A.clrf(TMR1L), loop(4)))
    m.runUntil(500 * TCY)
    expect(tmr1(m)).toBe(0)
  })

  it("asynchronous counter on the 32.768 kHz Timer1 oscillator: TMR1H = 80h overflows after exactly 1 s, and wakes the part from Sleep (§7.3, §7.4)", () => {
    // T1CON = 0Fh: 1:1, T1OSCEN, no sync, external, on. TMR1IE + PEIE, then SLEEP.
    const m = part(
      A.prog(
        A.clrf(TMR1L),
        A.movlw(0x80),
        A.movwf(TMR1H),
        A.movlw(0x0f),
        A.movwf(T1CON),
        bank1(A.bsf(PIE1 & 0x7f, 0)),
        A.bsf(INTCON, 6),
        A.sleep(),
        A.movlw(0x77),
        loop(10),
      ),
    )
    m.setT1Oscillator({ hz: 32768, kind: "crystal", startup: 0 })
    m.runUntil(0.5)
    expect(m.cpu.sleeping).toBe(true)
    m.runUntil(1.0 - 1e-4)
    expect(m.cpu.sleeping).toBe(true)
    m.runUntil(1.0 + 1e-4)
    expect(m.cpu.sleeping).toBe(false)
    expect(m.peekFile(PIR1) & 1).toBe(1)
  })

  it("synchronous counter mode does not count in Sleep (§7.2, P2-051)", () => {
    // T1CON = 0Bh: T1OSCEN, synchronised, external, on.
    const m = part(A.prog(A.clrf(TMR1L), A.clrf(TMR1H), A.movlw(0x0b), A.movwf(T1CON), A.sleep(), loop(5)))
    m.setT1Oscillator({ hz: 32768, kind: "crystal", startup: 0 })
    m.runUntil(0.1)
    expect(m.cpu.sleeping).toBe(true)
    expect(tmr1(m)).toBe(0)
  })

  it("counts rising edges on RB6/T1CKI when T1OSCEN = 0 (§7.2, Register 7-1)", () => {
    // T1CON = 03h: synchronised, external, on.
    const m = part(A.prog(A.clrf(TMR1L), A.clrf(TMR1H), A.movlw(0x03), A.movwf(T1CON), loop(4)))
    m.setWiredPads([16 + 6])
    m.setPad(RB(6), false)
    m.runUntil(10 * TCY)
    for (let i = 0; i < 7; i++) {
      m.setPad(RB(6), true)
      m.runUntil(m.time + 3 * TCY)
      m.setPad(RB(6), false)
      m.runUntil(m.time + 3 * TCY)
    }
    expect(tmr1(m)).toBe(7)
  })

  it("with T1OSCEN = 1, RB6 and RB7 are the oscillator's: TRISB<7:6> ignored, they do not drive (§7.0, P2-041; D17)", () => {
    const m = part(A.prog(bank1(A.clrf(TRISB & 0x7f)), A.movlw(0xff), A.movwf(PORTB), A.movlw(0x08), A.movwf(T1CON), A.movf(PORTB, 0), loop(8)))
    m.runUntil(20 * TCY)
    expect([m.padDrive(RB(6)), m.padDrive(RB(7)), m.padDrive(RB(5))]).toEqual([null, null, "high"])
    expect(m.cpu.w & 0xc0).toBe(0)
  })

  it("TMR1 keeps its value through an MCLR reset; T1CON too, but not through a brown-out (§7.6, Table 14-7 note 6)", () => {
    const m = part(A.prog(A.movlw(0x12), A.movwf(TMR1H), A.movlw(0x30), A.movwf(T1CON), loop(4)), CONFIG | BOREN)
    m.runUntil(10 * TCY)
    m.setMclr(true)
    m.runUntil(20 * TCY)
    expect(m.peekFile(TMR1H)).toBe(0x12)
    expect(m.peekFile(T1CON)).toBe(0x30)
    m.setMclr(false)
    m.setSupply(3.5)
    m.runUntil(m.time + 200e-6)
    m.setSupply(5)
    expect(m.peekFile(T1CON)).toBe(0)
  })
})

describe("Timer2 (§8, DS33023A §13)", () => {
  it("counts 0…PR2 through the 1:1/1:4/1:16 prescaler; TMR2IF every postscale-th period (§8.0, P2-080…P2-090)", () => {
    // PR2 = 99, T2CON = 15h: postscale 1:3 (TOUTPS = 0010), on, prescale 1:4 → TMR2IF every 100 · 4 · 3 = 1200 TCY.
    // On the 648A (4K words) the NOPs outlast the 3700 cycles watched: no two-cycle GOTO between samples.
    const m = part(A.prog(bank1(A.movlw(99), A.movwf(PR2 & 0x7f)), A.clrf(TMR2), A.movlw(0x15), A.movwf(T2CON), sled(7, 4000)), CONFIG, PIC16F648A)
    m.runUntil(7 * TCY)
    const times: number[] = []
    for (let t = 7; t < 7 + 3700; t++) {
      m.runUntil(t * TCY)
      if (m.peekFile(PIR1) & 2) {
        times.push(m.cpu.cycles)
        m.pokeFile(PIR1, 0)
      }
    }
    expect(times.length).toBe(3)
    expect(times[1] - times[0]).toBe(1200)
    expect(times[2] - times[1]).toBe(1200)
  })

  it("never counts past PR2 and wraps to 0 on the increment after the match (P2-080, P9-067)", () => {
    const m = part(A.prog(bank1(A.movlw(5), A.movwf(PR2 & 0x7f)), A.clrf(TMR2), A.movlw(0x04), A.movwf(T2CON), sled(7)))
    const seen = new Set<number>()
    for (let t = 8; t < 40; t++) {
      m.runUntil(t * TCY)
      seen.add(m.peekFile(TMR2))
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it("a write to T2CON clears the pre- and postscalers but not TMR2 (§8.1, P2-084/P2-085)", () => {
    const m = part(A.prog(A.movlw(0x30), A.movwf(TMR2), A.movlw(0x06), A.movwf(T2CON), A.movlw(0x06), A.movwf(T2CON), loop(6)))
    m.runUntil(5 * TCY)
    expect(m.peekFile(TMR2)).toBe(0x30)
  })

  it("is cleared on reset and PR2 set to FFh; stops in Sleep (§8.0, P9-068, P9-072)", () => {
    const m = part(A.prog(A.movlw(0x04), A.movwf(T2CON), A.sleep(), loop(3)))
    m.runUntil(50 * TCY)
    const a = m.peekFile(TMR2)
    m.runUntil(500 * TCY)
    expect(m.peekFile(TMR2)).toBe(a)
    m.setMclr(true)
    m.runUntil(m.time + 5 * TCY)
    m.setMclr(false)
    expect([m.peekFile(TMR2), m.peekFile(PR2), m.peekFile(T2CON)]).toEqual([0, 0xff, 0])
  })
})

describe("CCP1 capture (§9.1, DS33023A §14.3)", () => {
  /** Timer1 at 1:1 from 0, CCP1 in `mode`, RB3 an input fed by the test. */
  function capture(mode: number) {
    const m = part(A.prog(A.clrf(TMR1L), A.clrf(TMR1H), A.movlw(mode), A.movwf(CCP1CON), A.movlw(0x01), A.movwf(T1CON), loop(6)))
    m.setWiredPads([16 + 3])
    m.setPad(RB(3), false)
    m.runUntil(10 * TCY)
    m.pokeFile(PIR1, 0)
    return m
  }
  const ccpr1 = (m: PicMcu) => m.peekFile(CCPR1L) | (m.peekFile(CCPR1H) << 8)

  it("every rising edge (0101): CCPR1 takes TMR1 at the edge and CCP1IF sets", () => {
    const m = capture(0x05)
    m.runUntil(100 * TCY)
    const before = tmr1(m)
    m.setPad(RB(3), true)
    m.runUntil(m.time + 2 * TCY)
    expect(m.peekFile(PIR1) & 4).toBe(4)
    expect(Math.abs(ccpr1(m) - before)).toBeLessThanOrEqual(1)
  })

  it("every falling edge (0100) ignores rising ones", () => {
    const m = capture(0x04)
    m.setPad(RB(3), true)
    m.runUntil(m.time + 5 * TCY)
    expect(m.peekFile(PIR1) & 4).toBe(0)
    m.setPad(RB(3), false)
    m.runUntil(m.time + 5 * TCY)
    expect(m.peekFile(PIR1) & 4).toBe(4)
  })

  it("every 4th (0110) and every 16th (0111) rising edge", () => {
    for (const [mode, n] of [
      [0x06, 4],
      [0x07, 16],
    ]) {
      const m = capture(mode)
      for (let i = 1; i <= n; i++) {
        m.setPad(RB(3), true)
        m.runUntil(m.time + 3 * TCY)
        m.setPad(RB(3), false)
        m.runUntil(m.time + 3 * TCY)
        expect(m.peekFile(PIR1) & 4, `edge ${i} of ${n}`).toBe(i === n ? 4 : 0)
      }
    }
  })

  it("switching between capture prescalers does not clear the prescaler counter (§9.1.4, P2-119)", () => {
    const m = capture(0x07)
    for (let i = 0; i < 3; i++) {
      m.setPad(RB(3), true)
      m.runUntil(m.time + 3 * TCY)
      m.setPad(RB(3), false)
      m.runUntil(m.time + 3 * TCY)
    }
    // Three edges counted at ÷16; now ÷4 straight away: the fourth edge completes a count of 4.
    m.pokeFile(CCP1CON, 0x06)
    m.pokeFile(PIR1, 0)
    m.setPad(RB(3), true)
    m.runUntil(m.time + 3 * TCY)
    expect(m.peekFile(PIR1) & 4).toBe(4)
  })

  it("a second capture before CCPR1 is read overwrites the first (§9.1, P2-112)", () => {
    const m = capture(0x05)
    for (let i = 0; i < 2; i++) {
      m.runUntil(m.time + 50 * TCY)
      m.setPad(RB(3), true)
      m.runUntil(m.time + 3 * TCY)
      m.setPad(RB(3), false)
    }
    expect(ccpr1(m)).toBeGreaterThan(90)
  })
})

describe("CCP1 compare (§9.2, DS33023A §14.4)", () => {
  it("1000 drives RB3 low until TMR1 = CCPR1, then high, and sets CCP1IF (DS33023A §14.4.1: the opposite level first)", () => {
    const m = part(
      A.prog(bank1(A.bcf(TRISB & 0x7f, 3)), A.clrf(TMR1L), A.clrf(TMR1H), A.clrf(CCPR1L), A.movlw(0x01), A.movwf(CCPR1H), A.movlw(0x08), A.movwf(CCP1CON), A.movlw(0x01), A.movwf(T1CON), loop(12)),
    )
    m.runUntil(20 * TCY)
    expect(m.padDrive(RB(3))).toBe("low")
    m.runUntil(13 * TCY + 0x100 * TCY + 3 * TCY)
    expect(m.padDrive(RB(3))).toBe("high")
    expect(m.peekFile(PIR1) & 4).toBe(4)
  })

  it("1001 drives RB3 high until the match, then low", () => {
    const m = part(
      A.prog(bank1(A.bcf(TRISB & 0x7f, 3)), A.clrf(TMR1L), A.clrf(TMR1H), A.clrf(CCPR1L), A.movlw(0x01), A.movwf(CCPR1H), A.movlw(0x09), A.movwf(CCP1CON), A.movlw(0x01), A.movwf(T1CON), loop(12)),
    )
    m.runUntil(20 * TCY)
    expect(m.padDrive(RB(3))).toBe("high")
    m.runUntil(13 * TCY + 0x100 * TCY + 3 * TCY)
    expect(m.padDrive(RB(3))).toBe("low")
  })

  it("1010 only sets CCP1IF; the pin keeps the port latch (§9.2.3)", () => {
    const m = part(
      A.prog(bank1(A.bcf(TRISB & 0x7f, 3)), A.bsf(PORTB, 3), A.clrf(TMR1L), A.clrf(TMR1H), A.movlw(0x40), A.movwf(CCPR1L), A.clrf(CCPR1H), A.movlw(0x0a), A.movwf(CCP1CON), A.movlw(0x01), A.movwf(T1CON), loop(13)),
    )
    m.runUntil(200 * TCY)
    expect(m.padDrive(RB(3))).toBe("high")
    expect(m.peekFile(PIR1) & 4).toBe(4)
  })

  it("1011 resets TMR1 on the next TMR1 clock after the match: a period of CCPR1 + 1, and TMR1IF stays clear (§9.2.4, P2-127)", () => {
    const m = part(A.prog(A.clrf(TMR1L), A.clrf(TMR1H), A.movlw(0x63), A.movwf(CCPR1L), A.clrf(CCPR1H), A.movlw(0x0b), A.movwf(CCP1CON), A.movlw(0x01), A.movwf(T1CON), sled(9)))
    const seen = new Set<number>()
    let flags = 0
    for (let t = 10; t < 1000; t++) {
      m.runUntil(t * TCY)
      seen.add(tmr1(m))
      if (m.peekFile(PIR1) & 4) flags++
      m.pokeFile(PIR1, m.peekFile(PIR1) & ~4)
    }
    expect(Math.max(...seen)).toBe(0x63)
    expect(flags).toBeGreaterThanOrEqual(9)
    expect(m.peekFile(PIR1) & 1).toBe(0)
  })

  it("special event with CCPR1 = FFFFh: the match coincides with the overflow, so TMR1IF sets too (DS33023A §14.7 Q5, P9-099)", () => {
    const m = part(A.prog(A.movlw(0xf0), A.movwf(TMR1L), A.movlw(0xff), A.movwf(TMR1H), A.movwf(CCPR1L), A.movwf(CCPR1H), A.movlw(0x0b), A.movwf(CCP1CON), A.movlw(0x01), A.movwf(T1CON), loop(10)))
    m.runUntil(60 * TCY)
    expect(m.peekFile(PIR1) & 5).toBe(5)
    expect(tmr1(m)).toBeLessThan(0x40)
  })

  it("clearing CCP1CON forces the compare output latch low (§9.2.1 note)", () => {
    const m = part(
      A.prog(bank1(A.bcf(TRISB & 0x7f, 3)), A.clrf(TMR1L), A.clrf(TMR1H), A.movlw(0x10), A.movwf(CCPR1L), A.clrf(CCPR1H), A.movlw(0x08), A.movwf(CCP1CON), A.movlw(0x01), A.movwf(T1CON), loop(12)),
    )
    m.runUntil(100 * TCY)
    expect(m.padDrive(RB(3))).toBe("high")
    m.pokeFile(CCP1CON, 0)
    m.pokeFile(CCP1CON, 0x0a)
    m.runUntil(m.time + 2 * TCY)
    // 1010 hands the pin back to the port latch; the compare latch itself was forced low.
    expect(m.ccpOutput).toBe(false)
  })
})

describe("CCP1 PWM (§9.3, DS33023A §14.5)", () => {
  /** HS 20 MHz, PR2, duty (10 bits), prescale bits; RB3 an output. */
  function pwm(pr2: number, duty: number, t2ckps = 0) {
    // PORTB's latch is unknown at power-on (Table 14-7): clear it before RB3 becomes an output.
    return part(
      A.prog(
        A.clrf(PORTB),
        bank1(A.movlw(pr2), A.movwf(PR2 & 0x7f), A.bcf(TRISB & 0x7f, 3)),
        A.movlw(duty >> 2),
        A.movwf(CCPR1L),
        A.movlw(0x0c | ((duty & 3) << 4)),
        A.movwf(CCP1CON),
        A.movlw(0x04 | t2ckps),
        A.movwf(T2CON),
        loop(12),
      ),
      HS20,
    )
  }
  const period = (edges: { level: boolean | null; time: number }[]) => {
    const rises = edges.filter((e) => e.level === true).map((e) => e.time)
    return rises[rises.length - 1] - rises[rises.length - 2]
  }
  const highTime = (edges: { level: boolean | null; time: number }[]) => {
    const i = edges.findIndex((e, k) => k > 0 && e.level === true)
    const fall = edges.slice(i).find((e) => e.level === false)!
    return fall.time - edges[i].time
  }

  it("78.12 kHz at 20 MHz with PR2 = 3Fh, prescale 1 (Table 9-3); period = (PR2 + 1)·4·TOSC·prescale (§9.3.1)", () => {
    const m = pwm(0x3f, 128)
    const edges = watch(m, 3)
    m.runUntil(1024 / 20e6 + 200e-6)
    const e = edges()
    expect(period(e)).toBeCloseTo(1 / 78125, 9)
    // Duty = DC · TOSC · prescale = 128 · 50 ns = 6.4 µs (§9.3.2).
    expect(highTime(e)).toBeCloseTo(128 / 20e6, 9)
  })

  it("1.22 kHz with PR2 = FFh, prescale 16 (Table 9-3)", () => {
    const m = pwm(0xff, 512, 2)
    const edges = watch(m, 3)
    m.runUntil(1024 / 20e6 + 5e-3)
    expect(1 / period(edges())).toBeCloseTo(1220.7, 0)
  })

  it("Example 14-5: PR2 = 7Fh, CCPR1L = 1Fh, DC LSbs = 10 → about 25 % (126 of 512 TOSC)", () => {
    const m = pwm(0x7f, (0x1f << 2) | 2)
    const edges = watch(m, 3)
    m.runUntil(1024 / 20e6 + 300e-6)
    const e = edges()
    expect(highTime(e) / period(e)).toBeCloseTo(126 / 512, 4)
  })

  it("a duty longer than the period never clears the pin: 100 % (§9.3.2 note); duty 0 never sets it (§9.3.1)", () => {
    const full = pwm(0x3e, 0x7f << 2)
    full.runUntil(1024 / 20e6 + 100e-6)
    expect(full.padDrive(RB(3))).toBe("high")
    const zero = pwm(0x3f, 0)
    const edges = watch(zero, 3)
    zero.runUntil(1024 / 20e6 + 100e-6)
    expect(edges().filter((e) => e.level === true)).toEqual([])
    expect(zero.padDrive(RB(3))).toBe("low")
  })

  it("a new duty is latched only at the end of the period (§9.3.2, double buffering)", () => {
    const m = pwm(0xff, 256)
    const edges = watch(m, 3)
    // 20 MHz, PR2 = FFh: a 1024 TOSC (51.2 µs) period; 8.8 µs into the first one, mid-pulse (256 TOSC = 12.8 µs).
    m.runUntil(1024 / 20e6 + 60e-6)
    edges()
    m.pokeFile(CCPR1L, 768 >> 2)
    m.runUntil(m.time + 200e-6)
    const e = edges()
    const T = 1024 / 20e6
    const nextRise = e.find((x) => x.level === true)!.time
    // The pulse under way still ends at 256 TOSC; the following ones last 768.
    expect((e[0].time - (nextRise - T)) * 20e6).toBeCloseTo(256, 6)
    const fall = e.find((x) => x.level === false && x.time > nextRise)!.time
    expect((fall - nextRise) * 20e6).toBeCloseTo(768, 6)
  })

  it("CCPR1H is read-only in PWM mode and holds the latched duty (§9.3.2)", () => {
    const m = pwm(0x3f, 128)
    m.runUntil(1024 / 20e6 + 50e-6)
    m.pokeFile(CCPR1H, 0x55)
    expect(m.peekFile(CCPR1H)).toBe(128 >> 2)
  })
})
