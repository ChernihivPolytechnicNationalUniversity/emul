/**
 * What a chain's latched words light. Every chip runs its outputs as PWM at the datasheet's
 * frequency; before each solver step the stage works out what fraction of the step each
 * output is on, and turns that into what the analog circuit sees:
 *
 *   - `PixelLight`: LEDs inside the package. The circuit sees the supply current they draw
 *     (a live resistor VDD–GND); the field sees each pixel's colour.
 *   - `SinkLight`: constant-current outputs (OUTR/OUTG/OUTB…) for LEDs outside the package.
 *     Each output is a MOSFET sink whose gate the stage drives so that it carries the set
 *     current for the on-fraction of the step.
 */
import type { ChannelDrive } from "./format"
import type { Channel, ChipSpec } from "./spec"

/** Gate drive of an output sink: the solver's Id = k (Vgs − VTH)², `SINK_REFERENCE` at Vgs = VTH + 1. */
export const SINK_VTH = 1
export const SINK_K = 0.2
const gateFor = (fraction: number) => (fraction > 0 ? SINK_VTH + Math.sqrt(Math.min(1, fraction)) : 0)

/** Model key of output `output` (pin order) of chip `chip`: the gate node of its sink. */
export const sinkGate = (chip: number, output: number) => `$g${chip}_${output}`

/** Model key of the supply load (a live resistor VDD–GND). */
export const SUPPLY_KEY = "$idd"

/** Fraction of [t0, t1] during which a PWM output of period `p` and duty `d` (on at the start of each period) is on. */
export function onFraction(t0: number, t1: number, p: number, d: number): number {
  if (t1 <= t0) return d
  if (d <= 0) return 0
  if (d >= 1) return 1
  const on = d * p
  // Time on in [0, t): whole periods, plus the part of the last one.
  const upTo = (t: number) => {
    const n = Math.floor(t / p)
    return n * on + Math.min(on, t - n * p)
  }
  return (upTo(t1) - upTo(t0)) / (t1 - t0)
}

export abstract class LightStage {
  readonly spec: ChipSpec
  readonly chips: number
  readonly channels: readonly Channel[]
  /** Latched drive per chip, per channel. */
  readonly drive: ChannelDrive[][]
  /** On-fraction over the coming step, per chip and channel (flat). */
  protected readonly fraction: Float64Array
  private readonly period: number
  private last = 0
  /** Supply voltage the chip sees, for the supply load. */
  vdd = 0
  /** Whether the chip runs at all (powered, not burnt). */
  on = false

  constructor(spec: ChipSpec, chips: number, channels: readonly Channel[]) {
    this.spec = spec
    this.chips = chips
    this.channels = channels
    this.period = 1 / spec.pwmHz
    this.drive = Array.from({ length: chips }, () => channels.map(() => ({ duty: 0, scale: 1 })))
    this.fraction = new Float64Array(chips * channels.length)
  }

  /** Power-on state: every output off. */
  clear() {
    for (const chip of this.drive) for (const c of chip) {
      c.duty = 0
      c.scale = 1
    }
    this.fraction.fill(0)
  }

  /** A frame latched: chip `chip` drives `drive` from now on. */
  set(chip: number, drive: ChannelDrive[]) {
    this.drive[chip] = drive
  }

  /** The step ending at `time` is next: work out the on-fractions. True when anything the circuit sees changed. */
  tick(time: number): boolean {
    const t0 = this.last
    this.last = time
    let changed = false
    const n = this.channels.length
    for (let chip = 0; chip < this.chips; chip++)
      for (let c = 0; c < n; c++) {
        const f = this.on ? onFraction(t0, time, this.period, this.drive[chip][c].duty) : 0
        const i = chip * n + c
        if (f !== this.fraction[i]) {
          this.fraction[i] = f
          changed = true
        }
      }
    return changed
  }

  /** Until when no output changes state (Infinity when every output is steady on or off). */
  quietUntil(now: number): number {
    if (!this.on) return Infinity
    let next = Infinity
    const p = this.period
    for (const chip of this.drive)
      for (const c of chip) {
        if (c.duty <= 0 || c.duty >= 1) continue
        const n = Math.floor(now / p)
        const off = n * p + c.duty * p
        next = Math.min(next, off > now ? off : (n + 1) * p)
      }
    return next
  }

  /** Supply current averaged over the step just set up, A. */
  abstract current(): number

  /** Supply current averaged over whole PWM periods (what a meter reads), A. */
  abstract averageCurrent(): number

  /** Model element values this stage owns: undefined for a key it does not. */
  private loadCurrent = -1
  private loadOhms = 1e9

  analog(key: string): number | undefined {
    if (key !== SUPPLY_KEY) return undefined
    const i = this.current()
    // Ohms that draw `i` from the supply as it was last solved. Only a change of current moves
    // them: following the supply's own ripple under the load would keep the solver from ever
    // settling.
    if (i !== this.loadCurrent) {
      this.loadCurrent = i
      this.loadOhms = !(i > 0) || this.vdd <= 0.1 ? 1e9 : this.vdd / i
    }
    return this.loadOhms
  }
}

/** LEDs in the package: the supply carries their current, the field shows their colour. */
export class PixelLight extends LightStage {
  current(): number {
    if (!this.on) return 0
    const spec = this.spec
    if (spec.light.kind !== "pixel") return spec.quiescent
    let i = spec.quiescent * this.chips
    const n = this.channels.length
    for (let chip = 0; chip < this.chips; chip++)
      for (let c = 0; c < n; c++) i += (spec.light.current[this.channels[c]] ?? 0) * this.drive[chip][c].scale * this.fraction[chip * n + c]
    return i
  }

  averageCurrent(): number {
    if (!this.on || this.spec.light.kind !== "pixel") return this.on ? this.spec.quiescent * this.chips : 0
    const light = this.spec.light
    let i = this.spec.quiescent * this.chips
    for (const chip of this.drive) this.channels.forEach((ch, c) => (i += (light.current[ch] ?? 0) * chip[c].scale * chip[c].duty))
    return i
  }

  /** What chip `chip` looks like right now, 0xRRGGBB (its time-averaged light). */
  color(chip: number): number {
    if (!this.on) return 0
    let r = 0
    let g = 0
    let b = 0
    this.channels.forEach((ch, c) => {
      const tint = TINT[ch]
      const d = this.drive[chip][c].duty * this.drive[chip][c].scale
      r += tint[0] * d
      g += tint[1] * d
      b += tint[2] * d
    })
    const clamp = (v: number) => Math.min(255, Math.round(v))
    return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b)
  }
}

/** How each channel's LED reads on the field at full drive (sRGB): W2 is the warmer white of a five-channel part. */
const TINT: Record<Channel, readonly [number, number, number]> = {
  R: [255, 0, 0],
  G: [0, 255, 0],
  B: [0, 0, 255],
  W: [255, 255, 255],
  W2: [255, 196, 137],
}

/**
 * Constant-current outputs: each a sink the stage gates for the on-fraction of every step.
 * The set current is the datasheet's, or (WS2801) the feedback pin's reference voltage over
 * the resistor from that pin to ground, read off the last solve.
 */
export class SinkLight extends LightStage {
  /** Physical outputs: pin, the channel index it follows, its set current. */
  readonly outputs: { pin: string; channel: number; feedback?: string; current: number }[]

  constructor(spec: ChipSpec, chips: number, channels: readonly Channel[]) {
    super(spec, chips, channels)
    if (spec.light.kind !== "sink") throw new Error(`${spec.part} has no outputs`)
    const light = spec.light
    this.outputs = light.outputs.map((o) => ({ pin: o.pin, channel: channels.indexOf(o.channel), feedback: o.feedback, current: light.current[o.channel] ?? 0 }))
  }

  /** Full-scale current each output sinks, A. */
  sinkCurrent(output: number) {
    return this.outputs[output].current
  }

  /** A feedback pin read `volts` through the stage's own source (`FEEDBACK_R` from the reference): that sets its output's current. */
  setFeedback(output: number, volts: number) {
    const light = this.spec.light
    if (light.kind !== "sink" || !light.feedback) return
    const ref = light.feedback.volts
    // The pin sits at ref·R/(R + FEEDBACK_R): solve for R, the current is ref / R.
    const r = volts < ref - 1e-6 ? (FEEDBACK_R * volts) / (ref - volts) : Infinity
    this.outputs[output].current = Math.min(light.feedback.max, r > 0 ? ref / r : light.feedback.max)
  }

  current(): number {
    return this.on ? this.spec.quiescent * this.chips : 0
  }

  averageCurrent(): number {
    return this.current()
  }

  analog(key: string): number | undefined {
    if (key.startsWith("$g")) {
      const [chip, output] = key.slice(2).split("_").map(Number)
      const o = this.outputs[output]
      if (!(chip < this.chips) || !o || o.channel < 0) return undefined
      const n = this.channels.length
      // The sink saturates at the reference current; gating it for the scaled share of the
      // step makes it carry the set current × gain × duty on average.
      const set = (o.current * this.drive[chip][o.channel].scale) / SINK_REFERENCE
      return gateFor(this.fraction[chip * n + o.channel] * set)
    }
    return super.analog(key)
  }
}

/** Every output sink is built to saturate at this current; the stage gates it down to the set one. */
export const SINK_REFERENCE = 0.2

/** Source resistance behind a feedback pin's reference (the engine's sourced-voltage pad). */
export const FEEDBACK_R = 100
