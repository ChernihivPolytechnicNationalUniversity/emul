/**
 * Every ALU instruction of the mid-range PIC core on every operand combination against a
 * reference written from the instruction descriptions of DS40044G §15.2 (Table 15-2, Register
 * 4-1): result, destination (W or f), C/DC/Z and clocks. Subtraction is "adding the two's
 * complement of the second operand", C and DC are carries out of bits 7 and 3 of that sum
 * (Register 4-1 note), so they read as "no borrow".
 */
import { describe, expect, it } from "vitest"
import { PicCpu, type PicSystem } from "@/mcu/pic/cpu"
import { PIC16F628A } from "@/mcu/pic/chip"
import * as A from "../lib/pic-asm"

const REG = 0x20
const C = 1
const DC = 2
const Z = 4

function core() {
  const system: PicSystem = {
    sleep: () => true,
    clrwdt: () => {},
    option: () => {},
    tris: () => {},
    acknowledge: () => {},
    retfie: () => {},
    canWake: () => false,
    wakeCycles: () => 0,
    reserved: () => {},
    service: () => {},
  }
  const cpu = new PicCpu(PIC16F628A, system)
  cpu.reset()
  return cpu
}

/** Run the one instruction at 0 and return the instruction cycles it took. */
function step(cpu: PicCpu, word: number[], w: number, f: number, status: number): number {
  cpu.flash[0] = word[0]
  cpu.invalidate(0, 1)
  cpu.pc = 0
  cpu.w = w
  cpu.poke(REG, f)
  cpu.poke(A.STATUS, status)
  const before = cpu.cycles
  cpu.run(cpu.cycles + 1)
  return cpu.cycles - before
}

type Ref = { R: number; c?: number; dc?: number; z?: number }
/** STATUS after the instruction: only the flags the reference names change. */
function statusOf(old: number, r: Ref) {
  let s = old
  const put = (m: number, v: number | undefined) => {
    if (v !== undefined) s = v ? s | m : s & ~m
  }
  put(C, r.c)
  put(DC, r.dc)
  put(Z, r.z)
  return s
}
const zero = (R: number) => (R === 0 ? 1 : 0)

function add(a: number, b: number): Ref {
  const sum = a + b
  const R = sum & 0xff
  return { R, c: sum > 0xff ? 1 : 0, dc: (a & 0x0f) + (b & 0x0f) > 0x0f ? 1 : 0, z: zero(R) }
}
/** a − b as a + (two's complement of b): C and DC are the carries of that addition. */
function sub(a: number, b: number): Ref {
  const nb = ~b & 0xff
  const sum = a + nb + 1
  const R = sum & 0xff
  return { R, c: sum > 0xff ? 1 : 0, dc: (a & 0x0f) + (nb & 0x0f) + 1 > 0x0f ? 1 : 0, z: zero(R) }
}

type ByteOp = { name: string; enc: (f: number, d: 0 | 1) => number[]; ref: (w: number, f: number, status: number) => Ref }
const BYTE: ByteOp[] = [
  { name: "ADDWF", enc: A.addwf, ref: (w, f) => add(w, f) },
  { name: "SUBWF", enc: A.subwf, ref: (w, f) => sub(f, w) },
  { name: "ANDWF", enc: A.andwf, ref: (w, f) => ({ R: w & f, z: zero(w & f) }) },
  { name: "IORWF", enc: A.iorwf, ref: (w, f) => ({ R: w | f, z: zero(w | f) }) },
  { name: "XORWF", enc: A.xorwf, ref: (w, f) => ({ R: w ^ f, z: zero(w ^ f) }) },
  { name: "COMF", enc: A.comf, ref: (_w, f) => ({ R: ~f & 0xff, z: zero(~f & 0xff) }) },
  { name: "DECF", enc: A.decf, ref: (_w, f) => ({ R: (f - 1) & 0xff, z: zero((f - 1) & 0xff) }) },
  { name: "INCF", enc: A.incf, ref: (_w, f) => ({ R: (f + 1) & 0xff, z: zero((f + 1) & 0xff) }) },
  { name: "MOVF", enc: A.movf, ref: (_w, f) => ({ R: f, z: zero(f) }) },
  // RLF: C ← f<7>, f<6:0> shift up, f<0> ← C. RRF: C ← f<0>, f<7> ← C.
  { name: "RLF", enc: A.rlf, ref: (_w, f, s) => ({ R: ((f << 1) | (s & C)) & 0xff, c: f >> 7 }) },
  { name: "RRF", enc: A.rrf, ref: (_w, f, s) => ({ R: (f >> 1) | ((s & C) << 7), c: f & 1 }) },
  { name: "SWAPF", enc: A.swapf, ref: (_w, f) => ({ R: ((f & 0x0f) << 4) | (f >> 4) }) },
]

type LitOp = { name: string; enc: (k: number) => number[]; ref: (w: number, k: number) => Ref }
const LIT: LitOp[] = [
  { name: "ADDLW", enc: A.addlw, ref: (w, k) => add(w, k) },
  { name: "SUBLW", enc: A.sublw, ref: (w, k) => sub(k, w) },
  { name: "ANDLW", enc: A.andlw, ref: (w, k) => ({ R: w & k, z: zero(w & k) }) },
  { name: "IORLW", enc: A.iorlw, ref: (w, k) => ({ R: w | k, z: zero(w | k) }) },
  { name: "XORLW", enc: A.xorlw, ref: (w, k) => ({ R: w ^ k, z: zero(w ^ k) }) },
  { name: "MOVLW", enc: A.movlw, ref: (_w, k) => ({ R: k }) },
]

// TO and PD set (as after power-up), bank 0, the three flags in every combination.
const STATUSES = [0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]
const ALL = Array.from({ length: 256 }, (_, i) => i)

describe("PIC16 ALU against DS40044G §15.2", () => {
  for (const op of BYTE) {
    it(`${op.name} f,W and f,F on every W, f and incoming flags`, () => {
      const cpu = core()
      const bad: string[] = []
      // Single-operand ops ignore W: one W suffices; the two-operand ones take every W.
      const ws = op.name.endsWith("WF") ? ALL : [0x5a]
      for (const d of [0, 1] as const)
        for (const s of STATUSES)
          for (const w of ws)
            for (const f of ALL) {
              const ref = op.ref(w, f, s)
              const cycles = step(cpu, op.enc(REG, d), w, f, s)
              const gotW = cpu.w
              const gotF = cpu.peek(REG)
              const gotS = cpu.peek(A.STATUS)
              const wantW = d === 0 ? ref.R : w
              const wantF = d === 1 ? ref.R : f
              const wantS = statusOf(s, ref)
              if (gotW !== wantW || gotF !== wantF || gotS !== wantS || cycles !== 1)
                if (bad.length < 10) bad.push(`d=${d} W=${w} f=${f} S=${s.toString(16)}: got W=${gotW} f=${gotF} S=${gotS.toString(16)} ${cycles}cy, want W=${wantW} f=${wantF} S=${wantS.toString(16)} 1cy`)
            }
      expect(bad).toEqual([])
    })
  }

  for (const op of LIT) {
    it(`${op.name} on every W, k and incoming flags`, () => {
      const cpu = core()
      const bad: string[] = []
      for (const s of STATUSES)
        for (const w of ALL)
          for (const k of ALL) {
            const ref = op.ref(w, k)
            const cycles = step(cpu, op.enc(k), w, 0, s)
            const gotS = cpu.peek(A.STATUS)
            const wantS = statusOf(s, ref)
            if (cpu.w !== ref.R || gotS !== wantS || cycles !== 1)
              if (bad.length < 10) bad.push(`W=${w} k=${k} S=${s.toString(16)}: got W=${cpu.w} S=${gotS.toString(16)} ${cycles}cy, want W=${ref.R} S=${wantS.toString(16)}`)
          }
      expect(bad).toEqual([])
    })
  }

  it("CLRF sets Z and clears f; CLRW sets Z and clears W; MOVWF moves W and leaves the flags", () => {
    const cpu = core()
    for (const s of STATUSES) {
      expect(step(cpu, A.clrf(REG), 0x33, 0xa5, s)).toBe(1)
      expect([cpu.peek(REG), cpu.w, cpu.peek(A.STATUS)]).toEqual([0, 0x33, s | Z])
      expect(step(cpu, A.clrw(), 0x33, 0xa5, s)).toBe(1)
      expect([cpu.peek(REG), cpu.w, cpu.peek(A.STATUS)]).toEqual([0xa5, 0, s | Z])
      expect(step(cpu, A.movwf(REG), 0x00, 0xa5, s)).toBe(1)
      expect([cpu.peek(REG), cpu.w, cpu.peek(A.STATUS)]).toEqual([0, 0, s])
    }
  })

  it("BCF/BSF change one bit of f and no flag", () => {
    const cpu = core()
    for (const s of [0x18, 0x1f])
      for (const f of ALL)
        for (let b = 0; b < 8; b++) {
          step(cpu, A.bcf(REG, b), 0, f, s)
          expect([cpu.peek(REG), cpu.peek(A.STATUS)]).toEqual([f & ~(1 << b), s])
          step(cpu, A.bsf(REG, b), 0, f, s)
          expect([cpu.peek(REG), cpu.peek(A.STATUS)]).toEqual([f | (1 << b), s])
        }
  })

  it("the examples printed in §15.2", () => {
    const cpu = core()
    step(cpu, A.addlw(0x15), 0x10, 0, 0x18)
    expect(cpu.w).toBe(0x25)
    step(cpu, A.andlw(0x5f), 0xa3, 0, 0x18)
    expect(cpu.w).toBe(0x03)
    // ADDWF REG1,0: W = 0x17, REG1 = 0xC2 → W = 0xD9, Z = C = DC = 0.
    step(cpu, A.addwf(REG, 0), 0x17, 0xc2, 0x1f)
    expect([cpu.w, cpu.peek(REG), cpu.peek(A.STATUS) & 7]).toEqual([0xd9, 0xc2, 0])
    // ANDWF REG1,1: W = 0x17, REG1 = 0xC2 → REG1 = 0x02.
    step(cpu, A.andwf(REG, 1), 0x17, 0xc2, 0x18)
    expect([cpu.w, cpu.peek(REG)]).toEqual([0x17, 0x02])
    step(cpu, A.bcf(REG, 7), 0, 0xc7, 0x18)
    expect(cpu.peek(REG)).toBe(0x47)
    step(cpu, A.bsf(REG, 7), 0, 0x0a, 0x18)
    expect(cpu.peek(REG)).toBe(0x8a)
    step(cpu, A.comf(REG, 0), 0, 0x13, 0x18)
    expect([cpu.peek(REG), cpu.w]).toEqual([0x13, 0xec])
    step(cpu, A.decf(REG, 1), 0, 0x01, 0x18)
    expect([cpu.peek(REG), cpu.peek(A.STATUS) & Z]).toEqual([0, Z])
    step(cpu, A.incf(REG, 1), 0, 0xff, 0x18)
    expect([cpu.peek(REG), cpu.peek(A.STATUS) & Z]).toEqual([0, Z])
    step(cpu, A.iorlw(0x35), 0x9a, 0, 0x1c)
    expect([cpu.w, cpu.peek(A.STATUS) & Z]).toEqual([0xbf, 0])
    // IORWF REG1,0: REG1 = 0x13, W = 0x91 → W = 0x93 (the printed "Z = 1" is a misprint: 0x93 is not zero).
    step(cpu, A.iorwf(REG, 0), 0x91, 0x13, 0x18)
    expect([cpu.peek(REG), cpu.w, cpu.peek(A.STATUS) & Z]).toEqual([0x13, 0x93, 0])
    step(cpu, A.movwf(REG), 0x4f, 0xff, 0x18)
    expect([cpu.peek(REG), cpu.w]).toEqual([0x4f, 0x4f])
    step(cpu, A.rlf(REG, 0), 0, 0b1110_0110, 0x18)
    expect([cpu.peek(REG), cpu.w, cpu.peek(A.STATUS) & C]).toEqual([0b1110_0110, 0b1100_1100, C])
    step(cpu, A.rrf(REG, 0), 0, 0b1110_0110, 0x18)
    expect([cpu.peek(REG), cpu.w, cpu.peek(A.STATUS) & C]).toEqual([0b1110_0110, 0b0111_0011, 0])
    // SUBLW 0x02 with W = 1, 2, 3 → 1 (C = 1), 0 (C = 1), 0xFF (C = 0).
    for (const [w, r, c] of [[1, 1, C], [2, 0, C], [3, 0xff, 0]]) {
      step(cpu, A.sublw(0x02), w, 0, 0x18)
      expect([cpu.w, cpu.peek(A.STATUS) & C]).toEqual([r, c])
    }
    // SUBWF REG1,1 with W = 2: REG1 3 → 1 (C, DC, ¬Z); 2 → 0 (C, DC, Z); 1 → 0xFF (¬C, ¬DC, ¬Z).
    for (const [f, r, flags] of [[3, 1, C | DC], [2, 0, C | DC | Z], [1, 0xff, 0]]) {
      step(cpu, A.subwf(REG, 1), 2, f, 0x18)
      expect([cpu.peek(REG), cpu.w, cpu.peek(A.STATUS) & 7]).toEqual([r, 2, flags])
    }
    step(cpu, A.swapf(REG, 0), 0, 0xa5, 0x18)
    expect([cpu.peek(REG), cpu.w]).toEqual([0xa5, 0x5a])
    step(cpu, A.xorlw(0xaf), 0xb5, 0, 0x18)
    expect(cpu.w).toBe(0x1a)
    step(cpu, A.xorwf(REG, 1), 0xb5, 0xaf, 0x18)
    expect([cpu.peek(REG), cpu.w]).toEqual([0x1a, 0xb5])
  })
})
