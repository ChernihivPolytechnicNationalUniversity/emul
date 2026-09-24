/**
 * What the debugger's two halves say to each other: the UI (DWARF, the views) and the core
 * (wherever it runs: the simulation worker or a worker of its own). Plain data throughout,
 * since it crosses worker boundaries.
 */

/** A breakpoint as the user set it. The core resolves it against whatever image it has, on every load. */
export type BreakpointSpec =
  | { id: string; kind: "line"; path: string; line: number; enabled: boolean }
  | { id: string; kind: "function"; name: string; enabled: boolean }
  | { id: string; kind: "address"; address: number; enabled: boolean }

export type StopReason =
  /** A breakpoint the user set. */
  | "breakpoint"
  /** A step finished. */
  | "step"
  /** The bench was paused. */
  | "pause"
  /** A BKPT instruction in the program. */
  | "bkpt"
  /** A fault exception was entered (vector catch). */
  | "exception"
  /** The core reset in the middle of a step. */
  | "reset"

export type DebugStop = {
  reason: StopReason
  pc: number
  /** Which breakpoint, for `breakpoint`. */
  breakpoint?: string
  /** The exception number, for `exception`. */
  exception?: number
  /** A line for the status bar: the fault's description, the BKPT immediate. */
  detail?: string
}

/**
 * A step, as the core performs it. `into`/`over` step one source line (the core has the line
 * table); `instruction` one instruction (`over` runs a call through); `until` runs to an
 * address, optionally only once the stack is back above `sp` (step out, run to cursor).
 */
export type StepRequest = { kind: "into" } | { kind: "over" } | { kind: "instruction"; over?: boolean } | { kind: "until"; addr: number; sp?: number }

/** What the loop tells a core about debugging. */
export type CoreDebugCommand =
  | { op: "breakpoints"; list: BreakpointSpec[] }
  /** Stop when a fault exception is entered, as a probe's vector catch does. */
  | { op: "catch"; faults: boolean }
  /** Go on from a stop: the instruction under a breakpoint runs once without stopping there again. */
  | { op: "resume" }
  | { op: "step"; step: StepRequest }

/** The core's registers at a stop. */
export type CoreRegisters = {
  /** r0–r15; r[13] is the active SP, r[15] the PC. */
  r: number[]
  xpsr: number
  msp: number
  psp: number
  primask: number
  basepri: number
  faultmask: number
  control: number
  /** Single-precision registers as bit patterns (d0–d15 overlay them); null without an FPU. */
  s: number[] | null
  fpscr: number
  cycles: number
  instructions: number
  sleeping: boolean
}

/** `blocks` asks for the peripheral blocks the emulator models, with their registers. */
export type InspectRequest = { regs?: boolean; ranges?: { addr: number; size: number }[]; blocks?: boolean }

/** A peripheral block the emulator models, and the registers it has. */
export type BlockInfo = { name: string; base: number; size: number; registers: { name: string; offset: number }[] }

/** Memory as read without side effects; `invalid` are the sub-ranges nothing answers at (unmapped). */
export type MemoryChunk = { addr: number; bytes: Uint8Array; invalid?: [number, number][] }

export type InspectReply = {
  regs: CoreRegisters | null
  memory: MemoryChunk[]
  blocks?: BlockInfo[]
  stop: DebugStop | null
  /** The core's own time, seconds since its last reset. */
  time: number
  halted: string | null
}
