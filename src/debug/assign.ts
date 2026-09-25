/**
 * Setting a value at a stop, as a debugger's `set var` does: the new value is a C expression in
 * the target's frame, converted to the target's type by C's rules for assignment, and stored
 * where the target lives: at its address, in a register of its frame (the core's own, or the
 * stack slot a callee saved it to and restores it from), in each piece of a value the compiler
 * split up. A value the program computes (a constant, an expression the compiler kept instead of
 * the variable) is stored nowhere and cannot be set.
 */
import { DW_ATE } from "./dwarf/consts"
import { regName, type Piece } from "./dwarf/expr"
import { castTo, evaluateExpression, tokenize, type EvalScope } from "./eval"
import type { DebugWrite } from "./protocol"
import { strip, typeName, VOID, type DType } from "./types"
import type { RegHome, StackFrame } from "./unwind"
import { isSignedEncoding, leBytes, scalarOf, valueBytes, type Env, type Scalar, type Value } from "./values"

/** Why a value cannot be set. */
export class Unwritable extends Error {}

const isCharType = (t: DType) => t.kind === "base" && t.size === 1 && (t.encoding === DW_ATE.signed_char || t.encoding === DW_ATE.unsigned_char)
const isCharArray = (t: DType) => t.kind === "array" && isCharType(strip(t.element))

/** Whether the views offer to set a value: a number, a pointer or a string, somewhere it can be stored. */
export function settable(v: Value): boolean {
  const t = strip(v.type)
  const kind = t.kind === "base" || t.kind === "enum" || t.kind === "pointer" || t.kind === "reference" || isCharArray(t)
  const loc = v.loc.kind
  return kind && (loc === "memory" || loc === "register" || loc === "pieces" || ((loc === "bytes" || loc === "value") && v.origin !== undefined))
}

/** The text to edit a value from: what the view shows, without the symbol, character or string beside a number. */
export function editText(shown: string): string {
  return shown.replace(/ <[^<>]*>$/, "").replace(/^(-?\d+) '(?:\\.|[^'])+'$/, "$1").replace(/^(0x[0-9a-f]+) ".*"$/, "$1")
}

/**
 * The writes that set `target` to `text`, a C expression evaluated in the target's frame. Throws
 * Unwritable with the reason, or Pending when memory it needs is not read yet.
 */
export function assignment(env: Env, scope: EvalScope, target: Value, text: string): DebugWrite[] {
  const t = strip(target.type)
  // A reference is set through: C++ assigns to what it refers to.
  if (t.kind === "reference") {
    const s = scalarOf(env, target)
    if (s.kind !== "pointer") throw new Unwritable("not a reference")
    return assignment(env, scope, { type: t.target, loc: { kind: "memory", addr: s.value } }, text)
  }
  return writesFor(env, target, newBytes(env, scope, target, text))
}

/** What the target's bytes become. */
function newBytes(env: Env, scope: EvalScope, target: Value, text: string): Uint8Array {
  const t = strip(target.type)
  if (isCharArray(t)) {
    // A string into a char array: its characters and the terminator where there is room, zeros after.
    const toks = tokenize(text)
    if (toks.length === 2 && toks[0].k === "str") {
      const s = toks[0].value
      if (s.length > t.size) throw new Unwritable(`${s.length} characters do not fit in ${typeName(target.type)}`)
      const out = new Uint8Array(t.size)
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i)
        if (c > 0xff) throw new Unwritable(`'${s[i]}' is not a one-byte character`)
        out[i] = c
      }
      return out
    }
  }
  const src = evaluateExpression(env, scope, text)
  if (target.bitSize !== undefined) {
    // A bit-field: the new bits into the bytes that hold it, the neighbours' bits as they are.
    const s = scalarOf(env, castTo(env, target.type, src))
    const bits = BigInt.asUintN(target.bitSize, s.kind === "int" ? s.value : BigInt(Math.trunc(s.value)))
    const out = valueBytes(env, target).slice()
    const from = target.bitOffset ?? 0
    for (let i = 0; i < target.bitSize; i++) {
      const at = from + i
      if ((bits >> BigInt(i)) & 1n) out[at >> 3] |= 1 << (at & 7)
      else out[at >> 3] &= ~(1 << (at & 7))
    }
    return out
  }
  switch (t.kind) {
    case "base":
    case "enum":
    case "pointer":
      return valueBytes(env, castTo(env, target.type, src), t.size)
    case "struct":
    case "array":
      // A whole struct or array from another of the same type, as C assigns structs.
      if (typeName(src.type) !== typeName(target.type) || strip(src.type).size !== t.size) throw new Unwritable(`cannot assign ${typeName(src.type)} to ${typeName(target.type)}`)
      return valueBytes(env, src, t.size)
    default:
      throw new Unwritable(`${typeName(target.type)} cannot be set`)
  }
}

/** How a register's bytes above a narrower value are filled: kept as they are, or extended as C extends it. */
type Fill = "keep" | "zero" | "sign"

function fillOf(target: Value): Fill {
  if (target.bitSize !== undefined) return "keep"
  const t = strip(target.type)
  if (t.kind === "base" && t.encoding !== DW_ATE.float) return isSignedEncoding(t.encoding) ? "sign" : "zero"
  if (t.kind === "enum") return t.signed ? "sign" : "zero"
  return t.kind === "void" ? "keep" : "zero"
}

/** The writes that store `bytes` where `target` lives. */
function writesFor(env: Env, target: Value, bytes: Uint8Array): DebugWrite[] {
  const loc = target.loc
  switch (loc.kind) {
    case "memory":
      return [{ kind: "memory", addr: loc.addr >>> 0, bytes }]
    case "register":
      return registerWrites(env.frame, loc.reg, bytes, fillOf(target))
    case "pieces":
      return pieceWrites(env, loc.pieces, bytes)
    case "bytes":
    case "value": {
      // A part of a value read out of registers: the whole value, with the part changed, back where it lives.
      const o = target.origin
      if (!o) throw new Unwritable(loc.kind === "value" ? "the program computes this value: it is stored nowhere" : "a constant: it is stored nowhere")
      const whole = valueBytes(env, o.value).slice()
      whole.set(bytes.subarray(0, Math.max(0, whole.length - o.offset)), o.offset)
      return writesFor(env, o.value, whole)
    }
    case "implicit-pointer":
      throw new Unwritable("the compiler replaced the pointer: it is stored nowhere")
    case "unavailable":
      throw new Unwritable(loc.why)
  }
}

/** Each piece gets its bits of the value; a piece that is part of a byte or a register keeps the rest. */
function pieceWrites(env: Env, pieces: Piece[], bytes: Uint8Array): DebugWrite[] {
  const out: DebugWrite[] = []
  let bit = 0
  for (const p of pieces) {
    if (!p.loc) throw new Unwritable("part of it is optimized out")
    const n = Math.max(1, Math.ceil((p.offsetBits + p.bits) / 8))
    const whole = p.offsetBits === 0 && p.bits % 8 === 0
    const cur = whole ? new Uint8Array(n) : valueBytes(env, { type: VOID, loc: p.loc }, n).slice()
    for (let i = 0; i < p.bits; i++) {
      const from = bit + i
      const to = p.offsetBits + i
      if ((bytes[from >> 3] >> (from & 7)) & 1) cur[to >> 3] |= 1 << (to & 7)
      else cur[to >> 3] &= ~(1 << (to & 7))
    }
    out.push(...writesFor(env, { type: VOID, loc: p.loc }, cur))
    bit += p.bits
  }
  return out
}

/** A DWARF register (r0–r15, s0–s31, d0–d15) of the frame, set to the bytes, a word per register. */
function registerWrites(frame: StackFrame | null, reg: number, bytes: Uint8Array, fill: Fill): DebugWrite[] {
  // The registers the bytes go into, as [r-or-s, number] a word each.
  const words = Math.max(1, Math.ceil(bytes.length / 4))
  const targets: { fp: boolean; n: number }[] = []
  if (reg < 16) for (let i = 0; i < words; i++) targets.push({ fp: false, n: reg + i })
  else if (reg >= 64 && reg < 96) for (let i = 0; i < words; i++) targets.push({ fp: true, n: reg - 64 + i })
  else if (reg >= 256 && reg < 272) for (let i = 0; i < words; i++) targets.push({ fp: true, n: (reg - 256) * 2 + i })
  else throw new Unwritable(`${regName(reg)} cannot be set`)
  const out: DebugWrite[] = []
  targets.forEach(({ fp, n }, i) => {
    if ((!fp && n > 15) || (fp && n > 31)) throw new Unwritable(`${regName(reg)} cannot hold ${bytes.length} bytes`)
    let value = 0
    const top = Math.min(4, bytes.length - i * 4)
    if (top < 4) {
      // A value narrower than the register: the rest kept, or extended as the compiler keeps it.
      const cur = fp ? (frame?.regs.s?.[n] ?? null) : (frame?.regs.r[n] ?? null)
      const negative = top > 0 && (bytes[i * 4 + top - 1] & 0x80) !== 0
      value = fill === "keep" ? (cur ?? 0) : fill === "sign" && negative ? 0xffffffff : 0
    }
    for (let k = 0; k < Math.max(0, top); k++) value = ((value & ~(0xff << (k * 8))) | (bytes[i * 4 + k] << (k * 8))) >>> 0
    out.push(...homeWrites(frame, n, fp, value >>> 0))
  })
  return out
}

/** A frame's register set: where the frame keeps it (the core's register, or a callee's save slot). */
function homeWrites(frame: StackFrame | null, n: number, fp: boolean, value: number): DebugWrite[] {
  const home: RegHome | null = frame ? (fp ? (frame.regs.sHome?.[n] ?? null) : frame.regs.rHome[n]) : { kind: "register", reg: n }
  const name = fp ? `s${n}` : regName(n)
  if (!home) throw new Unwritable(`${name} is not kept in this frame (#${frame?.index ?? 0}): the code it called did not save it`)
  // A caller's PC is a return address and keeps the Thumb bit a return needs; a PC proper has bit 0 clear.
  const v = home.thumb ? (value | 1) >>> 0 : !fp && n === 15 ? (value & ~1) >>> 0 : value
  if (home.kind === "memory") return [{ kind: "memory", addr: home.addr, bytes: leBytes(BigInt(v), 4) }]
  return [{ kind: "register", reg: fp ? `s${home.reg}` : regName(home.reg), value: v }]
}

const u32 = (s: Scalar): number => (s.kind === "pointer" ? s.value >>> 0 : s.kind === "float" ? Math.trunc(s.value) >>> 0 : Number(BigInt.asUintN(32, s.value)))
const f32bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0]
const CORE = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "sp", "lr", "pc"]

/**
 * The writes that set a register, named as the registers view names it, to `text` evaluated in
 * the selected frame. An FP register takes a float as its value and an integer as its bits.
 */
export function registerAssignment(env: Env, scope: EvalScope, name: string, text: string): DebugWrite[] {
  const reg = name.toLowerCase()
  const s = scalarOf(env, evaluateExpression(env, scope, text))
  const fp = /^s(\d{1,2})$/.exec(reg)
  if (fp) return homeWrites(env.frame, Number(fp[1]), true, s.kind === "float" ? f32bits(s.value) : u32(s))
  const n = CORE.indexOf(reg)
  if (n >= 0) return homeWrites(env.frame, n, false, u32(s))
  if (!["xpsr", "msp", "psp", "primask", "basepri", "faultmask", "control", "fpscr"].includes(reg)) throw new Unwritable(`${name} cannot be set`)
  return [{ kind: "register", reg, value: u32(s) }]
}
