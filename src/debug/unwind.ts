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
import type { CoreRegisters } from "./protocol"
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
const isExcReturn = (v: number) => (v & 0xffffffe0) >>> 0 === 0xffffffe0 && v >>> 0 >= 0xffffffe0

/** The frames at a stop, innermost first. */
export function unwind(info: DebugInfo, regs: CoreRegisters, mem: MemorySnapshot): StackFrame[] {
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
