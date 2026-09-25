/**
 * Thumb-2 instruction decoder for ARMv7-M with DSP and FPv4-SP extensions.
 *
 * Decoding produces a closure per instruction; the CPU caches them by address, so the
 * bit twiddling happens once per instruction and execution is a plain call. Encodings follow
 * the ARMv7-M ARM chapter A7; comments name the encoding table used (T1, T2, …).
 */
import type { Cpu } from "./cpu"
import { CpuHalt, EXC, ExceptionRequest } from "./faults"

export type Instr = {
  size: 2 | 4
  /** Base cycle cost; loads, branches and multiplies add their own. */
  cycles: number
  exec: (c: Cpu) => void
  /** Disassembly, for the debugger and for error messages. */
  text: string
  /**
   * The same semantics as `exec` as JavaScript statements for the block compiler (jit.ts):
   * over `c`, `r`, `bus`, `s`; a taken branch sets `c.pc` and ends with `$EXIT`.
   * Absent for instructions the compiler calls through `exec`.
   */
  js?: string
  /** The snippet may touch the bus or fault: state is flushed before it, checks run after. */
  jsMem?: boolean
  /**
   * A branch with a static target, for the compiler to lay out (it may continue the block
   * at the target): the condition as a JS expression (null: unconditional), the cycles a
   * taken branch adds, and whether LR gets the return address first (BL).
   */
  jsBranch?: { target: number; extra: number; cond: string | null; link: boolean }
}

// --- arithmetic helpers -------------------------------------------------------------

/** Carry and overflow of the last addWithCarry, kept here to avoid allocating a tuple. */
let lastC = 0
let lastV = 0

function addWithCarry(x: number, y: number, cin: number): number {
  x >>>= 0
  y >>>= 0
  const sum = x + y + cin
  const result = sum >>> 0
  lastC = sum > 0xffffffff ? 1 : 0
  const sx = x | 0
  const sy = y | 0
  const sr = result | 0
  lastV = (sx >= 0) === (sy >= 0) && (sr >= 0) !== (sx >= 0) ? 1 : 0
  return result
}

const SRType = { LSL: 0, LSR: 1, ASR: 2, ROR: 3, RRX: 4 } as const
type SRType = (typeof SRType)[keyof typeof SRType]

/** Carry out of the last shiftC. */
let shiftCarry = 0

/** Shift_C from A7.4.2: amount may be 0 (no shift, carry unchanged) or up to 255 for register shifts. */
function shiftC(value: number, type: SRType, amount: number, carryIn: number): number {
  value >>>= 0
  if (amount === 0) {
    shiftCarry = carryIn
    return value
  }
  switch (type) {
    case SRType.LSL:
      if (amount >= 32) {
        shiftCarry = amount === 32 ? value & 1 : 0
        return 0
      }
      shiftCarry = (value >>> (32 - amount)) & 1
      return (value << amount) >>> 0
    case SRType.LSR:
      if (amount >= 32) {
        shiftCarry = amount === 32 ? value >>> 31 : 0
        return 0
      }
      shiftCarry = (value >>> (amount - 1)) & 1
      return value >>> amount
    case SRType.ASR:
      if (amount >= 32) {
        shiftCarry = value >>> 31
        return value & 0x80000000 ? 0xffffffff : 0
      }
      shiftCarry = (value >>> (amount - 1)) & 1
      return (value >> amount) >>> 0
    case SRType.ROR: {
      const m = amount & 31
      const result = m === 0 ? value : ((value >>> m) | (value << (32 - m))) >>> 0
      shiftCarry = result >>> 31
      return result
    }
    case SRType.RRX:
      shiftCarry = value & 1
      return ((value >>> 1) | (carryIn << 31)) >>> 0
  }
}

/** DecodeImmShift (A7.4.2): returns [type, amount]. */
function decodeImmShift(type: number, imm5: number): [SRType, number] {
  switch (type) {
    case 0:
      return [SRType.LSL, imm5]
    case 1:
      return [SRType.LSR, imm5 === 0 ? 32 : imm5]
    case 2:
      return [SRType.ASR, imm5 === 0 ? 32 : imm5]
    default:
      return imm5 === 0 ? [SRType.RRX, 1] : [SRType.ROR, imm5]
  }
}

/** ThumbExpandImm_C (A5.3.2). Carry out goes to shiftCarry. */
function thumbExpandImmC(imm12: number, carryIn: number): number {
  if ((imm12 & 0xc00) === 0) {
    const b = imm12 & 0xff
    shiftCarry = carryIn
    switch ((imm12 >>> 8) & 3) {
      case 0:
        return b
      case 1:
        return ((b << 16) | b) >>> 0
      case 2:
        return ((b << 24) | (b << 8)) >>> 0
      default:
        return ((b << 24) | (b << 16) | (b << 8) | b) >>> 0
    }
  }
  const unrotated = 0x80 | (imm12 & 0x7f)
  const rot = (imm12 >>> 7) & 0x1f
  return shiftC(unrotated, SRType.ROR, rot, carryIn)
}

function signExtend(value: number, bits: number): number {
  const shift = 32 - bits
  return (value << shift) >> shift
}

const hex = (v: number) => "0x" + (v >>> 0).toString(16)
const REG = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "sp", "lr", "pc"]
const CONDS = ["eq", "ne", "cs", "cc", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "", ""]
const regList = (mask: number) => {
  const names: string[] = []
  for (let i = 0; i < 16; i++) if (mask & (1 << i)) names.push(REG[i])
  return "{" + names.join(",") + "}"
}

// --- snippets for the block compiler (jit.ts) ----------------------------------------
//
// Each is the instruction's semantics as JavaScript statements over `c` (the Cpu), `r`
// (its registers), `bus` and `s` (the FP registers). They
// mirror the closures below exactly: whatever the closure computes, the snippet computes
// the same way, and scripts/mcu-jit.ts checks the two agree on real firmware.

/** Attach a snippet to a decoded instruction. */
function J(instr: Instr, js: string, mem = false): Instr {
  instr.js = js
  if (mem) instr.jsMem = true
  return instr
}
/** N and Z from the uint32 in `v`. */
const NZ = (v: string) => `c.n = ${v} >>> 31; c.z = ${v} === 0 ? 1 : 0;`
/** a + b + cin (uint32 expressions) into r[d] (or nowhere for d < 0), optionally with all four flags. */
const ADDC = (d: number, a: string, b: string, cin: string, flags: boolean) =>
  `const a = ${a}, b = ${b}, sum = a + b + ${cin}, v = sum >>> 0; ${d >= 0 ? `r[${d}] = v;` : ""} ${flags ? `${NZ("v")} c.c = sum > 0xffffffff ? 1 : 0; c.v = (~(a ^ b) & (a ^ v)) >>> 31;` : ""}`
/** The bitwise complement of a uint32 expression, as uint32 (the b operand of a subtraction). */
const NOT = (x: string) => `(~${x} >>> 0)`
/** A shift by an immediate with the carry out, as shiftC computes it. */
function SHIFT(d: number, x: string, type: number, n: number, flags: boolean): string {
  let v: string
  let carry: string
  if (type === SRType.LSL) {
    v = `(x << ${n}) >>> 0`
    carry = `(x >>> ${32 - n}) & 1`
  } else if (type === SRType.LSR) {
    v = n === 32 ? "0" : `x >>> ${n}`
    carry = n === 32 ? "x >>> 31" : `(x >>> ${n - 1}) & 1`
  } else {
    v = n === 32 ? "(x & 0x80000000 ? 0xffffffff : 0)" : `(x >> ${n}) >>> 0`
    carry = n === 32 ? "x >>> 31" : `(x >>> ${n - 1}) & 1`
  }
  return `const x = ${x}, v = ${v}; r[${d}] = v; ${flags ? `${NZ("v")} c.c = ${carry};` : ""}`
}
/** Condition tests as condPassed evaluates them, by condition code. */
const COND_JS = [
  "c.z === 1", "c.z === 0", "c.c === 1", "c.c === 0", "c.n === 1", "c.n === 0", "c.v === 1", "c.v === 0",
  "c.c === 1 && c.z === 0", "!(c.c === 1 && c.z === 0)", "c.n === c.v", "c.n !== c.v", "c.n === c.v && c.z === 0", "!(c.n === c.v && c.z === 0)", "true", "true",
]
/**
 * Every FP snippet's entry: the coprocessor access check and the FP-context mark, as
 * `coprocessor` wraps them. The fault sets the PC itself (`$A`, the compiler fills it in),
 * so an FP instruction that touches no memory needs nothing flushed before it.
 */
export const FPX = "if (!c.fpOn) c.fpDenied($A); c.control |= 4;"
const JF = (instr: Instr, js: string, mem = false) => J(instr, `${FPX} ${js}`, mem)
/** Mark a branch with a static target for the compiler; `extra` cycles when taken. */
function BR(instr: Instr, target: number, extra: number, cond: string | null, link = false): Instr {
  instr.jsBranch = { target: (target & ~1) >>> 0, extra, cond, link }
  return instr
}

// --- helpers used by the closures ---------------------------------------------------

function setNZ(c: Cpu, result: number) {
  c.n = result >>> 31
  c.z = result === 0 ? 1 : 0
}

/** Register read where r15 yields the instruction address + 4. */
function rd(c: Cpu, n: number): number {
  return n === 15 ? c.readPc() : c.r[n]
}

/** Register write from an ALU result: writing PC is a plain branch (ALUWritePC). */
function wr(c: Cpu, n: number, value: number) {
  if (n === 15) c.branchWritePc(value)
  else c.r[n] = value >>> 0
}

/** Register write from a load: writing PC interworks (LoadWritePC). */
function wrLoad(c: Cpu, n: number, value: number) {
  if (n === 15) c.branchTo(value)
  else c.r[n] = value >>> 0
}

function unimplemented(hw1: number, hw2: number, size: 2 | 4, addr: number, what: string): Instr {
  const text = `${what} (${hw1.toString(16).padStart(4, "0")}${size === 4 ? " " + hw2.toString(16).padStart(4, "0") : ""})`
  return {
    size,
    cycles: 1,
    text,
    exec: () => {
      throw new CpuHalt("unimplemented", text, addr)
    },
  }
}

function undefinedInstr(hw1: number, hw2: number, size: 2 | 4): Instr {
  const text = `udf.${size === 4 ? "w" : "n"} ${hw1.toString(16)}${size === 4 ? hw2.toString(16) : ""}`
  return {
    size,
    cycles: 1,
    text,
    exec: (c) => c.fault(EXC.USAGE_FAULT, `undefined instruction ${text}`),
  }
}

// --- entry point --------------------------------------------------------------------

export function decode(hw1: number, hw2: number, addr: number, inIT: boolean): Instr {
  if ((hw1 & 0xf800) >= 0xe800) return decode32(hw1, hw2, addr, inIT)
  return decode16(hw1, addr, inIT)
}

// --- 16-bit encodings (A5.2) -----------------------------------------------------------

function decode16(hw: number, addr: number, inIT: boolean): Instr {
  const op = hw >>> 10
  const i2 = (cycles: number, text: string, exec: (c: Cpu) => void): Instr => ({ size: 2, cycles, text, exec })
  const setflags = !inIT

  // Shift (immediate), add, subtract, move, compare: 00xxxx
  if (op < 0x10) {
    const opc = (hw >>> 9) & 0x1f
    if (opc < 0x0c) {
      // LSL/LSR/ASR (immediate) T1
      const type = (hw >>> 11) & 3
      const imm5 = (hw >>> 6) & 0x1f
      const rdN = hw & 7
      const rm = (hw >>> 3) & 7
      const [srt, amount] = decodeImmShift(type, imm5)
      if (type === 0 && imm5 === 0) {
        // MOV (register) T2: MOVS Rd, Rm
        return J(
          i2(1, `movs ${REG[rdN]}, ${REG[rm]}`, (c) => {
            const v = c.r[rm]
            c.r[rdN] = v
            if (setflags) setNZ(c, v)
          }),
          `const v = r[${rm}]; r[${rdN}] = v; ${setflags ? NZ("v") : ""}`,
        )
      }
      const name = ["lsl", "lsr", "asr"][type]
      return J(
        i2(1, `${name}s ${REG[rdN]}, ${REG[rm]}, #${amount}`, (c) => {
          const v = shiftC(c.r[rm], srt, amount, c.c)
          c.r[rdN] = v
          if (setflags) {
            setNZ(c, v)
            c.c = shiftCarry
          }
        }),
        SHIFT(rdN, `r[${rm}]`, srt, amount, setflags),
      )
    }
    if (opc === 0x0c || opc === 0x0d) {
      // ADD/SUB (register) T1
      const rdN = hw & 7
      const rn = (hw >>> 3) & 7
      const rm = (hw >>> 6) & 7
      const sub = opc === 0x0d
      return J(
        i2(1, `${sub ? "subs" : "adds"} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
          const v = sub ? addWithCarry(c.r[rn], ~c.r[rm], 1) : addWithCarry(c.r[rn], c.r[rm], 0)
          c.r[rdN] = v
          if (setflags) {
            setNZ(c, v)
            c.c = lastC
            c.v = lastV
          }
        }),
        ADDC(rdN, `r[${rn}]`, sub ? NOT(`r[${rm}]`) : `r[${rm}]`, sub ? "1" : "0", setflags),
      )
    }
    if (opc === 0x0e || opc === 0x0f) {
      // ADD/SUB (immediate) T1: imm3
      const rdN = hw & 7
      const rn = (hw >>> 3) & 7
      const imm = (hw >>> 6) & 7
      const sub = opc === 0x0f
      return J(
        i2(1, `${sub ? "subs" : "adds"} ${REG[rdN]}, ${REG[rn]}, #${imm}`, (c) => {
          const v = sub ? addWithCarry(c.r[rn], ~imm, 1) : addWithCarry(c.r[rn], imm, 0)
          c.r[rdN] = v
          if (setflags) {
            setNZ(c, v)
            c.c = lastC
            c.v = lastV
          }
        }),
        ADDC(rdN, `r[${rn}]`, sub ? String(~imm >>> 0) : String(imm), sub ? "1" : "0", setflags),
      )
    }
    const rdN = (hw >>> 8) & 7
    const imm8 = hw & 0xff
    switch (opc >>> 2) {
      case 4: // MOV (immediate) T1
        return J(
          i2(1, `movs ${REG[rdN]}, #${imm8}`, (c) => {
            c.r[rdN] = imm8
            if (setflags) setNZ(c, imm8)
          }),
          `r[${rdN}] = ${imm8}; ${setflags ? `c.n = 0; c.z = ${imm8 === 0 ? 1 : 0};` : ""}`,
        )
      case 5: // CMP (immediate) T1
        return J(
          i2(1, `cmp ${REG[rdN]}, #${imm8}`, (c) => {
            const v = addWithCarry(c.r[rdN], ~imm8, 1)
            setNZ(c, v)
            c.c = lastC
            c.v = lastV
          }),
          ADDC(-1, `r[${rdN}]`, String(~imm8 >>> 0), "1", true),
        )
      case 6: // ADD (immediate) T2
        return J(
          i2(1, `adds ${REG[rdN]}, #${imm8}`, (c) => {
            const v = addWithCarry(c.r[rdN], imm8, 0)
            c.r[rdN] = v
            if (setflags) {
              setNZ(c, v)
              c.c = lastC
              c.v = lastV
            }
          }),
          ADDC(rdN, `r[${rdN}]`, String(imm8), "0", setflags),
        )
      default: // SUB (immediate) T2
        return J(
          i2(1, `subs ${REG[rdN]}, #${imm8}`, (c) => {
            const v = addWithCarry(c.r[rdN], ~imm8, 1)
            c.r[rdN] = v
            if (setflags) {
              setNZ(c, v)
              c.c = lastC
              c.v = lastV
            }
          }),
          ADDC(rdN, `r[${rdN}]`, String(~imm8 >>> 0), "1", setflags),
        )
    }
  }

  // Data processing (register): 010000
  if (op === 0x10) {
    const opc = (hw >>> 6) & 0xf
    const rdn = hw & 7
    const rm = (hw >>> 3) & 7
    const logic = (name: string, f: (a: number, b: number) => number, write = true, js?: string) =>
      J(
        i2(1, `${name}${write ? "s" : ""} ${REG[rdn]}, ${REG[rm]}`, (c) => {
          const v = f(c.r[rdn], c.r[rm]) >>> 0
          if (write) c.r[rdn] = v
          if (setflags || !write) setNZ(c, v)
        }),
        `const v = (${js ?? "0"}) >>> 0; ${write ? `r[${rdn}] = v;` : ""} ${setflags || !write ? NZ("v") : ""}`,
      )
    const shift = (name: string, type: SRType) =>
      i2(1, `${name}s ${REG[rdn]}, ${REG[rm]}`, (c) => {
        const v = shiftC(c.r[rdn], type, c.r[rm] & 0xff, c.c)
        c.r[rdn] = v
        if (setflags) {
          setNZ(c, v)
          c.c = shiftCarry
        }
      })
    switch (opc) {
      case 0:
        return logic("and", (a, b) => a & b, true, `r[${rdn}] & r[${rm}]`)
      case 1:
        return logic("eor", (a, b) => a ^ b, true, `r[${rdn}] ^ r[${rm}]`)
      case 2:
        return shift("lsl", SRType.LSL)
      case 3:
        return shift("lsr", SRType.LSR)
      case 4:
        return shift("asr", SRType.ASR)
      case 5: // ADC
        return i2(1, `adcs ${REG[rdn]}, ${REG[rm]}`, (c) => {
          const v = addWithCarry(c.r[rdn], c.r[rm], c.c)
          c.r[rdn] = v
          if (setflags) {
            setNZ(c, v)
            c.c = lastC
            c.v = lastV
          }
        })
      case 6: // SBC
        return i2(1, `sbcs ${REG[rdn]}, ${REG[rm]}`, (c) => {
          const v = addWithCarry(c.r[rdn], ~c.r[rm], c.c)
          c.r[rdn] = v
          if (setflags) {
            setNZ(c, v)
            c.c = lastC
            c.v = lastV
          }
        })
      case 7:
        return shift("ror", SRType.ROR)
      case 8: // TST
        return logic("tst", (a, b) => a & b, false, `r[${rdn}] & r[${rm}]`)
      case 9: // RSB (immediate) T1: negs
        return i2(1, `rsbs ${REG[rdn]}, ${REG[rm]}, #0`, (c) => {
          const v = addWithCarry(~c.r[rm], 0, 1)
          c.r[rdn] = v
          if (setflags) {
            setNZ(c, v)
            c.c = lastC
            c.v = lastV
          }
        })
      case 10: // CMP (register) T1
        return J(
          i2(1, `cmp ${REG[rdn]}, ${REG[rm]}`, (c) => {
            const v = addWithCarry(c.r[rdn], ~c.r[rm], 1)
            setNZ(c, v)
            c.c = lastC
            c.v = lastV
          }),
          ADDC(-1, `r[${rdn}]`, NOT(`r[${rm}]`), "1", true),
        )
      case 11: // CMN
        return i2(1, `cmn ${REG[rdn]}, ${REG[rm]}`, (c) => {
          const v = addWithCarry(c.r[rdn], c.r[rm], 0)
          setNZ(c, v)
          c.c = lastC
          c.v = lastV
        })
      case 12:
        return logic("orr", (a, b) => a | b, true, `r[${rdn}] | r[${rm}]`)
      case 13: // MUL
        return J(
          i2(1, `muls ${REG[rdn]}, ${REG[rm]}`, (c) => {
            const v = Math.imul(c.r[rdn], c.r[rm]) >>> 0
            c.r[rdn] = v
            if (setflags) setNZ(c, v)
          }),
          `const v = Math.imul(r[${rdn}], r[${rm}]) >>> 0; r[${rdn}] = v; ${setflags ? NZ("v") : ""}`,
        )
      case 14:
        return logic("bic", (a, b) => a & ~b, true, `r[${rdn}] & ~r[${rm}]`)
      default: // MVN
        return J(
          i2(1, `mvns ${REG[rdn]}, ${REG[rm]}`, (c) => {
            const v = ~c.r[rm] >>> 0
            c.r[rdn] = v
            if (setflags) setNZ(c, v)
          }),
          `const v = ~r[${rm}] >>> 0; r[${rdn}] = v; ${setflags ? NZ("v") : ""}`,
        )
    }
  }

  // Special data instructions and branch and exchange: 010001
  if (op === 0x11) {
    const opc = (hw >>> 8) & 3
    const rm = (hw >>> 3) & 0xf
    const rdn = (hw & 7) | ((hw >>> 4) & 8)
    switch (opc) {
      case 0: {
        // ADD (register) T2, high registers, no flags
        const instr = i2(1, `add ${REG[rdn]}, ${REG[rm]}`, (c) => {
          const v = (rd(c, rdn) + rd(c, rm)) >>> 0
          wr(c, rdn, v)
        })
        return rdn === 15 || rm === 15 ? instr : J(instr, `r[${rdn}] = (r[${rdn}] + r[${rm}]) >>> 0;`)
      }
      case 1: {
        // CMP (register) T2
        const instr = i2(1, `cmp ${REG[rdn]}, ${REG[rm]}`, (c) => {
          const v = addWithCarry(rd(c, rdn), ~rd(c, rm), 1)
          setNZ(c, v)
          c.c = lastC
          c.v = lastV
        })
        return rdn === 15 || rm === 15 ? instr : J(instr, ADDC(-1, `r[${rdn}]`, NOT(`r[${rm}]`), "1", true))
      }
      case 2: {
        // MOV (register) T1
        const instr = i2(1, `mov ${REG[rdn]}, ${REG[rm]}`, (c) => wr(c, rdn, rd(c, rm)))
        return rdn === 15 || rm === 15 ? instr : J(instr, `r[${rdn}] = r[${rm}];`)
      }
      default:
        if (hw & 0x80) {
          // BLX (register)
          return i2(2, `blx ${REG[rm]}`, (c) => {
            const target = rd(c, rm)
            c.r[14] = (c.pc + 2) | 1
            c.branchTo(target)
          })
        }
        // BX: through branchTo for the exception-return and interworking checks, so the
        // snippet is flushed like a memory access (an exception return reads the stack).
        return J(i2(2, `bx ${REG[rm]}`, (c) => c.branchTo(rd(c, rm))), rm === 15 ? "c.branchTo(c.readPc()); c.pc = c.nextPc; $EXIT" : `c.branchTo(r[${rm}]); c.pc = c.nextPc; $EXIT`, true)
    }
  }

  // LDR (literal) T1: 01001x
  if (op === 0x12 || op === 0x13) {
    const rt = (hw >>> 8) & 7
    const imm = (hw & 0xff) << 2
    return J(
      i2(2, `ldr ${REG[rt]}, [pc, #${imm}]`, (c) => {
        const base = (c.pc + 4) & ~3
        c.r[rt] = c.bus.read32((base + imm) >>> 0)
      }),
      `r[${rt}] = bus.read32(${(((addr + 4) & ~3) + imm) >>> 0});`,
      true,
    )
  }

  // Load/store single data item (A5.2.4): 0101xx, 011xxx, 100xxx
  if (op >= 0x14 && op < 0x28) {
    const rt = hw & 7
    const rn = (hw >>> 3) & 7
    if (op < 0x18) {
      // register offset
      const rm = (hw >>> 6) & 7
      const opB = (hw >>> 9) & 7
      const ea = (c: Cpu) => (c.r[rn] + c.r[rm]) >>> 0
      const fmt = (name: string) => `${name} ${REG[rt]}, [${REG[rn]}, ${REG[rm]}]`
      const EA = `((r[${rn}] + r[${rm}]) >>> 0)`
      switch (opB) {
        case 0:
          return J(i2(2, fmt("str"), (c) => c.bus.write32(ea(c), c.r[rt])), `bus.write32(${EA}, r[${rt}]);`, true)
        case 1:
          return J(i2(2, fmt("strh"), (c) => c.bus.write16(ea(c), c.r[rt])), `bus.write16(${EA}, r[${rt}]);`, true)
        case 2:
          return J(i2(2, fmt("strb"), (c) => c.bus.write8(ea(c), c.r[rt])), `bus.write8(${EA}, r[${rt}]);`, true)
        case 3:
          return J(i2(2, fmt("ldrsb"), (c) => (c.r[rt] = signExtend(c.bus.read8(ea(c)), 8) >>> 0)), `r[${rt}] = ((bus.read8(${EA}) << 24) >> 24) >>> 0;`, true)
        case 4:
          return J(i2(2, fmt("ldr"), (c) => (c.r[rt] = c.bus.read32(ea(c)))), `r[${rt}] = bus.read32(${EA});`, true)
        case 5:
          return J(i2(2, fmt("ldrh"), (c) => (c.r[rt] = c.bus.read16(ea(c)))), `r[${rt}] = bus.read16(${EA});`, true)
        case 6:
          return J(i2(2, fmt("ldrb"), (c) => (c.r[rt] = c.bus.read8(ea(c)))), `r[${rt}] = bus.read8(${EA});`, true)
        default:
          return J(i2(2, fmt("ldrsh"), (c) => (c.r[rt] = signExtend(c.bus.read16(ea(c)), 16) >>> 0)), `r[${rt}] = ((bus.read16(${EA}) << 16) >> 16) >>> 0;`, true)
      }
    }
    const imm5 = (hw >>> 6) & 0x1f
    const load = (hw & 0x800) !== 0
    if (op < 0x1c) {
      // STR/LDR (immediate) T1, word
      const imm = imm5 << 2
      const fmt = (name: string) => `${name} ${REG[rt]}, [${REG[rn]}, #${imm}]`
      return load
        ? J(i2(2, fmt("ldr"), (c) => (c.r[rt] = c.bus.read32((c.r[rn] + imm) >>> 0))), `r[${rt}] = bus.read32((r[${rn}] + ${imm}) >>> 0);`, true)
        : J(i2(2, fmt("str"), (c) => c.bus.write32((c.r[rn] + imm) >>> 0, c.r[rt])), `bus.write32((r[${rn}] + ${imm}) >>> 0, r[${rt}]);`, true)
    }
    if (op < 0x20) {
      // STRB/LDRB (immediate) T1
      const fmt = (name: string) => `${name} ${REG[rt]}, [${REG[rn]}, #${imm5}]`
      return load
        ? J(i2(2, fmt("ldrb"), (c) => (c.r[rt] = c.bus.read8((c.r[rn] + imm5) >>> 0))), `r[${rt}] = bus.read8((r[${rn}] + ${imm5}) >>> 0);`, true)
        : J(i2(2, fmt("strb"), (c) => c.bus.write8((c.r[rn] + imm5) >>> 0, c.r[rt])), `bus.write8((r[${rn}] + ${imm5}) >>> 0, r[${rt}]);`, true)
    }
    if (op < 0x24) {
      // STRH/LDRH (immediate) T1
      const imm = imm5 << 1
      const fmt = (name: string) => `${name} ${REG[rt]}, [${REG[rn]}, #${imm}]`
      return load
        ? J(i2(2, fmt("ldrh"), (c) => (c.r[rt] = c.bus.read16((c.r[rn] + imm) >>> 0))), `r[${rt}] = bus.read16((r[${rn}] + ${imm}) >>> 0);`, true)
        : J(i2(2, fmt("strh"), (c) => c.bus.write16((c.r[rn] + imm) >>> 0, c.r[rt])), `bus.write16((r[${rn}] + ${imm}) >>> 0, r[${rt}]);`, true)
    }
    // STR/LDR (immediate) T2, SP-relative
    const rt8 = (hw >>> 8) & 7
    const imm = (hw & 0xff) << 2
    const fmt = (name: string) => `${name} ${REG[rt8]}, [sp, #${imm}]`
    return load
      ? J(i2(2, fmt("ldr"), (c) => (c.r[rt8] = c.bus.read32((c.r[13] + imm) >>> 0))), `r[${rt8}] = bus.read32((r[13] + ${imm}) >>> 0);`, true)
      : J(i2(2, fmt("str"), (c) => c.bus.write32((c.r[13] + imm) >>> 0, c.r[rt8])), `bus.write32((r[13] + ${imm}) >>> 0, r[${rt8}]);`, true)
  }

  // ADR T1: 10100x
  if (op === 0x28 || op === 0x29) {
    const rdN = (hw >>> 8) & 7
    const imm = (hw & 0xff) << 2
    return J(i2(1, `adr ${REG[rdN]}, pc, #${imm}`, (c) => (c.r[rdN] = (((c.pc + 4) & ~3) + imm) >>> 0)), `r[${rdN}] = ${(((addr + 4) & ~3) + imm) >>> 0};`)
  }
  // ADD (SP plus immediate) T1: 10101x
  if (op === 0x2a || op === 0x2b) {
    const rdN = (hw >>> 8) & 7
    const imm = (hw & 0xff) << 2
    return J(i2(1, `add ${REG[rdN]}, sp, #${imm}`, (c) => (c.r[rdN] = (c.r[13] + imm) >>> 0)), `r[${rdN}] = (r[13] + ${imm}) >>> 0;`)
  }

  // Miscellaneous 16-bit instructions (A5.2.5): 1011xx
  if (op >= 0x2c && op < 0x30) {
    const opc = (hw >>> 5) & 0x7f
    if ((opc & 0x7c) === 0) {
      // ADD (SP plus immediate) T2
      const imm = (hw & 0x7f) << 2
      return J(i2(1, `add sp, #${imm}`, (c) => (c.r[13] = (c.r[13] + imm) >>> 0)), `r[13] = (r[13] + ${imm}) >>> 0;`)
    }
    if ((opc & 0x7c) === 0x04) {
      const imm = (hw & 0x7f) << 2
      return J(i2(1, `sub sp, #${imm}`, (c) => (c.r[13] = (c.r[13] - imm) >>> 0)), `r[13] = (r[13] - ${imm}) >>> 0;`)
    }
    if ((opc & 0x78) === 0x08 || (opc & 0x78) === 0x18 || (opc & 0x78) === 0x48 || (opc & 0x78) === 0x58) {
      // CBZ / CBNZ
      const nonzero = (hw & 0x800) !== 0
      const i = (hw >>> 9) & 1
      const imm = ((i << 5) | ((hw >>> 3) & 0x1f)) << 1
      const rn = hw & 7
      return BR(
        i2(1, `cb${nonzero ? "nz" : "z"} ${REG[rn]}, ${hex(addr + 4 + imm)}`, (c) => {
          if ((c.r[rn] === 0) !== nonzero) {
            c.branchWritePc(c.pc + 4 + imm)
            c.cycles += 1
          }
        }),
        addr + 4 + imm,
        1,
        `r[${rn}] ${nonzero ? "!==" : "==="} 0`,
      )
    }
    if ((opc & 0x78) === 0x10) {
      // SXTH/SXTB/UXTH/UXTB
      const rdN = hw & 7
      const rm = (hw >>> 3) & 7
      switch ((hw >>> 6) & 3) {
        case 0:
          return i2(1, `sxth ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = signExtend(c.r[rm] & 0xffff, 16) >>> 0))
        case 1:
          return i2(1, `sxtb ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = signExtend(c.r[rm] & 0xff, 8) >>> 0))
        case 2:
          return i2(1, `uxth ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = c.r[rm] & 0xffff))
        default:
          return i2(1, `uxtb ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = c.r[rm] & 0xff))
      }
    }
    if ((opc & 0x70) === 0x20) {
      // PUSH T1
      const list = (hw & 0xff) | ((hw & 0x100) << 6)
      const count = popcount(list)
      return i2(1 + count, `push ${regList(list)}`, (c) => {
        let sp = (c.r[13] - 4 * count) >>> 0
        const base = sp
        for (let i = 0; i < 15; i++) {
          if (list & (1 << i)) {
            c.bus.write32(sp, c.r[i])
            sp += 4
          }
        }
        c.r[13] = base
      })
    }
    if ((hw & 0xffe8) === 0xb660) {
      // CPS: CPSIE/CPSID i/f
      const disable = (hw & 0x10) !== 0
      const affectI = (hw & 2) !== 0
      const affectF = (hw & 1) !== 0
      return i2(1, `cps${disable ? "id" : "ie"} ${affectI ? "i" : ""}${affectF ? "f" : ""}`, (c) => {
        if (c.control & 1) return // unprivileged: no effect
        if (affectI) c.primask = disable ? 1 : 0
        if (affectF) c.faultmask = disable ? 1 : 0
      })
    }
    if ((opc & 0x78) === 0x50) {
      // REV/REV16/REVSH
      const rdN = hw & 7
      const rm = (hw >>> 3) & 7
      switch ((hw >>> 6) & 3) {
        case 0:
          return i2(1, `rev ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = bswap32(c.r[rm])))
        case 1:
          return i2(1, `rev16 ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = rev16(c.r[rm])))
        case 3:
          return i2(1, `revsh ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = revsh(c.r[rm])))
        default:
          return undefinedInstr(hw, 0, 2)
      }
    }
    if ((opc & 0x70) === 0x60) {
      // POP T1
      const list = (hw & 0xff) | ((hw & 0x100) << 7)
      const count = popcount(list)
      return i2(1 + count, `pop ${regList(list)}`, (c) => {
        let sp = c.r[13]
        for (let i = 0; i < 8; i++) {
          if (list & (1 << i)) {
            c.r[i] = c.bus.read32(sp)
            sp += 4
          }
        }
        if (list & 0x8000) {
          const target = c.bus.read32(sp)
          sp += 4
          c.r[13] = sp >>> 0
          c.branchTo(target)
          c.cycles += 2
          return
        }
        c.r[13] = sp >>> 0
      })
    }
    if ((opc & 0x78) === 0x70) {
      // BKPT
      const imm = hw & 0xff
      return i2(1, `bkpt #${imm}`, (c) => {
        throw new CpuHalt("bkpt", `bkpt #${imm}`, c.pc)
      })
    }
    if ((opc & 0x78) === 0x78) {
      // IT and hints
      const mask = hw & 0xf
      const firstcond = (hw >>> 4) & 0xf
      if (mask !== 0) {
        const it = hw & 0xff
        let name = "it"
        let m = mask
        const fcLow = firstcond & 1
        for (let i = 3; i > 0 && (m & ((1 << i) - 1)) !== 0; i--) name += ((m >>> i) & 1) === fcLow ? "t" : "e"
        return i2(1, `${name} ${CONDS[firstcond]}`, (c) => {
          c.itstate = it
        })
      }
      switch (firstcond) {
        case 0:
          return i2(1, "nop", () => {})
        case 1:
          return i2(1, "yield", () => {})
        case 2:
          return i2(1, "wfe", (c) => c.waitForEvent())
        case 3:
          return i2(1, "wfi", (c) => c.waitForInterrupt())
        case 4:
          return i2(1, "sev", (c) => void (c.eventRegister = true))
        default:
          return i2(1, "nop", () => {})
      }
    }
    return undefinedInstr(hw, 0, 2)
  }

  // STM/LDM T1: 1100xx
  if (op >= 0x30 && op < 0x34) {
    const load = (hw & 0x800) !== 0
    const rn = (hw >>> 8) & 7
    const list = hw & 0xff
    const count = popcount(list)
    if (load) {
      const writeback = (list & (1 << rn)) === 0
      return i2(1 + count, `ldmia ${REG[rn]}${writeback ? "!" : ""}, ${regList(list)}`, (c) => {
        let a = c.r[rn]
        for (let i = 0; i < 8; i++) {
          if (list & (1 << i)) {
            c.r[i] = c.bus.read32(a)
            a += 4
          }
        }
        if (writeback) c.r[rn] = a >>> 0
      })
    }
    return i2(1 + count, `stmia ${REG[rn]}!, ${regList(list)}`, (c) => {
      let a = c.r[rn]
      for (let i = 0; i < 8; i++) {
        if (list & (1 << i)) {
          c.bus.write32(a, c.r[i])
          a += 4
        }
      }
      c.r[rn] = a >>> 0
    })
  }

  // Conditional branch, SVC, UDF: 1101xx
  if (op >= 0x34 && op < 0x38) {
    const cond = (hw >>> 8) & 0xf
    if (cond === 0xe) return undefinedInstr(hw, 0, 2)
    if (cond === 0xf) {
      const imm = hw & 0xff
      return i2(1, `svc #${imm}`, () => {
        throw new ExceptionRequest(EXC.SVCALL)
      })
    }
    const imm = signExtend(hw & 0xff, 8) << 1
    return BR(
      i2(1, `b${CONDS[cond]} ${hex(addr + 4 + imm)}`, (c) => {
        if (c.condPassed(cond)) {
          c.branchWritePc(c.pc + 4 + imm)
          c.cycles += 1
        }
      }),
      addr + 4 + imm,
      1,
      COND_JS[cond],
    )
  }

  // B T2: 11100x
  if (op === 0x38 || op === 0x39) {
    const imm = signExtend(hw & 0x7ff, 11) << 1
    return BR(i2(2, `b ${hex(addr + 4 + imm)}`, (c) => c.branchWritePc(c.pc + 4 + imm)), addr + 4 + imm, 0, null)
  }

  return undefinedInstr(hw, 0, 2)
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}
function bswap32(v: number): number {
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0
}
function rev16(v: number): number {
  return (((v & 0x00ff00ff) << 8) | ((v >>> 8) & 0x00ff00ff)) >>> 0
}
function revsh(v: number): number {
  return signExtend(((v & 0xff) << 8) | ((v >>> 8) & 0xff), 16) >>> 0
}
function clz(v: number): number {
  return Math.clz32(v)
}
function rbit(v: number): number {
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1)
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2)
  v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4)
  return bswap32(v)
}

/** Signed saturation to `bits`; sets satQ when saturated. */
let satQ = 0
function signedSat(value: number, bits: number): number {
  const max = 2 ** (bits - 1) - 1
  const min = -(2 ** (bits - 1))
  satQ = 0
  if (value > max) {
    satQ = 1
    return max
  }
  if (value < min) {
    satQ = 1
    return min
  }
  return value
}
function unsignedSat(value: number, bits: number): number {
  const max = 2 ** bits - 1
  satQ = 0
  if (value > max) {
    satQ = 1
    return max
  }
  if (value < 0) {
    satQ = 1
    return 0
  }
  return value
}

// --- 32-bit encodings (A5.3) -----------------------------------------------------------

function decode32(hw1: number, hw2: number, addr: number, inIT: boolean): Instr {
  const op1 = (hw1 >>> 11) & 3
  const op2 = (hw1 >>> 4) & 0x7f
  const op = (hw2 >>> 15) & 1
  const i4 = (cycles: number, text: string, exec: (c: Cpu) => void): Instr => ({ size: 4, cycles, text, exec })

  if (op1 === 1) {
    if ((op2 & 0x64) === 0) return loadStoreMultiple(hw1, hw2, i4)
    if ((op2 & 0x64) === 0x04) return loadStoreDualExclusiveTable(hw1, hw2, i4)
    if ((op2 & 0x60) === 0x20) return dataProcessingShiftedRegister(hw1, hw2, i4)
    return coprocessor(hw1, hw2, addr, i4)
  }
  if (op1 === 2) {
    if (op === 0) {
      if ((op2 & 0x20) === 0) return dataProcessingModifiedImmediate(hw1, hw2, i4)
      return dataProcessingPlainImmediate(hw1, hw2, i4)
    }
    return branchesAndMisc(hw1, hw2, addr, inIT, i4)
  }
  // op1 === 3
  if ((op2 & 0x71) === 0x00) return storeSingle(hw1, hw2, i4)
  if ((op2 & 0x67) === 0x01) return loadByteOrHint(hw1, hw2, i4)
  if ((op2 & 0x67) === 0x03) return loadHalfword(hw1, hw2, i4)
  if ((op2 & 0x67) === 0x05) return loadWord(hw1, hw2, i4)
  if ((op2 & 0x70) === 0x20) return dataProcessingRegister(hw1, hw2, i4)
  if ((op2 & 0x78) === 0x30) return multiply(hw1, hw2, i4)
  if ((op2 & 0x78) === 0x38) return longMultiplyDivide(hw1, hw2, i4)
  if ((op2 & 0x40) === 0x40) return coprocessor(hw1, hw2, addr, i4)
  return undefinedInstr(hw1, hw2, 4)
}

type I4 = (cycles: number, text: string, exec: (c: Cpu) => void) => Instr

// A5.3.5 Load/store multiple
function loadStoreMultiple(hw1: number, hw2: number, i4: I4): Instr {
  const opc = (hw1 >>> 7) & 3
  const w = (hw1 >>> 5) & 1
  const load = (hw1 >>> 4) & 1
  const rn = hw1 & 0xf
  const list = hw2
  const count = popcount(list)
  if (opc === 1 && !load) {
    // STM (STMIA) T2
    return i4(1 + count, `stmia.w ${REG[rn]}${w ? "!" : ""}, ${regList(list)}`, (c) => {
      let a = c.r[rn]
      for (let i = 0; i < 15; i++) {
        if (list & (1 << i)) {
          c.bus.write32(a, c.r[i])
          a += 4
        }
      }
      if (w) c.r[rn] = a >>> 0
    })
  }
  if (opc === 1 && load) {
    // LDM (LDMIA) T2 / POP T2
    const text = rn === 13 && w ? `pop.w ${regList(list)}` : `ldmia.w ${REG[rn]}${w ? "!" : ""}, ${regList(list)}`
    return i4(1 + count, text, (c) => {
      let a = c.r[rn]
      for (let i = 0; i < 15; i++) {
        if (list & (1 << i)) {
          c.r[i] = c.bus.read32(a)
          a += 4
        }
      }
      let target = -1
      if (list & 0x8000) {
        target = c.bus.read32(a)
        a += 4
      }
      if (w && !(list & (1 << rn))) c.r[rn] = a >>> 0
      if (target >= 0) {
        c.branchTo(target)
        c.cycles += 2
      }
    })
  }
  if (opc === 2 && !load) {
    // STMDB T1 / PUSH T2
    const text = rn === 13 && w ? `push.w ${regList(list)}` : `stmdb ${REG[rn]}${w ? "!" : ""}, ${regList(list)}`
    return i4(1 + count, text, (c) => {
      let a = (c.r[rn] - 4 * count) >>> 0
      const base = a
      for (let i = 0; i < 15; i++) {
        if (list & (1 << i)) {
          c.bus.write32(a, c.r[i])
          a += 4
        }
      }
      if (w) c.r[rn] = base
    })
  }
  if (opc === 2 && load) {
    // LDMDB T1
    return i4(1 + count, `ldmdb ${REG[rn]}${w ? "!" : ""}, ${regList(list)}`, (c) => {
      let a = (c.r[rn] - 4 * count) >>> 0
      const base = a
      for (let i = 0; i < 15; i++) {
        if (list & (1 << i)) {
          c.r[i] = c.bus.read32(a)
          a += 4
        }
      }
      let target = -1
      if (list & 0x8000) target = c.bus.read32(a)
      if (w && !(list & (1 << rn))) c.r[rn] = base
      if (target >= 0) c.branchTo(target)
    })
  }
  return undefinedInstr(hw1, hw2, 4)
}

// A5.3.6 Load/store dual or exclusive, table branch
function loadStoreDualExclusiveTable(hw1: number, hw2: number, i4: I4): Instr {
  const op1 = (hw1 >>> 7) & 3
  const op2 = (hw1 >>> 4) & 3
  const rn = hw1 & 0xf
  const rt = (hw2 >>> 12) & 0xf
  const rt2 = (hw2 >>> 8) & 0xf
  const rd2 = hw2 & 0xf
  if (op1 === 0 && op2 === 0) {
    // STREX
    const imm = (hw2 & 0xff) << 2
    return i4(2, `strex ${REG[rt2]}, ${REG[rt]}, [${REG[rn]}, #${imm}]`, (c) => {
      c.bus.write32((c.r[rn] + imm) >>> 0, c.r[rt])
      c.r[rt2] = 0 // single core: always succeeds
    })
  }
  if (op1 === 0 && op2 === 1) {
    const imm = (hw2 & 0xff) << 2
    return i4(2, `ldrex ${REG[rt]}, [${REG[rn]}, #${imm}]`, (c) => {
      c.r[rt] = c.bus.read32((c.r[rn] + imm) >>> 0)
    })
  }
  if (op1 === 1 && op2 === 0) {
    switch ((hw2 >>> 4) & 0xf) {
      case 4: // STREXB
        return i4(2, `strexb ${REG[rd2]}, ${REG[rt]}, [${REG[rn]}]`, (c) => {
          c.bus.write8(c.r[rn], c.r[rt])
          c.r[rd2] = 0
        })
      case 5: // STREXH
        return i4(2, `strexh ${REG[rd2]}, ${REG[rt]}, [${REG[rn]}]`, (c) => {
          c.bus.write16(c.r[rn], c.r[rt])
          c.r[rd2] = 0
        })
    }
  }
  if (op1 === 1 && op2 === 1) {
    switch ((hw2 >>> 4) & 0xf) {
      case 0: {
        // TBB
        const rm = hw2 & 0xf
        return i4(3, `tbb [${REG[rn]}, ${REG[rm]}]`, (c) => {
          const base = rd(c, rn)
          const off = c.bus.read8((base + c.r[rm]) >>> 0)
          c.branchWritePc(c.pc + 4 + off * 2)
        })
      }
      case 1: {
        // TBH
        const rm = hw2 & 0xf
        return i4(3, `tbh [${REG[rn]}, ${REG[rm]}, lsl #1]`, (c) => {
          const base = rd(c, rn)
          const off = c.bus.read16((base + c.r[rm] * 2) >>> 0)
          c.branchWritePc(c.pc + 4 + off * 2)
        })
      }
      case 4: // LDREXB
        return i4(2, `ldrexb ${REG[rt]}, [${REG[rn]}]`, (c) => (c.r[rt] = c.bus.read8(c.r[rn])))
      case 5: // LDREXH
        return i4(2, `ldrexh ${REG[rt]}, [${REG[rn]}]`, (c) => (c.r[rt] = c.bus.read16(c.r[rn])))
    }
    return undefinedInstr(hw1, hw2, 4)
  }
  // LDRD/STRD (immediate): op1 = 1x or op2 = 1x
  const p = (hw1 >>> 8) & 1
  const u = (hw1 >>> 7) & 1
  const w = (hw1 >>> 5) & 1
  const load = (hw1 >>> 4) & 1
  const imm = (hw2 & 0xff) << 2
  const signed = u ? imm : -imm
  const index = p === 1
  const wback = w === 1
  const addrText = index ? `[${REG[rn]}, #${signed}]${wback ? "!" : ""}` : `[${REG[rn]}], #${signed}`
  if (load) {
    if (rn === 15) {
      // LDRD (literal)
      return i4(3, `ldrd ${REG[rt]}, ${REG[rt2]}, [pc, #${signed}]`, (c) => {
        const base = ((c.pc + 4) & ~3) + signed
        c.r[rt] = c.bus.read32(base >>> 0)
        c.r[rt2] = c.bus.read32((base + 4) >>> 0)
      })
    }
    return J(
      i4(3, `ldrd ${REG[rt]}, ${REG[rt2]}, ${addrText}`, (c) => {
        const base = c.r[rn]
        const offAddr = (base + signed) >>> 0
        const a = index ? offAddr : base
        const v1 = c.bus.read32(a)
        const v2 = c.bus.read32((a + 4) >>> 0)
        if (wback) c.r[rn] = offAddr
        c.r[rt] = v1
        c.r[rt2] = v2
      }),
      `const base = r[${rn}], offAddr = (base + ${signed}) >>> 0, a = ${index ? "offAddr" : "base"}; const v1 = bus.read32(a), v2 = bus.read32((a + 4) >>> 0); ${wback ? `r[${rn}] = offAddr;` : ""} r[${rt}] = v1; r[${rt2}] = v2;`,
      true,
    )
  }
  return J(
    i4(3, `strd ${REG[rt]}, ${REG[rt2]}, ${addrText}`, (c) => {
      const base = c.r[rn]
      const offAddr = (base + signed) >>> 0
      const a = index ? offAddr : base
      c.bus.write32(a, c.r[rt])
      c.bus.write32((a + 4) >>> 0, c.r[rt2])
      if (wback) c.r[rn] = offAddr
    }),
    `const base = r[${rn}], offAddr = (base + ${signed}) >>> 0, a = ${index ? "offAddr" : "base"}; bus.write32(a, r[${rt}]); bus.write32((a + 4) >>> 0, r[${rt2}]); ${wback ? `r[${rn}] = offAddr;` : ""}`,
    true,
  )
}

/** Shared body of the data-processing group: computes result + flags for one opcode. */
type DPOp = (c: Cpu, a: number, b: number, carryIn: number, setflags: boolean, rdN: number) => void

const DP_NAMES = ["and", "bic", "orr", "orn", "eor", "", "pkh", "", "add", "", "adc", "sbc", "", "sub", "rsb", ""]

function dpOperation(opc: number, hw2rd: number): DPOp | null {
  switch (opc) {
    case 0: // AND / TST
      return (c, a, b, cin, s, rdN) => {
        const v = (a & b) >>> 0
        if (rdN !== 15) c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = cin
        }
      }
    case 1: // BIC
      return (c, a, b, cin, s, rdN) => {
        const v = (a & ~b) >>> 0
        c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = cin
        }
      }
    case 2: // ORR / MOV
      return (c, a, b, cin, s, rdN) => {
        const v = (a | b) >>> 0
        c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = cin
        }
      }
    case 3: // ORN / MVN
      return (c, a, b, cin, s, rdN) => {
        const v = (a | ~b) >>> 0
        c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = cin
        }
      }
    case 4: // EOR / TEQ
      return (c, a, b, cin, s, rdN) => {
        const v = (a ^ b) >>> 0
        if (rdN !== 15) c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = cin
        }
      }
    case 8: // ADD / CMN
      return (c, a, b, _cin, s, rdN) => {
        const v = addWithCarry(a, b, 0)
        if (rdN !== 15) c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = lastC
          c.v = lastV
        }
      }
    case 10: // ADC
      return (c, a, b, _cin, s, rdN) => {
        const v = addWithCarry(a, b, c.c)
        c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = lastC
          c.v = lastV
        }
      }
    case 11: // SBC
      return (c, a, b, _cin, s, rdN) => {
        const v = addWithCarry(a, ~b, c.c)
        c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = lastC
          c.v = lastV
        }
      }
    case 13: // SUB / CMP
      return (c, a, b, _cin, s, rdN) => {
        const v = addWithCarry(a, ~b, 1)
        if (rdN !== 15) c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = lastC
          c.v = lastV
        }
      }
    case 14: // RSB
      return (c, a, b, _cin, s, rdN) => {
        const v = addWithCarry(~a, b, 1)
        c.r[rdN] = v
        if (s) {
          setNZ(c, v)
          c.c = lastC
          c.v = lastV
        }
      }
    default:
      void hw2rd
      return null
  }
}

function dpText(opc: number, s: number, rdN: number, rn: number, operand: string): string {
  let name = DP_NAMES[opc]
  // Aliases: TST/TEQ/CMN/CMP when Rd = pc and S; MOV/MVN when Rn = pc.
  if (rdN === 15 && s) {
    if (opc === 0) return `tst ${REG[rn]}, ${operand}`
    if (opc === 4) return `teq ${REG[rn]}, ${operand}`
    if (opc === 8) return `cmn ${REG[rn]}, ${operand}`
    if (opc === 13) return `cmp ${REG[rn]}, ${operand}`
  }
  if (rn === 15 && (opc === 2 || opc === 3)) {
    name = opc === 2 ? "mov" : "mvn"
    return `${name}${s ? "s" : ""}.w ${REG[rdN]}, ${operand}`
  }
  return `${name}${s ? "s" : ""}.w ${REG[rdN]}, ${REG[rn]}, ${operand}`
}

/**
 * Snippet of one data-processing opcode over `a` and `b` (uint32 expressions), `cin` the
 * shifter carry-out expression, as dpOperation computes it; null for opcodes it has no form for.
 */
function dpJs(opc: number, a: string, b: string, cin: string, s: boolean, rdN: number): string | null {
  const store = rdN !== 15 ? `r[${rdN}] = v;` : ""
  const logical = (v: string) => `const v = (${v}) >>> 0; ${store} ${s ? `${NZ("v")} c.c = ${cin};` : ""}`
  switch (opc) {
    case 0:
      return logical(`${a} & ${b}`)
    case 1:
      return logical(`${a} & ~${b}`)
    case 2:
      return logical(`${a} | ${b}`)
    case 3:
      return logical(`${a} | ~${b}`)
    case 4:
      return logical(`${a} ^ ${b}`)
    case 8:
      return ADDC(rdN === 15 ? -1 : rdN, a, b, "0", s)
    case 10:
      return ADDC(rdN, a, b, "c.c", s)
    case 11:
      return ADDC(rdN, a, NOT(b), "c.c", s)
    case 13:
      return ADDC(rdN === 15 ? -1 : rdN, a, NOT(b), "1", s)
    case 14:
      return ADDC(rdN, NOT(a), b, "1", s)
    default:
      return null
  }
}
/** The shifted operand and its carry-out as expressions over a uint32 `x`, as shiftC computes them. */
function shiftJs(srt: SRType, amount: number): [value: string, carry: string] {
  if (amount === 0) return ["x", "c.c"]
  switch (srt) {
    case SRType.LSL:
      return amount >= 32 ? ["0", amount === 32 ? "x & 1" : "0"] : [`(x << ${amount}) >>> 0`, `(x >>> ${32 - amount}) & 1`]
    case SRType.LSR:
      return amount >= 32 ? ["0", amount === 32 ? "x >>> 31" : "0"] : [`x >>> ${amount}`, `(x >>> ${amount - 1}) & 1`]
    case SRType.ASR:
      return amount >= 32 ? ["(x & 0x80000000 ? 0xffffffff : 0)", "x >>> 31"] : [`(x >> ${amount}) >>> 0`, `(x >>> ${amount - 1}) & 1`]
    case SRType.ROR: {
      const m = amount & 31
      return m === 0 ? ["x", "x >>> 31"] : [`((x >>> ${m}) | (x << ${32 - m})) >>> 0`, "b0 >>> 31"]
    }
    case SRType.RRX:
      return ["((x >>> 1) | (c.c << 31)) >>> 0", "x & 1"]
  }
}

// A5.3.11 Data processing (shifted register)
function dataProcessingShiftedRegister(hw1: number, hw2: number, i4: I4): Instr {
  const opc = (hw1 >>> 5) & 0xf
  const s = (hw1 >>> 4) & 1
  const rn = hw1 & 0xf
  const rdN = (hw2 >>> 8) & 0xf
  const rm = hw2 & 0xf
  const imm5 = (((hw2 >>> 12) & 7) << 2) | ((hw2 >>> 6) & 3)
  const type = (hw2 >>> 4) & 3
  const [srt, amount] = decodeImmShift(type, imm5)
  const shiftText = amount === 0 && srt === SRType.LSL ? "" : srt === SRType.RRX ? ", rrx" : `, ${["lsl", "lsr", "asr", "ror"][srt]} #${amount}`
  if (opc === 6) {
    // PKHBT/PKHTB
    const tb = (hw2 >>> 5) & 1
    return i4(1, `pkh${tb ? "tb" : "bt"} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}${shiftText}`, (c) => {
      const operand2 = shiftC(c.r[rm], srt, amount, c.c)
      const a = c.r[rn]
      c.r[rdN] = tb ? ((a & 0xffff0000) | (operand2 & 0xffff)) >>> 0 : ((operand2 & 0xffff0000) | (a & 0xffff)) >>> 0
    })
  }
  const opFn = dpOperation(opc, rdN)
  if (!opFn) return undefinedInstr(hw1, hw2, 4)
  const isMov = rn === 15 && (opc === 2 || opc === 3)
  const setflags = s === 1
  const text = dpText(opc, s, rdN, rn, `${REG[rm]}${shiftText}`)
  const instr = i4(1, text, (c) => {
    const shifted = shiftC(c.r[rm], srt, amount, c.c)
    const a = isMov ? 0 : rd(c, rn)
    opFn(c, a, shifted, shiftCarry, setflags, rdN)
  })
  if (rm === 15 || (rn === 15 && !isMov) || (rdN === 15 && !((opc === 0 || opc === 4 || opc === 8 || opc === 13) && setflags))) return instr
  const [value, carry] = shiftJs(srt, amount)
  const body = dpJs(opc, isMov ? "0" : `r[${rn}]`, "b0", "cin", setflags, rdN)
  return body === null ? instr : J(instr, `const x = r[${rm}], b0 = ${value}, cin = ${carry}; ${body}`)
}

// A5.3.1 Data processing (modified immediate)
function dataProcessingModifiedImmediate(hw1: number, hw2: number, i4: I4): Instr {
  const opc = (hw1 >>> 5) & 0xf
  const s = (hw1 >>> 4) & 1
  const rn = hw1 & 0xf
  const rdN = (hw2 >>> 8) & 0xf
  const i = (hw1 >>> 10) & 1
  const imm12 = (i << 11) | (((hw2 >>> 12) & 7) << 8) | (hw2 & 0xff)
  const opFn = dpOperation(opc, rdN)
  if (!opFn) return undefinedInstr(hw1, hw2, 4)
  const isMov = rn === 15 && (opc === 2 || opc === 3)
  const setflags = s === 1
  // The immediate's carry-out depends on the incoming carry only for the 8-bit forms with no rotation,
  // where carry is unchanged; precompute both cases.
  const imm0 = thumbExpandImmC(imm12, 0)
  const carry0 = shiftCarry
  const imm1 = thumbExpandImmC(imm12, 1)
  const carry1 = shiftCarry
  const text = dpText(opc, s, rdN, rn, `#${imm0}`)
  const fixed = carry0 === carry1 && imm0 === imm1
  const instr = fixed
    ? i4(1, text, (c) => {
        const a = isMov ? 0 : rd(c, rn)
        opFn(c, a, imm0, carry0, setflags, rdN)
      })
    : i4(1, text, (c) => {
        const a = isMov ? 0 : rd(c, rn)
        opFn(c, a, c.c ? imm1 : imm0, c.c ? carry1 : carry0, setflags, rdN)
      })
  if ((rn === 15 && !isMov) || (rdN === 15 && !((opc === 0 || opc === 4 || opc === 8 || opc === 13) && setflags))) return instr
  const body = dpJs(opc, isMov ? "0" : `r[${rn}]`, "b0", "cin", setflags, rdN)
  if (body === null) return instr
  return J(instr, fixed ? `const b0 = ${imm0}, cin = ${carry0}; ${body}` : `const b0 = c.c ? ${imm1} : ${imm0}, cin = c.c ? ${carry1} : ${carry0}; ${body}`)
}

// A5.3.3 Data processing (plain binary immediate)
function dataProcessingPlainImmediate(hw1: number, hw2: number, i4: I4): Instr {
  const opc = (hw1 >>> 4) & 0x1f
  const rn = hw1 & 0xf
  const rdN = (hw2 >>> 8) & 0xf
  const i = (hw1 >>> 10) & 1
  const imm3 = (hw2 >>> 12) & 7
  const imm8 = hw2 & 0xff
  const imm12 = (i << 11) | (imm3 << 8) | imm8
  switch (opc) {
    case 0: // ADDW / ADR
      if (rn === 15) return i4(1, `adr.w ${REG[rdN]}, pc, #${imm12}`, (c) => (c.r[rdN] = (((c.pc + 4) & ~3) + imm12) >>> 0))
      return J(i4(1, `addw ${REG[rdN]}, ${REG[rn]}, #${imm12}`, (c) => (c.r[rdN] = (rd(c, rn) + imm12) >>> 0)), `r[${rdN}] = (r[${rn}] + ${imm12}) >>> 0;`)
    case 4: {
      // MOVW
      const imm16 = ((hw1 & 0xf) << 12) | (i << 11) | (imm3 << 8) | imm8
      return J(i4(1, `movw ${REG[rdN]}, #${imm16}`, (c) => (c.r[rdN] = imm16)), `r[${rdN}] = ${imm16};`)
    }
    case 10: // SUBW / ADR (minus)
      if (rn === 15) return i4(1, `adr.w ${REG[rdN]}, pc, #-${imm12}`, (c) => (c.r[rdN] = (((c.pc + 4) & ~3) - imm12) >>> 0))
      return J(i4(1, `subw ${REG[rdN]}, ${REG[rn]}, #${imm12}`, (c) => (c.r[rdN] = (rd(c, rn) - imm12) >>> 0)), `r[${rdN}] = (r[${rn}] - ${imm12}) >>> 0;`)
    case 12: {
      // MOVT
      const imm16 = ((hw1 & 0xf) << 12) | (i << 11) | (imm3 << 8) | imm8
      return J(i4(1, `movt ${REG[rdN]}, #${imm16}`, (c) => (c.r[rdN] = ((c.r[rdN] & 0xffff) | (imm16 << 16)) >>> 0)), `r[${rdN}] = ((r[${rdN}] & 0xffff) | (${imm16} << 16)) >>> 0;`)
    }
    case 16:
    case 18: {
      // SSAT (16), SSAT16 (18 with sh=0... only when imm5==0), and 16 with shift
      const shN = (hw1 >>> 5) & 1
      const imm5 = (imm3 << 2) | ((hw2 >>> 6) & 3)
      const satImm = (hw2 & 0x1f) + 1
      if (opc === 18 && imm5 === 0) {
        // SSAT16
        const sat = hw2 & 0xf
        return i4(1, `ssat16 ${REG[rdN]}, #${sat + 1}, ${REG[rn]}`, (c) => {
          const v = c.r[rn]
          const lo = signedSat((v << 16) >> 16, sat + 1)
          const q1 = satQ
          const hi = signedSat(v >> 16, sat + 1)
          if (q1 || satQ) c.q = 1
          c.r[rdN] = ((lo & 0xffff) | (hi << 16)) >>> 0
        })
      }
      const [srt, amount] = decodeImmShift(shN << 1, imm5)
      return i4(1, `ssat ${REG[rdN]}, #${satImm}, ${REG[rn]}${amount ? `, ${srt === SRType.ASR ? "asr" : "lsl"} #${amount}` : ""}`, (c) => {
        const operand = shiftC(c.r[rn], srt, amount, c.c) | 0
        const v = signedSat(operand, satImm)
        if (satQ) c.q = 1
        c.r[rdN] = v >>> 0
      })
    }
    case 20: {
      // SBFX
      const imm5 = (imm3 << 2) | ((hw2 >>> 6) & 3)
      const width = (hw2 & 0x1f) + 1
      return J(
        i4(1, `sbfx ${REG[rdN]}, ${REG[rn]}, #${imm5}, #${width}`, (c) => {
          const v = c.r[rn] >>> imm5
          c.r[rdN] = signExtend(v & (width === 32 ? 0xffffffff : (1 << width) - 1), width) >>> 0
        }),
        `r[${rdN}] = ((((r[${rn}] >>> ${imm5}) & ${width === 32 ? 0xffffffff : (1 << width) - 1}) << ${32 - width}) >> ${32 - width}) >>> 0;`,
      )
    }
    case 22: {
      // BFI / BFC
      const lsb = (imm3 << 2) | ((hw2 >>> 6) & 3)
      const msb = hw2 & 0x1f
      const width = msb - lsb + 1
      const mask = width >= 32 ? 0xffffffff : (((1 << width) - 1) << lsb) >>> 0
      if (rn === 15) return J(i4(1, `bfc ${REG[rdN]}, #${lsb}, #${width}`, (c) => (c.r[rdN] = (c.r[rdN] & ~mask) >>> 0)), `r[${rdN}] = (r[${rdN}] & ${~mask}) >>> 0;`)
      return J(
        i4(1, `bfi ${REG[rdN]}, ${REG[rn]}, #${lsb}, #${width}`, (c) => {
          c.r[rdN] = ((c.r[rdN] & ~mask) | ((c.r[rn] << lsb) & mask)) >>> 0
        }),
        `r[${rdN}] = ((r[${rdN}] & ${~mask}) | ((r[${rn}] << ${lsb}) & ${mask})) >>> 0;`,
      )
    }
    case 24:
    case 26: {
      // USAT / USAT16
      const shN = (hw1 >>> 5) & 1
      const imm5 = (imm3 << 2) | ((hw2 >>> 6) & 3)
      const satImm = hw2 & 0x1f
      if (opc === 26 && imm5 === 0) {
        const sat = hw2 & 0xf
        return i4(1, `usat16 ${REG[rdN]}, #${sat}, ${REG[rn]}`, (c) => {
          const v = c.r[rn]
          const lo = unsignedSat((v << 16) >> 16, sat)
          const q1 = satQ
          const hi = unsignedSat(v >> 16, sat)
          if (q1 || satQ) c.q = 1
          c.r[rdN] = ((lo & 0xffff) | (hi << 16)) >>> 0
        })
      }
      const [srt, amount] = decodeImmShift(shN << 1, imm5)
      return i4(1, `usat ${REG[rdN]}, #${satImm}, ${REG[rn]}${amount ? `, ${srt === SRType.ASR ? "asr" : "lsl"} #${amount}` : ""}`, (c) => {
        const operand = shiftC(c.r[rn], srt, amount, c.c) | 0
        const v = unsignedSat(operand, satImm)
        if (satQ) c.q = 1
        c.r[rdN] = v >>> 0
      })
    }
    case 28: {
      // UBFX
      const imm5 = (imm3 << 2) | ((hw2 >>> 6) & 3)
      const width = (hw2 & 0x1f) + 1
      const mask = width === 32 ? 0xffffffff : (1 << width) - 1
      return J(i4(1, `ubfx ${REG[rdN]}, ${REG[rn]}, #${imm5}, #${width}`, (c) => (c.r[rdN] = ((c.r[rn] >>> imm5) & mask) >>> 0)), `r[${rdN}] = ((r[${rn}] >>> ${imm5}) & ${mask}) >>> 0;`)
    }
  }
  return undefinedInstr(hw1, hw2, 4)
}

// A5.3.4 Branches and miscellaneous control
function branchesAndMisc(hw1: number, hw2: number, addr: number, _inIT: boolean, i4: I4): Instr {
  const op = (hw1 >>> 4) & 0x7f
  const op1 = (hw2 >>> 12) & 7
  if ((op1 & 5) === 0) {
    // Conditional branch B T3, or misc control when cond = 111x
    if ((op & 0x38) !== 0x38) {
      const cond = (hw1 >>> 6) & 0xf
      const s = (hw1 >>> 10) & 1
      const j1 = (hw2 >>> 13) & 1
      const j2 = (hw2 >>> 11) & 1
      const imm6 = hw1 & 0x3f
      const imm11 = hw2 & 0x7ff
      const imm = signExtend((s << 20) | (j2 << 19) | (j1 << 18) | (imm6 << 12) | (imm11 << 1), 21)
      return BR(
        i4(1, `b${CONDS[cond]}.w ${hex(addr + 4 + imm)}`, (c) => {
          if (c.condPassed(cond)) {
            c.branchWritePc(c.pc + 4 + imm)
            c.cycles += 1
          }
        }),
        addr + 4 + imm,
        1,
        COND_JS[cond],
      )
    }
    switch (op) {
      case 0x38:
      case 0x39: {
        // MSR (register)
        const rn = hw1 & 0xf
        const sysm = hw2 & 0xff
        const mask = (hw2 >>> 10) & 3
        return i4(1, `msr ${SYSM_NAMES[sysm] ?? sysm}, ${REG[rn]}`, (c) => {
          const v = c.r[rn]
          switch (sysm >>> 3) {
            case 0: // APSR
              if (mask & 2) {
                c.n = (v >>> 31) & 1
                c.z = (v >>> 30) & 1
                c.c = (v >>> 29) & 1
                c.v = (v >>> 28) & 1
                c.q = (v >>> 27) & 1
              }
              if (mask & 1) c.ge = (v >>> 16) & 0xf
              return
            case 1: // SP
              if (c.control & 1) return
              if (sysm === 8) c.setMsp(v)
              else if (sysm === 9) c.setPsp(v)
              return
            case 2: // PRIMASK, BASEPRI, BASEPRI_MAX, FAULTMASK, CONTROL
              if (c.control & 1) return
              switch (sysm) {
                case 16:
                  c.primask = v & 1
                  return
                case 17:
                  c.basepri = v & 0xff
                  return
                case 18:
                  if ((v & 0xff) !== 0 && ((v & 0xff) < c.basepri || c.basepri === 0)) c.basepri = v & 0xff
                  return
                case 19:
                  if (c.executionPriority() > -1) c.faultmask = v & 1
                  return
                case 20:
                  c.setControl(c.ipsr === 0 ? v & 7 : (v & 5) | (c.control & 2))
                  return
              }
          }
        })
      }
      case 0x3a: {
        // Hints: NOP.W, YIELD, WFE, WFI, SEV, DBG
        const hint = hw2 & 0xff
        if (hint === 2) return i4(1, "wfe.w", (c) => c.waitForEvent())
        if (hint === 3) return i4(1, "wfi.w", (c) => c.waitForInterrupt())
        if (hint === 4) return i4(1, "sev.w", (c) => void (c.eventRegister = true))
        return i4(1, "nop.w", () => {})
      }
      case 0x3b: {
        // Miscellaneous control: CLREX, DSB, DMB, ISB
        const opc = (hw2 >>> 4) & 0xf
        const name = opc === 2 ? "clrex" : opc === 4 ? "dsb" : opc === 5 ? "dmb" : opc === 6 ? "isb" : "barrier"
        return i4(1, name, () => {})
      }
      case 0x3e:
      case 0x3f: {
        // MRS
        const rdN = (hw2 >>> 8) & 0xf
        const sysm = hw2 & 0xff
        return i4(1, `mrs ${REG[rdN]}, ${SYSM_NAMES[sysm] ?? sysm}`, (c) => {
          let v = 0
          switch (sysm >>> 3) {
            case 0:
              // bit0: include IPSR; bit2: exclude APSR; EPSR always reads as zero.
              if (sysm & 1) v |= c.ipsr
              if ((sysm & 4) === 0) v |= c.apsr
              break
            case 1:
              v = sysm === 8 ? c.getMsp() : c.getPsp()
              break
            case 2:
              switch (sysm) {
                case 16:
                  v = c.primask
                  break
                case 17:
                case 18:
                  v = c.basepri
                  break
                case 19:
                  v = c.faultmask
                  break
                case 20:
                  v = c.control
                  break
              }
          }
          c.r[rdN] = v >>> 0
        })
      }
      case 0x7f:
        // UDF.W / permanently undefined
        return undefinedInstr(hw1, hw2, 4)
    }
    return undefinedInstr(hw1, hw2, 4)
  }
  const s = (hw1 >>> 10) & 1
  const j1 = (hw2 >>> 13) & 1
  const j2 = (hw2 >>> 11) & 1
  const i1 = (~(j1 ^ s)) & 1
  const i2b = (~(j2 ^ s)) & 1
  const imm10 = hw1 & 0x3ff
  const imm11 = hw2 & 0x7ff
  const imm = signExtend((s << 24) | (i1 << 23) | (i2b << 22) | (imm10 << 12) | (imm11 << 1), 25)
  if ((op1 & 5) === 1) {
    // B T4
    return BR(i4(2, `b.w ${hex(addr + 4 + imm)}`, (c) => c.branchWritePc(c.pc + 4 + imm)), addr + 4 + imm, 0, null)
  }
  if ((op1 & 5) === 5) {
    // BL T1
    return BR(
      i4(3, `bl ${hex(addr + 4 + imm)}`, (c) => {
        c.r[14] = ((c.pc + 4) | 1) >>> 0
        c.branchWritePc(c.pc + 4 + imm)
      }),
      addr + 4 + imm,
      0,
      null,
      true,
    )
  }
  return undefinedInstr(hw1, hw2, 4)
}

const SYSM_NAMES: Record<number, string> = {
  0: "apsr",
  1: "iapsr",
  2: "eapsr",
  3: "xpsr",
  5: "ipsr",
  6: "epsr",
  7: "iepsr",
  8: "msp",
  9: "psp",
  16: "primask",
  17: "basepri",
  18: "basepri_max",
  19: "faultmask",
  20: "control",
}

/** Addressing-mode decode shared by the single load/store encodings (A5.3.7–A5.3.10). */
type MemAccess = {
  text: string
  /** Effective address; `commit` performs the writeback when needed (called after the access). */
  ea: (c: Cpu) => number
  commit: ((c: Cpu) => void) | null
  literal: boolean
  /** The same two as snippets: the address expression, and the writeback statement (or ""). */
  eaJs: string
  commitJs: string
}

function memAddressing(hw1: number, hw2: number, rn: number): MemAccess | null {
  const op1bit = (hw1 >>> 7) & 1 // 1: imm12 form
  if (rn === 15) {
    // literal: imm12, U from bit 7
    const u = (hw1 >>> 7) & 1
    const imm = hw2 & 0xfff
    const off = u ? imm : -imm
    return {
      text: `[pc, #${off}]`,
      ea: (c) => (((c.pc + 4) & ~3) + off) >>> 0,
      commit: null,
      literal: true,
      eaJs: `((((c.pc + 4) & ~3) + ${off}) >>> 0)`,
      commitJs: "",
    }
  }
  if (op1bit) {
    // immediate offset, 12-bit positive
    const imm = hw2 & 0xfff
    return { text: `[${REG[rn]}, #${imm}]`, ea: (c) => (c.r[rn] + imm) >>> 0, commit: null, literal: false, eaJs: `((r[${rn}] + ${imm}) >>> 0)`, commitJs: "" }
  }
  const op2 = (hw2 >>> 8) & 0xf
  if (op2 === 0) {
    // register offset with LSL
    const rm = hw2 & 0xf
    const shift = (hw2 >>> 4) & 3
    return {
      text: `[${REG[rn]}, ${REG[rm]}${shift ? `, lsl #${shift}` : ""}]`,
      ea: (c) => (c.r[rn] + (c.r[rm] << shift)) >>> 0,
      commit: null,
      literal: false,
      eaJs: `((r[${rn}] + (r[${rm}] << ${shift})) >>> 0)`,
      commitJs: "",
    }
  }
  if (op2 === 0xc || op2 === 0xe) {
    // imm8: 1100 = negative offset, 1110 = unprivileged (T) form, same address here
    const imm = hw2 & 0xff
    if (op2 === 0xe) return { text: `[${REG[rn]}, #${imm}]`, ea: (c) => (c.r[rn] + imm) >>> 0, commit: null, literal: false, eaJs: `((r[${rn}] + ${imm}) >>> 0)`, commitJs: "" }
    return { text: `[${REG[rn]}, #-${imm}]`, ea: (c) => (c.r[rn] - imm) >>> 0, commit: null, literal: false, eaJs: `((r[${rn}] - ${imm}) >>> 0)`, commitJs: "" }
  }
  if ((op2 & 0x9) === 0x9) {
    // pre/post-indexed with writeback: P = bit10, U = bit9, W = bit8
    const p = (hw2 >>> 10) & 1
    const u = (hw2 >>> 9) & 1
    const imm = hw2 & 0xff
    const off = u ? imm : -imm
    if (p) {
      return {
        text: `[${REG[rn]}, #${off}]!`,
        ea: (c) => (c.r[rn] + off) >>> 0,
        commit: (c) => (c.r[rn] = (c.r[rn] + off) >>> 0),
        literal: false,
        eaJs: `((r[${rn}] + ${off}) >>> 0)`,
        commitJs: `r[${rn}] = (r[${rn}] + ${off}) >>> 0;`,
      }
    }
    return {
      text: `[${REG[rn]}], #${off}`,
      ea: (c) => c.r[rn],
      commit: (c) => (c.r[rn] = (c.r[rn] + off) >>> 0),
      literal: false,
      eaJs: `r[${rn}]`,
      commitJs: `r[${rn}] = (r[${rn}] + ${off}) >>> 0;`,
    }
  }
  return null
}

// A5.3.10 Store single data item
function storeSingle(hw1: number, hw2: number, i4: I4): Instr {
  const size = (hw1 >>> 5) & 3
  const rn = hw1 & 0xf
  const rt = (hw2 >>> 12) & 0xf
  if (rn === 15) return undefinedInstr(hw1, hw2, 4)
  const m = memAddressing(hw1, hw2, rn)
  if (!m) return undefinedInstr(hw1, hw2, 4)
  const name = ["strb", "strh", "str"][size]
  if (size > 2) return undefinedInstr(hw1, hw2, 4)
  const width = (size === 0 ? 1 : size === 1 ? 2 : 4) as 1 | 2 | 4
  const commit = m.commit
  const ea = m.ea
  const instr = i4(2, `${name}.w ${REG[rt]}, ${m.text}`, (c) => {
    const a = ea(c)
    c.bus.write(a, rd(c, rt), width)
    if (commit) commit(c)
  })
  if (rt === 15) return instr
  return J(instr, `bus.write${width * 8}(${m.eaJs}, r[${rt}]); ${m.commitJs}`, true)
}

// A5.3.8 Load byte, memory hints
function loadByteOrHint(hw1: number, hw2: number, i4: I4): Instr {
  const rn = hw1 & 0xf
  const rt = (hw2 >>> 12) & 0xf
  const signed = (hw1 >>> 8) & 1
  if (rt === 15) return i4(1, "pld", () => {}) // PLD/PLI hints
  const m = memAddressing(hw1, hw2, rn)
  if (!m) return undefinedInstr(hw1, hw2, 4)
  const commit = m.commit
  const ea = m.ea
  const name = signed ? "ldrsb" : "ldrb"
  return J(
    i4(2, `${name}.w ${REG[rt]}, ${m.text}`, (c) => {
      const v = c.bus.read8(ea(c))
      if (commit) commit(c)
      c.r[rt] = signed ? signExtend(v, 8) >>> 0 : v
    }),
    `const v = bus.read8(${m.eaJs}); ${m.commitJs} r[${rt}] = ${signed ? "((v << 24) >> 24) >>> 0" : "v"};`,
    true,
  )
}

// A5.3.9 Load halfword
function loadHalfword(hw1: number, hw2: number, i4: I4): Instr {
  const rn = hw1 & 0xf
  const rt = (hw2 >>> 12) & 0xf
  const signed = (hw1 >>> 8) & 1
  if (rt === 15) return i4(1, "nop.w", () => {}) // unallocated hint
  const m = memAddressing(hw1, hw2, rn)
  if (!m) return undefinedInstr(hw1, hw2, 4)
  const commit = m.commit
  const ea = m.ea
  const name = signed ? "ldrsh" : "ldrh"
  return J(
    i4(2, `${name}.w ${REG[rt]}, ${m.text}`, (c) => {
      const v = c.bus.read16(ea(c))
      if (commit) commit(c)
      c.r[rt] = signed ? signExtend(v, 16) >>> 0 : v
    }),
    `const v = bus.read16(${m.eaJs}); ${m.commitJs} r[${rt}] = ${signed ? "((v << 16) >> 16) >>> 0" : "v"};`,
    true,
  )
}

// A5.3.7 Load word
function loadWord(hw1: number, hw2: number, i4: I4): Instr {
  const rn = hw1 & 0xf
  const rt = (hw2 >>> 12) & 0xf
  const m = memAddressing(hw1, hw2, rn)
  if (!m) return undefinedInstr(hw1, hw2, 4)
  const commit = m.commit
  const ea = m.ea
  const instr = i4(2, `ldr.w ${REG[rt]}, ${m.text}`, (c) => {
    const v = c.bus.read32(ea(c))
    if (commit) commit(c)
    wrLoad(c, rt, v)
    if (rt === 15) c.cycles += 2
  })
  if (rt === 15) return instr
  return J(instr, `const v = bus.read32(${m.eaJs}); ${m.commitJs} r[${rt}] = v;`, true)
}

// A5.3.12 Data processing (register)
function dataProcessingRegister(hw1: number, hw2: number, i4: I4): Instr {
  const op1 = (hw1 >>> 4) & 0xf
  const rn = hw1 & 0xf
  const rdN = (hw2 >>> 8) & 0xf
  const rm = hw2 & 0xf
  const op2 = (hw2 >>> 4) & 0xf
  if ((hw2 & 0xf000) !== 0xf000) return undefinedInstr(hw1, hw2, 4)
  if ((op1 & 8) === 0 && op2 === 0) {
    // LSL/LSR/ASR/ROR (register) T2
    const type = (op1 >>> 1) & 3
    const s = op1 & 1
    const name = ["lsl", "lsr", "asr", "ror"][type]
    return i4(1, `${name}${s ? "s" : ""}.w ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
      const v = shiftC(c.r[rn], type as SRType, c.r[rm] & 0xff, c.c)
      c.r[rdN] = v
      if (s) {
        setNZ(c, v)
        c.c = shiftCarry
      }
    })
  }
  if ((op1 & 8) === 0 && (op2 & 8) === 8) {
    // SXTH/UXTH/SXTB16/UXTB16/SXTB/UXTB and the -AH/-AB accumulate forms
    const rotate = (op2 & 3) << 3
    const acc = rn !== 15
    const op = op1
    const names = ["sxth", "uxth", "sxtb16", "uxtb16", "sxtb", "uxtb"]
    if (op > 5) return undefinedInstr(hw1, hw2, 4)
    const base = names[op]
    const name = acc ? base.replace("t", "ta") : base
    const rotText = rotate ? `, ror #${rotate}` : ""
    return i4(1, `${name}${acc ? "" : ".w"} ${REG[rdN]}, ${acc ? REG[rn] + ", " : ""}${REG[rm]}${rotText}`, (c) => {
      const rotated = shiftC(c.r[rm], SRType.ROR, rotate, c.c)
      const a = acc ? c.r[rn] : 0
      let v: number
      switch (op) {
        case 0:
          v = a + (signExtend(rotated & 0xffff, 16) >>> 0)
          break
        case 1:
          v = a + (rotated & 0xffff)
          break
        case 2:
          v = (((a & 0xffff) + signExtend(rotated & 0xff, 8)) & 0xffff) | ((((a >>> 16) + signExtend((rotated >>> 16) & 0xff, 8)) & 0xffff) << 16)
          break
        case 3:
          v = (((a & 0xffff) + (rotated & 0xff)) & 0xffff) | ((((a >>> 16) + ((rotated >>> 16) & 0xff)) & 0xffff) << 16)
          break
        case 4:
          v = a + (signExtend(rotated & 0xff, 8) >>> 0)
          break
        default:
          v = a + (rotated & 0xff)
      }
      c.r[rdN] = v >>> 0
    })
  }
  if ((op1 & 8) === 8 && (op2 & 0x8) === 0) return parallelAddSub(hw1, hw2, i4)
  if ((op1 & 0xc) === 8 && (op2 & 0xc) === 8) {
    // Miscellaneous operations: QADD/QSUB/QDADD/QDSUB, REV/REV16/RBIT/REVSH, SEL, CLZ
    const op1l = op1 & 3
    const op2l = op2 & 3
    if (op1l === 0) {
      const names = ["qadd", "qdadd", "qsub", "qdsub"]
      return i4(1, `${names[op2l]} ${REG[rdN]}, ${REG[rm]}, ${REG[rn]}`, (c) => {
        const a = c.r[rm] | 0
        let b = c.r[rn] | 0
        if (op2l & 1) {
          b = signedSat(b * 2, 32)
          if (satQ) c.q = 1
        }
        const v = signedSat(op2l & 2 ? a - b : a + b, 32)
        if (satQ) c.q = 1
        c.r[rdN] = v >>> 0
      })
    }
    if (op1l === 1) {
      switch (op2l) {
        case 0:
          return i4(1, `rev.w ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = bswap32(c.r[rm])))
        case 1:
          return i4(1, `rev16.w ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = rev16(c.r[rm])))
        case 2:
          return i4(1, `rbit ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = rbit(c.r[rm])))
        default:
          return i4(1, `revsh.w ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = revsh(c.r[rm])))
      }
    }
    if (op1l === 2 && op2l === 0) {
      return i4(1, `sel ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
        const a = c.r[rn]
        const b = c.r[rm]
        let v = 0
        for (let i = 0; i < 4; i++) {
          const mask = 0xff << (i * 8)
          v |= (c.ge & (1 << i) ? a : b) & mask
        }
        c.r[rdN] = v >>> 0
      })
    }
    if (op1l === 3 && op2l === 0) return i4(1, `clz ${REG[rdN]}, ${REG[rm]}`, (c) => (c.r[rdN] = clz(c.r[rm])))
  }
  return undefinedInstr(hw1, hw2, 4)
}

// A5.3.13 / A5.3.14 Parallel addition and subtraction, signed and unsigned (SIMD)
function parallelAddSub(hw1: number, hw2: number, i4: I4): Instr {
  const op1 = (hw1 >>> 4) & 7
  const rn = hw1 & 0xf
  const rdN = (hw2 >>> 8) & 0xf
  const rm = hw2 & 0xf
  const op2 = (hw2 >>> 4) & 3
  // hw2[6] selects the unsigned table (A5.3.14) over the signed one (A5.3.13).
  const u = (hw2 >>> 6) & 1
  const kind = op2 === 0 ? "" : op2 === 1 ? "q" : op2 === 2 ? "h" : ""
  if (op2 === 3) return undefinedInstr(hw1, hw2, 4)
  const opName = ["add8", "add16", "asx", "", "sub8", "sub16", "sax"][op1 & 7]
  if (!opName) return undefinedInstr(hw1, hw2, 4)
  const prefix = (u ? "u" : "s") + kind
  const halves = op1 !== 0 && op1 !== 4
  const text = `${prefix}${opName} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}`
  // Lane arithmetic on 8- or 16-bit lanes with the wrap/saturate/halve variants.
  const lane = (val: number, bits: number) => (u ? val & ((1 << bits) - 1) : signExtend(val & ((1 << bits) - 1), bits))
  const finish = (val: number, bits: number) => {
    if (op2 === 1) return (u ? unsignedSat(val, bits) : signedSat(val, bits)) & ((1 << bits) - 1)
    if (op2 === 2) return (val >> 1) & ((1 << bits) - 1)
    return val & ((1 << bits) - 1)
  }
  return i4(1, text, (c) => {
    const a = c.r[rn]
    const b = c.r[rm]
    let result = 0
    let ge = 0
    if (!halves) {
      const sub = op1 === 4
      for (let i = 0; i < 4; i++) {
        const x = lane(a >>> (i * 8), 8)
        const y = lane(b >>> (i * 8), 8)
        const s = sub ? x - y : x + y
        result |= finish(s, 8) << (i * 8)
        if (op2 === 0) ge |= (u ? (sub ? s >= 0 : s >= 0x100) : s >= 0) ? 1 << i : 0
      }
    } else {
      const x0 = lane(a, 16)
      const x1 = lane(a >>> 16, 16)
      const y0 = lane(b, 16)
      const y1 = lane(b >>> 16, 16)
      let s0: number
      let s1: number
      switch (op1) {
        case 1: // add16
          s0 = x0 + y0
          s1 = x1 + y1
          break
        case 2: // asx: lo = x0 - y1, hi = x1 + y0
          s0 = x0 - y1
          s1 = x1 + y0
          break
        case 5: // sub16
          s0 = x0 - y0
          s1 = x1 - y1
          break
        default: // sax: lo = x0 + y1, hi = x1 - y0
          s0 = x0 + y1
          s1 = x1 - y0
      }
      result = finish(s0, 16) | (finish(s1, 16) << 16)
      if (op2 === 0) {
        const g0 = u ? (op1 === 1 || op1 === 6 ? s0 >= 0x10000 : s0 >= 0) : s0 >= 0
        const g1 = u ? (op1 === 1 || op1 === 2 ? s1 >= 0x10000 : s1 >= 0) : s1 >= 0
        ge = (g0 ? 3 : 0) | (g1 ? 12 : 0)
      }
    }
    c.r[rdN] = result >>> 0
    if (op2 === 0) c.ge = ge
  })
}

// A5.3.16 Multiply, multiply accumulate, and absolute difference
function multiply(hw1: number, hw2: number, i4: I4): Instr {
  const op1 = (hw1 >>> 4) & 7
  const rn = hw1 & 0xf
  const ra = (hw2 >>> 12) & 0xf
  const rdN = (hw2 >>> 8) & 0xf
  const rm = hw2 & 0xf
  const op2 = (hw2 >>> 4) & 3
  const hasAcc = ra !== 15
  const half = (v: number, top: boolean) => (top ? v >> 16 : (v << 16) >> 16)
  switch (op1) {
    case 0:
      if (op2 === 0) {
        if (hasAcc) return J(i4(2, `mla ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}, ${REG[ra]}`, (c) => (c.r[rdN] = (Math.imul(c.r[rn], c.r[rm]) + c.r[ra]) >>> 0)), `r[${rdN}] = (Math.imul(r[${rn}], r[${rm}]) + r[${ra}]) >>> 0;`)
        return J(i4(1, `mul.w ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}`, (c) => (c.r[rdN] = Math.imul(c.r[rn], c.r[rm]) >>> 0)), `r[${rdN}] = Math.imul(r[${rn}], r[${rm}]) >>> 0;`)
      }
      if (op2 === 1) return J(i4(2, `mls ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}, ${REG[ra]}`, (c) => (c.r[rdN] = (c.r[ra] - Math.imul(c.r[rn], c.r[rm])) >>> 0)), `r[${rdN}] = (r[${ra}] - Math.imul(r[${rn}], r[${rm}])) >>> 0;`)
      break
    case 1: {
      // SMULxy / SMLAxy
      const nTop = (op2 & 2) !== 0
      const mTop = (op2 & 1) !== 0
      const suffix = (nTop ? "t" : "b") + (mTop ? "t" : "b")
      const halfJs = (x: string, top: boolean) => (top ? `(${x} >> 16)` : `((${x} << 16) >> 16)`)
      if (hasAcc) {
        return J(
          i4(1, `smla${suffix} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}, ${REG[ra]}`, (c) => {
            const p = half(c.r[rn], nTop) * half(c.r[rm], mTop)
            const sum = p + (c.r[ra] | 0)
            const v = sum | 0
            if (sum !== v) c.q = 1
            c.r[rdN] = v >>> 0
          }),
          `const sum = ${halfJs(`r[${rn}]`, nTop)} * ${halfJs(`r[${rm}]`, mTop)} + (r[${ra}] | 0), v = sum | 0; if (sum !== v) c.q = 1; r[${rdN}] = v >>> 0;`,
        )
      }
      return J(i4(1, `smul${suffix} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}`, (c) => (c.r[rdN] = (half(c.r[rn], nTop) * half(c.r[rm], mTop)) >>> 0)), `r[${rdN}] = (${halfJs(`r[${rn}]`, nTop)} * ${halfJs(`r[${rm}]`, mTop)}) >>> 0;`)
    }
    case 2: {
      // SMUAD / SMLAD (op2 bit0 = X swap)
      const swap = (op2 & 1) !== 0
      if (op2 > 1) break
      return i4(1, `${hasAcc ? "smlad" : "smuad"}${swap ? "x" : ""} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}${hasAcc ? ", " + REG[ra] : ""}`, (c) => {
        const a = c.r[rn]
        let b = c.r[rm]
        if (swap) b = ((b >>> 16) | (b << 16)) >>> 0
        const p = half(a, false) * half(b, false) + half(a, true) * half(b, true)
        const sum = p + (hasAcc ? c.r[ra] | 0 : 0)
        const v = sum | 0
        if (sum !== v) c.q = 1
        c.r[rdN] = v >>> 0
      })
    }
    case 3: {
      // SMULWy / SMLAWy
      const mTop = (op2 & 1) !== 0
      if (op2 > 1) break
      return i4(1, `${hasAcc ? "smlaw" : "smulw"}${mTop ? "t" : "b"} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}${hasAcc ? ", " + REG[ra] : ""}`, (c) => {
        const p = (c.r[rn] | 0) * half(c.r[rm], mTop)
        const r = Math.floor(p / 65536)
        const sum = r + (hasAcc ? c.r[ra] | 0 : 0)
        const v = sum | 0
        if (hasAcc && sum !== v) c.q = 1
        c.r[rdN] = v >>> 0
      })
    }
    case 4: {
      // SMUSD / SMLSD
      const swap = (op2 & 1) !== 0
      if (op2 > 1) break
      return i4(1, `${hasAcc ? "smlsd" : "smusd"}${swap ? "x" : ""} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}${hasAcc ? ", " + REG[ra] : ""}`, (c) => {
        const a = c.r[rn]
        let b = c.r[rm]
        if (swap) b = ((b >>> 16) | (b << 16)) >>> 0
        const p = half(a, false) * half(b, false) - half(a, true) * half(b, true)
        const sum = p + (hasAcc ? c.r[ra] | 0 : 0)
        const v = sum | 0
        if (sum !== v) c.q = 1
        c.r[rdN] = v >>> 0
      })
    }
    case 5: {
      // SMMUL / SMMLA (op2 bit0 = R round)
      const round = (op2 & 1) !== 0
      if (op2 > 1) break
      return i4(1, `${hasAcc ? "smmla" : "smmul"}${round ? "r" : ""} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}${hasAcc ? ", " + REG[ra] : ""}`, (c) => {
        let p = BigInt(c.r[rn] | 0) * BigInt(c.r[rm] | 0)
        if (hasAcc) p += BigInt(c.r[ra] | 0) << 32n
        if (round) p += 0x80000000n
        c.r[rdN] = Number(BigInt.asUintN(32, p >> 32n))
      })
    }
    case 6: {
      // SMMLS
      const round = (op2 & 1) !== 0
      if (op2 > 1) break
      return i4(1, `smmls${round ? "r" : ""} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}, ${REG[ra]}`, (c) => {
        let p = (BigInt(c.r[ra] | 0) << 32n) - BigInt(c.r[rn] | 0) * BigInt(c.r[rm] | 0)
        if (round) p += 0x80000000n
        c.r[rdN] = Number(BigInt.asUintN(32, p >> 32n))
      })
    }
    case 7: {
      // USAD8 / USADA8
      if (op2 !== 0) break
      return i4(1, `${hasAcc ? "usada8" : "usad8"} ${REG[rdN]}, ${REG[rn]}, ${REG[rm]}${hasAcc ? ", " + REG[ra] : ""}`, (c) => {
        const a = c.r[rn]
        const b = c.r[rm]
        let sum = hasAcc ? c.r[ra] : 0
        for (let i = 0; i < 4; i++) sum += Math.abs(((a >>> (i * 8)) & 0xff) - ((b >>> (i * 8)) & 0xff))
        c.r[rdN] = sum >>> 0
      })
    }
  }
  return undefinedInstr(hw1, hw2, 4)
}

// A5.3.17 Long multiply, long multiply accumulate, and divide
function longMultiplyDivide(hw1: number, hw2: number, i4: I4): Instr {
  const op1 = (hw1 >>> 4) & 7
  const rn = hw1 & 0xf
  const rdLo = (hw2 >>> 12) & 0xf
  const rdHi = (hw2 >>> 8) & 0xf
  const rm = hw2 & 0xf
  const op2 = (hw2 >>> 4) & 0xf
  switch (op1) {
    case 0: // SMULL
      return i4(3, `smull ${REG[rdLo]}, ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
        const p = BigInt(c.r[rn] | 0) * BigInt(c.r[rm] | 0)
        c.r[rdLo] = Number(BigInt.asUintN(32, p))
        c.r[rdHi] = Number(BigInt.asUintN(32, p >> 32n))
      })
    case 1: // SDIV
      return i4(4, `sdiv ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
        const d = c.r[rm] | 0
        if (d === 0) {
          if (c.scs.divByZeroTraps()) c.fault(EXC.USAGE_FAULT, "divide by zero")
          c.r[rdHi] = 0
          return
        }
        const n = c.r[rn] | 0
        c.r[rdHi] = (n === -2147483648 && d === -1 ? n : Math.trunc(n / d)) >>> 0
      })
    case 2: // UMULL: 32×32→64 in 16-bit limbs, since a double cannot hold the full product
      return i4(3, `umull ${REG[rdLo]}, ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
        const a = c.r[rn]
        const b = c.r[rm]
        const aL = a & 0xffff
        const aH = a >>> 16
        const bL = b & 0xffff
        const bH = b >>> 16
        const ll = aL * bL
        const mid = aL * bH + aH * bL + Math.floor(ll / 65536)
        c.r[rdLo] = ((mid % 65536) * 65536 + (ll % 65536)) >>> 0
        c.r[rdHi] = (aH * bH + Math.floor(mid / 65536)) >>> 0
      })
    case 3: // UDIV
      return i4(4, `udiv ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
        const d = c.r[rm]
        if (d === 0) {
          if (c.scs.divByZeroTraps()) c.fault(EXC.USAGE_FAULT, "divide by zero")
          c.r[rdHi] = 0
          return
        }
        c.r[rdHi] = Math.floor(c.r[rn] / d) >>> 0
      })
    case 4:
      if (op2 === 0) {
        return i4(3, `smlal ${REG[rdLo]}, ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
          const acc = (BigInt(c.r[rdHi] | 0) << 32n) | BigInt(c.r[rdLo])
          const p = BigInt(c.r[rn] | 0) * BigInt(c.r[rm] | 0) + acc
          c.r[rdLo] = Number(BigInt.asUintN(32, p))
          c.r[rdHi] = Number(BigInt.asUintN(32, p >> 32n))
        })
      }
      if ((op2 & 0xc) === 0x8) {
        // SMLALxy
        const nTop = (op2 & 2) !== 0
        const mTop = (op2 & 1) !== 0
        return i4(3, `smlal${nTop ? "t" : "b"}${mTop ? "t" : "b"} ${REG[rdLo]}, ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
          const x = nTop ? c.r[rn] >> 16 : (c.r[rn] << 16) >> 16
          const y = mTop ? c.r[rm] >> 16 : (c.r[rm] << 16) >> 16
          const acc = (BigInt(c.r[rdHi] | 0) << 32n) | BigInt(c.r[rdLo])
          const p = BigInt(x * y) + acc
          c.r[rdLo] = Number(BigInt.asUintN(32, p))
          c.r[rdHi] = Number(BigInt.asUintN(32, p >> 32n))
        })
      }
      if ((op2 & 0xe) === 0xc) {
        // SMLALD / SMLALDX
        const swap = (op2 & 1) !== 0
        return i4(3, `smlald${swap ? "x" : ""} ${REG[rdLo]}, ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
          const a = c.r[rn]
          let b = c.r[rm]
          if (swap) b = ((b >>> 16) | (b << 16)) >>> 0
          const p = ((a << 16) >> 16) * ((b << 16) >> 16) + (a >> 16) * (b >> 16)
          const acc = (BigInt(c.r[rdHi] | 0) << 32n) | BigInt(c.r[rdLo])
          const r = BigInt(p) + acc
          c.r[rdLo] = Number(BigInt.asUintN(32, r))
          c.r[rdHi] = Number(BigInt.asUintN(32, r >> 32n))
        })
      }
      break
    case 5:
      if ((op2 & 0xe) === 0xc) {
        // SMLSLD
        const swap = (op2 & 1) !== 0
        return i4(3, `smlsld${swap ? "x" : ""} ${REG[rdLo]}, ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
          const a = c.r[rn]
          let b = c.r[rm]
          if (swap) b = ((b >>> 16) | (b << 16)) >>> 0
          const p = ((a << 16) >> 16) * ((b << 16) >> 16) - (a >> 16) * (b >> 16)
          const acc = (BigInt(c.r[rdHi] | 0) << 32n) | BigInt(c.r[rdLo])
          const r = BigInt(p) + acc
          c.r[rdLo] = Number(BigInt.asUintN(32, r))
          c.r[rdHi] = Number(BigInt.asUintN(32, r >> 32n))
        })
      }
      break
    case 6:
      if (op2 === 0) {
        return i4(3, `umlal ${REG[rdLo]}, ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
          const acc = (BigInt(c.r[rdHi]) << 32n) | BigInt(c.r[rdLo])
          const p = BigInt(c.r[rn]) * BigInt(c.r[rm]) + acc
          c.r[rdLo] = Number(BigInt.asUintN(32, p))
          c.r[rdHi] = Number(BigInt.asUintN(32, p >> 32n))
        })
      }
      if (op2 === 6) {
        return i4(3, `umaal ${REG[rdLo]}, ${REG[rdHi]}, ${REG[rn]}, ${REG[rm]}`, (c) => {
          const p = BigInt(c.r[rn]) * BigInt(c.r[rm]) + BigInt(c.r[rdHi]) + BigInt(c.r[rdLo])
          c.r[rdLo] = Number(BigInt.asUintN(32, p))
          c.r[rdHi] = Number(BigInt.asUintN(32, p >> 32n))
        })
      }
      break
  }
  return undefinedInstr(hw1, hw2, 4)
}

// --- Floating-point extension (A6, FPv4-SP) ------------------------------------------------

const SREG = (n: number) => `s${n}`
const DREG = (n: number) => `d${n}`

/** FPSCR flag bits. */
const FPSCR_N = 1 << 31
const FPSCR_Z = 1 << 30
const FPSCR_C = 1 << 29
const FPSCR_V = 1 << 28

function fpCompare(c: Cpu, a: number, b: number) {
  let flags: number
  if (Number.isNaN(a) || Number.isNaN(b)) flags = FPSCR_C | FPSCR_V
  else if (a === b) flags = FPSCR_Z | FPSCR_C
  else if (a < b) flags = FPSCR_N
  else flags = FPSCR_C
  c.fpscr = ((c.fpscr & 0x0fffffff) | flags) >>> 0
}

/** Rounding modes: FPSCR.RMode (0 nearest-even, 1 +∞, 2 −∞, 3 zero) and the FPv5 directed ones. */
type Rounding = "even" | "away" | "up" | "down" | "zero"
const RMODE: Rounding[] = ["even", "up", "down", "zero"]
function roundTo(value: number, mode: Rounding): number {
  switch (mode) {
    case "zero":
      return Math.trunc(value)
    case "up":
      return Math.ceil(value)
    case "down":
      return Math.floor(value)
    case "away":
      return Math.sign(value) * Math.round(Math.abs(value))
    default: {
      // Ties to even: Math.round rounds .5 up; fix the tie case.
      const r = Math.round(value)
      return Math.abs(value - Math.trunc(value)) === 0.5 ? 2 * Math.round(value / 2) : r
    }
  }
}
/** Rounded conversion of a float to a signed/unsigned 32-bit int with saturation. */
function fpToInt(value: number, unsigned: boolean, mode: Rounding): number {
  if (Number.isNaN(value)) return 0
  const v = roundTo(value, mode)
  if (unsigned) return v <= 0 ? 0 : v >= 4294967295 ? 4294967295 : v >>> 0
  return v <= -2147483648 ? 0x80000000 : v >= 2147483647 ? 0x7fffffff : v >>> 0
}
/** Round a float to an integral value keeping it a float (VRINT*): ±0 and infinities pass through. */
function fpRint(value: number, mode: Rounding): number {
  if (!Number.isFinite(value) || value === 0) return value
  const r = roundTo(value, mode)
  return r === 0 && value < 0 ? -0 : r
}
/** IEEE half precision ↔ single (VCVTB/VCVTT); round to nearest even on the way down. */
function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >>> 10) & 0x1f
  const frac = h & 0x3ff
  if (exp === 0) return sign * frac * 2 ** -24
  if (exp === 31) return frac ? NaN : sign * Infinity
  return sign * (1 + frac / 1024) * 2 ** (exp - 15)
}
function floatToHalf(f: number): number {
  if (Number.isNaN(f)) return 0x7e00
  const sign = f < 0 || Object.is(f, -0) ? 0x8000 : 0
  const a = Math.abs(f)
  if (a === Infinity) return sign | 0x7c00
  if (a === 0) return sign
  let exp = Math.floor(Math.log2(a))
  let mant = a / 2 ** exp - 1
  if (exp < -14) {
    // Subnormal: 10 fraction bits of 2^-14 units.
    const q = Math.round(a / 2 ** -24)
    return sign | (q >= 1024 ? 0x0400 : q)
  }
  let m = Math.round(mant * 1024)
  if (m === 1024) {
    m = 0
    exp++
  }
  if (exp > 15) return sign | 0x7c00
  void mant
  return sign | ((exp + 15) << 10) | m
}
/** VFPExpandImm for the double form: sign, exp = NOT(b6):replicate(b6,8):b5:b4, frac = b3:b0 << 48. */
function expandImm64(imm8: number): number {
  const sign = imm8 >>> 7 ? -1 : 1
  const b6 = (imm8 >>> 6) & 1
  const exp = ((b6 ^ 1) << 10) | (b6 ? 0x3fc : 0) | ((imm8 >>> 4) & 3)
  return sign * (1 + (imm8 & 0xf) / 16) * 2 ** (exp - 1023)
}

/**
 * One FP register file view for both precisions: `sd` etc. are S indices (single) or D
 * indices (double); `rd/wr` read and write the value, `fr` rounds a result to the precision.
 */
type FpView = {
  dp: boolean
  name: (i: number) => string
  rd: (c: Cpu, i: number) => number
  wr: (c: Cpu, i: number, v: number) => void
  fr: (v: number) => number
  ty: string
}
const FP32: FpView = { dp: false, name: SREG, rd: (c, i) => c.s[i], wr: (c, i, v) => (c.s[i] = v), fr: Math.fround, ty: "f32" }
const FP64: FpView = { dp: true, name: DREG, rd: (c, i) => c.dBits[i], wr: (c, i, v) => (c.dBits[i] = v), fr: (v) => v, ty: "f64" }
/** Guards for what the part's FPU has: double precision (MVFR0.FPDP) and the FPv5 extras (MVFR2). */
const needDouble = (c: Cpu) => {
  if (!c.hasFp64) c.fault(EXC.USAGE_FAULT, "double-precision VFP instruction on a single-precision FPU")
}
const needFpv5 = (c: Cpu) => {
  if (!c.hasFpv5) c.fault(EXC.USAGE_FAULT, "FPv5 instruction (VSEL/VMAXNM/VRINT/VCVTA…) on an FPv4 FPU")
}

function coprocessor(hw1: number, hw2: number, addr: number, i4: I4): Instr {
  const coproc = (hw2 >>> 8) & 0xf
  if (coproc !== 10 && coproc !== 11) return unimplemented(hw1, hw2, 4, addr, "coprocessor")
  const dp = coproc === 11 // double-precision register form (D regs)
  const op1 = (hw1 >>> 4) & 0x3f
  // Every FP instruction needs CP10/CP11 access (else UsageFault.NOCP) and marks the context
  // as owning FP state (CONTROL.FPCA), which is what makes exception entry stack s0–s15.
  // Wrapped at creation, one closure deep, rather than around the finished instruction.
  const fpI4: I4 = (cycles, text, exec) =>
    i4(cycles, text, (c) => {
      if ((c.scs.cpacr & 0x00f00000) !== 0x00f00000) c.fault(EXC.USAGE_FAULT, "coprocessor access denied (CPACR)")
      c.control |= 4
      exec(c)
    })
  if ((hw1 & 0xff00) === 0xfe00 && (hw2 & 0x10) === 0) return fpv5(hw1, hw2, dp, addr, fpI4)
  if ((op1 & 0x3e) === 0x04) return fpTransfer64(hw1, hw2, dp, fpI4)
  if ((op1 & 0x20) === 0) return fpLoadStore(hw1, hw2, dp, fpI4)
  if ((hw2 & 0x10) === 0) return fpDataProcessing(hw1, hw2, dp, addr, fpI4)
  return fpTransfer32(hw1, hw2, dp, addr, fpI4)
}

/** VMOV between two core registers and two S registers or one D register (A7.7.243). */
function fpTransfer64(hw1: number, hw2: number, dp: boolean, i4: I4): Instr {
  const toCore = (hw1 >>> 4) & 1
  const rt = (hw2 >>> 12) & 0xf
  const rt2 = hw1 & 0xf
  const vm = hw2 & 0xf
  const m = (hw2 >>> 5) & 1
  if (dp) {
    const d = ((m << 4) | vm) * 2 // D register → S pair index
    const text = toCore ? `vmov ${REG[rt]}, ${REG[rt2]}, ${DREG(d / 2)}` : `vmov ${DREG(d / 2)}, ${REG[rt]}, ${REG[rt2]}`
    return i4(2, text, (c) => {
      if (toCore) {
        c.r[rt] = c.sBits[d]
        c.r[rt2] = c.sBits[d + 1]
      } else {
        c.sBits[d] = c.r[rt]
        c.sBits[d + 1] = c.r[rt2]
      }
    })
  }
  const s = (vm << 1) | m
  const text = toCore ? `vmov ${REG[rt]}, ${REG[rt2]}, ${SREG(s)}, ${SREG(s + 1)}` : `vmov ${SREG(s)}, ${SREG(s + 1)}, ${REG[rt]}, ${REG[rt2]}`
  return i4(2, text, (c) => {
    if (toCore) {
      c.r[rt] = c.sBits[s]
      c.r[rt2] = c.sBits[s + 1]
    } else {
      c.sBits[s] = c.r[rt]
      c.sBits[s + 1] = c.r[rt2]
    }
  })
}

/** VLDR/VSTR/VLDM/VSTM/VPUSH/VPOP (A7.7.x extension register load/store). */
function fpLoadStore(hw1: number, hw2: number, dp: boolean, i4: I4): Instr {
  const p = (hw1 >>> 8) & 1
  const u = (hw1 >>> 7) & 1
  const d = (hw1 >>> 6) & 1
  const w = (hw1 >>> 5) & 1
  const l = (hw1 >>> 4) & 1
  const rn = hw1 & 0xf
  const vd = (hw2 >>> 12) & 0xf
  const imm8 = hw2 & 0xff
  const imm = imm8 << 2
  // Register index in S units.
  const first = dp ? ((d << 4) | vd) * 2 : (vd << 1) | d
  if (p === 1 && w === 0) {
    // VLDR / VSTR
    const off = u ? imm : -imm
    const regName = dp ? DREG(first / 2) : SREG(first)
    const base = (c: Cpu) => (rn === 15 ? (c.pc + 4) & ~3 : c.r[rn])
    const baseJs = rn === 15 ? "((c.pc + 4) & ~3)" : `r[${rn}]`
    if (l) {
      return JF(
        i4(2, `vldr ${regName}, [${REG[rn]}, #${off}]`, (c) => {
          const a = (base(c) + off) >>> 0
          c.sBits[first] = c.bus.read32(a)
          if (dp) c.sBits[first + 1] = c.bus.read32(a + 4)
        }),
        `const a = (${baseJs} + ${off}) >>> 0; c.sBits[${first}] = bus.read32(a); ${dp ? `c.sBits[${first + 1}] = bus.read32(a + 4);` : ""}`,
        true,
      )
    }
    return JF(
      i4(2, `vstr ${regName}, [${REG[rn]}, #${off}]`, (c) => {
        const a = (base(c) + off) >>> 0
        c.bus.write32(a, c.sBits[first])
        if (dp) c.bus.write32(a + 4, c.sBits[first + 1])
      }),
      `const a = (${baseJs} + ${off}) >>> 0; bus.write32(a, c.sBits[${first}]); ${dp ? `bus.write32(a + 4, c.sBits[${first + 1}]);` : ""}`,
      true,
    )
  }
  // VLDM / VSTM (and VPUSH/VPOP aliases): count in S units
  const count = dp ? imm8 & ~1 : imm8
  if (count === 0 || first + count > 32) return undefinedInstr(hw1, hw2, 4)
  const regs = dp ? `{d${first / 2}-d${(first + count) / 2 - 1}}` : `{s${first}-s${first + count - 1}}`
  const isPush = p === 1 && u === 0 && w === 1 && rn === 13 && !l
  const isPop = p === 0 && u === 1 && w === 1 && rn === 13 && l
  const text = isPush ? `vpush ${regs}` : isPop ? `vpop ${regs}` : `${l ? "vldm" : "vstm"}${p ? "db" : "ia"} ${REG[rn]}${w ? "!" : ""}, ${regs}`
  return i4(1 + count, text, (c) => {
    const start = p ? (c.r[rn] - 4 * count) >>> 0 : c.r[rn]
    let a = start
    for (let i = 0; i < count; i++) {
      if (l) c.sBits[first + i] = c.bus.read32(a)
      else c.bus.write32(a, c.sBits[first + i])
      a += 4
    }
    if (w) c.r[rn] = p ? start : a >>> 0
  })
}

/** VMOV core↔single, VMRS, VMSR (A7.7.242, 246, 247). */
function fpTransfer32(hw1: number, hw2: number, dp: boolean, addr: number, i4: I4): Instr {
  const a = (hw1 >>> 5) & 7
  const l = (hw1 >>> 4) & 1
  const rt = (hw2 >>> 12) & 0xf
  const vn = hw1 & 0xf
  const n = (hw2 >>> 7) & 1
  if (a === 0 && !dp) {
    const sn = (vn << 1) | n
    if (l) return JF(i4(1, `vmov ${REG[rt]}, ${SREG(sn)}`, (c) => (c.r[rt] = c.sBits[sn])), `r[${rt}] = c.sBits[${sn}];`)
    return JF(i4(1, `vmov ${SREG(sn)}, ${REG[rt]}`, (c) => (c.sBits[sn] = c.r[rt])), `c.sBits[${sn}] = r[${rt}];`)
  }
  if (a === 7 && vn === 1 && !dp) {
    // VMRS / VMSR FPSCR
    if (l) {
      if (rt === 15) {
        return JF(
          i4(1, "vmrs APSR_nzcv, fpscr", (c) => {
            c.n = (c.fpscr >>> 31) & 1
            c.z = (c.fpscr >>> 30) & 1
            c.c = (c.fpscr >>> 29) & 1
            c.v = (c.fpscr >>> 28) & 1
          }),
          "const f = c.fpscr; c.n = (f >>> 31) & 1; c.z = (f >>> 30) & 1; c.c = (f >>> 29) & 1; c.v = (f >>> 28) & 1;",
        )
      }
      return i4(1, `vmrs ${REG[rt]}, fpscr`, (c) => (c.r[rt] = c.fpscr))
    }
    return i4(1, `vmsr fpscr, ${REG[rt]}`, (c) => (c.fpscr = c.r[rt] >>> 0))
  }
  if (a === 7 && !dp && l) {
    // VMRS of other system registers (FPSID, MVFR0/1): read as constants
    const ids: Record<number, number> = { 0: 0x41023240, 6: 0x11111111, 7: 0x11111111 }
    return i4(1, `vmrs ${REG[rt]}, fpsys${vn}`, (c) => (c.r[rt] = ids[vn] ?? 0))
  }
  return unimplemented(hw1, hw2, 4, addr, "fp transfer")
}

/** Floating-point data-processing instructions (A7.7.x), single or double precision. */
function fpDataProcessing(hw1: number, hw2: number, dp: boolean, addr: number, i4: I4): Instr {
  const F = dp ? FP64 : FP32
  const opc1 = (hw1 >>> 4) & 0xf
  const d = (hw1 >>> 6) & 1
  const vn = hw1 & 0xf
  const vd = (hw2 >>> 12) & 0xf
  const opc3 = (hw2 >>> 6) & 3
  const n = (hw2 >>> 7) & 1
  const m = (hw2 >>> 5) & 1
  const vm = hw2 & 0xf
  const sd = dp ? (d << 4) | vd : (vd << 1) | d
  const sn = dp ? (n << 4) | vn : (vn << 1) | n
  const sm = dp ? (m << 4) | vm : (vm << 1) | m
  const fr = F.fr
  const R = F.name
  // Single precision is the common case and gets flat closures on `c.s`; double goes through
  // the view (and the FPU check) since it is rare.
  const op = dp
    ? (cycles: number, text: string, exec: (c: Cpu) => void) =>
        i4(cycles, text, (c) => {
          needDouble(c)
          exec(c)
        })
    : i4
  const bin = (name: string, f: (a: number, b: number) => number, cycles = 1) =>
    op(cycles, `${name}.${F.ty} ${R(sd)}, ${R(sn)}, ${R(sm)}`, (c) => F.wr(c, sd, fr(f(F.rd(c, sn), F.rd(c, sm)))))
  const acc = (name: string, f: (d: number, n: number, m: number) => number) =>
    op(3, `${name}.${F.ty} ${R(sd)}, ${R(sn)}, ${R(sm)}`, (c) => F.wr(c, sd, fr(f(F.rd(c, sd), F.rd(c, sn), F.rd(c, sm)))))
  const slow = dp ? 30 : 14
  const t3 = (name: string) => `${name}.${F.ty} ${R(sd)}, ${R(sn)}, ${R(sm)}`
  if (!dp) {
    // The arithmetic the compilers emit most, each its own closure so the call site stays flat.
    switch (opc1 & 0xb) {
      case 0:
        return (opc3 & 1) === 0
          ? JF(i4(3, t3("vmla"), (c) => (c.s[sd] = c.s[sd] + Math.fround(c.s[sn] * c.s[sm]))), `s[${sd}] = s[${sd}] + Math.fround(s[${sn}] * s[${sm}]);`)
          : JF(i4(3, t3("vmls"), (c) => (c.s[sd] = c.s[sd] - Math.fround(c.s[sn] * c.s[sm]))), `s[${sd}] = s[${sd}] - Math.fround(s[${sn}] * s[${sm}]);`)
      case 2:
        return (opc3 & 1) === 0
          ? JF(i4(1, t3("vmul"), (c) => (c.s[sd] = c.s[sn] * c.s[sm])), `s[${sd}] = s[${sn}] * s[${sm}];`)
          : JF(i4(1, t3("vnmul"), (c) => (c.s[sd] = -(c.s[sn] * c.s[sm]))), `s[${sd}] = -(s[${sn}] * s[${sm}]);`)
      case 3:
        return (opc3 & 1) === 0
          ? JF(i4(1, t3("vadd"), (c) => (c.s[sd] = c.s[sn] + c.s[sm])), `s[${sd}] = s[${sn}] + s[${sm}];`)
          : JF(i4(1, t3("vsub"), (c) => (c.s[sd] = c.s[sn] - c.s[sm])), `s[${sd}] = s[${sn}] - s[${sm}];`)
      case 8:
        return JF(i4(slow, t3("vdiv"), (c) => (c.s[sd] = c.s[sn] / c.s[sm])), `s[${sd}] = s[${sn}] / s[${sm}];`)
      case 10:
        return (opc3 & 1) === 0
          ? JF(i4(3, t3("vfma"), (c) => (c.s[sd] = c.s[sd] + c.s[sn] * c.s[sm])), `s[${sd}] = s[${sd}] + s[${sn}] * s[${sm}];`)
          : JF(i4(3, t3("vfms"), (c) => (c.s[sd] = c.s[sd] - c.s[sn] * c.s[sm])), `s[${sd}] = s[${sd}] - s[${sn}] * s[${sm}];`)
    }
  }
  switch (opc1 & 0xb) {
    case 0: // VMLA / VMLS (the product rounds before the add)
      return (opc3 & 1) === 0 ? acc("vmla", (a, b, c) => a + fr(b * c)) : acc("vmls", (a, b, c) => a - fr(b * c))
    case 1: // VNMLA / VNMLS
      return (opc3 & 1) === 1 ? acc("vnmla", (a, b, c) => -a - fr(b * c)) : acc("vnmls", (a, b, c) => -a + fr(b * c))
    case 2: // VMUL / VNMUL
      return (opc3 & 1) === 0 ? bin("vmul", (a, b) => a * b) : bin("vnmul", (a, b) => -(a * b))
    case 3: // VADD / VSUB
      return (opc3 & 1) === 0 ? bin("vadd", (a, b) => a + b) : bin("vsub", (a, b) => a - b)
    case 8: // VDIV
      return bin("vdiv", (a, b) => a / b, slow)
    case 9: // VFNMA / VFNMS (fused: one rounding)
      return (opc3 & 1) === 1 ? acc("vfnma", (a, b, c) => -a - b * c) : acc("vfnms", (a, b, c) => -a + b * c)
    case 10: // VFMA / VFMS
      return (opc3 & 1) === 0 ? acc("vfma", (a, b, c) => a + b * c) : acc("vfms", (a, b, c) => a - b * c)
    case 11: {
      if ((opc3 & 1) === 0) {
        // VMOV (immediate)
        const imm8 = ((hw1 & 0xf) << 4) | (hw2 & 0xf)
        if (dp) {
          const value = expandImm64(imm8)
          return op(1, `vmov.f64 ${R(sd)}, #${value}`, (c) => (c.dBits[sd] = value))
        }
        // VFPExpandImm: sign, exp = NOT(b6):replicate(b6,5):b5:b4, frac = b3:b0 << 19
        const sign = (imm8 >>> 7) & 1
        const b6 = (imm8 >>> 6) & 1
        const exp = ((b6 ^ 1) << 7) | (b6 ? 0x7c : 0) | ((imm8 >>> 4) & 3)
        const bits = ((sign << 31) | (exp << 23) | ((imm8 & 0xf) << 19)) >>> 0
        return JF(i4(1, `vmov.f32 ${SREG(sd)}, #${hex(bits)}`, (c) => (c.sBits[sd] = bits)), `c.sBits[${sd}] = ${bits};`)
      }
      // Other VFP data-processing: opc2 = vn, opc3 in bit 7
      const opc2 = vn
      const opc3b = (hw2 >>> 7) & 1
      switch (opc2) {
        case 0:
          if (opc3b === 0) {
            if (dp) return op(1, `vmov.f64 ${R(sd)}, ${R(sm)}`, (c) => (c.dBits[sd] = c.dBits[sm]))
            return JF(i4(1, `vmov.f32 ${SREG(sd)}, ${SREG(sm)}`, (c) => (c.sBits[sd] = c.sBits[sm])), `c.sBits[${sd}] = c.sBits[${sm}];`)
          }
          if (dp) return op(1, `vabs.f64 ${R(sd)}, ${R(sm)}`, (c) => (c.dBits[sd] = Math.abs(c.dBits[sm])))
          return JF(i4(1, `vabs.f32 ${SREG(sd)}, ${SREG(sm)}`, (c) => (c.sBits[sd] = c.sBits[sm] & 0x7fffffff)), `c.sBits[${sd}] = c.sBits[${sm}] & 0x7fffffff;`)
        case 1:
          if (opc3b === 0) {
            if (dp) return op(1, `vneg.f64 ${R(sd)}, ${R(sm)}`, (c) => (c.dBits[sd] = -c.dBits[sm]))
            return JF(i4(1, `vneg.f32 ${SREG(sd)}, ${SREG(sm)}`, (c) => (c.sBits[sd] = (c.sBits[sm] ^ 0x80000000) >>> 0)), `c.sBits[${sd}] = (c.sBits[${sm}] ^ 0x80000000) >>> 0;`)
          }
          if (!dp) return JF(i4(slow, `vsqrt.f32 ${SREG(sd)}, ${SREG(sm)}`, (c) => (c.s[sd] = Math.sqrt(c.s[sm]))), `s[${sd}] = Math.sqrt(s[${sm}]);`)
          return op(slow, `vsqrt.${F.ty} ${R(sd)}, ${R(sm)}`, (c) => F.wr(c, sd, fr(Math.sqrt(F.rd(c, sm)))))
        case 2:
        case 3: {
          // VCVTB / VCVTT: half precision in the bottom/top half of an S register ↔ single (or double).
          const top = opc2 === 3
          const sh = (vd << 1) | d
          const smS = (vm << 1) | m
          const pick = (bits: number) => (top ? bits >>> 16 : bits & 0xffff)
          if (opc3b === 0)
            return op(1, `vcvt${top ? "t" : "b"}.${F.ty}.f16 ${R(sd)}, ${SREG(smS)}`, (c) => F.wr(c, sd, halfToFloat(pick(c.sBits[smS]))))
          return op(1, `vcvt${top ? "t" : "b"}.f16.${F.ty} ${SREG(sh)}, ${R(sm)}`, (c) => {
            const h = floatToHalf(F.rd(c, sm))
            c.sBits[sh] = (top ? (c.sBits[sh] & 0xffff) | (h << 16) : (c.sBits[sh] & 0xffff0000) | h) >>> 0
          })
        }
        case 4: {
          // VCMP / VCMPE (register)
          const instr = op(1, `vcmp${opc3b ? "e" : ""}.${F.ty} ${R(sd)}, ${R(sm)}`, (c) => fpCompare(c, F.rd(c, sd), F.rd(c, sm)))
          return dp ? instr : JF(instr, `H.fpCompare(c, s[${sd}], s[${sm}]);`)
        }
        case 5: {
          // VCMP with #0.0
          const instr = op(1, `vcmp${opc3b ? "e" : ""}.${F.ty} ${R(sd)}, #0.0`, (c) => fpCompare(c, F.rd(c, sd), 0))
          return dp ? instr : JF(instr, `H.fpCompare(c, s[${sd}], 0);`)
        }
        case 6: {
          // VRINTR (FPSCR rounding) / VRINTZ (toward zero)
          const text = `vrint${opc3b ? "z" : "r"}.${F.ty} ${R(sd)}, ${R(sm)}`
          return op(1, text, (c) => {
            needFpv5(c)
            F.wr(c, sd, fpRint(F.rd(c, sm), opc3b ? "zero" : RMODE[(c.fpscr >>> 22) & 3]))
          })
        }
        case 7: {
          if (opc3b === 0)
            return op(1, `vrintx.${F.ty} ${R(sd)}, ${R(sm)}`, (c) => {
              needFpv5(c)
              F.wr(c, sd, fpRint(F.rd(c, sm), RMODE[(c.fpscr >>> 22) & 3]))
            })
          // VCVT between precisions: Sm → Dd, or Dm → Sd.
          if (dp) {
            const sdS = (vd << 1) | d
            return op(1, `vcvt.f32.f64 ${SREG(sdS)}, ${DREG(sm)}`, (c) => (c.s[sdS] = Math.fround(c.dBits[sm])))
          }
          const ddD = (d << 4) | vd
          return i4(1, `vcvt.f64.f32 ${DREG(ddD)}, ${SREG(sm)}`, (c) => {
            needDouble(c)
            c.dBits[ddD] = c.s[sm]
          })
        }
        case 8: {
          // VCVT from integer (always an S source): op bit 7 = signed (1) / unsigned (0)
          const signed = opc3b === 1
          const smS = (vm << 1) | m
          const instr = op(1, `vcvt.${F.ty}.${signed ? "s32" : "u32"} ${R(sd)}, ${SREG(smS)}`, (c) => F.wr(c, sd, fr(signed ? c.sBits[smS] | 0 : c.sBits[smS])))
          return dp ? instr : JF(instr, `s[${sd}] = c.sBits[${smS}]${signed ? " | 0" : ""};`)
        }
        case 10:
        case 11:
          return fpCvtFixed(hw1, hw2, sd, false, F, i4)
        case 12:
        case 13: {
          // VCVT to integer (always an S destination): opc2 bit0 = signed; opc3 bit 7 = round toward zero (1) / FPSCR (0)
          const signed = (opc2 & 1) === 1
          const roundZero = opc3b === 1
          const sdS = (vd << 1) | d
          const instr = op(1, `vcvt${roundZero ? "" : "r"}.${signed ? "s32" : "u32"}.${F.ty} ${SREG(sdS)}, ${R(sm)}`, (c) => {
            c.sBits[sdS] = fpToInt(F.rd(c, sm), !signed, roundZero ? "zero" : RMODE[(c.fpscr >>> 22) & 3])
          })
          if (dp) return instr
          if (roundZero)
            return JF(
              instr,
              signed
                ? `const v = Math.trunc(s[${sm}]); c.sBits[${sdS}] = v !== v ? 0 : v <= -2147483648 ? 0x80000000 : v >= 2147483647 ? 0x7fffffff : v >>> 0;`
                : `const v = Math.trunc(s[${sm}]); c.sBits[${sdS}] = v !== v || v <= 0 ? 0 : v >= 4294967295 ? 4294967295 : v >>> 0;`,
            )
          return JF(instr, `c.sBits[${sdS}] = H.fpToInt(s[${sm}], ${!signed}, H.RMODE[(c.fpscr >>> 22) & 3]);`)
        }
        case 14:
        case 15:
          return fpCvtFixed(hw1, hw2, sd, true, F, i4)
      }
      return unimplemented(hw1, hw2, 4, addr, "vfp data-processing")
    }
  }
  return unimplemented(hw1, hw2, 4, addr, "vfp")
}

/** The FPv5 additions (0xFE-prefixed): VSEL, VMAXNM/VMINNM, VCVT{A,N,P,M}, VRINT{A,N,P,M}. */
function fpv5(hw1: number, hw2: number, dp: boolean, addr: number, i4: I4): Instr {
  const F = dp ? FP64 : FP32
  const d = (hw1 >>> 6) & 1
  const vn = hw1 & 0xf
  const vd = (hw2 >>> 12) & 0xf
  const n = (hw2 >>> 7) & 1
  const m = (hw2 >>> 5) & 1
  const vm = hw2 & 0xf
  const sd = dp ? (d << 4) | vd : (vd << 1) | d
  const sn = dp ? (n << 4) | vn : (vn << 1) | n
  const sm = dp ? (m << 4) | vm : (vm << 1) | m
  const R = F.name
  const op = (text: string, exec: (c: Cpu) => void) =>
    i4(1, text, (c) => {
      needFpv5(c)
      if (dp) needDouble(c)
      exec(c)
    })
  const DIRECTED: Rounding[] = ["away", "even", "up", "down"]
  if ((hw1 & 0x80) === 0) {
    // VSEL<cc>: cc 00 EQ, 01 VS, 10 GE, 11 GT (on the APSR flags set by VMRS).
    const cc = (hw1 >>> 4) & 3
    const name = ["eq", "vs", "ge", "gt"][cc]
    return op(`vsel${name}.${F.ty} ${R(sd)}, ${R(sn)}, ${R(sm)}`, (c) => {
      const take = cc === 0 ? c.z === 1 : cc === 1 ? c.v === 1 : cc === 2 ? c.n === c.v : c.z === 0 && c.n === c.v
      F.wr(c, sd, F.rd(c, take ? sn : sm))
    })
  }
  const sub = (hw1 >>> 4) & 3
  if (sub === 0) {
    // VMAXNM / VMINNM: a quiet NaN loses to a number.
    const min = ((hw2 >>> 6) & 1) === 1
    return op(`v${min ? "min" : "max"}nm.${F.ty} ${R(sd)}, ${R(sn)}, ${R(sm)}`, (c) => {
      const a = F.rd(c, sn)
      const b = F.rd(c, sm)
      const r = Number.isNaN(a) ? b : Number.isNaN(b) ? a : min ? Math.min(a, b) : Math.max(a, b)
      F.wr(c, sd, r)
    })
  }
  if (sub === 3) {
    const rm = DIRECTED[hw1 & 3]
    const letter = "anpm"[hw1 & 3]
    if (hw1 & 4) {
      // VCVT{A,N,P,M}: to a 32-bit integer in an S register with the directed rounding.
      const signed = ((hw2 >>> 7) & 1) === 1
      const sdS = (vd << 1) | d
      return op(`vcvt${letter}.${signed ? "s32" : "u32"}.${F.ty} ${SREG(sdS)}, ${R(sm)}`, (c) => {
        c.sBits[sdS] = fpToInt(F.rd(c, sm), !signed, rm)
      })
    }
    return op(`vrint${letter}.${F.ty} ${R(sd)}, ${R(sm)}`, (c) => F.wr(c, sd, fpRint(F.rd(c, sm), rm)))
  }
  return unimplemented(hw1, hw2, 4, addr, "fpv5")
}

/** VCVT between a float and fixed-point in the same register (A7.7.227). */
function fpCvtFixed(hw1: number, hw2: number, sd: number, toFixed: boolean, F: FpView, i4: I4): Instr {
  const u = hw1 & 1 // opc2 bit 0: unsigned
  const sx = (hw2 >>> 7) & 1 // size: 0 = 16, 1 = 32
  const i = (hw2 >>> 5) & 1
  const imm4 = hw2 & 0xf
  const size = sx ? 32 : 16
  const fracBits = size - ((imm4 << 1) | i)
  const scale = 2 ** fracBits
  const ty = `${u ? "u" : "s"}${size}`
  // The fixed-point value lives in the low bits of the same register (the low word of a D).
  const lo = F.dp ? sd * 2 : sd
  if (toFixed) {
    return i4(1, `vcvt.${ty}.${F.ty} ${F.name(sd)}, ${F.name(sd)}, #${fracBits}`, (c) => {
      if (F.dp) needDouble(c)
      const v = F.rd(c, sd) * scale
      let r = roundTo(v, "even")
      const max = u ? 2 ** size - 1 : 2 ** (size - 1) - 1
      const min = u ? 0 : -(2 ** (size - 1))
      r = Math.max(min, Math.min(max, r))
      c.sBits[lo] = (size === 16 ? r & 0xffff : r) >>> 0
      if (F.dp) c.sBits[lo + 1] = 0
    })
  }
  return i4(1, `vcvt.${F.ty}.${ty} ${F.name(sd)}, ${F.name(sd)}, #${fracBits}`, (c) => {
    if (F.dp) needDouble(c)
    let v = c.sBits[lo]
    if (size === 16) v = u ? v & 0xffff : (v << 16) >> 16
    else if (!u) v = v | 0
    F.wr(c, sd, F.fr(v / scale))
  })
}

/** Helpers the compiled blocks (jit.ts) call by name through their `H` argument. */
export const jitHelpers = { fpCompare, fpToInt, RMODE }
