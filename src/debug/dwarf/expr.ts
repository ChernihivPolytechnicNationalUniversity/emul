/**
 * DWARF expressions (DWARF 5 section 2.5–2.6): the stack machine that says where a variable
 * lives — at an address, in a register, spread over pieces of several — or what its value
 * is when it lives nowhere (`stack_value`, `implicit_value`). Arithmetic is on 32-bit
 * target addresses.
 */
import { DW_OP } from "./consts"
import { Reader } from "./reader"

export type ExprContext = {
  /** A register by its DWARF number (r0–r15 = 0–15, s0–s31 = 64–95, d0–d31 = 256–287); null when this frame does not know it. */
  reg(n: number): number | null
  /** `size` bytes (1, 2 or 4) at an address, little-endian; null when unreadable. */
  read(addr: number, size: number): number | null
  /** DW_AT_frame_base of the function, evaluated (for `fbreg`). */
  frameBase?(): number | null
  /** The frame's canonical frame address (for `call_frame_cfa`). */
  cfa?(): number | null
}

export type Piece = { loc: Loc | null; bits: number; offsetBits: number }
export type Loc =
  | { kind: "memory"; addr: number }
  | { kind: "register"; reg: number }
  /** A value computed from the program state; the variable itself is nowhere. */
  | { kind: "value"; value: number }
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "pieces"; pieces: Piece[] }
  | { kind: "implicit-pointer"; die: number; offset: number }
  | { kind: "unavailable"; why: string }

class Unavailable extends Error {}

/** Evaluate a location expression. `push` seeds the stack (a member's location starts from the object's address). */
export function evaluate(expr: Uint8Array, ctx: ExprContext, push?: number): Loc {
  try {
    return run(expr, ctx, push)
  } catch (e) {
    if (e instanceof Unavailable) return { kind: "unavailable", why: e.message }
    throw e
  }
}

/** Evaluate an expression for its value (a frame base, a DW_AT_data_member_location): the top of the stack. */
export function evaluateValue(expr: Uint8Array, ctx: ExprContext, push?: number): number | null {
  const loc = evaluate(expr, ctx, push)
  if (loc.kind === "memory") return loc.addr
  if (loc.kind === "value") return loc.value
  if (loc.kind === "register") return ctx.reg(loc.reg)
  return null
}

const u32 = (v: number) => v >>> 0
const s32 = (v: number) => v | 0

function run(expr: Uint8Array, ctx: ExprContext, push?: number): Loc {
  const r = new Reader(expr)
  const stack: number[] = push === undefined ? [] : [u32(push)]
  const pieces: Piece[] = []
  /** What the operations so far describe, before a piece closes it. */
  let current: Loc | null = null
  const pop = () => {
    if (!stack.length) throw new Unavailable("malformed location expression")
    return stack.pop()!
  }
  const need = (v: number | null, what: string) => {
    if (v === null) throw new Unavailable(what)
    return v
  }
  const reg = (n: number) => need(ctx.reg(n), `register ${regName(n)} is not known in this frame`)
  const deref = (addr: number, size: number) => need(ctx.read(addr, size), `memory at 0x${u32(addr).toString(16)} is not readable`)
  while (!r.done) {
    const op = r.u8()
    if (op >= DW_OP.lit0 && op <= DW_OP.lit31) {
      stack.push(op - DW_OP.lit0)
      continue
    }
    if (op >= DW_OP.reg0 && op <= DW_OP.reg31) {
      current = { kind: "register", reg: op - DW_OP.reg0 }
      continue
    }
    if (op >= DW_OP.breg0 && op <= DW_OP.breg31) {
      stack.push(u32(reg(op - DW_OP.breg0) + r.sleb()))
      continue
    }
    switch (op) {
      case DW_OP.addr:
        stack.push(r.u32())
        break
      case DW_OP.deref:
        stack.push(deref(pop(), 4))
        break
      case DW_OP.deref_size:
        stack.push(deref(pop(), r.u8()))
        break
      case DW_OP.const1u:
        stack.push(r.u8())
        break
      case DW_OP.const1s:
        stack.push(u32(r.i8()))
        break
      case DW_OP.const2u:
        stack.push(r.u16())
        break
      case DW_OP.const2s:
        stack.push(u32(r.i16()))
        break
      case DW_OP.const4u:
        stack.push(r.u32())
        break
      case DW_OP.const4s:
        stack.push(u32(r.i32()))
        break
      case DW_OP.const8u:
      case DW_OP.const8s:
        stack.push(u32(r.u32()))
        r.u32()
        break
      case DW_OP.constu:
        stack.push(u32(r.uleb()))
        break
      case DW_OP.consts:
        stack.push(u32(r.sleb()))
        break
      case DW_OP.dup:
        stack.push(stack[stack.length - 1] ?? pop())
        break
      case DW_OP.drop:
        pop()
        break
      case DW_OP.over:
        stack.push(need(stack[stack.length - 2] ?? null, "malformed location expression"))
        break
      case DW_OP.pick: {
        const i = r.u8()
        stack.push(need(stack[stack.length - 1 - i] ?? null, "malformed location expression"))
        break
      }
      case DW_OP.swap: {
        const a = pop()
        const b = pop()
        stack.push(a, b)
        break
      }
      case DW_OP.rot: {
        const a = pop()
        const b = pop()
        const c = pop()
        stack.push(a, c, b)
        break
      }
      case DW_OP.abs:
        stack.push(u32(Math.abs(s32(pop()))))
        break
      case DW_OP.and: {
        const b = pop()
        stack.push(u32(pop() & b))
        break
      }
      case DW_OP.div: {
        const b = s32(pop())
        const a = s32(pop())
        if (b === 0) throw new Unavailable("division by zero in a location expression")
        stack.push(u32(Math.trunc(a / b)))
        break
      }
      case DW_OP.minus: {
        const b = pop()
        stack.push(u32(pop() - b))
        break
      }
      case DW_OP.mod: {
        const b = pop()
        const a = pop()
        if (b === 0) throw new Unavailable("division by zero in a location expression")
        stack.push(u32(a % b))
        break
      }
      case DW_OP.mul: {
        const b = pop()
        stack.push(u32(Math.imul(pop(), b)))
        break
      }
      case DW_OP.neg:
        stack.push(u32(-s32(pop())))
        break
      case DW_OP.not:
        stack.push(u32(~pop()))
        break
      case DW_OP.or: {
        const b = pop()
        stack.push(u32(pop() | b))
        break
      }
      case DW_OP.plus: {
        const b = pop()
        stack.push(u32(pop() + b))
        break
      }
      case DW_OP.plus_uconst:
        stack.push(u32(pop() + r.uleb()))
        break
      case DW_OP.shl: {
        const b = pop()
        stack.push(b >= 32 ? 0 : u32(pop() << b))
        break
      }
      case DW_OP.shr: {
        const b = pop()
        stack.push(b >= 32 ? 0 : pop() >>> b)
        break
      }
      case DW_OP.shra: {
        const b = pop()
        stack.push(u32(s32(pop()) >> Math.min(31, b)))
        break
      }
      case DW_OP.xor: {
        const b = pop()
        stack.push(u32(pop() ^ b))
        break
      }
      case DW_OP.eq:
      case DW_OP.ge:
      case DW_OP.gt:
      case DW_OP.le:
      case DW_OP.lt:
      case DW_OP.ne: {
        const b = s32(pop())
        const a = s32(pop())
        const t = op === DW_OP.eq ? a === b : op === DW_OP.ge ? a >= b : op === DW_OP.gt ? a > b : op === DW_OP.le ? a <= b : op === DW_OP.lt ? a < b : a !== b
        stack.push(t ? 1 : 0)
        break
      }
      case DW_OP.skip: {
        const off = r.i16()
        r.pos += off
        break
      }
      case DW_OP.bra: {
        const off = r.i16()
        if (pop() !== 0) r.pos += off
        break
      }
      case DW_OP.regx:
        current = { kind: "register", reg: r.uleb() }
        break
      case DW_OP.fbreg: {
        const base = need(ctx.frameBase?.() ?? null, "the frame base is not known")
        stack.push(u32(base + r.sleb()))
        break
      }
      case DW_OP.bregx: {
        const n = r.uleb()
        stack.push(u32(reg(n) + r.sleb()))
        break
      }
      case DW_OP.call_frame_cfa:
        stack.push(need(ctx.cfa?.() ?? null, "the frame address is not known"))
        break
      case DW_OP.nop:
        break
      case DW_OP.stack_value:
        current = { kind: "value", value: pop() }
        break
      case DW_OP.implicit_value:
        current = { kind: "bytes", bytes: r.take(r.uleb()) }
        break
      case DW_OP.implicit_pointer:
      case DW_OP.GNU_implicit_pointer: {
        const die = r.u32()
        current = { kind: "implicit-pointer", die, offset: r.sleb() }
        break
      }
      case DW_OP.piece: {
        const bytes = r.uleb()
        pieces.push({ loc: current ?? (stack.length ? { kind: "memory", addr: pop() } : null), bits: bytes * 8, offsetBits: 0 })
        current = null
        stack.length = 0
        break
      }
      case DW_OP.bit_piece: {
        const bits = r.uleb()
        const offsetBits = r.uleb()
        pieces.push({ loc: current ?? (stack.length ? { kind: "memory", addr: pop() } : null), bits, offsetBits })
        current = null
        stack.length = 0
        break
      }
      case DW_OP.entry_value:
      case DW_OP.GNU_entry_value:
        // The value a register had when the function was entered: only the caller's call site knows it.
        throw new Unavailable("optimized out (entry value)")
      case DW_OP.GNU_parameter_ref:
        throw new Unavailable("optimized out (parameter reference)")
      case DW_OP.GNU_uninit:
        break
      case DW_OP.convert:
      case DW_OP.GNU_convert:
      case DW_OP.reinterpret:
      case DW_OP.GNU_reinterpret:
        r.uleb()
        break
      case DW_OP.const_type:
      case DW_OP.GNU_const_type: {
        r.uleb()
        const n = r.u8()
        const bytes = r.take(n)
        stack.push(n >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) : bytes.reduce((v, b, i) => v | (b << (8 * i)), 0))
        break
      }
      case DW_OP.regval_type:
      case DW_OP.GNU_regval_type: {
        const n = r.uleb()
        r.uleb()
        stack.push(reg(n))
        break
      }
      case DW_OP.deref_type:
      case DW_OP.GNU_deref_type: {
        const size = r.u8()
        r.uleb()
        stack.push(deref(pop(), Math.min(4, size)))
        break
      }
      case DW_OP.addrx:
      case DW_OP.constx:
      case DW_OP.GNU_addr_index:
      case DW_OP.GNU_const_index:
        throw new Unavailable("indexed address in a location expression")
      default:
        throw new Unavailable(`location expression operator 0x${op.toString(16)} is not supported`)
    }
  }
  if (pieces.length) return { kind: "pieces", pieces }
  if (current) return current
  if (stack.length) return { kind: "memory", addr: stack[stack.length - 1] }
  return { kind: "unavailable", why: "optimized out" }
}

/** The name of a DWARF register number on ARM. */
export function regName(n: number): string {
  if (n < 13) return `r${n}`
  if (n === 13) return "sp"
  if (n === 14) return "lr"
  if (n === 15) return "pc"
  if (n >= 64 && n < 96) return `s${n - 64}`
  if (n >= 256 && n < 288) return `d${n - 256}`
  return `reg${n}`
}
