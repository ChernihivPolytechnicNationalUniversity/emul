/**
 * The disassembly view's lines: the core's own decoder over the memory as held, with what a
 * reader wants besides — function labels, branch targets as `<symbol+offset>`, the value a
 * PC-relative load reads, literal pools shown as data (the ELF's `$d` mapping symbols say
 * where they are), and the source line each group of instructions came from.
 */
import { blockName } from "@/mcu/blocks"
import { decode } from "@/mcu/decode"
import { symbolAt, type MappingSymbol, type Symbol } from "@/mcu/elf"
import type { LineTable } from "./lines"

export type DisasmLine =
  | { kind: "label"; addr: number; text: string }
  | { kind: "source"; addr: number; path: string; line: number; text: string | null }
  | { kind: "insn"; addr: number; size: number; bytes: string; mnemonic: string; operands: string; comment: string; target: number | null }
  | { kind: "data"; addr: number; size: number; bytes: string; text: string; comment: string }
  | { kind: "unreadable"; addr: number }

export type DisasmContext = {
  read: (addr: number, size: number) => Uint8Array | null
  symbols: Symbol[]
  mapping: MappingSymbol[]
  lines: LineTable | null
  /** The text of a source line, when the file is at hand. */
  sourceLine?: (path: string, line: number) => string | null
}

const hex = (v: number, width = 8) => `0x${(v >>> 0).toString(16).padStart(width, "0")}`

/** The mapping kind in force at an address: `d` inside a literal pool. */
function mappingAt(mapping: MappingSymbol[], addr: number): MappingSymbol | null {
  let lo = 0
  let hi = mapping.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (mapping[mid].addr <= addr) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return best < 0 ? null : mapping[best]
}
function nextMapping(mapping: MappingSymbol[], addr: number): number {
  for (const m of mapping) if (m.addr > addr) return m.addr
  return Infinity
}

/** A `<symbol+offset>` for an address that a symbol covers (or a peripheral block's name), or "". */
export function symbolize(symbols: Symbol[], addr: number): string {
  if (addr >= 0x40000000 && addr < 0x60000000) {
    const block = blockName(addr)
    return block.startsWith("0x") ? "" : `<${block}>`
  }
  const s = symbolAt(symbols, addr)
  if (!s || s.symbol.type === "other") return ""
  if (s.symbol.size && s.offset >= s.symbol.size) return ""
  return `<${s.symbol.name}${s.offset ? `+${s.offset}` : ""}>`
}

/** Instructions (and data) from `start` to `end`, as the view shows them. */
export function disassemble(ctx: DisasmContext, start: number, end: number): DisasmLine[] {
  const out: DisasmLine[] = []
  const funcs = ctx.symbols.filter((s) => s.type === "func")
  const labels = new Map<number, string[]>()
  for (const s of funcs) if (s.value >= start && s.value < end) labels.set(s.value, [...(labels.get(s.value) ?? []), s.name])
  let itLeft = 0
  let lastKey = -2
  let addr = start >>> 0
  const u16 = (a: number) => {
    const b = ctx.read(a, 2)
    return b ? b[0] | (b[1] << 8) : null
  }
  while (addr < end && out.length < 4000) {
    const names = labels.get(addr)
    if (names) {
      out.push({ kind: "label", addr, text: names.join(", ") })
      itLeft = 0
    }
    // Source line of the next group of instructions.
    if (ctx.lines) {
      const key = ctx.lines.keyAt(addr)
      if (key > 0 && key !== lastKey && ctx.lines.isStmtStart(addr)) {
        const l = ctx.lines.lineAt(addr)!
        out.push({ kind: "source", addr, path: l.path, line: l.line, text: ctx.sourceLine?.(l.path, l.line) ?? null })
      }
      if (key !== -1) lastKey = key
    }
    const map = mappingAt(ctx.mapping, addr)
    if (map?.kind === "d") {
      // A literal pool: words while aligned, then what is left before the code starts again.
      const stop = Math.min(end, nextMapping(ctx.mapping, addr))
      const size = addr % 4 === 0 && stop - addr >= 4 ? 4 : addr % 2 === 0 && stop - addr >= 2 ? 2 : 1
      const b = ctx.read(addr, size)
      if (!b) {
        out.push({ kind: "unreadable", addr })
        addr += size
        continue
      }
      let v = 0
      for (let i = size - 1; i >= 0; i--) v = v * 256 + b[i]
      out.push({ kind: "data", addr, size, bytes: [...b].map((x) => x.toString(16).padStart(2, "0")).join(" "), text: `${size === 4 ? ".word" : size === 2 ? ".short" : ".byte"} ${hex(v, size * 2)}`, comment: size === 4 ? symbolize(ctx.symbols, v & ~1) : "" })
      addr += size
      continue
    }
    const hw1 = u16(addr)
    if (hw1 === null) {
      out.push({ kind: "unreadable", addr })
      addr += 2
      continue
    }
    const wide = (hw1 & 0xf800) >= 0xe800
    const hw2 = wide ? u16(addr + 2) : 0
    if (hw2 === null) {
      out.push({ kind: "unreadable", addr })
      addr += 2
      continue
    }
    const instr = decode(hw1, hw2, addr, itLeft > 0)
    const text = instr.text
    const sp = text.indexOf(" ")
    const mnemonic = sp < 0 ? text : text.slice(0, sp)
    const operands = sp < 0 ? "" : text.slice(sp + 1)
    let comment = ""
    let target: number | null = null
    // Branches and calls with a target in the text.
    const br = /^(?:b|bl|blx|cbz|cbnz|b[a-z]{2})(?:\.w|\.n)?$/.test(mnemonic) ? /(0x[0-9a-f]+)\s*$/.exec(operands) : null
    if (br) {
      target = parseInt(br[1], 16)
      comment = symbolize(ctx.symbols, target)
    }
    // A load from the literal pool: the value it reads.
    const lit = /\[pc, #(-?\d+)\]/.exec(operands)
    if (lit && /^ldr/.test(mnemonic)) {
      const at = (((addr + 4) & ~3) + Number(lit[1])) >>> 0
      const size = /^ldrb/.test(mnemonic) ? 1 : /^ldrh/.test(mnemonic) ? 2 : 4
      const b = ctx.read(at, size)
      if (b) {
        let v = 0
        for (let i = size - 1; i >= 0; i--) v = v * 256 + b[i]
        const sym = size === 4 ? symbolize(ctx.symbols, v & ~1) : ""
        comment = `= ${hex(v, size * 2)}${sym ? ` ${sym}` : ""}`
      }
    }
    const bytes = wide ? `${hw1.toString(16).padStart(4, "0")} ${hw2.toString(16).padStart(4, "0")}` : hw1.toString(16).padStart(4, "0")
    out.push({ kind: "insn", addr, size: instr.size, bytes, mnemonic, operands, comment, target })
    // IT: the next 1–4 instructions are conditional (their flag-setting reads differently).
    if (/^it[te]{0,3}$/.test(mnemonic)) itLeft = mnemonic.length - 1
    else if (itLeft > 0) itLeft--
    addr = (addr + instr.size) >>> 0
  }
  return out
}

/** A sensible range to show around an address: its function, or a window where no symbol covers it. */
export function rangeAround(symbols: Symbol[], addr: number): { start: number; end: number; name: string | null } {
  const s = symbolAt(symbols.filter((x) => x.type === "func"), addr)
  if (s && s.symbol.size && s.offset < s.symbol.size) return { start: s.symbol.value, end: s.symbol.value + s.symbol.size, name: s.symbol.name }
  return { start: Math.max(0, (addr & ~1) - 64), end: (addr & ~1) + 192, name: null }
}
