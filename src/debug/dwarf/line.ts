/**
 * `.debug_line`: the line number programs (DWARF 2–5), run into their rows. A row says that
 * the instructions from its address up to the next row's come from one line of one file;
 * `isStmt` marks the rows a debugger should stop at, and each sequence ends with a row that
 * only gives the end address.
 */
import { DW_FORM, DW_LNCT, DW_LNE, DW_LNS } from "./consts"
import { Reader, stringAt } from "./reader"
import type { Sections } from "./info"
import { isAbsolute, normalizePath } from "../paths"

export type LineRow = {
  address: number
  /** Index into the program's `files`. */
  file: number
  line: number
  column: number
  isStmt: boolean
  prologueEnd: boolean
  endSequence: boolean
}

export type LineProgram = {
  offset: number
  version: number
  /** Full paths by the program's file numbers (v5 counts from 0, v2–4 from 1; index 0 is then the unit's own file). */
  files: string[]
  rows: LineRow[]
}

/** `name` in `dir`, both possibly relative; a relative directory is under the unit's compilation directory. */
export function joinPath(compDir: string, dir: string, name: string): string {
  if (isAbsolute(name)) return normalizePath(name)
  const base = !dir ? compDir : isAbsolute(dir) ? dir : compDir ? `${compDir}/${dir}` : dir
  return normalizePath(base ? `${base}/${name}` : name)
}

/** Run the line program at `offset`, for a unit compiled in `compDir` from `unitName`. */
export function parseLineProgram(s: Sections, offset: number, compDir: string, unitName: string): LineProgram | null {
  const section = s.line
  if (!section || offset >= section.length) return null
  const r = new Reader(section, offset)
  const length = r.initialLength()
  const end = r.pos + length
  if (end > section.length) return null
  const version = r.u16()
  if (version < 2 || version > 5) return null
  if (version >= 5) {
    r.addressSize = r.u8()
    r.u8() // segment selector size
  }
  const headerLength = r.offset()
  const programStart = r.pos + headerLength
  const minInst = r.u8()
  if (version >= 4) r.u8() // maximum operations per instruction: 1 on everything but VLIW
  const defaultIsStmt = r.u8() !== 0
  const lineBase = r.i8()
  const lineRange = r.u8()
  const opcodeBase = r.u8()
  const opLengths = [0]
  for (let i = 1; i < opcodeBase; i++) opLengths.push(r.u8())

  const files: string[] = []
  if (version >= 5) {
    const dirs = entryTable(r, s).map((e) => e.path)
    const dirOf = (i: number) => (i === 0 ? dirs[0] || compDir : (dirs[i] ?? ""))
    for (const f of entryTable(r, s)) files.push(joinPath(compDir, dirOf(f.dir), f.path))
  } else {
    const dirs: string[] = [compDir]
    for (;;) {
      const d = r.cstr()
      if (!d) break
      dirs.push(d)
    }
    files.push(joinPath(compDir, "", unitName))
    for (;;) {
      const name = r.cstr()
      if (!name) break
      const dir = r.uleb()
      r.uleb()
      r.uleb()
      files.push(joinPath(compDir, dirs[dir] ?? "", name))
    }
  }

  r.pos = programStart
  const rows: LineRow[] = []
  let address = 0
  let file = 1
  let line = 1
  let column = 0
  let isStmt = defaultIsStmt
  let prologueEnd = false
  const reset = () => {
    address = 0
    file = 1
    line = 1
    column = 0
    isStmt = defaultIsStmt
    prologueEnd = false
  }
  const emit = (endSequence: boolean) => {
    rows.push({ address: address >>> 0, file, line, column, isStmt, prologueEnd, endSequence })
    prologueEnd = false
  }
  while (r.pos < end) {
    const op = r.u8()
    if (op >= opcodeBase) {
      const adjusted = op - opcodeBase
      address += Math.floor(adjusted / lineRange) * minInst
      line += lineBase + (adjusted % lineRange)
      emit(false)
      continue
    }
    switch (op) {
      case 0: {
        const len = r.uleb()
        const next = r.pos + len
        const sub = r.u8()
        if (sub === DW_LNE.end_sequence) {
          emit(true)
          reset()
        } else if (sub === DW_LNE.set_address) address = len - 1 === 8 ? r.u64() : r.u32()
        else if (sub === DW_LNE.define_file) {
          const name = r.cstr()
          r.uleb()
          files.push(joinPath(compDir, "", name))
        }
        r.pos = next
        break
      }
      case DW_LNS.copy:
        emit(false)
        break
      case DW_LNS.advance_pc:
        address += r.uleb() * minInst
        break
      case DW_LNS.advance_line:
        line += r.sleb()
        break
      case DW_LNS.set_file:
        file = r.uleb()
        break
      case DW_LNS.set_column:
        column = r.uleb()
        break
      case DW_LNS.negate_stmt:
        isStmt = !isStmt
        break
      case DW_LNS.set_basic_block:
        break
      case DW_LNS.const_add_pc:
        address += Math.floor((255 - opcodeBase) / lineRange) * minInst
        break
      case DW_LNS.fixed_advance_pc:
        address += r.u16()
        break
      case DW_LNS.set_prologue_end:
        prologueEnd = true
        break
      case DW_LNS.set_epilogue_begin:
        break
      case DW_LNS.set_isa:
        r.uleb()
        break
      default:
        // An opcode this reader does not know: its operands are ULEB128s, as many as the header says.
        for (let i = 0; i < (opLengths[op] ?? 0); i++) r.uleb()
    }
  }
  return { offset, version, files, rows }
}

/** A v5 directory or file table: a format description, then the entries in it. */
function entryTable(r: Reader, s: Sections): { path: string; dir: number }[] {
  const formatCount = r.u8()
  const format: [number, number][] = []
  for (let i = 0; i < formatCount; i++) format.push([r.uleb(), r.uleb()])
  const count = r.uleb()
  const out: { path: string; dir: number }[] = []
  for (let i = 0; i < count; i++) {
    let path = ""
    let dir = 0
    for (const [type, form] of format) {
      const v = entryValue(r, s, form)
      if (type === DW_LNCT.path && typeof v === "string") path = v
      else if (type === DW_LNCT.directory_index && typeof v === "number") dir = v
    }
    out.push({ path, dir })
  }
  return out
}

function entryValue(r: Reader, s: Sections, form: number): string | number | null {
  switch (form) {
    case DW_FORM.string:
      return r.cstr()
    case DW_FORM.line_strp:
      return stringAt(s.lineStr, r.offset())
    case DW_FORM.strp:
      return stringAt(s.str, r.offset())
    case DW_FORM.udata:
      return r.uleb()
    case DW_FORM.data1:
      return r.u8()
    case DW_FORM.data2:
      return r.u16()
    case DW_FORM.data4:
      return r.u32()
    case DW_FORM.data8:
      return r.u64()
    case DW_FORM.data16:
      r.pos += 16
      return null
    case DW_FORM.block:
      r.pos += r.uleb()
      return null
    case DW_FORM.strx:
    case DW_FORM.strx1:
    case DW_FORM.strx2:
    case DW_FORM.strx3:
    case DW_FORM.strx4:
      // Index forms need the unit's string offsets base, which a line table cannot know; GCC never uses them here.
      if (form === DW_FORM.strx) r.uleb()
      else r.sized(form - DW_FORM.strx1 + 1)
      return ""
    default:
      throw new Error(`DWARF: form 0x${form.toString(16)} in a line table header`)
  }
}
