import type { Cite } from "./types"

/**
 * A part's characteristics as a closed, typed system: what kind of number it is (KINDS), in what
 * quantity (QUANTITIES), its value as numbers (never text), the conditions it holds under, its page.
 * Nothing is written outside it: a new kind, quantity or condition is added here first, and the
 * tests (tests/sim/characteristics.test.ts) hold every record to it. Values are base SI; the unit
 * and prefix are the renderer's choice. One row each in the inspector (glyph · label · visual ·
 * number), drawn by the kind's visual; the abs-max limit rides in the same row as a red mark.
 */

// ---------------------------------------------------------------- quantities

export const QUANTITIES = {
  voltage: { unit: "V", scale: "linear" },
  current: { unit: "A", scale: "linear" },
  frequency: { unit: "Hz", scale: "log" },
  time: { unit: "s", scale: "log" },
  temperature: { unit: "°C", scale: "linear" },
  resistance: { unit: "Ω", scale: "log" },
  capacitance: { unit: "F", scale: "log" },
  inductance: { unit: "H", scale: "log" },
  power: { unit: "W", scale: "linear" },
  slewRate: { unit: "V/µs", scale: "log", factor: 1e-6 },
  thermalResistance: { unit: "°C/W", scale: "linear" },
  soundLevel: { unit: "dB", scale: "linear" },
  wavelength: { unit: "nm", scale: "linear", factor: 1e9 },
  torque: { unit: "kgf·cm", scale: "linear", factor: 10.197 },
  force: { unit: "gf", scale: "linear", factor: 101.97 },
  angle: { unit: "°", scale: "linear" },
  ratio: { unit: "%", scale: "linear", factor: 100 },
  count: { unit: "", scale: "linear" },
  address: { unit: "", scale: "linear" },
  memory: { unit: "B", scale: "log" },
  charge: { unit: "Ah", scale: "linear" },
} as const satisfies Record<string, { unit: string; scale: "linear" | "log"; factor?: number }>

export type Quantity = keyof typeof QUANTITIES

// ---------------------------------------------------------------- visuals

/**
 * The small closed set every kind is drawn with. range: a band on a linear scale with the abs-max
 * hatched beyond its red tick. rail: marks on a GND–VCC rail. log: a decade ruler with a pointer.
 * level: a meter with everyday anchors. swatch: colour from wavelength. tokens: mono chips.
 */
export type Visual = "range" | "rail" | "log" | "level" | "swatch" | "tokens"

export type Glyph = "rail" | "arrow" | "sine" | "clock" | "thermo" | "zigzag" | "speaker" | "prism" | "chip" | "battery" | "gear"

// ---------------------------------------------------------------- kinds

type KindDef = {
  /** Shown beside the visual: at most two words (a test holds it). */
  label: string
  quantity: Quantity
  visual: Visual
  glyph: Glyph
  /** An abs-max limit may ride in the row. */
  limit?: true
  /** A value may be given against a rail ("VCC − 1.7 V", "⅔ VCC"). */
  rail?: true
  /** A trip value may carry its release (hysteresis). */
  hysteresis?: true
  /** The value is a set of alternatives (addresses) or tokens (interfaces), not a number range. */
  set?: true
}

export const KINDS = {
  // power
  supply: { label: "Supply", quantity: "voltage", visual: "range", glyph: "rail", limit: true },
  supplyCurrent: { label: "Supply current", quantity: "current", visual: "range", glyph: "arrow", limit: true },
  quiescent: { label: "Quiescent", quantity: "current", visual: "log", glyph: "arrow" },
  input: { label: "Input", quantity: "voltage", visual: "range", glyph: "rail", limit: true },
  output: { label: "Output", quantity: "voltage", visual: "range", glyph: "rail", rail: true },
  dropout: { label: "Dropout", quantity: "voltage", visual: "range", glyph: "rail" },
  currentLimit: { label: "Current limit", quantity: "current", visual: "range", glyph: "arrow" },
  switching: { label: "Switching", quantity: "frequency", visual: "log", glyph: "sine" },
  // thermal
  temperature: { label: "Temperature", quantity: "temperature", visual: "range", glyph: "thermo", limit: true },
  thermal: { label: "Thermal", quantity: "thermalResistance", visual: "range", glyph: "thermo" },
  shutdown: { label: "Shutdown", quantity: "temperature", visual: "range", glyph: "thermo", hysteresis: true },
  dissipation: { label: "Dissipation", quantity: "power", visual: "range", glyph: "thermo", limit: true },
  // logic and pins
  inputHigh: { label: "Input high", quantity: "voltage", visual: "rail", glyph: "rail", rail: true },
  inputLow: { label: "Input low", quantity: "voltage", visual: "rail", glyph: "rail", rail: true },
  outputHigh: { label: "Output high", quantity: "voltage", visual: "rail", glyph: "rail", rail: true },
  outputLow: { label: "Output low", quantity: "voltage", visual: "rail", glyph: "rail", rail: true },
  threshold: { label: "Threshold", quantity: "voltage", visual: "rail", glyph: "rail", rail: true, hysteresis: true },
  trigger: { label: "Trigger", quantity: "voltage", visual: "rail", glyph: "rail", rail: true },
  outputCurrent: { label: "Output current", quantity: "current", visual: "range", glyph: "arrow", limit: true },
  shortCircuit: { label: "Short circuit", quantity: "current", visual: "range", glyph: "arrow" },
  swing: { label: "Output swing", quantity: "voltage", visual: "rail", glyph: "rail", rail: true },
  commonMode: { label: "Common mode", quantity: "voltage", visual: "rail", glyph: "rail", rail: true },
  pinVoltage: { label: "Pin voltage", quantity: "voltage", visual: "range", glyph: "rail", rail: true, limit: true },
  pinCurrent: { label: "Pin current", quantity: "current", visual: "range", glyph: "arrow", limit: true },
  inputBias: { label: "Input bias", quantity: "current", visual: "log", glyph: "arrow" },
  offset: { label: "Offset", quantity: "voltage", visual: "range", glyph: "rail" },
  bandwidth: { label: "Bandwidth", quantity: "frequency", visual: "log", glyph: "sine" },
  slew: { label: "Slew rate", quantity: "slewRate", visual: "log", glyph: "sine" },
  // timing
  clock: { label: "Max clock", quantity: "frequency", visual: "log", glyph: "sine" },
  busClock: { label: "Bus clock", quantity: "frequency", visual: "log", glyph: "sine" },
  delay: { label: "Delay", quantity: "time", visual: "log", glyph: "clock" },
  pulse: { label: "Min pulse", quantity: "time", visual: "log", glyph: "clock" },
  execution: { label: "Execution", quantity: "time", visual: "log", glyph: "clock" },
  timing: { label: "Timing range", quantity: "time", visual: "log", glyph: "clock" },
  tripTime: { label: "Trip time", quantity: "time", visual: "log", glyph: "clock" },
  // light
  forwardVoltage: { label: "Forward voltage", quantity: "voltage", visual: "range", glyph: "rail" },
  forwardCurrent: { label: "Forward current", quantity: "current", visual: "range", glyph: "arrow", limit: true },
  peakCurrent: { label: "Peak current", quantity: "current", visual: "range", glyph: "arrow", limit: true },
  reverseVoltage: { label: "Reverse voltage", quantity: "voltage", visual: "range", glyph: "rail", limit: true },
  wavelength: { label: "Colour", quantity: "wavelength", visual: "swatch", glyph: "prism" },
  segmentCurrent: { label: "Segment current", quantity: "current", visual: "log", glyph: "arrow" },
  contrast: { label: "Contrast", quantity: "voltage", visual: "range", glyph: "rail" },
  // battery
  float: { label: "Float", quantity: "voltage", visual: "rail", glyph: "battery" },
  chargeCurrent: { label: "Charge current", quantity: "current", visual: "range", glyph: "battery" },
  trickle: { label: "Trickle", quantity: "voltage", visual: "rail", glyph: "battery" },
  overcharge: { label: "Overcharge", quantity: "voltage", visual: "rail", glyph: "battery", hysteresis: true },
  overdischarge: { label: "Over-discharge", quantity: "voltage", visual: "rail", glyph: "battery", hysteresis: true },
  overcurrent: { label: "Overcurrent", quantity: "current", visual: "range", glyph: "battery" },
  onResistance: { label: "On resistance", quantity: "resistance", visual: "range", glyph: "zigzag" },
  hold: { label: "Hold", quantity: "current", visual: "range", glyph: "arrow" },
  trip: { label: "Trip", quantity: "current", visual: "range", glyph: "arrow" },
  // sound and motion
  soundLevel: { label: "Sound level", quantity: "soundLevel", visual: "level", glyph: "speaker" },
  tone: { label: "Tone", quantity: "frequency", visual: "log", glyph: "speaker" },
  coil: { label: "Coil", quantity: "resistance", visual: "range", glyph: "zigzag" },
  capacitance: { label: "Capacitance", quantity: "capacitance", visual: "log", glyph: "chip" },
  contactRating: { label: "Contact rating", quantity: "current", visual: "range", glyph: "arrow", limit: true },
  contactResistance: { label: "Contact", quantity: "resistance", visual: "range", glyph: "zigzag" },
  torque: { label: "Torque", quantity: "torque", visual: "range", glyph: "gear" },
  speed: { label: "Speed", quantity: "time", visual: "log", glyph: "gear" },
  pulseWidth: { label: "Pulse width", quantity: "time", visual: "range", glyph: "clock" },
  detents: { label: "Detents", quantity: "count", visual: "tokens", glyph: "gear", set: true },
  // digital
  address: { label: "Address", quantity: "address", visual: "tokens", glyph: "chip", set: true },
} as const satisfies Record<string, KindDef>

export type KindId = keyof typeof KINDS
export const kindOf = (id: KindId): KindDef => KINDS[id]

// ---------------------------------------------------------------- values

export type Rail = "VCC" | "VDD" | "GND"

/** A number, or a level against a rail: { rail: "VCC", offset: −1.7 } is VCC − 1.7 V; { rail: "VCC", times: 2/3 } is ⅔ VCC. */
export type Level = number | { rail: Rail; offset?: number; times?: number }

export type Value = {
  min?: Level
  typ?: Level
  max?: Level
  /** ±: the range is symmetric about zero (±6 mA), given by its max. */
  sym?: true
  /** Hysteresis: where it lets go after tripping at typ. */
  release?: number
  /** "About": an estimate, drawn dashed. */
  approx?: true
}

/** Under what the number holds: shown as chips on hover, never as words in the value. */
export type Condition =
  | { supply: number; sym?: true }
  | { vin: number }
  | { temp: number }
  | { load: { ohms?: number; amps?: number } }
  | { freq: number }
  | { distance: number }
  | { path: readonly [from: string, to: string] }
  | { state: "noLoad" | "outputLow" | "ratedDrive" | "shutdown" | "stall" }

/** What the number counts per: one pin, one amplifier, one segment, the whole package. */
export type Per = "pin" | "amp" | "segment" | "package" | "channel"

/** An LED colour a value belongs to, when the part carries several. */
export type Colour = "red" | "green" | "blue" | "white" | "yellow"

export type Characteristic = {
  kind: KindId
  /** The recommended or typical value. Absent only for a set kind or a limit-only row. */
  value?: Value
  /** Alternatives (addresses, detent counts). */
  set?: readonly number[]
  /** Abs max, drawn as the red tick in the same row (a kind with `limit`). */
  limit?: { min?: Level; max?: Level; sym?: true }
  at?: readonly Condition[]
  per?: Per
  colour?: Colour
  cite: Cite
  /** Where the limit comes from, when not the value's page. */
  limitCite?: Cite
}

// ---------------------------------------------------------------- text

const PREFIXES: [number, string][] = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
  [1e-12, "p"],
]
/** Units that take an SI prefix; the rest are shown as they are. */
const PREFIXED = new Set(["V", "A", "Hz", "s", "Ω", "F", "H", "W", "B", "Ah"])

const trim = (v: number) => {
  const r = Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100
  return String(r).replace("-", "−")
}

/** A number in a quantity's unit, with an SI prefix: 17e-9 s → "17 ns", 25e6 Hz → "25 MHz". */
export function formatNumber(v: number, quantity: Quantity, prefixFrom?: number): string {
  const q = QUANTITIES[quantity]
  if (quantity === "address") return `0x${v.toString(16).toUpperCase().padStart(2, "0")}`
  const shown = "factor" in q ? v * q.factor : v
  if (!PREFIXED.has(q.unit)) return q.unit ? `${trim(shown)} ${q.unit}` : trim(shown)
  const ref = Math.abs(prefixFrom ?? shown)
  const [f, p] = PREFIXES.find(([f]) => ref >= f * 0.9999) ?? PREFIXES[PREFIXES.length - 1]
  return `${trim(shown / f)} ${p}${q.unit}`
}

const FRACTIONS: [number, string][] = [
  [1 / 3, "⅓"],
  [2 / 3, "⅔"],
  [1 / 2, "½"],
]

function formatLevel(l: Level, quantity: Quantity, prefixFrom?: number): string {
  if (typeof l === "number") return formatNumber(l, quantity, prefixFrom)
  if (l.times !== undefined) return `${FRACTIONS.find(([f]) => Math.abs(f - l.times!) < 1e-6)?.[1] ?? trim(l.times)} ${l.rail}`
  if (l.offset) return `${l.rail} ${l.offset < 0 ? "−" : "+"} ${formatNumber(Math.abs(l.offset), quantity)}`
  return l.rail
}

/** The number alone, without its unit: for the near end of a range ("2–6 V"). */
const bare = (s: string) => s.replace(/\s*\S*$/, "")

/** A value as one short line: "2–6 V", "≥ 3.15 V", "±6 mA", "17 ns", "4.3 ↘ 4.1 V", "VCC − 1.7 V". */
export function formatValue(v: Value, quantity: Quantity): string {
  const nums = [v.min, v.typ, v.max].filter((x): x is number => typeof x === "number")
  const big = nums.length ? Math.max(...nums.map(Math.abs)) : undefined
  const f = (l: Level) => formatLevel(l, quantity, big)
  const approx = v.approx ? "~" : ""
  if (v.sym && v.max !== undefined) return `±${f(v.max)}`
  if (v.typ !== undefined && v.release !== undefined) return `${bare(f(v.typ))} ${v.release < (v.typ as number) ? "↘" : "↗"} ${formatNumber(v.release, quantity, big)}`
  if (v.typ !== undefined) return approx + f(v.typ)
  if (v.min !== undefined && v.max !== undefined) {
    const lo = f(v.min)
    const hi = f(v.max)
    const loUnit = lo.split(" ").slice(1).join(" ")
    const hiUnit = hi.split(" ").slice(1).join(" ")
    if (typeof v.min === "number" && typeof v.max === "number" && loUnit === hiUnit) return `${bare(lo)}${v.min < 0 ? " to " : "–"}${hi}`
    return `${lo} to ${hi}`
  }
  if (v.min !== undefined) return `≥ ${f(v.min)}`
  if (v.max !== undefined) return `≤ ${f(v.max)}`
  return ""
}

/** A characteristic as the hover card's short line: the value, the limit after a ⚠. */
export function formatCharacteristic(c: Characteristic): string {
  const q = KINDS[c.kind].quantity
  if (c.set) return c.set.map((n) => formatNumber(n, q)).join(" │ ")
  const value = c.value ? formatValue(c.value, q) : ""
  const limit = c.limit?.max !== undefined ? formatLevel(c.limit.max, q) : undefined
  return [value, limit && `⚠ ${limit}`].filter(Boolean).join(" ")
}

/** Conditions as chips: "4.5 V", "25 °C", "→ 2 kΩ", "RCLK→QA". */
export function formatCondition(c: Condition): string {
  if ("supply" in c) return `${c.sym ? "±" : ""}${formatNumber(c.supply, "voltage")}`
  if ("vin" in c) return `in ${formatNumber(c.vin, "voltage")}`
  if ("temp" in c) return formatNumber(c.temp, "temperature")
  if ("load" in c) return `→ ${c.load.ohms !== undefined ? formatNumber(c.load.ohms, "resistance") : formatNumber(c.load.amps!, "current")}`
  if ("freq" in c) return formatNumber(c.freq, "frequency")
  if ("distance" in c) return `${trim(c.distance * 100)} cm`
  if ("path" in c) return `${c.path[0]}→${c.path[1]}`
  return { noLoad: "no load", outputLow: "output low", ratedDrive: "rated drive", shutdown: "shut down", stall: "stall" }[c.state]
}
