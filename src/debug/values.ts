/**
 * Values in the target: where one lives (a location from its DWARF expression), its bytes,
 * the number they make for its type, and how the variables view and the hovers show it —
 * `{x = 1, y = -2}` for a struct, `0x20000010 <first>` for a pointer, `"hello"` for a
 * char array — and its children when it is expanded.
 */
import { DW_ATE } from "./dwarf/consts"
import { evaluate, evaluateValue, type ExprContext, type Loc } from "./dwarf/expr"
import { locationAt } from "./dwarf/lists"
import type { DebugInfo, VariableInfo } from "./info"
import type { MemorySnapshot } from "./memory"
import { strip, typeName, VOID, type DType, type Member } from "./types"
import type { StackFrame } from "./unwind"
import { symbolAt } from "@/mcu/elf"

export type Value = {
  type: DType
  loc: Loc
  /** A bit-field: its width and the offset of its lowest bit in the bytes at the location. */
  bitSize?: number
  bitOffset?: number
}

/** What reading needs: the memory as held, and the registers of the frame the value belongs to. */
export type Env = {
  info: DebugInfo
  mem: MemorySnapshot
  frame: StackFrame | null
}

/** A read that has to wait for memory the UI does not hold yet (the session fetches it). */
export class Pending extends Error {
  constructor() {
    super("pending")
  }
}
/** Something that cannot be shown: optimized out, unreadable memory, an expression error. */
export class Unreadable extends Error {}

export type Scalar =
  | { kind: "int"; value: bigint; signed: boolean; size: number }
  | { kind: "float"; value: number; size: number }
  | { kind: "pointer"; value: number; target: DType }

const u32 = (v: number) => v >>> 0

/** The registers of a frame as a DWARF expression context. */
export function frameContext(env: Env, frame: StackFrame | null = env.frame): ExprContext {
  const r = frame?.regs.r ?? []
  const s = frame?.regs.s ?? null
  const reg = (n: number): number | null => {
    if (n < 16) return r[n] ?? null
    if (n >= 64 && n < 96) return s ? s[n - 64] : null
    if (n >= 256 && n < 272) return s ? s[(n - 256) * 2] : null
    return null
  }
  const cfa = () => frame?.cfa ?? null
  const base: ExprContext = { reg, read: (a, size) => env.mem.read(a, size), cfa }
  return {
    ...base,
    frameBase: () => {
      const fb = frame?.fn?.frameBase
      const expr = fb ? locationAt(fb, frame!.lookup) : null
      return expr ? evaluateValue(expr, base) : null
    },
  }
}

/** Where a variable is, at the frame's PC. */
export function variableValue(env: Env, v: VariableInfo, frame: StackFrame | null = env.frame): Value {
  if (v.constValue !== undefined) {
    const size = Math.max(1, v.type.size)
    const bytes = v.constValue instanceof Uint8Array ? v.constValue : leBytes(BigInt(Math.trunc(v.constValue)), size)
    return { type: v.type, loc: { kind: "bytes", bytes } }
  }
  const pc = frame?.lookup ?? 0
  const expr = locationAt(v.location, pc)
  if (!expr) return { type: v.type, loc: { kind: "unavailable", why: "optimized out" } }
  return { type: v.type, loc: evaluate(expr, frameContext(env, frame)) }
}

/** The bytes of a value; throws Pending while the memory is not held, Unreadable when it cannot be had. */
export function valueBytes(env: Env, v: Value, size = byteSize(v)): Uint8Array {
  const loc = v.loc
  switch (loc.kind) {
    case "memory": {
      const b = env.mem.bytes(loc.addr, size)
      if (b) return b
      if (env.mem.unmapped(loc.addr, size)) throw new Unreadable(`cannot access memory at 0x${u32(loc.addr).toString(16)}`)
      throw new Pending()
    }
    case "register":
      return registerBytes(env, loc.reg, size)
    case "value":
      return leBytes(BigInt(u32(loc.value)), size)
    case "bytes": {
      if (loc.bytes.length >= size) return loc.bytes.subarray(0, size)
      const out = new Uint8Array(size)
      out.set(loc.bytes)
      return out
    }
    case "pieces": {
      const out = new Uint8Array(Math.max(size, Math.ceil(loc.pieces.reduce((n, p) => n + p.bits, 0) / 8)))
      let bit = 0
      for (const p of loc.pieces) {
        if (!p.loc) throw new Unreadable("optimized out")
        const n = Math.ceil((p.bits + p.offsetBits) / 8)
        const part = valueBytes(env, { type: VOID, loc: p.loc }, Math.max(n, 1))
        for (let i = 0; i < p.bits; i++) {
          const src = p.offsetBits + i
          const b = (part[src >> 3] >> (src & 7)) & 1
          const dst = bit + i
          if (b) out[dst >> 3] |= 1 << (dst & 7)
        }
        bit += p.bits
      }
      return out.subarray(0, size)
    }
    case "implicit-pointer":
      throw new Unreadable("implicit pointer")
    case "unavailable":
      throw new Unreadable(loc.why)
  }
}

function registerBytes(env: Env, reg: number, size: number): Uint8Array {
  const ctx = frameContext(env)
  const out = new Uint8Array(Math.max(size, 4))
  const put = (at: number, v: number | null) => {
    if (v === null) throw new Unreadable(`not saved in this frame`)
    out[at] = v & 0xff
    out[at + 1] = (v >>> 8) & 0xff
    out[at + 2] = (v >>> 16) & 0xff
    out[at + 3] = (v >>> 24) & 0xff
  }
  if (reg >= 256 && reg < 272) {
    // d0–d15 overlay s0–s31 in pairs.
    const k = reg - 256
    put(0, ctx.reg(64 + k * 2))
    if (size > 4) put(4, ctx.reg(64 + k * 2 + 1))
  } else {
    put(0, ctx.reg(reg))
    // A value wider than the register continues in the next one (r0:r1 for a 64-bit integer).
    for (let at = 4, n = reg + 1; at < size && n < 16; at += 4, n++) put(at, ctx.reg(n))
  }
  return out.subarray(0, size)
}

function byteSize(v: Value): number {
  if (v.bitSize !== undefined) return Math.ceil(((v.bitOffset ?? 0) + v.bitSize) / 8)
  return Math.max(0, strip(v.type).size)
}

export function leBytes(v: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = BigInt.asUintN(size * 8, v)
  for (let i = 0; i < size; i++) {
    out[i] = Number(x & 0xffn)
    x >>= 8n
  }
  return out
}

function leValue(b: Uint8Array): bigint {
  let v = 0n
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i])
  return v
}

export const isSignedEncoding = (e: number) => e === DW_ATE.signed || e === DW_ATE.signed_char

/** The number a value makes for its type: integers (enums, bools, chars, bit-fields), floats and pointers. */
export function scalarOf(env: Env, v: Value): Scalar {
  const t = strip(v.type)
  if (v.bitSize !== undefined) {
    const raw = leValue(valueBytes(env, v)) >> BigInt(v.bitOffset ?? 0)
    const signed = t.kind === "base" ? isSignedEncoding(t.encoding) : t.kind === "enum" && t.signed
    const bits = BigInt.asUintN(v.bitSize, raw)
    return { kind: "int", value: signed ? BigInt.asIntN(v.bitSize, bits) : bits, signed, size: t.size || 4 }
  }
  switch (t.kind) {
    case "base": {
      const b = valueBytes(env, v)
      if (t.encoding === DW_ATE.float) {
        const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
        return { kind: "float", value: t.size === 8 ? view.getFloat64(0, true) : t.size === 4 ? view.getFloat32(0, true) : NaN, size: t.size }
      }
      const raw = leValue(b)
      const signed = isSignedEncoding(t.encoding)
      return { kind: "int", value: signed ? BigInt.asIntN(t.size * 8, raw) : raw, signed, size: t.size }
    }
    case "enum": {
      const raw = leValue(valueBytes(env, v))
      return { kind: "int", value: t.signed ? BigInt.asIntN(t.size * 8, raw) : raw, signed: t.signed, size: t.size }
    }
    case "pointer":
    case "reference":
      return { kind: "pointer", value: Number(leValue(valueBytes(env, v, 4)) & 0xffffffffn), target: t.target }
    case "array":
      // An array decays to the address of its first element.
      if (v.loc.kind === "memory") return { kind: "pointer", value: u32(v.loc.addr), target: t.element }
      throw new Unreadable("an array not in memory has no address")
    case "function":
      if (v.loc.kind === "memory") return { kind: "pointer", value: u32(v.loc.addr), target: t }
      throw new Unreadable("not a function address")
    default:
      throw new Unreadable(`${typeName(v.type)} is not a number`)
  }
}

// --- display --------------------------------------------------------------------------------------

export type Radix = "dec" | "hex"
export type Shown = { text: string; /** The value could not be read: shown dimmed, with the reason. */ error?: boolean; pending?: boolean; expandable: boolean }

/** The text for a value; never throws. */
export function show(env: Env, v: Value, radix: Radix = "dec"): Shown {
  const expandable = hasChildren(v)
  try {
    return { text: format(env, v, radix, 0), expandable }
  } catch (e) {
    if (e instanceof Pending) return { text: "…", pending: true, expandable }
    return { text: `<${(e as Error).message}>`, error: true, expandable: false }
  }
}

/** The shortest decimal that reads back as the same float (or double): 0.1f shows as 0.1. */
const floatText = (x: number, size: number) => {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf"
  if (size !== 4) return String(x)
  for (let p = 1; p < 9; p++) {
    const y = Number(x.toPrecision(p))
    if (Math.fround(y) === x) return String(y)
  }
  return String(Number(x.toPrecision(9)))
}

export function intText(value: bigint, radix: Radix, signed: boolean, size: number): string {
  if (radix === "hex") return `0x${BigInt.asUintN(size * 8, value).toString(16)}`
  return (signed ? value : BigInt.asUintN(size * 8, value)).toString()
}

const CHAR_ESCAPES: Record<number, string> = { 0: "\\0", 7: "\\a", 8: "\\b", 9: "\\t", 10: "\\n", 11: "\\v", 12: "\\f", 13: "\\r", 34: '\\"', 39: "\\'", 92: "\\\\" }
const charText = (c: number) => CHAR_ESCAPES[c] ?? (c >= 32 && c < 127 ? String.fromCharCode(c) : `\\${c.toString(8).padStart(3, "0")}`)

/** A pointer's target as the symbol it is in: `<first>`, `<buf+4>`, `<main+12>`. */
export function symbolText(env: Env, addr: number): string {
  if (addr === 0) return ""
  const s = symbolAt(env.info.symbols, addr)
  if (!s || s.symbol.type === "other") return ""
  if (s.offset !== 0 && s.symbol.size && s.offset >= s.symbol.size) return ""
  return ` <${s.symbol.name}${s.offset ? `+${s.offset}` : ""}>`
}

const isCharType = (t: DType) => t.kind === "base" && t.size === 1 && (t.encoding === DW_ATE.signed_char || t.encoding === DW_ATE.unsigned_char)

function format(env: Env, v: Value, radix: Radix, depth: number): string {
  const t = strip(v.type)
  switch (t.kind) {
    case "base": {
      const s = scalarOf(env, v)
      if (s.kind === "float") return floatText(s.value, s.size)
      if (s.kind !== "int") return String(s.value)
      if (t.encoding === DW_ATE.boolean) return s.value ? "true" : "false"
      if (isCharType(t)) return `${intText(s.value, radix, s.signed, 1)} '${charText(Number(BigInt.asUintN(8, s.value)))}'`
      return intText(s.value, radix, s.signed, s.size)
    }
    case "enum": {
      const s = scalarOf(env, v)
      if (s.kind !== "int") return String(s.value)
      const n = Number(s.value)
      const hit = t.values.find((e) => e.value === n)
      if (hit) return hit.name
      // A combination of flags, or a value outside the enumeration.
      let rest = n
      const parts: string[] = []
      for (const e of t.values) if (e.value && (rest & e.value) === e.value && e.value > 0 && (e.value & (e.value - 1)) === 0) {
        parts.push(e.name)
        rest &= ~e.value
      }
      return parts.length && rest === 0 ? parts.join(" | ") : `(${typeName(v.type)}) ${intText(s.value, radix, s.signed, s.size)}`
    }
    case "pointer":
    case "reference": {
      const s = scalarOf(env, v) as Scalar & { kind: "pointer" }
      const addr = s.value
      const target = strip(t.target)
      const hex = `0x${addr.toString(16).padStart(8, "0")}`
      if (addr === 0) return t.kind === "reference" ? `@${hex}` : "0x0"
      if (isCharType(target)) {
        const str = safeString(env, addr)
        return str === null ? hex : `${hex} ${str}`
      }
      // A function pointer carries the Thumb bit; the function is at the even address.
      if (target.kind === "function") return `${hex}${symbolText(env, addr & ~1)}`
      return `${hex}${symbolText(env, addr)}`
    }
    case "array": {
      if (isCharType(strip(t.element)) && t.dims.length === 1) {
        const n = t.dims[0] < 0 ? 64 : t.dims[0]
        const b = valueBytes(env, v, n)
        let end = b.indexOf(0)
        if (end < 0) end = b.length
        return `"${[...b.subarray(0, end)].map(charText).join("")}"`
      }
      if (depth > 1) return "{…}"
      const kids = children(env, v, 0, 8)
      const text = kids.map((k) => format(env, k.value, radix, depth + 1))
      return `{${text.join(", ")}${arrayLength(t) > kids.length ? ", …" : ""}}`
    }
    case "struct": {
      if (depth > 1) return "{…}"
      const kids = children(env, v, 0, 6)
      const parts = kids.map((k) => `${k.name} = ${format(env, k.value, radix, depth + 1)}`)
      return `{${parts.join(", ")}${t.members.length > kids.length ? ", …" : ""}}`
    }
    case "function":
      return v.loc.kind === "memory" ? `{${typeName(t)}} 0x${u32(v.loc.addr).toString(16)}${symbolText(env, v.loc.addr)}` : `{${typeName(t)}}`
    case "void":
      return "void"
    default:
      return `<${typeName(v.type)}>`
  }
}

/** A C string at an address, quoted, or null when its first byte is not readable yet. */
function safeString(env: Env, addr: number): string | null {
  const s = env.mem.cString(addr, 200)
  if (!s) {
    // Ask for it; the next evaluation has it.
    env.mem.bytes(addr, 1)
    return null
  }
  return `"${[...new TextEncoder().encode(s.text)].map(charText).join("")}${s.truncated ? "…" : ""}"`
}

// --- children --------------------------------------------------------------------------------------

export type Child = { name: string; value: Value; /** A pointer's target, shown as `*p`. */ deref?: boolean }

const arrayLength = (t: DType & { kind: "array" }) => (t.dims[0] < 0 ? 0 : t.dims[0])

export function hasChildren(v: Value): boolean {
  const t = strip(v.type)
  if (t.kind === "struct") return t.members.length > 0
  if (t.kind === "array") return arrayLength(t) > 0
  if (t.kind === "pointer" || t.kind === "reference") {
    const target = strip(t.target)
    return target.kind !== "void" && target.kind !== "function" && !isCharType(target) && target.size > 0
  }
  return false
}

/** How many children a value has, for paging long arrays. */
export function childCount(v: Value): number {
  const t = strip(v.type)
  if (t.kind === "struct") return t.members.length
  if (t.kind === "array") return arrayLength(t)
  if (t.kind === "pointer" || t.kind === "reference") {
    const target = strip(t.target)
    return target.kind === "struct" ? target.members.length : hasChildren(v) ? 1 : 0
  }
  return 0
}

/** A part of a value at a byte offset, wherever the value lives. */
function part(v: Value, type: DType, offset: number, m?: Member): Value {
  const loc = v.loc
  let at: Loc
  switch (loc.kind) {
    case "memory":
      at = { kind: "memory", addr: u32(loc.addr + offset) }
      break
    case "bytes":
      at = { kind: "bytes", bytes: loc.bytes.subarray(offset) }
      break
    default:
      // A value in registers or in pieces: its bytes, then the part of them.
      at = { kind: "unavailable", why: "part of a value not in memory" }
  }
  const out: Value = { type, loc: at }
  if (m?.bitSize !== undefined) {
    out.bitSize = m.bitSize
    out.bitOffset = m.bitOffset ?? 0
  }
  return out
}

/** The value's children from `start`, at most `max`: members, elements, or what a pointer points to. */
export function children(env: Env, v: Value, start = 0, max = 100): Child[] {
  let base = v
  let t = strip(v.type)
  // A value outside memory is split up from its bytes.
  if (v.loc.kind !== "memory" && v.loc.kind !== "bytes" && (t.kind === "struct" || t.kind === "array")) {
    try {
      base = { type: v.type, loc: { kind: "bytes", bytes: valueBytes(env, v) } }
    } catch {
      base = v
    }
  }
  if (t.kind === "pointer" || t.kind === "reference") {
    const s = scalarOf(env, v)
    if (s.kind !== "pointer") return []
    const target: Value = { type: t.target, loc: { kind: "memory", addr: s.value } }
    const tt = strip(t.target)
    if (tt.kind === "struct") {
      base = target
      t = tt
    } else return start === 0 && hasChildren(v) ? [{ name: "*", value: target, deref: true }] : []
  }
  if (t.kind === "struct") {
    return t.members.slice(start, start + max).map((m) => ({ name: m.base ? `<${m.name}>` : m.name || "<anonymous>", value: part(base, m.type, m.offset, m) }))
  }
  if (t.kind === "array") {
    const n = arrayLength(t)
    // A multi-dimensional array: its children are arrays of the remaining dimensions.
    const rest = t.dims.slice(1)
    const elemType: DType = rest.length ? { kind: "array", element: t.element, dims: rest, size: rest.reduce((p, d) => p * Math.max(0, d), 1) * t.element.size } : t.element
    const size = elemType.size
    const out: Child[] = []
    for (let i = start; i < Math.min(n, start + max); i++) out.push({ name: `[${i}]`, value: part(base, elemType, i * size) })
    return out
  }
  return []
}

/** The address of a value in memory, for `&x` and the memory view's "go to". */
export function addressOf(v: Value): number | null {
  return v.loc.kind === "memory" ? u32(v.loc.addr) : null
}
