import { BatteryIcon } from "../icons"
import { dw03, mt3608, tp4056 } from "../power-model"
import { parseValue } from "@/sim/units"
import { LED_COLORS } from "./basic"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"


const W = 12
const H = 10
const R_FB = 2.2e3
const R_TRIM = 100e3
const VREF = 0.6

const pins: PinDef[] = [
  { id: "VO+", label: "VO+", x: 2, y: 0, side: "top", labelAt: "bottom", kind: "power", note: "Boosted output, set by the trimmer" },
  { id: "VO-", label: "VO−", x: 5, y: 0, side: "top", labelAt: "bottom", kind: "gnd", note: "Output ground; the same net as IN−" },
  { id: "B+", label: "B+", x: 8, y: 0, side: "top", labelAt: "bottom", kind: "power", note: "Cell plus" },
  { id: "B-", label: "B−", x: 11, y: 0, side: "top", labelAt: "bottom", kind: "gnd", note: "Cell minus, behind the DW03's MOSFETs" },
  { id: "IN-", label: "IN−", x: 8, y: H, side: "bottom", labelAt: "top", kind: "gnd", note: "Input ground" },
  { id: "IN+", label: "IN+", x: 10, y: H, side: "bottom", labelAt: "top", kind: "power", note: "4.5–6.5 V in (8 V absolute), the USB-C's VBUS" },
]

const parts: PartDef[] = [
  { type: "usb", id: "USB", label: "USB-C", x: 4.5, y: H - 0.6, side: "bottom" },
  { type: "led", id: "CHRG", label: "CHRG", x: 1.4, y: 8.4, color: LED_COLORS.red.css },
  { type: "led", id: "STDBY", label: "STDBY", x: 2.4, y: 8.4, color: LED_COLORS.blue.css },
]

const body: BodyShape[] = [
  { type: "rect", x: 0, y: 0, w: W, h: H, rx: 0.3, fill: "board" },
  { type: "rect", x: 0.8, y: 1.6, w: 3.2, h: 3.2, rx: 0.3, fill: "chip" },
  { type: "text", x: 2.4, y: 3.35, text: "10 µH", size: 0.4, inverse: true },
  { type: "rect", x: 0.8, y: 5.4, w: 2.2, h: 1, rx: 0.1, fill: "chip" },
  { type: "text", x: 1.9, y: 6, text: "SS34", size: 0.3, inverse: true },
  { type: "rect", x: 4.6, y: 2, w: 1.8, h: 1.2, rx: 0.1, fill: "chip" },
  { type: "text", x: 5.5, y: 2.7, text: "MT3608", size: 0.26, inverse: true },
  { type: "circle", cx: 5.5, cy: 5, r: 0.7, fill: "connector" },
  { type: "text", x: 5.5, y: 6.35, text: "{vout}", size: 0.32, muted: true },
  { type: "rect", x: 7.2, y: 3.6, w: 2.8, h: 2.2, rx: 0.1, fill: "chip" },
  { type: "text", x: 8.6, y: 4.8, text: "TP4056", size: 0.34, inverse: true },
  { type: "rect", x: 9.8, y: 1.6, w: 1.6, h: 1.2, rx: 0.1, fill: "chip" },
  { type: "text", x: 10.6, y: 2.3, text: "DW03", size: 0.28, inverse: true },
  { type: "text", x: 9, y: 7.4, text: "{ref}", size: 0.45 },
]

const trimFor = (p: Record<string, string>) => {
  const v = parseValue(p.vout)
  const top = R_FB * ((Number.isFinite(v) ? v : 5) / VREF - 1)
  return Math.min(R_TRIM, Math.max(1, top))
}

const model: Element[] = [
  { kind: "SHORT", nodes: ["IN-", "VO-"] },
  { kind: "V", plus: "$usb", minus: "IN-", value: 5 },
  { kind: "SW", a: "$usb", b: "IN+", part: "USB", closed: "on", ron: 0.15, ideal: true },
  ...tp4056({ vcc: "IN+", bat: "B+", gnd: "IN-", prog: "$prog", chrg: "$chrg", stdby: "$stdby" }),
  { kind: "R", a: "$prog", b: "IN-", value: 1.2e3 },
  { kind: "R", a: "IN+", b: "$chrgA", value: 1e3 },
  { kind: "D", anode: "$chrgA", cathode: "$chrg", vf: LED_COLORS.red.vf, part: "CHRG" },
  { kind: "R", a: "IN+", b: "$stdbyA", value: 1e3 },
  { kind: "D", anode: "$stdbyA", cathode: "$stdby", vf: LED_COLORS.blue.vf, part: "STDBY" },
  ...dw03({ vdd: "B+", gnd: "B-", vm: "IN-" }),
  ...mt3608({ power: "B+", out: "VO+", gnd: "IN-", fb: "$fb" }),
  { kind: "D", anode: "B+", cathode: "VO+", vf: 0.3, limits: { current: 3, fail: "short", fatal: false } },
  { kind: "R", a: "VO+", b: "$fb", value: trimFor },
  { kind: "R", a: "$fb", b: "IN-", value: R_FB },
]

export const chargeBoostModule: ComponentDef = {
  id: "lx-lcbst",
  name: "LX-LCBST charger + boost",
  keywords: ["Li-ion", "lithium", "TP4056", "DW03", "MT3608", "module", "USB-C"],
  description: "Li-ion charger and boost module",
  category: "power",
  icon: BatteryIcon,
  prefix: "A",
  defaults: { vout: "5 V" },
  fields: [{ key: "vout", label: "Output voltage", type: "quantity", unit: "V", placeholder: "4.2–28 V, trimmer" }],
  width: W,
  height: H,
  body,
  pins,
  parts,
  model,
  hideIdle: true,
  pinsAreSockets: true,
  info: {
    // Charger: "TP4056, 1 A (R_PROG 1.2 kΩ), 4.2 V ±1 %, trickle 100 mA below 2.9 V, ends at 100 mA, recharges at 4.05 V"
    Charger: "TP4056, 1 A (1.2 kΩ)",
    Float: "4.2 V ±1 %",
    Trickle: "100 mA below 2.9 V",
    "Charge end": "100 mA, restarts 4.05 V",
    // Protection: "DW03: overcharge 4.3 V, over-discharge 2.4 V, overcurrent 3.5 A, short circuit 20 A, 40 mΩ"
    Protection: "DW03, cell 2.4–4.3 V",
    Overcurrent: "3.5 A, short 20 A",
    // Boost: "MT3608, 4.2–28 V by the trimmer, ~2 A from the cell (5 W)"
    Boost: "MT3608, 4.2–28 V, ~2 A",
    Input: "USB-C or IN+/IN−, 4.5–6.5 V",
    Size: "23.5 × 19 mm",
    // Source (in the datasheet record): "Datasheets: TP4056 (NanJing Top Power), DW03 (PJSEMI), MT3608 (Aerosemi)"
  },
}

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [chargeBoostModule]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "lx-lcbst": {
    maker: "NanJing Top Power",
    docs: [DOCS["toppower-tp4056"], DOCS["pjsemi-dw03"], DOCS["aerosemi-mt3608"]],
    specs: [
      { label: "Charger supply", value: "4.0–8.0 V", cite: { page: 5, at: "Electrical Characteristics" } },
      { label: "Float voltage", value: "4.2 V ±1 %", cite: { page: 5, at: "Electrical Characteristics, VFLOAT" } },
      { label: "Overcharge / over-discharge", value: "4.3 V / 2.4 V", cite: { doc: "pjsemi-dw03", page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings)" } },
      { label: "Overcurrent / short", value: "3.5 A / 20 A", cite: { doc: "pjsemi-dw03", page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings)" } },
      { label: "Boost output", value: "up to 28 V", cite: { doc: "aerosemi-mt3608", page: 1, at: "Features" } },
      { label: "Boost switch limit", value: "4 A", cite: { doc: "aerosemi-mt3608", page: 3, at: "Electrical Characteristics, SW Current Limit" } },
    ],
    modelled: [
      { what: "1 A charge from USB-C", test: "tests/sim/charge-boost.test.ts" },
      { what: "CHRG lit while charging", test: "tests/sim/charge-boost.test.ts" },
      { what: "C/10 trickle below 2.9 V", cite: { page: 5, at: "Electrical Characteristics, VTRIKL" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Holds 4.2 V until C/10", cite: { page: 9, at: "Charge Termination" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "STDBY lit once charged", cite: { page: 9, at: "Charge Termination" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Trimmer sets 4.2–28 V output", cite: { doc: "aerosemi-mt3608", page: 6, at: "Setting the Output Voltage" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Output sags past 2 A", cite: { doc: "aerosemi-mt3608", page: 3, at: "Electrical Characteristics, SW Current Limit" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Short trips DW03 until charger", cite: { doc: "pjsemi-dw03", page: 6, at: "Overcurrent Condition" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Cell cut-off at 2.4 V", cite: { doc: "pjsemi-dw03", page: 5, at: "Overdischarge Condition" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "TP4056 dies past 8 V", cite: { page: 2, at: "Absolute Maximum Ratings" }, test: "tests/sim/charge-boost.test.ts" },
    ],
    notModelled: [
      { what: "TP4056's 1100 V/R_PROG law", cite: { page: 9, at: "Programming Charge Current" } },
      { what: "TP4056 thermal regulation", cite: { page: 8, at: "Operation" } },
      { what: "MT3608 1.2 MHz ripple", cite: { doc: "aerosemi-mt3608", page: 3, at: "Electrical Characteristics, Switching Frequency" } },
      { what: "Efficiency change (fixed 90 %)", cite: { doc: "aerosemi-mt3608", page: 4, at: "Typical Performance Characteristics" } },
      { what: "The DW03's over-temperature protection", cite: { doc: "pjsemi-dw03", page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings), TSHD" } },
      { what: "USB-C CC lines" },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
