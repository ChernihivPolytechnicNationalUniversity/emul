import {
  AcSourceIcon,
  BatteryIcon,
  CapacitorIcon,
  DiodeIcon,
  ElectrolyticCapacitorIcon,
  GroundIcon,
  InductorIcon,
  JunctionIcon,
  LedIcon,
  NmosIcon,
  NpnIcon,
  PmosIcon,
  PnpIcon,
  PulseSourceIcon,
  PotentiometerIcon,
  PushbuttonIcon,
  ResistorIcon,
  SupplyIcon,
  LogicStateIcon,
  SwitchIcon,
  TerminalIcon,
  TransformerIcon,
  ZenerDiodeIcon,
} from "../icons"
import { parseValue } from "@/sim/units"
import type { BodyShape, ComponentDef, PinDef, PinKind, PropField } from "../types"

const POWER_RATINGS = ["0.125", "0.25", "0.5", "1", "2", "5"].map((w) => ({ value: w, label: `${w} W` }))
/** A junction that overheats or avalanches melts through: the die fails short, not open. */
const Q_LIMITS = { current: "{icmax}", voltage: "{vcemax}", power: "{pmax}", fail: "short" } as const

/** LED colours: CSS colour and typical forward voltage. */
export const LED_COLORS: Record<string, { css: string; vf: number }> = {
  red: { css: "#ef4444", vf: 1.9 },
  green: { css: "#22c55e", vf: 2.1 },
  blue: { css: "#3b82f6", vf: 3.0 },
  yellow: { css: "#eab308", vf: 2.0 },
  white: { css: "#f5f5f5", vf: 3.0 },
}

/**
 * Discrete components drawn as IEC schematic symbols.
 * Two-terminal parts are 4 × 2 cells with pins on the left and right edge nodes.
 */

const W = 4
const H = 2

type PinSpec = { label?: string; kind?: PinKind }

const twoPin = (a: PinSpec = {}, b: PinSpec = {}): PinDef[] => [
  { id: "1", label: a.label ?? "", x: 0, y: 1, side: "left", labelAt: "top", kind: a.kind ?? "digital" },
  { id: "2", label: b.label ?? "", x: W, y: 1, side: "right", labelAt: "top", kind: b.kind ?? "digital" },
]

const LEADS = "M0 1 H1 M3 1 H4"

const labels = (refX = 2, refAnchor: "start" | "middle" | "end" = "middle"): BodyShape[] => [
  { type: "text", x: refX, y: 0.28, text: "{ref}", size: 0.35, anchor: refAnchor },
  { type: "text", x: 2, y: 1.78, text: "{value}", size: 0.3, muted: true },
]

const VALUE_FIELD = (label: string, unit: string) => ({ key: "value", label, type: "quantity", unit }) as const

const base = (d: Omit<ComponentDef, "width" | "height" | "parts" | "pins"> & Partial<ComponentDef>): ComponentDef => ({
  width: W,
  height: H,
  parts: [],
  pins: twoPin(),
  ...d,
})

export const resistor = base({
  id: "resistor",
  name: "Resistor",
  category: "Passive",
  icon: ResistorIcon,
  prefix: "R",
  defaults: { value: "1 kΩ", power: "0.25" },
  fields: [
    VALUE_FIELD("Resistance", "Ω"),
    { key: "power", label: "Power rating", type: "select", options: POWER_RATINGS },
  ],
  body: [{ type: "path", d: `${LEADS} M1 0.6 H3 V1.4 H1 Z` }, ...labels()],
  model: [{ kind: "R", a: "1", b: "2", value: "{value}", limits: { power: "{power}" } }],
})

export const potentiometer = base({
  id: "potentiometer",
  name: "Potentiometer",
  category: "Passive",
  icon: PotentiometerIcon,
  prefix: "RV",
  defaults: { value: "10 kΩ", pos: "0.5", power: "0.25" },
  fields: [
    VALUE_FIELD("Resistance", "Ω"),
    { key: "pos", label: "Wiper position", type: "range", min: 0, max: 1, step: 0.01 },
    { key: "power", label: "Power rating", type: "select", options: POWER_RATINGS },
  ],
  model: [
    // One side of the track can burn through while the other still conducts.
    { kind: "R", a: "1", b: "W", value: (p) => Math.max(1e-3, parseValue(p.value) * Number(p.pos)), limits: { power: "{power}", fatal: false } },
    { kind: "R", a: "W", b: "2", value: (p) => Math.max(1e-3, parseValue(p.value) * (1 - Number(p.pos))), limits: { power: "{power}", fatal: false } },
  ],
  pins: [
    ...twoPin(),
    { id: "W", label: "", x: 2, y: 0, side: "top", labelAt: "right", kind: "digital" },
  ],
  body: [
    { type: "path", d: `${LEADS} M1 0.6 H3 V1.4 H1 Z M2 0 V0.3` },
    { type: "path", d: "M1.75 0.3 L2 0.6 L2.25 0.3 Z", fill: "foreground" },
    ...labels(1.5, "end"),
  ],
})

export const capacitor = base({
  id: "capacitor",
  name: "Capacitor",
  category: "Passive",
  icon: CapacitorIcon,
  prefix: "C",
  defaults: { value: "100 nF", vmax: "50 V" },
  fields: [VALUE_FIELD("Capacitance", "F"), { key: "vmax", label: "Voltage rating", type: "quantity", unit: "V" }],
  body: [{ type: "path", d: "M0 1 H1.8 M2.2 1 H4 M1.8 0.4 V1.6 M2.2 0.4 V1.6" }, ...labels()],
  model: [{ kind: "C", a: "1", b: "2", value: "{value}", limits: { voltage: "{vmax}", fail: "short" } }],
})

export const capacitorPolarized = base({
  id: "capacitor-polarized",
  name: "Electrolytic capacitor",
  category: "Passive",
  icon: ElectrolyticCapacitorIcon,
  prefix: "C",
  defaults: { value: "10 µF", vmax: "16 V", vrev: "1.5 V" },
  fields: [
    VALUE_FIELD("Capacitance", "F"),
    { key: "vmax", label: "Voltage rating", type: "quantity", unit: "V" },
    { key: "vrev", label: "Max reverse voltage", type: "quantity", unit: "V" },
  ],
  pins: twoPin({ label: "+" }, { label: "−" }),
  body: [
    { type: "path", d: "M0 1 H1.8 M2.4 1 H4 M1.8 0.4 V1.6 M2.4 0.4 Q2.05 1 2.4 1.6 M1.15 0.5 H1.55 M1.35 0.3 V0.7" },
    ...labels(),
  ],
  // Over-voltage or reverse polarity beyond a volt or two punctures the oxide; pin 1 is the anode.
  model: [{ kind: "C", a: "1", b: "2", value: "{value}", limits: { voltage: "{vmax}", reverse: "{vrev}", fail: "short" } }],
})

export const inductor = base({
  id: "inductor",
  name: "Inductor",
  category: "Passive",
  icon: InductorIcon,
  prefix: "L",
  defaults: { value: "10 µH", imax: "1 A" },
  fields: [VALUE_FIELD("Inductance", "H"), { key: "imax", label: "Rated current", type: "quantity", unit: "A" }],
  body: [
    {
      type: "path",
      d: `${LEADS} M1 1 A0.25 0.25 0 0 1 1.5 1 A0.25 0.25 0 0 1 2 1 A0.25 0.25 0 0 1 2.5 1 A0.25 0.25 0 0 1 3 1`,
    },
    ...labels(),
  ],
  model: [{ kind: "L", a: "1", b: "2", value: "{value}", limits: { current: "{imax}" } }],
})

const DIODE_PINS = twoPin({ label: "A" }, { label: "K" })
const DIODE_LEADS = "M0 1 H1.6 M2.4 1 H4"
const DIODE_TRIANGLE: BodyShape = { type: "path", d: "M1.6 0.5 L2.4 1 L1.6 1.5 Z", fill: "foreground" }

export const diode = base({
  id: "diode",
  name: "Diode",
  category: "Semiconductors",
  icon: DiodeIcon,
  prefix: "D",
  defaults: { value: "1N4148", vf: "0.7", imax: "300 mA", vrev: "100 V" },
  fields: [
    { key: "value", label: "Part", type: "text", placeholder: "e.g. 1N4148" },
    { key: "vf", label: "Forward voltage", type: "range", min: 0.2, max: 1.2, step: 0.05, unit: "V" },
    { key: "imax", label: "Max forward current", type: "quantity", unit: "A" },
    { key: "vrev", label: "Max reverse voltage", type: "quantity", unit: "V" },
  ],
  pins: DIODE_PINS,
  body: [{ type: "path", d: `${DIODE_LEADS} M2.4 0.5 V1.5` }, DIODE_TRIANGLE, ...labels()],
  // A junction pushed past its current or reverse voltage punches through and stays a short.
  model: [{ kind: "D", anode: "1", cathode: "2", vf: (p) => Number(p.vf) || 0.7, limits: { current: "{imax}", voltage: "{vrev}", fail: "short" } }],
})

export const zener = base({
  id: "zener",
  name: "Zener diode",
  category: "Semiconductors",
  icon: ZenerDiodeIcon,
  prefix: "D",
  defaults: { value: "5.1 V", power: "0.5" },
  fields: [VALUE_FIELD("Zener voltage", "V"), { key: "power", label: "Power rating", type: "select", options: POWER_RATINGS }],
  pins: DIODE_PINS,
  body: [{ type: "path", d: `${DIODE_LEADS} M2.55 0.4 L2.4 0.5 V1.5 L2.25 1.6` }, DIODE_TRIANGLE, ...labels()],
  model: [{ kind: "D", anode: "1", cathode: "2", vf: 0.7, zener: (p) => parseValue(p.value) || 5.1, limits: { power: "{power}", fail: "short" } }],
})

export const led = base({
  id: "led",
  name: "LED",
  category: "Semiconductors",
  icon: LedIcon,
  prefix: "LED",
  defaults: { value: "red", imax: "30 mA" },
  fields: [
    {
      key: "value",
      label: "Color",
      type: "select",
      options: Object.keys(LED_COLORS).map((c) => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })),
    },
    { key: "imax", label: "Max current", type: "quantity", unit: "A" },
  ],
  pins: DIODE_PINS,
  body: [
    { type: "path", d: `${DIODE_LEADS} M2.4 0.5 V1.5` },
    DIODE_TRIANGLE,
    // light arrows
    { type: "path", d: "M2.3 0.45 L2.7 0.05 M2.5 0.05 H2.7 V0.25 M2.75 0.6 L3.15 0.2 M2.95 0.2 H3.15 V0.4" },
    ...labels(1.5, "end"),
  ],
  parts: [{ type: "led", id: "LED", label: "", x: 2, y: 1, color: "{value}", style: "glow" }],
  model: [{ kind: "D", anode: "1", cathode: "2", vf: (p) => LED_COLORS[p.value]?.vf ?? 2, part: "LED", limits: { current: "{imax}", voltage: 5 } }],
})

const TRANSISTOR_PINS: PinDef[] = [
  { id: "B", label: "B", x: 0, y: 2, side: "left", labelAt: "top", kind: "digital" },
  { id: "C", label: "C", x: 3, y: 0, side: "top", labelAt: "right", kind: "digital" },
  { id: "E", label: "E", x: 3, y: 4, side: "bottom", labelAt: "right", kind: "digital" },
]
// Emitter runs (1.6, 2.4) → (3, 3.2); the arrowheads below are laid along that line, 0.6 long
// and 0.5 wide, tip outward for NPN and on the base for PNP.
const TRANSISTOR_BODY: BodyShape[] = [
  { type: "circle", cx: 2, cy: 2, r: 1.3, fill: "none" },
  { type: "path", d: "M0 2 H1.6 M1.6 1.1 V2.9 M1.6 1.6 L3 0.8 V0 M1.6 2.4 L3 3.2 V4" },
  { type: "text", x: 0.9, y: 0.4, text: "{ref}", size: 0.35, anchor: "start" },
  { type: "text", x: 0.9, y: 3.7, text: "{value}", size: 0.3, anchor: "start", muted: true },
]

export const npn: ComponentDef = {
  id: "npn",
  name: "NPN transistor",
  category: "Semiconductors",
  icon: NpnIcon,
  prefix: "Q",
  defaults: { value: "BC547", beta: "200", rc: "5 Ω", icmax: "100 mA", vcemax: "45 V", pmax: "500 mW" },
  fields: [
    { key: "value", label: "Part", type: "text", placeholder: "e.g. BC547" },
    { key: "beta", label: "Current gain (β)", type: "range", min: 20, max: 600, step: 10 },
    { key: "rc", label: "Collector resistance (sets Vce sat)", type: "quantity", unit: "Ω" },
    { key: "icmax", label: "Max collector current", type: "quantity", unit: "A" },
    { key: "vcemax", label: "Max Vce", type: "quantity", unit: "V" },
    { key: "pmax", label: "Max dissipation", type: "quantity", unit: "W" },
  ],
  width: 4,
  height: 4,
  pins: TRANSISTOR_PINS,
  parts: [],
  body: [...TRANSISTOR_BODY, { type: "path", d: "M3 3.2 L2.355 3.119 L2.603 2.685 Z", fill: "foreground" }],
  model: [{ kind: "Q", polarity: "npn", b: "B", c: "C", e: "E", beta: (p) => Number(p.beta) || 200, rc: "{rc}", limits: Q_LIMITS }],
}

export const pnp: ComponentDef = {
  id: "pnp",
  name: "PNP transistor",
  category: "Semiconductors",
  icon: PnpIcon,
  prefix: "Q",
  defaults: { value: "BC557", beta: "200", rc: "5 Ω", icmax: "100 mA", vcemax: "45 V", pmax: "500 mW" },
  fields: [
    { key: "value", label: "Part", type: "text", placeholder: "e.g. BC557" },
    { key: "beta", label: "Current gain (β)", type: "range", min: 20, max: 600, step: 10 },
    { key: "rc", label: "Collector resistance (sets Vce sat)", type: "quantity", unit: "Ω" },
    { key: "icmax", label: "Max collector current", type: "quantity", unit: "A" },
    { key: "vcemax", label: "Max Vce", type: "quantity", unit: "V" },
    { key: "pmax", label: "Max dissipation", type: "quantity", unit: "W" },
  ],
  width: 4,
  height: 4,
  pins: TRANSISTOR_PINS,
  parts: [],
  body: [...TRANSISTOR_BODY, { type: "path", d: "M1.6 2.4 L1.997 2.915 L2.245 2.481 Z", fill: "foreground" }],
  model: [{ kind: "Q", polarity: "pnp", b: "B", c: "C", e: "E", beta: (p) => Number(p.beta) || 200, rc: "{rc}", limits: Q_LIMITS }],
}

const MOSFET_PINS: PinDef[] = [
  { id: "G", label: "G", x: 0, y: 2, side: "left", labelAt: "top", kind: "digital" },
  { id: "D", label: "D", x: 3, y: 0, side: "top", labelAt: "right", kind: "digital" },
  { id: "S", label: "S", x: 3, y: 4, side: "bottom", labelAt: "right", kind: "digital" },
]
/** A P-channel part is drawn source up, the way it sits in a high-side switch. */
const PMOS_PINS: PinDef[] = [
  { id: "G", label: "G", x: 0, y: 2, side: "left", labelAt: "top", kind: "digital" },
  { id: "S", label: "S", x: 3, y: 0, side: "top", labelAt: "right", kind: "digital" },
  { id: "D", label: "D", x: 3, y: 4, side: "bottom", labelAt: "right", kind: "digital" },
]
// Gate plate at x 1.4, channel in three dashes at x 1.8, drain and source leads bent in to
// the channel ends, the bulk tied to the source through the middle dash.
const MOSFET_BODY: BodyShape[] = [
  { type: "circle", cx: 2, cy: 2, r: 1.3, fill: "none" },
  { type: "path", d: "M0 2 H1.4 M1.4 1.1 V2.9 M1.8 0.85 V1.45 M1.8 1.7 V2.3 M1.8 2.55 V3.15 M3 0 V1.15 H1.8 M3 4 V2.85 H1.8 M2.6 2 V2.85" },
  { type: "text", x: 0.9, y: 0.4, text: "{ref}", size: 0.35, anchor: "start" },
  { type: "text", x: 0.9, y: 3.7, text: "{value}", size: 0.3, anchor: "start", muted: true },
]
/** A MOSFET that avalanches or overheats fails drain-to-source short. */
const M_LIMITS = { current: "{idmax}", voltage: "{vdsmax}", power: "{pmax}", fail: "short" } as const
const MOSFET_FIELDS: PropField[] = [
  { key: "value", label: "Part", type: "text", placeholder: "e.g. IRLZ44N" },
  { key: "vth", label: "Gate threshold |Vgs(th)|", type: "quantity", unit: "V" },
  { key: "rdson", label: "Rds(on) at Vgs = 10 V", type: "quantity", unit: "Ω" },
  { key: "idmax", label: "Max drain current", type: "quantity", unit: "A" },
  { key: "vdsmax", label: "Max Vds", type: "quantity", unit: "V" },
  { key: "pmax", label: "Max dissipation", type: "quantity", unit: "W" },
]
/** Transconductance parameter from the datasheet's Rds(on): in deep triode R = 1 / (2k(Vgs − Vth)). */
const mosK = (p: Record<string, string>) => {
  const vth = Math.abs(parseValue(p.vth)) || 2
  const r = parseValue(p.rdson) || 0.1
  return 1 / (2 * r * Math.max(1, 10 - vth))
}

export const nmos: ComponentDef = {
  id: "nmos",
  name: "N-channel MOSFET",
  description: "Enhancement mode, with its body diode. Set by threshold and Rds(on) off the datasheet.",
  category: "Semiconductors",
  icon: NmosIcon,
  prefix: "Q",
  defaults: { value: "IRLZ44N", vth: "2 V", rdson: "22 mΩ", idmax: "47 A", vdsmax: "55 V", pmax: "110 W" },
  fields: MOSFET_FIELDS,
  width: 4,
  height: 4,
  pins: MOSFET_PINS,
  parts: [],
  body: [...MOSFET_BODY, { type: "path", d: "M1.85 2 L2.4 1.75 V2.25 Z", fill: "foreground" }],
  model: [
    { kind: "M", polarity: "nmos", g: "G", d: "D", s: "S", vth: "{vth}", k: mosK, limits: M_LIMITS },
    { kind: "D", anode: "S", cathode: "D", vf: 0.8, limits: { current: "{idmax}", fail: "short" } },
  ],
}

export const pmos: ComponentDef = {
  id: "pmos",
  name: "P-channel MOSFET",
  description: "Enhancement mode, with its body diode. Set by threshold and Rds(on) off the datasheet.",
  category: "Semiconductors",
  icon: PmosIcon,
  prefix: "Q",
  defaults: { value: "IRF9540N", vth: "3.7 V", rdson: "117 mΩ", idmax: "23 A", vdsmax: "100 V", pmax: "140 W" },
  fields: MOSFET_FIELDS,
  width: 4,
  height: 4,
  pins: PMOS_PINS,
  parts: [],
  body: [
    ...MOSFET_BODY.filter((b) => b.type !== "path"),
    { type: "path", d: "M0 2 H1.4 M1.4 1.1 V2.9 M1.8 0.85 V1.45 M1.8 1.7 V2.3 M1.8 2.55 V3.15 M3 0 V1.15 H1.8 M3 4 V2.85 H1.8 M2.6 2 V1.15" },
    { type: "path", d: "M2.6 2 L2.05 1.75 V2.25 Z", fill: "foreground" },
  ],
  model: [
    { kind: "M", polarity: "pmos", g: "G", d: "D", s: "S", vth: "{vth}", k: mosK, limits: M_LIMITS },
    { kind: "D", anode: "D", cathode: "S", vf: 0.8, limits: { current: "{idmax}", fail: "short" } },
  ],
}

export const pushbutton = base({
  id: "pushbutton",
  name: "Pushbutton",
  category: "Switches",
  icon: PushbuttonIcon,
  prefix: "SW",
  defaults: { value: "tactile", imax: "50 mA", rcontact: "100 mΩ" },
  fields: [
    { key: "value", label: "Type", type: "text", placeholder: "e.g. tactile" },
    { key: "imax", label: "Contact rating", type: "quantity", unit: "A" },
    { key: "rcontact", label: "Contact resistance", type: "quantity", unit: "Ω" },
  ],
  body: [
    { type: "path", d: LEADS },
    { type: "circle", cx: 1, cy: 1, r: 0.1, fill: "foreground" },
    { type: "circle", cx: 3, cy: 1, r: 0.1, fill: "foreground" },
    { type: "path", d: "M0.9 0.55 H3.1" },
    { type: "text", x: 3.6, y: 0.28, text: "{ref}", size: 0.35 },
    { type: "text", x: 2, y: 1.78, text: "{value}", size: 0.3, muted: true },
  ],
  parts: [{ type: "button", id: "SW", label: "", x: 2, y: 0.25, size: 0.6 }],
  // Contacts pushed past their rating weld: the button stays closed.
  model: [{ kind: "SW", a: "1", b: "2", part: "SW", closed: "pressed", ron: "{rcontact}", limits: { current: "{imax}", fail: "short" } }],
})

export const toggleSwitch = base({
  id: "switch",
  name: "Switch",
  category: "Switches",
  icon: SwitchIcon,
  prefix: "SW",
  defaults: { value: "SPST", imax: "3 A", rcontact: "50 mΩ" },
  fields: [
    { key: "value", label: "Type", type: "text", placeholder: "e.g. SPST" },
    { key: "imax", label: "Contact rating", type: "quantity", unit: "A" },
    { key: "rcontact", label: "Contact resistance", type: "quantity", unit: "Ω" },
  ],
  body: [{ type: "path", d: LEADS }, ...labels(3.6)],
  parts: [{ type: "switch", id: "SW", label: "", x: 1, y: 1, span: 2 }],
  // Contacts pushed past their rating weld: the switch stays closed.
  model: [{ kind: "SW", a: "1", b: "2", part: "SW", closed: "on", ron: "{rcontact}", limits: { current: "{imax}", fail: "short" } }],
})

export const battery: ComponentDef = {
  id: "battery",
  name: "Battery",
  category: "Power",
  icon: BatteryIcon,
  prefix: "BT",
  defaults: { value: "3 V", rint: "0.5 Ω", imax: "3 A" },
  fields: [
    VALUE_FIELD("Voltage", "V"),
    { key: "rint", label: "Internal resistance", type: "quantity", unit: "Ω" },
    { key: "imax", label: "Max current", type: "quantity", unit: "A" },
  ],
  width: 2,
  height: 4,
  parts: [],
  pins: [
    { id: "+", label: "+", x: 1, y: 0, side: "top", labelAt: "right", kind: "power" },
    { id: "-", label: "−", x: 1, y: 4, side: "bottom", labelAt: "right", kind: "gnd" },
  ],
  body: [
    { type: "path", d: "M1 0 V1.4 M1 2.6 V4 M0.3 1.4 H1.7 M0.6 1.8 H1.4 M0.3 2.2 H1.7 M0.6 2.6 H1.4" },
    { type: "text", x: 1.9, y: 1.5, text: "{ref}", size: 0.35, anchor: "start" },
    { type: "text", x: 1.9, y: 2.5, text: "{value}", size: 0.3, anchor: "start", muted: true },
  ],
  // Internal resistance keeps a short from being infinite; the cell overheats past imax.
  model: [
    { kind: "V", plus: "$cell", minus: "-", value: "{value}", limits: { current: "{imax}" } },
    { kind: "R", a: "$cell", b: "+", value: "{rint}" },
  ],
}

export const acSource: ComponentDef = {
  id: "ac-source",
  name: "AC source",
  description: "Sine voltage source: RMS voltage, frequency and DC offset. Defaults to European mains.",
  category: "Power",
  icon: AcSourceIcon,
  prefix: "G",
  defaults: { value: "230 V", freq: "50 Hz", phase: "0", offset: "0 V", rint: "0.5 Ω", imax: "16 A" },
  fields: [
    VALUE_FIELD("Voltage (RMS)", "V"),
    { key: "freq", label: "Frequency", type: "quantity", unit: "Hz" },
    { key: "phase", label: "Phase", type: "range", min: 0, max: 360, step: 5, unit: "°" },
    { key: "offset", label: "DC offset", type: "quantity", unit: "V" },
    { key: "rint", label: "Internal resistance", type: "quantity", unit: "Ω" },
    { key: "imax", label: "Max current", type: "quantity", unit: "A" },
  ],
  width: 2,
  height: 4,
  parts: [],
  pins: [
    { id: "+", label: "~", x: 1, y: 0, side: "top", labelAt: "right", kind: "power" },
    { id: "-", label: "~", x: 1, y: 4, side: "bottom", labelAt: "right", kind: "gnd" },
  ],
  body: [
    { type: "path", d: "M1 0 V1.2 M1 2.8 V4" },
    { type: "circle", cx: 1, cy: 2, r: 0.8 },
    { type: "path", d: "M0.5 2 C0.62 1.5 0.88 1.5 1 2 C1.12 2.5 1.38 2.5 1.5 2" },
    { type: "text", x: 1.9, y: 1.5, text: "{ref}", size: 0.35, anchor: "start" },
    { type: "text", x: 1.9, y: 2.5, text: "{value}", size: 0.3, anchor: "start", muted: true },
  ],
  // Same internal resistance trick as the battery, so a short draws a finite current.
  model: [
    // The value is RMS, as on a nameplate; the sine peak is √2 higher.
    {
      kind: "V",
      plus: "$cell",
      minus: "-",
      value: "{offset}",
      amplitude: (p) => parseValue(p.value) * Math.SQRT2,
      frequency: "{freq}",
      phase: (p) => ((Number(p.phase) || 0) * Math.PI) / 180,
      limits: { current: "{imax}" },
    },
    { kind: "R", a: "$cell", b: "+", value: "{rint}" },
  ],
}

export const pulseSource: ComponentDef = {
  id: "pulse-source",
  name: "Pulse source",
  description: "Square wave between two levels at a set frequency and duty cycle: a clock, a PWM output, a logic signal.",
  category: "Power",
  icon: PulseSourceIcon,
  prefix: "G",
  defaults: { high: "5 V", low: "0 V", freq: "1 kHz", duty: "50", rint: "1 Ω", imax: "1 A" },
  fields: [
    { key: "high", label: "High level", type: "quantity", unit: "V" },
    { key: "low", label: "Low level", type: "quantity", unit: "V" },
    { key: "freq", label: "Frequency", type: "quantity", unit: "Hz" },
    { key: "duty", label: "Duty cycle", type: "range", min: 1, max: 99, step: 1, unit: "%" },
    { key: "rint", label: "Internal resistance", type: "quantity", unit: "Ω" },
    { key: "imax", label: "Max current", type: "quantity", unit: "A" },
  ],
  width: 2,
  height: 4,
  parts: [],
  pins: [
    { id: "+", label: "+", x: 1, y: 0, side: "top", labelAt: "right", kind: "power" },
    { id: "-", label: "−", x: 1, y: 4, side: "bottom", labelAt: "right", kind: "gnd" },
  ],
  body: [
    { type: "path", d: "M1 0 V1.2 M1 2.8 V4" },
    { type: "circle", cx: 1, cy: 2, r: 0.8 },
    { type: "path", d: "M0.5 2.3 H0.75 V1.7 H1.25 V2.3 H1.5" },
    { type: "text", x: 1.9, y: 1.5, text: "{ref}", size: 0.35, anchor: "start" },
    { type: "text", x: 1.9, y: 2.5, text: "{high} · {freq}", size: 0.3, anchor: "start", muted: true },
  ],
  model: [
    {
      kind: "V",
      plus: "$cell",
      minus: "-",
      shape: "pulse",
      value: "{low}",
      amplitude: (p) => parseValue(p.high) - parseValue(p.low),
      frequency: "{freq}",
      duty: (p) => Number(p.duty) / 100,
      limits: { current: "{imax}" },
    },
    { kind: "R", a: "$cell", b: "+", value: "{rint}" },
  ],
}

export const transformer: ComponentDef = {
  id: "transformer",
  name: "Transformer",
  description: "Transformer set by primary and secondary voltage, with the winding resistances and the magnetising inductance of the core. DC on the primary sees only the winding and burns it.",
  category: "Power",
  icon: TransformerIcon,
  prefix: "T",
  defaults: { value: "230 V", sec: "12 V", rs: "1 Ω", rp: "200 Ω", lm: "50 H", va: "10 VA" },
  fields: [
    VALUE_FIELD("Primary voltage", "V"),
    { key: "sec", label: "Secondary voltage", type: "quantity", unit: "V" },
    { key: "rs", label: "Secondary winding resistance", type: "quantity", unit: "Ω" },
    { key: "rp", label: "Primary winding resistance", type: "quantity", unit: "Ω" },
    { key: "lm", label: "Magnetising inductance", type: "quantity", unit: "H" },
    { key: "va", label: "Rated power", type: "quantity", unit: "VA" },
  ],
  width: 4,
  height: 4,
  parts: [],
  pins: [
    { id: "P1", label: "", x: 0, y: 1, side: "left", labelAt: "top", kind: "analog" },
    { id: "P2", label: "", x: 0, y: 3, side: "left", labelAt: "bottom", kind: "analog" },
    { id: "S1", label: "", x: 4, y: 1, side: "right", labelAt: "top", kind: "analog" },
    { id: "S2", label: "", x: 4, y: 3, side: "right", labelAt: "bottom", kind: "analog" },
  ],
  body: [
    { type: "path", d: "M0 1 H1.5 V1.1 A0.3 0.3 0 0 0 1.5 1.7 A0.3 0.3 0 0 0 1.5 2.3 A0.3 0.3 0 0 0 1.5 2.9 V3 H0" },
    { type: "path", d: "M4 1 H2.5 V1.1 A0.3 0.3 0 0 1 2.5 1.7 A0.3 0.3 0 0 1 2.5 2.3 A0.3 0.3 0 0 1 2.5 2.9 V3 H4" },
    { type: "path", d: "M1.9 0.9 V3.1 M2.1 0.9 V3.1" },
    { type: "text", x: 2, y: 0.5, text: "{ref}", size: 0.35 },
    { type: "text", x: 2, y: 3.75, text: "{value} : {sec}", size: 0.3, muted: true },
  ],
  // The secondary winding resistance is what limits the inrush into a filter capacitor. The
  // magnetising inductance across the ideal primary draws the no-load current on AC and is a
  // short on DC, so a transformer on a battery burns its primary winding — rated at 1.3× the
  // nameplate current, like the copper it is.
  model: [
    { kind: "XFMR", p1: "$p", p2: "P2", s1: "$s", s2: "S2", ratio: (p) => parseValue(p.sec) / parseValue(p.value), limits: { power: "{va}" } },
    { kind: "R", a: "$s", b: "S1", value: "{rs}" },
    { kind: "R", a: "P1", b: "$p", value: "{rp}", hidden: true, limits: { current: (p) => (1.3 * parseValue(p.va)) / parseValue(p.value) } },
    { kind: "L", a: "$p", b: "P2", value: "{lm}", hidden: true },
  ],
}

/**
 * A bare wire node. Wires run pin to pin, so a place where three wires meet — or where one
 * taps another — needs something to meet at; without it, crossing wires simply pass over each
 * other. It has no model: it conducts because every wire on it shares its pin.
 */
export const junction: ComponentDef = {
  id: "junction",
  name: "Junction",
  description: "Connects the wires drawn to it. Wires that merely cross do not touch.",
  category: "Wiring",
  icon: JunctionIcon,
  width: 2,
  height: 2,
  parts: [],
  pins: [{ id: "J", label: "", x: 1, y: 1, side: "right", labelAt: "top", kind: "node", stub: 0 }],
  // The pin is the dot; the ring around it is what the node is dragged by, so dropping one and
  // picking it up again moves it rather than starting a wire.
  body: [{ type: "circle", cx: 1, cy: 1, r: 0.6, fill: "grip" }],
}

export const ground: ComponentDef = {
  id: "ground",
  name: "Ground",
  category: "Power",
  icon: GroundIcon,
  width: 2,
  height: 2,
  parts: [],
  pins: [{ id: "GND", label: "", x: 1, y: 0, side: "top", labelAt: "right", kind: "gnd" }],
  body: [{ type: "path", d: "M1 0 V0.9 M0.3 0.9 H1.7 M0.55 1.3 H1.45 M0.8 1.7 H1.2" }],
  model: [{ kind: "GND", node: "GND" }],
}

export const supply: ComponentDef = {
  id: "supply",
  name: "Power rail",
  category: "Power",
  icon: SupplyIcon,
  defaults: { value: "+3V3", voltage: "3.3 V", imax: "1 A" },
  fields: [
    { key: "value", label: "Label", type: "text", placeholder: "e.g. VCC" },
    { key: "voltage", label: "Voltage", type: "quantity", unit: "V" },
    { key: "imax", label: "Max current", type: "quantity", unit: "A" },
  ],
  width: 2,
  height: 2,
  parts: [],
  pins: [{ id: "V", label: "", x: 1, y: 2, side: "bottom", labelAt: "right", kind: "power" }],
  body: [
    { type: "path", d: "M1 2 V1.1 M0.4 1.1 H1.6" },
    { type: "text", x: 1, y: 0.6, text: "{value}", size: 0.35 },
  ],
  // The supply behind the rail trips past its rating and the rail goes dead.
  model: [
    { kind: "V", plus: "V", minus: "$gnd", value: "{voltage}", limits: { current: "{imax}" } },
    { kind: "GND", node: "$gnd" },
  ],
}

/**
 * Logic state: a box that drives its output to VDD or ground, flipped by a click. The
 * instrument for poking a level into a node by hand — a gate input, a MCU pin, a reset line.
 */
export const logicState: ComponentDef = {
  id: "logic-state",
  name: "Logic state",
  description: "Toggle 0/1 level source",
  category: "Instruments",
  icon: LogicStateIcon,
  prefix: "LS",
  defaults: { vdd: "3.3 V", imax: "100 mA" },
  fields: [
    { key: "vdd", label: "High level", type: "quantity", unit: "V" },
    { key: "imax", label: "Max output current", type: "quantity", unit: "A" },
  ],
  width: 3,
  height: 2,
  pins: [{ id: "OUT", label: "", x: 3, y: 1, side: "right", labelAt: "top", kind: "digital" }],
  body: [
    { type: "path", d: "M2 1 H3" },
    { type: "text", x: 1, y: -0.3, text: "{ref}", size: 0.3, muted: true },
  ],
  parts: [{ type: "logic", id: "S", label: "", x: 1, y: 1 }],
  // A logic driver: ~25 Ω out, and its output stage burns past the current rating.
  model: [
    { kind: "V", plus: "$hi", minus: "$gnd", value: "{vdd}", limits: { current: "{imax}" } },
    { kind: "GND", node: "$gnd" },
    { kind: "SW", a: "$hi", b: "OUT", part: "S", closed: "on", ron: 25, ideal: true },
    { kind: "SW", a: "$gnd", b: "OUT", part: "S", closed: "off", ron: 25, ideal: true },
  ],
}

/**
 * Serial terminal: a UART endpoint. RX listens to whatever drives its net (an MCU TX pad),
 * TX drives its net with the bytes typed in; both at the configured baud, 8N1. Bits reach a
 * connected MCU pad with exact timing through the digital fast path; the analog engine sees
 * the same levels at its own time step.
 */
export const serialTerminal: ComponentDef = {
  id: "serial-terminal",
  name: "Serial terminal",
  description: "UART console, 8N1",
  category: "Instruments",
  icon: TerminalIcon,
  prefix: "TERM",
  defaults: { baud: "115200", charset: "utf-8" },
  fields: [
    {
      key: "baud",
      label: "Baud",
      type: "select",
      options: ["1200", "2400", "4800", "9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600"].map((b) => ({ value: b, label: b })),
    },
    // Bytes above 0x7F mean nothing without a charset; GCC's string literals are UTF-8.
    { key: "charset", label: "Encoding", type: "select", options: [{ value: "utf-8", label: "UTF-8" }, { value: "windows-1251", label: "Windows-1251" }] },
  ],
  width: 5,
  height: 4,
  pins: [
    { id: "RX", label: "RX", x: 0, y: 1, side: "left", labelAt: "right", kind: "digital", note: "Connect to the device's TX" },
    { id: "TX", label: "TX", x: 0, y: 3, side: "left", labelAt: "right", kind: "digital", note: "Connect to the device's RX" },
  ],
  body: [
    { type: "rect", x: 0.6, y: 0, w: 4.4, h: 4, rx: 0.3, fill: "zone" },
    { type: "path", d: "M2.2 1.6 L2.9 2.2 L2.2 2.8 M3.2 2.8 H4.2" },
    { type: "text", x: 2.8, y: -0.3, text: "{ref}", size: 0.3, muted: true },
    { type: "text", x: 2.8, y: 3.7, text: "{baud}", size: 0.26, muted: true },
  ],
  parts: [],
  // TX is a push-pull driver at 3.3 V logic that the simulation loop levels bit by bit.
  // TX is a 3.3 V driver; RX an input with the bridge's weak pull-up, so an undriven line idles
  // high instead of reading a start bit. Either pin past the transceiver's absolute maximum
  // (5.5 V) burns the port.
  model: [
    { kind: "GPIO", node: "TX", vdd: 3.3, limits: { voltage: 5.5, fail: "open" } },
    { kind: "GPIO", node: "RX", vdd: 3.3, limits: { voltage: 5.5, fail: "open" } },
  ],
}

export const basicComponents: ComponentDef[] = [
  resistor,
  potentiometer,
  capacitor,
  capacitorPolarized,
  inductor,
  diode,
  zener,
  led,
  npn,
  pnp,
  nmos,
  pmos,
  pushbutton,
  toggleSwitch,
  battery,
  acSource,
  pulseSource,
  transformer,
  ground,
  junction,
  supply,
  logicState,
  serialTerminal,
]
