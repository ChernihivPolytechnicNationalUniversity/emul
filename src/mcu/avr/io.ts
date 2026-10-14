/**
 * The frame every AVR peripheral hangs on: I/O register hooks, interrupt sources, and lazy
 * clocking. A peripheral is not ticked per instruction; it remembers the cycle it was last
 * brought up to, is caught up when its registers are touched or a pin it listens to moves,
 * and asks for an event at the cycle its next flag, edge or bit comes due. The core pays one
 * compare per instruction for all of them (`AvrCpu.nextEventCycle`).
 */
import type { AvrCpu } from "./cpu"

/** Which clock a block runs from: it stops in the sleep modes that gate that clock (DS40002061B Table 10-1). */
export type ClockDomain = "io" | "adc" | "asy" | "wdt" | "none"

export type RegisterHooks = {
  name: string
  read?: () => number
  /** `mask` is 0xFF for a byte write, the one bit for SBI/CBI. */
  write?: (value: number, mask: number) => void
}

/** What the SoC offers its peripherals. */
export interface AvrBus {
  readonly cpu: AvrCpu
  readonly irq: Interrupts
  /** System clock, Hz (after the CLKPR prescaler). */
  readonly hz: number
  /** Hook a data-space address in the I/O window. */
  register(addr: number, hooks: RegisterHooks): void
  /** A block's next event moved; the SoC recomputes the earliest one. */
  reschedule(): void
  /** A block changed what it overrides on its pins (DS40002061B §14.3). */
  pinsChanged(): void
  /** Power reduction: PRR bit for this block set (its clock is stopped, its registers frozen). */
  powerReduced(bit: number): boolean
}

export abstract class Peripheral {
  abstract readonly name: string
  readonly domain: ClockDomain = "io"
  /** Cycle of the next event this block needs; Infinity when it needs none. */
  due = Infinity
  protected readonly bus: AvrBus
  constructor(bus: AvrBus) {
    this.bus = bus
  }
  /** The cycle of the current access (or event). */
  protected get now(): number {
    return this.bus.cpu.at
  }
  /** Whether the block's clock runs in a sleep mode (null: awake), from its clock domain (Table 10-1). */
  runsIn(mode: string | null): boolean {
    switch (this.domain) {
      case "io":
        return mode === null || mode === "idle"
      case "adc":
        return mode === null || mode === "idle" || mode === "adc-noise"
      case "asy":
        return mode === null || mode === "idle" || mode === "adc-noise" || mode === "power-save" || mode === "extended-standby"
      default:
        return true
    }
  }
  /** Back to the reset state (the SoC calls it for every reset source). */
  abstract reset(): void
  /** Bring the block up to `cycle` (lazily clocked blocks); events due by then are handled. */
  sync(cycle: number): void {
    void cycle
  }
  /** The event at `due` has come. */
  service(cycle: number): void {
    this.sync(cycle)
  }
  /** The block's clock stops (sleep, PRR) or runs again: lazy blocks freeze their count. */
  setClockRunning(running: boolean, cycle: number): void {
    void running
    void cycle
  }
  /** The core went to sleep in `mode` (the ADC starts a conversion in Idle and ADC Noise Reduction, §24.6). */
  onSleep(mode: string, cycle: number): void {
    void mode
    void cycle
  }
  /** The system clock changed (CLKPR, a reset): blocks timed in seconds re-plan in cycles. */
  clockChanged(cycle: number): void {
    void cycle
  }
}

/**
 * One interrupt vector's source: its flag and enable, as functions of the owning block's
 * state, and what entering the vector does to the flag (most flags clear by hardware then).
 */
export type IrqSource = {
  vector: number
  pending: () => boolean
  /** Called when the vector is taken. */
  acknowledge?: () => void
  /** Wakes the part from these sleep modes (besides Idle, which any interrupt ends). */
  wakes?: () => boolean
}

/**
 * The interrupt priority logic: the lowest vector number among pending sources wins
 * (DS40002061B §7.7). Blocks call `update()` when a flag or an enable changes.
 */
export class Interrupts {
  private readonly sources: (IrqSource | undefined)[] = []
  private readonly cpu: AvrCpu
  constructor(cpu: AvrCpu) {
    this.cpu = cpu
  }
  add(source: IrqSource) {
    this.sources[source.vector] = source
  }
  update() {
    let any = false
    for (const s of this.sources) if (s && s.pending()) any = true
    this.cpu.irqPending = any
  }
  /** Vector number of the most urgent pending source (acknowledged), or 0. */
  take(): number {
    for (const s of this.sources)
      if (s && s.pending()) {
        s.acknowledge?.()
        this.update()
        return s.vector
      }
    this.cpu.irqPending = false
    return 0
  }
  /** Pending sources that may end the given sleep mode. */
  wakePending(): boolean {
    for (const s of this.sources) if (s && s.pending() && (s.wakes?.() ?? true)) return true
    return false
  }
}
