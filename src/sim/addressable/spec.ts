/**
 * What a cascadable LED chip is, as its datasheet tells it: how bits arrive, how a frame and
 * a chip's share of it are laid out, what it lights and from what supply. The behaviour in
 * `chain.ts` is generic over these; the table of real parts is in `parts.ts`.
 */

/** [min, max], seconds or volts. */
export type Range = readonly [number, number]

/** Single-wire NRZ code ("Data transfer time" table), seconds. */
export type NrzTiming = {
  t0h: Range
  t1h: Range
  t0l: Range
  t1l: Range
  /** Low time that ends a frame and latches it (RES / Treset minimum). */
  reset: number
}

/** Clock-and-data input (WS2801): data sampled on the rising clock edge, latched after the clock idles low. */
export type ClockedTiming = {
  /** Highest clock rate the datasheet allows, Hz. */
  maxHz: number
  /** Clock held low this long latches the frame. */
  latch: number
}

/**
 * How the chip is fed.
 *   `backup`: a second data input (BIN, DIN2, BI) the chip falls back to when the chip
 *     before it dies (WS2813, WS2815, WS2818, WS2805…).
 *   `relay`: a BO output that repeats the chip's input for the next chip's BI (WS2816,
 *     WS2916, the later WS2813s).
 *   `bidirectional`: DIN and DOUT are interchangeable; the first to carry data is the input
 *     (WS2812B-V6).
 */
export type InputSpec =
  | { kind: "nrz"; timing: NrzTiming; backup?: boolean; relay?: boolean; bidirectional?: boolean }
  | { kind: "clocked"; timing: ClockedTiming }

/** Light channels: red, green, blue, white, and the second white of a five-channel part. */
export type Channel = "R" | "G" | "B" | "W" | "W2"

/**
 * One field, in wire order (MSB first). `level` sets a channel's PWM duty; `gain` scales its
 * output current (the 5-bit current gain of the WS291x parts); `check` is a fixed check bit
 * the chip does not use.
 */
export type FieldSpec = { channel: Channel | null; bits: number; role: "level" | "gain" | "check" }

/**
 * What lights. `pixel`: LEDs inside the package, `current` each at full duty and gain.
 * `sink`: constant-current outputs for LEDs outside it, in pin order with the data channel
 * each one follows (WS2914's OUTW2 follows W); the current is fixed, or set by a resistor
 * from a feedback pin to ground (WS2801: I = `feedback` volts / R).
 */
export type LightSpec =
  | { kind: "pixel"; current: Partial<Record<Channel, number>> }
  | {
      kind: "sink"
      outputs: readonly { pin: string; channel: Channel; feedback?: string }[]
      current: Partial<Record<Channel, number>>
      withstand: number
      feedback?: { volts: number; max: number }
    }

/**
 * A strap pin the die reads: a SET that picks the 400 kHz timing (WS2811, 2011) or a mode the
 * model does not have (WS2913's 8-bit mode), a POL that inverts the outputs (WS2801).
 */
export type StrapSpec = {
  pin: string
  /** The die's own pull-up on the pin, Ω (a floating pin without one reads low). */
  pullUp?: number
  /** What the pin does held high, and held (or left) low. */
  high?: StrapEffect
  low?: StrapEffect
}
export type StrapEffect = { kind: "timing"; timing: NrzTiming } | { kind: "invert" } | { kind: "unmodelled"; what: string }

export type ChipSpec = {
  /** Part number as printed ("WS2812B-V5"). */
  part: string
  /** What the part is, for the inspector's select. */
  label: string
  input: InputSpec
  /** One chip's word, wire order. */
  fields: readonly FieldSpec[]
  /** A header every frame starts with, read by every chip and passed on ahead of the remaining words (the WS291x current gains). */
  header?: readonly FieldSpec[]
  /** Level code that means fully on (default all ones; WS2801: 256, so 0xFF is 255/256). */
  fullScale?: number
  light: LightSpec
  /** Output PWM frequency, Hz. */
  pwmHz: number
  /**
   * Supply at the die's supply pin (`logic.pin`): below `min` the chip is off (its power-on
   * reset clears the latches), past `abs` the die is gone.
   */
  supply: { min: number; max: number; abs: number }
  /** Supply current with every output off, A. */
  quiescent: number
  /**
   * The die's supply pin (VDD, or VCC on parts that feed the LEDs and the control circuit
   * separately) and the input high threshold: a fraction of that supply, or a fixed voltage
   * (the 2.7 V of the V5 parts, the 3.5 V of a 12 V part's internal 5 V rail).
   */
  logic: { pin: "VDD" | "VCC"; vih: { ratio: number } | { volts: number } }
  /** VCC is the output of the die's own regulator (a 12 V part): held at this voltage from VDD. */
  regulator?: number
  /**
   * VDD is held by a built-in shunt regulator, so a higher supply only needs a series resistor
   * ("only a resistance needed … when under 24V"): the voltage it clamps at.
   */
  clamp?: number
  /** Data input absolute maximum against ground, V. */
  inputMax: number
  /** DIN → DO propagation (tPLZ), s. */
  delay: number
  strap?: StrapSpec
  /** Datasheet the numbers come from, and anything the model had to decide on its own. */
  source: string
}

const sumBits = (fields: readonly FieldSpec[] | undefined) => (fields ?? []).reduce((n, f) => n + f.bits, 0)

/** Bits in one chip's word. */
export const wordBits = (spec: ChipSpec) => sumBits(spec.fields)

/** Bits in the frame header. */
export const headerBits = (spec: ChipSpec) => sumBits(spec.header)

const CHANNEL_ORDER: readonly Channel[] = ["R", "G", "B", "W", "W2"]

/** Data channels the chip has, in canonical order (R, G, B, W, W2), whatever the wire order. */
export const channelsOf = (spec: ChipSpec): Channel[] => CHANNEL_ORDER.filter((c) => spec.fields.some((f) => f.channel === c && f.role === "level"))
