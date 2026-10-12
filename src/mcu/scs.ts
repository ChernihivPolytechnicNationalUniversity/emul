/**
 * System Control Space (0xE000E000–0xE000EFFF): SysTick, NVIC, SCB and the FP extension
 * registers. Also owns the pending/active exception state that the core consults.
 *
 * Reference: ARMv7-M ARM chapter B3.2 (SCB), B3.3 (SysTick), B3.4 (NVIC). STM32F4 implements
 * 4 priority bits (16 levels) and 91 interrupt lines.
 */
import { WordPeripheral } from "./bus"
import { CORTEX_M4F, type CoreProfile } from "./chip"
import type { Cpu } from "./cpu"
import { EXC, excName } from "./faults"
import { MPU_RASR_WRITABLE, MPU_REGIONS } from "./mpu"

const PRIO_BITS = 4
const PRIO_MASK = (0xff << (8 - PRIO_BITS)) & 0xff
const MMFSR_IACCVIOL = 1 << 0
const MMFSR_DACCVIOL = 1 << 1
const MMFSR_MSTKERR = 1 << 4
const MMFSR_MMARVALID = 1 << 7
const BFSR_STKERR = 1 << 12
const BFSR_BFARVALID = 1 << 15
const HFSR_VECTTBL = 1 << 1
const CCR_USERSETMPEND = 1 << 1
const MPU_RBAR_ADDR = 0xffffffe0
const MPU_RBAR_VALID = 1 << 4

export type FaultRecord = { exc: number; detail: string; pc: number; time: number }

export class Scs extends WordPeripheral {
  // SysTick
  systCsr = 0
  systRvr = 0
  systCvr = 0
  private systCountflag = 0
  /** Sub-cycle accumulator for the /8 external clock. */
  private systDiv = 0
  /**
   * The counter is advanced lazily: `systAt` is the core cycle count its state is current
   * to, `systDue` the cycle at which it next reaches zero (Infinity when it will not), which
   * the CPU compares against between instructions instead of counting every one.
   */
  private systAt = 0
  systDue = Infinity

  // SCB
  vtor = 0
  aircr = 0xfa050000
  scr = 0
  /** CCR resets with STKALIGN set. */
  ccr = 0x200
  shcsr = 0
  cfsr = 0
  hfsr = 0
  mmfar = 0
  bfar = 0
  cpacr = 0
  fpccr = 0xc0000000
  fpcar = 0
  fpdscr = 0
  /** CoreDebug DEMCR (TRCENA gates the DWT). */
  demcr = 0
  mpuCtrl = 0
  mpuRnr = 0
  readonly mpuRbar = new Uint32Array(MPU_REGIONS)
  readonly mpuRasr = new Uint32Array(MPU_REGIONS)
  /** CSSELR: which cache CCSIDR describes (Cortex-M7 only). */
  csselr = 0

  /** Per-exception state; index = exception number. */
  readonly enabled: Uint8Array
  readonly pending: Uint8Array
  readonly active: Uint8Array
  /** Configured priority bytes: SHPR for 4..15, IPR for IRQs. Reset, NMI, HardFault are fixed. */
  readonly priority: Uint8Array
  pendingCount = 0
  private activeCount = 0

  /** Faults recorded for the debugger, newest last. */
  readonly faults: FaultRecord[] = []

  private cpu: Cpu
  readonly core: CoreProfile

  constructor(cpu: Cpu, core: CoreProfile = CORTEX_M4F) {
    super("SCS", 0xe000e000, 0x1000)
    this.cpu = cpu
    this.core = core
    this.enabled = new Uint8Array(EXC.IRQ0 + core.irqCount)
    this.pending = new Uint8Array(this.enabled.length)
    this.active = new Uint8Array(this.enabled.length)
    this.priority = new Uint8Array(this.enabled.length)
  }

  reset() {
    this.systCsr = 0
    this.systRvr = 0
    this.systCvr = 0
    this.systCountflag = 0
    this.systDiv = 0
    this.systAt = 0
    this.systDue = Infinity
    this.aircr = 0xfa050000
    this.scr = 0
    this.ccr = 0x200
    this.shcsr = 0
    this.cfsr = 0
    this.hfsr = 0
    this.cpacr = 0
    this.cpu.fpOn = false
    this.mpuCtrl = 0
    this.mpuRnr = 0
    this.mpuRbar.fill(0)
    this.mpuRasr.fill(0)
    this.csselr = 0
    this.fpccr = 0xc0000000
    this.demcr = 0
    this.enabled.fill(0)
    this.pending.fill(0)
    this.active.fill(0)
    this.priority.fill(0)
    this.pendingCount = 0
    this.activeCount = 0
    this.faults.length = 0
    // Always-enabled exceptions.
    for (const e of [EXC.RESET, EXC.NMI, EXC.HARD_FAULT, EXC.SVCALL, EXC.DEBUG_MONITOR, EXC.PENDSV, EXC.SYSTICK]) this.enabled[e] = 1
  }

  // --- priorities ---------------------------------------------------------------------

  /** AIRCR.PRIGROUP: number of low bits that form the sub-priority is PRIGROUP + 1. */
  get prigroup() {
    return (this.aircr >>> 8) & 7
  }
  /** Mask selecting the group-priority bits of a priority byte. */
  get groupMask() {
    return (~((1 << (this.prigroup + 1)) - 1) & 0xff) >>> 0
  }

  /** Configured priority of an exception as a signed number (Reset −3, NMI −2, HardFault −1). */
  priorityOf(exc: number): number {
    if (exc === EXC.RESET) return -3
    if (exc === EXC.NMI) return -2
    if (exc === EXC.HARD_FAULT) return -1
    return this.priority[exc]
  }
  groupPriorityOf(exc: number): number {
    const p = this.priorityOf(exc)
    return p < 0 ? p : p & this.groupMask
  }

  /** Lowest (most urgent) group priority among active exceptions, or 256 when none. */
  highestActivePriority(): number {
    if (this.activeCount === 0) return 256
    let best = 256
    for (let e = 2; e < this.enabled.length; e++) if (this.active[e]) best = Math.min(best, this.groupPriorityOf(e))
    return best
  }

  /**
   * The exception to take now, or 0: the most urgent pending enabled exception whose group
   * priority beats the current execution priority (B1.5.4). Ties go to the lower exception number.
   */
  anyPending(): boolean {
    return this.pendingCount !== 0
  }

  pendingToTake(executionPriority: number): number {
    if (this.pendingCount === 0) return 0
    let bestExc = 0
    let bestPrio = 256
    let bestGroup = 256
    for (let e = 2; e < this.enabled.length; e++) {
      if (!this.pending[e] || !this.enabled[e]) continue
      const p = this.priorityOf(e)
      if (p < bestPrio) {
        bestPrio = p
        bestGroup = p < 0 ? p : p & this.groupMask
        bestExc = e
      }
    }
    if (bestExc === 0) return 0
    return bestGroup < executionPriority ? bestExc : 0
  }

  setPending(exc: number, on: boolean) {
    if (exc <= 0 || exc >= this.enabled.length) return
    const cur = this.pending[exc]
    if (on && !cur) {
      this.pending[exc] = 1
      this.pendingCount++
      // SCR.SEVONPEND: a newly pending interrupt is a WFE wake-up event.
      if (this.scr & 0x10) this.cpu.eventRegister = true
    } else if (!on && cur) {
      this.pending[exc] = 0
      this.pendingCount--
    }
  }
  setActive(exc: number, on: boolean) {
    const cur = this.active[exc]
    if (on && !cur) {
      this.active[exc] = 1
      this.activeCount++
    } else if (!on && cur) {
      this.active[exc] = 0
      this.activeCount--
    }
  }
  /** External interrupt line n asserted/deasserted by a peripheral. Level-sensitive behaviour is the peripheral's job. */
  raiseIrq(n: number) {
    this.setPending(EXC.IRQ0 + n, true)
  }

  /** Whether a fault of this kind can be taken as itself; otherwise it escalates to HardFault. */
  escalate(exc: number): number {
    if (exc === EXC.HARD_FAULT) return exc
    if (!this.enabled[exc] || this.groupPriorityOf(exc) >= this.cpu.executionPriority()) {
      this.hfsr |= 1 << 30 // FORCED
      return EXC.HARD_FAULT
    }
    return exc
  }

  recordFault(exc: number, detail: string, pc: number) {
    if (exc === EXC.BUS_FAULT) this.cfsr |= 1 << 9 // PRECISERR
    if (exc === EXC.USAGE_FAULT) this.cfsr |= detail.startsWith("divide") ? 1 << 25 : 1 << 16
    this.logFault(exc, detail, pc)
  }
  private logFault(exc: number, detail: string, pc: number) {
    this.faults.push({ exc, detail, pc, time: this.cpu.cycles })
    if (this.faults.length > 64) this.faults.shift()
  }

  stackingFault(exc: typeof EXC.MEM_MANAGE | typeof EXC.BUS_FAULT, detail: string, pc: number) {
    this.cfsr |= exc === EXC.MEM_MANAGE ? MMFSR_MSTKERR : BFSR_STKERR
    this.logFault(exc, detail, pc)
  }
  vectorTableFault(detail: string, pc: number) {
    this.hfsr |= HFSR_VECTTBL
    this.logFault(EXC.HARD_FAULT, detail, pc)
  }

  instructionAccessViolation(detail: string, pc: number) {
    this.cfsr |= MMFSR_IACCVIOL
    this.recordFault(EXC.MEM_MANAGE, detail, pc)
  }
  dataAccessViolation(addr: number, detail: string, pc: number) {
    this.cfsr |= MMFSR_DACCVIOL | MMFSR_MMARVALID
    this.mmfar = addr >>> 0
    this.recordFault(EXC.MEM_MANAGE, detail, pc)
  }
  preciseBusFault(addr: number, detail: string, pc: number) {
    this.cfsr |= BFSR_BFARVALID
    this.bfar = addr >>> 0
    this.recordFault(EXC.BUS_FAULT, detail, pc)
  }
  unprivilegedMayPend() {
    return (this.ccr & CCR_USERSETMPEND) !== 0
  }

  divByZeroTraps() {
    return (this.ccr & 0x10) !== 0
  }

  // --- SysTick -----------------------------------------------------------------------

  /** Advance the timer by `cycles` core clocks. */
  /** Bring the counter up to core cycle `now` and schedule its next zero. */
  sync(now: number) {
    const elapsed = now - this.systAt
    this.systAt = now
    if (elapsed > 0) this.tick(elapsed)
    this.systDue = now + this.cyclesUntilTick()
  }
  /** The clocks stood still from `from` (a deep sleep): the counter did not run in between. */
  resume(now: number) {
    this.systAt = now
    this.systDue = now + this.cyclesUntilTick()
  }

  private tick(cycles: number) {
    if ((this.systCsr & 1) === 0) return
    if ((this.systCsr & 4) === 0) {
      // External reference clock: HCLK/8 on STM32.
      this.systDiv += cycles
      cycles = Math.floor(this.systDiv / 8)
      this.systDiv -= cycles * 8
      if (cycles === 0) return
    }
    const rvr = this.systRvr
    if (rvr === 0) return
    let cvr = this.systCvr
    // A counter at zero spends one clock reloading, without flagging (B3.3.1).
    if (cvr === 0) {
      cvr = rvr
      cycles--
    }
    if (cycles >= cvr) {
      // Reaches zero: COUNTFLAG and, if enabled, the SysTick exception. Several wraps in one
      // call still pend a single exception, as on hardware.
      this.systCountflag = 1
      if (this.systCsr & 2) this.setPending(EXC.SYSTICK, true)
      cycles -= cvr
      const period = rvr + 1
      cycles -= Math.floor(cycles / period) * period
      cvr = cycles === 0 ? 0 : rvr - (cycles - 1)
    } else cvr -= cycles
    this.systCvr = cvr
  }

  /** Core cycles until SysTick next reaches zero, or Infinity when it will not. */
  cyclesUntilTick(): number {
    if ((this.systCsr & 3) !== 3 || this.systRvr === 0) return Infinity
    const cvr = this.systCvr === 0 ? this.systRvr + 1 : this.systCvr
    return this.systCsr & 4 ? cvr : cvr * 8 - this.systDiv
  }

  // --- register file ----------------------------------------------------------------------

  /** SYST_CSR without clearing COUNTFLAG, the one read here with a side effect. */
  peekWord(off: number): number {
    if (off === 0x010) {
      this.sync(this.cpu.cycles)
      return this.systCsr | (this.systCountflag << 16)
    }
    return this.readWord(off)
  }

  readWord(off: number): number {
    switch (off) {
      case 0x004: // ICTR: number of interrupt lines / 32 - 1
        return Math.ceil(this.core.irqCount / 32) - 1
      case 0x008: // ACTLR
        return 0
      case 0x010: {
        this.sync(this.cpu.cycles)
        const v = this.systCsr | (this.systCountflag << 16)
        this.systCountflag = 0
        return v
      }
      case 0x014:
        return this.systRvr
      case 0x018:
        this.sync(this.cpu.cycles)
        return this.systCvr
      case 0x01c: // CALIB: 10 ms at 18 MHz (STCLK = HCLK/8 at 144 MHz), NOREF = 0
        return 0x00011250 & 0x00ffffff
      case 0xd00: // CPUID
        return this.core.cpuid
      case 0xd04: {
        const cpu = this.cpu
        let v = cpu.ipsr
        const pend = this.pendingToTake(-4)
        if (pend) v |= pend << 12
        for (let e = EXC.IRQ0; e < this.enabled.length; e++) if (this.pending[e]) v |= 1 << 22
        if (this.pending[EXC.SYSTICK]) v |= 1 << 26
        if (this.pending[EXC.PENDSV]) v |= 1 << 28
        if (this.pending[EXC.NMI]) v |= 1 << 31
        return v >>> 0
      }
      case 0xd08:
        return this.vtor
      case 0xd0c:
        return this.aircr
      case 0xd10:
        return this.scr
      case 0xd14:
        return this.ccr
      case 0xd18:
        return this.priority[4] | (this.priority[5] << 8) | (this.priority[6] << 16)
      case 0xd1c:
        return this.priority[11] << 24
      case 0xd20:
        return (this.priority[12] | (this.priority[14] << 16) | (this.priority[15] << 24)) >>> 0
      case 0xd24: {
        let v = this.shcsr & 0x00070000
        if (this.active[EXC.MEM_MANAGE]) v |= 1
        if (this.active[EXC.BUS_FAULT]) v |= 2
        if (this.active[EXC.USAGE_FAULT]) v |= 8
        if (this.active[EXC.SVCALL]) v |= 0x80
        if (this.active[EXC.DEBUG_MONITOR]) v |= 0x100
        if (this.active[EXC.PENDSV]) v |= 0x400
        if (this.active[EXC.SYSTICK]) v |= 0x800
        if (this.pending[EXC.USAGE_FAULT]) v |= 0x1000
        if (this.pending[EXC.MEM_MANAGE]) v |= 0x2000
        if (this.pending[EXC.BUS_FAULT]) v |= 0x4000
        if (this.pending[EXC.SVCALL]) v |= 0x8000
        return v
      }
      case 0xd28:
        return this.cfsr
      case 0xd2c:
        return this.hfsr
      case 0xd30: // DFSR
        return 0
      case 0xd34:
        return this.mmfar
      case 0xd38:
        return this.bfar
      case 0xd3c: // AFSR
        return 0
      case 0xd40: // ID_PFR0
        return 0x00000030
      case 0xd44:
        return 0x00000200
      case 0xd48: // ID_DFR0
        return 0x00100000
      case 0xd4c:
        return 0
      case 0xd50: // ID_MMFR0
        return 0x00100030
      case 0xd54:
      case 0xd58:
      case 0xd5c:
        return 0
      case 0xd60: // ID_ISAR0..4
        return 0x01141110
      case 0xd64:
        return 0x02112000
      case 0xd68:
        return 0x21232231
      case 0xd6c:
        return 0x01111131
      case 0xd70:
        return 0x01310132
      case 0xd78: // CLIDR: L1 I+D on the M7, no caches on the M4
        return this.core.cache ? 0x09000003 : 0
      case 0xd7c: // CTR
        return this.core.cache ? 0x8303c003 : 0
      case 0xd80: // CCSIDR for the cache CSSELR selects: 4 KB 4-way D, 4 KB 2-way I, 32-byte lines
        return !this.core.cache ? 0 : this.csselr & 1 ? 0xf007e009 : 0xf003e019
      case 0xd84:
        return this.csselr
      case 0xd88:
        return this.cpacr
      case 0xd90: // MPU_TYPE: 8 unified regions, separate I/D not supported
        return 0x800
      case 0xd94:
        return this.mpuCtrl
      case 0xd98:
        return this.mpuRnr
      case 0xd9c:
      case 0xda4:
      case 0xdac:
      case 0xdb4:
        return (this.mpuRbar[this.mpuRnr] | this.mpuRnr) >>> 0
      case 0xda0:
      case 0xda8:
      case 0xdb0:
      case 0xdb8:
        return this.mpuRasr[this.mpuRnr]
      case 0xf34:
        return this.fpccr
      case 0xf38:
        return this.fpcar
      case 0xf3c:
        return this.fpdscr
      case 0xf40:
        return this.core.mvfr[0]
      case 0xf44:
        return this.core.mvfr[1]
      case 0xf48:
        return this.core.mvfr[2]
      case 0xdf0: // DHCSR: no debugger attached
        return 0
      case 0xdfc:
        return this.demcr
    }
    if (off >= 0x100 && off < 0x120) return this.readIrqBits(this.enabled, off - 0x100)
    if (off >= 0x180 && off < 0x1a0) return this.readIrqBits(this.enabled, off - 0x180)
    if (off >= 0x200 && off < 0x220) return this.readIrqBits(this.pending, off - 0x200)
    if (off >= 0x280 && off < 0x2a0) return this.readIrqBits(this.pending, off - 0x280)
    if (off >= 0x300 && off < 0x320) return this.readIrqBits(this.active, off - 0x300)
    if (off >= 0x400 && off < 0x400 + this.core.irqCount) {
      const base = EXC.IRQ0 + (off - 0x400)
      return (this.priority[base] | (this.priority[base + 1] << 8) | (this.priority[base + 2] << 16) | (this.priority[base + 3] << 24)) >>> 0
    }
    return 0
  }

  private readIrqBits(arr: Uint8Array, byteOff: number): number {
    const first = EXC.IRQ0 + (byteOff >>> 2) * 32
    let v = 0
    for (let i = 0; i < 32; i++) if (first + i < this.enabled.length && arr[first + i]) v |= 1 << i
    return v >>> 0
  }

  writeWord(off: number, value: number): void {
    switch (off) {
      case 0x010:
        this.sync(this.cpu.cycles)
        this.systCsr = value & 7
        this.systDue = this.cpu.cycles + this.cyclesUntilTick()
        return
      case 0x014:
        this.sync(this.cpu.cycles)
        this.systRvr = value & 0xffffff
        this.systDue = this.cpu.cycles + this.cyclesUntilTick()
        return
      case 0x018:
        // Any write clears the counter and COUNTFLAG.
        this.sync(this.cpu.cycles)
        this.systCvr = 0
        this.systCountflag = 0
        this.systDue = this.cpu.cycles + this.cyclesUntilTick()
        return
      case 0xd04:
        if (value & (1 << 31)) this.setPending(EXC.NMI, true)
        if (value & (1 << 28)) this.setPending(EXC.PENDSV, true)
        if (value & (1 << 27)) this.setPending(EXC.PENDSV, false)
        if (value & (1 << 26)) this.setPending(EXC.SYSTICK, true)
        if (value & (1 << 25)) this.setPending(EXC.SYSTICK, false)
        return
      case 0xd08:
        this.vtor = value & 0xffffff80
        return
      case 0xd0c:
        if ((value >>> 16) !== 0x05fa) return // VECTKEY
        if (value & 4) {
          // SYSRESETREQ: reset the whole MCU on the next step.
          this.cpu.requestReset()
        }
        this.aircr = (0xfa050000 | (value & 0x0700) | (value & 0x2)) >>> 0
        return
      case 0xd10:
        this.scr = value & 0x16
        return
      case 0xd14:
        // DC/IC/BP (bits 16..18) exist on the M7; the caches are not modelled, the bits just latch.
        this.ccr = ((value & (this.core.cache ? 0x7031f : 0x31f)) | 0x200) >>> 0
        return
      case 0xd18:
        this.priority[4] = value & PRIO_MASK
        this.priority[5] = (value >>> 8) & PRIO_MASK
        this.priority[6] = (value >>> 16) & PRIO_MASK
        return
      case 0xd1c:
        this.priority[11] = (value >>> 24) & PRIO_MASK
        return
      case 0xd20:
        this.priority[12] = value & PRIO_MASK
        this.priority[14] = (value >>> 16) & PRIO_MASK
        this.priority[15] = (value >>> 24) & PRIO_MASK
        return
      case 0xd24:
        this.shcsr = value & 0x00070000
        this.enabled[EXC.MEM_MANAGE] = value & (1 << 16) ? 1 : 0
        this.enabled[EXC.BUS_FAULT] = value & (1 << 17) ? 1 : 0
        this.enabled[EXC.USAGE_FAULT] = value & (1 << 18) ? 1 : 0
        this.setPending(EXC.USAGE_FAULT, (value & 0x1000) !== 0)
        this.setPending(EXC.MEM_MANAGE, (value & 0x2000) !== 0)
        this.setPending(EXC.BUS_FAULT, (value & 0x4000) !== 0)
        this.setPending(EXC.SVCALL, (value & 0x8000) !== 0)
        return
      case 0xd28: // write-one-to-clear
        this.cfsr = (this.cfsr & ~value) >>> 0
        return
      case 0xd2c:
        this.hfsr = (this.hfsr & ~value) >>> 0
        return
      case 0xd84:
        this.csselr = value & 0xf
        return
      case 0xd88:
        this.cpacr = value & 0x00f00000
        this.cpu.fpOn = this.cpacr === 0x00f00000
        return
      case 0xd94:
        this.mpuCtrl = value & 7
        this.cpu.mpuChanged()
        return
      case 0xd98:
        this.mpuRnr = value & (MPU_REGIONS - 1)
        return
      case 0xd9c:
      case 0xda4:
      case 0xdac:
      case 0xdb4:
        if (value & MPU_RBAR_VALID) this.mpuRnr = value & (MPU_REGIONS - 1)
        this.mpuRbar[this.mpuRnr] = (value & MPU_RBAR_ADDR) >>> 0
        this.cpu.mpuChanged()
        return
      case 0xda0:
      case 0xda8:
      case 0xdb0:
      case 0xdb8:
        this.mpuRasr[this.mpuRnr] = (value & MPU_RASR_WRITABLE) >>> 0
        this.cpu.mpuChanged()
        return
      // Cache maintenance (ICIALLU .. BPIALL): write-only, nothing to invalidate here.
      case 0xf50:
      case 0xf58:
      case 0xf5c:
      case 0xf60:
      case 0xf64:
      case 0xf68:
      case 0xf6c:
      case 0xf70:
      case 0xf74:
      case 0xf78:
        return
      case 0xf34:
        this.fpccr = value >>> 0
        return
      case 0xf38:
        this.fpcar = value & ~7
        return
      case 0xf3c:
        this.fpdscr = value & 0x07c00000
        return
      case 0xf00: // STIR
        if ((value & 0x1ff) < this.core.irqCount) this.raiseIrq(value & 0x1ff)
        return
      case 0xdfc:
        this.demcr = value >>> 0
        return
    }
    if (off >= 0x100 && off < 0x120) return this.writeIrqBits(off - 0x100, value, (e) => (this.enabled[e] = 1))
    if (off >= 0x180 && off < 0x1a0) return this.writeIrqBits(off - 0x180, value, (e) => (this.enabled[e] = 0))
    if (off >= 0x200 && off < 0x220) return this.writeIrqBits(off - 0x200, value, (e) => this.setPending(e, true))
    if (off >= 0x280 && off < 0x2a0) return this.writeIrqBits(off - 0x280, value, (e) => this.setPending(e, false))
    if (off >= 0x400 && off < 0x400 + this.core.irqCount) {
      const base = EXC.IRQ0 + (off - 0x400)
      for (let i = 0; i < 4; i++) if (base + i < this.enabled.length) this.priority[base + i] = ((value >>> (i * 8)) & 0xff) & PRIO_MASK
    }
  }

  private writeIrqBits(byteOff: number, value: number, fn: (exc: number) => void) {
    const first = EXC.IRQ0 + (byteOff >>> 2) * 32
    for (let i = 0; i < 32; i++) if (value & (1 << i) && first + i < this.enabled.length) fn(first + i)
  }

  /** Human-readable state for the debugger. */
  describePending(): string[] {
    const out: string[] = []
    for (let e = 2; e < this.enabled.length; e++) if (this.pending[e]) out.push(excName(e))
    return out
  }
}
