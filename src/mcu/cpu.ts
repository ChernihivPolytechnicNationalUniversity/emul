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
import { decode, type Instr } from "./decode"
import { CpuHalt, EXC, ExceptionRequest } from "./faults"
import { Scs } from "./scs"



export { CpuHalt, EXC, ExceptionRequest, NUM_EXC, NUM_IRQ } from "./faults"

/** Thumb condition codes. */
export const COND = ["eq", "ne", "cs", "cc", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "al", "nv"]

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
  private cache = new Map<number, Instr>()

  /** Addresses the run loop stops at before executing. */
  breakpoints = new Set<number>()
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
    }
  }

  requestReset() {
    this.resetRequested = true
  }

  /** Enter `exc` now: push the context frame, switch to Handler mode, fetch the vector. */
  exceptionEntry(exc: number) {
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
  flashTiming = { latency: 0, prefetch: false, cache: false, lineBytes: 16, dataLines: 0 }
  /** log2 of the line size, kept apart so the per-fetch check is one shift and one compare. */
  lineShift = 4
  /** Address ranges that are flash (with its aliases), for the timing above. */
  flashRanges: [number, number][] = []
  private lastLine = -1
  private readonly artLines = new Map<number, true>()
  private readonly dataCacheLines = new Map<number, true>()
  /** ICRST / ARTRST: forget the cached lines. */
  resetFlashCaches() {
    this.artLines.clear()
    this.dataCacheLines.clear()
    this.lastLine = -1
  }
  private inFlash(addr: number) {
    for (const [lo, hi] of this.flashRanges) if (addr >= lo && addr < hi) return true
    return false
  }
  /** A fetch from a new flash line: pay the wait states unless prefetched or cached. */
  private fetchPenalty(addr: number, line: number) {
    const t = this.flashTiming
    const sequential = line === this.lastLine + 1
    this.lastLine = line
    if (!this.inFlash(addr)) return
    if (t.cache && this.artLines.has(line)) return
    if (!(t.prefetch && sequential)) this.cycles += t.latency
    if (t.cache) {
      this.artLines.set(line, true)
      if (this.artLines.size > 64) this.artLines.delete(this.artLines.keys().next().value!)
    }
  }
  /** A data read from flash (literal pools, tables): the wait states unless the data cache has the line. */
  dataPenalty(addr: number) {
    const t = this.flashTiming
    if (!t.latency) return
    const line = addr >>> this.lineShift
    if (t.dataLines) {
      if (this.dataCacheLines.has(line)) return
      this.dataCacheLines.set(line, true)
      if (this.dataCacheLines.size > t.dataLines) this.dataCacheLines.delete(this.dataCacheLines.keys().next().value!)
    }
    this.cycles += t.latency
  }

  /** Decode the instruction at `addr`, through the cache when it lives in flash. */
  fetch(addr: number): Instr {
    if (this.bus.flashDirty) {
      this.cache.clear()
      this.bus.flashDirty = false
    }
    if (this.flashTiming.latency) {
      const line = addr >>> this.lineShift
      if (line !== this.lastLine) this.fetchPenalty(addr, line)
    }
    let instr = this.cache.get(addr)
    if (instr) return instr
    const hw1 = this.bus.fetch16(addr)
    const wide = (hw1 & 0xf800) >= 0xe800
    const hw2 = wide ? this.bus.fetch16(addr + 2) : 0
    instr = decode(hw1, hw2, addr, this.inITBlock)
    if (addr < 0x20000000) this.cache.set(addr, instr)
    return instr
  }

  /** Execute one instruction (or take a pending exception). Returns cycles spent. */
  step(): number {
    const before = this.cycles
    // Pending exceptions are taken between instructions.
    const pend = this.scs.pendingToTake(this.executionPriority())
    if (pend !== 0) {
      if (this.sleeping) this.leaveSleep()
      this.nextPc = this.pc
      this.exceptionEntry(pend)
      this.pc = this.nextPc
    }
    if (this.sleeping && this.wakeup()) this.leaveSleep()
    if (this.sleeping) {
      this.cycles += 1
      this.sleepCycles += 1
      if (!this.deep) this.scs.tick(1)
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
        } else if (e instanceof CpuHalt) {
          this.halted = e
          throw e
        } else throw e
      }
    }
    this.pc = this.nextPc
    this.cycles += instr.cycles
    this.instructions++
    const spent = this.cycles - before
    this.scs.tick(spent)
    if (this.cycles >= this.nextEventCycle) this.onEvent()
    return spent
  }

  /** Run for at least `cycles` cycles; stops early when halted. Returns cycles actually spent. */
  run(cycles: number): number {
    const target = this.cycles + cycles
    const start = this.cycles
    this.stop = false
    while (this.cycles < target && !this.stop) {
      if (this.sleeping) {
        // Nothing to execute until a wake-up event: jump straight to the next timer event
        // (SysTick is stopped along with the rest of the clocks in a deep sleep).
        if (this.wakeup()) this.leaveSleep()
        else {
          const skip = Math.max(1, Math.min(target - this.cycles, this.deep ? Infinity : this.scs.cyclesUntilTick(), this.nextEventCycle - this.cycles))
          this.cycles += skip
          this.sleepCycles += skip
          if (!this.deep) this.scs.tick(skip)
          if (this.cycles >= this.nextEventCycle) this.onEvent()
          continue
        }
      } else if (this.breakpoints.size && this.breakpoints.has(this.pc)) {
        this.halted = new CpuHalt("bkpt", "breakpoint", this.pc)
        break
      }
      this.step()
    }
    return this.cycles - start
  }
}
