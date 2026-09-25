/**
 * C and C++ types as the debugger needs them, built from the DWARF type entries on first
 * use. Every type is cached by the offset of its entry before its parts are resolved, so a
 * struct that points to itself resolves to itself.
 */
import { DW_AT, DW_ATE, DW_TAG } from "./dwarf/consts"
import { blockOf, numOf, refOf, strOf, type Die } from "./dwarf/info"
import { evaluateValue } from "./dwarf/expr"

export type Member = {
  name: string
  type: DType
  /** Byte offset in the object. */
  offset: number
  /** Bit-fields: width, and the offset of the lowest bit counted from bit 0 of the byte at `offset`. */
  bitSize?: number
  bitOffset?: number
  /** A base class subobject (C++ inheritance), shown as its own child. */
  base?: boolean
}

export type DType =
  | { kind: "void"; name: string; size: 0 }
  | { kind: "base"; name: string; size: number; encoding: number }
  | { kind: "pointer"; name?: string; size: number; target: DType }
  | { kind: "reference"; name?: string; size: number; target: DType; rvalue: boolean }
  | { kind: "struct"; name: string; tag: "struct" | "union" | "class"; size: number; members: Member[]; declaration: boolean }
  | { kind: "array"; name?: string; element: DType; /** Element counts per dimension; −1 when unknown (a flexible array). */ dims: number[]; size: number }
  | { kind: "enum"; name: string; size: number; values: { name: string; value: number }[]; signed: boolean }
  | { kind: "typedef"; name: string; target: DType; size: number }
  | { kind: "qualified"; qualifier: "const" | "volatile" | "restrict" | "atomic"; target: DType; size: number }
  | { kind: "function"; name?: string; ret: DType; params: DType[]; varargs: boolean; size: 0 }
  | { kind: "unknown"; name: string; size: number }

export const VOID: DType = { kind: "void", name: "void", size: 0 }
const UNKNOWN = (name: string, size = 0): DType => ({ kind: "unknown", name, size })

/** Typedefs and qualifiers peeled off: the type that decides how a value reads. */
export function strip(t: DType): DType {
  let x = t
  for (let i = 0; i < 64 && (x.kind === "typedef" || x.kind === "qualified"); i++) x = x.target
  return x
}

/** The name a C programmer would write for a type. */
export function typeName(t: DType): string {
  switch (t.kind) {
    case "void":
    case "base":
    case "typedef":
    case "unknown":
      return t.name
    case "struct":
      return t.name ? (t.tag === "class" ? t.name : `${t.tag} ${t.name}`) : `${t.tag} {…}`
    case "enum":
      return t.name ? `enum ${t.name}` : "enum {…}"
    case "qualified": {
      const target = t.target
      if (target.kind === "pointer") return `${typeName(target)} ${t.qualifier}`
      // A const array is an array of const elements, which DWARF often says twice.
      if (target.kind === "array") {
        const el = target.element
        const same = el.kind === "qualified" && el.qualifier === t.qualifier
        return typeName(same ? target : { ...target, element: { kind: "qualified", qualifier: t.qualifier, target: el, size: el.size } })
      }
      return `${t.qualifier} ${typeName(target)}`
    }
    case "pointer": {
      const target = t.target
      if (target.kind === "function") return `${typeName(target.ret)} (*)(${target.params.map(typeName).join(", ")}${target.varargs ? ", ..." : ""})`
      return `${typeName(target)} *`.replace(/\* \*/g, "**")
    }
    case "reference":
      return `${typeName(t.target)} ${t.rvalue ? "&&" : "&"}`
    case "array":
      return `${typeName(t.element)} ${t.dims.map((d) => `[${d < 0 ? "" : d}]`).join("")}`
    case "function":
      return `${typeName(t.ret)} (${t.params.map(typeName).join(", ")}${t.varargs ? ", ..." : ""})`
  }
}

/** Resolves type entries into `DType`s, once each. */
export class TypeResolver {
  private readonly cache = new Map<number, DType>()
  private readonly byOffset: Map<number, Die>

  constructor(byOffset: Map<number, Die>) {
    this.byOffset = byOffset
  }

  /** The type an entry's DW_AT_type names (void when it has none). */
  typeOf(die: Die): DType {
    const ref = refOf(die.attrs[DW_AT.type])
    return ref === undefined ? VOID : this.at(ref)
  }

  at(offset: number): DType {
    const cached = this.cache.get(offset)
    if (cached) return cached
    const die = this.byOffset.get(offset)
    if (!die) return UNKNOWN("<unknown type>")
    return this.build(die)
  }

  private build(die: Die): DType {
    const a = die.attrs
    const name = strOf(a[DW_AT.name]) ?? ""
    const size = numOf(a[DW_AT.byte_size]) ?? 0
    const put = <T extends DType>(t: T): T => {
      this.cache.set(die.offset, t)
      return t
    }
    switch (die.tag) {
      case DW_TAG.base_type:
        return put({ kind: "base", name, size, encoding: numOf(a[DW_AT.encoding]) ?? DW_ATE.signed })
      case DW_TAG.unspecified_type:
        return put(name === "decltype(nullptr)" ? { kind: "pointer", name, size: 4, target: VOID } : UNKNOWN(name || "void"))
      case DW_TAG.pointer_type: {
        const t = put({ kind: "pointer", size: size || 4, target: VOID } as DType & { kind: "pointer" })
        t.target = this.typeOf(die)
        return t
      }
      case DW_TAG.reference_type:
      case DW_TAG.rvalue_reference_type: {
        const t = put({ kind: "reference", size: size || 4, target: VOID, rvalue: die.tag === DW_TAG.rvalue_reference_type } as DType & { kind: "reference" })
        t.target = this.typeOf(die)
        return t
      }
      case DW_TAG.ptr_to_member_type:
        return put(UNKNOWN("<pointer to member>", size || 4))
      case DW_TAG.const_type:
      case DW_TAG.volatile_type:
      case DW_TAG.restrict_type:
      case DW_TAG.atomic_type: {
        const qualifier = die.tag === DW_TAG.const_type ? "const" : die.tag === DW_TAG.volatile_type ? "volatile" : die.tag === DW_TAG.restrict_type ? "restrict" : "atomic"
        const t = put({ kind: "qualified", qualifier, target: VOID, size: 0 } as DType & { kind: "qualified" })
        t.target = this.typeOf(die)
        t.size = t.target.size
        return t
      }
      case DW_TAG.typedef: {
        const t = put({ kind: "typedef", name, target: VOID, size: 0 } as DType & { kind: "typedef" })
        t.target = this.typeOf(die)
        t.size = t.target.size
        return t
      }
      case DW_TAG.structure_type:
      case DW_TAG.union_type:
      case DW_TAG.class_type: {
        const tag = die.tag === DW_TAG.union_type ? "union" : die.tag === DW_TAG.class_type ? "class" : "struct"
        const t = put({ kind: "struct", name: scopedName(die, name), tag, size, members: [], declaration: a[DW_AT.declaration] === true } as DType & { kind: "struct" })
        for (const c of die.children) {
          if (c.tag !== DW_TAG.member && c.tag !== DW_TAG.inheritance) continue
          // Static data members are declarations inside the class; they live elsewhere.
          if (c.tag === DW_TAG.member && c.attrs[DW_AT.declaration] === true) continue
          const mt = this.typeOf(c)
          const m: Member = { name: strOf(c.attrs[DW_AT.name]) ?? (c.tag === DW_TAG.inheritance ? typeName(mt) : ""), type: mt, offset: memberOffset(c), base: c.tag === DW_TAG.inheritance }
          const bitSize = numOf(c.attrs[DW_AT.bit_size])
          if (bitSize !== undefined) {
            const dataBit = numOf(c.attrs[DW_AT.data_bit_offset])
            if (dataBit !== undefined) {
              m.offset = Math.floor(dataBit / 8)
              m.bitOffset = dataBit % 8
            } else {
              // DWARF 2/3 counts bit_offset from the most significant bit of a storage unit of byte_size.
              const storage = (numOf(c.attrs[DW_AT.byte_size]) ?? mt.size) * 8
              const fromMsb = numOf(c.attrs[DW_AT.bit_offset]) ?? 0
              const fromLsb = storage - fromMsb - bitSize
              m.offset += Math.floor(fromLsb / 8)
              m.bitOffset = fromLsb % 8
            }
            m.bitSize = bitSize
          }
          t.members.push(m)
        }
        return t
      }
      case DW_TAG.array_type: {
        const t = put({ kind: "array", element: VOID, dims: [], size } as DType & { kind: "array" })
        t.element = this.typeOf(die)
        for (const c of die.children) {
          if (c.tag !== DW_TAG.subrange_type) continue
          const count = numOf(c.attrs[DW_AT.count])
          const upper = numOf(c.attrs[DW_AT.upper_bound])
          const lower = numOf(c.attrs[DW_AT.lower_bound]) ?? 0
          // An upper bound of all ones is how GCC says "no size" for a flexible array member.
          t.dims.push(count !== undefined ? count : upper !== undefined && upper !== 0xffffffff && upper >= lower ? upper - lower + 1 : -1)
        }
        if (!t.dims.length) t.dims.push(-1)
        if (!t.size) t.size = t.dims.every((d) => d >= 0) ? t.dims.reduce((p, d) => p * d, 1) * t.element.size : 0
        return t
      }
      case DW_TAG.enumeration_type: {
        const t = put({ kind: "enum", name: scopedName(die, name), size: size || 4, values: [], signed: false } as DType & { kind: "enum" })
        const base = refOf(a[DW_AT.type])
        if (base !== undefined) {
          const bt = strip(this.at(base))
          t.signed = bt.kind === "base" && (bt.encoding === DW_ATE.signed || bt.encoding === DW_ATE.signed_char)
        }
        for (const c of die.children) if (c.tag === DW_TAG.enumerator) t.values.push({ name: strOf(c.attrs[DW_AT.name]) ?? "", value: numOf(c.attrs[DW_AT.const_value]) ?? 0 })
        if (!t.signed && t.values.some((v) => v.value < 0)) t.signed = true
        return t
      }
      case DW_TAG.subroutine_type: {
        const t = put({ kind: "function", ret: VOID, params: [], varargs: false, size: 0 } as DType & { kind: "function" })
        t.ret = this.typeOf(die)
        for (const c of die.children) {
          if (c.tag === DW_TAG.formal_parameter) t.params.push(this.typeOf(c))
          else if (c.tag === DW_TAG.unspecified_parameters) t.varargs = true
        }
        return t
      }
      default:
        return put(UNKNOWN(name || `<tag 0x${die.tag.toString(16)}>`, size))
    }
  }
}

/** A member's offset: a constant, or (DWARF 2) an expression run over the object's address 0. */
function memberOffset(die: Die): number {
  const v = die.attrs[DW_AT.data_member_location]
  const n = numOf(v)
  if (n !== undefined) return n
  const block = blockOf(v)
  if (block) return evaluateValue(block, { reg: () => null, read: () => null }, 0) ?? 0
  return 0
}

/** A name qualified by the namespaces and classes around it (C++). */
export function scopedName(die: Die, name: string): string {
  if (!name) return name
  const parts = [name]
  for (let p = die.parent; p; p = p.parent) {
    if (p.tag === DW_TAG.namespace || p.tag === DW_TAG.structure_type || p.tag === DW_TAG.class_type || p.tag === DW_TAG.union_type) {
      const n = strOf(p.attrs[DW_AT.name])
      parts.unshift(n ?? (p.tag === DW_TAG.namespace ? "(anonymous namespace)" : "{…}"))
    }
  }
  return parts.join("::")
}
