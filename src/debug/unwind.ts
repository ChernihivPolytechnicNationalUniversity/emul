/**
 * The call stack at a stop, from the registers and the stack memory: the call frame
 * information says for every code address where the caller's SP and the saved registers
 * are; an EXC_RETURN in LR says the caller is the context an exception interrupted, whose
 * registers the hardware stacked (with the FP extension when bit 4 is clear). Each physical
 * frame is shown with the functions inlined into it at that point, innermost first, as GDB
 * does.
 */
import { symbolAt } from "@/mcu/elf"
import { excName } from "@/mcu/faults"
import type { DebugInfo, FunctionInfo, InlineLevel } from "./info"
import type { MemorySnapshot } from "./memory"
import { AVR_DW_RA, AVR_DW_SP } from "./arch"
import type { ArmRegisters, AvrRegisters, CoreRegisters } from "./protocol"
import { evaluateValue, type ExprContext } from "./dwarf/expr"

/**
 * Where a frame's register value is kept, for setting it: in one of the core's registers (the
 * same one, or another a rule moved it to: a caller's PC is the callee's LR until it is saved),
 * or in the stack slot a callee saved it to (it is restored from there on the way back).
 * `reg` counts r0–r15, or s0–s31 for an FP register's home. `thumb`: kept as a return
 * address, with bit 0 set (a caller's PC in its callee's LR or its save slot).
 */
export type RegHome = ({ kind: "register"; reg: number } | { kind: "memory"; addr: number }) & { thumb?: boolean }

export type FrameRegs = {
  /** r0–r15 as far as this frame knows them: a caller does not know the scratch registers (null). */
  r: (number | null)[]
  /** The FP registers, as bit patterns; only the innermost frame has them for certain. */
  s: number[] | null
  /** Where each of r0–r15 is kept; null for a value that is computed (the caller's SP) or lost. */
  rHome: (RegHome | null)[]
  /** Where each FP register is kept, where `s` is known. */
  sHome: (RegHome | null)[] | null
}

const inRegister = (reg: number): RegHome => ({ kind: "register", reg })
const slot = (addr: number): RegHome => ({ kind: "memory", addr: addr >>> 0 })

export type StackFrame = {
  /** Position in the stack, 0 innermost; inlined frames count too. */
  index: number
  /** The frame's PC: where it is stopped, or where it goes on when its callee returns. */
  pc: number
  /** Where lines and scopes are looked up: a return address minus one lands in its call. */
  lookup: number
  /** Canonical frame address (the caller's SP), when the call frame information has it. */
  cfa: number | null
  regs: FrameRegs
  fn: FunctionInfo | null
  level: InlineLevel | null
  name: string
  file: string | null
  line: number
  column: number
  /** A function inlined into the physical frame below it in the list. */
  inlined: boolean
  /** The exception that interrupted this frame, for the marker the call stack shows above it. */
  interruptedBy: string | null
}

const MAX_FRAMES = 64
/** An EXC_RETURN (B1.5.8): 0xFFFFFFE1/E9/ED/F1/F9/FD. Not LR's reset value 0xFFFFFFFF, which ends the stack. */
const isExcReturn = (v: number) => (v & 0xffffffe0) >>> 0 === 0xffffffe0 && [0x1, 0x9, 0xd].includes(v & 0xf)

/** The frames at a stop, innermost first. */
export function unwind(info: DebugInfo, regs: CoreRegisters, mem: MemorySnapshot): StackFrame[] {
  return regs.arch === "avr" ? unwindAvr(info, regs, mem) : unwindArm(info, regs, mem)
}

function unwindArm(info: DebugInfo, regs: ArmRegisters, mem: MemorySnapshot): StackFrame[] {
  const frames: StackFrame[] = []
  let r: (number | null)[] = regs.r.slice(0, 16)
  let s: number[] | null = regs.s
  let rHome: (RegHome | null)[] = r.map((_, n) => inRegister(n))
  let sHome: (RegHome | null)[] | null = s ? s.map((_, k) => inRegister(k)) : null
  let interrupted = false
  let interruptedBy: string | null = null
  let psp = regs.psp
  let ipsr = regs.xpsr & 0x1ff
  for (let depth = 0; depth < MAX_FRAMES; depth++) {
    const pc = r[15]
    if (pc === null) break
    // The innermost frame and an interrupted one are stopped *at* their PC; a caller is past its call.
    const lookup = depth === 0 || interrupted ? pc : (pc - 1) >>> 0
    const row = info.frames.rowAt(lookup)
    const regOf = (n: number) => (n < 16 ? r[n] : null)
    let cfa: number | null = null
    if (row) {
      if (row.cfa.expr) cfa = evaluateValue(row.cfa.expr, ctx(regOf, mem))
      else {
        const base = regOf(row.cfa.reg)
        cfa = base === null ? null : (base + row.cfa.offset) >>> 0
      }
    } else if (depth === 0 || interrupted) {
      // No unwinding rules (hand-written assembly, a library routine): at a function's first
      // instruction nothing is pushed yet, and a leaf never pushes; take SP and LR as they are.
      cfa = r[13]
    }
    pushFrames(frames, info, { pc, lookup, cfa, regs: { r, s, rHome, sHome }, interruptedBy })
    interruptedBy = null
    interrupted = false
    if (cfa === null) break

    // The caller's registers, and where each is kept.
    const next: (number | null)[] = new Array(16).fill(null)
    const nextHome: (RegHome | null)[] = new Array(16).fill(null)
    for (let n = 4; n <= 11; n++) {
      next[n] = r[n]
      nextHome[n] = rHome[n]
    }
    next[13] = cfa
    let ra: number | null = r[14]
    let raHome: RegHome | null = rHome[14]
    if (row) {
      for (const [n, rule] of row.regs) {
        if (n >= 16) continue
        let v: number | null = null
        let home: RegHome | null = null
        switch (rule.kind) {
          case "offset":
            v = mem.u32((cfa + rule.n) >>> 0)
            home = slot(cfa + rule.n)
            break
          case "val-offset":
            v = (cfa + rule.n) >>> 0
            break
          case "register":
            v = regOf(rule.reg)
            home = rule.reg < 16 ? rHome[rule.reg] : null
            break
          case "same":
            v = r[n]
            home = rHome[n]
            break
          case "expr": {
            const a = evaluateValue(rule.expr, ctx(regOf, mem), cfa)
            v = a === null ? null : mem.u32(a)
            home = a === null ? null : slot(a)
            break
          }
          case "val-expr":
            v = evaluateValue(rule.expr, ctx(regOf, mem), cfa)
            break
          case "undefined":
            v = null
        }
        next[n] = v
        nextHome[n] = v === null ? null : home
      }
      const kept = row.regs.has(row.returnRegister)
      ra = kept ? next[row.returnRegister] : r[row.returnRegister]
      raHome = kept ? nextHome[row.returnRegister] : rHome[row.returnRegister]
    }
    if (ra === null) break

    if (isExcReturn(ra)) {
      // The frame below returns from an exception: the interrupted context is on the stack
      // the EXC_RETURN names — the thread's PSP, or MSP where the handler's frame ends.
      const handler = ipsr
      const onPsp = (ra & 4) !== 0
      const frame = onPsp ? psp : cfa
      const fp = (ra & 0x10) === 0
      const words = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => mem.u32((frame + i * 4) >>> 0))
      if (words.some((w) => w === null)) break
      const [r0, r1, r2, r3, r12, lr, rpc, xpsr] = words as number[]
      const stacked: (number | null)[] = [...next]
      const stackedHome: (RegHome | null)[] = [...nextHome]
      // The hardware's frame: r0–r3, r12, lr, pc, xPSR, a word each; they are popped back on return.
      ;[0, 1, 2, 3, 12, 14, 15].forEach((n, i) => (stackedHome[n] = slot(frame + i * 4)))
      stacked[0] = r0
      stacked[1] = r1
      stacked[2] = r2
      stacked[3] = r3
      stacked[12] = r12
      stacked[14] = lr
      stacked[15] = rpc & ~1
      const size = fp ? 0x68 : 0x20
      stacked[13] = (frame + size + (xpsr & (1 << 9) ? 4 : 0)) >>> 0
      stackedHome[13] = null
      if (fp && s) {
        const sv = [...s]
        const svHome = [...(sHome ?? s.map(() => null))]
        for (let i = 0; i < 16; i++) {
          const v = mem.u32((frame + 32 + i * 4) >>> 0)
          sv[i] = v ?? sv[i]
          if (v !== null) svHome[i] = slot(frame + 32 + i * 4)
        }
        s = sv
        sHome = svHome
      }
      if (onPsp) psp = stacked[13]!
      ipsr = xpsr & 0x1ff
      interrupted = true
      interruptedBy = excName(handler)
      r = stacked
      rHome = stackedHome
      continue
    }
    // The end of the stack: Reset_Handler's LR, or nothing to return to.
    if (ra === 0 || ra >>> 0 === 0xffffffff) break
    const callerPc = (ra & ~1) >>> 0
    if (depth > 0 && next[13] !== null && r[13] !== null && next[13]! < r[13]!) break
    next[15] = callerPc
    // Its PC is the return address: changing it changes where the callee returns to.
    nextHome[15] = raHome && { ...raHome, thumb: true }
    // A caller only knows the registers the callee had to keep (r4–r11) and what the rules restore.
    r = next
    rHome = nextHome
    s = null
    sHome = null
  }
  return frames
}

/** Registers a callee must keep for its caller (avr-gcc's ABI): r1 (zero), r2–r17, r28–r29 (Y). */
const AVR_KEPT = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 28, 29]

/**
 * The AVR's frames, by avr-gcc's call frame information: the CFA is SP (DWARF 32) plus an
 * offset, a saved register is one byte at CFA + n, and the return address (column 36) is the
 * two bytes a call pushed, high byte first, a word address. Registers and SP hold data
 * addresses; the debugger reads the data space at 0x800000 up.
 */
function unwindAvr(info: DebugInfo, regs: AvrRegisters, mem: MemorySnapshot): StackFrame[] {
  const data = info.arch.dataAddress
  const frames: StackFrame[] = []
  let r: (number | null)[] = regs.r.slice(0, AVR_DW_SP + 1)
  let rHome: (RegHome | null)[] = r.map((_, n) => inRegister(n))
  let pc = regs.pc
  for (let depth = 0; depth < MAX_FRAMES; depth++) {
    const lookup = depth === 0 ? pc : pc - 1
    const row = info.frames.rowAt(lookup)
    // SP, or a register pair as the CFA's base (r28 is Y, r28:r29).
    const regOf = (n: number) => {
      if (n === AVR_DW_SP) return r[n]
      const lo = r[n]
      const hi = r[n + 1]
      return n < 31 && lo !== null && hi !== null ? lo | (hi << 8) : null
    }
    const sp = r[AVR_DW_SP]
    let cfa: number | null = null
    if (row) {
      if (row.cfa.expr) cfa = evaluateValue(row.cfa.expr, ctx(regOf, mem))
      else {
        const base = regOf(row.cfa.reg)
        cfa = base === null ? null : (base + row.cfa.offset) & 0xffff
      }
      if (cfa !== null && sregPushedUndescribed(info, mem, lookup)) cfa = (cfa + 1) & 0xffff
    } else if (depth === 0 && sp !== null) {
      // No rules (assembly, a library routine): as at a function's entry, the return address is on top.
      cfa = (sp + 2) & 0xffff
    }
    pushFrames(frames, info, { pc, lookup, cfa, regs: { r, s: null, rHome, sHome: null }, interruptedBy: null })
    if (cfa === null) break

    const next: (number | null)[] = new Array(AVR_DW_SP + 1).fill(null)
    const nextHome: (RegHome | null)[] = new Array(AVR_DW_SP + 1).fill(null)
    for (const n of AVR_KEPT) {
      next[n] = r[n]
      nextHome[n] = rHome[n]
    }
    next[AVR_DW_SP] = cfa
    let raAt: number | null = (cfa - 1) & 0xffff
    if (row) {
      for (const [n, rule] of row.regs) {
        if (n === AVR_DW_RA) {
          raAt = rule.kind === "offset" ? (cfa + rule.n) & 0xffff : null
          continue
        }
        if (n >= AVR_DW_SP) continue
        if (rule.kind === "offset") {
          const at = data((cfa + rule.n) & 0xffff)
          next[n] = mem.u8(at)
          nextHome[n] = next[n] === null ? null : slot(at)
        } else if (rule.kind === "register") {
          next[n] = rule.reg <= AVR_DW_SP ? r[rule.reg] : null
          nextHome[n] = rule.reg <= AVR_DW_SP ? rHome[rule.reg] : null
        } else if (rule.kind === "same") {
          next[n] = r[n]
          nextHome[n] = rHome[n]
        } else {
          next[n] = null
          nextHome[n] = null
        }
      }
    }
    if (raAt === null) break
    const hi = mem.u8(data(raAt))
    const lo = mem.u8(data((raAt + 1) & 0xffff))
    if (hi === null || lo === null) break
    const ra = ((hi << 8) | lo) * 2
    // The stack only grows down: a caller is above its callee; past the top there is nothing to return to.
    if (sp !== null && cfa <= sp) break
    pc = ra
    r = next
    rHome = nextHome
  }
  return frames
}

/**
 * avr-gcc 5.4 leaves one push of an interrupt handler's prologue out of its call frame
 * information: SREG saved through r0 (`in r0, 0x3f` or `lds r0, 0x5f`, then `push r0`). Past
 * that push the CFA the rules give is a byte short, and the return address read there is
 * wrong. Whether the code at `pc` is past such a push in its function's prologue.
 */
function sregPushedUndescribed(info: DebugInfo, mem: MemorySnapshot, pc: number): boolean {
  const fn = symbolAt(info.symbols.filter((x) => x.type === "func"), pc)
  if (!fn || !/^__vector_\d+$/.test(fn.symbol.name)) return false
  const start = fn.symbol.value
  for (let a = start; a < pc && a < start + 16; a += 2) {
    const w = mem.u16(a)
    const next = mem.u16(a + 2)
    if (w === 0xb60f && next === 0x920f) return a + 2 < pc
    if (w === 0x9000 && next === 0x005f && mem.u16(a + 4) === 0x920f) return a + 4 < pc
  }
  return false
}

function ctx(reg: (n: number) => number | null, mem: MemorySnapshot): ExprContext {
  return { reg, read: (a, n) => mem.read(a, n) }
}

/** One physical frame, preceded by the functions inlined at its PC. */
function pushFrames(out: StackFrame[], info: DebugInfo, f: { pc: number; lookup: number; cfa: number | null; regs: FrameRegs; interruptedBy: string | null }) {
  const levels = info.inlineLevels(f.lookup)
  const fn = info.functionAt(f.lookup)
  const line = info.lines.lineAt(f.lookup)
  if (!levels.length) {
    const sym = symbolAt(info.symbols.filter((x) => x.type === "func"), f.lookup)
    out.push({
      index: out.length,
      pc: f.pc,
      lookup: f.lookup,
      cfa: f.cfa,
      regs: f.regs,
      fn,
      level: null,
      name: sym ? sym.symbol.name : `0x${f.pc.toString(16).padStart(8, "0")}`,
      file: line?.path ?? null,
      line: line?.line ?? 0,
      column: line?.column ?? 0,
      inlined: false,
      interruptedBy: f.interruptedBy,
    })
    return
  }
  levels.forEach((level, i) => {
    // The innermost level is where the PC is; each one outside it is where it made the inlined call.
    const at = i === 0 ? { file: line?.path ?? null, line: line?.line ?? 0, column: line?.column ?? 0 } : levels[i - 1].call!
    out.push({
      index: out.length,
      pc: f.pc,
      lookup: f.lookup,
      cfa: f.cfa,
      regs: f.regs,
      fn,
      level,
      name: level.name,
      file: at.file,
      line: at.line,
      column: at.column,
      inlined: i < levels.length - 1,
      interruptedBy: i === 0 ? f.interruptedBy : null,
    })
  })
}
