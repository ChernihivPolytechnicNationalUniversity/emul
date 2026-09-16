/**
 * GPIO port (RM0090 §8) and EXTI (§12).
 *
 * Each pin has an outward face for the analog world: what the pad drives (`driveOf`) and a
 * way for the outside to set the sampled input level (`setInput`). Alternate-function pins
 * are driven by whichever peripheral claims them through `afOutputs`.
 */
import { RegBlock, type RegDef } from "./regblock"
import type { Syscfg } from "./misc"

export const GPIO_BASE = 0x40020000
export const GPIO_PORTS = 11 // A..K
export const PORT_NAMES = "ABCDEFGHIJK"

/**
 * What a pad presents to the circuit. `high`/`low` are the push-pull driver (or an open-drain
 * pulled low); `pullup`/`pulldown` the weak internal resistors of an undriven pin; a number
 * is a voltage the pad sources (a DAC output); null is floating (input without pulls,
 * analog, or open-drain released).
 */
export type PadDrive = "high" | "low" | "pullup" | "pulldown" | number | null

export type PinChangeListener = (port: number, pin: number, level: boolean) => void

const REGS: RegDef[] = [
  { name: "MODER", offset: 0x00 },
  { name: "OTYPER", offset: 0x04, rw: 0xffff },
  { name: "OSPEEDR", offset: 0x08 },
  { name: "PUPDR", offset: 0x0c },
  { name: "IDR", offset: 0x10, rw: 0 },
  { name: "ODR", offset: 0x14, rw: 0xffff },
  { name: "BSRR", offset: 0x18 },
  { name: "LCKR", offset: 0x1c, rw: 0x1ffff },
  { name: "AFRL", offset: 0x20 },
  { name: "AFRH", offset: 0x24 },
]

/** Reset values differ per port because of the debug pins (RM0090 §8.4). */
const RESET_MODER = [0xa8000000, 0x00000280, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const RESET_OSPEEDR = [0x0c000000, 0x000000c0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
const RESET_PUPDR = [0x64000000, 0x00000100, 0, 0, 0, 0, 0, 0, 0, 0, 0]

export class Gpio extends RegBlock {
  readonly index: number
  /** Sampled pad levels, bit per pin; what IDR returns. */
  private input = 0
  /**
   * Levels driven by peripherals on alternate-function pins (bit per pin), and which pins
   * a peripheral currently claims as outputs. Unclaimed AF pins float.
   */
  afOutputs = 0
  afClaimed = 0
  /** Bumped whenever the outward-facing state may have changed. */
  version = 0
  /** Fired on IDR bit changes for EXTI and the debugger. */
  onInput: PinChangeListener | null = null
  /** Fired after a register write that may have changed what the pads drive. */
  onOutput: ((port: number) => void) | null = null

  constructor(index: number) {
    super(`GPIO${PORT_NAMES[index]}`, GPIO_BASE + index * 0x400, 0x400, REGS)
    this.index = index
    this.resetPort()
  }

  /** The sensed input levels are the board's, not the chip's: a reset leaves them alone. */
  reset() {
    super.reset()
    this.afOutputs = 0
    this.afClaimed = 0
    this.resetPort()
  }
  /** Standby: the port's registers reset and the pads float, while the sensed input levels stay known. */
  powerDown() {
    super.reset()
    this.afOutputs = 0
    this.afClaimed = 0
    this.resetPort()
  }
  private resetPort() {
    if (!this.regs) return
    this.regs[0] = RESET_MODER[this.index] ?? 0
    this.regs[2] = RESET_OSPEEDR[this.index] ?? 0
    this.regs[3] = RESET_PUPDR[this.index] ?? 0
    this.version++
  }

  protected onRead(d: RegDef, current: number): number {
    if (d.name === "IDR") return this.input
    if (d.name === "BSRR") return 0
    return current
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "BSRR": {
        // Set bits win over reset bits (RM0090: BSx has priority).
        const set = written & 0xffff
        const clr = (written >>> 16) & 0xffff
        const odr = ((this.regs[5] & ~clr) | set) & 0xffff
        if (odr !== this.regs[5]) {
          this.regs[5] = odr
          this.version++
          this.onOutput?.(this.index)
        }
        return 0
      }
      case "MODER":
      case "OTYPER":
      case "PUPDR":
      case "ODR":
      case "AFRL":
      case "AFRH":
        if (next !== old) {
          // Store first: the listener reads the pads' new drive (a pin switched from input to
          // output must go out as an edge now, not at the next ODR write).
          this.regs[d.offset >>> 2] = next >>> 0
          this.version++
          this.onOutput?.(this.index)
        }
        return
    }
  }

  // --- pin-level view ------------------------------------------------------------------

  mode(pin: number): 0 | 1 | 2 | 3 {
    return ((this.regs[0] >>> (pin * 2)) & 3) as 0 | 1 | 2 | 3
  }
  openDrain(pin: number) {
    return (this.regs[1] & (1 << pin)) !== 0
  }
  pull(pin: number): 0 | 1 | 2 | 3 {
    return ((this.regs[3] >>> (pin * 2)) & 3) as 0 | 1 | 2 | 3
  }
  odr(pin: number) {
    return (this.regs[5] & (1 << pin)) !== 0
  }
  af(pin: number) {
    const reg = pin < 8 ? this.regs[8] : this.regs[9]
    return (reg >>> ((pin & 7) * 4)) & 0xf
  }

  /** What the pad drives right now. */
  driveOf(pin: number): PadDrive {
    const mode = this.mode(pin)
    const pull = this.pull(pin)
    const weak: PadDrive = pull === 1 ? "pullup" : pull === 2 ? "pulldown" : null
    switch (mode) {
      case 0: // input
        return weak
      case 3: // analog
        return null
      case 1: {
        const level = this.odr(pin)
        if (this.openDrain(pin)) return level ? weak : "low"
        return level ? "high" : "low"
      }
      default: {
        // alternate function: driven by the owning peripheral, else floating (with pulls)
        if (!(this.afClaimed & (1 << pin))) return weak
        const level = (this.afOutputs & (1 << pin)) !== 0
        if (this.openDrain(pin)) return level ? weak : "low"
        return level ? "high" : "low"
      }
    }
  }

  /** The outside world reports the sampled level of a pad. */
  setInput(pin: number, level: boolean) {
    const bit = 1 << pin
    const cur = (this.input & bit) !== 0
    if (cur === level) return
    this.input = level ? this.input | bit : this.input & ~bit
    this.onInput?.(this.index, pin, level)
  }
  inputLevel(pin: number) {
    return (this.input & (1 << pin)) !== 0
  }

  /** A peripheral drives an AF pin (claim = true) or releases it. */
  setAfOutput(pin: number, level: boolean, claim = true) {
    const bit = 1 << pin
    const before = this.afOutputs | (this.afClaimed << 16)
    this.afOutputs = level ? this.afOutputs | bit : this.afOutputs & ~bit
    this.afClaimed = claim ? this.afClaimed | bit : this.afClaimed & ~bit
    if (before !== (this.afOutputs | (this.afClaimed << 16))) this.version++
  }
}

// --- EXTI ---------------------------------------------------------------------------------

/** EXTI line → NVIC interrupt number (RM0090 table 62). */
export function extiIrq(line: number): number {
  if (line < 5) return 6 + line
  if (line < 10) return 23
  if (line < 16) return 40
  switch (line) {
    case 16:
      return 1 // PVD
    case 17:
      return 41 // RTC alarm
    case 18:
      return 42 // USB OTG FS wakeup
    case 21:
      return 2 // RTC tamper
    case 22:
      return 3 // RTC wakeup
    default:
      return -1
  }
}

export class Exti extends RegBlock {
  private raise: (irq: number) => void
  private syscfg: Syscfg

  constructor(syscfg: Syscfg, raise: (irq: number) => void) {
    super("EXTI", 0x40013c00, 0x400, [
      { name: "IMR", offset: 0x00 },
      { name: "EMR", offset: 0x04 },
      { name: "RTSR", offset: 0x08 },
      { name: "FTSR", offset: 0x0c },
      { name: "SWIER", offset: 0x10 },
      { name: "PR", offset: 0x14, rw: 0, w1c: 0x007fffff },
    ])
    this.syscfg = syscfg
    this.raise = raise
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    if (d.name === "SWIER") {
      // Rising edge on a SWIER bit triggers the line.
      const newly = next & ~old
      for (let line = 0; line < 23; line++) if (newly & (1 << line)) this.trigger(line)
      return
    }
    if (d.name === "PR") {
      // Clearing the pending bit also clears SWIER for that line.
      this.regs[4] &= ~(written & 0x007fffff)
    }
  }

  /** A line in event mode fired: a WFE wake-up event for the core. */
  onEvent: () => void = () => {}
  /** A line fired with its interrupt or event mask set: what wakes the chip from Stop and Standby. */
  onWake: (line: number) => void = () => {}

  /**
   * An edge arrived on a line: pend the interrupt when IMR allows it (PR is set only then),
   * send an event when EMR does (RM0090 §12.2.5).
   */
  trigger(line: number) {
    const bit = 1 << line
    const irqMode = (this.regs[0] & bit) !== 0
    const eventMode = (this.regs[1] & bit) !== 0
    if (irqMode) {
      this.regs[5] |= bit
      const irq = extiIrq(line)
      if (irq >= 0) this.raise(irq)
    }
    if (eventMode) this.onEvent()
    if (irqMode || eventMode) this.onWake(line)
  }

  /** A peripheral's rising edge on an internal line (RTC alarm 17, wake-up 22): armed by RTSR. */
  event(line: number) {
    if (this.regs[2] & (1 << line)) this.trigger(line)
  }

  /** A GPIO input changed; fire when this port is selected for the line and the edge is armed. */
  onPinChange(port: number, pin: number, level: boolean) {
    if (pin > 15 || this.syscfg.extiPort(pin) !== port) return
    const bit = 1 << pin
    const armed = level ? this.regs[2] & bit : this.regs[3] & bit
    if (armed) this.trigger(pin)
  }
}
