/**
 * A peripheral that advances with the core clock but is only caught up lazily: on register
 * access, on a pin change it listens to, or when its next event is due. The SoC keeps the set
 * of active ones and the earliest due cycle (see `Stm32.sync`/`schedule`).
 */
export interface Clocked {
  /** Advance by `cycles` core clocks. */
  tick(cycles: number): void
  /** Core clocks until the next event that changes visible state, or Infinity. */
  cyclesUntilEvent(): number
}
