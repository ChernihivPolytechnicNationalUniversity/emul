/** Exception numbers and the control-flow signals the core uses to leave an instruction early. */

/** Architected exception numbers. External interrupt n is 16 + n. */
export const EXC = {
  RESET: 1,
  NMI: 2,
  HARD_FAULT: 3,
  MEM_MANAGE: 4,
  BUS_FAULT: 5,
  USAGE_FAULT: 6,
  SVCALL: 11,
  DEBUG_MONITOR: 12,
  PENDSV: 14,
  SYSTICK: 15,
  IRQ0: 16,
} as const

/** The STM32F429 implements 91 external interrupt lines (IRQn 0..90). */
export const NUM_IRQ = 91
export const NUM_EXC = EXC.IRQ0 + NUM_IRQ

export type CpuHaltReason = "bkpt" | "fault" | "unimplemented" | "lockup"

/** The core stopped: a breakpoint, an unrecoverable fault or an instruction we do not model. */
export class CpuHalt extends Error {
  readonly reason: CpuHaltReason
  readonly detail: string
  readonly pc: number
  constructor(reason: CpuHaltReason, detail: string, pc: number) {
    super(`${reason} at 0x${(pc >>> 0).toString(16).padStart(8, "0")}: ${detail}`)
    this.reason = reason
    this.detail = detail
    this.pc = pc
  }
}

/** Thrown by an instruction to request a synchronous exception; the step loop takes it. */
export class ExceptionRequest {
  readonly exc: number
  constructor(exc: number) {
    this.exc = exc
  }
}

export const EXC_NAMES: Record<number, string> = {
  1: "Reset",
  2: "NMI",
  3: "HardFault",
  4: "MemManage",
  5: "BusFault",
  6: "UsageFault",
  11: "SVCall",
  12: "DebugMonitor",
  14: "PendSV",
  15: "SysTick",
}

export function excName(exc: number): string {
  return EXC_NAMES[exc] ?? (exc >= EXC.IRQ0 ? `IRQ${exc - EXC.IRQ0}` : `exception ${exc}`)
}
