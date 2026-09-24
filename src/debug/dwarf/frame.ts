/**
 * `.debug_frame` (DWARF call frame information): for any code address, how to find the
 * caller's frame — the canonical frame address (CFA, the caller's SP at the call) as a
 * register plus offset, and where each callee-saved register was stored. This is what makes
 * a call stack possible in optimized code with no frame pointer.
 */
import { DW_CFA } from "./consts"
import { Reader } from "./reader"

export type CfaRule = { reg: number; offset: number; expr?: undefined } | { expr: Uint8Array }
export type RegRule =
  | { kind: "undefined" }
  | { kind: "same" }
  /** Saved at CFA + n. */
  | { kind: "offset"; n: number }
  /** The value is CFA + n itself. */
  | { kind: "val-offset"; n: number }
  | { kind: "register"; reg: number }
  | { kind: "expr"; expr: Uint8Array }
  | { kind: "val-expr"; expr: Uint8Array }

export type FrameRow = { cfa: CfaRule; regs: Map<number, RegRule>; returnRegister: number }

type Cie = { codeAlign: number; dataAlign: number; returnRegister: number; initial: Uint8Array; addressSize: number; augmentation: string }
type Fde = { cie: Cie; start: number; end: number; instructions: Uint8Array }

export class FrameTable {
  private readonly fdes: Fde[] = []

  constructor(section: Uint8Array | undefined, addressSize = 4) {
    if (!section) return
    const cies = new Map<number, Cie>()
    const r = new Reader(section)
    r.addressSize = addressSize
    while (r.pos + 4 <= section.length) {
      const start = r.pos
      const length = r.initialLength()
      if (length === 0) continue
      const end = r.pos + length
      if (end > section.length) break
      const id = r.offset()
      // The CIE id is all ones in the unit's offset width (the 64-bit one reads back rounded).
      const isCie = r.offsetSize === 8 ? id >= 0xffffffff * 0x100000000 : id === 0xffffffff
      if (isCie) {
        const version = r.u8()
        const augmentation = r.cstr()
        let cieAddressSize = addressSize
        if (version >= 4) {
          cieAddressSize = r.u8()
          r.u8()
        }
        const codeAlign = r.uleb()
        const dataAlign = r.sleb()
        const returnRegister = version === 1 ? r.u8() : r.uleb()
        if (augmentation.startsWith("z")) r.pos += r.uleb()
        cies.set(start, { codeAlign, dataAlign, returnRegister, initial: section.subarray(r.pos, end), addressSize: cieAddressSize, augmentation })
      } else {
        const cie = cies.get(id) ?? parseCieAt(section, id, addressSize, cies)
        if (cie) {
          r.addressSize = cie.addressSize
          const lo = r.address()
          const range = r.address()
          if (cie.augmentation.startsWith("z")) r.pos += r.uleb()
          // Entries for code the linker dropped keep their relocations at 0: skip them.
          if (range > 0 && lo !== 0) this.fdes.push({ cie, start: lo, end: lo + range, instructions: section.subarray(r.pos, end) })
          r.addressSize = addressSize
        }
      }
      r.pos = end
    }
    this.fdes.sort((a, b) => a.start - b.start)
  }

  get size() {
    return this.fdes.length
  }

  private fdeAt(pc: number): Fde | null {
    let lo = 0
    let hi = this.fdes.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const f = this.fdes[mid]
      if (pc < f.start) hi = mid - 1
      else if (pc >= f.end) lo = mid + 1
      else return f
    }
    return null
  }

  /** Whether some entry covers `pc`. */
  covers(pc: number) {
    return this.fdeAt(pc) !== null
  }

  /** The unwinding rules in effect at `pc`, or null when no entry covers it. */
  rowAt(pc: number): FrameRow | null {
    const fde = this.fdeAt(pc)
    if (!fde) return null
    const { cie } = fde
    const state: FrameRow = { cfa: { reg: 13, offset: 0 }, regs: new Map(), returnRegister: cie.returnRegister }
    run(cie.initial, cie, state, null, Infinity, fde.start)
    const initial = new Map(state.regs)
    run(fde.instructions, cie, state, initial, pc, fde.start)
    return state
  }
}

function parseCieAt(section: Uint8Array, offset: number, addressSize: number, cies: Map<number, Cie>): Cie | undefined {
  if (offset >= section.length) return undefined
  const r = new Reader(section, offset)
  const length = r.initialLength()
  const end = r.pos + length
  r.offset()
  const version = r.u8()
  const augmentation = r.cstr()
  let cieAddressSize = addressSize
  if (version >= 4) {
    cieAddressSize = r.u8()
    r.u8()
  }
  const codeAlign = r.uleb()
  const dataAlign = r.sleb()
  const returnRegister = version === 1 ? r.u8() : r.uleb()
  if (augmentation.startsWith("z")) r.pos += r.uleb()
  const cie = { codeAlign, dataAlign, returnRegister, initial: section.subarray(r.pos, end), addressSize: cieAddressSize, augmentation }
  cies.set(offset, cie)
  return cie
}

/** Execute call frame instructions until the location passes `pc`. */
function run(code: Uint8Array, cie: Cie, state: FrameRow, initial: Map<number, RegRule> | null, pc: number, start: number) {
  const r = new Reader(code)
  r.addressSize = cie.addressSize
  let loc = start
  const stack: { cfa: CfaRule; regs: Map<number, RegRule> }[] = []
  const restore = (reg: number) => {
    const v = initial?.get(reg)
    if (v) state.regs.set(reg, v)
    else state.regs.delete(reg)
  }
  const advance = (delta: number) => {
    loc += delta * cie.codeAlign
    return loc > pc
  }
  while (!r.done) {
    const op = r.u8()
    const high = op & 0xc0
    const low = op & 0x3f
    if (high === DW_CFA.advance_loc) {
      if (advance(low)) return
      continue
    }
    if (high === DW_CFA.offset) {
      state.regs.set(low, { kind: "offset", n: r.uleb() * cie.dataAlign })
      continue
    }
    if (high === DW_CFA.restore) {
      restore(low)
      continue
    }
    switch (op) {
      case DW_CFA.nop:
        break
      case DW_CFA.set_loc:
        loc = r.address()
        if (loc > pc) return
        break
      case DW_CFA.advance_loc1:
        if (advance(r.u8())) return
        break
      case DW_CFA.advance_loc2:
        if (advance(r.u16())) return
        break
      case DW_CFA.advance_loc4:
        if (advance(r.u32())) return
        break
      case DW_CFA.offset_extended:
        state.regs.set(r.uleb(), { kind: "offset", n: r.uleb() * cie.dataAlign })
        break
      case DW_CFA.offset_extended_sf: {
        const reg = r.uleb()
        state.regs.set(reg, { kind: "offset", n: r.sleb() * cie.dataAlign })
        break
      }
      case DW_CFA.restore_extended:
        restore(r.uleb())
        break
      case DW_CFA.undefined:
        state.regs.set(r.uleb(), { kind: "undefined" })
        break
      case DW_CFA.same_value:
        state.regs.set(r.uleb(), { kind: "same" })
        break
      case DW_CFA.register: {
        const reg = r.uleb()
        state.regs.set(reg, { kind: "register", reg: r.uleb() })
        break
      }
      case DW_CFA.remember_state:
        stack.push({ cfa: { ...state.cfa }, regs: new Map(state.regs) })
        break
      case DW_CFA.restore_state: {
        const s = stack.pop()
        if (s) {
          state.cfa = s.cfa
          state.regs = s.regs
        }
        break
      }
      case DW_CFA.def_cfa: {
        const reg = r.uleb()
        state.cfa = { reg, offset: r.uleb() }
        break
      }
      case DW_CFA.def_cfa_sf: {
        const reg = r.uleb()
        state.cfa = { reg, offset: r.sleb() * cie.dataAlign }
        break
      }
      case DW_CFA.def_cfa_register:
        state.cfa = { reg: r.uleb(), offset: state.cfa.expr ? 0 : state.cfa.offset }
        break
      case DW_CFA.def_cfa_offset:
        state.cfa = { reg: state.cfa.expr ? 13 : state.cfa.reg, offset: r.uleb() }
        break
      case DW_CFA.def_cfa_offset_sf:
        state.cfa = { reg: state.cfa.expr ? 13 : state.cfa.reg, offset: r.sleb() * cie.dataAlign }
        break
      case DW_CFA.def_cfa_expression:
        state.cfa = { expr: r.take(r.uleb()) }
        break
      case DW_CFA.expression: {
        const reg = r.uleb()
        state.regs.set(reg, { kind: "expr", expr: r.take(r.uleb()) })
        break
      }
      case DW_CFA.val_expression: {
        const reg = r.uleb()
        state.regs.set(reg, { kind: "val-expr", expr: r.take(r.uleb()) })
        break
      }
      case DW_CFA.val_offset: {
        const reg = r.uleb()
        state.regs.set(reg, { kind: "val-offset", n: r.uleb() * cie.dataAlign })
        break
      }
      case DW_CFA.val_offset_sf: {
        const reg = r.uleb()
        state.regs.set(reg, { kind: "val-offset", n: r.sleb() * cie.dataAlign })
        break
      }
      case DW_CFA.GNU_args_size:
        r.uleb()
        break
      case DW_CFA.GNU_negative_offset_extended: {
        const reg = r.uleb()
        state.regs.set(reg, { kind: "offset", n: -r.uleb() * cie.dataAlign })
        break
      }
      default:
        // Unknown instruction: nothing after it can be trusted.
        return
    }
  }
}
