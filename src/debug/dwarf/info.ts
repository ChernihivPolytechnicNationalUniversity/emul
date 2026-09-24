/**
 * `.debug_info`: compilation units and their tree of debugging information entries (DWARF
 * 2–5). Every unit is parsed at once into plain objects — a firmware image has a few tens of
 * thousands of entries — with attribute values tagged by their form's class, since that is
 * what decides their meaning (a `high_pc` constant is an offset, a `location` block is an
 * expression, a section offset is a location list).
 */
import { DW_AT, DW_FORM, DW_TAG } from "./consts"
import { Reader, stringAt } from "./reader"

/** A reference to another entry, as an offset into `.debug_info`. */
export type RefValue = { ref: number }
/** An address operand (DW_FORM_addr and the indexed forms, resolved). */
export type AddrValue = { addr: number }
/** An offset into another section (stmt_list, ranges, location lists, macros). */
export type SecValue = { sec: number }
/** An index into the unit's location or range list offsets table (DWARF 5). */
export type ListxValue = { listx: number }
export type AttrValue = number | string | boolean | Uint8Array | RefValue | AddrValue | SecValue | ListxValue

export type Die = {
  offset: number
  tag: number
  attrs: Record<number, AttrValue>
  children: Die[]
  parent: Die | null
  unit: Unit
}

export type Unit = {
  offset: number
  version: number
  unitType: number
  addressSize: number
  offsetSize: number
  die: Die
  /** Bases of the DWARF 5 indexed tables, from the unit entry. */
  strOffsetsBase: number
  addrBase: number
  rnglistsBase: number
  loclistsBase: number
  /** DW_AT_low_pc of the unit: the base for its range and location lists. */
  baseAddress: number
  name: string
  compDir: string
  language: number
}

export type Sections = {
  info?: Uint8Array
  abbrev?: Uint8Array
  str?: Uint8Array
  lineStr?: Uint8Array
  strOffsets?: Uint8Array
  addr?: Uint8Array
  line?: Uint8Array
  ranges?: Uint8Array
  rnglists?: Uint8Array
  loc?: Uint8Array
  loclists?: Uint8Array
  frame?: Uint8Array
  macro?: Uint8Array
  aranges?: Uint8Array
}

/** The DWARF sections of an ELF, by the names GCC gives them. */
export function dwarfSections(byName: Map<string, Uint8Array>): Sections {
  return {
    info: byName.get(".debug_info"),
    abbrev: byName.get(".debug_abbrev"),
    str: byName.get(".debug_str"),
    lineStr: byName.get(".debug_line_str"),
    strOffsets: byName.get(".debug_str_offsets"),
    addr: byName.get(".debug_addr"),
    line: byName.get(".debug_line"),
    ranges: byName.get(".debug_ranges"),
    rnglists: byName.get(".debug_rnglists"),
    loc: byName.get(".debug_loc"),
    loclists: byName.get(".debug_loclists"),
    frame: byName.get(".debug_frame"),
    macro: byName.get(".debug_macro"),
    aranges: byName.get(".debug_aranges"),
  }
}

type AbbrevAttr = { at: number; form: number; implicit: number }
type Abbrev = { tag: number; children: boolean; attrs: AbbrevAttr[] }

function parseAbbrevs(section: Uint8Array, offset: number): Map<number, Abbrev> {
  const r = new Reader(section, offset)
  const table = new Map<number, Abbrev>()
  while (!r.done) {
    const code = r.uleb()
    if (code === 0) break
    const tag = r.uleb()
    const children = r.u8() !== 0
    const attrs: AbbrevAttr[] = []
    for (;;) {
      const at = r.uleb()
      const form = r.uleb()
      if (at === 0 && form === 0) break
      attrs.push({ at, form, implicit: form === DW_FORM.implicit_const ? r.sleb() : 0 })
    }
    table.set(code, { tag, children, attrs })
  }
  return table
}

/** DW_AT_macros (v5) and DW_AT_GNU_macros (its v4 forerunner): the unit's `.debug_macro` offset. */
export const DW_AT_MACROS = 0x79
export const DW_AT_GNU_MACROS = 0x2119

/** Value placeholders resolved once the unit entry has given the table bases. */
type Pending = { die: Die; at: number; kind: "strx" | "addrx"; index: number }

/**
 * Every unit of `.debug_info`, parsed. Units of kinds other than compile and partial units
 * (type units) are skipped. `rootOnly` reads just each unit's own entry — its name,
 * directory and line table — which is all a core needs to step by line.
 */
export function parseUnits(s: Sections, rootOnly = false): Unit[] {
  const info = s.info
  if (!info || !s.abbrev) return []
  const units: Unit[] = []
  const abbrevCache = new Map<number, Map<number, Abbrev>>()
  const r = new Reader(info)
  while (r.pos + 11 <= info.length) {
    const start = r.pos
    const length = r.initialLength()
    const end = r.pos + length
    if (length === 0 || end > info.length) break
    const version = r.u16()
    let unitType = 1
    let abbrevOffset: number
    let addressSize: number
    if (version >= 5) {
      unitType = r.u8()
      addressSize = r.u8()
      abbrevOffset = r.offset()
      // Skeleton and split units carry a DWO id, type units a signature and an offset.
      if (unitType === 4 || unitType === 5) r.pos += 8
      else if (unitType === 2 || unitType === 6) {
        r.pos += 8
        r.offset()
      }
    } else {
      abbrevOffset = r.offset()
      addressSize = r.u8()
    }
    if (version < 2 || version > 5 || !(unitType === 1 || unitType === 3)) {
      r.pos = end
      continue
    }
    r.addressSize = addressSize
    let abbrevs = abbrevCache.get(abbrevOffset)
    if (!abbrevs) {
      abbrevs = parseAbbrevs(s.abbrev, abbrevOffset)
      abbrevCache.set(abbrevOffset, abbrevs)
    }
    const unit = { offset: start, version, unitType, addressSize, offsetSize: r.offsetSize, strOffsetsBase: 0, addrBase: 0, rnglistsBase: 0, loclistsBase: 0, baseAddress: 0, name: "", compDir: "", language: 0 } as Unit
    const pending: Pending[] = []
    const stack: Die[] = []
    let first: Die | null = null
    while (r.pos < end) {
      const offset = r.pos
      const code = r.uleb()
      if (code === 0) {
        stack.pop()
        if (stack.length === 0 && first) break
        continue
      }
      const abbrev = abbrevs.get(code)
      if (!abbrev) break
      const parent = stack.length ? stack[stack.length - 1] : null
      const die: Die = { offset, tag: abbrev.tag, attrs: {}, children: [], parent, unit }
      for (const a of abbrev.attrs) {
        const v = readForm(r, a.form, a.implicit, unit, s, start, die, a.at, pending)
        if (v !== undefined) die.attrs[a.at] = v
      }
      if (parent) parent.children.push(die)
      else if (!first) first = die
      if (rootOnly) break
      if (abbrev.children) stack.push(die)
      else if (!parent) break
    }
    r.pos = end
    if (!first) continue
    unit.die = first
    const ua = first.attrs
    unit.strOffsetsBase = secOf(ua[DW_AT.str_offsets_base]) ?? 0
    unit.addrBase = secOf(ua[DW_AT.addr_base]) ?? 0
    unit.rnglistsBase = secOf(ua[DW_AT.rnglists_base]) ?? 0
    unit.loclistsBase = secOf(ua[DW_AT.loclists_base]) ?? 0
    for (const p of pending) p.die.attrs[p.at] = p.kind === "strx" ? strx(s, unit, p.index) : { addr: addrx(s, unit, p.index) }
    unit.name = typeof ua[DW_AT.name] === "string" ? (ua[DW_AT.name] as string) : ""
    unit.compDir = typeof ua[DW_AT.comp_dir] === "string" ? (ua[DW_AT.comp_dir] as string) : ""
    unit.language = typeof ua[DW_AT.language] === "number" ? (ua[DW_AT.language] as number) : 0
    unit.baseAddress = addrOf(ua[DW_AT.low_pc]) ?? 0
    units.push(unit)
  }
  return units
}

function readForm(r: Reader, form: number, implicit: number, unit: Unit, s: Sections, unitStart: number, die: Die, at: number, pending: Pending[]): AttrValue | undefined {
  switch (form) {
    case DW_FORM.addr:
      return { addr: r.address() }
    case DW_FORM.data1:
      return r.u8()
    case DW_FORM.data2:
      return r.u16()
    case DW_FORM.data4:
      // A section offset in DWARF 2/3 was a data4 as well (stmt_list, ranges, location lists).
      return unit.version < 4 && (at === DW_AT.stmt_list || at === DW_AT.ranges || at === DW_AT.location || at === DW_AT.frame_base || at === DW_AT_MACROS) ? { sec: r.u32() } : r.u32()
    case DW_FORM.data8:
      return unit.version < 4 && (at === DW_AT.stmt_list || at === DW_AT.ranges || at === DW_AT.location) ? { sec: r.u64() } : r.u64()
    case DW_FORM.data16:
      return r.take(16)
    case DW_FORM.sdata:
      return r.sleb()
    case DW_FORM.udata:
      return r.uleb()
    case DW_FORM.implicit_const:
      return implicit
    case DW_FORM.string:
      return r.cstr()
    case DW_FORM.strp:
    case DW_FORM.GNU_strp_alt:
    case DW_FORM.strp_sup:
      return stringAt(s.str, r.offset())
    case DW_FORM.line_strp:
      return stringAt(s.lineStr, r.offset())
    case DW_FORM.strx:
    case DW_FORM.GNU_str_index:
      return defer(pending, die, at, "strx", r.uleb(), unit, s)
    case DW_FORM.strx1:
      return defer(pending, die, at, "strx", r.u8(), unit, s)
    case DW_FORM.strx2:
      return defer(pending, die, at, "strx", r.u16(), unit, s)
    case DW_FORM.strx3:
      return defer(pending, die, at, "strx", r.u24(), unit, s)
    case DW_FORM.strx4:
      return defer(pending, die, at, "strx", r.u32(), unit, s)
    case DW_FORM.addrx:
    case DW_FORM.GNU_addr_index:
      return defer(pending, die, at, "addrx", r.uleb(), unit, s)
    case DW_FORM.addrx1:
      return defer(pending, die, at, "addrx", r.u8(), unit, s)
    case DW_FORM.addrx2:
      return defer(pending, die, at, "addrx", r.u16(), unit, s)
    case DW_FORM.addrx3:
      return defer(pending, die, at, "addrx", r.u24(), unit, s)
    case DW_FORM.addrx4:
      return defer(pending, die, at, "addrx", r.u32(), unit, s)
    case DW_FORM.ref1:
      return { ref: unitStart + r.u8() }
    case DW_FORM.ref2:
      return { ref: unitStart + r.u16() }
    case DW_FORM.ref4:
      return { ref: unitStart + r.u32() }
    case DW_FORM.ref8:
      return { ref: unitStart + r.u64() }
    case DW_FORM.ref_udata:
      return { ref: unitStart + r.uleb() }
    case DW_FORM.ref_addr:
      // An offset from the start of .debug_info: address-sized in DWARF 2, offset-sized after.
      return { ref: unit.version === 2 ? r.address() : r.offset() }
    case DW_FORM.GNU_ref_alt:
    case DW_FORM.ref_sup4:
      r.u32()
      return undefined
    case DW_FORM.ref_sup8:
    case DW_FORM.ref_sig8:
      r.pos += 8
      return undefined
    case DW_FORM.block1:
      return r.take(r.u8())
    case DW_FORM.block2:
      return r.take(r.u16())
    case DW_FORM.block4:
      return r.take(r.u32())
    case DW_FORM.block:
    case DW_FORM.exprloc:
      return r.take(r.uleb())
    case DW_FORM.flag:
      return r.u8() !== 0
    case DW_FORM.flag_present:
      return true
    case DW_FORM.sec_offset:
      return { sec: r.offset() }
    case DW_FORM.loclistx:
    case DW_FORM.rnglistx:
      return { listx: r.uleb() }
    case DW_FORM.indirect:
      return readForm(r, r.uleb(), implicit, unit, s, unitStart, die, at, pending)
    default:
      throw new Error(`DWARF: unknown form 0x${form.toString(16)} at 0x${r.pos.toString(16)}`)
  }
}

/** Indexed values: resolved now for a unit whose entry has been read, after it for the entry itself. */
function defer(pending: Pending[], die: Die, at: number, kind: "strx" | "addrx", index: number, unit: Unit, s: Sections): AttrValue | undefined {
  if (die.parent !== null) return kind === "strx" ? strx(s, unit, index) : { addr: addrx(s, unit, index) }
  pending.push({ die, at, kind, index })
  return undefined
}

function strx(s: Sections, unit: Unit, index: number): string {
  const table = s.strOffsets
  if (!table) return ""
  // Without a base (DWARF 4 split units) the table starts after its 8-byte header.
  const base = unit.strOffsetsBase || 8
  const at = base + index * unit.offsetSize
  if (at + unit.offsetSize > table.length) return ""
  const r = new Reader(table, at)
  r.offsetSize = unit.offsetSize
  return stringAt(s.str, r.offset())
}

function addrx(s: Sections, unit: Unit, index: number): number {
  const table = s.addr
  if (!table) return 0
  const base = unit.addrBase || 8
  const at = base + index * unit.addressSize
  if (at + unit.addressSize > table.length) return 0
  const r = new Reader(table, at)
  r.addressSize = unit.addressSize
  return r.address()
}

/** The address a unit's DW_FORM_addrx index names (for location and range list entries). */
export function unitAddress(s: Sections, unit: Unit, index: number): number {
  return addrx(s, unit, index)
}

// --- attribute access --------------------------------------------------------------------------

export const addrOf = (v: AttrValue | undefined): number | undefined => (v !== undefined && typeof v === "object" && "addr" in v ? v.addr : undefined)
export const secOf = (v: AttrValue | undefined): number | undefined => (v !== undefined && typeof v === "object" && "sec" in v ? v.sec : undefined)
export const refOf = (v: AttrValue | undefined): number | undefined => (v !== undefined && typeof v === "object" && "ref" in v ? v.ref : undefined)
export const listxOf = (v: AttrValue | undefined): number | undefined => (v !== undefined && typeof v === "object" && "listx" in v ? v.listx : undefined)
export const numOf = (v: AttrValue | undefined): number | undefined => (typeof v === "number" ? v : undefined)
export const strOf = (v: AttrValue | undefined): string | undefined => (typeof v === "string" ? v : undefined)
export const blockOf = (v: AttrValue | undefined): Uint8Array | undefined => (v instanceof Uint8Array ? v : undefined)

/** Every entry of the units by its `.debug_info` offset, for following references. */
export function indexDies(units: Unit[]): Map<number, Die> {
  const byOffset = new Map<number, Die>()
  const walk = (d: Die) => {
    byOffset.set(d.offset, d)
    for (const c of d.children) walk(c)
  }
  for (const u of units) walk(u.die)
  return byOffset
}

/** Tags that open a scope a variable can be declared in. */
export const SCOPE_TAGS: ReadonlySet<number> = new Set([DW_TAG.subprogram, DW_TAG.lexical_block, DW_TAG.inlined_subroutine])
