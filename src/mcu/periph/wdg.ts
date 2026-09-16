/**
 * The two watchdogs (RM0090 §20, §21; identical on the F7).
 *
 * IWDG: a 12-bit down-counter on LSI (32 kHz) through PR; once started by the 0xCCCC key it
 * cannot be stopped, and reaching 0 resets the chip. The 0x5555 key opens PR/RLR, 0xAAAA
 * reloads. Debug freeze (DBGMCU) is not honoured: a halted core lets the dog bite.
 *
 * WWDG: a 7-bit down-counter on PCLK1 / 4096 / 2^WDGTB; the chip resets when T6 clears
 * (0x40 → 0x3F), or when the counter is refreshed while above the window W. The early
 * wake-up interrupt fires at T = 0x40 when EWI is set.
 */
import type { Clocked } from "./clocked"
import { RegBlock, type RegDef } from "./regblock"

const LSI_HZ = 32000

export class Iwdg extends RegBlock implements Clocked {
  private started = false
  private unlocked = false
  private counter = 0xfff
  /** Core cycles to the next decrement. */
  private due = Infinity
  private hclkHz = 16e6
  private active = false
  onActive: (on: boolean) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  /** The counter hit zero: reset the chip. */
  onReset: () => void = () => {}

  constructor() {
    super("IWDG", 0x40003000, 0x400, [
      { name: "KR", offset: 0x00, rw: 0 },
      { name: "PR", offset: 0x04, rw: 7 },
      { name: "RLR", offset: 0x08, reset: 0xfff, rw: 0xfff },
      { name: "SR", offset: 0x0c, rw: 0 },
    ])
  }

  setClock(hclkHz: number) {
    this.hclkHz = hclkHz
  }

  reset() {
    super.reset()
    if (this.counter === undefined) return
    this.started = this.unlocked = false
    this.counter = 0xfff
    this.due = Infinity
    this.setActive(false)
  }

  /** The hardware-watchdog option byte: the dog runs from reset with the reset PR/RLR (512 ms). */
  hardwareStart() {
    this.write(0, 0xcccc, 4)
  }

  /** Core cycles per counter tick: LSI / (4 << PR). */
  private tickCycles() {
    return ((4 << (this.regs[1] & 7)) * this.hclkHz) / LSI_HZ
  }

  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    super.write(offset, value, size)
    this.reschedule()
  }

  protected onWrite(d: RegDef, next: number, _old: number, written: number): number | void {
    switch (d.name) {
      case "KR":
        switch (written & 0xffff) {
          case 0x5555:
            this.unlocked = true
            break
          case 0xaaaa:
            this.counter = this.regs[2] & 0xfff
            if (this.started) this.due = this.tickCycles()
            break
          case 0xcccc:
            if (!this.started) {
              this.started = true
              this.counter = this.regs[2] & 0xfff
              this.due = this.tickCycles()
              this.setActive(true)
            }
            break
          default:
            this.unlocked = false
        }
        return 0
      case "PR":
      case "RLR":
        // Writable only after the access key; the update flags (SR) clear at once here.
        return this.unlocked ? next : _old
    }
  }

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  tick(cycles: number) {
    if (!this.started) return
    this.due -= cycles
    while (this.due <= 0) {
      if (this.counter === 0) {
        this.started = false
        this.due = Infinity
        this.setActive(false)
        this.onReset()
        return
      }
      this.counter--
      this.due += this.tickCycles()
    }
  }

  cyclesUntilEvent(): number {
    return this.started ? Math.max(1, Math.ceil(this.due)) : Infinity
  }
}

export class Wwdg extends RegBlock implements Clocked {
  private due = Infinity
  private pclk1Hz = 16e6
  private hclkHz = 16e6
  private active = false
  onActive: (on: boolean) => void = () => {}
  sync: () => void = () => {}
  reschedule: () => void = () => {}
  raiseIrq: (irq: number) => void = () => {}
  onReset: () => void = () => {}

  constructor() {
    super("WWDG", 0x40002c00, 0x400, [
      { name: "CR", offset: 0x00, reset: 0x7f, rw: 0xff },
      { name: "CFR", offset: 0x04, reset: 0x7f, rw: 0x3ff },
      { name: "SR", offset: 0x08, rw: 0 },
    ])
  }

  setClock(pclk1Hz: number, hclkHz: number) {
    this.pclk1Hz = pclk1Hz
    this.hclkHz = hclkHz
  }

  reset() {
    super.reset()
    if (this.due === undefined) return
    this.due = Infinity
    this.setActive(false)
  }

  private running() {
    return (this.regs[0] & 0x80) !== 0
  }
  private tickCycles() {
    return ((4096 << ((this.regs[1] >>> 7) & 3)) * this.hclkHz) / this.pclk1Hz
  }

  write(offset: number, value: number, size: 1 | 2 | 4): void {
    this.sync()
    super.write(offset, value, size)
    this.reschedule()
  }

  protected onWrite(d: RegDef, next: number, old: number, written: number): number | void {
    switch (d.name) {
      case "CR": {
        // WDGA sticks once set. A refresh above the window is a reset.
        const v = (next | (old & 0x80)) >>> 0
        if (v & 0x80) {
          if (old & 0x80 && (old & 0x7f) > (this.regs[1] & 0x7f)) {
            this.onReset()
            return old
          }
          if (!(old & 0x80)) this.due = this.tickCycles()
          this.setActive(true)
        }
        return v
      }
      case "SR":
        // EWIF is write-zero-to-clear.
        return (old & written) >>> 0
    }
  }

  private setActive(on: boolean) {
    if (on === this.active) return
    this.active = on
    this.onActive(on)
  }

  tick(cycles: number) {
    if (!this.running()) return
    this.due -= cycles
    while (this.due <= 0) {
      const t = ((this.regs[0] & 0x7f) - 1) & 0x7f
      this.regs[0] = (this.regs[0] & ~0x7f) | t
      // Reaching 0x40: early wake-up; T6 clearing on the next tick: reset.
      if (t === 0x40 && this.regs[1] & (1 << 9)) {
        this.regs[2] |= 1
        this.raiseIrq(0)
      }
      if (!(t & 0x40)) {
        this.onReset()
        return
      }
      this.due += this.tickCycles()
    }
  }

  cyclesUntilEvent(): number {
    return this.running() ? Math.max(1, Math.ceil(this.due)) : Infinity
  }
}
