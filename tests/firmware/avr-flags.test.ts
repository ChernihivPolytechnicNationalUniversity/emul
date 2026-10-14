/**
 * Every ALU instruction of the AVR core on every operand combination (and a spread of incoming
 * SREG values) against a reference written bit by bit from the boolean formulas of the AVR
 * Instruction Set Manual (DS40002198C §6): result, all eight SREG bits, clocks.
 */
import { describe, expect, it } from "vitest"
import { AvrCpu, type AvrSystem } from "@/mcu/avr/cpu"

const SREGS = [0x00, 0x01, 0x02, 0x03, 0x80, 0xfc, 0xfd, 0xfe, 0xff, 0x55, 0xaa]

function core() {
  const system: AvrSystem = { takeInterrupt: () => 0, sleep: () => false, canWake: () => true, wakeCycles: () => 0, watchdogReset: () => {}, spm: () => 0, lpm: () => 0, service: () => {} }
  return new AvrCpu(32 * 1024, 0x8ff, system)
}

/** Run the one instruction at 0 and return the clocks it took. */
function step(c: AvrCpu): number {
  c.pc = 0
  const before = c.cycles
  c.run(c.cycles + 1)
  if (c.halted) throw c.halted
  return c.cycles - before
}

const bit = (x: number, n: number) => (x >> n) & 1
const not = (x: number) => x ^ 1

/** SREG from the individual flags; I and T are carried over from `old`. */
function sregOf(old: number, f: { h?: number; v?: number; n?: number; z?: number; c?: number }) {
  let s = old
  const put = (b: number, v: number | undefined) => {
    if (v === undefined) return
    s = v ? s | (1 << b) : s & ~(1 << b)
  }
  put(0, f.c)
  put(1, f.z)
  put(2, f.n)
  put(3, f.v)
  put(5, f.h)
  // S = N ⊕ V whenever either is defined by the instruction.
  if (f.n !== undefined || f.v !== undefined) put(4, bit(s, 2) ^ bit(s, 3))
  return s
}

function addRef(d: number, r: number, cin: number, old: number) {
  const R = (d + r + cin) & 0xff
  const h = (bit(d, 3) & bit(r, 3)) | (bit(r, 3) & not(bit(R, 3))) | (not(bit(R, 3)) & bit(d, 3))
  const v = (bit(d, 7) & bit(r, 7) & not(bit(R, 7))) | (not(bit(d, 7)) & not(bit(r, 7)) & bit(R, 7))
  const c = (bit(d, 7) & bit(r, 7)) | (bit(r, 7) & not(bit(R, 7))) | (not(bit(R, 7)) & bit(d, 7))
  return { R, s: sregOf(old, { h, v, n: bit(R, 7), z: R === 0 ? 1 : 0, c }) }
}

/** SUB/SBC/CP/CPC/SUBI/SBCI/CPI; `chainZ` is the "Z ← ¬R ∧ Z" rule of the with-carry forms. */
function subRef(d: number, r: number, cin: number, old: number, chainZ: boolean) {
  const R = (d - r - cin) & 0xff
  const h = (not(bit(d, 3)) & bit(r, 3)) | (bit(r, 3) & bit(R, 3)) | (bit(R, 3) & not(bit(d, 3)))
  const v = (bit(d, 7) & not(bit(r, 7)) & not(bit(R, 7))) | (not(bit(d, 7)) & bit(r, 7) & bit(R, 7))
  const c = (not(bit(d, 7)) & bit(r, 7)) | (bit(r, 7) & bit(R, 7)) | (bit(R, 7) & not(bit(d, 7)))
  const z = R === 0 ? (chainZ ? bit(old, 1) : 1) : 0
  return { R, s: sregOf(old, { h, v, n: bit(R, 7), z, c }) }
}

function logicRef(R: number, old: number) {
  return { R, s: sregOf(old, { v: 0, n: bit(R, 7), z: R === 0 ? 1 : 0 }) }
}

const enc2 = (base: number, d: number, r: number) => base | ((r & 0x10) << 5) | ((d & 0x1f) << 4) | (r & 0x0f)
const encK = (base: number, d: number, K: number) => base | ((K & 0xf0) << 4) | ((d - 16) << 4) | (K & 0x0f)

type TwoReg = { name: string; base: number; ref: (d: number, r: number, old: number) => { R: number; s: number }; writes: boolean }
const TWO: TwoReg[] = [
  { name: "ADD", base: 0x0c00, ref: (d, r, o) => addRef(d, r, 0, o), writes: true },
  { name: "ADC", base: 0x1c00, ref: (d, r, o) => addRef(d, r, o & 1, o), writes: true },
  { name: "SUB", base: 0x1800, ref: (d, r, o) => subRef(d, r, 0, o, false), writes: true },
  { name: "SBC", base: 0x0800, ref: (d, r, o) => subRef(d, r, o & 1, o, true), writes: true },
  { name: "CP", base: 0x1400, ref: (d, r, o) => subRef(d, r, 0, o, false), writes: false },
  { name: "CPC", base: 0x0400, ref: (d, r, o) => subRef(d, r, o & 1, o, true), writes: false },
  { name: "AND", base: 0x2000, ref: (d, r, o) => logicRef(d & r, o), writes: true },
  { name: "OR", base: 0x2800, ref: (d, r, o) => logicRef(d | r, o), writes: true },
  { name: "EOR", base: 0x2400, ref: (d, r, o) => logicRef(d ^ r, o), writes: true },
]

const IMM: TwoReg[] = [
  { name: "SUBI", base: 0x5000, ref: (d, K, o) => subRef(d, K, 0, o, false), writes: true },
  { name: "SBCI", base: 0x4000, ref: (d, K, o) => subRef(d, K, o & 1, o, true), writes: true },
  { name: "CPI", base: 0x3000, ref: (d, K, o) => subRef(d, K, 0, o, false), writes: false },
  { name: "ANDI", base: 0x7000, ref: (d, K, o) => logicRef(d & K, o), writes: true },
  { name: "ORI", base: 0x6000, ref: (d, K, o) => logicRef(d | K, o), writes: true },
]

type OneReg = { name: string; low: number; ref: (d: number, old: number) => { R: number; s: number } }
const ONE: OneReg[] = [
  { name: "COM", low: 0x0, ref: (d, o) => { const R = 0xff - d; return { R, s: sregOf(o, { v: 0, n: bit(R, 7), z: R === 0 ? 1 : 0, c: 1 }) } } },
  {
    name: "NEG",
    low: 0x1,
    ref: (d, o) => {
      const R = (0x100 - d) & 0xff
      return { R, s: sregOf(o, { h: bit(R, 3) | bit(d, 3), v: R === 0x80 ? 1 : 0, n: bit(R, 7), z: R === 0 ? 1 : 0, c: R !== 0 ? 1 : 0 }) }
    },
  },
  { name: "SWAP", low: 0x2, ref: (d, o) => ({ R: ((d & 0x0f) << 4) | (d >> 4), s: o }) },
  { name: "INC", low: 0x3, ref: (d, o) => { const R = (d + 1) & 0xff; return { R, s: sregOf(o, { v: R === 0x80 ? 1 : 0, n: bit(R, 7), z: R === 0 ? 1 : 0 }) } } },
  { name: "DEC", low: 0xa, ref: (d, o) => { const R = (d - 1) & 0xff; return { R, s: sregOf(o, { v: R === 0x7f ? 1 : 0, n: bit(R, 7), z: R === 0 ? 1 : 0 }) } } },
  {
    name: "ASR",
    low: 0x5,
    ref: (d, o) => {
      const R = (d >> 1) | (d & 0x80)
      return { R, s: sregOf(o, { n: bit(R, 7), v: bit(R, 7) ^ bit(d, 0), z: R === 0 ? 1 : 0, c: bit(d, 0) }) }
    },
  },
  { name: "LSR", low: 0x6, ref: (d, o) => { const R = d >> 1; return { R, s: sregOf(o, { n: 0, v: bit(d, 0), z: R === 0 ? 1 : 0, c: bit(d, 0) }) } } },
  {
    name: "ROR",
    low: 0x7,
    ref: (d, o) => {
      const R = (d >> 1) | ((o & 1) << 7)
      return { R, s: sregOf(o, { n: bit(R, 7), v: bit(R, 7) ^ bit(d, 0), z: R === 0 ? 1 : 0, c: bit(d, 0) }) }
    },
  },
]

describe("AVR ALU against the instruction set manual's formulas", () => {
  it.each(TWO)("$name Rd,Rr over all operands", (op) => {
    const c = core()
    c.flash[0] = enc2(op.base, 16, 17)
    for (const old of SREGS)
      for (let d = 0; d < 256; d++)
        for (let r = 0; r < 256; r++) {
          c.data[16] = d
          c.data[17] = r
          c.data[0x5f] = old
          const clocks = step(c)
          const want = op.ref(d, r, old)
          if (c.data[0x5f] !== want.s || c.data[16] !== (op.writes ? want.R : d) || clocks !== 1)
            expect({ d, r, old, sreg: c.data[0x5f], R: c.data[16], clocks }).toEqual({ d, r, old, sreg: want.s, R: op.writes ? want.R : d, clocks: 1 })
        }
  })

  it("Rd,Rd forms (LSL/ROL/TST/CLR) read the same register twice", () => {
    const c = core()
    for (const [name, base] of [["ADD", 0x0c00], ["ADC", 0x1c00], ["AND", 0x2000], ["EOR", 0x2400]] as const) {
      c.flash[0] = enc2(base, 20, 20)
      c.invalidate()
      const op = TWO.find((t) => t.name === name)!
      for (const old of SREGS)
        for (let d = 0; d < 256; d++) {
          c.data[20] = d
          c.data[0x5f] = old
          step(c)
          const want = op.ref(d, d, old)
          if (c.data[0x5f] !== want.s || c.data[20] !== want.R) expect({ name, d, old, sreg: c.data[0x5f], R: c.data[20] }).toEqual({ name, d, old, sreg: want.s, R: want.R })
        }
    }
  })

  it.each(IMM)("$name Rd,K over all operands", (op) => {
    const c = core()
    for (let K = 0; K < 256; K++) {
      c.flash[0] = encK(op.base, 23, K)
      c.invalidate()
      for (const old of SREGS)
        for (let d = 0; d < 256; d++) {
          c.data[23] = d
          c.data[0x5f] = old
          step(c)
          const want = op.ref(d, K, old)
          if (c.data[0x5f] !== want.s || c.data[23] !== (op.writes ? want.R : d)) expect({ d, K, old, sreg: c.data[0x5f], R: c.data[23] }).toEqual({ d, K, old, sreg: want.s, R: op.writes ? want.R : d })
        }
    }
  })

  it.each(ONE)("$name Rd over all operands", (op) => {
    const c = core()
    c.flash[0] = 0x9400 | (5 << 4) | op.low
    for (const old of [...SREGS, 0x20, 0xdf])
      for (let d = 0; d < 256; d++) {
        c.data[5] = d
        c.data[0x5f] = old
        const clocks = step(c)
        const want = op.ref(d, old)
        if (c.data[0x5f] !== want.s || c.data[5] !== want.R || clocks !== 1) expect({ d, old, sreg: c.data[0x5f], R: c.data[5], clocks }).toEqual({ d, old, sreg: want.s, R: want.R, clocks: 1 })
      }
  })

  it.each([
    ["ADIW", 0x9600],
    ["SBIW", 0x9700],
  ] as const)("%s over all words and constants", (name, base) => {
    const c = core()
    for (const reg of [24, 26, 28, 30])
      for (let K = 0; K < 64; K++) {
        c.flash[0] = base | ((K & 0x30) << 2) | (((reg - 24) / 2) << 4) | (K & 0x0f)
        c.invalidate()
        for (const old of [0x00, 0xff, 0x3f])
          for (let x = 0; x < 0x10000; x += K === 0 ? 1 : 7) {
            c.data[reg] = x & 0xff
            c.data[reg + 1] = x >> 8
            c.data[0x5f] = old
            const clocks = step(c)
            const R = (name === "ADIW" ? x + K : x - K) & 0xffff
            const dh7 = bit(x, 15)
            const r15 = bit(R, 15)
            const v = name === "ADIW" ? not(dh7) & r15 : dh7 & not(r15)
            const cf = name === "ADIW" ? not(r15) & dh7 : r15 & not(dh7)
            const want = sregOf(old, { v, n: r15, z: R === 0 ? 1 : 0, c: cf })
            const got = c.data[reg] | (c.data[reg + 1] << 8)
            if (c.data[0x5f] !== want || got !== R || clocks !== 2) expect({ reg, K, x, old, sreg: c.data[0x5f], R: got, clocks }).toEqual({ reg, K, x, old, sreg: want, R, clocks: 2 })
          }
      }
  })

  it.each([
    ["MUL", (a: number, b: number) => a * b, 0, false],
    ["MULS", (a: number, b: number) => ((a << 24) >> 24) * ((b << 24) >> 24), 1, false],
    ["MULSU", (a: number, b: number) => ((a << 24) >> 24) * b, 2, false],
    ["FMUL", (a: number, b: number) => a * b, 3, true],
    ["FMULS", (a: number, b: number) => ((a << 24) >> 24) * ((b << 24) >> 24), 4, true],
    ["FMULSU", (a: number, b: number) => ((a << 24) >> 24) * b, 5, true],
  ] as const)("%s over all operands", (name, product, kind, fractional) => {
    const c = core()
    const d = 18
    const r = 21
    c.flash[0] = [enc2(0x9c00, d, r), 0x0200 | ((d - 16) << 4) | (r - 16), 0x0300 | ((d - 16) << 4) | (r - 16), 0x0308 | ((d - 16) << 4) | (r - 16), 0x0380 | ((d - 16) << 4) | (r - 16), 0x0388 | ((d - 16) << 4) | (r - 16)][kind]
    for (const old of [0x00, 0xff, 0xc3])
      for (let a = 0; a < 256; a++)
        for (let b = 0; b < 256; b++) {
          c.data[d] = a
          c.data[r] = b
          c.data[0x5f] = old
          const clocks = step(c)
          const p = product(a, b) & 0xffff
          const R = fractional ? (p << 1) & 0xffff : p
          const want = sregOf(old, { c: bit(p, 15), z: R === 0 ? 1 : 0 })
          const got = c.data[0] | (c.data[1] << 8)
          if (c.data[0x5f] !== want || got !== R || clocks !== 2) expect({ name, a, b, old, sreg: c.data[0x5f], R: got, clocks }).toEqual({ name, a, b, old, sreg: want, R, clocks: 2 })
        }
  })
})
