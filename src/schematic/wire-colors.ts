import type { PinKind } from "./types"

export const WIRE_COLORS = [
  "black",
  "brown",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
  "grey",
  "white",
  "cyan",
  "magenta",
] as const

export type WireColorKey = (typeof WIRE_COLORS)[number]

const KEY_SET: ReadonlySet<string> = new Set(WIRE_COLORS)

export const isWireColor = (v: string | undefined): v is WireColorKey => !!v && KEY_SET.has(v)

export const wireColorVar = (key: WireColorKey) => `var(--wire-${key})`

export const wireFlowVar = (key: WireColorKey) => `var(--wire-${key}-flow)`

const SHORTCUTS: readonly (readonly [label: string, color: WireColorKey])[] = [
  ["0", "black"],
  ["1", "brown"],
  ["2", "red"],
  ["3", "orange"],
  ["4", "yellow"],
  ["5", "green"],
  ["6", "blue"],
  ["7", "violet"],
  ["8", "grey"],
  ["9", "white"],
  ["C", "cyan"],
  ["M", "magenta"],
]

const codesFor = (label: string) => (/^\d$/.test(label) ? [`Digit${label}`, `Numpad${label}`] : [`Key${label}`])

export const WIRE_COLOR_BY_CODE: ReadonlyMap<string, WireColorKey> = new Map(
  SHORTCUTS.flatMap(([label, color]) => codesFor(label).map((code) => [code, color] as const)),
)

export const WIRE_COLOR_SHORTCUT: Readonly<Record<WireColorKey, string>> = Object.fromEntries(
  SHORTCUTS.map(([label, color]) => [color, label]),
) as Record<WireColorKey, string>

export const AUTO_COLOR_ORDER: readonly WireColorKey[] = [
  "blue",
  "orange",
  "green",
  "violet",
  "cyan",
  "brown",
  "magenta",
  "yellow",
]

export const DEFAULT_SIGNAL_COLOR: WireColorKey = "black"

export function autoNetColor(kinds: Iterable<PinKind>): WireColorKey {
  const semantic = semanticNetColor(kinds)
  return semantic ?? DEFAULT_SIGNAL_COLOR
}

export function semanticNetColor(kinds: Iterable<PinKind>): WireColorKey | undefined {
  let power = false
  for (const k of kinds) {
    if (k === "gnd") return "black"
    if (k === "power") power = true
  }
  return power ? "red" : undefined
}
