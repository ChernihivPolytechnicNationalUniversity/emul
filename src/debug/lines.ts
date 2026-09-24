/**
 * The address ↔ source line map of a firmware image: every unit's line program merged into
 * one table sorted by address. Both sides of the debugger use it — the core (in whatever
 * thread it runs) to put breakpoints on lines and to step by line, the UI to show where
 * the core is — so a breakpoint means the same thing to both.
 *
 * Lookups follow GDB's conventions: an address belongs to the last row at or below it; at an
 * address that starts several rows the last statement row wins (that is the line to stop on);
 * a breakpoint on a line without code moves to the next line that has some, but not out of
 * the function the line is in; a breakpoint on a function's first line goes past its prologue.
 */
import { dwarfSections, parseUnits, secOf, type Sections, type Unit } from "./dwarf/info"
import { DW_AT } from "./dwarf/consts"
import { parseLineProgram } from "./dwarf/line"
import { normalizePath } from "./paths"

/** A function as the symbol table gives it: where it starts and where it ends. */
export type FunctionRange = { name: string; start: number; end: number }

const STMT = 1
const PROLOGUE_END = 2
/** Line keys pack a file and a line: file · 2²⁰ + line. */
const LINE_BITS = 1 << 20

export class LineTable {
  /** Source files by id, normalized full paths as the compiler saw them. */
  readonly files: string[]
  /** Rows, by address; each sequence ends with a marker row whose file is −1. */
  readonly addr: Uint32Array
  readonly file: Int32Array
  readonly line: Int32Array
  readonly column: Int32Array
  readonly flags: Uint8Array
  /** Functions sorted by start, for the prologue and the moved-breakpoint rules. */
  functions: FunctionRange[] = []

  private constructor(files: string[], rows: { address: number; file: number; line: number; column: number; flags: number }[]) {
    this.files = files
    const n = rows.length
    this.addr = new Uint32Array(n)
    this.file = new Int32Array(n)
    this.line = new Int32Array(n)
    this.column = new Int32Array(n)
    this.flags = new Uint8Array(n)
    rows.forEach((r, i) => {
      this.addr[i] = r.address
      this.file[i] = r.file
      this.line[i] = r.line
      this.column[i] = r.column
      this.flags[i] = r.flags
    })
  }

  get size() {
    return this.addr.length
  }

  /**
   * The table of an ELF's DWARF. `units` saves parsing `.debug_info` again when the caller
   * has it; `loaded` are the image's loadable ranges — sequences outside them belong to code
   * the linker dropped (`--gc-sections` leaves their line programs at address 0).
   */
  static build(s: Sections, units: Unit[] | null, loaded: { addr: number; size: number }[]): LineTable {
    const files: string[] = []
    const fileId = new Map<string, number>()
    const idOf = (path: string) => {
      let id = fileId.get(path)
      if (id === undefined) {
        id = files.length
        files.push(path)
        fileId.set(path, id)
      }
      return id
    }
    type Row = { address: number; file: number; line: number; column: number; flags: number }
    const sequences: Row[][] = []
    const inImage = (a: number) => loaded.some((r) => a >= r.addr && a < r.addr + r.size)
    const seen = new Set<number>()
    for (const unit of units ?? parseUnits(s, true)) {
      const stmt = secOf(unit.die.attrs[DW_AT.stmt_list])
      if (stmt === undefined || seen.has(stmt)) continue
      seen.add(stmt)
      const program = parseLineProgram(s, stmt, unit.compDir, unit.name)
      if (!program) continue
      const ids = program.files.map(idOf)
      let seq: Row[] = []
      for (const r of program.rows) {
        if (r.endSequence) {
          if (seq.length && inImage(seq[0].address) && r.address > seq[0].address) sequences.push([...seq, { address: r.address, file: -1, line: 0, column: 0, flags: 0 }])
          seq = []
          continue
        }
        seq.push({ address: r.address, file: ids[r.file] ?? -1, line: r.line, column: r.column, flags: (r.isStmt ? STMT : 0) | (r.prologueEnd ? PROLOGUE_END : 0) })
      }
    }
    sequences.sort((a, b) => a[0].address - b[0].address)
    const rows: Row[] = []
    let end = 0
    for (const seq of sequences) {
      // Two sequences over the same addresses (an overlay, a duplicate unit): the first one stands.
      if (seq[0].address < end) continue
      rows.push(...seq)
      end = seq[seq.length - 1].address
    }
    return new LineTable(files, rows)
  }

  /** The table of an ELF image, straight from its sections. */
  static fromSections(byName: Map<string, Uint8Array>, loaded: { addr: number; size: number }[]): LineTable {
    return LineTable.build(dwarfSections(byName), null, loaded)
  }

  /** Index of the last row at or below `pc`, or −1 when no sequence covers it. */
  rowAt(pc: number): number {
    const a = this.addr
    let lo = 0
    let hi = a.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (a[mid] <= pc) {
        best = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (best < 0 || this.file[best] === -1) return -1
    // Several rows at one address (views): the last statement among them is the line of the
    // code there, as GDB reports it.
    if (!(this.flags[best] & STMT)) {
      const at = a[best]
      for (let i = best - 1; i >= 0 && a[i] === at && this.file[i] !== -1; i--) if (this.flags[i] & STMT) return i
    }
    return best
  }

  /** The source position of an address, or null outside every sequence. */
  lineAt(pc: number): { file: number; path: string; line: number; column: number; stmt: boolean } | null {
    const i = this.rowAt(pc)
    if (i < 0) return null
    return { file: this.file[i], path: this.files[this.file[i]], line: this.line[i], column: this.column[i], stmt: (this.flags[i] & STMT) !== 0 }
  }

  /** file · 2²⁰ + line of an address; 0 for code the compiler gave no line (line 0), −1 for none at all. */
  keyAt(pc: number): number {
    const i = this.rowAt(pc)
    if (i < 0) return -1
    const line = this.line[i]
    return line === 0 ? 0 : this.file[i] * LINE_BITS + line
  }
  static keyFile(key: number) {
    return Math.floor(key / LINE_BITS)
  }
  static keyLine(key: number) {
    return key % LINE_BITS
  }

  /** Whether a statement row starts exactly at `pc`: a place a line step may stop. */
  isStmtStart(pc: number): boolean {
    const i = this.rowAt(pc)
    return i >= 0 && this.addr[i] === pc && (this.flags[i] & STMT) !== 0
  }

  /** Address ranges the table attributes to this line of this file (as `lineAt` does), in address order. */
  rangesOf(file: number, line: number): [number, number][] {
    const out: [number, number][] = []
    const n = this.addr.length
    for (let i = 0; i < n; ) {
      const lo = this.addr[i]
      let j = i
      while (j < n && this.addr[j] === lo) j++
      if (j < n) {
        const r = this.rowAt(lo)
        if (r >= 0 && this.file[r] === file && this.line[r] === line) {
          const last = out[out.length - 1]
          if (last && last[1] === lo) last[1] = this.addr[j]
          else out.push([lo, this.addr[j]])
        }
      }
      i = j
    }
    return out
  }

  // --- files ------------------------------------------------------------------------------

  /**
   * The files a path names, by the longest run of trailing path segments they share: a
   * project's `Core/Src/main.c` is the image's `/tmp/emul-build-x/src/Core/Src/main.c`, and
   * `main.c` alone matches every `main.c`. Case matters only between candidates that tie.
   */
  matchFiles(path: string): number[] {
    const want = normalizePath(path).split("/").filter(Boolean)
    if (!want.length) return []
    let best = 0
    let bestExact = false
    let out: number[] = []
    this.files.forEach((f, id) => {
      const have = f.split("/").filter(Boolean)
      let n = 0
      let exact = true
      while (n < want.length && n < have.length) {
        const a = want[want.length - 1 - n]
        const b = have[have.length - 1 - n]
        if (a === b) n++
        else if (a.toLowerCase() === b.toLowerCase()) {
          exact = false
          n++
        } else break
      }
      if (n === 0) return
      if (n > best || (n === best && exact && !bestExact)) {
        best = n
        bestExact = exact
        out = [id]
      } else if (n === best && exact === bestExact) out.push(id)
    })
    return out
  }

  /** The files of the table that have code on some line: what the image was built from. */
  sourceFiles(): number[] {
    const used = new Set<number>()
    for (let i = 0; i < this.file.length; i++) if (this.file[i] >= 0 && this.line[i] > 0) used.add(this.file[i])
    return [...used].sort((a, b) => a - b)
  }

  /** Lines of a file that have a statement: where a breakpoint can go. */
  linesWithCode(file: number): Set<number> {
    const out = new Set<number>()
    for (let i = 0; i < this.file.length; i++) if (this.file[i] === file && this.line[i] > 0 && this.flags[i] & STMT) out.add(this.line[i])
    return out
  }

  // --- functions --------------------------------------------------------------------------

  /** The function around an address, from the symbol table. */
  functionAt(pc: number): FunctionRange | null {
    const fns = this.functions
    let lo = 0
    let hi = fns.length - 1
    let best = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (fns[mid].start <= pc) {
        best = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (best < 0) return null
    const f = fns[best]
    return pc < f.end || f.end === f.start ? f : null
  }

  /**
   * Where a function's body starts, past the code that sets up its frame: the row the
   * compiler marked `prologue_end`; else the entry itself when a statement of another line
   * starts there (optimized code that needs no frame); else the next statement row after the
   * entry (the first line of the body — or, in a function written on one line, the same line
   * again once the frame is up).
   */
  postPrologue(entry: number, end = entry): number {
    const first = this.rowAt(entry)
    if (first < 0) return entry
    const limit = end > entry ? end : Infinity
    let start = first
    while (start > 0 && this.addr[start - 1] === this.addr[first] && this.file[start - 1] !== -1) start--
    for (let i = start; i < this.addr.length && this.addr[i] < limit && this.file[i] !== -1; i++) if (this.flags[i] & PROLOGUE_END) return this.addr[i]
    const line0 = this.line[start]
    let i = start
    for (; i < this.addr.length && this.addr[i] === entry && this.file[i] !== -1; i++) if (this.line[i] !== line0 && this.line[i] !== 0 && this.flags[i] & STMT) return entry
    for (; i < this.addr.length && this.addr[i] < limit && this.file[i] !== -1; i++) if (this.line[i] !== 0 && this.flags[i] & STMT) return this.addr[i]
    return entry
  }

  /**
   * Addresses for a breakpoint on `line` of the files `path` names: the lowest statement of
   * that line in each function it has code in. A line without code moves to the next line
   * that has some in the same function; null when there is none.
   */
  resolve(path: string, line: number): { line: number; addrs: number[] } | null {
    const files = new Set(this.matchFiles(path))
    if (!files.size) return null
    const exact = this.locations(files, line)
    if (exact.length) return { line, addrs: exact }
    // The next line with code, if the requested one lies inside the function that code is in.
    let next = Infinity
    for (let i = 0; i < this.file.length; i++) if (files.has(this.file[i]) && this.line[i] > line && this.line[i] < next && this.flags[i] & STMT) next = this.line[i]
    if (next === Infinity) return null
    const moved = this.locations(files, next).filter((a) => {
      const fn = this.functionAt(a)
      if (!fn) return true
      for (let i = this.rowAt(fn.start); i >= 0 && i < this.addr.length && this.addr[i] < fn.end; i++) if (files.has(this.file[i]) && this.line[i] > 0 && this.line[i] < line) return true
      return false
    })
    return moved.length ? { line: next, addrs: moved } : null
  }

  /** The lowest statement address of a line per function, past the prologue at a function's entry. */
  private locations(files: Set<number>, line: number): number[] {
    const byFunction = new Map<number, number>()
    let any = false
    for (const wantStmt of [true, false]) {
      for (let i = 0; i < this.file.length; i++) {
        if (!files.has(this.file[i]) || this.line[i] !== line) continue
        if (wantStmt && !(this.flags[i] & STMT)) continue
        const a = this.addr[i]
        const key = this.functionAt(a)?.start ?? -1 - i
        const had = byFunction.get(key)
        if (had === undefined || a < had) byFunction.set(key, a)
        any = true
      }
      if (any) break
    }
    const out: number[] = []
    for (const [start, a] of byFunction) {
      const fn = start >= 0 ? this.functionAt(start) : null
      out.push(fn && a === fn.start ? this.postPrologue(fn.start, fn.end) : a)
    }
    return [...new Set(out)].sort((x, y) => x - y)
  }
}
