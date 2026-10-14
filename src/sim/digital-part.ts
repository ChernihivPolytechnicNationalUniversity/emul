/**
 * The interface every digital part on the field implements, and the bit-level I²C slave several
 * of them build on. Kept apart from `digital.ts` (which constructs the parts) so a part's own
 * module can extend these without importing the registry of parts.
 */
import type { PartState } from "@/schematic/types"

export type DigitalEdge = { pin: string; level: boolean | null; time: number }

export interface DigitalPart {
  readonly object: string
  /** Model node names the part listens on and drives. */
  readonly pins: readonly string[]
  /** What the part drives on a pin right now: true/false push-pull, null released. */
  drive(pin: string): boolean | null
  /** The resolved level of a pin's net changed at `time` (seconds, loop clock). */
  input(pin: string, level: boolean, time: number): void
  /** Drives the part changed since the loop last drained them, in order. */
  readonly out: DigitalEdge[]
  /** Power-on state. */
  reset(): void
  /** Props changed on the field. */
  configure(props: Record<string, string>): void
  /** A part of the component was touched on the field (a display's panel): its state, by part id, at loop time `time`. */
  interact?(part: string, state: PartState, time: number): void
  /**
   * Time passes (called before every solver step, with the step's end): for parts with a clock
   * of their own (a scan period). True when what `analog` answers changed.
   */
  tick?(time: number): boolean | void
  /** Pins the part can drive; absent, any of `pins`. A core that only feeds listen-only pins need not hand its edges over one by one. */
  readonly outputs?: readonly string[]
  /** Pins whose voltage the part reads after every solver step (its supply, an input's high level). */
  readonly senses?: readonly string[]
  sense?(volts: (pin: string) => number, time: number): void
  /**
   * A model element's value the part sets itself, by node or `live` key: volts for a GPIO
   * node it sources as a voltage, ohms for a live resistor; undefined for a key it does not own.
   */
  analog?(key: string): number | undefined
  parts?(): Record<string, { on: boolean; level: number }>
  pressure?(): number
  pitch?(): number | null
  /** The component burnt out: the die is dead. */
  burn?(): void
  /** Until when `tick` drives nothing, as long as no input or interaction comes (a part with a `tick` and without this is never skipped over). */
  quietUntil?(): number
  /** What the UI shows about the part, if anything. Plain data: it crosses the worker boundary. */
  snapshot(): unknown
  /** The part as built no longer matches the object's props (another part number): build a new one. */
  outdated?(props: Record<string, string>): boolean
  prime?(levels: Map<string, boolean>, time: number): void
  readonly supply?: { vcc: string; gnd: string }
  senseSupply?(vcc: number, read: (pin: string) => number, time: number): void
  thresholds?(): [falling: number, rising: number]
}

// --- I²C slave scaffold ----------------------------------------------------------------------

/**
 * The bit-level side of an I²C slave: START/STOP detection, address match, ACKs, bytes in and
 * out. A part built on it gets whole bytes: `onSelected` when addressed, `onByte` for each
 * byte written, `nextByte` for each byte the master reads, `onStop` at the end.
 */
export abstract class I2cSlave implements DigitalPart {
  readonly object: string
  abstract readonly pins: readonly string[]
  readonly out: DigitalEdge[] = []
  protected readonly sdaPin: string
  protected readonly sclPin: string
  private sda = true
  private scl = true
  private state: "idle" | "addr" | "ack" | "write" | "read" | "readAck" | "skip" = "idle"
  private shift = 0
  private bit = 0
  private reading = false
  private readByte = 0
  private sdaDrive: boolean | null = null

  constructor(object: string, sdaPin: string, sclPin: string) {
    this.object = object
    this.sdaPin = sdaPin
    this.sclPin = sclPin
  }

  /** 7-bit address this part answers, or -1 to stay silent. */
  protected abstract address(): number
  protected abstract onSelected(read: boolean): void
  protected abstract onByte(byte: number): void
  protected abstract nextByte(): number
  protected onStop(_time: number): void {}
  protected onStart(): void {}

  abstract configure(props: Record<string, string>): void
  abstract snapshot(): unknown

  reset() {
    this.state = "idle"
    this.setSda(null, 0)
  }

  drive(pin: string): boolean | null {
    return pin === this.sdaPin ? this.sdaDrive : null
  }

  protected setSda(level: boolean | null, time: number) {
    if (this.sdaDrive === level) return
    this.sdaDrive = level
    this.out.push({ pin: this.sdaPin, level, time })
  }

  input(pin: string, level: boolean, time: number) {
    if (pin === this.sdaPin) {
      if (this.scl) {
        if (!level && this.sda) {
          this.state = "addr"
          this.shift = 0
          this.bit = 0
          this.onStart()
        } else if (level && !this.sda) {
          this.state = "idle"
          this.setSda(null, time)
          this.onStop(time)
        }
      }
      this.sda = level
    } else if (pin === this.sclPin) {
      if (level && !this.scl) this.onSclRise()
      else if (!level && this.scl) this.onSclFall(time)
      this.scl = level
    }
  }

  private onSclRise() {
    switch (this.state) {
      case "addr":
      case "write":
        this.shift = ((this.shift << 1) | (this.sda ? 1 : 0)) & 0xff
        this.bit++
        return
      case "readAck":
        this.reading = !this.sda
        return
    }
  }

  private onSclFall(time: number) {
    switch (this.state) {
      case "addr":
        if (this.bit < 8) return
        this.bit = 0
        if (this.shift >>> 1 !== this.address()) {
          this.state = "skip"
          return
        }
        this.reading = (this.shift & 1) === 1
        this.onSelected(this.reading)
        this.setSda(false, time)
        this.state = "ack"
        return
      case "write":
        if (this.bit < 8) return
        this.bit = 0
        this.onByte(this.shift)
        this.setSda(false, time)
        this.state = "ack"
        return
      case "ack":
        this.setSda(null, time)
        if (this.reading) this.startReadByte(time)
        else this.state = "write"
        return
      case "read":
        this.bit++
        if (this.bit < 8) this.setSda(((this.readByte >>> (7 - this.bit)) & 1) === 1 ? null : false, time)
        else {
          this.setSda(null, time)
          this.state = "readAck"
        }
        return
      case "readAck":
        if (this.reading) this.startReadByte(time)
        else this.state = "skip"
        return
    }
  }

  private startReadByte(time: number) {
    this.readByte = this.nextByte() & 0xff
    this.bit = 0
    this.state = "read"
    this.setSda((this.readByte & 0x80) !== 0 ? null : false, time)
  }
}

