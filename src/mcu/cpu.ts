/**
 * ARMv7-M core (Cortex-M4F): register file, program status, exception model and the
 * fetch–decode–execute loop. Instruction semantics live in decode.ts; this file owns
 * everything that is state.
 *
 * References: ARMv7-M Architecture Reference Manual (DDI 0403E), chapters B1 (exception
 * model), B3 (System Control Space) and A7 (instruction set).
 */
import { Bus, BusFault } from "./bus"
import { CORTEX_M4F, type CoreProfile } from "./chip"
import { decode, jitHelpers, type Instr } from "./decode"
import { compileBlock, type Compiled } from "./jit"
import { CpuHalt, EXC, ExceptionRequest } from "./faults"
import { Scs } from "./scs"
import { DBG_STEP_QUIET, DBG_STOP, type CoreDebugger } from "./debugger"

export { CpuHalt, EXC, ExceptionRequest, NUM_EXC, NUM_IRQ } from "./faults"

/**
 * The addresses the run loop stops at. Blocks never run through one, so a change drops the
 * decoded blocks (through `onChange`) and they are built again around the new set.
 */
export class BreakpointSet extends Set<number> {
  onChange: (() => void) | null = null
  add(addr: number) {
    if (!this.has(addr)) {
      super.add(addr >>> 0)
      this.onChange?.()
    }
    return this
  }
  delete(addr: number) {
    const had = super.delete(addr >>> 0)
    if (had) this.onChange?.()
    return had
  }
  clear() {
    if (this.size) {
      super.clear()
      this.onChange?.()
    }
  }
}

/** Thumb condition codes. */
export const COND = ["eq", "ne", "cs", "cc", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "al", "nv"]

/** Lines in the flash accelerator's instruction cache. */
const ART_LINES = 64
/** Slots in the hash over those lines: a quarter full, so probes stay short. */
const ART_HASH = 256
/** Home slot of a line: a Fibonacci hash in 32-bit integer arithmetic, its top bits. */
const artSlot = (line: number) => Math.imul(line, 0x9e3779b1) >>> 24
/** Longest straight-line block the run loop executes without returning to `step`. */
const BLOCK_MAX = 64
/** Instructions that (may) leave the straight line: a block ends after one of these. */
const FLOW = /^(?:b(?:l|lx|x)?(?:\.w|\.n)?(?:eq|ne|cs|cc|mi|pl|vs|vc|hi|ls|ge|lt|gt|le)?\s|cb(?:n)?z\s|tb[bh]\s|it\w*\s|svc\s|bkpt\s|udf|wf[ie]|msr\s|cps|isb|dsb|dmb|(?:pop|ldm\w*)\b.*\bpc\b|(?:ldr|mov|add|sub)\w*\s+pc\b)/

/**
 * A straight run of decoded instructions from one address to the next branch, executed by
 * the run loop with only the checks that matter between instructions; anything that leaves
 * the line (a taken branch, an exception, an IT block, sleep) ends it early.
 */
type Block = {
  addrs: Float64Array
  instrs: Instr[]
  n: number
  fn: Compiled | null
  lineShift: number
  /** The block this one last went on to, by the address it left for: chained without a lookup. */
  link: Block | null
  linkPc: number
}
/**
 * Decoded instructions and blocks of one 4 KB page, indexed by halfword. `inside` names a
 * block that runs through an address that is not a block start, and `heat` counts entries
 * there: an interrupt returns into the middle of blocks, and only an address entered often
 * enough gets a block (and a compilation) of its own.
 */
type CachePage = { instrs: (Instr | undefined)[]; blocks: (Block | undefined)[]; inside: ({ block: Block; index: number } | undefined)[]; heat: Uint16Array }
const emptyPage = (): CachePage => ({ instrs: [], blocks: [], inside: [], heat: new Uint16Array(0) })
/** Entries at an address inside another block before it becomes a block start of its own. */
const HOT = 32

export class Cpu {
  readonly bus: Bus
  readonly scs: Scs

  /** r0–r12, r13 = current SP; r14 = LR. PC is kept separately. */
  readonly r = new Uint32Array(16)
  /** Address of the instruction being executed (set by step) and of the next one to fetch. */
  pc = 0
  nextPc = 0
  /** Banked stack pointers: the one not selected is stored here. */
  msp = 0
  psp = 0

  // APSR
  n = 0
  z = 0
  c = 0
  v = 0
  q = 0
  ge = 0
  /** IPSR: exception number currently being handled, 0 in Thread mode. */
  ipsr = 0
  /** EPSR.IT bits: [7:5] = base condition, [4:0] = mask; 0 outside an IT block. */
  itstate = 0

  // Special-purpose mask and control registers.
  primask = 0
  faultmask = 0
  basepri = 0
  /** CONTROL: bit0 nPRIV, bit1 SPSEL, bit2 FPCA. */
  control = 0

  // FPv4-SP register file, shared buffer so bit patterns can be moved untouched.
  readonly fpBuffer = new ArrayBuffer(32 * 4)
  readonly s = new Float32Array(this.fpBuffer)
  readonly sBits = new Uint32Array(this.fpBuffer)
  readonly dBits = new Float64Array(this.fpBuffer)
  fpscr = 0
  /** What the FPU can do, from MVFR0.FPDP and MVFR2 (FPv5 misc features): the decoder faults on the rest. */
  readonly hasFp64: boolean
  readonly hasFpv5: boolean

  /** Cycles consumed since reset; approximate per-instruction costs. */
  cycles = 0
  instructions = 0
  /** Set while sleeping after WFI/WFE until a wake-up event (B1.5.19). */
  sleeping = false
  sleepKind: "wfi" | "wfe" = "wfi"
  /** Sleeping with SCR.SLEEPDEEP: the SoC has frozen its clocks (Stop/Standby), SysTick included. */
  deep = false
  /** Cycles spent asleep, for the supply-current estimate. */
  sleepCycles = 0
  /** The core went to sleep with SLEEPDEEP set: the SoC freezes the 1.2 V domain. */
  onDeepSleep: () => void = () => {}
  /** A deep sleep ended, before the first instruction runs: the SoC thaws and adds the wake-up latency. */
  onDeepWake: () => void = () => {}
  /** The WFE event register: SEV, exception entry, or (with SCR.SEVONPEND) a new pending interrupt. */
  eventRegister = false
  halted: CpuHalt | null = null

  /** Decoded instructions by address; flushed when flash is written. */
  /**
   * Decoded instructions by address, in 4 KB pages: a page is an array indexed by halfword,
   * and the page of the last fetch is kept at hand since most fetches stay on it.
   */
  private cache = new Map<number, CachePage>()
  private cachePageNo = -1
  private cachePage: CachePage = emptyPage()

  /**
   * Addresses the run loop stops at before executing. Without a debugger (`dbg`) a hit halts
   * the core, as the scripts use it; with one, the debugger decides (see debugger.ts).
   */
  readonly breakpoints = new BreakpointSet()
  /** The debug unit, once something debugs this core. */
  dbg: CoreDebugger | null = null
  /** The debugger asks to see every boundary the run loop passes: a step in progress, a stop to take. */
  dbgActive = false
  /** While a line is stepped: whether a block starting at `start` must end before `addr`. */
  dbgSplit: ((addr: number, start: number) => boolean) | null = null
  /**
   * Cycle count at which a peripheral event is due (a timer overflow or compare); the SoC sets
   * it and handles `onEvent`, so the core pays one compare per instruction for all timers.
   */
  nextEventCycle = Infinity
  onEvent: () => void = () => {}
  /** Set by AIRCR.SYSRESETREQ; the owner (the MCU model) performs the reset. */
  resetRequested = false
  /** Set by the owner (from `onEvent`) to end the current `run` early; cleared by `run`. */
  stop = false

  constructor(bus = new Bus(), core: CoreProfile = CORTEX_M4F) {
    this.bus = bus
    this.scs = new Scs(this, core)
    bus.attach(this.scs)
    this.hasFp64 = ((core.mvfr[0] >>> 8) & 0xf) === 2
    this.hasFpv5 = ((core.mvfr[2] >>> 4) & 0xf) !== 0
    this.breakpoints.onChange = () => this.flushBlocks()
  }

  /** Forget every decoded instruction and block: they are built again on the way. */
  flushBlocks() {
    this.cache.clear()
    this.cachePageNo = -1
    this.coldEntry = null
  }

  /** The instruction at an address, decoded outside the cache and the fetch timing (for the debugger); null when nothing is there. */
  instrAt(addr: number): Instr | null {
    try {
      const hw1 = this.bus.fetch16(addr)
      const wide = (hw1 & 0xf800) >= 0xe800
      return decode(hw1, wide ? this.bus.fetch16(addr + 2) : 0, addr, false)
    } catch {
      return null
    }
  }

  // --- reset --------------------------------------------------------------------

  /** Take the reset exception: SP and PC from the vector table at the given base. */
  reset(vectorBase = 0x08000000) {
    this.r.fill(0)
    this.n = this.z = this.c = this.v = this.q = this.ge = 0
    this.ipsr = 0
    this.itstate = 0
    this.primask = this.faultmask = this.basepri = 0
    this.control = 0
    this.sBits.fill(0)
    this.fpscr = 0
    this.cycles = 0
    this.sleepCycles = 0
    this.instructions = 0
    this.sleeping = false
    this.deep = false
    this.eventRegister = false
    this.halted = null
    this.cache.clear()
    this.cachePageNo = -1
    this.scs.reset()
    this.scs.vtor = vectorBase >>> 0
    this.msp = this.bus.read32(vectorBase) & ~3
    this.psp = 0
    this.r[13] = this.msp
    this.r[14] = 0xffffffff
    const entry = this.bus.read32(vectorBase + 4)
    // A reset vector without the Thumb bit (nothing at the boot address) locks the core up.
    if ((entry & 1) === 0) {
      this.pc = (entry & ~1) >>> 0
      this.halted = new CpuHalt("fault", `reset vector 0x${entry.toString(16)} at 0x${(vectorBase + 4).toString(16)} is not Thumb code: lockup`, this.pc)
      return
    }
    this.branchTo(entry)
    this.pc = this.nextPc
  }

  // --- program status helpers -------------------------------------------------------

  get apsr(): number {
    return ((this.n << 31) | (this.z << 30) | (this.c << 29) | (this.v << 28) | (this.q << 27) | (this.ge << 16)) >>> 0
  }
  set apsr(v: number) {
    this.n = (v >>> 31) & 1
    this.z = (v >>> 30) & 1
    this.c = (v >>> 29) & 1
    this.v = (v >>> 28) & 1
    this.q = (v >>> 27) & 1
    this.ge = (v >>> 16) & 0xf
  }
  /** xPSR as stacked on exception entry: APSR | IPSR | EPSR(T=1, IT). */
  get xpsr(): number {
    const it = this.itstate
    const epsr = (1 << 24) | ((it & 0x3) << 25) | ((it >>> 2) << 10)
    return (this.apsr | this.ipsr | epsr) >>> 0
  }
  set xpsr(v: number) {
    this.apsr = v
    this.ipsr = v & 0x1ff
    this.itstate = (((v >>> 25) & 0x3) | (((v >>> 10) & 0x3f) << 2)) & 0xff
  }

  get inITBlock() {
    return (this.itstate & 0xf) !== 0
  }
  get lastInITBlock() {
    return (this.itstate & 0xf) === 0x8
  }

  /** Condition code check (A7.3.1). */
  condPassed(cond: number): boolean {
    let result: boolean
    switch (cond >>> 1) {
      case 0:
        result = this.z === 1
        break
      case 1:
        result = this.c === 1
        break
      case 2:
        result = this.n === 1
        break
      case 3:
        result = this.v === 1
        break
      case 4:
        result = this.c === 1 && this.z === 0
        break
      case 5:
        result = this.n === this.v
        break
      case 6:
        result = this.n === this.v && this.z === 0
        break
      default:
        result = true
    }
    if (cond & 1 && cond !== 15) result = !result
    return result
  }

  /** SP as seen by software follows CONTROL.SPSEL; keep the banked copy in sync. */
  get spsel() {
    return (this.control >>> 1) & 1
  }
  setControl(v: number) {
    const newSel = (v >>> 1) & 1
    if (newSel !== this.spsel) {
      if (this.spsel) this.psp = this.r[13]
      else this.msp = this.r[13]
      this.r[13] = newSel ? this.psp : this.msp
    }
    this.control = v & 7
  }
  getMsp() {
    return this.spsel ? this.msp : this.r[13]
  }
  getPsp() {
    return this.spsel ? this.r[13] : this.psp
  }
  setMsp(v: number) {
    if (this.spsel) this.msp = v >>> 0
    else this.r[13] = v >>> 0
  }
  setPsp(v: number) {
    if (this.spsel) this.r[13] = v >>> 0
    else this.psp = v >>> 0
  }

  /** Reading r15 within an instruction: address of the instruction + 4. */
  readPc() {
    return (this.pc + 4) >>> 0
  }

  /** BX/BLX/POP{pc}/LDR pc: interworking branch, handling EXC_RETURN in Handler mode. */
  branchTo(addr: number) {
    addr >>>= 0
    if (this.ipsr !== 0 && addr >= 0xf0000000) {
      this.exceptionReturn(addr)
      return
    }
    if ((addr & 1) === 0) {
      // Clearing T is a UsageFault (INVSTATE); real code never does this on purpose.
      throw new CpuHalt("fault", `branch to ARM state at 0x${addr.toString(16)}`, this.pc)
    }
    this.nextPc = addr & ~1
  }

  /** B/BL/conditional branch: plain Thumb target, bit 0 ignored. */
  branchWritePc(addr: number) {
    this.nextPc = (addr & ~1) >>> 0
  }

  // --- exception model (B1.5) -------------------------------------------------------

  /**
   * Priority currently executing, taking BASEPRI/PRIMASK/FAULTMASK into account (B1.5.4).
   * `forWakeup` ignores PRIMASK and FAULTMASK: a masked interrupt still wakes WFI/WFE (B1.5.19).
   */
  executionPriority(forWakeup = false): number {
    let highest = 256
    // BASEPRI boosts to its group priority; PRIMASK to 0; FAULTMASK to −1.
    if (this.basepri !== 0) highest = this.basepri & this.scs.groupMask
    if (!forWakeup) {
      if (this.primask) highest = 0
      if (this.faultmask) highest = -1
    }
    return Math.min(highest, this.scs.highestActivePriority())
  }

  /** Whether a pending exception is taken before the next instruction. */
  exceptionDue(): boolean {
    return this.scs.pendingCount !== 0 && this.scs.pendingToTake(this.executionPriority()) !== 0
  }

  /** Whether a sleeping core should resume; consumes the event register for WFE. */
  wakeup(): boolean {
    if (this.scs.pendingToTake(this.executionPriority(true)) !== 0) return true
    if (this.sleepKind === "wfe" && this.eventRegister) {
      this.eventRegister = false
      return true
    }
    return false
  }

  /** WFE: return at once when an event is already registered, else sleep until one arrives. */
  waitForEvent() {
    if (this.eventRegister) {
      this.eventRegister = false
      return
    }
    this.enterSleep("wfe")
  }
  waitForInterrupt() {
    this.enterSleep("wfi")
  }
  private enterSleep(kind: "wfi" | "wfe") {
    this.sleepKind = kind
    this.sleeping = true
    if (this.scs.scr & 4) {
      // SysTick stops with the clocks: bring it up to now, and let it resume from the wake-up.
      this.scs.sync(this.cycles)
      this.deep = true
      this.onDeepSleep()
    }
  }
  /** A wake-up event: back to executing (after the SoC's deep-sleep exit, when it was one). */
  private leaveSleep() {
    this.sleeping = false
    if (this.deep) {
      this.deep = false
      this.onDeepWake()
      this.scs.resume(this.cycles)
    }
  }

  requestReset() {
    this.resetRequested = true
  }

  /** Enter `exc` now: push the context frame, switch to Handler mode, fetch the vector. */
  exceptionEntry(exc: number) {
    if (this.dbg !== null) this.dbg.onException(exc, this.returnAddress(exc), this.r[13], this.ipsr)
    const spsel = this.spsel
    const framePtrAlign = 8
    const fp = (this.control & 4) !== 0
    const frameSize = fp ? 0x68 : 0x20
    // B1.5.6: frame is 8-byte aligned when STKALIGN (always set on v7-M).
    let sp = this.r[13]
    const align = (sp & 4) !== 0 ? 1 : 0
    sp = (sp - frameSize) & ~(framePtrAlign - 1)
    const bus = this.bus
    bus.write32(sp, this.r[0])
    bus.write32(sp + 4, this.r[1])
    bus.write32(sp + 8, this.r[2])
    bus.write32(sp + 12, this.r[3])
    bus.write32(sp + 16, this.r[12])
    bus.write32(sp + 20, this.r[14])
    bus.write32(sp + 24, this.returnAddress(exc))
    bus.write32(sp + 28, (this.xpsr & ~(1 << 9)) | (align << 9))
    if (fp) {
      // Non-lazy stacking of s0–s15 and FPSCR (ASPEN=1, LSPEN treated as 0).
      for (let i = 0; i < 16; i++) bus.write32(sp + 32 + i * 4, this.sBits[i])
      bus.write32(sp + 96, this.fpscr)
    }
    this.r[13] = sp
    // EXC_RETURN encodes the mode and stack of the interrupted context.
    let excReturn = 0xffffffe1
    if (this.ipsr === 0) excReturn |= 8
    if (this.ipsr === 0 && spsel) excReturn |= 4
    if (!fp) excReturn |= 0x10
    // Handler mode always runs on MSP.
    if (spsel) {
      this.psp = this.r[13]
      this.r[13] = this.msp
    }
    this.control &= ~(4 | 2)
    this.r[14] = excReturn >>> 0
    this.ipsr = exc
    this.itstate = 0
    this.eventRegister = true
    this.scs.setActive(exc, true)
    this.scs.setPending(exc, false)
    const vector = this.bus.read32(this.scs.vtor + exc * 4)
    this.nextPc = (vector & ~1) >>> 0
    this.cycles += 12
  }

  /** The address to resume at, per exception type (B1.5.6, table of preferred return addresses). */
  private returnAddress(exc: number): number {
    // Synchronous faults raised by an instruction return to it; everything else to the next.
    // Faults are reported from within an instruction before nextPc is committed, so pc is it.
    switch (exc) {
      case EXC.BUS_FAULT:
      case EXC.MEM_MANAGE:
      case EXC.USAGE_FAULT:
      case EXC.HARD_FAULT:
        return this.pc
      default:
        return this.nextPc
    }
  }

  /** Return from the handler using the EXC_RETURN value (B1.5.8). */
  exceptionReturn(excReturn: number) {
    const returning = this.ipsr
    this.scs.setActive(returning, false)
    const toThread = (excReturn & 8) !== 0
    const usePsp = (excReturn & 4) !== 0
    const fp = (excReturn & 0x10) === 0
    // Returning to another handler stays on MSP; IPSR then comes from the frame.
    const sp = toThread && usePsp ? this.psp : this.r[13]
    const bus = this.bus
    this.r[0] = bus.read32(sp)
    this.r[1] = bus.read32(sp + 4)
    this.r[2] = bus.read32(sp + 8)
    this.r[3] = bus.read32(sp + 12)
    this.r[12] = bus.read32(sp + 16)
    this.r[14] = bus.read32(sp + 20)
    const pc = bus.read32(sp + 24)
    const psr = bus.read32(sp + 28)
    if (fp) {
      for (let i = 0; i < 16; i++) this.sBits[i] = bus.read32(sp + 32 + i * 4)
      this.fpscr = bus.read32(sp + 96)
    }
    const frameSize = fp ? 0x68 : 0x20
    let newSp = (sp + frameSize) >>> 0
    if (psr & (1 << 9)) newSp += 4
    this.xpsr = psr
    // IPSR comes from the frame: 0 when returning to Thread mode.
    if (toThread) {
      this.ipsr = 0
      if (usePsp) {
        this.msp = this.r[13]
        this.r[13] = newSp
        this.control |= 2
      } else {
        this.r[13] = newSp
        this.control &= ~2
      }
    } else {
      this.r[13] = newSp
      this.control &= ~2
    }
    if (fp) this.control |= 4
    else this.control &= ~4
    this.nextPc = (pc & ~1) >>> 0
    this.cycles += 10
    // A pending exception that can preempt the returned-to context is taken by the next step,
    // which is what tail-chaining looks like from software.
    // SCR.SLEEPONEXIT: back in Thread mode the core goes straight back to sleep (B1.5.19).
    if (toThread && this.scs.scr & 2 && this.scs.pendingToTake(this.executionPriority()) === 0) this.enterSleep("wfi")
  }

  /** CPACR grants CP10/CP11 (kept by the SCS), so compiled FP snippets test one flag. */
  fpOn = false
  /** An FP instruction with CP10/CP11 access off in CPACR (compiled blocks call this). */
  fpDenied(pc: number): never {
    this.pc = pc
    this.fault(EXC.USAGE_FAULT, "coprocessor access denied (CPACR)")
  }

  /** Raise a synchronous fault from within an instruction. */
  fault(exc: number, detail: string): never {
    this.scs.recordFault(exc, detail, this.pc)
    throw new ExceptionRequest(exc)
  }

  // --- execution ------------------------------------------------------------------

  /**
   * Flash timing, set by the FLASH interface from ACR: wait states on a line fetch, and the
   * prefetch buffer / accelerator cache that hide them. Lines are 128-bit on the F4's ART,
   * 256-bit on the F7's. `dataLines` is the data cache depth (DCEN: 8 lines).
   */
  private timing = { latency: 0, prefetch: false, cache: false, lineBytes: 16, dataLines: 0 }
  /** Whether fetches pay wait states at all, kept as one flag for the compiled blocks. */
  timed = false
  get flashTiming() {
    return this.timing
  }
  set flashTiming(t) {
    this.timing = t
    this.timed = t.latency !== 0
  }
  /** Compile blocks to JavaScript (jit.ts); off runs them through the instruction closures. */
  jit = true
  /** log2 of the line size, kept apart so the per-fetch check is one shift and one compare. */
  lineShift = 4
  /** Address ranges that are flash (with its aliases), for the timing above; kept as a 64 KB page map for the check. */
  private flashPages = new Uint8Array(1 << 16)
  set flashRanges(ranges: [number, number][]) {
    this.flashPages.fill(0)
    for (const [lo, hi] of ranges) for (let p = lo >>> 16; p <= (hi - 1) >>> 16; p++) this.flashPages[p] = 1
  }
  private lastLine = -1
  /**
   * The accelerator's 64 lines: a FIFO ring of line numbers for eviction and an open-addressed
   * hash of the same (-1 empty) for the lookup on every line change.
   */
  private readonly artRing = new Int32Array(ART_LINES).fill(-1)
  private artNext = 0
  private readonly artHash = new Int32Array(ART_HASH).fill(-1)
  /** The data cache's lines (DCEN), a FIFO of at most `dataLines` line numbers. */
  private readonly dataRing = new Int32Array(64).fill(-1)
  private dataNext = 0
  /** ICRST / ARTRST: forget the cached lines. */
  resetFlashCaches() {
    this.artRing.fill(-1)
    this.artHash.fill(-1)
    this.artNext = 0
    this.dataRing.fill(-1)
    this.dataNext = 0
    this.lastLine = -1
  }
  private artHas(line: number) {
    const h = this.artHash
    for (let i = artSlot(line); ; i = (i + 1) & (ART_HASH - 1)) {
      const v = h[i]
      if (v === line) return true
      if (v === -1) return false
    }
  }
  private artAdd(line: number) {
    const h = this.artHash
    const old = this.artRing[this.artNext]
    if (old !== -1) {
      // Backward-shift deletion keeps every probe chain intact without tombstones.
      let i = artSlot(old)
      while (h[i] !== old) i = (i + 1) & (ART_HASH - 1)
      let j = i
      for (;;) {
        j = (j + 1) & (ART_HASH - 1)
        const v = h[j]
        if (v === -1) break
        const home = artSlot(v)
        // v may move down to i if its home is not in (i, j].
        if (i <= j ? home <= i || home > j : home <= i && home > j) {
          h[i] = v
          i = j
        }
      }
      h[i] = -1
    }
    this.artRing[this.artNext] = line
    this.artNext = (this.artNext + 1) & (ART_LINES - 1)
    let i = artSlot(line)
    while (h[i] !== -1) i = (i + 1) & (ART_HASH - 1)
    h[i] = line
  }
  private inFlash(addr: number) {
    return this.flashPages[addr >>> 16] === 1
  }
  /** A fetch from a new flash line: pay the wait states unless prefetched or cached. */
  private fetchPenalty(addr: number, line: number) {
    this.cycles += this.fetchCost(addr, line)
  }
  /** The wait states a fetch from a new flash line costs, and the caches' bookkeeping. */
  fetchCost(addr: number, line: number): number {
    const t = this.timing
    const sequential = line === this.lastLine + 1
    this.lastLine = line
    if (!this.inFlash(addr)) return 0
    if (t.cache && this.artHas(line)) return 0
    if (t.cache) this.artAdd(line)
    return t.prefetch && sequential ? 0 : t.latency
  }
  /** A data read from flash (literal pools, tables): the wait states unless the data cache has the line. */
  dataPenalty(addr: number) {
    const t = this.timing
    if (!t.latency) return
    this.bus.slow = true
    const line = addr >>> this.lineShift
    const lines = t.dataLines
    if (lines) {
      const ring = this.dataRing
      for (let i = 0; i < lines; i++) if (ring[i] === line) return
      ring[this.dataNext] = line
      this.dataNext = (this.dataNext + 1) % lines
    }
    this.cycles += t.latency
  }

  /** Decode the instruction at `addr`, through the cache when it lives in flash. */
  fetch(addr: number): Instr {
    if (this.bus.flashDirty) {
      this.cache.clear()
    this.cachePageNo = -1
      this.bus.flashDirty = false
    }
    if (this.flashTiming.latency) {
      const line = addr >>> this.lineShift
      if (line !== this.lastLine) this.fetchPenalty(addr, line)
    }
    return this.decodeAt(addr)
  }

  /** The cache page holding `addr`, made on first use. */
  private pageOf(addr: number): CachePage {
    const pageNo = addr >>> 12
    if (pageNo === this.cachePageNo) return this.cachePage
    let page = this.cache.get(pageNo)
    if (page === undefined) {
      page = { instrs: new Array(2048).fill(undefined), blocks: new Array(2048).fill(undefined), inside: new Array(2048).fill(undefined), heat: new Uint16Array(2048) }
      this.cache.set(pageNo, page)
    }
    this.cachePageNo = pageNo
    this.cachePage = page
    return page
  }

  /** The decoded instruction at `addr`, without the fetch timing. */
  private decodeAt(addr: number): Instr {
    const page = this.pageOf(addr)
    let instr = page.instrs[(addr & 0xfff) >>> 1]
    if (instr !== undefined) return instr
    const hw1 = this.bus.fetch16(addr)
    const wide = (hw1 & 0xf800) >= 0xe800
    const hw2 = wide ? this.bus.fetch16(addr + 2) : 0
    instr = decode(hw1, hw2, addr, this.inITBlock)
    if (addr < 0x20000000) page.instrs[(addr & 0xfff) >>> 1] = instr
    return instr
  }

  /**
   * The block starting at `addr` (flash only), built on first use up to the next branch.
   * An address inside another block is run from there through the interpreter (`runBlock`
   * from that index) until it has been entered HOT times; then it gets its own block.
   */
  private blockAt(addr: number): Block | null {
    if (addr >= 0x20000000) return null
    const page = this.pageOf(addr)
    const slot = (addr & 0xfff) >>> 1
    let block = page.blocks[slot]
    if (block !== undefined) return block
    const holder = page.inside[slot]
    if (holder !== undefined && page.heat[slot] < HOT) {
      page.heat[slot]++
      this.coldEntry = holder
      return null
    }
    const addrs: number[] = []
    const instrs: Instr[] = []
    let at = addr
    const bps = this.breakpoints
    const split = this.dbgSplit
    for (let i = 0; i < BLOCK_MAX && at < 0x20000000; i++) {
      // A block ends before a breakpoint (the run loop looks at each one) and, while a line is
      // being stepped, before another line starts.
      if (i > 0 && ((bps.size !== 0 && bps.has(at)) || (split !== null && split(at, addr)))) break
      let instr: Instr
      try {
        instr = this.decodeAt(at)
      } catch (e) {
        // Off the end of memory: the line ends where the instructions do.
        if (e instanceof BusFault && i > 0) break
        throw e
      }
      addrs.push(at)
      instrs.push(instr)
      at = (at + instr.size) >>> 0
      const br = instr.jsBranch
      if (br !== undefined) {
        // The block follows a static branch: a jump or call goes on at its target, a
        // conditional one at the target when it points back (a loop) and at the
        // fall-through otherwise. Never round into itself: a loop closes through the link.
        const follow = br.cond === null || br.target < addrs[0] ? br.target : at
        // Closing on its own start is a loop the compiled code keeps inside the block.
        if (br.target === addrs[0] || addrs.includes(follow) || follow >= 0x20000000) break
        at = follow
        continue
      }
      if (FLOW.test(instr.text)) break
    }
    block = { addrs: Float64Array.from(addrs), instrs, n: instrs.length, fn: null, lineShift: this.lineShift, link: null, linkPc: -1 }
    if (this.jit) block.fn = compileBlock(addrs, instrs, this.lineShift)
    page.blocks[slot] = block
    for (let i = 1; i < addrs.length; i++) {
      const p = this.pageOf(addrs[i])
      const k = (addrs[i] & 0xfff) >>> 1
      if (p.inside[k] === undefined) p.inside[k] = { block, index: i }
    }
    this.cachePageNo = -1
    return block
  }
  /** Set by `blockAt` for an address it declined to start a block at: where to interpret from. */
  private coldEntry: { block: Block; index: number } | null = null

  /** Whatever came due by the current cycle count: the SysTick, a peripheral event. */
  service() {
    if (this.cycles >= this.scs.systDue) this.scs.sync(this.cycles)
    if (this.cycles >= this.nextEventCycle) this.onEvent()
  }
  /** Cycles the interpreter/compiled code compare against before the next instruction. */
  deadline(target: number): number {
    const a = this.scs.systDue
    const b = this.nextEventCycle
    return a < b ? (a < target ? a : target) : b < target ? b : target
  }

  /**
   * Run the compiled form of a block; faults raised inside it are taken as `step` would,
   * with the state the code flushed before the instruction that raised them.
   */
  private runCompiled(block: Block, target: number) {
    const bps = this.breakpoints
    try {
      for (;;) {
        block.fn!(this, this.r, this.bus, this.s, block.instrs, jitHelpers, target)
        // A block leaving on a taken branch has not looked at the deadline since its last
        // instruction: what came due is taken now, as the run loop would. Then straight on to
        // the next block while nothing needs the run loop's attention — a breakpoint where the
        // next one starts, or a debugger watching every boundary, does.
        this.service()
        if (this.dbgActive || this.cycles >= target || this.stop || this.sleeping || this.itstate !== 0 || this.scs.pendingCount !== 0 || this.bus.flashDirty) return
        const pc = this.pc
        if (bps.size !== 0 && bps.has(pc)) return
        let next: Block | null
        if (block.linkPc === pc) next = block.link
        else {
          next = this.blockAt(pc)
          if (next === null) {
            this.coldEntry = null
            return
          }
          block.link = next
          block.linkPc = pc
        }
        if (next === null || next.fn === null || next.lineShift !== this.lineShift) return
        block = next
      }
    } catch (e) {
      // The instruction that raised it is the one at the PC the code left; the frame's return
      // address is the instruction after it, as `step` would have set up.
      let i = 0
      while (i < block.n - 1 && block.addrs[i] !== this.pc) i++
      // A BKPT with a debugger attached is a stop on the instruction, not a halt.
      if (e instanceof CpuHalt && e.reason === "bkpt" && this.dbg !== null) {
        this.instructions += i
        this.dbg.onBkpt(e.detail)
        return
      }
      const instr = block.instrs[i]
      if (instr.js !== undefined) this.nextPc = (this.pc + instr.size) >>> 0
      if (e instanceof ExceptionRequest) {
        this.exceptionEntry(e.exc)
      } else if (e instanceof BusFault) {
        this.scs.recordFault(EXC.BUS_FAULT, e.message, this.pc)
        this.exceptionEntry(this.scs.escalate(EXC.BUS_FAULT))
      } else if (e instanceof CpuHalt) {
        this.halted = e
        throw e
      } else throw e
      // The instruction that faulted counts as executed; the handler runs from the next block.
      this.pc = this.nextPc
      this.cycles += instr.cycles
      this.instructions += i + 1
      this.bus.slow = false
    }
  }

  /**
   * Execute the block at the current PC until the line is left, the slice ends at `target`
   * cycles, or something between instructions needs the full `step` path (a pending
   * exception, an IT block, sleep, a stop request).
   */
  private runBlock(block: Block, target: number, from = 0) {
    const { addrs, instrs, n } = block
    const scs = this.scs
    let pc = this.pc
    let i = from
    try {
      for (; i < n; i++) {
        if (this.timed) {
          const line = pc >>> this.lineShift
          if (line !== this.lastLine) this.fetchPenalty(pc, line)
        }
        const instr = instrs[i]
        this.pc = pc
        this.nextPc = (pc + instr.size) >>> 0
        instr.exec(this)
        pc = this.pc = this.nextPc
        const cycles = (this.cycles += instr.cycles)
        if (cycles >= scs.systDue) scs.sync(cycles)
        if (cycles >= this.nextEventCycle) this.onEvent()
        // Left the line, or something the plain step path must look at first.
        if (i + 1 < n && pc !== addrs[i + 1]) {
          this.instructions += i + 1 - from
          return
        }
        if (cycles >= target || this.stop || this.sleeping || this.itstate !== 0 || scs.pendingCount !== 0) {
          this.instructions += i + 1 - from
          return
        }
      }
      this.instructions += n - from
    } catch (e) {
      if (e instanceof ExceptionRequest) {
        this.exceptionEntry(e.exc)
      } else if (e instanceof BusFault) {
        this.scs.recordFault(EXC.BUS_FAULT, e.message, this.pc)
        this.exceptionEntry(this.scs.escalate(EXC.BUS_FAULT))
      } else if (e instanceof CpuHalt && e.reason === "bkpt" && this.dbg !== null) {
        // A stop on the BKPT itself: the PC stays on it.
        this.instructions += i - from
        this.dbg.onBkpt(e.detail)
        return
      } else if (e instanceof CpuHalt) {
        this.halted = e
        throw e
      } else throw e
      // The instruction that faulted counts as executed; the handler runs from the next block.
      this.pc = this.nextPc
      this.cycles += instrs[i].cycles
      this.instructions += i + 1 - from
    }
  }

  /**
   * Execute one instruction (or take a pending exception). Returns cycles spent. `quiet`
   * leaves pending exceptions for later: the debugger's single step, which runs exactly the
   * instruction at the PC.
   */
  step(quiet = false): number {
    const before = this.cycles
    // Pending exceptions are taken between instructions.
    const pend = !quiet && this.scs.anyPending() ? this.scs.pendingToTake(this.executionPriority()) : 0
    if (pend !== 0) {
      if (this.sleeping) this.leaveSleep()
      this.nextPc = this.pc
      this.exceptionEntry(pend)
      this.pc = this.nextPc
      // The debugger (or a breakpoint on it) gets to look at the handler's first instruction before it runs.
      if (this.dbgActive || (this.breakpoints.size !== 0 && this.breakpoints.has(this.pc))) return this.cycles - before
    }
    if (this.sleeping && this.wakeup()) this.leaveSleep()
    if (this.sleeping) {
      this.cycles += 1
      this.sleepCycles += 1
      if (!this.deep && this.cycles >= this.scs.systDue) this.scs.sync(this.cycles)
      return 1
    }
    const pc = this.pc
    let instr: Instr
    try {
      instr = this.fetch(pc)
    } catch (e) {
      if (e instanceof BusFault) {
        this.halted = new CpuHalt("fault", `instruction fetch: ${e.message}`, pc)
        throw this.halted
      }
      throw e
    }
    this.nextPc = (pc + instr.size) >>> 0
    // IT block: check the condition for this instruction, then advance ITSTATE.
    let execute = true
    if (this.itstate !== 0) {
      const cond = this.itstate >>> 4
      execute = this.condPassed(cond)
      const mask = this.itstate & 0xf
      this.itstate = (mask & 7) === 0 ? 0 : (this.itstate & 0xe0) | ((this.itstate << 1) & 0x1f)
    }
    if (execute) {
      try {
        instr.exec(this)
      } catch (e) {
        if (e instanceof ExceptionRequest) {
          this.exceptionEntry(e.exc)
        } else if (e instanceof BusFault) {
          this.scs.recordFault(EXC.BUS_FAULT, e.message, pc)
          this.exceptionEntry(this.scs.escalate(EXC.BUS_FAULT))
        } else if (e instanceof CpuHalt && e.reason === "bkpt" && this.dbg !== null) {
          // A stop on the BKPT itself: nothing of it happens, the PC stays on it.
          this.pc = pc
          this.dbg.onBkpt(e.detail)
          return this.cycles - before
        } else if (e instanceof CpuHalt) {
          this.halted = e
          throw e
        } else throw e
      }
    }
    this.pc = this.nextPc
    this.cycles += instr.cycles
    this.instructions++
    if (this.cycles >= this.scs.systDue) this.scs.sync(this.cycles)
    if (this.cycles >= this.nextEventCycle) this.onEvent()
    return this.cycles - before
  }

  /** Run for at least `cycles` cycles; stops early when halted. Returns cycles actually spent. */
  run(cycles: number): number {
    const target = this.cycles + cycles
    const start = this.cycles
    this.stop = false
    const bps = this.breakpoints
    const dbg = this.dbg
    while (this.cycles < target && !this.stop) {
      if (this.sleeping) {
        // Nothing to execute until a wake-up event: jump straight to the next timer event
        // (SysTick is stopped along with the rest of the clocks in a deep sleep).
        if (this.wakeup()) {
          this.leaveSleep()
          // Awake: what woke the core goes at once, in this slice, unless the debugger is to
          // look at the boundary first (a step in progress, a breakpoint on the next instruction).
          if (dbg === null || !(this.dbgActive || (bps.size !== 0 && bps.has(this.pc)))) this.step()
        } else {
          const skip = Math.max(1, Math.min(target - this.cycles, this.deep ? Infinity : this.scs.systDue - this.cycles, this.nextEventCycle - this.cycles))
          this.cycles += skip
          this.sleepCycles += skip
          if (!this.deep && this.cycles >= this.scs.systDue) this.scs.sync(this.cycles)
          if (this.cycles >= this.nextEventCycle) this.onEvent()
        }
        continue
      }
      if (dbg !== null) {
        if (this.dbgActive || (bps.size !== 0 && bps.has(this.pc))) {
          const act = dbg.check()
          if (act === DBG_STOP) break
          if (act === DBG_STEP_QUIET) {
            this.step(true)
            continue
          }
        }
      } else if (bps.size !== 0 && bps.has(this.pc)) {
        this.halted = new CpuHalt("bkpt", "breakpoint", this.pc)
        break
      }
      if (this.itstate === 0 && this.scs.pendingCount === 0) {
        // The common case: nothing pending, no IT block — run the straight line as a block.
        if (this.bus.flashDirty) this.fetch(this.pc)
        const block = this.blockAt(this.pc)
        if (block !== null) {
          if (block.fn !== null && block.lineShift === this.lineShift) {
            this.runCompiled(block, target)
            this.service()
          } else this.runBlock(block, target)
          continue
        }
        const cold = this.coldEntry
        if (cold !== null) {
          this.coldEntry = null
          this.runBlock(cold.block, target, cold.index)
          continue
        }
      }
      this.step()
    }
    return this.cycles - start
  }
}
