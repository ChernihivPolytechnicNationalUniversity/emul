/**
 * One PIC16F62x port (PORTx/TRISx) on the pin logic of DS40044G §5 (Figures 5-1…5-15): a data
 * latch and a TRIS latch per pin; reading PORTx reads the pins, writing it the latch (P1-198).
 * Whatever the alternate functions do to a pin — analog input that reads 0, an output the
 * peripheral drives, open drain, input only, an oscillator pin — the SoC says through `mode`.
 *
 * A write lands at the end of Q4, a read samples the pin in Q2 (§5.3.2, Figure 5-16, P1-245): the
 * level a read at fractional cycle `at` sees is the one the pin had then.
 */
import type { PadDrive } from "../periph/gpio"

/** What the alternate functions make of one pin. */
export type PinMode = {
  /** The digital input buffer works; false: an analog input or an oscillator pin, which reads 0 (P1-199, P1-201). */
  digital: boolean
  /** The pin can drive at all (false: RA5, an oscillator pin, RB4 as PGM). */
  output: boolean
  /** A peripheral decides direction and level (USART, CCP, comparator outputs, CLKOUT): undefined leaves TRIS and the latch. */
  outEnable?: boolean
  outValue?: boolean | number
  /** N-channel only: a high releases the pin (RA4, P1-207). */
  openDrain: boolean
  /** The weak pull-up is on (PORTB, RBPU = 0, the pin an input; P1-223). */
  pullUp: boolean
}

export class PicPort {
  readonly letter: string
  readonly index: number
  latch = 0
  tris = 0xff
  /** Pins the circuit is wired to: their input comes from `external`; the others read their own drive. */
  sensed = 0
  readonly drive: PadDrive[] = new Array<PadDrive>(8).fill(null)
  version = 0
  /** The SoC's view of every pin. */
  mode: (pin: number) => PinMode
  /** A pin's drive changed at `cycle`. */
  onDrive: (pin: number, drive: PadDrive, cycle: number) => void = () => {}
  /** A pin's digital input level changed at `cycle` (fractional for outside edges). */
  onInput: (pin: number, level: boolean, cycle: number) => void = () => {}

  private readonly external = new Array<boolean>(8).fill(false)
  private readonly sampledUnder: (PadDrive | undefined)[] = new Array(8).fill(undefined)
  /** Level at the pin now, the one before, and the cycle it changed. */
  private readonly level = new Array<boolean>(8).fill(false)
  private readonly prev = new Array<boolean>(8).fill(false)
  private readonly since = new Array<number>(8).fill(-Infinity)
  private readonly digital = new Array<boolean>(8).fill(true)

  constructor(letter: string, index: number, mode: (pin: number) => PinMode) {
    this.letter = letter
    this.index = index
    this.mode = mode
  }

  /** The level the pin had at fractional cycle `at` (the input buffer's view, before analog gating). */
  pinAt(p: number, at: number): boolean {
    return this.since[p] > at ? this.prev[p] : this.level[p]
  }
  /** PORTx as read in Q2 at `at`: analog and oscillator pins read 0. */
  read(at: number): number {
    let v = 0
    for (let p = 0; p < 8; p++) if (this.digital[p] && this.pinAt(p, at)) v |= 1 << p
    return v
  }
  /** The digital level a peripheral input sees now (0 when the buffer is off). */
  di(p: number): boolean {
    return this.digital[p] && this.level[p]
  }
  /** The raw pin level (comparator inputs, programming entry). */
  pin(p: number): boolean {
    return this.level[p]
  }

  writeLatch(v: number, cycle: number) {
    this.latch = v & 0xff
    this.refresh(cycle)
  }
  writeTris(v: number, cycle: number) {
    this.tris = v & 0xff
    this.refresh(cycle)
  }

  setExternal(p: number, level: boolean, cycle: number, under: PadDrive = this.drive[p]) {
    this.external[p] = level
    this.sampledUnder[p] = under
    this.updateInput(p, cycle)
  }

  /** Recompute every pin; changes take effect at `cycle`. */
  refresh(cycle: number) {
    for (let p = 0; p < 8; p++) {
      const m = this.mode(p)
      const out = m.output && (m.outEnable ?? !((this.tris >> p) & 1))
      let drive: PadDrive = null
      if (out) {
        const v = m.outValue ?? ((this.latch >> p) & 1) === 1
        if (typeof v === "number") drive = v
        else drive = v ? (m.openDrain ? null : "high") : "low"
      }
      if (drive === null && m.pullUp) drive = "pullup"
      this.digital[p] = m.digital
      if (drive !== this.drive[p]) {
        this.drive[p] = drive
        this.version++
        this.onDrive(p, drive, cycle)
      }
      this.updateInput(p, cycle)
    }
  }

  /**
   * What the pin is at: an unwired pad (or one the circuit has not reported yet) is at its own
   * drive; a wired pad at the circuit's level, except while it drives a level the circuit has not
   * been solved under yet.
   */
  private updateInput(p: number, cycle: number) {
    const d = this.drive[p]
    const own = d === "high" || d === "pullup" || (typeof d === "number" && d > 0)
    const under = this.sampledUnder[p]
    let lvl: boolean
    if (!((this.sensed >> p) & 1) || under === undefined) lvl = own
    else if ((d === "high" || d === "low") && under !== d) lvl = own
    else lvl = this.external[p]
    if (lvl !== this.level[p]) {
      this.prev[p] = this.level[p]
      this.level[p] = lvl
      this.since[p] = cycle
      this.onInput(p, lvl, cycle)
    }
  }
}
