import { GENERIC_OPAMP, OPAMP_PRESETS, type OpampPreset } from "@/sim/opamp"
import { parseValue } from "@/sim/units"
import { OpAmpIcon } from "../icons"
import { pinNumbers } from "../pin-numbers"
import type { BodyShape, ComponentDef, ModelElement, PinDef, PropField } from "../types"

/**
 * Op amps as the schematic draws them: a triangle, IN− above IN+ on its left edge, the output at
 * its point, V+ and V− on its upper and lower edges with their leads running up and down to the
 * edge of the cell box. One palette entry per preset in `OPAMP_PRESETS`, `opamp-<preset id>`.
 */

const W = 6
const H = 6
const TRIANGLE = "M1 1 L5 3 L1 5 Z"

function pinsOf(p: OpampPreset): PinDef[] {
  const dip = p.dip
  const on = (n: number | undefined) => (dip && n !== undefined ? { connector: dip.package, connectorPin: n } : {})
  return [
    { id: "IN-", label: "−", x: 1, y: 2, side: "left", labelAt: "right", kind: "analog", ...on(dip?.inn), note: "Inverting input" },
    { id: "IN+", label: "+", x: 1, y: 4, side: "left", labelAt: "right", kind: "analog", ...on(dip?.inp), note: "Non-inverting input" },
    { id: "OUT", label: "", x: 5, y: 3, side: "right", labelAt: "left", kind: "analog", ...on(dip?.out), note: "Output" },
    { id: "V+", label: "", x: 3, y: 2, side: "top", labelAt: "bottom", kind: "power", stub: 2, ...on(dip?.vcc), note: "Positive supply" },
    { id: "V-", label: "", x: 3, y: 4, side: "bottom", labelAt: "top", kind: "power", stub: 2, ...on(dip?.vee), note: "Negative supply, or ground on a single supply" },
  ]
}

/** The generic op amp's settable figures; a named part is its datasheet and has none. */
const GENERIC_FIELDS: PropField[] = [
  { key: "gain", label: "Open-loop gain", type: "quantity", unit: "dB" },
  { key: "gbw", label: "Gain-bandwidth product", type: "quantity", unit: "Hz" },
  { key: "slew", label: "Slew rate", type: "quantity", unit: "V/µs" },
  { key: "vos", label: "Input offset voltage", type: "quantity", unit: "V" },
  { key: "rail", label: "Output swing short of each rail", type: "quantity", unit: "V" },
  { key: "isc", label: "Output current limit", type: "quantity", unit: "A" },
  { key: "vmax", label: "Absolute maximum supply (V+ − V−)", type: "quantity", unit: "V" },
]

const GENERIC_DEFAULTS = { gain: "120 dB", gbw: "10 MHz", slew: "10 V/µs", vos: "0 V", rail: "0 V", isc: "40 mA", vmax: "36 V" }

/** Thermal time constant of the die in its package: an output short is ridden out for a moment, not held. */
const DIE_TAU = 1

function modelOf(p: OpampPreset): ModelElement[] {
  const generic = p.id === GENERIC_OPAMP
  const amplifier: ModelElement = {
    kind: "OPAMP",
    inp: "IN+",
    inn: "IN-",
    out: "OUT",
    vcc: "V+",
    vee: "V-",
    part: p.id,
    ...(generic && {
      gain: (props: Record<string, string>) => 10 ** (parseValue(props.gain) / 20),
      gbw: "{gbw}",
      slew: (props: Record<string, string>) => parseValue(props.slew) * 1e6,
      vos: "{vos}",
      rail: "{rail}",
      isc: "{isc}",
    }),
    // A die past its supply rating or its package's dissipation is destroyed, and shorts its rails.
    limits: { voltage: generic ? "{vmax}" : p.vsAbs, power: p.pmax, tau: DIE_TAU, fail: "short" },
  }
  return [
    amplifier,
    // The substrate diode: a supply connected the wrong way round conducts through it and burns it.
    { kind: "D", anode: "V-", cathode: "V+", vf: 0.7, hidden: true, label: "Substrate diode", limits: { current: 0.05, fail: "short" } },
    ...(p.rin ? [{ kind: "R" as const, a: "IN+", b: "IN-", value: p.rin, hidden: true, label: "Input resistance" }] : []),
    ...(p.clamp
      ? (["IN+", "IN-"] as const).map((pin): ModelElement => ({ kind: "D", anode: "V-", cathode: pin, vf: 0.7, hidden: true, label: `${pin} protection diode`, limits: { current: p.clamp!, fail: "short" } }))
      : []),
  ]
}

function opampDef(p: OpampPreset): ComponentDef {
  const pins = pinsOf(p)
  const generic = p.id === GENERIC_OPAMP
  const body: BodyShape[] = [
    { type: "path", d: TRIANGLE },
    { type: "text", x: 4.1, y: 1.2, text: "{ref}", size: 0.35, anchor: "start" },
    ...(generic ? [] : ([{ type: "text", x: 4.1, y: 4.9, text: p.part, size: 0.3, anchor: "start", muted: true }] as BodyShape[])),
    ...pinNumbers(pins),
  ]
  return {
    id: `opamp-${p.id}`,
    name: generic ? "Op amp" : p.part,
    description: p.description,
    category: "Op amps",
    keywords: p.keywords,
    icon: OpAmpIcon,
    prefix: "U",
    width: W,
    height: H,
    ...(generic && { defaults: GENERIC_DEFAULTS, fields: GENERIC_FIELDS }),
    pins,
    body,
    parts: [],
    model: modelOf(p),
    info: {
      ...(p.dip && { Package: `${p.dip.package}: this amplifier on pins ${p.dip.inp} (IN+), ${p.dip.inn} (IN−), ${p.dip.out} (OUT), supply ${p.dip.vcc} (V+) and ${p.dip.vee} (V−); ${p.dip.others}` }),
      Source: p.source,
    },
  }
}

export const opamps: ComponentDef[] = OPAMP_PRESETS.map(opampDef)
