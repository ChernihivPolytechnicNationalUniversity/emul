/**
 * One I/O port (PINx/DDRx/PORTx), modelled on the data sheet's pin logic (DS40002061B §14.2,
 * Figures 14-2 and 14-5): every pin's driver, pull-up and input buffer are decided by the
 * register bits unless an alternate function overrides them through PUOE/PUOV, DDOE/DDOV,
 * PVOE/PVOV and DIEOE/DIEOV (Table 14-2). The SoC wires each pin's alternate functions (the
 * port tables 14-4…14-11) as one function that fills in the override signals.
 *
 * Reading PINx goes through the synchronizer: a read in clock cycle n returns the pin as it
 * was half a cycle before (Figures 14-3/14-4), so `out PORTx` followed at once by `in PINx`
 * still reads the old level and one NOP in between makes it read the new one. A register
 * write changes the pin at the end of the write cycle.
 */
import type { PadDrive } from "../periph/gpio"

/** Override signals of one pin (Table 14-2); all clear means plain GPIO. */
export type PinOverride = {
  puoe: boolean
  puov: boolean
  ddoe: boolean
  ddov: boolean
  pvoe: boolean
  pvov: boolean
  dieoe: boolean
  dieov: boolean
}

export type AltFunction = (o: PinOverride) => void

const blank = (): PinOverride => ({ puoe: false, puov: false, ddoe: false, ddov: false, pvoe: false, pvov: false, dieoe: false, dieov: false })

export class Port {
  readonly letter: string
  readonly index: number
  readonly mask: number
  ddr = 0
  port = 0
  /** Alternate functions per pin (the SoC fills these from the port tables). */
  readonly alt: (AltFunction | null)[] = new Array(8).fill(null)
  /** What each pin drives, as the circuit sees it. */
  readonly drive: PadDrive[] = new Array<PadDrive>(8).fill(null)
  /** Counts every change of `drive`. */
  version = 0
  /** Pins the circuit is wired to: their input comes from `external`; the others read their own drive. */
  sensed = 0
  /** Level on the pad as the circuit last reported it, and the pin's drive at the time. */
  private readonly external = new Array<boolean>(8).fill(false)
  private readonly sampledUnder: (PadDrive | undefined)[] = new Array(8).fill(undefined)
  /** Level the input buffer sees now, the one before, and the cycle it changed (fractional for outside edges). */
  private readonly level = new Array<boolean>(8).fill(false)
  private readonly prev = new Array<boolean>(8).fill(false)
  private readonly since = new Array<number>(8).fill(-Infinity)
  /** Digital input enabled per pin (after DIDR, sleep clamping and the overrides). */
  private readonly die = new Array<boolean>(8).fill(true)
  /** The DI signal alternate functions see: the level when the input is enabled, 0 when clamped. */
  private readonly diLevel = new Array<boolean>(8).fill(false)
  private readonly ov = blank()
  /** MCUCR.PUD, shared by all ports. */
  pud = false
  /** The sleep controller's SLEEP signal: input buffers clamped unless an override keeps them on. */
  sleepClamp = false
  /** A pin's DI signal changed (alternate-function inputs: INTn, PCINT, ICP1, Tn, RXD, SPI, TWI). */
  onInput: (pin: number, level: boolean, cycle: number) => void = () => {}
  /** A pin's drive changed at `cycle`. */
  onDrive: (pin: number, drive: PadDrive, cycle: number) => void = () => {}

  constructor(letter: string, index: number, mask: number) {
    this.letter = letter
    this.index = index
    this.mask = mask
  }

  reset() {
    this.ddr = 0
    this.port = 0
    this.pud = false
    this.sleepClamp = false
    for (let p = 0; p < 8; p++) {
      this.since[p] = -Infinity
      this.prev[p] = this.level[p]
    }
    this.refresh(0)
  }

  /** The level a read of PINx in clock cycle `at` returns for one pin. */
  private pinAt(p: number, at: number): boolean {
    if (!this.die[p]) return false
    return this.since[p] > at - 0.5 ? this.prev[p] : this.level[p]
  }
  readPin(at: number): number {
    let v = 0
    for (let p = 0; p < 8; p++) if (this.mask & (1 << p) && this.pinAt(p, at)) v |= 1 << p
    return v
  }
  /** The digital input to alternate functions (before the synchronizer, Table 14-2 DI). */
  di(p: number): boolean {
    return this.diLevel[p]
  }

  /** Writing a one to PINxn toggles PORTxn (§14.2.2). */
  writePin(value: number, mask: number, at: number) {
    const t = value & mask & this.mask
    if (t) this.writePort(this.port ^ t, at)
  }
  writePort(value: number, at: number) {
    this.port = value & this.mask
    this.refresh(at + 1)
  }
  writeDdr(value: number, at: number) {
    this.ddr = value & this.mask
    this.refresh(at + 1)
  }

  /** The circuit reports a pad level (sampled under `under`, the drive the solver saw). */
  setExternal(p: number, level: boolean, cycle: number, under: PadDrive = this.drive[p]) {
    this.external[p] = level
    this.sampledUnder[p] = under
    this.updateInput(p, cycle)
  }

  /** Recompute every pin from the registers and overrides; changes take effect at `cycle`. */
  refresh(cycle: number) {
    for (let p = 0; p < 8; p++) {
      if (!(this.mask & (1 << p))) continue
      const o = this.ov
      o.puoe = o.puov = o.ddoe = o.ddov = o.pvoe = o.pvov = o.dieoe = o.dieov = false
      this.alt[p]?.(o)
      const ddBit = (this.ddr >> p) & 1
      const portBit = (this.port >> p) & 1
      const out = o.ddoe ? o.ddov : ddBit === 1
      const value = o.pvoe ? o.pvov : portBit === 1
      const pull = o.puoe ? o.puov : ddBit === 0 && portBit === 1 && !this.pud
      const drive: PadDrive = out ? (value ? "high" : "low") : pull ? "pullup" : null
      this.die[p] = o.dieoe ? o.dieov : !this.sleepClamp
      if (drive !== this.drive[p]) {
        this.drive[p] = drive
        this.version++
        this.onDrive(p, drive, cycle)
      }
      this.updateInput(p, cycle)
    }
  }

  /**
   * What the input buffer sees: an unwired pad (or one the circuit has not reported yet) reads
   * its own drive; a wired pad reads the circuit's level, except while the pin drives a level
   * the circuit has not been solved under yet — then it reads what it drives.
   */
  private updateInput(p: number, cycle: number) {
    const d = this.drive[p]
    const own = d === "high" || d === "pullup"
    const under = this.sampledUnder[p]
    let lvl: boolean
    if (!((this.sensed >> p) & 1) || under === undefined) lvl = own
    else if ((d === "high" || d === "low") && under !== d) lvl = own
    else lvl = this.external[p]
    if (lvl !== this.level[p]) {
      this.prev[p] = this.level[p]
      this.level[p] = lvl
      this.since[p] = cycle
    }
    const di = this.die[p] && lvl
    if (di !== this.diLevel[p]) {
      this.diLevel[p] = di
      this.onInput(p, di, cycle)
    }
  }
}
