/**
 * ICSP on the PIC16F627A/628A/648A against DS41196G (rows P7-001…P7-143 of docs/pic16-checklist.md,
 * decisions D48–D56): a programmer made of pin edges — VPP on MCLR, CLOCK on RB6, DATA on RB7 —
 * erasing, writing, reading back and verifying, then letting the part run what it wrote.
 */
import { describe, expect, it } from "vitest"
import { PIC16F627, PIC16F627A, PIC16F628A, PIC16F648A, type PicProfile } from "@/mcu/pic/chip"
import type { PicMcu } from "@/mcu/pic/mcu"
import { createPic } from "@/mcu/pic/parts"
import * as A from "../lib/pic-asm"

const RB = (pin: number) => ({ port: 1, pin })
const CONFIG = 0x3e00 | 0x0100 | 0x20 | 0x08 | 0x10 // INTOSC I/O, no WDT/PWRT/BOR/LVP, CP/CPD off
const CMD = { loadConfig: 0x00, loadProg: 0x02, loadData: 0x03, readProg: 0x04, readData: 0x05, inc: 0x06, program: 0x08, eraseProg: 0x09, eraseData: 0x0b }
const T_HALF = 1e-6 // a 500 kHz programming clock

/** A programmer on the part's pins, clocking at 2 µs a bit. */
class Programmer {
  readonly m: PicMcu
  t: number
  constructor(m: PicMcu, opts: { lowVoltage?: boolean } = {}) {
    this.m = m
    m.setWiredPads([16 + 4, 16 + 6, 16 + 7])
    m.setPad(RB(4), false)
    m.setPad(RB(6), false)
    m.setPad(RB(7), false)
    this.t = m.time + 10e-6
    m.runUntil(this.t)
    if (opts.lowVoltage) {
      m.setPad(RB(4), true)
      m.runUntil((this.t += 10e-6))
    } else m.setMclrVoltage(13)
    m.runUntil((this.t += 10e-6))
  }
  private edge(pin: number, level: boolean) {
    this.m.setPadAt(RB(pin), level, this.t)
    this.m.runUntil(this.t)
  }
  /** One clock with DATA at `bit` (or released, reading what the part drives at the falling edge). */
  private clock(bit: boolean | null): boolean | null {
    if (bit !== null) this.edge(7, bit)
    this.t += T_HALF / 2
    this.edge(6, true)
    this.t += T_HALF
    const drive = this.m.padDrive(RB(7))
    this.edge(6, false)
    this.t += T_HALF / 2
    return drive === "high" ? true : drive === "low" ? false : null
  }
  command(code: number) {
    for (let i = 0; i < 6; i++) this.clock(((code >> i) & 1) === 1)
    this.t += 2e-6 // TDLY2
  }
  load(code: number, word: number) {
    this.command(code)
    const frame = (word & 0x3fff) << 1
    for (let i = 0; i < 16; i++) this.clock(((frame >> i) & 1) === 1)
    this.t += 2e-6
  }
  /** A read: the 16 data clocks with DATA released; returns the 14-bit word and what DATA did on each clock. */
  read(code: number): { word: number; seen: (boolean | null)[] } {
    this.command(code)
    const seen: (boolean | null)[] = []
    for (let i = 0; i < 16; i++) seen.push(this.clock(null))
    this.t += 2e-6
    let w = 0
    for (let i = 1; i <= 14; i++) if (seen[i]) w |= 1 << (i - 1)
    return { word: w, seen }
  }
  wait(s: number) {
    this.t += s
    this.m.runUntil(this.t)
  }
  /** Load, program, wait TPROG/TDPROG max (P7-064). */
  programWord(word: number) {
    this.load(CMD.loadProg, word)
    this.command(CMD.program)
    this.wait(4e-3)
  }
  exit() {
    this.m.setMclrVoltage(0)
    this.wait(10e-6)
    this.m.setMclrVoltage(5)
    this.m.setPad(RB(4), false)
    this.wait(10e-6)
  }
}
function part(chip: PicProfile = PIC16F628A, words: number[] = [A.goto(0)].flat(), config = CONFIG) {
  const m = createPic(chip)
  m.program(words, config)
  m.runUntil(20e-6)
  return m
}
const reports = (m: PicMcu) => [...m.unmodelled.keys()].join("\n")

describe("entering Program/Verify and reading (§2.4, §2.4.6)", () => {
  it("VPP with RB6/RB7 low: PC = 0, Read Data from Program Memory gives word 0, Increment Address the next (P7-047, P7-052, P7-067, P7-068)", () => {
    const m = part(PIC16F628A, [0x3005, 0x2801, 0x0000])
    const p = new Programmer(m)
    expect(m.programmingMode).toBe(true)
    expect(p.read(CMD.readProg).word).toBe(0x3005)
    p.command(CMD.inc)
    expect(p.read(CMD.readProg).word).toBe(0x2801)
    expect(reports(m)).not.toMatch(/ICSP.*not modelled/)
  })

  it("DATA drives from the 2nd rising edge to after the 16th, the start bit never; all other pins are inputs (P7-069, P7-053; D49)", () => {
    const m = part(PIC16F628A, [0x3fff])
    const p = new Programmer(m)
    const { seen } = p.read(CMD.readProg)
    expect(seen[0]).toBe(null)
    expect(seen.slice(1, 15).every((b) => b === true)).toBe(true)
    expect(seen[15]).toBe(false) // the stop bit, driven low
    expect(m.padDrive(RB(7))).toBe(null)
    expect(m.padDrive(RB(3))).toBe(null)
  })

  it("the PC wraps at the end of program memory (P7-016)", () => {
    const words = new Array(2048).fill(0)
    words[0] = 0x1234
    const m = part(PIC16F628A, words)
    const p = new Programmer(m)
    for (let i = 0; i < 2048; i++) p.command(CMD.inc)
    expect(p.read(CMD.readProg).word).toBe(0x1234)
  })
})

describe("programming (§2.4.1, §2.4.4, §3.1)", () => {
  it("bulk erase, then Load + Begin Programming + read back for each word (Figure 3-3 flow; P7-073, P7-085)", () => {
    const m = part(PIC16F628A, [0x0000, 0x0000])
    const p = new Programmer(m)
    p.load(CMD.loadProg, 0x3fff)
    p.command(CMD.eraseProg)
    p.wait(6e-3)
    expect(p.read(CMD.readProg).word).toBe(0x3fff)
    for (const w of [0x3042, 0x00a0, 0x2802]) {
      p.programWord(w)
      expect(p.read(CMD.readProg).word).toBe(w)
      p.command(CMD.inc)
    }
    expect(m.cpu.flash[1]).toBe(0x00a0)
  })

  it("programming only clears bits: a word written over a non-erased one is old AND new (P7-065; D52)", () => {
    const m = part(PIC16F628A, [0x00ff])
    const p = new Programmer(m)
    p.programWord(0x3f0f)
    expect(p.read(CMD.readProg).word).toBe(0x000f)
  })

  it("Begin Programming without a Load writes nothing and is reported (P7-063; D52)", () => {
    const m = part(PIC16F628A, [0x3fff, 0x3fff])
    const p = new Programmer(m)
    p.programWord(0x1111)
    p.command(CMD.inc)
    p.command(CMD.program)
    p.wait(4e-3)
    expect(p.read(CMD.readProg).word).toBe(0x3fff)
    expect(reports(m)).toMatch(/Load/)
  })

  it("a command during the 2 ms write is ignored and reported; after it, all is well (D50, D51)", () => {
    const m = part(PIC16F628A, [0x3fff])
    const p = new Programmer(m)
    p.load(CMD.loadProg, 0x0123)
    p.command(CMD.program)
    p.wait(1e-3)
    p.command(CMD.inc)
    p.wait(2e-3)
    expect(reports(m)).toMatch(/still running/)
    expect(p.read(CMD.readProg).word).toBe(0x0123)
  })

  it("an undefined command code is ignored and reported (P7-045; D50)", () => {
    const m = part()
    const p = new Programmer(m)
    p.command(0x0e)
    expect(reports(m)).toMatch(/command 0x0e|command 0E/i)
  })

  it("a whole program written over ICSP runs after the reset that ends Program/Verify (P7-018; D11, D53)", () => {
    const m = part(PIC16F628A, [0x0000, 0x0000, 0x0000])
    const p = new Programmer(m)
    p.load(CMD.loadProg, 0x3fff)
    p.command(CMD.eraseProg)
    p.wait(6e-3)
    for (const w of [A.movlw(0x42), A.goto(1)].flat()) {
      p.programWord(w)
      p.command(CMD.inc)
    }
    // Configuration memory: the IDs, then 2007h (INTOSC, PWRT off, MCLR on).
    p.load(CMD.loadConfig, 0x0001)
    p.command(CMD.program)
    p.wait(4e-3)
    for (let a = 0x2000; a < 0x2007; a++) p.command(CMD.inc)
    p.programWord(CONFIG)
    expect(p.read(CMD.readProg).word).toBe(CONFIG)
    p.exit()
    expect(m.programmingMode).toBe(false)
    m.runUntil(m.time + 50e-6)
    expect(m.cpu.w).toBe(0x42)
    expect(m.config).toBe(CONFIG)
    expect(m.ids[0]).toBe(0x0001)
  })
})

describe("configuration memory (§2.1, §2.2, §3.7)", () => {
  it("Load Configuration puts the PC at 2000h; 2006h reads the device ID; the PC stays in 2000h–3FFFh (P7-017, P7-061, P7-091, P7-092)", () => {
    for (const [chip, id] of [
      [PIC16F627A, 0x1040],
      [PIC16F628A, 0x1060],
      [PIC16F648A, 0x1100],
    ] as const) {
      const m = part(chip)
      const p = new Programmer(m)
      p.load(CMD.loadConfig, 0x3fff)
      for (let i = 0; i < 6; i++) p.command(CMD.inc)
      expect(p.read(CMD.readProg).word, chip.name).toBe(id)
      p.command(CMD.inc)
      expect(p.read(CMD.readProg).word).toBe(CONFIG)
    }
  })

  it("the configuration word cannot be set back to 1 by programming; a bulk erase can (P7-105; D52)", () => {
    const m = part()
    const p = new Programmer(m)
    p.load(CMD.loadConfig, 0x3fff)
    for (let i = 0; i < 7; i++) p.command(CMD.inc)
    p.programWord(0x3fff)
    expect(p.read(CMD.readProg).word).toBe(CONFIG)
    p.command(CMD.eraseProg)
    p.wait(6e-3)
    expect(p.read(CMD.readProg).word).toBe(0x3fff)
  })
})

describe("data EEPROM over ICSP (§2.3, §2.4.2, §2.4.7, §3.2)", () => {
  it("Load Data for Data Memory, program, read back (8 bits, the rest zero); the PC's low 7 bits address it on the 628A (P7-028, P7-029, P7-070; D49)", () => {
    const m = part()
    const p = new Programmer(m)
    p.command(CMD.eraseData)
    p.wait(6e-3)
    p.load(CMD.loadData, 0x5a)
    p.command(CMD.program)
    p.wait(6e-3)
    expect(p.read(CMD.readData).word).toBe(0x5a)
    expect(m.eeprom[0]).toBe(0x5a)
  })

  it("Bulk Erase Data Memory erases the EEPROM only (Table 3-1)", () => {
    const m = part(PIC16F628A, [0x1234])
    m.eeprom.fill(0x00)
    const p = new Programmer(m)
    p.command(CMD.eraseData)
    p.wait(6e-3)
    expect(m.eeprom.every((b) => b === 0xff)).toBe(true)
    expect(p.read(CMD.readProg).word).toBe(0x1234)
  })
})

describe("Bulk Erase Program Memory against Table 3-1 (P7-074…P7-081; D52)", () => {
  it.each([
    [true, true, { prog: true, data: true, ids: true }],
    [false, true, { prog: true, data: false, ids: true }],
    [true, false, { prog: true, data: true, ids: false }],
    [false, false, { prog: true, data: false, ids: false }],
  ])("CPD on %s, PC in configuration memory %s", (cpdOn, inConfig, erased) => {
    const m = part(PIC16F628A, [0x1234], cpdOn ? CONFIG & ~0x100 : CONFIG)
    m.eeprom.fill(0x00)
    m.ids[0] = 0x0005
    const p = new Programmer(m)
    if (inConfig) p.load(CMD.loadConfig, 0x3fff)
    else p.load(CMD.loadProg, 0x3fff)
    p.command(CMD.eraseProg)
    p.wait(6e-3)
    expect(m.cpu.flash[0] === 0x3fff).toBe(erased.prog)
    expect(m.eeprom[0] === 0xff).toBe(erased.data)
    expect(m.ids[0] === 0x3fff).toBe(erased.ids)
    expect(m.config).toBe(0x3fff)
  })
})

describe("code protection over ICSP (§14.9; D54)", () => {
  it("CP on: program memory reads 0 and is not programmed; the config word and IDs still read; a bulk erase lifts it", () => {
    const m = part(PIC16F628A, [0x1234], CONFIG & ~0x2000)
    m.ids[0] = 0x000a
    const p = new Programmer(m)
    expect(p.read(CMD.readProg).word).toBe(0)
    p.load(CMD.loadConfig, 0x3fff)
    expect(p.read(CMD.readProg).word).toBe(0x000a)
    for (let i = 0; i < 7; i++) p.command(CMD.inc)
    expect(p.read(CMD.readProg).word).toBe(CONFIG & ~0x2000)
    p.command(CMD.eraseProg)
    p.wait(6e-3)
    p.exit()
    const q = new Programmer(m)
    expect(q.read(CMD.readProg).word).toBe(0x3fff)
  })

  it("CPD on: the data EEPROM reads 0", () => {
    const m = part(PIC16F628A, [0x3fff], CONFIG & ~0x100)
    m.eeprom[0] = 0x77
    const p = new Programmer(m)
    expect(p.read(CMD.readData).word).toBe(0)
  })
})

describe("supply and LVP (D55, D56)", () => {
  it("a bulk erase under 4.5 V is reported (P7-122, E-003)", () => {
    const m = part()
    m.setSupply(4.0)
    const p = new Programmer(m)
    p.command(CMD.eraseProg)
    p.wait(6e-3)
    expect(reports(m)).toMatch(/needs 4\.5–5\.5 V/)
  })

  it("low-voltage entry (LVP bit set, PGM high): program memory works, the data EEPROM does not on the 627A/628A (E-001)", () => {
    const m = part(PIC16F628A, [0x1234], CONFIG | 0x80)
    m.eeprom[0] = 0x55
    const p = new Programmer(m, { lowVoltage: true })
    expect(m.programmingEntry).toBe("low-voltage")
    expect(p.read(CMD.readProg).word).toBe(0x1234)
    expect(p.read(CMD.readData).word).toBe(0)
    expect(reports(m)).toMatch(/E-001|LVP/)
  })

  it("with the LVP bit set, an edge on PGM during high-voltage programming resets the PC (P7-054)", () => {
    const m = part(PIC16F628A, [0x1111, 0x2222], CONFIG | 0x80)
    const p = new Programmer(m)
    p.command(CMD.inc)
    m.setPadAt(RB(4), true, (p.t += 2e-6))
    m.setPadAt(RB(4), false, (p.t += 2e-6))
    p.wait(2e-6)
    expect(p.read(CMD.readProg).word).toBe(0x1111)
  })
})

describe("the original PIC16F627 (D48)", () => {
  it("enters Program/Verify but its programming commands are not modelled (its specification is not among the documents)", () => {
    const m = part(PIC16F627, [0x3005])
    const p = new Programmer(m)
    expect(m.programmingMode).toBe(true)
    expect(p.read(CMD.readProg).seen.every((b) => b === null)).toBe(true)
    expect(reports(m)).toMatch(/not modelled/)
  })
})
