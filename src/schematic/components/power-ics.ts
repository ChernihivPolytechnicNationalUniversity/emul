import { ChipIcon } from "../icons"
import { dw03, mt3608, tp4056 } from "../power-model"
import type { BodyShape, ComponentDef, ModelElement, Value } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

const chipBody = (w: number, h: number, part: string, what: string, y: number): BodyShape[] => [
  { type: "rect", x: 1, y: 0.5, w: w - 2, h: h - 1, rx: 0.2, fill: "board" },
  { type: "text", x: w / 2, y: y + 0.15, text: part, size: 0.4 },
  { type: "text", x: w / 2, y: y + 0.75, text: what, size: 0.24, muted: true },
  { type: "text", x: w - 1.6, y: 0.15, text: "{ref}", size: 0.3, muted: true },
]

export const tp4056Chip: ComponentDef = {
  id: "tp4056",
  name: "TP4056",
  description: "Linear Li-ion charger IC",
  keywords: ["charger", "battery charger", "Li-ion", "lithium", "SOP-8"],
  category: "power",
  icon: ChipIcon,
  prefix: "U",
  width: 9,
  height: 8,
  pins: [
    { id: "VCC", label: "VCC", x: 1, y: 1, side: "left", labelAt: "right", kind: "power", note: "4–8 V supply (pin 4)" },
    { id: "CE", label: "CE", x: 1, y: 4, side: "left", labelAt: "right", kind: "digital", note: "Chip enable, high to charge; tie to VCC (pin 8)" },
    { id: "TEMP", label: "TEMP", x: 1, y: 5, side: "left", labelAt: "right", kind: "analog", note: "NTC divider: charges between 45 % and 80 % of VCC; to GND disables the check (pin 1)" },
    { id: "PROG", label: "PROG", x: 1, y: 6, side: "left", labelAt: "right", kind: "analog", note: "R_PROG to GND: I = 1200 V / R_PROG (pin 2)" },
    { id: "BAT", label: "BAT", x: 8, y: 1, side: "right", labelAt: "left", kind: "power", note: "Cell plus (pin 5)" },
    { id: "CHRG", label: "CHRG", x: 8, y: 4, side: "right", labelAt: "left", kind: "digital", note: "Open drain, low while charging (pin 7)" },
    { id: "STDBY", label: "STDBY", x: 8, y: 5, side: "right", labelAt: "left", kind: "digital", note: "Open drain, low once charged (pin 6)" },
    { id: "GND", label: "GND", x: 4.5, y: 8, side: "bottom", labelAt: "right", kind: "gnd", note: "Pin 3 and the exposed pad" },
  ],
  body: chipBody(9, 8, "TP4056", "Li-ion charger", 2),
  parts: [],
  model: tp4056({ vcc: "VCC", bat: "BAT", gnd: "GND", prog: "PROG", chrg: "CHRG", stdby: "STDBY", ce: "CE", temp: "TEMP" }),
  // Source (in the datasheet record): "TP4056 datasheet (NanJing Top Power)"
  info: { Package: "SOP-8 with exposed pad" },
}

export const dw03Chip: ComponentDef = {
  id: "dw03",
  name: "DW03",
  description: "Li-ion cell protection IC",
  keywords: ["battery protection", "protection", "Li-ion", "lithium", "overcharge", "over-discharge", "SOT-23-5"],
  category: "power",
  icon: ChipIcon,
  prefix: "U",
  width: 8,
  height: 5,
  pins: [
    { id: "VDD", label: "VDD", x: 4, y: 0, side: "top", labelAt: "right", kind: "power", note: "Cell plus, through 1 kΩ with 0.1 µF to GND on a board (pin 3); 6 V absolute" },
    { id: "GND", label: "GND", x: 1, y: 3.5, side: "left", labelAt: "right", kind: "gnd", note: "Cell minus (pin 2)" },
    { id: "VM", label: "VM", x: 7, y: 3.5, side: "right", labelAt: "left", kind: "gnd", note: "Pack minus, P− (pins 4 and 5)" },
  ],
  body: chipBody(8, 5, "DW03", "Li-ion protection", 1.8),
  parts: [],
  model: dw03({ vdd: "VDD", gnd: "GND", vm: "VM" }, true),
  // Source (in the datasheet record): "DW03 datasheet (PJSEMI)"
  info: { Package: "SOT-23-5 (pin 1 NC)", "On resistance": "40 mΩ GND to VM" },
}

export const mt3608Chip: ComponentDef = {
  id: "mt3608",
  name: "MT3608",
  keywords: ["boost", "step-up", "DC-DC", "converter", "SOT-23-6"],
  description: "Step-up DC-DC boost converter",
  category: "power",
  icon: ChipIcon,
  prefix: "U",
  width: 9,
  height: 6,
  pins: [
    { id: "IN", label: "IN", x: 1, y: 1, side: "left", labelAt: "right", kind: "power", note: "2–24 V supply (pin 5)" },
    { id: "EN", label: "EN", x: 1, y: 4, side: "left", labelAt: "right", kind: "digital", note: "High to run; tie to IN (pin 4)" },
    { id: "SW", label: "SW", x: 8, y: 1, side: "right", labelAt: "left", kind: "power", note: "Switch: inductor from the supply, Schottky to the output (pin 1)" },
    { id: "FB", label: "FB", x: 8, y: 4, side: "right", labelAt: "left", kind: "analog", note: "Feedback, 0.6 V: Vout = 0.6 × (1 + R1/R2) (pin 3)" },
    { id: "GND", label: "GND", x: 4.5, y: 6, side: "bottom", labelAt: "right", kind: "gnd", note: "Pin 2" },
  ],
  body: chipBody(9, 6, "MT3608", "boost converter", 2.2),
  parts: [],
  model: mt3608({ power: "SW", gnd: "GND", fb: "FB", vin: "IN", en: "EN" }),
  // "Switch limit": "4 A peak, ~2 A average from the input"; Source (in the datasheet record): "MT3608 datasheet (Aerosemi)"
  info: { Package: "SOT-23-6 (pin 6 NC)", "Switch limit": "4 A peak", "Average input": "~2 A", Output: "up to 28 V" },
}

/**
 * NCP1117 (onsemi NCP1117/D), the fixed-output parts. The dropout is fitted to the table's
 * 0.95 V at 100 mA and 1.07 V at 800 mA as 0.933 V plus 0.171 Ω times the load.
 */
/**
 * Thermal shutdown: RθJA 160 °C/W (SOT-223, minimum pad), "approximately 175 °C" (Note 2).
 * Assumed until checked: 15 °C of hysteresis and a 2 s junction-to-ambient time constant (the sheet gives neither).
 */
const NCP1117_THERMAL = { rja: 160, tsd: 175, tsdOff: 160, tau: 2 }
const NCP1117 = { volts: ["1.5", "1.8", "2.0", "2.5", "3.3", "5.0", "12"], dropout: 0.933, rDrop: 0.171, limit: 1.5, iq: 6e-3, iqAt: 15, vinMax: 20 }

/** The NCP1117's regulator element between `nodes`, at `vout` volts (a number or "{vout}"). */
export const ncp1117Element = (nodes: { in: string; out: string; gnd: string }, vout: number | string, label?: string): ModelElement => ({
  kind: "REG",
  ...nodes,
  value: vout,
  dropout: NCP1117.dropout,
  rdrop: NCP1117.rDrop,
  imax: NCP1117.limit,
  gq: NCP1117.iq / NCP1117.iqAt,
  thermal: NCP1117_THERMAL,
  limits: { voltage: NCP1117.vinMax, fail: "open" },
  label,
})

export const ncp1117Chip: ComponentDef = {
  id: "ncp1117",
  name: "NCP1117",
  keywords: ["LDO", "regulator", "voltage regulator", "linear regulator", "1117", "low-dropout", "onsemi", "SOT-223"],
  description: "1 A low-dropout regulator",
  category: "power",
  icon: ChipIcon,
  prefix: "U",
  defaults: { vout: "5.0" },
  fields: [{ key: "vout", label: "Output", type: "select", options: NCP1117.volts.map((v) => ({ value: v, label: `${v} V (NCP1117ST${v.replace(".", "").padEnd(2, "0").slice(0, 2)}T3G)` })) }],
  width: 8,
  height: 4,
  pins: [
    { id: "IN", label: "IN", x: 1, y: 1, side: "left", labelAt: "right", kind: "power", connector: "SOT-223", connectorPin: 3, note: "Input, 20 V at most (pin 3)" },
    { id: "OUT", label: "OUT", x: 7, y: 1, side: "right", labelAt: "left", kind: "power", connector: "SOT-223", connectorPin: 2, note: "Output (pin 2 and the tab)" },
    { id: "GND", label: "GND", x: 4, y: 4, side: "bottom", labelAt: "right", kind: "gnd", connector: "SOT-223", connectorPin: 1, note: "Ground (pin 1, GND/ADJ)" },
  ],
  body: chipBody(8, 4, "NCP1117", "{vout} V LDO", 1.6),
  parts: [],
  model: [
    ncp1117Element({ in: "IN", out: "OUT", gnd: "GND" }, "{vout}"),
  ],
  info: {
    // Package: "SOT-223: 1 GND/ADJ, 2 OUT (and the tab), 3 IN"
    Package: "SOT-223, tab is OUT",
    // Accuracy: "±1 % at 25 °C, ±2 % over line, load and temperature"
    Accuracy: "±1 % (±2 % overall)",
    // Source (in the datasheet record): "onsemi NCP1117/D: electrical characteristics, absolute maximum ratings, ordering information"
    // Thermal: "shuts down at 175 °C, junction at 25 °C + P · 160 °C/W; assumed, to be checked: back on at 160 °C, a 2 s time constant"
    Thermal: "160 °C/W from 25 °C",
    Shutdown: "at 175 °C",
    "Restart (assumed)": "160 °C, 2 s τ",
    // "Not modelled" (in the datasheet record): "the safe-operating-area limit, the ambient temperature (25 °C), the ground current's rise with load, line and load regulation, ripple rejection, the adjustable part, reverse current from OUT to IN"
  },
}

/**
 * LP2985 (TI SLVS522S), the new chip TI ships today. Dropout fitted to 98 mV at 10 mA and 180 mV
 * at 150 mA as 92 mV plus 0.586 Ω times the load (120 mV at 50 mA falls out of it). ON/OFF: on above 0.85 V,
 * off below 0.72 V (typical). Ground current 69 µA with no load at VOUT + 1 V, 1.12 µA shut down
 * at 16 V.
 */
/** Thermal shutdown: RθJA 178.6 °C/W (new chip, DBV), off at 170 °C, back at 150 °C (§5.4, 5.5). Assumed: a 1 s time constant. */
const LP2985_THERMAL = { rja: 178.6, tsd: 170, tsdOff: 150, tau: 1 }
const LP2985 = { volts: ["1.8", "2.5", "2.8", "2.9", "3.0", "3.3", "5.0"], dropout: 0.092, rDrop: 0.586, limit: 0.375, enOn: 0.85, enOff: 0.72, iq: 69e-6, iqOff: 1.12e-6, iqOffAt: 16, vinMax: 18 }

/** The LP2985's regulator element; `gq` its own draw while on (69 µA at VOUT + 1 V). */
export const lp2985Element = (nodes: { in: string; out: string; gnd: string; en: string }, vout: number | string, gq: Value, label?: string): ModelElement => ({
  kind: "REG",
  ...nodes,
  value: vout,
  dropout: LP2985.dropout,
  rdrop: LP2985.rDrop,
  imax: LP2985.limit,
  enOn: LP2985.enOn,
  enOff: LP2985.enOff,
  gq,
  gqOff: LP2985.iqOff / LP2985.iqOffAt,
  thermal: LP2985_THERMAL,
  limits: { voltage: LP2985.vinMax, fail: "open" },
  label,
})

/** The LP2985-33's own draw while on: 69 µA at 4.3 V. */
export const LP2985_33_GQ = LP2985.iq / 4.3

export const lp2985Chip: ComponentDef = {
  id: "lp2985",
  name: "LP2985",
  keywords: ["LDO", "regulator", "voltage regulator", "linear regulator", "low noise", "low-dropout", "TI", "SOT-23-5"],
  description: "Low-noise 150 mA LDO regulator",
  category: "power",
  icon: ChipIcon,
  prefix: "U",
  defaults: { vout: "3.3" },
  fields: [{ key: "vout", label: "Output", type: "select", options: LP2985.volts.map((v) => ({ value: v, label: `${v} V (LP2985-${v.replace(".", "").slice(0, 2)}DBVR)` })) }],
  width: 9,
  height: 6,
  pins: [
    { id: "IN", label: "IN", x: 1, y: 1, side: "left", labelAt: "right", kind: "power", connector: "SOT-23-5", connectorPin: 1, note: "Input, 2.5–16 V; 18 V at most (pin 1)" },
    { id: "EN", label: "ON/OFF", x: 1, y: 4, side: "left", labelAt: "right", kind: "digital", connector: "SOT-23-5", connectorPin: 3, note: "High (above 0.85 V) runs, low (below 0.72 V) shuts down; tie to IN to run always (pin 3)" },
    { id: "OUT", label: "OUT", x: 8, y: 1, side: "right", labelAt: "left", kind: "power", connector: "SOT-23-5", connectorPin: 5, note: "Output, 150 mA (pin 5)" },
    { id: "BP", label: "BP", x: 8, y: 4, side: "right", labelAt: "left", kind: "analog", connector: "SOT-23-5", connectorPin: 4, note: "Bypass: 10 nF to GND lowers the noise; may be left open (pin 4)" },
    { id: "GND", label: "GND", x: 4.5, y: 6, side: "bottom", labelAt: "right", kind: "gnd", connector: "SOT-23-5", connectorPin: 2, note: "Ground (pin 2)" },
  ],
  body: chipBody(9, 6, "LP2985", "{vout} V LDO", 2.2),
  parts: [],
  model: [
    lp2985Element({ in: "IN", out: "OUT", gnd: "GND", en: "EN" }, "{vout}", (p) => LP2985.iq / (Number(p.vout ?? "3.3") + 1)),
  ],
  info: {
    // Package: "SOT-23-5 (DBV): 1 IN, 2 GND, 3 ON/OFF, 4 BYPASS, 5 OUT"
    Package: "SOT-23-5 (DBV)",
    Accuracy: "±0.5 % (new chip)",
    // Source (in the datasheet record): "TI SLVS522S (May 2025), §5.1, 5.3, 5.5, the new chip's figures"
    // Thermal: "off at 170 °C, back at 150 °C, junction at 25 °C + P · 178.6 °C/W; assumed, to be checked: a 1 s time constant"
    Thermal: "178.6 °C/W from 25 °C",
    Shutdown: "170 °C, back 150 °C",
    "Time constant (assumed)": "1 s",
    // "Not modelled" (in the datasheet record): "the ambient temperature (25 °C), the input's UVLO (2.2 V rising), the ground current's rise with load (765 µA at 150 mA), the bypass pin's noise, the legacy chip's figures"
  },
}

export const powerIcs = [tp4056Chip, dw03Chip, mt3608Chip, ncp1117Chip, lp2985Chip]

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = powerIcs

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "tp4056": {
    maker: "NanJing Top Power",
    package: "SOP-8 with exposed pad",
    docs: [DOCS["toppower-tp4056"]],
    specs: [],
    characteristics: [
      { kind: "supply", value: { min: 4, typ: 5, max: 8 }, limit: { min: -0.3, max: 8 }, cite: { page: 5, at: "Electrical Characteristics" }, limitCite: { page: 2, at: "Abs Max" } },
      { kind: "chargeCurrent", value: { typ: 1 }, cite: { page: 5, at: "IBAT" } },
      { kind: "float", value: { min: 4.158, typ: 4.2, max: 4.242 }, cite: { page: 5, at: "VFLOAT" } },
      { kind: "trickle", value: { typ: 2.9 }, cite: { page: 5, at: "VTRIKL" } },
    ],
    modelled: [
      { what: "I = 1200 V/R_PROG", cite: { page: 7, at: "Pin Functions, PROG" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Constant voltage at 4.2 V", cite: { page: 9, at: "Charge Termination" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Ends charge below C/10", cite: { page: 9, at: "Charge Termination" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "C/10 trickle below 2.9 V", cite: { page: 5, at: "Electrical Characteristics, VTRIKL, VTRHYS" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Recharge 150 mV below float", cite: { page: 5, at: "Electrical Characteristics, ΔVRECHRG" } },
      { what: "UVLO on at 3.8 V", cite: { page: 5, at: "Electrical Characteristics, VUV, VASD" } },
      { what: "CHRG and STDBY open drains", cite: { page: 10, at: "Charge status indicator" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Charges only with CE high", test: "tests/sim/charge-boost.test.ts" },
      { what: "TEMP window 45–80 % VCC", cite: { page: 7, at: "Pin Functions, TEMP" } },
      { what: "Draws 150 µA from VCC", cite: { page: 5, at: "Electrical Characteristics, ICC" } },
      { what: "Destroyed past 8 V supply", cite: { page: 2, at: "Absolute Maximum Ratings" }, test: "tests/sim/charge-boost.test.ts" },
    ],
    notModelled: [
      { what: "Sheet's 1100 V/R_PROG law", cite: { page: 9, at: "Programming Charge Current" } },
      { what: "Thermal regulation near 145 °C", cite: { page: 8, at: "Operation" } },
      { what: "650 mΩ power-FET resistance", cite: { page: 5, at: "Electrical Characteristics, RON" } },
      { what: "Soft start (20 µs)", cite: { page: 5, at: "Electrical Characteristics, tss" } },
      { what: "Standby and shutdown currents", cite: { page: 5, at: "Electrical Characteristics, ICC, IBAT" } },
      { what: "Shutdown by leaving PROG open", cite: { page: 11, at: "Manual Shutdown" } },
      { what: "LED flicker without a battery", cite: { page: 10, at: "Charge status indicator" } },
    ],
  },
  "dw03": {
    maker: "PJSEMI",
    package: "SOT-23-5 (pin 1 NC)",
    docs: [DOCS["pjsemi-dw03"]],
    specs: [],
    characteristics: [
      { kind: "supply", limit: { min: -0.3, max: 6 }, cite: { page: 3, at: "Abs Max" } },
      { kind: "overcharge", value: { min: 4.25, typ: 4.3, max: 4.35, release: 4.1 }, cite: { page: 3, at: "Electrical table" } },
      { kind: "overdischarge", value: { min: 2.3, typ: 2.4, max: 2.5, release: 3 }, cite: { page: 3, at: "Electrical table" } },
      { kind: "overcurrent", value: { min: 2.7, typ: 3.5, max: 4.4 }, at: [{ supply: 3.6 }], cite: { page: 3, at: "IIOV1" } },
      { kind: "shortCircuit", value: { min: 10, typ: 20, max: 30 }, cite: { page: 3, at: "ISHORT" } },
      { kind: "tripTime", value: { max: 200e-6 }, cite: { page: 3, at: "tSHORT" } },
      { kind: "onResistance", value: { min: 0.035, typ: 0.04, max: 0.05 }, cite: { page: 3, at: "RDS(ON)" } },
    ],
    modelled: [
      { what: "Two series N-MOSFETs, 40 mΩ", cite: { page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings), RDS(ON)" } },
      { what: "Overcharge cut at 4.3 V", cite: { page: 5, at: "Overcharge Condition" } },
      { what: "Overcharge releases at 4.1 V", cite: { page: 5, at: "Overcharge Condition" } },
      { what: "Over-discharge cut at 2.4 V", cite: { page: 5, at: "Overdischarge Condition" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Charger or 3.0 V releases", cite: { page: 5, at: "Overdischarge Condition" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Overcurrent trip at 3.5 A", cite: { page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings)" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Short-circuit trip at 20 A", cite: { page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings)" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "20 kΩ pull-down after overcurrent", cite: { page: 6, at: "Overcurrent Condition" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Draws about 3 µA", cite: { page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings), IOPE" } },
      { what: "Destroyed past 6 V supply", cite: { page: 3, at: "Absolute Maximum Ratings" } },
    ],
    notModelled: [
      { what: "Over-temperature protection (130 °C)", cite: { page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings), TSHD" } },
      { what: "Power-down after over-discharge", cite: { page: 5, at: "Overdischarge Condition" } },
      { what: "300 kΩ VM-to-VDD pull-up", cite: { page: 5, at: "Overdischarge Condition" } },
      { what: "Abnormal charge current detection", cite: { page: 6, at: "Abnormal Charge Current Detection" } },
      { what: "0 V battery charging", cite: { page: 7, at: "0V Battery Charging Function" } },
      { what: "Spread of thresholds and delays", cite: { page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings)" } },
      { what: "Over-discharge delay at maximum", cite: { page: 3, at: "Electrical table (printed as a second Absolute Maximum Ratings)" } },
    ],
  },
  "mt3608": {
    maker: "Aerosemi",
    package: "SOT-23-6 (pin 6 NC)",
    docs: [DOCS["aerosemi-mt3608"]],
    specs: [],
    characteristics: [
      { kind: "input", value: { min: 2, max: 24 }, limit: { max: 26 }, cite: { page: 3, at: "Electrical Characteristics" }, limitCite: { page: 2, at: "Abs Max" } },
      { kind: "output", value: { max: 28 }, cite: { page: 1, at: "Features" } },
      { kind: "feedback", value: { min: 0.588, typ: 0.6, max: 0.612 }, cite: { page: 3, at: "FB Voltage" } },
      { kind: "currentLimit", value: { typ: 4 }, cite: { page: 3, at: "SW Current Limit" } },
      { kind: "switching", value: { typ: 1.2e6 }, cite: { page: 3, at: "Electrical Characteristics" } },
    ],
    modelled: [
      { what: "Holds FB at 0.6 V", cite: { page: 6, at: "Setting the Output Voltage" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Averaged switching, 90 % efficiency", test: "tests/sim/charge-boost.test.ts" },
      { what: "Output at the Schottky's cathode" },
      { what: "About 2 A input limit", cite: { page: 3, at: "Electrical Characteristics, SW Current Limit" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "Overload pulls output down", cite: { page: 3, at: "Electrical Characteristics, SW Current Limit" }, test: "tests/sim/charge-boost.test.ts" },
      { what: "UVLO at 2 V", cite: { page: 3, at: "Electrical Characteristics, Under Voltage Lockout" } },
      { what: "EN above 1.5 V enables", cite: { page: 3, at: "Electrical Characteristics, EN Input High Voltage" } },
      { what: "Draws 1 mA while running", test: "tests/sim/charge-boost.test.ts" },
      { what: "Breaks open past 28 V", cite: { page: 1, at: "Features" } },
    ],
    notModelled: [
      { what: "Switching ripple at 1.2 MHz", cite: { page: 3, at: "Electrical Characteristics, Switching Frequency" } },
      { what: "PFM at light load", cite: { page: 3, at: "Electrical Characteristics, Quiescent Current" } },
      { what: "100 µA quiescent current", cite: { page: 3, at: "Electrical Characteristics, Quiescent Current" } },
      { what: "Efficiency change with load, input", cite: { page: 4, at: "Typical Performance Characteristics" } },
      { what: "90 % maximum duty cycle", cite: { page: 3, at: "Electrical Characteristics, Maximum Duty Cycle" } },
      { what: "80 mΩ switch resistance", cite: { page: 3, at: "Electrical Characteristics, SW On Resistance" } },
      { what: "Soft start", cite: { page: 5, at: "Functional Description" } },
      { what: "Thermal shutdown (155 °C)", cite: { page: 3, at: "Electrical Characteristics, Thermal Shutdown" } },
    ],
  },
  "ncp1117": {
    maker: "onsemi",
    package: "SOT-223",
    docs: [DOCS["onsemi-ncp1117"]],
    specs: [],
    characteristics: [
      { kind: "input", limit: { max: 20 }, cite: { page: 2, at: "Maximum Ratings" } },
      { kind: "output", value: { min: 4.95, typ: 5, max: 5.05 }, at: [{ vin: 7 }, { load: { amps: 10e-3 } }], cite: { page: 3, at: "Electrical Characteristics" } },
      { kind: "dropout", value: { typ: 1.07, max: 1.2 }, at: [{ load: { amps: 0.8 } }], cite: { page: 3, at: "Dropout Voltage" } },
      { kind: "currentLimit", value: { min: 1, typ: 1.5, max: 2.2 }, cite: { page: 3, at: "Output Current Limit" } },
      { kind: "quiescent", value: { typ: 6e-3, max: 10e-3 }, at: [{ vin: 15 }], cite: { page: 4, at: "Quiescent Current" } },
      { kind: "thermal", value: { typ: 160 }, cite: { page: 2, at: "Note 2" } },
      { kind: "shutdown", value: { typ: 175, approx: true }, cite: { page: 2, at: "Note 2" } },
    ],
    modelled: [
      { what: "Seven fixed outputs, 1.5–12 V", cite: { page: 12, at: "Ordering Information" } },
      { what: "Regulates to nominal output", cite: { page: 3, at: "Electrical Characteristics" }, test: "tests/sim/ldo.test.ts" },
      { what: "Dropout linear in load current", cite: { page: 3, at: "Electrical Characteristics, Dropout Voltage" }, test: "tests/sim/ldo.test.ts" },
      { what: "Current limit 1.5 A", cite: { page: 3, at: "Electrical Characteristics, Output Current Limit" } },
      { what: "6 mA quiescent current", cite: { page: 4, at: "Electrical Characteristics, Quiescent Current" }, test: "tests/sim/ldo.test.ts" },
      { what: "Quiescent current scales with input", cite: { page: 4, at: "Electrical Characteristics, Quiescent Current" }, test: "tests/sim/ldo.test.ts" },
      { what: "Thermal shutdown at 175 °C", cite: { page: 2, at: "Maximum Ratings, Note 2" }, test: "tests/sim/ldo.test.ts" },
      { what: "160 °C/W junction heating", cite: { page: 2, at: "Maximum Ratings, Note 2" }, test: "tests/sim/ldo.test.ts" },
      { what: "Destroyed past 20 V input", cite: { page: 2, at: "Maximum Ratings" }, test: "tests/sim/ldo.test.ts" },
    ],
    notModelled: [
      { what: "The safe-operating-area limit", cite: { page: 2, at: "Maximum Ratings, Note 3" } },
      { what: "The ambient temperature (25 °C)", cite: { page: 2, at: "Maximum Ratings" } },
      { what: "Ground current rise with load" },
      { what: "Line and load regulation", cite: { page: 3, at: "Electrical Characteristics" } },
      { what: "Ripple rejection", cite: { page: 4, at: "Electrical Characteristics, Ripple Rejection" } },
      { what: "The adjustable part", cite: { page: 9, at: "Output Voltage" } },
      { what: "Reverse OUT-to-IN current", cite: { page: 10, at: "Protection Diodes" } },
      { what: "Output-capacitor stability requirement", cite: { page: 9, at: "External Capacitors" } },
    ],
  },
  "lp2985": {
    maker: "Texas Instruments",
    package: "SOT-23-5 (DBV)",
    docs: [DOCS["ti-slvs522s"]],
    specs: [],
    characteristics: [
      { kind: "input", value: { min: 2.5, max: 16 }, limit: { max: 18 }, cite: { page: 4, at: "§5.3" }, limitCite: { page: 4, at: "§5.1" } },
      { kind: "outputCurrent", value: { max: 0.15 }, cite: { page: 7, at: "§5.5" } },
      { kind: "shortCircuit", value: { typ: 0.375 }, cite: { page: 7, at: "§5.5" } },
      { kind: "dropout", value: { typ: 0.18, max: 0.198 }, at: [{ load: { amps: 0.15 } }], cite: { page: 6, at: "§5.5" } },
      { kind: "quiescent", value: { typ: 69e-6 }, at: [{ state: "noLoad" }], cite: { page: 7, at: "§5.5" } },
      { kind: "quiescent", value: { typ: 1.12e-6 }, at: [{ state: "shutdown" }, { vin: 16 }], cite: { page: 7, at: "§5.5" } },
      { kind: "threshold", value: { typ: 0.85, release: 0.72 }, cite: { page: 7, at: "§5.5" } },
    ],
    modelled: [
      { what: "Regulates within ±0.5 %", cite: { page: 5, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ldo.test.ts" },
      { what: "Dropout linear in load current", cite: { page: 6, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ldo.test.ts" },
      { what: "Brick-wall limit at 375 mA", cite: { page: 7, at: "§5.5 Electrical Characteristics, IO(SC)" }, test: "tests/sim/ldo.test.ts" },
      { what: "Draws 69 µA unloaded", cite: { page: 6, at: "§5.5 Electrical Characteristics, IGND" }, test: "tests/sim/ldo.test.ts" },
      { what: "On above 0.85 V", cite: { page: 7, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ldo.test.ts" },
      { what: "Off below 0.72 V", cite: { page: 7, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ldo.test.ts" },
      { what: "1.12 µA when shut down", cite: { page: 7, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ldo.test.ts" },
      { what: "Thermal shutdown at 170 °C", cite: { page: 7, at: "§5.5 Electrical Characteristics, Tsd" }, test: "tests/sim/ldo.test.ts" },
      { what: "178.6 °C/W junction heating", cite: { page: 7, at: "§5.5 Electrical Characteristics, Tsd" }, test: "tests/sim/ldo.test.ts" },
      { what: "Destroyed past 18 V input", cite: { page: 4, at: "§5.1 Absolute Maximum Ratings" }, test: "tests/sim/ldo.test.ts" },
    ],
    notModelled: [
      { what: "The ambient temperature (25 °C)", cite: { page: 5, at: "§5.4 Thermal Information" } },
      { what: "Input UVLO (2.2 V rising)", cite: { page: 7, at: "§5.5 Electrical Characteristics, VUVLO+" } },
      { what: "Ground current rise with load", cite: { page: 6, at: "§5.5 Electrical Characteristics, IGND" } },
      { what: "The bypass pin's noise", cite: { page: 7, at: "§5.5 Electrical Characteristics, Vn" } },
      { what: "The legacy chip's figures", cite: { page: 5, at: "§5.5 Electrical Characteristics" } },
      { what: "The output pull-down when disabled", cite: { page: 16, at: "§6.3.1 Output Enable" } },
      { what: "Reverse OUT-to-IN current", cite: { page: 21, at: "§7.1.4 Reverse Current" } },
      { what: "Line regulation and ripple rejection", cite: { page: 7, at: "§5.5 Electrical Characteristics" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
