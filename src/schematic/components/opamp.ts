import { GENERIC_OPAMP, OPAMP_PRESETS, type OpampPreset } from "@/sim/opamp"
import { parseValue } from "@/sim/units"
import { OpAmpIcon } from "../icons"
import { pinNumbers } from "../pin-numbers"
import type { BodyShape, ComponentDef, ModelElement, PinDef, PropField, NoDatasheet } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

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
    category: "ics",
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
    ...(generic && {
      datasheet: {
        none: "An idealised op amp, close to the textbook's: every figure is set in the inspector. The named op amps beside it are real parts off their datasheets.",
        modelled: [{ what: "Gain and gain-bandwidth as set", test: "tests/sim/opamp.test.ts" }, { what: "Slew and offset as set", test: "tests/sim/opamp.test.ts" }, { what: "Rail swing and current limit", test: "tests/sim/opamp.test.ts" }],
        notModelled: [{ what: "Input bias current and noise" }, { what: "Common-mode and supply rejection" }],
      } satisfies NoDatasheet,
    }),
    // Was one note: Package `${p.dip.package}: this amplifier on pins ${p.dip.inp} (IN+), ${p.dip.inn} (IN−), ${p.dip.out} (OUT), supply ${p.dip.vcc} (V+) and ${p.dip.vee} (V−); ${p.dip.others}`
    // Source (in the datasheet record): p.source
    info: p.dip
      ? {
          Package: p.dip.package,
          "IN+/IN−/OUT": `pins ${p.dip.inp}/${p.dip.inn}/${p.dip.out}`,
          "V+/V−": `pins ${p.dip.vcc}/${p.dip.vee}`,
          "Other pins": p.dip.others,
        }
      : {},
  }
}

export const opamps: ComponentDef[] = OPAMP_PRESETS.map(opampDef)

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = opamps

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "opamp-lm358": {
    maker: "Texas Instruments",
    package: "PDIP-8",
    docs: [DOCS["ti-slos068ab"]],
    specs: [
      { label: "Supply", value: "3–30 V (32 V abs max)", cite: { page: 5, at: "§5.3 Recommended Operating Conditions; §5.1" } },
      { label: "Common-mode range", value: "V− to V+ − 1.5 V", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
      { label: "Output current", value: "30 mA source, 20 mA sink (VS = 15 V)", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
      { label: "Gain-bandwidth", value: "0.7 MHz", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
      { label: "Slew rate", value: "0.3 V/µs", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
      { label: "Quiescent current", value: "350 µA per amplifier at 5 V", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
    ],
    modelled: [
      { what: "100 V/mV open-loop gain", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "2 mV input offset", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "Output 1.5 V under V+", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "Output 5 mV above V−", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "30/20 mA source/sink short", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "Per-amp supply 350–500 µA", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "20 nA PNP input bias", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "0.3 V/µs slew rate", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "0.7 MHz single-pole gain-bandwidth", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "Reports input outside common-mode range", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" }, test: "tests/sim/opamp.test.ts" },
      { what: "Dies shorted past 32 V", cite: { page: 4, at: "§5.1 Absolute Maximum Ratings" }, test: "tests/sim/opamp.test.ts" },
      { what: "Survives output shorted to ground", cite: { page: 4, at: "§5.1 Absolute Maximum Ratings" }, test: "tests/sim/opamp.test.ts" },
    ],
    notModelled: [
      { what: "Common-mode and supply rejection", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
      { what: "Channel separation", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
      { what: "Noise and input offset current", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
      { what: "Offset and bias temperature drift", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
      { what: "Heating from a shorted output", cite: { page: 4, at: "§5.1 Absolute Maximum Ratings" } },
      { what: "Phase margin and capacitive-load ringing" },
      { what: "Unplaced half's supply current", cite: { page: 10, at: "§5.7 Electrical Characteristics: LM358" } },
    ],
  },
  "opamp-lm741": {
    maker: "Texas Instruments",
    package: "PDIP-8",
    docs: [DOCS["ti-snosc25d"]],
    specs: [
      { label: "Supply", value: "±10 to ±18 V (LM741C)", cite: { page: 4, at: "§6.3 Recommended Operating Conditions" } },
      { label: "Supply (abs max)", value: "±18 V (LM741C)", cite: { page: 4, at: "§6.1 Absolute Maximum Ratings" } },
      { label: "Output swing", value: "±14 V into 10 kΩ, ±13 V into 2 kΩ at ±15 V", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
      { label: "Output short-circuit current", value: "25 mA", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
      { label: "Slew rate", value: "0.5 V/µs", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
      { label: "Supply current", value: "1.7 mA at ±15 V", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
    ],
    modelled: [
      { what: "200 V/mV open-loop gain", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
      { what: "2 mV input offset", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
      { what: "±14 V into 10 kΩ", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
      { what: "±13 V into 2 kΩ", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
      { what: "Survives 25 mA output short", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
      { what: "1.7 mA supply current", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
      { what: "80 nA NPN input bias", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
      { what: "2 MΩ input resistance", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
      { what: "0.5 V/µs slew rate", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" }, test: "tests/sim/opamp.test.ts" },
    ],
    notModelled: [
      { what: "Offset null (pins 1, 5)", cite: { page: 3, at: "Pin Functions" } },
      { what: "Common-mode and supply rejection", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
      { what: "Input offset current (20 nA)", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
      { what: "Transient overshoot and rise time", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
      { what: "1 MHz gain-bandwidth is assumed", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
      { what: "Temperature drift and limits", cite: { page: 6, at: "§6.7 Electrical Characteristics, LM741C" } },
    ],
  },
  "opamp-tl072": {
    maker: "Texas Instruments",
    package: "PDIP-8",
    docs: [DOCS["ti-slos080w"]],
    specs: [
      { label: "Supply", value: "4.5–40 V (10–30 V for NS/PS packages and TL07xM)", cite: { page: 11, at: "§5.3 Recommended Operating Conditions" } },
      { label: "Supply (abs max)", value: "42 V (36 V for NS/PS packages and TL07xM)", cite: { page: 10, at: "§5.1 Absolute Maximum Ratings" } },
      { label: "Output swing", value: "±13.5 V into 10 kΩ at ±15 V", cite: { page: 15, at: "§5.8 Electrical Characteristics (DC), TL07xC" } },
      { label: "Input bias current", value: "65 pA", cite: { page: 15, at: "§5.8 Electrical Characteristics (DC), TL07xC" } },
      { label: "Gain-bandwidth", value: "5.25 MHz (3 MHz for NS/PS packages and TL07xM)", cite: { page: 15, at: "§5.8 Electrical Characteristics (DC), TL07xC" } },
      { label: "Slew rate", value: "20 V/µs", cite: { page: 16, at: "§5.9 Electrical Characteristics (AC), TL07xC" } },
    ],
    modelled: [
      { what: "200 V/mV open-loop gain", cite: { page: 15, at: "§5.8 Electrical Characteristics (DC), TL07xC" }, test: "tests/sim/opamp.test.ts" },
      { what: "3 mV input offset", cite: { page: 15, at: "§5.8 Electrical Characteristics (DC), TL07xC" }, test: "tests/sim/opamp.test.ts" },
      { what: "±13.5 V into 10 kΩ", cite: { page: 15, at: "§5.8 Electrical Characteristics (DC), TL07xC" }, test: "tests/sim/opamp.test.ts" },
      { what: "Survives 26 mA output short", cite: { page: 14, at: "§5.7 Electrical Characteristics for TL07xH" }, test: "tests/sim/opamp.test.ts" },
      { what: "1.4 mA quiescent current", cite: { page: 16, at: "§5.8 Electrical Characteristics (DC), TL07xC (continued)" }, test: "tests/sim/opamp.test.ts" },
      { what: "Picoamp input bias current", cite: { page: 16, at: "§5.8 Electrical Characteristics (DC), TL07xC (continued)" }, test: "tests/sim/opamp.test.ts" },
      { what: "20 V/µs slew rate", cite: { page: 16, at: "§5.9 Electrical Characteristics (AC), TL07xC" }, test: "tests/sim/opamp.test.ts" },
    ],
    notModelled: [
      { what: "Noise (37 nV/√Hz) and THD", cite: { page: 16, at: "§5.9 Electrical Characteristics (AC), TL07xC" } },
      { what: "Common-mode and supply rejection", cite: { page: 15, at: "§5.8 Electrical Characteristics (DC), TL07xC" } },
      { what: "Phase margin and capacitive-load ringing", cite: { page: 16, at: "§5.9 Electrical Characteristics (AC), TL07xC" } },
      { what: "Input clamp diodes to rails", cite: { page: 10, at: "§5.1 note 2" } },
      { what: "Bias current rise with temperature", cite: { page: 15, at: "§5.8 Electrical Characteristics (DC), TL07xC" } },
      { what: "Unplaced half's supply current", cite: { page: 16, at: "§5.8 Electrical Characteristics (DC), TL07xC (continued)" } },
    ],
  },
  "opamp-mcp6002": {
    maker: "Microchip",
    package: "PDIP-8",
    docs: [DOCS["mchp-ds20001733l"]],
    specs: [
      { label: "Supply", value: "1.8–6.0 V (7.0 V abs max)", cite: { page: 3, at: "DC Electrical Specifications; Absolute Maximum Ratings" } },
      { label: "Input range", value: "VSS − 0.3 V to VDD + 0.3 V", cite: { page: 3, at: "DC Electrical Specifications" } },
      { label: "Output swing", value: "within 25 mV of the rails (10 kΩ to VDD/2, 5.5 V)", cite: { page: 3, at: "DC Electrical Specifications" } },
      { label: "Output short-circuit current", value: "±6 mA at 1.8 V, ±23 mA at 5.5 V", cite: { page: 3, at: "DC Electrical Specifications" } },
      { label: "Gain-bandwidth / slew", value: "1.0 MHz, 0.6 V/µs", cite: { page: 4, at: "AC Electrical Specifications" } },
      { label: "Quiescent current", value: "100 µA per amplifier", cite: { page: 3, at: "DC Electrical Specifications" } },
    ],
    modelled: [
      { what: "112 dB open-loop gain", cite: { page: 3, at: "DC Electrical Specifications" }, test: "tests/sim/opamp.test.ts" },
      { what: "Rail-to-rail within 25 mV", cite: { page: 3, at: "DC Electrical Specifications" }, test: "tests/sim/opamp.test.ts" },
      { what: "±6–23 mA short-circuit current", cite: { page: 3, at: "DC Electrical Specifications" }, test: "tests/sim/opamp.test.ts" },
      { what: "100 µA quiescent current", cite: { page: 3, at: "DC Electrical Specifications" }, test: "tests/sim/opamp.test.ts" },
      { what: "0.3 V beyond rails tolerated", cite: { page: 3, at: "Absolute Maximum Ratings" }, test: "tests/sim/opamp.test.ts" },
      { what: "Reports 1 V beyond rails", cite: { page: 3, at: "Absolute Maximum Ratings" }, test: "tests/sim/opamp.test.ts" },
      { what: "2 mA input-diode burnout", cite: { page: 13, at: "§4.1.2 Input Voltage and Current Limits" }, test: "tests/sim/opamp.test.ts" },
      { what: "Warns above 6 V supply", cite: { page: 3, at: "Absolute Maximum Ratings" }, test: "tests/sim/opamp.test.ts" },
      { what: "Destroyed past 7 V", cite: { page: 3, at: "Absolute Maximum Ratings" }, test: "tests/sim/opamp.test.ts" },
    ],
    notModelled: [
      { what: "Input offset (only max given)", cite: { page: 3, at: "DC Electrical Specifications" } },
      { what: "Input diodes toward VDD", cite: { page: 13, at: "§4.1.2 Input Voltage and Current Limits" } },
      { what: "Input-stage crossover near VDD", cite: { page: 13, at: "§4.1.3 Normal Operation" } },
      { what: "±30 mA pin current rating", cite: { page: 3, at: "Absolute Maximum Ratings" } },
      { what: "Noise, CMRR and PSRR", cite: { page: 4, at: "AC Electrical Specifications" } },
      { what: "Phase margin and capacitive-load ringing", cite: { page: 14, at: "§4.3 Capacitive Loads" } },
    ],
  },
  "opamp-lmv358": {
    maker: "Texas Instruments",
    package: "VSSOP-8",
    docs: [DOCS["ti-slos263y"]],
    specs: [
      { label: "Supply", value: "2.7–5.5 V (5.5 V abs max)", cite: { page: 5, at: "§6.3 Recommended Operating Conditions; §6.1" } },
      { label: "Input voltage (abs max)", value: "−0.2 V to 5.7 V", cite: { page: 5, at: "§6.1 Absolute Maximum Ratings" } },
      { label: "Common-mode range", value: "−0.2 V to 4.2 V at 5 V (typ)", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" } },
      { label: "Output swing", value: "VCC − 10 mV / 65 mV into 10 kΩ at 5 V", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" } },
      { label: "Output short-circuit current", value: "40 mA source and sink at 5 V", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" } },
      { label: "Gain-bandwidth / slew", value: "1 MHz, 1 V/µs", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" } },
    ],
    modelled: [
      { what: "100 V/mV open-loop gain", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "1.7 mV input offset", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "10/65 mV headroom, 10 kΩ", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "40/120 mV headroom, 2 kΩ", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "40 mA short-circuit both ways", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "Per-amp supply 70–105 µA", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "15 nA PNP input bias", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "1 V/µs slew rate", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "1 MHz gain-bandwidth", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
      { what: "Common-mode −0.2 to VCC−0.8 V", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" }, test: "tests/sim/opamp.test.ts" },
    ],
    notModelled: [
      { what: "Common-mode and supply rejection", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" } },
      { what: "Noise (39 nV/√Hz)", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" } },
      { what: "Phase and gain margin, ringing", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" } },
      { what: "Clamp current, 1 kΩ assumed" },
      { what: "Heating from short to VCC", cite: { page: 5, at: "§6.1 note 4" } },
      { what: "Temperature drift and limits", cite: { page: 7, at: "§6.8 Electrical Characteristics: VCC+ = 5 V" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
