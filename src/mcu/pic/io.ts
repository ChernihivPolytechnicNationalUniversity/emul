/**
 * The frame every PIC16 peripheral hangs on, as on the AVR (`../avr/io.ts`): register hooks,
 * lazy clocking (a block is caught up when its registers are touched or a pin it listens to
 * moves, and asks for an event at the cycle its next flag or edge comes due), and the clock it
 * runs from. Cycles are instruction cycles (TCY = 4 TOSC).
 */
import type { PicCpu, FileHooks } from "./cpu"

/** Which clock a block runs from: "core" stops in Sleep (§14.8); "own" (WDT, Timer1's oscillator, comparators) keeps going. */
export type ClockDomain = "core" | "own"

/** What the SoC offers its peripherals. */
export interface PicBus {
  readonly cpu: PicCpu
  /** Instruction rate, Hz (FOSC/4). */
  readonly hz: number
  /** FOSC, Hz. */
  readonly fosc: number
  /** Hook a special function register at its file addresses. */
  register(addrs: number | number[], hooks: FileHooks): void
  /** A block's next event moved; the SoC recomputes the earliest one. */
  reschedule(): void
  /** A block changed what it overrides on its pins. */
  pinsChanged(cycle?: number): void
  /** An interrupt flag or enable changed at `cycle`: the SoC recomputes the request. */
  irqChanged(cycle: number): void
  /** Simulated time of a cycle, and back. */
  cycleTime(cycle: number): number
  timeCycle(t: number): number
  /** A mode the emulator does not model was used. */
  feature(what: string): void
  /** Power-up values of cells the documents give as unknown (decision D2): the part's own random source. */
  random(): number
}

export abstract class Peripheral {
  abstract readonly name: string
  readonly domain: ClockDomain = "core"
  /** Cycle of the next event this block needs; Infinity when it needs none. */
  due = Infinity
  protected readonly bus: PicBus
  constructor(bus: PicBus) {
    this.bus = bus
  }
  /** The cycle of the current access (or event). */
  protected get now(): number {
    return this.bus.cpu.at
  }
  /** Back to the reset state; `por` for a power-on (some registers keep their value otherwise, Table 14-7). */
  abstract reset(por: boolean): void
  /** Bring the block up to `cycle`; events due by then are handled. */
  sync(cycle: number): void {
    void cycle
  }
  /** The event at `due` has come. */
  service(cycle: number): void {
    this.sync(cycle)
  }
  /** The core clock stops (Sleep) or runs again. */
  setClockRunning(running: boolean, cycle: number): void {
    void running
    void cycle
  }
  /** The clock rate changed: blocks timed in seconds re-plan in cycles. */
  clockChanged(cycle: number): void {
    void cycle
  }
}
