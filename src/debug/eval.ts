/**
 * C expressions for the watch list and the editor's hovers, evaluated against the program's
 * DWARF and the memory at a stop: names (the frame's locals, then globals, enumerators,
 * functions, and — in a -g3 image — macros, so `GPIOA->ODR` reads the port), literals,
 * member access, indexing, the unary and binary operators with C's conversions, pointer
 * arithmetic, casts to the program's own types and `sizeof`. Calls and assignments are not
 * evaluated: a watch never changes the program.
 */
import { DW_ATE } from "./dwarf/consts"
import type { VariableInfo } from "./info"
import { strip, typeName, VOID, type DType } from "./types"
import { addressOf, isSignedEncoding, leBytes, partOrigin, Pending, scalarOf, Unreadable, valueBytes, variableValue, type Env, type Scalar, type Value } from "./values"

export { Pending, Unreadable }

type Tok = { k: "num"; text: string } | { k: "char"; value: number } | { k: "str"; value: string } | { k: "id"; text: string } | { k: "op"; text: string } | { k: "end" }

const OPS = ["<<=", ">>=", "->", "++", "--", "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "::", "+", "-", "*", "/", "%", "<", ">", "&", "|", "^", "!", "~", "?", ":", "(", ")", "[", "]", ".", ",", "="]

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const num = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[uUlLfF]*/.exec(src.slice(i))
    if (num && /[\d.]/.test(c) && !(c === "." && !/\d/.test(src[i + 1] ?? ""))) {
      out.push({ k: "num", text: num[0] })
      i += num[0].length
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))![0]
      out.push({ k: "id", text: id })
      i += id.length
      continue
    }
    if (c === "'") {
      const m = /^'(\\(?:x[0-9a-fA-F]+|[0-7]{1,3}|.)|[^'\\])'/.exec(src.slice(i))
      if (!m) throw new Unreadable("bad character literal")
      out.push({ k: "char", value: unescape(m[1]).charCodeAt(0) })
      i += m[0].length
      continue
    }
    if (c === '"') {
      const m = /^"((?:\\.|[^"\\])*)"/.exec(src.slice(i))
      if (!m) throw new Unreadable("bad string literal")
      out.push({ k: "str", value: unescape(m[1]) })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Unreadable(`unexpected '${c}'`)
    out.push({ k: "op", text: op })
    i += op.length
  }
  out.push({ k: "end" })
  return out
}

function unescape(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]+|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return ({ n: "\n", t: "\t", r: "\r", "0": "\0", a: "\x07", b: "\b", f: "\f", v: "\v" } as Record<string, string>)[e] ?? e
  })
}

// --- types the evaluator makes up ------------------------------------------------------------------

const base = (name: string, size: number, encoding: number): DType => ({ kind: "base", name, size, encoding })
const INT = base("int", 4, DW_ATE.signed)
const UINT = base("unsigned int", 4, DW_ATE.unsigned)
const LLONG = base("long long", 8, DW_ATE.signed)
const ULLONG = base("unsigned long long", 8, DW_ATE.unsigned)
const DOUBLE = base("double", 8, DW_ATE.float)
const FLOAT = base("float", 4, DW_ATE.float)
const CHAR = base("char", 1, DW_ATE.unsigned_char)
const BUILTIN: Record<string, DType> = {
  char: CHAR,
  "signed char": base("signed char", 1, DW_ATE.signed_char),
  "unsigned char": base("unsigned char", 1, DW_ATE.unsigned_char),
  short: base("short", 2, DW_ATE.signed),
  "short int": base("short", 2, DW_ATE.signed),
  "unsigned short": base("unsigned short", 2, DW_ATE.unsigned),
  "short unsigned int": base("unsigned short", 2, DW_ATE.unsigned),
  int: INT,
  signed: INT,
  "signed int": INT,
  unsigned: UINT,
  "unsigned int": UINT,
  long: base("long", 4, DW_ATE.signed),
  "long int": base("long", 4, DW_ATE.signed),
  "unsigned long": base("unsigned long", 4, DW_ATE.unsigned),
  "long unsigned int": base("unsigned long", 4, DW_ATE.unsigned),
  "long long": LLONG,
  "long long int": LLONG,
  "unsigned long long": ULLONG,
  "long long unsigned int": ULLONG,
  float: FLOAT,
  double: DOUBLE,
  "long double": DOUBLE,
  _Bool: base("_Bool", 1, DW_ATE.boolean),
  bool: base("bool", 1, DW_ATE.boolean),
  void: VOID,
}
const pointerTo = (t: DType): DType => ({ kind: "pointer", size: 4, target: t })

/** A computed value with no home in the target. */
function rvalue(type: DType, s: Scalar): Value {
  const size = Math.max(1, strip(type).size || 4)
  if (s.kind === "float") {
    const b = new Uint8Array(size)
    const view = new DataView(b.buffer)
    if (size === 8) view.setFloat64(0, s.value, true)
    else view.setFloat32(0, s.value, true)
    return { type, loc: { kind: "bytes", bytes: b } }
  }
  return { type, loc: { kind: "bytes", bytes: leBytes(s.kind === "pointer" ? BigInt(s.value >>> 0) : s.value, size) } }
}
const intValue = (v: bigint | number, type: DType = INT): Value => {
  const t = strip(type)
  const size = t.size || 4
  const signed = t.kind === "base" ? isSignedEncoding(t.encoding) : false
  const x = typeof v === "bigint" ? v : BigInt(Math.trunc(v))
  return rvalue(type, { kind: "int", value: signed ? BigInt.asIntN(size * 8, x) : BigInt.asUintN(size * 8, x), signed, size })
}

// --- the parser/evaluator ----------------------------------------------------------------------------

export type EvalScope = {
  /** The selected frame's variables, innermost first. */
  locals: VariableInfo[]
}

/** Evaluate an expression. Throws Pending (memory still to fetch) or Unreadable (with the reason). */
export function evaluateExpression(env: Env, scope: EvalScope, src: string): Value {
  const p = new Parser(env, scope, tokenize(src), new Set())
  const v = p.expression()
  p.expect("end")
  return v
}

class Parser {
  private i = 0
  private readonly env: Env
  private readonly scope: EvalScope
  private readonly toks: Tok[]
  /** Macros being expanded, so a self-referencing one stops. */
  private readonly expanding: Set<string>

  constructor(env: Env, scope: EvalScope, toks: Tok[], expanding: Set<string>) {
    this.env = env
    this.scope = scope
    this.toks = toks
    this.expanding = expanding
  }

  private peek(): Tok {
    return this.toks[this.i]
  }
  private isOp(text: string, at = this.i) {
    const t = this.toks[at]
    return t.k === "op" && t.text === text
  }
  private take(text: string) {
    if (this.isOp(text)) {
      this.i++
      return true
    }
    return false
  }
  expect(what: string) {
    if (what === "end") {
      if (this.peek().k !== "end") throw new Unreadable(`unexpected '${tokText(this.peek())}'`)
      return
    }
    if (!this.take(what)) throw new Unreadable(`expected '${what}'`)
  }

  expression(): Value {
    let v = this.ternary()
    while (this.take(",")) v = this.ternary()
    return v
  }

  private ternary(): Value {
    const cond = this.binary(0)
    if (!this.take("?")) return cond
    const a = this.expression()
    this.expect(":")
    const b = this.ternary()
    return truth(this.env, cond) ? a : b
  }

  private static readonly PREC: [string[], number][] = [
    [["||"], 1],
    [["&&"], 2],
    [["|"], 3],
    [["^"], 4],
    [["&"], 5],
    [["==", "!="], 6],
    [["<", ">", "<=", ">="], 7],
    [["<<", ">>"], 8],
    [["+", "-"], 9],
    [["*", "/", "%"], 10],
  ]

  private binary(min: number): Value {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      if (t.k !== "op") return left
      const entry = Parser.PREC.find(([ops]) => ops.includes(t.text))
      if (!entry || entry[1] <= min) return left
      this.i++
      const right = this.binary(entry[1])
      left = binaryOp(this.env, t.text, left, right)
    }
  }

  private unary(): Value {
    const t = this.peek()
    if (t.k === "op") {
      switch (t.text) {
        case "-":
        case "+":
        case "!":
        case "~": {
          this.i++
          return unaryOp(this.env, t.text, this.unary())
        }
        case "*": {
          this.i++
          return deref(this.env, this.unary())
        }
        case "&": {
          this.i++
          const v = this.unary()
          const a = addressOf(v)
          if (a === null) throw new Unreadable("not in memory: no address")
          return intValue(a, pointerTo(v.type))
        }
        case "(": {
          const cast = this.tryType(this.i + 1)
          if (cast && this.isOp(")", cast.end)) {
            this.i = cast.end + 1
            return castTo(this.env, cast.type, this.unary())
          }
        }
      }
    }
    if (t.k === "id" && t.text === "sizeof") {
      this.i++
      if (this.isOp("(")) {
        const ty = this.tryType(this.i + 1)
        if (ty && this.isOp(")", ty.end)) {
          this.i = ty.end + 1
          return intValue(strip(ty.type).size, UINT)
        }
      }
      return intValue(strip(this.unary().type).size, UINT)
    }
    return this.postfix()
  }

  private postfix(): Value {
    let v = this.primary()
    for (;;) {
      if (this.take("[")) {
        const index = this.expression()
        this.expect("]")
        v = deref(this.env, binaryOp(this.env, "+", v, index))
      } else if (this.take(".")) v = member(this.env, v, this.ident())
      else if (this.take("->")) v = member(this.env, deref(this.env, v), this.ident())
      else if (this.isOp("(")) throw new Unreadable("calling functions is not supported")
      else if (this.isOp("++") || this.isOp("--") || this.isOp("=")) throw new Unreadable("a watch cannot change the program")
      else return v
    }
  }

  private ident(): string {
    const t = this.peek()
    if (t.k !== "id") throw new Unreadable("expected a name")
    this.i++
    return t.text
  }

  private primary(): Value {
    const t = this.peek()
    switch (t.k) {
      case "num":
        this.i++
        return numberLiteral(t.text)
      case "char":
        this.i++
        return intValue(t.value, INT)
      case "str":
        throw new Unreadable("string literals have no address in the target")
      case "op":
        if (this.take("(")) {
          const v = this.expression()
          this.expect(")")
          return v
        }
        throw new Unreadable(`unexpected '${t.text}'`)
      case "id": {
        this.i++
        let name = t.text
        // A qualified C++ name: ns::Class::member.
        while (this.isOp("::") && this.toks[this.i + 1].k === "id") {
          this.i++
          name += `::${(this.toks[this.i++] as { text: string }).text}`
        }
        return this.name(name)
      }
      default:
        throw new Unreadable("the expression ends too soon")
    }
  }

  private name(name: string): Value {
    const env = this.env
    if (name.startsWith("$")) return register(env, name.slice(1))
    if (name === "true" || name === "false") return intValue(name === "true" ? 1 : 0, BUILTIN.bool)
    if (name === "NULL" || name === "nullptr") return intValue(0, pointerTo(VOID))
    const local = this.scope.locals.find((v) => v.name === name)
    if (local) return variableValue(env, local)
    // Inside a C++ method a member is named without `this->`.
    const self = this.scope.locals.find((v) => v.name === "this")
    if (self) {
      try {
        return member(env, deref(env, variableValue(env, self)), name)
      } catch (e) {
        if (e instanceof Pending) throw e
      }
    }
    const unit = env.frame?.fn?.die.unit
    const global = env.info.globalsNamed(name, unit)[0]
    if (global) return variableValue(env, global)
    const en = env.info.enumerator(name)
    if (en) return intValue(en.value, en.type)
    const fn = env.info.functions.find((f) => f.name === name)
    if (fn) return { type: { kind: "function", ret: VOID, params: [], varargs: false, size: 0 }, loc: { kind: "memory", addr: fn.low } }
    const macro = env.info.macros().get(name)
    if (macro && !this.expanding.has(name)) return this.expand(macro.name, macro.params, macro.body)
    const sym = env.info.symbols.find((s) => s.name === name && s.type === "object")
    if (sym) return { type: sym.size === 1 ? CHAR : sym.size === 2 ? BUILTIN["unsigned short"] : UINT, loc: { kind: "memory", addr: sym.value } }
    throw new Unreadable(`no symbol "${name}" in the current context`)
  }

  /** A macro, as the preprocessor would have it: its arguments substituted, its body evaluated. */
  private expand(name: string, params: string[] | null, body: string): Value {
    let text = body
    if (params) {
      this.expect("(")
      const args: string[] = []
      let depth = 0
      let cur: Tok[] = []
      for (;;) {
        const t = this.peek()
        if (t.k === "end") throw new Unreadable(`${name}: missing ')'`)
        this.i++
        if (t.k === "op" && t.text === "(") depth++
        if (t.k === "op" && t.text === ")") {
          if (depth === 0) break
          depth--
        }
        if (t.k === "op" && t.text === "," && depth === 0) {
          args.push(cur.map(tokText).join(" "))
          cur = []
          continue
        }
        cur.push(t)
      }
      if (cur.length || args.length) args.push(cur.map(tokText).join(" "))
      params.forEach((p, i) => (text = text.replace(new RegExp(`\\b${p}\\b`, "g"), `(${args[i] ?? ""})`)))
    }
    if (!text.trim()) throw new Unreadable(`${name} expands to nothing`)
    const sub = new Parser(this.env, this.scope, tokenize(text), new Set([...this.expanding, name]))
    const v = sub.expression()
    sub.expect("end")
    return v
  }

  /** A type name starting at token `at` (`unsigned int`, `GPIO_TypeDef *`, `struct x`), and where it ends. */
  private tryType(at: number): { type: DType; end: number } | null {
    let i = at
    const words: string[] = []
    let tag = ""
    const quals = new Set(["const", "volatile", "restrict"])
    const keywords = new Set(["unsigned", "signed", "short", "long", "int", "char", "float", "double", "void", "_Bool", "bool"])
    for (;;) {
      const t = this.toks[i]
      if (t.k !== "id") break
      if (quals.has(t.text)) {
        i++
        continue
      }
      if (t.text === "struct" || t.text === "union" || t.text === "enum" || t.text === "class") {
        tag = t.text
        i++
        continue
      }
      if (keywords.has(t.text)) {
        words.push(t.text)
        i++
        continue
      }
      if (words.length || tag) {
        if (tag && !words.length) {
          words.push(t.text)
          i++
        }
        break
      }
      // A typedef or a struct name the program declares.
      if (!this.env.info.typeNamed(t.text)) return null
      words.push(t.text)
      i++
      break
    }
    if (!words.length) return null
    let type: DType | null = null
    const spelled = words.join(" ")
    // Keywords only (`unsigned`, `long long int`): a built-in type, however it is spelled.
    if (!tag && words.every((w) => keywords.has(w))) type = BUILTIN[spelled] ?? BUILTIN[normalizeBuiltin(words)] ?? null
    if (!type) type = this.env.info.typeNamed(tag ? `${tag} ${spelled}` : spelled)
    if (!type) return null
    for (;;) {
      const t = this.toks[i]
      if (t.k === "op" && t.text === "*") {
        type = pointerTo(type)
        i++
      } else if (t.k === "id" && quals.has(t.text)) i++
      else break
    }
    return { type, end: i }
  }
}

function normalizeBuiltin(words: string[]): string {
  const w = words.filter((x) => x !== "int" || words.length === 1)
  const unsigned = w.includes("unsigned")
  const longs = w.filter((x) => x === "long").length
  const core = w.find((x) => x === "char" || x === "short" || x === "float" || x === "double" || x === "_Bool" || x === "bool" || x === "void")
  if (core === "char") return unsigned ? "unsigned char" : w.includes("signed") ? "signed char" : "char"
  if (core === "short") return unsigned ? "unsigned short" : "short"
  if (core) return longs && core === "double" ? "long double" : core
  if (longs >= 2) return unsigned ? "unsigned long long" : "long long"
  if (longs === 1) return unsigned ? "unsigned long" : "long"
  return unsigned ? "unsigned int" : "int"
}

function tokText(t: Tok): string {
  switch (t.k) {
    case "num":
    case "id":
    case "op":
      return t.text
    case "char":
      return String(t.value)
    case "str":
      return JSON.stringify(t.value)
    case "end":
      return ""
  }
}

function numberLiteral(text: string): Value {
  // In a hex literal f is a digit: only u and l can be suffixes there.
  const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([uUlLfF]*)$/.exec(text)
  if (!m) throw new Unreadable(`bad number "${text}"`)
  const body = m[1]
  const suffix = m[2].toLowerCase()
  if (/[.eE]/.test(body) && !/^0[xX]/.test(body)) return rvalue(suffix.includes("f") ? FLOAT : DOUBLE, { kind: "float", value: Number(body), size: suffix.includes("f") ? 4 : 8 })
  const value = /^0[bB]/.test(body) ? BigInt(`0b${body.slice(2)}`) : /^0[xX]/.test(body) ? BigInt(body) : /^0\d/.test(body) ? BigInt(`0o${body.slice(1)}`) : BigInt(body)
  const unsigned = suffix.includes("u") || (/^0/.test(body) && value > 0x7fffffffn && value <= 0xffffffffn)
  const long = (suffix.match(/l/g)?.length ?? 0) >= 2 || value > 0xffffffffn
  const type = long ? (unsigned ? ULLONG : LLONG) : unsigned || value > 0x7fffffffn ? UINT : INT
  return intValue(value, type)
}

const REGS = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11", "r12", "sp", "lr", "pc"]

function register(env: Env, name: string): Value {
  const r = env.frame?.regs.r ?? []
  const n = REGS.indexOf(name === "r13" ? "sp" : name === "r14" ? "lr" : name === "r15" ? "pc" : name)
  if (n >= 0) {
    const v = r[n]
    if (v === null || v === undefined) throw new Unreadable(`$${name} is not saved in this frame`)
    return intValue(v, n === 13 || n === 15 ? pointerTo(VOID) : UINT)
  }
  const s = env.frame?.regs.s
  const m = /^([sd])(\d+)$/.exec(name)
  if (m && s) {
    const k = Number(m[2])
    if (m[1] === "s" && k < 32) {
      const b = leBytes(BigInt(s[k] >>> 0), 4)
      return { type: FLOAT, loc: { kind: "bytes", bytes: b } }
    }
    if (m[1] === "d" && k < 16) {
      const b = new Uint8Array(8)
      b.set(leBytes(BigInt(s[k * 2] >>> 0), 4), 0)
      b.set(leBytes(BigInt(s[k * 2 + 1] >>> 0), 4), 4)
      return { type: DOUBLE, loc: { kind: "bytes", bytes: b } }
    }
  }
  throw new Unreadable(`no register $${name}`)
}

// --- operations -----------------------------------------------------------------------------------

function truth(env: Env, v: Value): boolean {
  const s = scalarOf(env, v)
  return s.kind === "int" ? s.value !== 0n : s.value !== 0
}

function member(env: Env, value: Value, name: string): Value {
  const t = strip(value.type)
  if (t.kind !== "struct") throw new Unreadable(`${typeName(value.type)} has no members`)
  // A struct in registers or in pieces (optimized code): its bytes, then the member of them.
  const v: Value = value.loc.kind === "memory" || value.loc.kind === "bytes" ? value : { type: value.type, loc: { kind: "bytes", bytes: valueBytes(env, value) }, origin: { value, offset: 0 } }
  const find = (s: DType & { kind: "struct" }, offset: number): Value | null => {
    for (const m of s.members) {
      if (m.name === name && !m.base) {
        const loc = v.loc.kind === "memory" ? { kind: "memory" as const, addr: (v.loc.addr + offset + m.offset) >>> 0 } : v.loc.kind === "bytes" ? { kind: "bytes" as const, bytes: v.loc.bytes.subarray(offset + m.offset) } : { kind: "unavailable" as const, why: "not in memory" }
        const out: Value = { type: m.type, loc }
        if (loc.kind === "bytes") out.origin = partOrigin(v, offset + m.offset)
        if (m.bitSize !== undefined) {
          out.bitSize = m.bitSize
          out.bitOffset = m.bitOffset ?? 0
        }
        return out
      }
    }
    // Members of base classes and of anonymous structs/unions.
    for (const m of s.members) {
      const mt = strip(m.type)
      if ((m.base || !m.name) && mt.kind === "struct") {
        const hit = find(mt, offset + m.offset)
        if (hit) return hit
      }
    }
    return null
  }
  const hit = find(t, 0)
  if (!hit) throw new Unreadable(`${typeName(v.type)} has no member "${name}"`)
  return hit
}

function deref(env: Env, v: Value): Value {
  const t = strip(v.type)
  if (t.kind === "array") {
    if (v.loc.kind === "memory") return { type: t.element, loc: v.loc }
    throw new Unreadable("an array not in memory")
  }
  const s = scalarOf(env, v)
  if (s.kind !== "pointer") throw new Unreadable(`${typeName(v.type)} is not a pointer`)
  if (strip(s.target).kind === "void") throw new Unreadable("a void pointer cannot be dereferenced")
  return { type: s.target, loc: { kind: "memory", addr: s.value } }
}

/** C's usual arithmetic conversions, far enough for a debugger: to double, else to the widest integer, unsigned if either is. */
function arith(a: Scalar, b: Scalar): { float: boolean; size: number; signed: boolean } {
  if (a.kind === "float" || b.kind === "float") return { float: true, size: 8, signed: true }
  const size = Math.max(a.kind === "int" ? a.size : 4, b.kind === "int" ? b.size : 4, 4)
  const signedA = a.kind === "int" ? a.signed || a.size < 4 : false
  const signedB = b.kind === "int" ? b.signed || b.size < 4 : false
  return { float: false, size, signed: signedA && signedB }
}

const asBig = (s: Scalar) => (s.kind === "int" ? s.value : s.kind === "pointer" ? BigInt(s.value >>> 0) : BigInt(Math.trunc(s.value)))
const asNum = (s: Scalar) => (s.kind === "float" ? s.value : Number(asBig(s)))

function binaryOp(env: Env, op: string, l: Value, r: Value): Value {
  if (op === "&&") return intValue(truth(env, l) && truth(env, r) ? 1 : 0)
  if (op === "||") return intValue(truth(env, l) || truth(env, r) ? 1 : 0)
  const a = scalarOf(env, l)
  const b = scalarOf(env, r)
  // Pointer arithmetic, in elements.
  if ((op === "+" || op === "-") && a.kind === "pointer" && b.kind === "int") {
    const size = Math.max(1, strip(a.target).size)
    const addr = Number(BigInt.asUintN(32, BigInt(a.value) + (op === "+" ? 1n : -1n) * b.value * BigInt(size)))
    return intValue(addr, pointerTo(a.target))
  }
  if (op === "+" && a.kind === "int" && b.kind === "pointer") return binaryOp(env, op, r, l)
  if (op === "-" && a.kind === "pointer" && b.kind === "pointer") return intValue((a.value - b.value) / Math.max(1, strip(a.target).size))
  const c = arith(a, b)
  const cmp = (x: boolean) => intValue(x ? 1 : 0)
  if (c.float) {
    const x = asNum(a)
    const y = asNum(b)
    switch (op) {
      case "+":
        return rvalue(DOUBLE, { kind: "float", value: x + y, size: 8 })
      case "-":
        return rvalue(DOUBLE, { kind: "float", value: x - y, size: 8 })
      case "*":
        return rvalue(DOUBLE, { kind: "float", value: x * y, size: 8 })
      case "/":
        return rvalue(DOUBLE, { kind: "float", value: x / y, size: 8 })
      case "<":
        return cmp(x < y)
      case ">":
        return cmp(x > y)
      case "<=":
        return cmp(x <= y)
      case ">=":
        return cmp(x >= y)
      case "==":
        return cmp(x === y)
      case "!=":
        return cmp(x !== y)
      default:
        throw new Unreadable(`'${op}' needs integer operands`)
    }
  }
  const bits = c.size * 8
  const norm = (v: bigint) => (c.signed ? BigInt.asIntN(bits, v) : BigInt.asUintN(bits, v))
  const x = norm(asBig(a))
  const y = norm(asBig(b))
  const type = c.size === 8 ? (c.signed ? LLONG : ULLONG) : c.signed ? INT : UINT
  const int = (v: bigint) => intValue(norm(v), type)
  switch (op) {
    case "+":
      return int(x + y)
    case "-":
      return int(x - y)
    case "*":
      return int(x * y)
    case "/":
      if (y === 0n) throw new Unreadable("division by zero")
      return int(x / y)
    case "%":
      if (y === 0n) throw new Unreadable("division by zero")
      return int(x % y)
    case "<<":
      return int(x << (y & 63n))
    case ">>":
      return int(x >> (y & 63n))
    case "&":
      return int(x & y)
    case "|":
      return int(x | y)
    case "^":
      return int(x ^ y)
    case "<":
      return cmp(x < y)
    case ">":
      return cmp(x > y)
    case "<=":
      return cmp(x <= y)
    case ">=":
      return cmp(x >= y)
    case "==":
      return cmp(x === y)
    case "!=":
      return cmp(x !== y)
  }
  throw new Unreadable(`unknown operator '${op}'`)
}

function unaryOp(env: Env, op: string, v: Value): Value {
  const s = scalarOf(env, v)
  if (op === "!") return intValue(truth(env, v) ? 0 : 1)
  if (s.kind === "float") {
    if (op === "~") throw new Unreadable("'~' needs an integer")
    return rvalue(v.type, { kind: "float", value: op === "-" ? -s.value : s.value, size: s.size })
  }
  const size = s.kind === "int" ? Math.max(4, s.size) : 4
  const signed = s.kind === "int" ? s.signed || s.size < 4 : false
  const type = size === 8 ? (signed ? LLONG : ULLONG) : signed ? INT : UINT
  const x = asBig(s)
  return intValue(op === "-" ? -x : op === "~" ? ~x : x, type)
}

/** A value converted to a scalar type as a C cast (and an assignment) converts it. */
export function castTo(env: Env, type: DType, v: Value): Value {
  const t = strip(type)
  if (t.kind === "struct" || t.kind === "array") throw new Unreadable(`cannot cast to ${typeName(type)}`)
  if (t.kind === "void") return { type, loc: { kind: "unavailable", why: "void" } }
  const s = scalarOf(env, v)
  if (t.kind === "base" && t.encoding === DW_ATE.float) return rvalue(type, { kind: "float", value: asNum(s), size: t.size })
  if (t.kind === "base" && t.encoding === DW_ATE.boolean) return intValue(truth(env, v) ? 1 : 0, type)
  const value = s.kind === "float" ? BigInt(Math.trunc(s.value)) : asBig(s)
  return intValue(value, type)
}
