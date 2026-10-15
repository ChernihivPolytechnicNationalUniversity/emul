/**
 * AVR 8-bit core, the AVRe+ flavour of the ATmega48/88/168/328 family: 32 registers, a 16-bit
 * program counter over word-addressed flash, the hardware multiplier, MOVW and enhanced LPM;
 * no ELPM/EIJMP/EICALL (no RAMPZ/EIND on parts with ≤ 128 KB) and none of the XMEGA additions.
 *
 * Semantics, flags and clock counts follow the AVR Instruction Set Manual (DS40002198C), the
 * AVRe column with a 16-bit PC: RCALL/ICALL 3, CALL/RET/RETI 4; interrupt entry and the
 * one-instruction latency after SEI and RETI follow the ATmega328P data sheet (DS40002061B
 * §7.7). Flash is held in words; data space (registers, I/O, SRAM) is one byte array and the
 * SoC hooks the I/O window (0x20–0xFF) with read and write handlers.
 *
 * The core is interpreted from a predecoded table (decode.ts): each flash word decodes once
 * into a closure carrying its operands; self-programming (SPM) drops what it rewrote.
 */
import { BreakpointSet } from "../breakpoints"
import { DBG_STEP_QUIET, DBG_STOP, type CoreDebugger } from "../debugger"
import { CpuHalt } from "../faults"

import { SPH, SPL, SREG, SREG_I } from "./sreg"
import { decode, isTwoWord, type Op } from "./decode"

export * from "./sreg"

/**
 * What the core asks of the SoC around it. I/O registers are hooked per address; a register
 * written with SBI/CBI arrives with `mask` naming the one bit the instruction meant, so flag
 * registers (write one to clear) only clear that bit (DS40002061B §36 note 3).
 */
export interface AvrSystem {
  /** An interrupt is about to be taken: the vector number (1 = RESET) of the most urgent pending one, or 0. */
  takeInterrupt(): number
  /** SLEEP with SMCR.SE set; returns false when the sleep instruction does nothing (SE clear). */
  sleep(): boolean
  /** A pending interrupt may end the current sleep mode (its source is a wake-up source there, Table 10-1). */
  canWake(): boolean
  /** Cycles a wake-up from the current sleep mode costs before the interrupt is answered. */
  wakeCycles(): number
  watchdogReset(): void
  /** SPM: SPMCSR decides what it does; returns the cycles it stalls the core. */
  spm(z: number, r1r0: number): number
  /** LPM reads flash, or the signature/fuse/lock bytes when SPMCSR asks for them. */
  lpm(byteAddr: number): number
  /** A peripheral event came due (`nextEventCycle`). */
  service(): void
  /** Pending interrupts are held off whatever SREG.I says (boot lock bits, Tables 27-2/27-3). */
  interruptsHeld?(): boolean
}

export const DATA_SIZE = 0x900

export class AvrCpu {
  /** Registers (0x00–0x1F), I/O (0x20–0x5F), extended I/O (0x60–0xFF), SRAM (0x100–RAMEND). */
  readonly data: Uint8Array
  /** Program memory in 16-bit words. */
  readonly flash: Uint16Array
  readonly ramEnd: number
  /** Flash size in words less one: the program counter wraps there. */
  readonly pcMask: number

  readonly ioRead: ((addr: number) => number)[] = []
  readonly ioWrite: ((addr: number, value: number, mask: number) => void)[] = []

  /** Word address of the next instruction. */
  pc = 0
  /** Word address of the instruction being executed (for faults and the debugger). */
  opPc = 0
  cycles = 0
  instructions = 0
  sleeping = false
  sleepCycles = 0
  halted: CpuHalt | null = null
  /** An enabled interrupt flag is set: the SoC raises it, the core takes it when SREG.I allows. */
  irqPending = false
  /** No interrupt is taken before this cycle: the instruction after SEI and RETI always runs first. */
  private irqHold = 0
  /** Interrupt vectors start here (word address): 0, or the boot section with MCUCR.IVSEL. */
  vectorBase = 0
  /** Words per vector: 2 on parts with JMP (> 8 KB flash), 1 on the 4/8 KB ones. */
  readonly vectorWords: number
  nextEventCycle = Infinity
  /** Set by the SoC to end `run` early (a clock change, an edge the owner must pass on). */
  stop = false
  system: AvrSystem
  /** Called on BREAK: a debugger may stop here; without one the core halts as on a BKPT. */
  onBreak: (pc: number) => void = (pc) => {
    throw new CpuHalt("bkpt", "break", pc * 2)
  }
  /**
   * Byte addresses the run loop stops at before executing. Without a debugger (`dbg`) a hit
   * halts the core; with one, the debugger decides (see debugger.ts, avr/debug.ts).
   */
  readonly breakpoints = new BreakpointSet()
  /** The debug unit, once something debugs this core. */
  dbg: CoreDebugger | null = null
  /** The debugger asks to see every boundary: a step in progress, a stop to take. */
  dbgActive = false
  /** Data-space accesses outside the implemented memory, counted for the inspector. */
  stray = 0
  /**
   * Clock cycle in which the current data access happens (the instruction's start plus the
   * cycle within it): an I/O read latches what was there half a cycle before, a write takes
   * effect at the end of that cycle (DS40002061B §8.3.1 Figure 8-4, §14.2.4 Figures 14-3/14-4).
   */
  at = 0

  private readonly ops: (Op | undefined)[]

  constructor(flashBytes: number, ramEnd: number, system: AvrSystem) {
    this.flash = new Uint16Array(flashBytes / 2)
    this.pcMask = this.flash.length - 1
    this.ramEnd = ramEnd
    this.data = new Uint8Array(Math.max(DATA_SIZE, ramEnd + 1))
    this.ops = new Array<Op | undefined>(this.flash.length)
    this.vectorWords = flashBytes > 8192 ? 2 : 1
    this.system = system
    for (let a = 0; a < 0x100; a++) {
      this.ioRead[a] = (x) => this.data[x]
      this.ioWrite[a] = (x, v) => {
        this.data[x] = v
      }
    }
    this.ioWrite[SREG] = (_x, v) => {
      this.data[SREG] = v
    }
  }

  /** Power-on / reset state of the core (registers are undefined on silicon; zero here). */
  reset(pc = 0) {
    this.data.fill(0, 0, 0x20)
    this.pc = pc
    this.opPc = pc
    this.cycles = 0
    this.instructions = 0
    this.sleeping = false
    this.sleepCycles = 0
    this.halted = null
    this.irqPending = false
    this.irqHold = 0
    this.vectorBase = 0
    this.stop = false
    this.nextEventCycle = Infinity
    this.data[SREG] = 0
    this.sp = this.ramEnd
  }

  /** Drop decoded instructions (flash changed). */
  invalidate(fromWord = 0, words = this.flash.length) {
    this.ops.fill(undefined, fromWord, fromWord + words)
  }

  get sp() {
    return this.data[SPL] | (this.data[SPH] << 8)
  }
  set sp(v: number) {
    this.data[SPL] = v & 0xff
    this.data[SPH] = (v >> 8) & 0xff
  }
  get sreg() {
    return this.data[SREG]
  }

  // --- data space ------------------------------------------------------------------------

  /** Read data space; `off` is the cycle within the instruction the access falls in. */
  read(a: number, off = 0): number {
    if (a < 0x20) return this.data[a]
    if (a < 0x100) {
      this.at = this.cycles + off
      return this.ioRead[a](a)
    }
    if (a <= this.ramEnd) return this.data[a]
    this.stray++
    return 0
  }
  write(a: number, v: number, off = 0) {
    if (a < 0x20) this.data[a] = v
    else if (a < 0x100) {
      this.at = this.cycles + off
      this.ioWrite[a](a, v & 0xff, 0xff)
    }
    else if (a <= this.ramEnd) this.data[a] = v
    else this.stray++
  }
  push(v: number) {
    const sp = this.sp
    this.write(sp, v, 1)
    this.sp = (sp - 1) & 0xffff
  }
  pop(): number {
    const sp = (this.sp + 1) & 0xffff
    this.sp = sp
    return this.read(sp, 1)
  }
  /** Return address on the stack: low byte pushed first, so the high byte sits below it. */
  pushPc(pc: number) {
    this.push(pc & 0xff)
    this.push((pc >> 8) & 0xff)
  }
  popPc(): number {
    const hi = this.pop()
    const lo = this.pop()
    return ((hi << 8) | lo) & this.pcMask
  }

  // --- running -----------------------------------------------------------------------------

  /**
   * Run until the cycle count reaches `limit` (an instruction may overshoot it), the core
   * halts, or the SoC sets `stop`.
   */
  run(limit: number) {
    if (this.halted) return
    this.stop = false
    const data = this.data
    const ops = this.ops
    try {
      while (this.cycles < limit && !this.stop) {
        if (this.sleeping) {
          // Asleep: nothing runs until a peripheral event raises an interrupt that may end this sleep mode.
          if (this.irqPending && data[SREG] & SREG_I && this.system.canWake()) {
            this.wake()
            continue
          }
          const until = this.nextEventCycle < limit ? this.nextEventCycle : limit
          if (until > this.cycles) {
            this.sleepCycles += until - this.cycles
            this.cycles = until
          }
        } else if (this.dbg !== null || this.breakpoints.size !== 0) {
          if (this.runWatched(limit)) break
        } else {
          // The deadline is read on every instruction: a register write can bring an event closer.
          while (this.cycles < limit && this.cycles < this.nextEventCycle) {
            if (this.irqPending && data[SREG] & SREG_I && this.cycles >= this.irqHold) this.interrupt()
            const pc = this.pc
            this.opPc = pc
            const op = ops[pc] ?? this.decodeAt(pc)
            op(this)
            this.instructions++
            if (this.stop || this.sleeping) break
          }
        }
        if (this.cycles >= this.nextEventCycle) {
          this.at = this.cycles
          this.system.service()
        }
      }
    } catch (e) {
      if (e instanceof CpuHalt) this.halted = e
      else throw e
    }
  }

  /**
   * The run loop with breakpoints or a debugger: each boundary is looked at before the
   * instruction there runs. An interrupt taken ends the boundary, so the debugger sees the
   * vector before it runs. Returns true when the core stopped.
   */
  private runWatched(limit: number): boolean {
    const data = this.data
    const bps = this.breakpoints
    const dbg = this.dbg
    while (this.cycles < limit && this.cycles < this.nextEventCycle) {
      const pc = this.pc
      let quiet = false
      if (dbg !== null) {
        if (this.dbgActive || bps.has(pc << 1)) {
          const act = dbg.check()
          if (act === DBG_STOP) return true
          quiet = act === DBG_STEP_QUIET
        }
      } else if (bps.has(pc << 1)) {
        this.halted = new CpuHalt("bkpt", "breakpoint", pc << 1)
        return true
      }
      if (!quiet && this.irqPending && data[SREG] & SREG_I && this.cycles >= this.irqHold) {
        this.interrupt()
        if (this.pc !== pc) continue
      }
      this.opPc = pc
      const op = this.ops[pc] ?? this.decodeAt(pc)
      try {
        op(this)
      } catch (e) {
        // BREAK with a debugger attached is a stop on the instruction, not a halt.
        if (!(e instanceof CpuHalt && e.reason === "bkpt" && dbg !== null)) throw e
        this.pc = pc
        dbg.onBkpt(e.detail)
        continue
      }
      this.instructions++
      if (this.stop || this.sleeping) break
    }
    return false
  }

  /** An interrupt would be taken before the next instruction. */
  interruptDue(): boolean {
    return this.irqPending && (this.data[SREG] & SREG_I) !== 0 && this.cycles >= this.irqHold && !this.system.interruptsHeld?.()
  }

  private wake() {
    this.sleeping = false
    const extra = this.system.wakeCycles()
    this.cycles += extra
    this.sleepCycles += extra
    // Waking costs four more cycles on top of the usual response (DS40002061B §7.7.1).
    this.cycles += 4
    this.interrupt()
  }

  /** Take the most urgent pending interrupt: PC on the stack, I cleared, four cycles. */
  private interrupt() {
    const vector = this.system.takeInterrupt()
    if (vector === 0) return
    const sp = this.sp
    this.dbg?.onException(vector, this.pc << 1, sp, 0)
    this.pushPc(this.pc)
    this.data[SREG] &= ~SREG_I
    this.pc = (this.vectorBase + (vector - 1) * this.vectorWords) & this.pcMask
    this.cycles += 4
  }

  /** SEI, RETI: the next instruction runs before any pending interrupt. */
  holdInterrupts() {
    this.irqHold = this.cycles + 1
  }

  private decodeAt(pc: number): Op {
    const op = decode(this.flash[pc], this.flash[(pc + 1) & this.pcMask], pc)
    this.ops[pc] = op
    return op
  }

  /** Words taken by the instruction at a word address (for skips). */
  wordsAt(pc: number): number {
    return isTwoWord(this.flash[pc & this.pcMask]) ? 2 : 1
  }

  undefinedOp(word: number): never {
    throw new CpuHalt("fault", `undefined instruction 0x${word.toString(16).padStart(4, "0")}`, this.opPc * 2)
  }
}
