/**
 * AVRe+ instruction decoder: one flash word (and the next, for two-word instructions) becomes
 * a closure with its operands bound, which the core caches per word address. Semantics,
 * flags and clocks: AVR Instruction Set Manual (DS40002198C), AVRe column, 16-bit PC.
 */
import type { AvrCpu } from "./cpu"
import { SREG, SREG_C, SREG_H, SREG_I, SREG_N, SREG_S, SREG_T, SREG_V, SREG_Z } from "./sreg"

/** One decoded instruction: runs itself against the core, advancing PC and cycles. */
export type Op = (c: AvrCpu) => void

export function isTwoWord(w: number): boolean {
  return (w & 0xfc0f) === 0x9000 || (w & 0xfe0c) === 0x940c
}

// --- flags -----------------------------------------------------------------------------------

const KEEP_IT = SREG_I | SREG_T

function addFlags(c: AvrCpu, d: number, r: number, R: number): number {
  const res = R & 0xff
  const cy = (d & r) | (r & ~res) | (~res & d)
  const h = cy & 0x08 ? SREG_H : 0
  const cf = cy & 0x80 ? SREG_C : 0
  const v = ((d & r & ~res) | (~d & ~r & res)) & 0x80 ? SREG_V : 0
  const n = res & 0x80 ? SREG_N : 0
  const s = (n !== 0) !== (v !== 0) ? SREG_S : 0
  const z = res === 0 ? SREG_Z : 0
  c.data[SREG] = (c.data[SREG] & KEEP_IT) | h | s | v | n | z | cf
  return res
}

/** Subtract flags; `keepZ` is the CPC/SBC/SBCI rule: Z only stays set if it was and the result is zero. */
function subFlags(c: AvrCpu, d: number, r: number, R: number, keepZ: boolean): number {
  const res = R & 0xff
  const bw = (~d & r) | (r & res) | (res & ~d)
  const h = bw & 0x08 ? SREG_H : 0
  const cf = bw & 0x80 ? SREG_C : 0
  const v = ((d & ~r & ~res) | (~d & r & res)) & 0x80 ? SREG_V : 0
  const n = res & 0x80 ? SREG_N : 0
  const s = (n !== 0) !== (v !== 0) ? SREG_S : 0
  const old = c.data[SREG]
  const z = res === 0 && (!keepZ || old & SREG_Z) ? SREG_Z : 0
  c.data[SREG] = (old & KEEP_IT) | h | s | v | n | z | cf
  return res
}

/** AND/OR/EOR/COM-style: V cleared, N and Z from the result, C and H untouched. */
function logicFlags(c: AvrCpu, res: number) {
  const n = res & 0x80 ? SREG_N : 0
  c.data[SREG] = (c.data[SREG] & (KEEP_IT | SREG_H | SREG_C)) | n | (n ? SREG_S : 0) | (res === 0 ? SREG_Z : 0)
}

/** LSR/ROR/ASR: C from bit 0, V = N ⊕ C, S = N ⊕ V; H untouched. */
function shiftRightFlags(c: AvrCpu, res: number, carry: number) {
  const n = res & 0x80 ? 1 : 0
  const v = n ^ carry
  const s = n ^ v
  c.data[SREG] = (c.data[SREG] & (KEEP_IT | SREG_H)) | (carry ? SREG_C : 0) | (res === 0 ? SREG_Z : 0) | (n ? SREG_N : 0) | (v ? SREG_V : 0) | (s ? SREG_S : 0)
}

function mulFlags(c: AvrCpu, product: number, carryBit: number) {
  const p = product & 0xffff
  c.data[0] = p & 0xff
  c.data[1] = p >> 8
  c.data[SREG] = (c.data[SREG] & ~(SREG_C | SREG_Z)) | (carryBit ? SREG_C : 0) | (p === 0 ? SREG_Z : 0)
}

const signed8 = (x: number) => (x << 24) >> 24

// --- decoder ---------------------------------------------------------------------------------

/** Skip the next instruction if `cond`: 1 cycle if not, 2 for a one-word, 3 for a two-word instruction. */
function skip(c: AvrCpu, pc: number, cond: boolean) {
  if (cond) {
    const w = c.wordsAt(pc + 1)
    c.pc = (pc + 1 + w) & c.pcMask
    c.cycles += 1 + w
  } else {
    c.pc = (pc + 1) & c.pcMask
    c.cycles += 1
  }
}

export function decode(w: number, next: number, pc: number): Op {
  const n = (pc + 1) & 0xffff
  const d5 = (w >> 4) & 0x1f
  const r5 = (w & 0x0f) | ((w >> 5) & 0x10)
  const d4 = 16 + ((w >> 4) & 0x0f)
  const K8 = (w & 0x0f) | ((w >> 4) & 0xf0)

  switch (w >> 12) {
    case 0x0: {
      if (w === 0) return nop(n)
      switch ((w >> 8) & 0x0f) {
        case 0x1: {
          const d = ((w >> 4) & 0x0f) * 2
          const r = (w & 0x0f) * 2
          return (c) => {
            c.data[d] = c.data[r]
            c.data[d + 1] = c.data[r + 1]
            c.pc = n
            c.cycles += 1
          }
        }
        case 0x2: {
          const d = 16 + ((w >> 4) & 0x0f)
          const r = 16 + (w & 0x0f)
          return (c) => {
            const p = signed8(c.data[d]) * signed8(c.data[r])
            mulFlags(c, p, (p >> 15) & 1)
            c.pc = n
            c.cycles += 2
          }
        }
        case 0x3: {
          const d = 16 + ((w >> 4) & 0x07)
          const r = 16 + (w & 0x07)
          const kind = ((w >> 6) & 2) | ((w >> 3) & 1)
          return (c) => {
            const a = c.data[d]
            const b = c.data[r]
            let p: number
            if (kind === 0) p = signed8(a) * b // MULSU
            else if (kind === 1) p = a * b // FMUL
            else if (kind === 2) p = signed8(a) * signed8(b) // FMULS
            else p = signed8(a) * b // FMULSU
            p &= 0xffff
            if (kind === 0) mulFlags(c, p, (p >> 15) & 1)
            else mulFlags(c, p << 1, (p >> 15) & 1)
            c.pc = n
            c.cycles += 2
          }
        }
        case 0x4:
        case 0x5:
        case 0x6:
        case 0x7:
          return (c) => {
            // CPC
            const a = c.data[d5]
            const b = c.data[r5]
            subFlags(c, a, b, a - b - (c.data[SREG] & SREG_C), true)
            c.pc = n
            c.cycles += 1
          }
        case 0x8:
        case 0x9:
        case 0xa:
        case 0xb:
          return (c) => {
            // SBC
            const a = c.data[d5]
            const b = c.data[r5]
            c.data[d5] = subFlags(c, a, b, a - b - (c.data[SREG] & SREG_C), true)
            c.pc = n
            c.cycles += 1
          }
        default:
          return (c) => {
            // ADD (LSL)
            const a = c.data[d5]
            const b = c.data[r5]
            c.data[d5] = addFlags(c, a, b, a + b)
            c.pc = n
            c.cycles += 1
          }
      }
    }
    case 0x1:
      switch ((w >> 10) & 3) {
        case 0:
          return (c) => skip(c, pc, c.data[d5] === c.data[r5]) // CPSE
        case 1:
          return (c) => {
            // CP
            const a = c.data[d5]
            const b = c.data[r5]
            subFlags(c, a, b, a - b, false)
            c.pc = n
            c.cycles += 1
          }
        case 2:
          return (c) => {
            // SUB
            const a = c.data[d5]
            const b = c.data[r5]
            c.data[d5] = subFlags(c, a, b, a - b, false)
            c.pc = n
            c.cycles += 1
          }
        default:
          return (c) => {
            // ADC (ROL)
            const a = c.data[d5]
            const b = c.data[r5]
            const cin = c.data[SREG] & SREG_C
            c.data[d5] = addFlags(c, a, b, a + b + cin)
            c.pc = n
            c.cycles += 1
          }
      }
    case 0x2:
      switch ((w >> 10) & 3) {
        case 0:
          return (c) => {
            const v = c.data[d5] & c.data[r5]
            c.data[d5] = v
            logicFlags(c, v)
            c.pc = n
            c.cycles += 1
          }
        case 1:
          return (c) => {
            const v = c.data[d5] ^ c.data[r5]
            c.data[d5] = v
            logicFlags(c, v)
            c.pc = n
            c.cycles += 1
          }
        case 2:
          return (c) => {
            const v = c.data[d5] | c.data[r5]
            c.data[d5] = v
            logicFlags(c, v)
            c.pc = n
            c.cycles += 1
          }
        default:
          return (c) => {
            c.data[d5] = c.data[r5]
            c.pc = n
            c.cycles += 1
          }
      }
    case 0x3:
      return (c) => {
        // CPI
        const a = c.data[d4]
        subFlags(c, a, K8, a - K8, false)
        c.pc = n
        c.cycles += 1
      }
    case 0x4:
      return (c) => {
        // SBCI
        const a = c.data[d4]
        c.data[d4] = subFlags(c, a, K8, a - K8 - (c.data[SREG] & SREG_C), true)
        c.pc = n
        c.cycles += 1
      }
    case 0x5:
      return (c) => {
        // SUBI
        const a = c.data[d4]
        c.data[d4] = subFlags(c, a, K8, a - K8, false)
        c.pc = n
        c.cycles += 1
      }
    case 0x6:
      return (c) => {
        // ORI
        const v = c.data[d4] | K8
        c.data[d4] = v
        logicFlags(c, v)
        c.pc = n
        c.cycles += 1
      }
    case 0x7:
      return (c) => {
        // ANDI
        const v = c.data[d4] & K8
        c.data[d4] = v
        logicFlags(c, v)
        c.pc = n
        c.cycles += 1
      }
    case 0x8:
    case 0xa: {
      // LDD/STD with displacement (q = 0 is plain LD/ST through Y or Z).
      const q = (w & 0x07) | ((w >> 7) & 0x18) | ((w >> 8) & 0x20)
      const base = w & 0x08 ? 28 : 30
      if (w & 0x0200)
        return (c) => {
          c.write(((c.data[base] | (c.data[base + 1] << 8)) + q) & 0xffff, c.data[d5], 1)
          c.pc = n
          c.cycles += 2
        }
      return (c) => {
        c.data[d5] = c.read(((c.data[base] | (c.data[base + 1] << 8)) + q) & 0xffff, 1)
        c.pc = n
        c.cycles += 2
      }
    }
    case 0x9:
      return decode9(w, next, pc, n, d5, r5)
    case 0xb: {
      const A = (w & 0x0f) | ((w >> 5) & 0x30)
      const addr = A + 0x20
      if (w & 0x0800)
        return (c) => {
          // OUT
          c.write(addr, c.data[d5])
          c.pc = n
          c.cycles += 1
        }
      return (c) => {
        // IN
        c.data[d5] = c.read(addr)
        c.pc = n
        c.cycles += 1
      }
    }
    case 0xc: {
      const k = ((w << 20) >> 20) // 12-bit signed
      const target = (pc + 1 + k) & 0xffff
      return (c) => {
        c.pc = target & c.pcMask
        c.cycles += 2
      }
    }
    case 0xd: {
      const k = (w << 20) >> 20
      const target = (pc + 1 + k) & 0xffff
      return (c) => {
        c.pushPc(n)
        c.pc = target & c.pcMask
        c.cycles += 3
      }
    }
    case 0xe:
      return (c) => {
        // LDI
        c.data[d4] = K8
        c.pc = n
        c.cycles += 1
      }
    default: {
      // 0xF: branches, BLD/BST, SBRC/SBRS. Bit 3 of BLD/BST/SBRC/SBRS is undefined in the manual
      // ("0bbb"); the silicon ignores it — erased flash (0xFFFF) runs as SBRS r31,7, which is how a
      // part with BOOTRST programmed and no boot loader slides through to the application at 0.
      const b = w & 0x07
      const bit = 1 << b
      switch ((w >> 9) & 7) {
        case 0:
        case 1:
        case 2:
        case 3: {
          const k = (w << 22) >> 25 // 7-bit signed, bits 9:3
          const target = (pc + 1 + k) & 0xffff
          const whenSet = (w & 0x0400) === 0
          return (c) => {
            const set = (c.data[SREG] & bit) !== 0
            if (set === whenSet) {
              c.pc = target & c.pcMask
              c.cycles += 2
            } else {
              c.pc = n
              c.cycles += 1
            }
          }
        }
        case 4:
          return (c) => {
            // BLD
            c.data[d5] = c.data[SREG] & SREG_T ? c.data[d5] | bit : c.data[d5] & ~bit
            c.pc = n
            c.cycles += 1
          }
        case 5:
          return (c) => {
            // BST
            c.data[SREG] = c.data[d5] & bit ? c.data[SREG] | SREG_T : c.data[SREG] & ~SREG_T
            c.pc = n
            c.cycles += 1
          }
        case 6:
          return (c) => skip(c, pc, (c.data[d5] & bit) === 0) // SBRC
        default:
          return (c) => skip(c, pc, (c.data[d5] & bit) !== 0) // SBRS
      }
    }
  }
}

function nop(n: number): Op {
  return (c) => {
    c.pc = n
    c.cycles += 1
  }
}

/** Pointer registers: X = r27:r26, Y = r29:r28, Z = r31:r30. */
const ptr = (c: AvrCpu, lo: number) => c.data[lo] | (c.data[lo + 1] << 8)
const setPtr = (c: AvrCpu, lo: number, v: number) => {
  c.data[lo] = v & 0xff
  c.data[lo + 1] = (v >> 8) & 0xff
}

function decode9(w: number, next: number, pc: number, n: number, d5: number, r5: number): Op {
  const undef: Op = (c) => c.undefinedOp(w)
  switch ((w >> 9) & 7) {
    case 0:
    case 1: {
      // 1001 00sd dddd mode: loads (s = 0) and stores (s = 1).
      const store = (w & 0x0200) !== 0
      const mode = w & 0x0f
      if (mode === 0) {
        const k = next
        const n2 = (pc + 2) & 0xffff
        if (store)
          return (c) => {
            c.write(k, c.data[d5], 1)
            c.pc = n2
            c.cycles += 2
          }
        return (c) => {
          c.data[d5] = c.read(k, 1)
          c.pc = n2
          c.cycles += 2
        }
      }
      if (mode === 0x0f) {
        if (store)
          return (c) => {
            c.push(c.data[d5])
            c.pc = n
            c.cycles += 2
          }
        return (c) => {
          c.data[d5] = c.pop()
          c.pc = n
          c.cycles += 2
        }
      }
      if (!store && (mode === 4 || mode === 5)) {
        const post = mode === 5
        return (c) => {
          // LPM Rd, Z / Z+
          const z = ptr(c, 30)
          const v = c.system.lpm(z)
          if (post) setPtr(c, 30, z + 1)
          c.data[d5] = v
          c.pc = n
          c.cycles += 3
        }
      }
      // Pointer modes: 1/2 Z+/-Z, 9/10 Y+/-Y, 12/13/14 X, X+, -X.
      let reg: number
      let inc = 0
      switch (mode) {
        case 1:
          reg = 30
          inc = 1
          break
        case 2:
          reg = 30
          inc = -1
          break
        case 9:
          reg = 28
          inc = 1
          break
        case 10:
          reg = 28
          inc = -1
          break
        case 12:
          reg = 26
          break
        case 13:
          reg = 26
          inc = 1
          break
        case 14:
          reg = 26
          inc = -1
          break
        default:
          // ELPM (6, 7), XCH/LAS/LAC/LAT (store 4–7) are not on this core.
          return undef
      }
      if (store)
        return (c) => {
          let p = ptr(c, reg)
          if (inc < 0) p = (p - 1) & 0xffff
          // The register is read before the pointer moves: ST X+, r26 stores the old r26.
          const v = c.data[d5]
          c.write(p, v, 1)
          if (inc > 0) p = (p + 1) & 0xffff
          setPtr(c, reg, p)
          c.pc = n
          c.cycles += 2
        }
      return (c) => {
        let p = ptr(c, reg)
        if (inc < 0) p = (p - 1) & 0xffff
        const v = c.read(p, 1)
        if (inc > 0) p = (p + 1) & 0xffff
        setPtr(c, reg, p)
        c.data[d5] = v
        c.pc = n
        c.cycles += 2
      }
    }
    case 2:
    case 3: {
      // 1001 010x xxxx xxxx, 1001 011x: ADIW/SBIW
      const low = w & 0x0f
      if ((w & 0x0600) === 0x0400 && (w & 0x0c) === 0x0c) {
        // JMP / CALL k (22 bits; the upper bits are beyond this part's flash)
        const k = ((((w >> 3) & 0x3e) | (w & 1)) << 16) | next
        const call = (w & 0x02) !== 0
        const n2 = (pc + 2) & 0xffff
        if (call)
          return (c) => {
            c.pushPc(n2)
            c.pc = k & c.pcMask
            c.cycles += 4
          }
        return (c) => {
          c.pc = k & c.pcMask
          c.cycles += 3
        }
      }
      if ((w & 0x0600) === 0x0600) {
        // 1001 011x: ADIW / SBIW
        const d = 24 + ((w >> 3) & 0x06)
        const K = (w & 0x0f) | ((w >> 2) & 0x30)
        // Rd+1:Rd ± K; V and C from bit 15 of the operand and the result (DS40002198C §6.4, §6.106).
        const sub = (w & 0x0100) !== 0
        return (c) => {
          const a = c.data[d] | (c.data[d + 1] << 8)
          const res = (sub ? a - K : a + K) & 0xffff
          c.data[d] = res & 0xff
          c.data[d + 1] = res >> 8
          const a15 = a >> 15
          const r15 = res >> 15
          const vf = sub ? a15 & ~r15 & 1 : ~a15 & r15 & 1
          const cf = sub ? r15 & ~a15 & 1 : ~r15 & a15 & 1
          const nf = r15
          c.data[SREG] = (c.data[SREG] & (KEEP_IT | SREG_H)) | (cf ? SREG_C : 0) | (res === 0 ? SREG_Z : 0) | (nf ? SREG_N : 0) | (vf ? SREG_V : 0) | (nf ^ vf ? SREG_S : 0)
          c.pc = n
          c.cycles += 2
        }
      }
      switch (low) {
        case 0x0:
          return (c) => {
            // COM
            const v = ~c.data[d5] & 0xff
            c.data[d5] = v
            const nf = v & 0x80 ? SREG_N : 0
            c.data[SREG] = (c.data[SREG] & (KEEP_IT | SREG_H)) | SREG_C | nf | (nf ? SREG_S : 0) | (v === 0 ? SREG_Z : 0)
            c.pc = n
            c.cycles += 1
          }
        case 0x1:
          return (c) => {
            // NEG
            const a = c.data[d5]
            c.data[d5] = subFlags(c, 0, a, -a, false)
            c.pc = n
            c.cycles += 1
          }
        case 0x2:
          return (c) => {
            const a = c.data[d5]
            c.data[d5] = ((a << 4) | (a >> 4)) & 0xff
            c.pc = n
            c.cycles += 1
          }
        case 0x3:
          return (c) => {
            // INC: C untouched, V when 0x7F → 0x80.
            const v = (c.data[d5] + 1) & 0xff
            c.data[d5] = v
            const nf = v & 0x80 ? 1 : 0
            const vf = v === 0x80 ? 1 : 0
            c.data[SREG] = (c.data[SREG] & (KEEP_IT | SREG_H | SREG_C)) | (nf ? SREG_N : 0) | (vf ? SREG_V : 0) | (nf ^ vf ? SREG_S : 0) | (v === 0 ? SREG_Z : 0)
            c.pc = n
            c.cycles += 1
          }
        case 0x5:
          return (c) => {
            const a = c.data[d5]
            const v = (a >> 1) | (a & 0x80)
            c.data[d5] = v
            shiftRightFlags(c, v, a & 1)
            c.pc = n
            c.cycles += 1
          }
        case 0x6:
          return (c) => {
            const a = c.data[d5]
            const v = a >> 1
            c.data[d5] = v
            shiftRightFlags(c, v, a & 1)
            c.pc = n
            c.cycles += 1
          }
        case 0x7:
          return (c) => {
            const a = c.data[d5]
            const v = (a >> 1) | (c.data[SREG] & SREG_C ? 0x80 : 0)
            c.data[d5] = v
            shiftRightFlags(c, v, a & 1)
            c.pc = n
            c.cycles += 1
          }
        case 0xa:
          return (c) => {
            // DEC: V when 0x80 → 0x7F.
            const v = (c.data[d5] - 1) & 0xff
            c.data[d5] = v
            const nf = v & 0x80 ? 1 : 0
            const vf = v === 0x7f ? 1 : 0
            c.data[SREG] = (c.data[SREG] & (KEEP_IT | SREG_H | SREG_C)) | (nf ? SREG_N : 0) | (vf ? SREG_V : 0) | (nf ^ vf ? SREG_S : 0) | (v === 0 ? SREG_Z : 0)
            c.pc = n
            c.cycles += 1
          }
        case 0x8:
          return decodeMisc(w, pc, n, undef)
        case 0x9:
          if (w === 0x9409)
            return (c) => {
              c.pc = ptr(c, 30) & c.pcMask
              c.cycles += 2
            }
          if (w === 0x9509)
            return (c) => {
              c.pushPc(n)
              c.pc = ptr(c, 30) & c.pcMask
              c.cycles += 3
            }
          return undef // EIJMP/EICALL: no EIND on this part
        default:
          return undef // 0x4 (reserved), 0xB (DES, XMEGA only)
      }
    }
    case 4:
    case 5: {
      // 1001 1000 CBI, 1001 1001 SBIC, 1001 1010 SBI, 1001 1011 SBIS (A in 0x00–0x1F)
      const A = ((w >> 3) & 0x1f) + 0x20
      const bit = 1 << (w & 7)
      switch ((w >> 8) & 3) {
        case 0:
          return (c) => {
            c.at = c.cycles
            const v = c.ioRead[A](A) & ~bit
            c.at = c.cycles + 1
            c.ioWrite[A](A, v, bit)
            c.pc = n
            c.cycles += 2
          }
        case 1:
          return (c) => {
            c.at = c.cycles
            skip(c, pc, (c.ioRead[A](A) & bit) === 0)
          }
        case 2:
          return (c) => {
            c.at = c.cycles
            const v = c.ioRead[A](A) | bit
            c.at = c.cycles + 1
            c.ioWrite[A](A, v, bit)
            c.pc = n
            c.cycles += 2
          }
        default:
          return (c) => {
            c.at = c.cycles
            skip(c, pc, (c.ioRead[A](A) & bit) !== 0)
          }
      }
    }
    default:
      // 1001 11rd dddd rrrr: MUL
      return (c) => {
        const p = c.data[d5] * c.data[r5]
        mulFlags(c, p, (p >> 15) & 1)
        c.pc = n
        c.cycles += 2
      }
  }
}

function decodeMisc(w: number, pc: number, n: number, undef: Op): Op {
  // 1001 0100 Bsss 1000: BSET/BCLR
  if ((w & 0xff0f) === 0x9408) {
    const bit = 1 << ((w >> 4) & 7)
    const set = (w & 0x80) === 0
    if (set && bit === SREG_I)
      return (c) => {
        // SEI: the next instruction runs before any pending interrupt.
        c.data[SREG] |= SREG_I
        c.pc = n
        c.cycles += 1
        c.holdInterrupts()
      }
    if (set)
      return (c) => {
        c.data[SREG] |= bit
        c.pc = n
        c.cycles += 1
      }
    return (c) => {
      c.data[SREG] &= ~bit
      c.pc = n
      c.cycles += 1
    }
  }
  switch (w) {
    case 0x9508:
      return (c) => {
        c.pc = c.popPc()
        c.cycles += 4
      }
    case 0x9518:
      return (c) => {
        c.pc = c.popPc()
        c.data[SREG] |= SREG_I
        c.cycles += 4
        c.holdInterrupts()
      }
    case 0x9588:
      return (c) => {
        c.pc = n
        c.cycles += 1
        if (c.system.sleep()) c.sleeping = true
      }
    case 0x9598:
      return (c) => {
        c.onBreak(pc)
        c.pc = n
        c.cycles += 1
      }
    case 0x95a8:
      return (c) => {
        c.system.watchdogReset()
        c.pc = n
        c.cycles += 1
      }
    case 0x95c8:
      return (c) => {
        // LPM (r0 ← (Z))
        c.data[0] = c.system.lpm(ptr(c, 30))
        c.pc = n
        c.cycles += 3
      }
    case 0x95e8:
      return (c) => {
        const stall = c.system.spm(ptr(c, 30), c.data[0] | (c.data[1] << 8))
        c.pc = n
        c.cycles += 1 + stall
      }
    default:
      return undef // ELPM (0x95D8), SPM Z+ (0x95F8, XMEGA) and the reserved codes
  }
}
