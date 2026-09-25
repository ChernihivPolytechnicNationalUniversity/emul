/**
 * Range lists (`.debug_ranges`, v5 `.debug_rnglists`) and location lists (`.debug_loc`, v5
 * `.debug_loclists`): where a scope's code lies when it is not one contiguous block, and
 * where a variable lives as the program counter moves through its scope.
 */
import { DW_AT, DW_LLE, DW_RLE } from "./consts"
import { addrOf, listxOf, numOf, secOf, unitAddress, type AttrValue, type Die, type Sections, type Unit } from "./info"
import { Reader } from "./reader"

export type Range = [number, number]
/** One entry of a location list: the expression that holds for pc in [lo, hi). */
export type LocEntry = { lo: number; hi: number; expr: Uint8Array }

/** The v5 lists section offset of a `listx` index, through the unit's offsets table. */
function listxOffset(section: Uint8Array | undefined, base: number, index: number, unit: Unit): number | undefined {
  if (!section || !base) return undefined
  const r = new Reader(section, base + index * unit.offsetSize)
  r.offsetSize = unit.offsetSize
  return base + r.offset()
}

/** The address ranges of a scope: low/high pc, or its range list. Empty when it has neither. */
export function dieRanges(s: Sections, die: Die): Range[] {
  const a = die.attrs
  const low = addrOf(a[DW_AT.low_pc])
  const high = a[DW_AT.high_pc]
  if (low !== undefined && high !== undefined) {
    const hi = addrOf(high) ?? low + (numOf(high) ?? 0)
    return hi > low ? [[low, hi]] : []
  }
  const ranges = a[DW_AT.ranges]
  if (ranges === undefined) return []
  const unit = die.unit
  if (unit.version >= 5) {
    const x = listxOf(ranges)
    const off = x !== undefined ? listxOffset(s.rnglists, unit.rnglistsBase, x, unit) : secOf(ranges) ?? numOf(ranges)
    return off === undefined ? [] : rnglist(s, off, unit)
  }
  const off = secOf(ranges) ?? numOf(ranges)
  return off === undefined ? [] : rangesV4(s, off, unit)
}

function rangesV4(s: Sections, offset: number, unit: Unit): Range[] {
  const sec = s.ranges
  if (!sec) return []
  const r = new Reader(sec, offset)
  r.addressSize = unit.addressSize
  const out: Range[] = []
  let base = unit.baseAddress
  const max = unit.addressSize === 8 ? Number.MAX_SAFE_INTEGER : 0xffffffff
  while (r.pos + 2 * unit.addressSize <= sec.length) {
    const a = r.address()
    const b = r.address()
    if (a === 0 && b === 0) break
    if (a === max) base = b
    else if (b > a) out.push([base + a, base + b])
  }
  return out
}

function rnglist(s: Sections, offset: number, unit: Unit): Range[] {
  const sec = s.rnglists
  if (!sec) return []
  const r = new Reader(sec, offset)
  r.addressSize = unit.addressSize
  const out: Range[] = []
  let base = unit.baseAddress
  while (r.pos < sec.length) {
    const kind = r.u8()
    switch (kind) {
      case DW_RLE.end_of_list:
        return out
      case DW_RLE.base_addressx:
        base = unitAddress(s, unit, r.uleb())
        break
      case DW_RLE.startx_endx: {
        const a = unitAddress(s, unit, r.uleb())
        const b = unitAddress(s, unit, r.uleb())
        if (b > a) out.push([a, b])
        break
      }
      case DW_RLE.startx_length: {
        const a = unitAddress(s, unit, r.uleb())
        const len = r.uleb()
        if (len) out.push([a, a + len])
        break
      }
      case DW_RLE.offset_pair: {
        const a = r.uleb()
        const b = r.uleb()
        if (b > a) out.push([base + a, base + b])
        break
      }
      case DW_RLE.base_address:
        base = r.address()
        break
      case DW_RLE.start_end: {
        const a = r.address()
        const b = r.address()
        if (b > a) out.push([a, b])
        break
      }
      case DW_RLE.start_length: {
        const a = r.address()
        const len = r.uleb()
        if (len) out.push([a, a + len])
        break
      }
      default:
        return out
    }
  }
  return out
}

/**
 * A location attribute: one expression for the whole scope (an `exprloc`), or a location
 * list. `null` is no location at all (optimized out, or a declaration).
 */
export type Location = { kind: "expr"; expr: Uint8Array } | { kind: "list"; entries: LocEntry[] } | null

export function dieLocation(s: Sections, die: Die, at: number = DW_AT.location): Location {
  const v: AttrValue | undefined = die.attrs[at]
  if (v === undefined) return null
  if (v instanceof Uint8Array) return { kind: "expr", expr: v }
  const unit = die.unit
  if (unit.version >= 5) {
    const x = listxOf(v)
    const off = x !== undefined ? listxOffset(s.loclists, unit.loclistsBase, x, unit) : secOf(v)
    return off === undefined ? null : { kind: "list", entries: loclist(s, off, unit) }
  }
  const off = secOf(v) ?? numOf(v)
  return off === undefined ? null : { kind: "list", entries: locV4(s, off, unit) }
}

function locV4(s: Sections, offset: number, unit: Unit): LocEntry[] {
  const sec = s.loc
  if (!sec) return []
  const r = new Reader(sec, offset)
  r.addressSize = unit.addressSize
  const out: LocEntry[] = []
  let base = unit.baseAddress
  const max = unit.addressSize === 8 ? Number.MAX_SAFE_INTEGER : 0xffffffff
  while (r.pos + 2 * unit.addressSize <= sec.length) {
    const a = r.address()
    const b = r.address()
    if (a === 0 && b === 0) break
    if (a === max) {
      base = b
      continue
    }
    const len = r.u16()
    const expr = r.take(len)
    if (b > a) out.push({ lo: base + a, hi: base + b, expr })
  }
  return out
}

function loclist(s: Sections, offset: number, unit: Unit): LocEntry[] {
  const sec = s.loclists
  if (!sec) return []
  const r = new Reader(sec, offset)
  r.addressSize = unit.addressSize
  const out: LocEntry[] = []
  let base = unit.baseAddress
  const push = (lo: number, hi: number) => {
    const expr = r.take(r.uleb())
    if (hi > lo) out.push({ lo, hi, expr })
  }
  while (r.pos < sec.length) {
    const kind = r.u8()
    switch (kind) {
      case DW_LLE.end_of_list:
        return out
      case DW_LLE.base_addressx:
        base = unitAddress(s, unit, r.uleb())
        break
      case DW_LLE.startx_endx: {
        const a = unitAddress(s, unit, r.uleb())
        push(a, unitAddress(s, unit, r.uleb()))
        break
      }
      case DW_LLE.startx_length: {
        const a = unitAddress(s, unit, r.uleb())
        push(a, a + r.uleb())
        break
      }
      case DW_LLE.offset_pair: {
        const a = r.uleb()
        const b = r.uleb()
        push(base + a, base + b)
        break
      }
      case DW_LLE.default_location:
        push(0, 0xffffffff)
        break
      case DW_LLE.base_address:
        base = r.address()
        break
      case DW_LLE.start_end: {
        const a = r.address()
        push(a, r.address())
        break
      }
      case DW_LLE.start_length: {
        const a = r.address()
        push(a, a + r.uleb())
        break
      }
      case DW_LLE.GNU_view_pair:
        // GCC's location views: a pair of view numbers, then the entry it qualifies follows.
        r.uleb()
        r.uleb()
        break
      default:
        return out
    }
  }
  return out
}

/** The expression that locates a variable at `pc`, or null when it has none there. */
export function locationAt(loc: Location, pc: number): Uint8Array | null {
  if (!loc) return null
  if (loc.kind === "expr") return loc.expr
  for (const e of loc.entries) if (pc >= e.lo && pc < e.hi) return e.expr
  return null
}
