const PREFIX: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
}

/** SI prefixes offered in the inspector, smallest first; "" is the bare unit. */
export const SI_PREFIXES = ["p", "n", "µ", "m", "", "k", "M", "G"] as const
export type SiPrefix = (typeof SI_PREFIXES)[number]

/** Prefixes that make sense for each unit, so a resistor does not offer picoohms. */
export const UNIT_PREFIXES: Record<string, readonly SiPrefix[]> = {
  "Ω": ["m", "", "k", "M"],
  V: ["µ", "m", "", "k"],
  A: ["µ", "m", "", "k"],
  W: ["m", "", "k"],
  F: ["p", "n", "µ", "m"],
  H: ["n", "µ", "m", ""],
  Hz: ["", "k", "M"],
  Ah: ["m", ""],
  VA: ["", "k"],
}

/** Normalise the spellings the parser accepts to the one prefix shown in menus. */
const CANONICAL: Record<string, SiPrefix> = { u: "µ", μ: "µ", K: "k" }

/** Split "4.7 kΩ" into its number text and prefix; the unit is dropped. Unparsable → empty number. */
export function splitValue(text: string): { number: string; prefix: SiPrefix } {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([pnuµμmkKMG])?/.exec(text)
  if (!m) return { number: "", prefix: "" }
  const raw = m[2] ?? ""
  return { number: m[1], prefix: CANONICAL[raw] ?? (raw as SiPrefix) }
}

/** The stored form of a quantity: "4.7 kΩ", "50 Hz", "0 V". */
export const joinValue = (number: string, prefix: string, unit: string) => `${number.trim()} ${prefix}${unit}`

/** Parse "4.7 kΩ", "100nF", "3 V", "1e-6" into a number. Returns NaN when unparsable. */
export function parseValue(text: string): number {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([pnuµμmkKMG])?/.exec(text)
  if (!m) return NaN
  const n = Number(m[1])
  return m[2] ? n * PREFIX[m[2]] : n
}

/** Format a voltage/current for display: 3.30 V, 12.5 mA, 3.3 MA. */
export function formatSI(v: number, unit: string, digits = 2): string {
  const a = Math.abs(v)
  // Below a hundredth of a nanounit is solver noise, not a reading: show it as the zero it is.
  if (a < 1e-11 || !Number.isFinite(v)) return `0 ${unit}`
  if (a >= 1e12) return `${v.toExponential(1)} ${unit}`
  let k = DISPLAY_PREFIXES.findIndex(([scale]) => a >= scale)
  if (k < 0) k = DISPLAY_PREFIXES.length - 1
  if (k > 0 && Number((a / DISPLAY_PREFIXES[k][0]).toFixed(digits)) >= 1000) k--
  const [scale, prefix] = DISPLAY_PREFIXES[k]
  return `${(v / scale).toFixed(digits)} ${prefix}${unit}`
}

const DISPLAY_PREFIXES = [
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
] as const
