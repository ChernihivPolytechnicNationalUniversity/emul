/**
 * The mid-range PIC core (PIC16, 14-bit instructions) of the PIC16F62x: W, a 13-bit program
 * counter over word-addressed flash, an 8-level circular hardware stack outside both memories,
 * and 512 bytes of banked data space (RP1:RP0 for direct addressing, IRP:FSR through INDF).
 *
 * Semantics and timing follow DS40044G §4 and §15 (Table 15-2): one instruction cycle (TCY,
 * four oscillator periods) per instruction, two when the PC changes or a skip is taken. Time is
 * counted in instruction cycles; within one, data is read in Q2 and written in Q4 (§3.2), so a
 * register access is stamped a quarter or three quarters into its cycle for the peripherals.
 * The interrupt response follows Figure 14-15 (the request is sampled each Q1; the instruction
 * under way completes, two dummy cycles follow, then 0004h runs) and the wake-up from Sleep
 * Figure 14-17.
 *
 * The core owns the registers every bank shares (INDF, PCL, STATUS, FSR, PCLATH); the SoC
 * hooks the special function registers and the core keeps the general purpose RAM.
 */
import { CpuHalt } from "../faults"
import type { PicProfile } from "./chip"
import { decode, type PicOp } from "./decode"

/** What the core asks of the SoC around it. */
export interface PicSystem {
  /** SLEEP: returns false when it completes as a NOP (an enabled interrupt is already pending, §14.8.1); otherwise the WDT is cleared. */
  sleep(): boolean
  clrwdt(): void
  /** OPTION instruction: W → OPTION_REG. */
  option(w: number): void
  /** TRIS f instruction: W → the TRIS register of port f (5–7). */
  tris(f: number, w: number): void
  /** An interrupt is being taken: GIE clears (the SoC drops `irqAt`). */
  acknowledge(): void
  /** RETFIE: GIE sets. */
  retfie(): void
  /** While asleep: an enabled interrupt flag is set (wakes regardless of GIE, §14.8.1). */
  canWake(): boolean
  /** Instruction cycles the oscillator needs to start again after Sleep (TOST in XT/HS/LP). */
  wakeCycles(): number
  /** A reserved opcode ran (Table 15-2 note 1). */
  reserved(word: number): void
  /** A peripheral event came due (`nextEventCycle`). */
  service(): void
}

// STATUS bits (Register 4-1).
export const STATUS_C = 0x01
export const STATUS_DC = 0x02
export const STATUS_Z = 0x04
export const STATUS_PD = 0x08
export const STATUS_TO = 0x10
export const STATUS_IRP = 0x80

/** What lives at a canonical data address. */
const Kind = { Ram: 0, Hook: 1, None: 2, Indf: 3, Pcl: 4, Status: 5, Fsr: 6, Pclath: 7 } as const
type Kind = (typeof Kind)[keyof typeof Kind]

export type FileHooks = {
  name: string
  read?: () => number
  write?: (value: number) => void
  /** Read without side effects (inspector, tests); defaults to `read`. */
  peek?: () => number
}

const CORE_REGS: [number, Kind][] = [
  [0x00, Kind.Indf],
  [0x02, Kind.Pcl],
  [0x03, Kind.Status],
  [0x04, Kind.Fsr],
  [0x0a, Kind.Pclath],
]

export class PicCpu {
  readonly chip: PicProfile
  /** Program memory, 14-bit words. */
  readonly flash: Uint16Array
  /** The PC wraps within the implemented program memory (§4.1). */
  readonly pcMask: number
  /** Data storage by canonical address (mirrors fold onto one). */
  readonly ram = new Uint8Array(512)
  /** Canonical address of every 9-bit file address. */
  private readonly canon = new Uint16Array(512)
  private readonly kind = new Uint8Array(512)
  private readonly hookRead: (() => number)[] = []
  private readonly hookWrite: ((v: number) => void)[] = []
  private readonly hookPeek: (() => number)[] = []
  /** Register names by canonical address (the SoC's SFRs), for the inspector. */
  readonly names = new Map<number, string>()

  w = 0
  status = 0x18
  fsr = 0
  pclath = 0
  /** Address of the next instruction (already incremented while one executes: PCL reads it). */
  pc = 0
  /** Address and start cycle of the instruction executed last. */
  opPc = 0
  opStart = 0
  /** Instruction cycles (TCY) since reset. */
  cycles = 0
  instructions = 0
  readonly stack = new Uint16Array(8)
  private sp = 0
  sleeping = false
  sleepCycles = 0
  halted: CpuHalt | null = null
  /**
   * Cycle (fractional for an asynchronous source) at which an interrupt request — a flag with
   * its enables and GIE — became true; Infinity when there is none. The SoC keeps it.
   */
  irqAt = Infinity
  /** Cycle the core last woke from Sleep: a request pending during Sleep is sampled from there. */
  private wokeAt = -Infinity
  nextEventCycle = Infinity
  /** Set by the SoC to end `run` early. */
  stop = false
  /** Cycle (fractional) of the current data access: Q2 for reads, Q4 for writes. */
  at = 0
  readonly system: PicSystem

  private readonly ops: (PicOp | undefined)[]

  constructor(chip: PicProfile, system: PicSystem) {
    this.chip = chip
    this.system = system
    this.flash = new Uint16Array(chip.flashWords).fill(0x3fff)
    this.pcMask = chip.flashWords - 1
    this.ops = new Array<PicOp | undefined>(chip.flashWords)
    for (let a = 0; a < 512; a++) {
      this.canon[a] = a
      this.kind[a] = Kind.None
    }
    for (const [lo, hi] of chip.gpr) for (let a = lo; a <= hi; a++) this.kind[a] = Kind.Ram
    for (const m of chip.commonMirrors) for (let i = 0; i < 16; i++) this.canon[m + i] = 0x70 + i
    for (const [addr, kind] of CORE_REGS)
      for (const bank of [0, 0x80, 0x100, 0x180]) {
        this.canon[bank + addr] = addr
        this.kind[addr] = kind
      }
  }

  /** Hook a special function register at one or more file addresses (its bank mirrors). */
  hook(addrs: number | number[], hooks: FileHooks) {
    const list = typeof addrs === "number" ? [addrs] : addrs
    const c = list[0]
    for (const a of list) this.canon[a] = c
    this.kind[c] = Kind.Hook
    const read = hooks.read ?? (() => 0)
    this.hookRead[c] = () => read() & 0xff
    this.hookWrite[c] = hooks.write ?? (() => {})
    const peek = hooks.peek ?? read
    this.hookPeek[c] = () => peek() & 0xff
    this.names.set(c, hooks.name)
  }
  /** What a file address is (for the SoC's map of unmodelled registers). */
  isImplemented(a: number): boolean {
    return this.kind[this.canon[a & 0x1ff]] !== Kind.None
  }

  /** Reset state of the core registers (Table 14-6): PC and PCLATH zero, bank 0, TO and PD set. */
  reset() {
    this.pc = 0
    this.opPc = 0
    this.opStart = 0
    this.pclath = 0
    this.status = (this.status & 0x07) | STATUS_TO | STATUS_PD
    this.sp = 0
    this.cycles = 0
    this.instructions = 0
    this.sleeping = false
    this.sleepCycles = 0
    this.halted = null
    this.irqAt = Infinity
    this.wokeAt = -Infinity
    this.stop = false
    this.nextEventCycle = Infinity
  }

  /** Drop decoded instructions (flash changed). */
  invalidate(fromWord = 0, words = this.flash.length) {
    this.ops.fill(undefined, fromWord, fromWord + words)
  }

  // --- data space --------------------------------------------------------------------------

  /** File address of operand `f` (7 bits): through IRP:FSR for INDF (f = 0), else RP1:RP0:f. */
  addr(f: number): number {
    return f === 0 ? ((this.status & 0x80) << 1) | this.fsr : ((this.status & 0x60) << 2) | f
  }

  read(a: number): number {
    const c = this.canon[a]
    switch (this.kind[c]) {
      case Kind.Ram:
        return this.ram[c]
      case Kind.Hook:
        this.at = this.cycles + 0.25
        return this.hookRead[c]()
      case Kind.Pcl:
        return this.pc & 0xff
      case Kind.Status:
        return this.status
      case Kind.Fsr:
        return this.fsr
      case Kind.Pclath:
        return this.pclath
      default:
        // Unimplemented locations and INDF reached through INDF read as zero (Figure 4-2, §4.4).
        return 0
    }
  }

  /**
   * Store an instruction's result. `flags`: the instruction affects C, DC or Z, so a write to
   * STATUS cannot change those three (§4.2.2.1); TO and PD are never writable.
   */
  write(a: number, v: number, flags: boolean) {
    const c = this.canon[a]
    switch (this.kind[c]) {
      case Kind.Ram:
        this.ram[c] = v
        return
      case Kind.Hook:
        this.at = this.cycles + 0.75
        this.hookWrite[c](v)
        return
      case Kind.Pcl:
        // Any write to PCL loads PCH from PCLATH<4:0>; the PC changed, so it takes a second cycle (§4.3).
        this.pc = (((this.pclath & 0x1f) << 8) | v) & this.pcMask
        this.cycles++
        return
      case Kind.Status: {
        const keep = flags ? 0x1f : STATUS_TO | STATUS_PD
        this.status = (this.status & keep) | (v & ~keep & 0xff)
        return
      }
      case Kind.Fsr:
        this.fsr = v
        return
      case Kind.Pclath:
        this.pclath = v & 0x1f
        return
    }
  }

  /** Raw data-space read without side effects (inspector, tests). */
  peek(a: number): number {
    const c = this.canon[a & 0x1ff]
    if (this.kind[c] === Kind.Hook) return this.hookPeek[c]()
    if (this.kind[c] === Kind.Indf) return 0
    return this.read(a & 0x1ff)
  }
  /** Raw store (tests, debugger): STATUS takes every bit, PCL does not move the PC. */
  poke(a: number, v: number) {
    const c = this.canon[a & 0x1ff]
    v &= 0xff
    switch (this.kind[c]) {
      case Kind.Status:
        this.status = v
        return
      case Kind.Pcl:
        this.pc = ((this.pc & 0x1f00) | v) & this.pcMask
        return
      case Kind.Hook:
        this.at = this.cycles
        this.hookWrite[c](v)
        return
      default:
        this.write(a & 0x1ff, v, false)
    }
  }

  /** Set C, DC, Z from an ALU result. */
  flagsZ(r: number) {
    this.status = r === 0 ? this.status | STATUS_Z : this.status & ~STATUS_Z
  }

  // --- stack ---------------------------------------------------------------------------------

  /** PUSH onto the circular stack: the ninth overwrites the first (§4.3.2). */
  push(pc: number) {
    this.stack[this.sp] = pc
    this.sp = (this.sp + 1) & 7
  }
  pop(): number {
    this.sp = (this.sp - 1) & 7
    return this.stack[this.sp]
  }
  stackTop(): number {
    return this.stack[(this.sp - 1) & 7]
  }

  // --- running -------------------------------------------------------------------------------

  /**
   * Run until the cycle count reaches `limit` (an instruction may overshoot it), the core
   * halts, or the SoC sets `stop`. At least one instruction runs when the core is awake.
   */
  run(limit: number) {
    if (this.halted) return
    this.stop = false
    const ops = this.ops
    try {
      while (this.cycles < limit && !this.stop) {
        if (this.sleeping) {
          if (this.system.canWake()) this.wake()
          else {
            const until = this.nextEventCycle < limit ? this.nextEventCycle : limit
            if (until > this.cycles) {
              this.sleepCycles += until - this.cycles
              this.cycles = until
            }
            if (this.cycles >= this.nextEventCycle) {
              this.at = this.cycles
              this.system.service()
            }
            continue
          }
        }
        // Awake (or just woken: the instruction after SLEEP runs as part of the wake-up, whatever the limit).
        for (;;) {
          // The deadline is read on every instruction: a register write can bring an event closer.
          if (this.cycles >= this.nextEventCycle) {
            this.at = this.cycles
            this.system.service()
            if (this.stop) break
          }
          if (this.irqAt !== Infinity) this.checkInterrupt()
          const pc = this.pc
          this.opPc = pc
          this.opStart = this.cycles
          this.pc = (pc + 1) & this.pcMask
          const op = ops[pc] ?? this.decodeAt(pc)
          op(this)
          this.cycles++
          this.instructions++
          if (this.cycles >= limit || this.stop || this.sleeping) break
        }
      }
    } catch (e) {
      if (e instanceof CpuHalt) this.halted = e
      else throw e
    }
  }

  /**
   * Figure 14-15: the request is sampled in Q1; the instruction in the sampled cycle completes,
   * then two dummy cycles, so 0004h starts three cycles after the sample. The return address
   * is the instruction fetched meanwhile and discarded.
   */
  private checkInterrupt() {
    let s = Math.ceil(this.irqAt - 1e-9)
    if (s < this.wokeAt) s = this.wokeAt
    if (s > this.cycles - 1) return
    this.push(this.pc)
    this.pc = 0x0004
    this.system.acknowledge()
    if (s + 3 > this.cycles) this.cycles = s + 3
  }

  private wake() {
    this.sleeping = false
    const extra = this.system.wakeCycles()
    this.cycles += extra
    this.sleepCycles += extra
    this.wokeAt = this.cycles
  }

  /** SLEEP: TO set, PD cleared unless it completes as a NOP (§14.8, DS33023A §26.4.2). */
  enterSleep() {
    if (!this.system.sleep()) return
    this.status = (this.status | STATUS_TO) & ~STATUS_PD
    this.sleeping = true
  }

  private decodeAt(pc: number): PicOp {
    const op = decode(this.flash[pc])
    this.ops[pc] = op
    return op
  }

  undefinedOp(word: number): never {
    throw new CpuHalt("fault", `undefined instruction 0x${word.toString(16).padStart(4, "0")}`, this.opPc)
  }
}
