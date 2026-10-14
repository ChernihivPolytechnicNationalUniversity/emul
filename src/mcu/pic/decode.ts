/**
 * Mid-range PIC instruction decoder: each 14-bit word decodes once into a closure carrying its
 * operands (DS40044G Table 15-2; OPTION and TRIS from DS33023A §29.5). The run loop has already
 * moved the PC past the instruction and adds the first cycle; a closure adds the second when
 * the PC changes or a skip is taken (Table 15-2 note 3).
 */
import type { PicCpu } from "./cpu"
import { STATUS_C, STATUS_DC, STATUS_Z } from "./cpu"

export type PicOp = (c: PicCpu) => void

const ZERO = (r: number) => (r === 0 ? STATUS_Z : 0)

/** Store a byte op's result in W (d = 0) or back in f (d = 1). */
function dest(c: PicCpu, a: number, d: boolean, r: number, flags: boolean) {
  if (d) c.write(a, r, flags)
  else c.w = r
}

/** f + W, or a − b as a + ~b + 1: C and DC are the carries out of bits 7 and 3 (Register 4-1). */
function sum(c: PicCpu, x: number, y: number, carry: number): number {
  const s = x + y + carry
  let st = c.status & ~(STATUS_C | STATUS_DC | STATUS_Z)
  if (s > 0xff) st |= STATUS_C
  if ((x & 0x0f) + (y & 0x0f) + carry > 0x0f) st |= STATUS_DC
  if ((s & 0xff) === 0) st |= STATUS_Z
  c.status = st
  return s & 0xff
}

/** Byte op with a Z-only result (AND, IOR, XOR, COMF, DECF, INCF, MOVF). */
function zOp(f: number, d: boolean, fn: (w: number, x: number) => number): PicOp {
  return (c) => {
    const a = c.addr(f)
    const r = fn(c.w, c.read(a)) & 0xff
    dest(c, a, d, r, true)
    c.status = (c.status & ~STATUS_Z) | ZERO(r)
  }
}

function byteOp(word: number): PicOp {
  const op = (word >> 8) & 0x0f
  const d = (word & 0x80) !== 0
  const f = word & 0x7f
  switch (op) {
    case 0x0:
      if (d)
        return (c) => {
          c.write(c.addr(f), c.w, false)
        }
      return special(word)
    case 0x1:
      if (d)
        return (c) => {
          c.write(c.addr(f), 0, true)
          c.status |= STATUS_Z
        }
      // CLRW: 00 0001 0xxx xxxx.
      return (c) => {
        c.w = 0
        c.status |= STATUS_Z
      }
    case 0x2: // SUBWF: f − W
      return (c) => {
        const a = c.addr(f)
        const x = c.read(a)
        const r = sum(c, x, ~c.w & 0xff, 1)
        dest(c, a, d, r, true)
      }
    case 0x3:
      return zOp(f, d, (_w, x) => x - 1)
    case 0x4:
      return zOp(f, d, (w, x) => w | x)
    case 0x5:
      return zOp(f, d, (w, x) => w & x)
    case 0x6:
      return zOp(f, d, (w, x) => w ^ x)
    case 0x7: // ADDWF
      return (c) => {
        const a = c.addr(f)
        const x = c.read(a)
        const r = sum(c, x, c.w, 0)
        dest(c, a, d, r, true)
      }
    case 0x8:
      return zOp(f, d, (_w, x) => x)
    case 0x9:
      return zOp(f, d, (_w, x) => ~x)
    case 0xa:
      return zOp(f, d, (_w, x) => x + 1)
    case 0xb: // DECFSZ
      return (c) => {
        const a = c.addr(f)
        const r = (c.read(a) - 1) & 0xff
        dest(c, a, d, r, false)
        if (r === 0) skip(c)
      }
    case 0xc: // RRF
      return (c) => {
        const a = c.addr(f)
        const x = c.read(a)
        const r = (x >> 1) | ((c.status & STATUS_C) << 7)
        dest(c, a, d, r, true)
        c.status = (c.status & ~STATUS_C) | (x & 1)
      }
    case 0xd: // RLF
      return (c) => {
        const a = c.addr(f)
        const x = c.read(a)
        const r = ((x << 1) | (c.status & STATUS_C)) & 0xff
        dest(c, a, d, r, true)
        c.status = (c.status & ~STATUS_C) | (x >> 7)
      }
    case 0xe: // SWAPF
      return (c) => {
        const a = c.addr(f)
        const x = c.read(a)
        dest(c, a, d, ((x & 0x0f) << 4) | (x >> 4), false)
      }
    default: // 0xf INCFSZ
      return (c) => {
        const a = c.addr(f)
        const r = (c.read(a) + 1) & 0xff
        dest(c, a, d, r, false)
        if (r === 0) skip(c)
      }
  }
}

/** The fetched next instruction is discarded and a NOP runs instead: one more cycle. */
function skip(c: PicCpu) {
  c.pc = (c.pc + 1) & c.pcMask
  c.cycles++
}

/** 00 0000 0xxx xxxx: NOP, RETURN, RETFIE, OPTION, SLEEP, CLRWDT, TRIS; the rest reserved. */
function special(word: number): PicOp {
  switch (word) {
    case 0x0000:
    case 0x0020:
    case 0x0040:
    case 0x0060:
      return () => {}
    case 0x0008: // RETURN
      return (c) => {
        c.pc = c.pop() & c.pcMask
        c.cycles++
      }
    case 0x0009: // RETFIE
      return (c) => {
        c.pc = c.pop() & c.pcMask
        c.system.retfie()
        c.cycles++
      }
    case 0x0062:
      return (c) => c.system.option(c.w)
    case 0x0063:
      return (c) => c.enterSleep()
    case 0x0064:
      return (c) => {
        c.system.clrwdt()
        c.status |= 0x18
      }
    case 0x0065:
    case 0x0066:
    case 0x0067:
      return (c) => c.system.tris(word & 7, c.w)
    default:
      return (c) => c.system.reserved(word)
  }
}

function bitOp(word: number): PicOp {
  const b = (word >> 7) & 7
  const m = 1 << b
  const f = word & 0x7f
  switch ((word >> 10) & 3) {
    case 0: // BCF
      return (c) => {
        const a = c.addr(f)
        c.write(a, c.read(a) & ~m & 0xff, false)
      }
    case 1: // BSF
      return (c) => {
        const a = c.addr(f)
        c.write(a, c.read(a) | m, false)
      }
    case 2: // BTFSC
      return (c) => {
        if (!(c.read(c.addr(f)) & m)) skip(c)
      }
    default: // BTFSS
      return (c) => {
        if (c.read(c.addr(f)) & m) skip(c)
      }
  }
}

function literalOp(word: number): PicOp {
  const k = word & 0xff
  const op = (word >> 8) & 0x0f
  if (op < 4)
    return (c) => {
      c.w = k
    }
  if (op < 8)
    return (c) => {
      c.w = k
      c.pc = c.pop() & c.pcMask
      c.cycles++
    }
  switch (op) {
    case 0x8:
      return (c) => {
        c.w |= k
        c.status = (c.status & ~STATUS_Z) | ZERO(c.w)
      }
    case 0x9:
      return (c) => {
        c.w &= k
        c.status = (c.status & ~STATUS_Z) | ZERO(c.w)
      }
    case 0xa:
      return (c) => {
        c.w ^= k
        c.status = (c.status & ~STATUS_Z) | ZERO(c.w)
      }
    case 0xb:
      return (c) => c.system.reserved(word)
    case 0xc:
    case 0xd: // SUBLW: k − W
      return (c) => {
        c.w = sum(c, k, ~c.w & 0xff, 1)
      }
    default: // ADDLW
      return (c) => {
        c.w = sum(c, c.w, k, 0)
      }
  }
}

export function decode(word: number): PicOp {
  word &= 0x3fff
  switch (word >> 12) {
    case 0:
      return byteOp(word)
    case 1:
      return bitOp(word)
    case 2: {
      const k = word & 0x7ff
      if (word & 0x800)
        // GOTO: PC<10:0> from the opcode, PC<12:11> from PCLATH<4:3>.
        return (c) => {
          c.pc = (((c.pclath & 0x18) << 8) | k) & c.pcMask
          c.cycles++
        }
      return (c) => {
        c.push(c.pc)
        c.pc = (((c.pclath & 0x18) << 8) | k) & c.pcMask
        c.cycles++
      }
    }
    default:
      return literalOp(word)
  }
}
