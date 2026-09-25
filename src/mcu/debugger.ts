/**
 * The debug unit of a core: breakpoints resolved against the loaded image, stepping by
 * instruction and by source line, vector catch, and the stop the core is at. It lives with
 * the core (in whatever thread that runs) so a step never waits for another thread: the
 * core has the line table and decides by itself when a step is done.
 *
 * The core's run loop asks `check()` at instruction boundaries — every block boundary while
 * a step is in progress, and wherever a breakpoint address comes up. Blocks never run
 * through a breakpoint, and while stepping a line they do not run from one line into the
 * next, so a boundary is always there when it matters; everything else (a call stepped over,
 * an interrupt taken mid-step) runs at full speed up to a temporary breakpoint at the place
 * it comes back to.
 *
 * Stepping follows GDB: a line step stops at the first statement of another line; it runs a
 * call through (`over`, or `into` a function without line information) and stops past the
 * callee's prologue otherwise; landing in the middle of another line keeps stepping to that
 * line's end, unless it is the caller the step returned into. A resumed or stepped core runs
 * the instruction under its PC once with interrupts held off, so a breakpoint there does not
 * fire again and a single step never lands in the SysTick handler. Otherwise an interrupt due
 * at a boundary goes first, as on the part: a breakpoint on the instruction after a WFI fires
 * once the handler that woke the core has returned.
 */
import type { Cpu } from "./cpu"
import type { Firmware } from "./elf"
import { elfAllocRanges, elfSections } from "./elf"
import { EXC } from "./faults"
import { LineTable, type FunctionRange } from "@/debug/lines"
import type { BreakpointSpec, DebugStop, StepRequest, StopReason } from "@/debug/protocol"

/** What the run loop does after `check()`. */
export const DBG_GO = 0
export const DBG_STOP = 1
/** Execute exactly one instruction without taking pending exceptions first. */
export const DBG_STEP_QUIET = 2

type Phase =
  | { kind: "none" }
  | { kind: "instr"; over: boolean; started: boolean; pc0: number; sp0: number }
  | { kind: "line"; into: boolean; key: number; sp: number; ipsr: number }
  /** Running at full speed to `addr` (a temporary breakpoint), then carrying on with `then`. */
  | { kind: "return"; addr: number; sp: number; ipsr: number; then: Phase }
  | { kind: "until"; addr: number; sp: number | null }

const NONE: Phase = { kind: "none" }
const FAULTS = new Set<number>([EXC.HARD_FAULT, EXC.MEM_MANAGE, EXC.BUS_FAULT, EXC.USAGE_FAULT])

export class CoreDebugger {
  readonly cpu: Cpu
  private firmware: Firmware | null = null
  private lineTable: LineTable | null = null
  private lineTableFor: Firmware | null = null
  private specs: BreakpointSpec[] = []
  /** Resolved user breakpoints: address → the breakpoint's id. */
  private user = new Map<number, string>()
  private temp: number | null = null
  private phase: Phase = NONE
  /** A stop waiting for the next boundary (a caught fault, a BKPT, a reset mid-step). */
  private pending: DebugStop | null = null
  /** The PC to run once quietly after a resume before breakpoints apply there again; −1 for none. */
  private resumeFrom = -1
  /** Where the core is stopped, when it is. */
  stop: DebugStop | null = null
  catchFaults = false
  /** Called when the core stops (the SoC ends its slice). */
  onStop: (() => void) | null = null

  constructor(cpu: Cpu) {
    this.cpu = cpu
  }

  get stopped() {
    return this.stop !== null
  }

  /** The line table of the loaded image, parsed the first time a step or a line breakpoint needs it. */
  get lines(): LineTable | null {
    const fw = this.firmware
    if (!fw?.image) return null
    if (this.lineTableFor !== fw) {
      this.lineTableFor = fw
      try {
        this.lineTable = LineTable.fromSections(elfSections(fw.image), elfAllocRanges(fw.image))
        this.lineTable.functions = functionRangesOf(fw)
      } catch {
        this.lineTable = null
      }
    }
    return this.lineTable
  }

  // --- configuration --------------------------------------------------------------------------

  /** A new image: breakpoints are resolved against it, and whatever was going on is over. */
  onLoad(fw: Firmware | null) {
    this.firmware = fw
    this.phase = NONE
    this.pending = null
    this.stop = null
    this.resumeFrom = -1
    this.temp = null
    this.resolve()
  }

  setBreakpoints(list: BreakpointSpec[]) {
    this.specs = list
    this.resolve()
  }

  private resolve() {
    this.user.clear()
    const fw = this.firmware
    if (fw) {
      for (const b of this.specs) {
        if (!b.enabled) continue
        for (const a of resolveSpec(b, fw, () => this.lines)) if (!this.user.has(a)) this.user.set(a, b.id)
      }
    }
    this.install()
  }

  /** The core's breakpoint set: the user's and the temporary one. */
  private install() {
    const want = new Set(this.user.keys())
    if (this.temp !== null) want.add(this.temp)
    const bps = this.cpu.breakpoints
    if (want.size === bps.size && [...want].every((a) => bps.has(a))) return
    bps.clear()
    for (const a of want) bps.add(a)
  }

  // --- going on -------------------------------------------------------------------------------

  /** Leave a stop: the next instruction runs, and the core goes on until something stops it. */
  resume() {
    const cpu = this.cpu
    if (this.stop?.reason === "bkpt" && /^bkpt\b/.test(cpu.instrAt(cpu.pc)?.text ?? "")) {
      // A BKPT stays where it is: going on means going past it (unless the PC was moved off it).
      cpu.pc = (cpu.pc + 2) >>> 0
      cpu.nextPc = cpu.pc
    }
    this.stop = null
    this.pending = null
    this.resumeFrom = cpu.pc
    this.setPhase(NONE)
  }

  step(req: StepRequest) {
    this.resume()
    const cpu = this.cpu
    switch (req.kind) {
      case "instruction":
        this.setPhase({ kind: "instr", over: !!req.over, started: false, pc0: cpu.pc, sp0: cpu.r[13] })
        break
      case "into":
      case "over": {
        const key = this.lines?.keyAt(cpu.pc) ?? -1
        // No line here (startup code, a library routine): a step is an instruction step.
        if (key <= 0) this.setPhase({ kind: "instr", over: req.kind === "over", started: false, pc0: cpu.pc, sp0: cpu.r[13] })
        else this.setPhase({ kind: "line", into: req.kind === "into", key, sp: cpu.r[13], ipsr: cpu.ipsr })
        break
      }
      case "until":
        this.setPhase({ kind: "until", addr: req.addr >>> 0, sp: req.sp ?? null })
        break
    }
  }

  private setPhase(p: Phase) {
    this.phase = p
    this.temp = p.kind === "return" || p.kind === "until" ? p.addr : null
    this.install()
    const cpu = this.cpu
    // While a line is stepped (and while a call made from it runs), a block must not run from
    // one line into another; blocks built so stay valid, only the ones from before must go.
    const stepping = p.kind === "line" || (p.kind === "return" && p.then.kind === "line")
    const line = stepping ? this.lines : null
    if (line && cpu.dbgSplit === null) {
      cpu.dbgSplit = (addr: number, start: number) => line.keyAt(addr) !== line.keyAt(start)
      cpu.flushBlocks()
    } else if (!line) cpu.dbgSplit = null
    this.refresh()
  }

  /** Whether the run loop must ask at every boundary, or only at breakpoint addresses. */
  private refresh() {
    const k = this.phase.kind
    this.cpu.dbgActive = this.pending !== null || this.resumeFrom >= 0 || k === "instr" || k === "line"
  }

  private finish(reason: StopReason, extra: Partial<DebugStop> = {}): number {
    this.stop = { reason, pc: this.cpu.pc, ...extra }
    this.phase = NONE
    this.temp = null
    this.install()
    this.cpu.dbgSplit = null
    this.refresh()
    this.onStop?.()
    return DBG_STOP
  }

  // --- the run loop's questions ---------------------------------------------------------------

  /** At an instruction boundary (before the instruction at the PC runs): go on, stop, or run one instruction quietly. */
  check(): number {
    const cpu = this.cpu
    const pc = cpu.pc
    if (this.stop) return DBG_STOP
    if (this.pending) {
      const p = this.pending
      this.pending = null
      return this.finish(p.reason, { ...p, pc })
    }
    if (this.resumeFrom === pc) {
      this.resumeFrom = -1
      const ph = this.phase
      if (ph.kind === "instr") ph.started = true
      this.refresh()
      return DBG_STEP_QUIET
    }
    this.resumeFrom = -1
    // An interrupt due now is taken before the instruction under the PC (an instruction step
    // holds it off, as a probe's single step does).
    if (this.phase.kind !== "instr" && cpu.exceptionDue()) {
      this.refresh()
      return DBG_GO
    }
    const bp = this.user.get(pc)
    if (bp !== undefined) return this.finish("breakpoint", { breakpoint: bp })
    let ph = this.phase
    if (ph.kind === "return" && pc === ph.addr) {
      // Back where the call (or the interrupt) returns to, unless this is a deeper activation of the same code.
      if (cpu.r[13] < ph.sp || cpu.ipsr !== ph.ipsr) return DBG_GO
      this.setPhase(ph.then)
      ph = this.phase
    }
    if (ph.kind === "until" && pc === ph.addr) {
      if (ph.sp !== null && cpu.r[13] < ph.sp) return DBG_GO
      return this.finish("step")
    }
    if (ph.kind === "instr") return this.checkInstruction(ph)
    if (ph.kind === "line") return this.checkLine(ph)
    this.refresh()
    return DBG_GO
  }

  private checkInstruction(ph: Phase & { kind: "instr" }): number {
    const cpu = this.cpu
    if (!ph.started) {
      ph.started = true
      return DBG_STEP_QUIET
    }
    // One instruction ran. A call stepped over runs to its return.
    if (ph.over) {
      const instr = cpu.instrAt(ph.pc0)
      const next = (ph.pc0 + (instr?.size ?? 2)) >>> 0
      if (instr && /^blx?\b/.test(instr.text) && cpu.pc !== next && (cpu.r[14] & ~1) >>> 0 === next) {
        this.setPhase({ kind: "until", addr: next, sp: ph.sp0 })
        return DBG_GO
      }
    }
    return this.finish("step")
  }

  private checkLine(ph: Phase & { kind: "line" }): number {
    const cpu = this.cpu
    const lines = this.lines
    if (!lines) return this.finish("step")
    const pc = cpu.pc
    if (cpu.ipsr !== ph.ipsr) return DBG_GO
    const key = lines.keyAt(pc)
    if (key === ph.key) return DBG_GO
    const fn = lines.functionAt(pc)
    if (fn && pc === fn.start && this.calledFrom(ph.key, lines)) {
      const ret = (cpu.r[14] & ~1) >>> 0
      if (!ph.into || key < 0) {
        this.setPhase({ kind: "return", addr: ret, sp: cpu.r[13], ipsr: ph.ipsr, then: ph })
        return DBG_GO
      }
      const body = lines.postPrologue(fn.start, fn.end)
      if (body === pc) return this.finish("step")
      this.setPhase({ kind: "until", addr: body, sp: null })
      return DBG_GO
    }
    // Code the compiler gave no line (line 0): part of whatever statement is being stepped.
    if (key === 0) return DBG_GO
    if (key < 0) return this.finish("step")
    if (!lines.isStmtStart(pc)) {
      // Returned into the caller, in the middle of its line: that is where it goes on from.
      if (cpu.r[13] > ph.sp) return this.finish("step")
      ph.key = key
      return DBG_GO
    }
    return this.finish("step")
  }

  /**
   * Whether the core has just entered a function by a call made from the line being stepped:
   * LR holds the address after a BL/BLX that belongs to that line.
   */
  private calledFrom(key: number, lines: LineTable): boolean {
    const lr = this.cpu.r[14]
    if ((lr & 1) === 0 || lr >>> 0 >= 0xf0000000) return false
    const ret = (lr & ~1) >>> 0
    for (const size of [4, 2]) {
      const at = (ret - size) >>> 0
      const instr = this.cpu.instrAt(at)
      if (instr && instr.size === size && /^blx?\b/.test(instr.text)) return lines.keyAt(at) === key
    }
    return false
  }

  /** The core is entering exception `exc` from a context that resumes at `ret` with SP `sp`. */
  onException(exc: number, ret: number, sp: number, ipsr: number) {
    if (this.catchFaults && FAULTS.has(exc)) {
      const fault = this.cpu.scs.faults[this.cpu.scs.faults.length - 1]
      this.pending = { reason: "exception", pc: 0, exception: exc, detail: fault?.detail }
      this.refresh()
      this.cpu.stop = true
      return
    }
    const ph = this.phase
    // An interrupt in the middle of a line step runs at full speed and the step carries on after it.
    if (ph.kind === "line" && ipsr === ph.ipsr) this.setPhase({ kind: "return", addr: ret >>> 0, sp, ipsr, then: ph })
  }

  /** A BKPT instruction ran: the core stops on it. */
  onBkpt(detail: string) {
    this.pending = { reason: "bkpt", pc: this.cpu.pc, detail }
    this.refresh()
  }

  /** The core was reset: whatever it was stopped at is gone, and a step in progress stops at the reset vector. */
  onReset() {
    const stepping = this.phase.kind !== "none" && !this.stop
    this.stop = null
    this.resumeFrom = -1
    this.pending = stepping ? { reason: "reset", pc: 0 } : null
    this.setPhase(NONE)
  }

  /** The user breakpoint addresses in effect (for tests and the status line). */
  addresses(): number[] {
    return [...this.user.keys()].sort((a, b) => a - b)
  }
}

/** Function ranges from an image's symbol table (the same the UI uses: `functionRanges` in debug/info). */
function functionRangesOf(fw: Firmware): FunctionRange[] {
  const fns = fw.symbols.filter((s) => s.type === "func").map((s) => ({ name: s.name, start: s.value, end: s.value + s.size }))
  fns.sort((a, b) => a.start - b.start || b.end - a.end)
  return fns
}

/** Where a breakpoint goes in an image: line breakpoints through the line table, functions past their prologue. */
export function resolveSpec(b: BreakpointSpec, fw: Firmware, lines: () => LineTable | null): number[] {
  switch (b.kind) {
    case "address":
      return [b.address >>> 0]
    case "line":
      return lines()?.resolve(b.path, b.line)?.addrs ?? []
    case "function": {
      const out: number[] = []
      for (const s of fw.symbols) {
        if (s.type !== "func" || (s.name !== b.name && demangle(s.name) !== b.name)) continue
        const table = lines()
        out.push(table ? table.postPrologue(s.value, s.value + s.size) : s.value)
      }
      return [...new Set(out)]
    }
  }
}

/**
 * The qualified name of an Itanium-mangled C++ function (`_ZN4Lab14tickEv` → `Lab1::tick`),
 * without its parameters: enough to put a function breakpoint on a method by name.
 */
export function demangle(name: string): string {
  if (!name.startsWith("_Z")) return name
  let i = 2
  const parts: string[] = []
  const source = () => {
    let n = 0
    while (i < name.length && name[i] >= "0" && name[i] <= "9") n = n * 10 + (name.charCodeAt(i++) - 48)
    const s = name.slice(i, i + n)
    i += n
    return s
  }
  if (name[i] === "N") {
    i++
    while (i < name.length && "rVK".includes(name[i])) i++
    while (i < name.length && name[i] !== "E") {
      if (name[i] >= "0" && name[i] <= "9") parts.push(source())
      else if (name.startsWith("C1", i) || name.startsWith("C2", i)) {
        parts.push(parts[parts.length - 1] ?? "")
        i += 2
      } else if (name.startsWith("D1", i) || name.startsWith("D2", i) || name.startsWith("D0", i)) {
        parts.push(`~${parts[parts.length - 1] ?? ""}`)
        i += 2
      } else return name
    }
  } else if (name[i] >= "0" && name[i] <= "9") parts.push(source())
  else return name
  return parts.join("::")
}
