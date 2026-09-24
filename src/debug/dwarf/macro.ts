/**
 * `.debug_macro` (DWARF 5, and GNU's version 4 of the same format): every `#define` a unit
 * saw, which `-g3` puts in the image. The expression evaluator expands them, so a watch on
 * `GPIOA->ODR` or `GPIO_PIN_5` works as it does in GDB. File scoping is ignored: the last
 * definition of a name wins, which for a firmware image is the one that matters.
 */
import { DW_FORM, DW_MACRO } from "./consts"
import { Reader, stringAt } from "./reader"
import type { Sections } from "./info"

export type MacroDef = { name: string; params: string[] | null; body: string }

/** Macros of the units whose `.debug_macro` offsets are given, imports followed. */
export function parseMacros(s: Sections, offsets: number[]): Map<string, MacroDef> {
  const out = new Map<string, MacroDef>()
  const sec = s.macro
  if (!sec) return out
  const done = new Set<number>()
  const unit = (offset: number, depth: number) => {
    if (done.has(offset) || offset >= sec.length || depth > 32) return
    done.add(offset)
    const r = new Reader(sec, offset)
    const version = r.u16()
    if (version !== 4 && version !== 5) return
    const flags = r.u8()
    r.offsetSize = flags & 1 ? 8 : 4
    if (flags & 2) r.offset()
    const operands = new Map<number, number[]>()
    if (flags & 4) {
      const count = r.u8()
      for (let i = 0; i < count; i++) {
        const op = r.u8()
        const n = r.uleb()
        const forms: number[] = []
        for (let k = 0; k < n; k++) forms.push(r.u8())
        operands.set(op, forms)
      }
    }
    while (!r.done) {
      const op = r.u8()
      switch (op) {
        case 0:
          return
        case DW_MACRO.define:
          r.uleb()
          define(out, r.cstr())
          break
        case DW_MACRO.undef:
          r.uleb()
          out.delete(r.cstr().trim())
          break
        case DW_MACRO.define_strp:
          r.uleb()
          define(out, stringAt(s.str, r.offset()))
          break
        case DW_MACRO.undef_strp:
          r.uleb()
          out.delete(stringAt(s.str, r.offset()).trim())
          break
        case DW_MACRO.start_file:
          r.uleb()
          r.uleb()
          break
        case DW_MACRO.end_file:
          break
        case DW_MACRO.import: {
          const at = r.offset()
          const back = r.pos
          unit(at, depth + 1)
          r.pos = back
          break
        }
        case DW_MACRO.define_strx:
        case DW_MACRO.undef_strx:
          // String indexes need a unit's offsets base; GCC does not emit these outside split DWARF.
          r.uleb()
          r.uleb()
          break
        case DW_MACRO.define_sup:
        case DW_MACRO.undef_sup:
          r.uleb()
          r.offset()
          break
        case DW_MACRO.import_sup:
          r.offset()
          break
        default: {
          const forms = operands.get(op)
          if (!forms) return
          for (const f of forms) skipForm(r, f)
        }
      }
    }
  }
  for (const o of offsets) unit(o, 0)
  return out
}

/** "NAME body" or "NAME(a, b) body", as the compiler records a definition. */
function define(out: Map<string, MacroDef>, text: string) {
  const m = /^([A-Za-z_]\w*)(\(([^)]*)\))?\s?([\s\S]*)$/.exec(text)
  if (!m) return
  const params = m[2] !== undefined ? m[3].split(",").map((p) => p.trim()).filter(Boolean) : null
  out.set(m[1], { name: m[1], params, body: m[4].trim() })
}

function skipForm(r: Reader, form: number) {
  switch (form) {
    case DW_FORM.data1:
    case DW_FORM.flag:
    case DW_FORM.strx1:
      r.pos += 1
      break
    case DW_FORM.data2:
    case DW_FORM.strx2:
      r.pos += 2
      break
    case DW_FORM.strx3:
      r.pos += 3
      break
    case DW_FORM.data4:
    case DW_FORM.strx4:
      r.pos += 4
      break
    case DW_FORM.data8:
      r.pos += 8
      break
    case DW_FORM.data16:
      r.pos += 16
      break
    case DW_FORM.sdata:
      r.sleb()
      break
    case DW_FORM.udata:
    case DW_FORM.strx:
      r.uleb()
      break
    case DW_FORM.string:
      r.cstr()
      break
    case DW_FORM.strp:
    case DW_FORM.line_strp:
    case DW_FORM.sec_offset:
      r.offset()
      break
    case DW_FORM.block:
      r.pos += r.uleb()
      break
    case DW_FORM.block1:
      r.pos += r.u8()
      break
    default:
      r.pos = r.bytes.length
  }
}
