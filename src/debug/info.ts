/**
 * Everything the debugger knows about a firmware image from its ELF: symbols, the line table,
 * call frame information, functions with their inlined instances and lexical scopes, the
 * variables in them, globals, types and (with -g3) macros. Built once per image on the UI
 * side; the core only needs the line table (`lines.ts`).
 */
import { elfAllocRanges, elfSections, parseElf, type Firmware, type MappingSymbol, type Symbol } from "@/mcu/elf"
import { DW_AT, DW_INL, DW_TAG } from "./dwarf/consts"
import { DW_AT_GNU_MACROS, DW_AT_MACROS, dwarfSections, indexDies, numOf, parseUnits, refOf, secOf, strOf, type Die, type Sections, type Unit } from "./dwarf/info"
import { parseLineProgram } from "./dwarf/line"
import { dieLocation, dieRanges, type Location, type Range } from "./dwarf/lists"
import { FrameTable } from "./dwarf/frame"
import { parseMacros, type MacroDef } from "./dwarf/macro"
import { LineTable, type FunctionRange } from "./lines"
import { scopedName, TypeResolver, typeName, type DType } from "./types"

export type FunctionInfo = {
  /** The concrete entry with the code (for an out-of-line copy of an inline function, that copy). */
  die: Die
  name: string
  ranges: Range[]
  low: number
  high: number
  frameBase: Location
  declFile: string | null
  declLine: number
}

export type VariableInfo = {
  name: string
  type: DType
  /** The entry with the location (a concrete instance); `origin` has the name, type and declaration. */
  die: Die
  origin: Die
  kind: "param" | "local" | "global"
  location: Location
  /** DW_AT_const_value: a variable the compiler folded into a constant. */
  constValue?: number | Uint8Array
  declFile: string | null
  declLine: number
}

/** A function activation at a pc, including the ones inlined into it; innermost first. */
export type InlineLevel = {
  /** The subprogram or inlined_subroutine entry that opens this level. */
  scope: Die
  name: string
  /** The scopes of this level that contain the pc: its own entry and the lexical blocks inside it, outermost first. */
  scopes: Die[]
  /** Where the inlined call is in the level below (the caller): null for the out-of-line function. */
  call: { file: string | null; line: number; column: number } | null
}

/** ELF function symbols as the ranges the line table works with (both sides of the debugger use the same). */
export function functionRanges(symbols: Symbol[]): FunctionRange[] {
  const fns = symbols.filter((s) => s.type === "func").map((s) => ({ name: s.name, start: s.value, end: s.value + s.size }))
  fns.sort((a, b) => a.start - b.start || b.end - a.end)
  return fns
}


export class DebugInfo {
  readonly firmware: Firmware
  readonly sections: Sections
  readonly units: Unit[]
  readonly byOffset: Map<number, Die>
  readonly lines: LineTable
  readonly frames: FrameTable
  readonly types: TypeResolver
  readonly functions: FunctionInfo[] = []
  /** Function entries with code, by the low address of each of their ranges. */
  private readonly fnRanges: { lo: number; hi: number; fn: FunctionInfo }[] = []
  private readonly globalsByName = new Map<string, VariableInfo[]>()
  readonly globals: VariableInfo[] = []
  private readonly typesByName = new Map<string, Die[]>()
  private readonly enumerators = new Map<string, { value: number; type: number }>()
  /** Where the image's sections are at run time: debug information outside them is for code the linker dropped. */
  private readonly alloc: { addr: number; size: number }[]
  private readonly unitFiles = new Map<Unit, string[]>()
  private macroCache: Map<string, MacroDef> | null = null
  /** How long the parse took, for the curious. */
  readonly parseMs: number

  constructor(image: Uint8Array) {
    const t0 = performance.now()
    const buf = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer
    this.firmware = parseElf(buf)
    const bytes = this.firmware.image ?? new Uint8Array(buf)
    this.sections = dwarfSections(elfSections(bytes))
    this.units = parseUnitsSafe(this.sections)
    this.byOffset = indexDies(this.units)
    this.alloc = elfAllocRanges(bytes)
    this.lines = LineTable.build(this.sections, this.units, this.alloc)
    this.lines.functions = functionRanges(this.firmware.symbols)
    this.frames = new FrameTable(this.sections.frame)
    this.types = new TypeResolver(this.byOffset)
    for (const u of this.units) {
      const stmt = secOf(u.die.attrs[DW_AT.stmt_list])
      const program = stmt === undefined ? null : parseLineProgram(this.sections, stmt, u.compDir, u.name)
      this.unitFiles.set(u, program?.files ?? [])
      this.walk(u.die)
    }
    // Enumerators by name, wherever their enumeration is declared (an anonymous one in a typedef, one inside a function).
    for (const d of this.byOffset.values()) {
      if (d.tag !== DW_TAG.enumeration_type) continue
      for (const c of d.children) {
        const n = c.tag === DW_TAG.enumerator ? strOf(c.attrs[DW_AT.name]) : undefined
        if (n && !this.enumerators.has(n)) this.enumerators.set(n, { value: numOf(c.attrs[DW_AT.const_value]) ?? 0, type: d.offset })
      }
    }
    this.fnRanges.sort((a, b) => a.lo - b.lo)
    this.functions.sort((a, b) => a.low - b.low)
    this.parseMs = performance.now() - t0
  }

  get symbols(): Symbol[] {
    return this.firmware.symbols
  }
  get mapping(): MappingSymbol[] {
    return this.firmware.mapping ?? []
  }
  /** Whether the image has DWARF at all (a stripped or HEX image does not). */
  get hasDwarf() {
    return this.units.length > 0
  }

  // --- the entry tree -------------------------------------------------------------------------

  private walk(die: Die) {
    for (const c of die.children) {
      switch (c.tag) {
        case DW_TAG.subprogram:
          this.addFunction(c)
          break
        case DW_TAG.variable:
          if (c.parent?.tag === DW_TAG.compile_unit || c.parent?.tag === DW_TAG.namespace || c.parent?.tag === DW_TAG.partial_unit) this.addGlobal(c)
          break
        case DW_TAG.typedef:
        case DW_TAG.structure_type:
        case DW_TAG.union_type:
        case DW_TAG.class_type:
        case DW_TAG.enumeration_type:
        case DW_TAG.base_type: {
          const n = strOf(c.attrs[DW_AT.name])
          if (n) {
            const full = scopedName(c, n)
            for (const key of new Set([n, full])) {
              const list = this.typesByName.get(key)
              if (list) list.push(c)
              else this.typesByName.set(key, [c])
            }
          }
          break
        }
      }
      if (c.tag === DW_TAG.namespace || c.tag === DW_TAG.structure_type || c.tag === DW_TAG.class_type || c.tag === DW_TAG.union_type) this.walk(c)
    }
  }

  private addFunction(die: Die) {
    const inline = numOf(die.attrs[DW_AT.inline])
    // An abstract instance (the inline function as written) has no code of its own.
    if (inline === DW_INL.inlined || inline === DW_INL.declared_inlined) return
    const ranges = dieRanges(this.sections, die).filter(([lo]) => this.inImage(lo))
    if (!ranges.length) return
    const origin = this.origin(die)
    const fn: FunctionInfo = {
      die,
      name: this.nameOf(die) ?? `<0x${ranges[0][0].toString(16)}>`,
      ranges,
      low: Math.min(...ranges.map((r) => r[0])),
      high: Math.max(...ranges.map((r) => r[1])),
      frameBase: dieLocation(this.sections, die, DW_AT.frame_base),
      declFile: this.fileOf(origin),
      declLine: numOf(origin.attrs[DW_AT.decl_line]) ?? 0,
    }
    this.functions.push(fn)
    for (const [lo, hi] of ranges) this.fnRanges.push({ lo, hi, fn })
  }

  private addGlobal(die: Die) {
    // A declaration (an `extern`, a static member in its class) is completed by a definition elsewhere.
    if (die.attrs[DW_AT.declaration] === true) return
    const location = dieLocation(this.sections, die)
    const cv = die.attrs[DW_AT.const_value]
    if (!location && cv === undefined) return
    // An unused variable the linker dropped keeps its entry, relocated to address 0.
    if (location?.kind === "expr" && location.expr.length === 5 && location.expr[0] === 0x03 && !this.inImage(new DataView(location.expr.buffer, location.expr.byteOffset + 1, 4).getUint32(0, true))) return
    const origin = this.origin(die)
    const name = this.nameOf(die)
    if (!name) return
    const v: VariableInfo = {
      name,
      type: this.typeOfEntry(die),
      die,
      origin,
      kind: "global",
      location,
      constValue: typeof cv === "number" || cv instanceof Uint8Array ? cv : undefined,
      declFile: this.fileOf(origin),
      declLine: numOf(origin.attrs[DW_AT.decl_line]) ?? 0,
    }
    this.globals.push(v)
    const short = strOf(origin.attrs[DW_AT.name]) ?? name
    for (const key of new Set([name, short])) {
      const list = this.globalsByName.get(key)
      if (list) list.push(v)
      else this.globalsByName.set(key, [v])
    }
  }

  /** The entry that carries the declaration: through DW_AT_abstract_origin and DW_AT_specification. */
  origin(die: Die): Die {
    let d = die
    for (let i = 0; i < 8; i++) {
      const next = refOf(d.attrs[DW_AT.abstract_origin]) ?? refOf(d.attrs[DW_AT.specification])
      const target = next === undefined ? undefined : this.byOffset.get(next)
      if (!target) break
      d = target
    }
    return d
  }

  /** A name, looking through the origin (C++ names qualified by their namespace or class). */
  nameOf(die: Die): string | null {
    let d: Die | undefined = die
    for (let i = 0; i < 8 && d; i++) {
      const n = strOf(d.attrs[DW_AT.name])
      if (n) return scopedName(d, n)
      const next: number | undefined = refOf(d.attrs[DW_AT.abstract_origin]) ?? refOf(d.attrs[DW_AT.specification])
      d = next === undefined ? undefined : this.byOffset.get(next)
    }
    return null
  }

  /** An entry's type, looking through its origin. */
  typeOfEntry(die: Die): DType {
    let d: Die | undefined = die
    for (let i = 0; i < 8 && d; i++) {
      if (d.attrs[DW_AT.type] !== undefined) return this.types.typeOf(d)
      const next: number | undefined = refOf(d.attrs[DW_AT.abstract_origin]) ?? refOf(d.attrs[DW_AT.specification])
      d = next === undefined ? undefined : this.byOffset.get(next)
    }
    return this.types.typeOf(die)
  }

  /** The source file a DW_AT_decl_file (or call_file) names, as a full path. */
  fileOf(die: Die, at: number = DW_AT.decl_file): string | null {
    const i = numOf(die.attrs[at])
    if (i === undefined) return null
    const files = this.unitFiles.get(die.unit)
    return files?.[i] ?? null
  }

  // --- where the pc is ------------------------------------------------------------------------

  /** The function whose code contains `pc`. */
  functionAt(pc: number): FunctionInfo | null {
    const r = this.fnRanges
    let lo = 0
    let hi = r.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (r[mid].lo <= pc) {
        best = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    // Ranges can nest (a cold part inside another function's span): look back a little.
    for (let i = best; i >= 0 && i > best - 8; i--) if (pc >= r[i].lo && pc < r[i].hi) return r[i].fn
    return null
  }

  /**
   * The activations at `pc`, innermost first: the functions inlined there (each with the
   * place it was inlined at) and the out-of-line function around them.
   */
  inlineLevels(pc: number): InlineLevel[] {
    const fn = this.functionAt(pc)
    if (!fn) return []
    // Descend through the scopes that contain pc.
    const chain: Die[] = [fn.die]
    for (let d = fn.die; ; ) {
      let next: Die | null = null
      for (const c of d.children) {
        if (c.tag !== DW_TAG.lexical_block && c.tag !== DW_TAG.inlined_subroutine) continue
        if (dieRanges(this.sections, c).some(([lo, hi]) => pc >= lo && pc < hi)) {
          next = c
          break
        }
      }
      if (!next) break
      chain.push(next)
      d = next
    }
    const levels: InlineLevel[] = []
    let scopes: Die[] = []
    for (const d of chain) {
      if (d.tag !== DW_TAG.lexical_block) {
        scopes = [d]
        levels.push({ scope: d, name: this.nameOf(d) ?? fn.name, scopes, call: null })
      } else scopes.push(d)
    }
    // Each inlined level was called from the level outside it.
    for (let i = levels.length - 1; i > 0; i--) {
      const s = levels[i].scope
      levels[i].call = { file: this.fileOf(s, DW_AT.call_file), line: numOf(s.attrs[DW_AT.call_line]) ?? 0, column: numOf(s.attrs[DW_AT.call_column]) ?? 0 }
    }
    return levels.reverse()
  }

  /**
   * The parameters and locals of one activation, innermost declaration first where names
   * repeat. Variables of blocks the pc is not in are not visible, as in C.
   */
  variablesOf(level: InlineLevel): VariableInfo[] {
    const out: VariableInfo[] = []
    const seen = new Set<string>()
    for (let i = level.scopes.length - 1; i >= 0; i--) {
      for (const c of level.scopes[i].children) {
        if (c.tag !== DW_TAG.formal_parameter && c.tag !== DW_TAG.variable) continue
        const origin = this.origin(c)
        const name = strOf(origin.attrs[DW_AT.name]) ?? strOf(c.attrs[DW_AT.name])
        if (!name || seen.has(name)) continue
        seen.add(name)
        const cv = c.attrs[DW_AT.const_value] ?? origin.attrs[DW_AT.const_value]
        out.push({
          name,
          type: this.typeOfEntry(c),
          die: c,
          origin,
          kind: c.tag === DW_TAG.formal_parameter ? "param" : "local",
          location: dieLocation(this.sections, c),
          constValue: typeof cv === "number" || cv instanceof Uint8Array ? cv : undefined,
          declFile: this.fileOf(origin),
          declLine: numOf(origin.attrs[DW_AT.decl_line]) ?? 0,
        })
      }
    }
    // Parameters first, in declaration order; then locals by where they are declared.
    const params = out.filter((v) => v.kind === "param").sort((a, b) => a.die.offset - b.die.offset)
    const locals = out.filter((v) => v.kind === "local").sort((a, b) => a.declLine - b.declLine || a.die.offset - b.die.offset)
    return [...params, ...locals]
  }

  /** Globals by name; the one in `unit` first when several share it (two `static int count;`). */
  globalsNamed(name: string, unit?: Unit): VariableInfo[] {
    const list = this.globalsByName.get(name) ?? []
    return unit ? [...list].sort((a, b) => Number(b.die.unit === unit) - Number(a.die.unit === unit)) : list
  }

  /** A type by the name a cast would use: `uint32_t`, `GPIO_TypeDef`, `struct foo`, `Lab1::Mode`. */
  typeNamed(name: string): DType | null {
    const n = name.replace(/^(struct|union|enum|class)\s+/, "").trim()
    const list = this.typesByName.get(n)
    if (!list?.length) return null
    // A complete definition beats a forward declaration.
    const die = list.find((d) => d.attrs[DW_AT.declaration] !== true) ?? list[0]
    return this.types.at(die.offset)
  }

  /** Enumerators by name, for expressions (`GPIO_PIN_SET`, `HAL_OK`). */
  enumerator(name: string): { value: number; type: DType } | null {
    const e = this.enumerators.get(name)
    return e ? { value: e.value, type: this.types.at(e.type) } : null
  }

  /** Whether an address is inside one of the image's sections. */
  inImage(addr: number): boolean {
    return this.alloc.some((r) => addr >= r.addr && addr < r.addr + r.size)
  }

  /** Every `#define` the image recorded (-g3), parsed on first use. */
  macros(): Map<string, MacroDef> {
    if (!this.macroCache) {
      const offsets: number[] = []
      for (const u of this.units) {
        const off = secOf(u.die.attrs[DW_AT_MACROS]) ?? secOf(u.die.attrs[DW_AT_GNU_MACROS])
        if (off !== undefined) offsets.push(off)
      }
      this.macroCache = parseMacros(this.sections, offsets)
    }
    return this.macroCache
  }

  /** The unit a pc's code was compiled in. */
  unitAt(pc: number): Unit | null {
    return this.functionAt(pc)?.die.unit ?? null
  }

  /** A readable description of a type, for tooltips and the variables view. */
  typeName(t: DType) {
    return typeName(t)
  }
}

/** A malformed unit must not take the rest of the debugger down with it: no DWARF then, but symbols and lines if they parse. */
function parseUnitsSafe(s: Sections): Unit[] {
  try {
    return parseUnits(s)
  } catch (e) {
    console.warn("DWARF: .debug_info could not be read:", (e as Error).message)
    return []
  }
}
