/**
 * TowerPro SG90 micro servo, as its sheet gives it (the TowerPro sheet as components101 and
 * FriendlyWire keep it, and Rapid 37-1330, Version 1 October 2013): an analog servo on a 20 ms
 * (50 Hz) pulse train, 1.5 ms the middle, ~2 ms all the way right (+90°), ~1 ms all the way left
 * (−90°), about 180° of travel; 0.1 s/60° at 4.8 V; dead band 10 µs.
 *
 * Supply current is the one thing the TowerPro and Rapid sheets leave out; the model takes the
 * vendor spec sheet's 90 mA running and 750 mA (±10 %) stalled at 4.8 V, and RobotShop's 4 mA at
 * rest (measured on the continuous-rotation SG90, the same board). A pulse asking for more than
 * the ±90° the sheet allows drives the horn into its end stop, where it stalls and draws the
 * stall current while the pulses keep asking.
 *
 * An analog servo drives its motor only in answer to pulses: when they stop, so does the horn,
 * and the gears hold it where it is.
 */
import type { DigitalEdge, DigitalPart } from "./digital-part"

export const SG90 = {
  /** Pulse width at the middle, and per 90° either way (s). */
  centre: 1.5e-3,
  perQuarterTurn: 0.5e-3,
  /** Travel either side of the middle, degrees. */
  travel: 90,
  /** Degrees per second at 4.8 V: 60° in 0.1 s. */
  speed: 60 / 0.1,
  /** Dead band width (s of pulse). */
  deadBand: 10e-6,
  /** Pulse period the sheet draws (s). */
  period: 20e-3,
  /** Supply current at rest, running and stalled (A). */
  idle: 4e-3,
  running: 0.09,
  stall: 0.75,
  /** The sheet's operating voltage. */
  volts: 4.8,
  /** Below this the electronics do not answer: the bottom of the 3–6 V Adafruit gives its sister SG92R; the SG90 sheets give none. */
  minVolts: 3,
} as const

export const SERVO_SUPPLY_KEY = "$servo"

/** The dead band as degrees of travel: 10 µs of a 500 µs quarter turn. */
const DEAD_BAND_DEGREES = (SG90.deadBand / SG90.perQuarterTurn) * SG90.travel

/** Pulses older than this many periods mean the train has stopped. */
const LOST_AFTER_PERIODS = 2

export type ServoSnapshot = {
  /** Horn angle, degrees clockwise from the middle. */
  angle: number
  /** Where the last pulse asked it to be, degrees (may lie past the end stop). */
  target: number | null
  /** The last pulse's width (s), and the period between the last two rising edges (s). */
  pulse: number | null
  period: number | null
  state: "idle" | "moving" | "holding" | "stalled"
  current: number
  vcc: number
}

export class Servo implements DigitalPart {
  readonly object: string
  readonly pins = ["SIG"] as const
  readonly outputs = [] as const
  readonly senses = ["VCC", "GND"] as const
  readonly out: DigitalEdge[] = []
  private angle = 0
  private target: number | null = null
  private pulse: number | null = null
  private period: number | null = null
  private riseAt = -Infinity
  private lastRise = -Infinity
  private high = false
  private time = 0
  private vcc = 0
  private state: ServoSnapshot["state"] = "idle"
  private loadCurrent = -1
  private loadOhms = 1e9

  constructor(object: string) {
    this.object = object
  }

  configure() {}

  reset() {
    this.target = null
    this.pulse = null
    this.period = null
    this.riseAt = -Infinity
    this.lastRise = -Infinity
    this.high = false
    this.time = 0
    this.state = "idle"
  }

  drive(): boolean | null {
    return null
  }

  sense(volts: (pin: string) => number, time: number) {
    const was = this.vcc >= SG90.minVolts
    this.vcc = Math.max(0, volts("VCC") - volts("GND"))
    if (was !== this.vcc >= SG90.minVolts) {
      this.advance(time)
      this.settle()
    }
  }

  input(pin: string, level: boolean, time: number) {
    if (pin !== "SIG" || level === this.high) return
    this.advance(time)
    this.high = level
    if (level) {
      if (Number.isFinite(this.lastRise)) this.period = time - this.lastRise
      this.lastRise = time
      this.riseAt = time
      return
    }
    if (!Number.isFinite(this.riseAt)) return
    const width = time - this.riseAt
    this.pulse = width
    const asked = ((width - SG90.centre) / SG90.perQuarterTurn) * SG90.travel
    // Within the dead band of where it was last sent, the servo does not react.
    if (this.target === null || Math.abs(asked - this.target) > DEAD_BAND_DEGREES) this.target = asked
    this.settle()
  }

  /** Whether pulses are still arriving at `time`. */
  private driven(time: number) {
    const period = this.period ?? SG90.period
    return this.vcc >= SG90.minVolts && this.target !== null && time - this.lastRise <= LOST_AFTER_PERIODS * Math.max(period, SG90.period)
  }

  private goal() {
    return Math.max(-SG90.travel, Math.min(SG90.travel, this.target ?? this.angle))
  }

  /** The state for the current target, angle and pulse train. */
  private settle() {
    if (!this.driven(this.time)) this.state = "idle"
    else if (Math.abs(this.goal() - this.angle) > 1e-9) this.state = "moving"
    // Pushing on the stop: only when the target lies past it by more than the dead band, as
    // inside the band the amplifier does not drive the motor at all.
    else if (this.target !== null && Math.abs(this.target) - SG90.travel > DEAD_BAND_DEGREES) this.state = "stalled"
    else this.state = "holding"
  }

  /** Move the horn from the last time to `time`. */
  private advance(time: number) {
    if (time <= this.time) return
    if (this.state === "moving") {
      const goal = this.goal()
      const step = SG90.speed * (time - this.time)
      this.angle = Math.abs(goal - this.angle) <= step ? goal : this.angle + Math.sign(goal - this.angle) * step
    }
    this.time = time
    this.settle()
  }

  tick(time: number): boolean {
    this.advance(time)
    const i = this.current()
    if (i === this.loadCurrent) return false
    this.loadCurrent = i
    this.loadOhms = this.vcc > 0.1 ? this.vcc / i : 1e9
    return true
  }

  quietUntil(): number {
    if (this.state === "moving") {
      // The horn reaches the goal (or the end stop) then: nothing changes before.
      return this.time + Math.abs(this.goal() - this.angle) / SG90.speed
    }
    if (this.state === "holding" || this.state === "stalled") return this.lastRise + LOST_AFTER_PERIODS * Math.max(this.period ?? SG90.period, SG90.period)
    return Infinity
  }

  private current(): number {
    if (this.vcc < SG90.minVolts) return 0
    return this.state === "stalled" ? SG90.stall : this.state === "moving" ? SG90.running : SG90.idle
  }

  analog(key: string): number | undefined {
    return key === SERVO_SUPPLY_KEY ? this.loadOhms : undefined
  }

  snapshot(): ServoSnapshot {
    return { angle: this.angle, target: this.target, pulse: this.pulse, period: this.period, state: this.state, current: this.current(), vcc: this.vcc }
  }
}
