/**
 * The mid-range PIC core outside the ALU, each check from a line of DS40044G (Figure/Table/§
 * cited at the check): memory banks and mirrors, the core registers, STATUS as a destination,
 * PCL/PCLATH and computed GOTOs, CALL/GOTO paging, the 8-level circular stack, branch and skip
 * timing, program memory wrap-around, the interrupt response of Figure 14-15 and the wake-up
 * from Sleep of Figure 14-17.
 */
import { describe, expect, it } from "vitest"
import { PicCpu, type PicSystem } from "@/mcu/pic/cpu"
import { PIC16F627A, PIC16F628A, PIC16F648A, type PicProfile } from "@/mcu/pic/chip"
import * as A from "../lib/pic-asm"

type Calls = { sleep: number; clrwdt: number; option: number[]; tris: [number, number][]; ack: number; retfie: number; reserved: number[] }

function core(chip: PicProfile = PIC16F628A, opts: { sleep?: boolean; wake?: () => boolean; wakeCycles?: number } = {}) {
  const calls: Calls = { sleep: 0, clrwdt: 0, option: [], tris: [], ack: 0, retfie: 0, reserved: [] }
  const system: PicSystem = {
    sleep: () => {
      calls.sleep++
      return opts.sleep ?? true
    },
    clrwdt: () => void calls.clrwdt++,
    option: (w) => void calls.option.push(w),
    tris: (f, w) => void calls.tris.push([f, w]),
    acknowledge: () => {
      calls.ack++
      cpu.irqAt = Infinity
    },
    retfie: () => void calls.retfie++,
    canWake: () => opts.wake?.() ?? false,
    wakeCycles: () => opts.wakeCycles ?? 0,
    reserved: (word) => void calls.reserved.push(word),
    service: () => {},
  }
  const cpu = new PicCpu(chip, system)
  return { cpu, calls }
}

function load(cpu: PicCpu, words: number[], at = 0) {
  cpu.flash.set(words, at)
  cpu.invalidate()
  cpu.reset()
}

/** Execute one instruction; returns where it was and the cycle it began. */
function step(cpu: PicCpu) {
  cpu.run(cpu.cycles + 1)
  return { pc: cpu.opPc, start: cpu.opStart }
}
function steps(cpu: PicCpu, n: number) {
  return Array.from({ length: n }, () => step(cpu))
}
/** Bank-select through STATUS with plain MOVWF (RP1:RP0 → bank, IRP as given). */
const bank = (b: number, irp = 0) => A.prog(A.movlw((irp << 7) | (b << 5) | 0x18), A.movwf(A.STATUS))

describe("PIC16 core: data memory (§4.2, Figures 4-2/4-3, Table 4-1)", () => {
  it("resets to STATUS 0001 1xxx, PCLATH ---0 0000, PCL 0000 0000 and PC 0 (Table 4-3)", () => {
    const { cpu } = core()
    cpu.reset()
    expect(cpu.peek(A.STATUS) & 0xf8).toBe(0x18)
    expect(cpu.peek(A.PCLATH)).toBe(0)
    expect(cpu.peek(A.PCL)).toBe(0)
    expect(cpu.pc).toBe(0)
  })

  it("selects the bank for direct addressing with RP1:RP0 (Table 4-2)", () => {
    const { cpu } = core(PIC16F648A)
    const prog: number[] = []
    for (let b = 0; b < 4; b++) prog.push(...bank(b), A.movlw(0x10 + b)[0], A.movwf(0x20)[0])
    load(cpu, prog)
    cpu.run(prog.length)
    expect([0x020, 0x0a0, 0x120, 0x1a0].map((a) => cpu.peek(a))).toEqual([0x10, 0x11, 0x12, 0])
  })

  it("maps 70h–7Fh into every bank as common RAM (Table 4-1)", () => {
    const { cpu } = core()
    load(cpu, [0, 1, 2, 3].flatMap((b) => [...bank(b), ...A.movlw(0xc0 + b), ...A.movwf(0x70 + b)]))
    cpu.run(16)
    for (const base of [0x70, 0xf0, 0x170, 0x1f0]) expect([0, 1, 2, 3].map((i) => cpu.peek(base + i))).toEqual([0xc0, 0xc1, 0xc2, 0xc3])
  })

  it("has 48 bytes of bank 2 GPR on the 627A/628A and 80 on the 648A; the gap reads 0 (Table 4-1, Figures 4-2/4-3)", () => {
    for (const [chip, gpr] of [
      [PIC16F627A, 0x30],
      [PIC16F628A, 0x30],
      [PIC16F648A, 0x50],
    ] as const) {
      const { cpu } = core(chip)
      cpu.reset()
      for (let a = 0x120; a < 0x170; a++) cpu.poke(a, 0xa5)
      for (let a = 0x120; a < 0x170; a++) expect(cpu.peek(a), `${chip.name} 0x${a.toString(16)}`).toBe(a < 0x120 + gpr ? 0xa5 : 0)
      // Bank 3 has only the common RAM; bank 1 GPR is A0h–EFh.
      cpu.poke(0x1a0, 0x55)
      expect(cpu.peek(0x1a0)).toBe(0)
      cpu.poke(0xa0, 0x55)
      cpu.poke(0xef, 0x56)
      expect([cpu.peek(0xa0), cpu.peek(0xef)]).toEqual([0x55, 0x56])
    }
  })

  it("mirrors PCL, STATUS, FSR and PCLATH in all four banks (Figures 4-2/4-3)", () => {
    const { cpu } = core()
    cpu.reset()
    for (const b of [0, 0x80, 0x100, 0x180]) {
      cpu.poke(b + A.FSR, 0x40 + (b >> 7))
      expect([0, 0x80, 0x100, 0x180].map((m) => cpu.peek(m + A.FSR))).toEqual(Array(4).fill(0x40 + (b >> 7)))
      cpu.poke(b + A.PCLATH, 0x05 + (b >> 7))
      expect(cpu.peek(A.PCLATH)).toBe(0x05 + (b >> 7))
    }
  })

  it("reaches all 512 addresses through INDF with IRP:FSR (§4.4, Figure 4-5)", () => {
    const { cpu } = core()
    load(cpu, A.prog(A.movlw(0x30), A.movwf(A.FSR), A.movlw(0x11), A.movwf(A.INDF), bank(0, 1), A.movlw(0x22), A.movwf(A.INDF), A.movf(A.INDF, 0)))
    cpu.run(8)
    // The last MOVF INDF,W reads back through IRP:FSR = 130h.
    cpu.w = 0
    cpu.run(9)
    expect([cpu.peek(0x30), cpu.peek(0x130), cpu.w]).toEqual([0x11, 0x22, 0x22])
    // FSR = 0xB0 with IRP = 0 is bank 1's B0h.
    load(cpu, A.prog(A.movlw(0xb0), A.movwf(A.FSR), A.movf(A.INDF, 0)))
    cpu.poke(0xb0, 0x77)
    cpu.run(3)
    expect(cpu.w).toBe(0x77)
  })

  it("reads INDF through INDF (FSR = 0) as 00h, and a write there does nothing but the flags (§4.4)", () => {
    const { cpu } = core()
    load(cpu, A.prog(A.clrf(A.FSR), A.movlw(0x5a), A.movf(A.INDF, 0), A.movlw(0x5a), A.movwf(A.INDF), A.comf(A.INDF, 1)))
    cpu.run(3)
    expect(cpu.w).toBe(0)
    expect(cpu.peek(A.STATUS) & 4).toBe(4)
    cpu.run(cpu.cycles + 2)
    expect(cpu.peek(A.FSR)).toBe(0)
    // COMF INDF,1 through FSR = 0: reads 0, the result 0xFF goes nowhere, Z is cleared.
    cpu.run(cpu.cycles + 1)
    expect(cpu.peek(A.STATUS) & 4).toBe(0)
    expect(cpu.peek(A.FSR)).toBe(0)
  })
})

describe("PIC16 core: read-modify-write (§15.1, DS33023A §29.6 vs §29.5 Q-cycles)", () => {
  it("every instruction naming a file register reads it, CLRF and MOVWF included", () => {
    const { cpu } = core()
    let reads = 0
    const writes: number[] = []
    cpu.hook([0x06, 0x106], { name: "PORTB", read: () => (reads++, 0x5a), write: (v) => void writes.push(v) })
    load(cpu, A.prog(A.clrf(0x06), A.movlw(0x33), A.movwf(0x06), A.bsf(0x06, 0), A.movf(0x06, 0)))
    cpu.run(5)
    expect(reads).toBe(4)
    expect(writes).toEqual([0x00, 0x33, 0x5b])
  })
})

describe("PIC16 core: power-on values (Table 14-7 'x', decision D2 in docs/pic16-checklist.md)", () => {
  it("W, FSR, C/DC/Z, the RAM and the stack pointer come up unknown at power-on and are kept by other resets", () => {
    const { cpu } = core()
    const seeds = [1, 2].map((seed) => {
      let x = seed
      const rnd = () => ((x = (x * 1103515245 + 12345) >>> 0), x / 2 ** 32)
      cpu.powerOn(rnd)
      return [cpu.w, cpu.peek(A.FSR), cpu.peek(A.STATUS) & 7, ...Array.from({ length: 16 }, (_, i) => cpu.peek(0x20 + i))]
    })
    expect(seeds[0]).not.toEqual(seeds[1])
    // TO and PD are set and the bank bits clear on power-on, whatever came up (Table 14-6).
    expect(cpu.peek(A.STATUS) & 0xf8).toBe(0x18)
    cpu.poke(0x20, 0x77)
    cpu.w = 0x12
    cpu.reset()
    expect([cpu.peek(0x20), cpu.w]).toEqual([0x77, 0x12])
  })

  it("tracks which RAM the program has written since power-on (for the inspector)", () => {
    const { cpu } = core()
    cpu.powerOn(() => 0.5)
    load(cpu, A.prog(A.movlw(1), A.movwf(0x21)))
    cpu.run(2)
    expect(cpu.written(0x21)).toBe(true)
    expect(cpu.written(0x22)).toBe(false)
  })
})

describe("PIC16 core: STATUS as a destination (§4.2.2.1, Register 4-1)", () => {
  it("CLRF STATUS clears the upper three bits and sets Z: 000uu1uu", () => {
    const { cpu } = core()
    for (const before of [0xff, 0xe7, 0x18, 0x1b, 0x03]) {
      load(cpu, A.clrf(A.STATUS))
      cpu.poke(A.STATUS, before)
      const was = cpu.peek(A.STATUS)
      cpu.run(1)
      expect(cpu.peek(A.STATUS), `from 0x${was.toString(16)}`).toBe((was & 0x1b) | 0x04)
    }
  })

  it("TO and PD are not writable; MOVWF, BSF, BCF and SWAPF write the other bits", () => {
    const { cpu } = core()
    load(cpu, A.prog(A.movlw(0x00), A.movwf(A.STATUS)))
    cpu.run(2)
    expect(cpu.peek(A.STATUS)).toBe(0x18)
    // With PD clear (after a SLEEP), MOVWF 0xFF cannot set it back.
    load(cpu, A.prog(A.movlw(0xff), A.movwf(A.STATUS)))
    cpu.poke(A.STATUS, 0x10)
    cpu.run(2)
    expect(cpu.peek(A.STATUS)).toBe(0xf7)
    load(cpu, A.prog(A.bsf(A.STATUS, A.Z), A.bsf(A.STATUS, A.C), A.bcf(A.STATUS, A.TO), A.swapf(A.STATUS, 1)))
    // C, DC and Z are unknown after a reset (Table 4-3: 0001 1xxx): start from clear ones.
    cpu.poke(A.STATUS, 0x18)
    cpu.run(3)
    expect(cpu.peek(A.STATUS)).toBe(0x1d)
    cpu.run(4)
    // SWAPF 0x1D → 0xD1: IRP, RP1 and C written, TO/PD kept, Z/DC from the swap (SWAPF affects no flag).
    expect(cpu.peek(A.STATUS)).toBe(0xd9)
  })

  it("an instruction that affects C, DC or Z cannot write those bits: ADDWF STATUS,F keeps the ALU flags", () => {
    const { cpu } = core()
    // STATUS = 0x18, W = 0xE8: sum 0x100 → result 0x00 written to bits 7–5, C = 1, DC = 1 (8 + 8), Z = 1.
    load(cpu, A.prog(A.movlw(0xe8), A.addwf(A.STATUS, 1)))
    cpu.run(2)
    expect(cpu.peek(A.STATUS)).toBe(0x1f)
    // W = 0x40: 0x18 + 0x40 = 0x58 → upper bits 010 (bank 2), no carries, not zero.
    load(cpu, A.prog(A.movlw(0x40), A.addwf(A.STATUS, 1)))
    cpu.run(2)
    expect(cpu.peek(A.STATUS)).toBe(0x58)
  })
})

describe("PIC16 core: program counter (§4.3, Figure 4-4)", () => {
  it("reads PCL as the low byte of the next instruction's address", () => {
    const { cpu } = core()
    const prog = new Array(0x105).fill(A.nop()[0])
    prog[0x103] = A.movf(A.PCL, 0)[0]
    load(cpu, prog)
    cpu.run(0x104)
    expect(cpu.opPc).toBe(0x103)
    expect(cpu.w).toBe(0x04)
  })

  it("loads PCH from PCLATH<4:0> on any write to PCL: a computed GOTO takes two cycles", () => {
    const { cpu } = core()
    const words = new Array(0x800).fill(A.nop()[0])
    words.splice(0, 4, ...A.movlw(0x03), ...A.movwf(A.PCLATH), ...A.movlw(0x10), ...A.movwf(A.PCL))
    load(cpu, words)
    const trace = steps(cpu, 5)
    expect(trace.map((t) => t.pc)).toEqual([0, 1, 2, 3, 0x310])
    expect(trace[4].start - trace[3].start).toBe(2)
  })

  it("ADDWF PCL,F jumps into a RETLW table relative to the next instruction (§4.3.1, RETLW example)", () => {
    const { cpu } = core()
    // 0: MOVLW 2; 1: CALL 3; 2: (return here); 3: ADDWF PCL,F; 4..: RETLW 10, 11, 12, 13
    load(cpu, A.prog(A.movlw(2), A.call(3), A.nop(), A.addwf(A.PCL, 1), A.retlw(10), A.retlw(11), A.retlw(12), A.retlw(13)))
    const trace = steps(cpu, 5)
    expect(trace.map((t) => t.pc)).toEqual([0, 1, 3, 6, 2])
    expect(cpu.w).toBe(12)
    // MOVLW 1, CALL 2, ADDWF 2, RETLW 2: the call returns 6 cycles after it began.
    expect(trace[4].start - trace[1].start).toBe(6)
  })

  it("takes PC<12:11> from PCLATH<4:3> on CALL and GOTO (§4.3, CALL/GOTO)", () => {
    const { cpu } = core(PIC16F648A)
    const words = new Array(0x1000).fill(A.nop()[0])
    words.splice(0, 3, ...A.movlw(0x1f), ...A.movwf(A.PCLATH), ...A.goto(0x123))
    // PCLATH = 0x1F: PCLATH<2:0> are ignored by GOTO, PC<12:11> = 11 → 0x1923, which wraps to 0x0923 on 4K words.
    words[0x923] = A.call(0x7ff)[0]
    load(cpu, words)
    const trace = steps(cpu, 5)
    expect(trace.map((t) => t.pc)).toEqual([0, 1, 2, 0x923, 0xfff])
    expect(trace[3].start - trace[2].start).toBe(2)
    expect(trace[4].start - trace[3].start).toBe(2)
  })

  it("wraps program memory above 1K/2K/4K words back into the implemented space (§4.1)", () => {
    for (const chip of [PIC16F627A, PIC16F628A, PIC16F648A]) {
      const { cpu } = core(chip)
      const words = new Array(chip.flashWords).fill(A.nop()[0])
      words.splice(0, 3, ...A.movlw(0x08), ...A.movwf(A.PCLATH), ...A.goto(0x005))
      words[5] = A.movlw(0x77)[0]
      load(cpu, words)
      // PCLATH<4:3> = 01: GOTO 0x805 lands on 0x005 on the 1K and 2K parts, on 0x805 on the 4K one.
      const t = steps(cpu, 4)
      expect(t[3].pc, chip.name).toBe(chip.flashWords > 0x800 ? 0x805 : 0x005)
      // Running off the end wraps to 0.
      load(cpu, new Array(chip.flashWords).fill(A.nop()[0]))
      cpu.run(chip.flashWords + 1)
      expect(cpu.opPc, chip.name).toBe(0)
    }
  })

  it("keeps an 8-level circular stack: the ninth CALL overwrites the first return address (§4.3.2)", () => {
    const { cpu } = core()
    // Nine nested calls: 0 → 10, 10 → 20, … 80 → 90; at 90 nine RETURNs follow the chain back.
    const words = new Array(0x200).fill(A.nop()[0])
    words[0] = A.call(0x10)[0]
    for (let i = 1; i <= 8; i++) words[i * 0x10] = A.call((i + 1) * 0x10)[0]
    for (let i = 1; i <= 9; i++) words[i * 0x10 + 1] = A.return_()[0]
    words[0x90] = A.return_()[0]
    load(cpu, words)
    const pcs = steps(cpu, 9 + 9 + 1).map((t) => t.pc)
    // Nine pushes (0x01, 0x11, …, 0x81): the ninth overwrites the slot of the first. Pops: 0x81 … 0x11, then 0x81 again.
    expect(pcs.slice(0, 9)).toEqual([0, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80])
    expect(pcs.slice(9, 18)).toEqual([0x90, 0x81, 0x71, 0x61, 0x51, 0x41, 0x31, 0x21, 0x11])
    expect(pcs[18]).toBe(0x81)
  })

  it("leaves PCLATH alone on CALL and RETURN (§4.3.2)", () => {
    const { cpu } = core()
    const words = new Array(0x800).fill(A.nop()[0])
    // PCLATH = 0x0D: CALL 0x050 goes to 0x850, which is 0x050 on the 2K part.
    words.splice(0, 3, ...A.movlw(0x0d), ...A.movwf(A.PCLATH), ...A.call(0x050))
    words[0x050] = A.return_()[0]
    load(cpu, words)
    const t = steps(cpu, 5)
    expect(t.map((s) => s.pc)).toEqual([0, 1, 2, 0x050, 3])
    expect(cpu.peek(A.PCLATH)).toBe(0x0d)
  })
})

describe("PIC16 core: instruction timing (Table 15-2, note 3)", () => {
  const timing = (words: number[], setup?: (cpu: PicCpu) => void) => {
    const { cpu } = core()
    load(cpu, [...words, ...A.nop(), ...A.nop(), ...A.nop()])
    setup?.(cpu)
    const before = cpu.cycles
    cpu.run(cpu.cycles + 1)
    return { cycles: cpu.cycles - before, pc: cpu.pc }
  }

  it("takes one cycle for every non-branching instruction", () => {
    for (const w of [A.nop(), A.movlw(1), A.addlw(1), A.clrwdt(), A.movwf(0x20), A.bsf(0x20, 1), A.incf(0x20, 1), A.option(), A.tris(6)])
      expect(timing(w).cycles, `0x${w[0].toString(16)}`).toBe(1)
  })

  it("takes two cycles for GOTO, CALL, RETURN, RETLW and RETFIE", () => {
    expect(timing(A.goto(2)).cycles).toBe(2)
    expect(timing(A.call(2)).cycles).toBe(2)
    for (const w of [A.return_(), A.retlw(3), A.retfie()]) expect(timing(w, (cpu) => cpu.push(2)).cycles).toBe(2)
  })

  it("takes two cycles when a skip is taken and one when it is not", () => {
    const at = (f: number) => (cpu: PicCpu) => cpu.poke(0x20, f)
    expect(timing(A.btfsc(0x20, 0), at(0))).toEqual({ cycles: 2, pc: 2 })
    expect(timing(A.btfsc(0x20, 0), at(1))).toEqual({ cycles: 1, pc: 1 })
    expect(timing(A.btfss(0x20, 7), at(0x80))).toEqual({ cycles: 2, pc: 2 })
    expect(timing(A.btfss(0x20, 7), at(0))).toEqual({ cycles: 1, pc: 1 })
    expect(timing(A.decfsz(0x20, 1), at(1))).toEqual({ cycles: 2, pc: 2 })
    expect(timing(A.decfsz(0x20, 1), at(2))).toEqual({ cycles: 1, pc: 1 })
    expect(timing(A.incfsz(0x20, 0), at(0xff))).toEqual({ cycles: 2, pc: 2 })
    expect(timing(A.incfsz(0x20, 0), at(0))).toEqual({ cycles: 1, pc: 1 })
  })

  it("DECFSZ/INCFSZ leave the flags alone; d = 0 puts the count in W", () => {
    const { cpu } = core()
    load(cpu, A.prog(A.decfsz(0x20, 0), A.nop(), A.incfsz(0x21, 1)))
    cpu.poke(0x20, 1)
    cpu.poke(0x21, 0xff)
    cpu.poke(A.STATUS, 0x18)
    cpu.run(4)
    expect([cpu.w, cpu.peek(0x20), cpu.peek(0x21), cpu.peek(A.STATUS) & 7]).toEqual([0, 1, 0, 0])
  })
})

describe("PIC16 core: special instructions", () => {
  it("SLEEP clears PD and sets TO; CLRWDT sets both (CLRWDT, SLEEP)", () => {
    const { cpu, calls } = core()
    load(cpu, A.prog(A.sleep()))
    cpu.poke(A.STATUS, 0)
    cpu.run(1)
    expect(cpu.peek(A.STATUS) & 0x18).toBe(0x10)
    expect(calls.sleep).toBe(1)
    expect(cpu.sleeping).toBe(true)
    load(cpu, A.prog(A.sleep(), A.clrwdt()))
    cpu.run(1)
    cpu.sleeping = false
    cpu.run(2)
    expect(cpu.peek(A.STATUS) & 0x18).toBe(0x18)
    expect(calls.clrwdt).toBe(1)
  })

  it("SLEEP is a NOP when an enabled interrupt is already pending with GIE clear (§14.8.1 note)", () => {
    const { cpu } = core(PIC16F628A, { sleep: false })
    load(cpu, A.prog(A.sleep(), A.movlw(9)))
    cpu.run(2)
    expect(cpu.sleeping).toBe(false)
    expect(cpu.w).toBe(9)
    // Completed as a NOP: TO not set, PD not cleared (DS33023A §26.4.2).
    expect(cpu.peek(A.STATUS) & 0x18).toBe(0x18)
  })

  it("OPTION and TRIS hand W to the system (DS33023A §29.5)", () => {
    const { cpu, calls } = core()
    load(cpu, A.prog(A.movlw(0x87), A.option(), A.movlw(0x0f), A.tris(5), A.movlw(0xf0), A.tris(6)))
    cpu.run(6)
    expect(calls.option).toEqual([0x87])
    expect(calls.tris).toEqual([
      [5, 0x0f],
      [6, 0xf0],
    ])
  })

  it("decodes the don't-care bits: CLRW 0x0100–0x017F, NOP 0x0000/20/40/60, MOVLW/RETLW 0x3x00, ADDLW/SUBLW with x = 1 (Table 15-2)", () => {
    const { cpu, calls } = core()
    for (const w of [0x0100, 0x0103, 0x017f]) {
      load(cpu, [w])
      cpu.w = 7
      cpu.run(1)
      expect(cpu.w).toBe(0)
    }
    for (const w of [0x0000, 0x0020, 0x0040, 0x0060]) {
      load(cpu, [w])
      cpu.run(1)
      expect(cpu.pc).toBe(1)
    }
    load(cpu, [0x3355])
    cpu.run(1)
    expect(cpu.w).toBe(0x55)
    load(cpu, [0x3f01])
    cpu.w = 1
    cpu.run(1)
    expect(cpu.w).toBe(2)
    load(cpu, [0x3d05])
    cpu.w = 1
    cpu.run(1)
    expect(cpu.w).toBe(4)
    expect(calls.reserved).toEqual([])
  })

  it("reports reserved opcodes and runs them as one-cycle NOPs (Table 15-2 note 1: the silicon's behaviour is undefined)", () => {
    const { cpu, calls } = core()
    for (const w of [0x0001, 0x0061, 0x0068, 0x007f, 0x000a]) {
      load(cpu, [w])
      cpu.w = 3
      cpu.run(1)
      expect([cpu.pc, cpu.w, cpu.cycles]).toEqual([1, 3, 1])
    }
    expect(calls.reserved).toEqual([0x0001, 0x0061, 0x0068, 0x007f, 0x000a])
  })
})

describe("PIC16 core: interrupt response (§14.5, Figure 14-15)", () => {
  const nops = (n: number) => new Array(n).fill(A.nop()[0])

  it("a synchronous request runs the current instruction, two dummy cycles, then 0004h: latency 3 TCY", () => {
    const { cpu, calls } = core()
    load(cpu, nops(32))
    cpu.run(5)
    // The request is in place at the Q1 of cycle 5: the instruction there completes, 6 and 7 are dummies.
    cpu.irqAt = 5
    const t = steps(cpu, 2)
    expect(t[0]).toEqual({ pc: 5, start: 5 })
    expect(t[1]).toEqual({ pc: 4, start: 8 })
    expect(calls.ack).toBe(1)
    // The return address is the instruction fetched but not executed (PC + 1).
    expect(cpu.stackTop()).toBe(6)
  })

  it("the latency is the same during a two-cycle instruction", () => {
    for (const at of [5, 6]) {
      const { cpu } = core()
      const words = nops(32)
      words[5] = A.goto(20)[0]
      load(cpu, words)
      cpu.run(5)
      cpu.irqAt = at
      const t = steps(cpu, 2)
      expect(t[0], `request at ${at}`).toEqual({ pc: 5, start: 5 })
      expect(t[1], `request at ${at}`).toEqual({ pc: 4, start: at + 3 })
      expect(cpu.stackTop()).toBe(20)
    }
  })

  it("an asynchronous request is sampled at the next Q1: 3 to 4 TCY", () => {
    for (const [at, vector] of [
      [4.25, 8],
      [4.75, 8],
      [5, 8],
    ] as const) {
      const { cpu } = core()
      load(cpu, nops(32))
      cpu.run(5)
      cpu.irqAt = at
      const t = steps(cpu, 2)
      expect(t[1], `request at ${at}`).toEqual({ pc: 4, start: vector })
    }
  })

  it("RETFIE returns to the instruction that was skipped over (RETFIE)", () => {
    const { cpu, calls } = core()
    const words = nops(64)
    words[0] = A.goto(16)[0]
    words[4] = A.retfie()[0]
    load(cpu, words)
    // GOTO (cycles 0–1), NOPs at 16–23 (cycles 2–9).
    cpu.run(10)
    cpu.irqAt = 10
    const t = steps(cpu, 4).map((s) => s.pc)
    expect(t).toEqual([24, 4, 25, 26])
    expect(calls.ack).toBe(1)
    expect(calls.retfie).toBe(1)
  })
})

describe("PIC16 core: wake-up from Sleep (§14.8.1, Figure 14-17)", () => {
  it("wakes after the start-up time, runs the instruction after SLEEP, two dummy cycles, then 0004h", () => {
    let wake = false
    const { cpu } = core(PIC16F628A, { wake: () => wake, wakeCycles: 256 })
    const words = new Array(32).fill(A.nop()[0])
    words[2] = A.sleep()[0]
    load(cpu, words)
    cpu.run(3)
    expect(cpu.sleeping).toBe(true)
    cpu.run(100)
    expect(cpu.cycles).toBe(100)
    wake = true
    cpu.irqAt = 50
    const t = steps(cpu, 2)
    // Woken at 100, the oscillator start-up runs 256 cycles; the prefetched PC + 1 runs at 356.
    expect(t[0]).toEqual({ pc: 3, start: 356 })
    expect(t[1]).toEqual({ pc: 4, start: 359 })
    expect(cpu.stackTop()).toBe(4)
  })

  it("with GIE clear (no request) it continues in line after the SLEEP", () => {
    let wake = false
    const { cpu } = core(PIC16F628A, { wake: () => wake })
    load(cpu, A.prog(A.sleep(), A.movlw(1), A.movlw(2)))
    cpu.run(10)
    wake = true
    const t = steps(cpu, 2)
    expect(t.map((s) => s.pc)).toEqual([1, 2])
    expect(t[0].start).toBe(10)
  })
})
