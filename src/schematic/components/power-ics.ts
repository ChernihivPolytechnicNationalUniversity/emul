import { ChipIcon } from "../icons"
import { dw03, mt3608, tp4056 } from "../power-model"
import type { BodyShape, ComponentDef, ModelElement, Value } from "../types"

const chipBody = (w: number, h: number, part: string, what: string, y: number): BodyShape[] => [
  { type: "rect", x: 1, y: 0.5, w: w - 2, h: h - 1, rx: 0.2, fill: "board" },
  { type: "text", x: w / 2, y: y + 0.15, text: part, size: 0.4 },
  { type: "text", x: w / 2, y: y + 0.75, text: what, size: 0.24, muted: true },
  { type: "text", x: w - 1.6, y: 0.15, text: "{ref}", size: 0.3, muted: true },
]

export const tp4056Chip: ComponentDef = {
  id: "tp4056",
  name: "TP4056",
  description: "1 A linear Li-ion charger, SOP-8. Charge current 1200 / R_PROG (1.2 kΩ = 1 A); trickle below 2.9 V, 4.2 V float, ends at C/10. CE high to run; TEMP to GND without an NTC.",
  keywords: ["charger", "battery charger", "Li-ion", "lithium"],
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
  info: { Package: "SOP-8 with exposed pad", Source: "TP4056 datasheet (NanJing Top Power)" },
}

export const dw03Chip: ComponentDef = {
  id: "dw03",
  name: "DW03",
  description: "One-cell Li-ion protection with its MOSFETs inside, SOT-23-5: cell minus on GND, the pack's minus on VM. Overcharge 4.3 V, over-discharge 2.4 V, 3.5 A, short 20 A.",
  keywords: ["battery protection", "protection", "Li-ion", "lithium"],
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
  info: { Package: "SOT-23-5 (pin 1 NC)", "On resistance": "40 mΩ GND to VM", Source: "DW03 datasheet (PJSEMI)" },
}

export const mt3608Chip: ComponentDef = {
  id: "mt3608",
  name: "MT3608",
  keywords: ["boost", "step-up", "DC-DC", "converter"],
  description:
    "1.2 MHz boost, SOT-23-6: the inductor from the supply to SW, a Schottky from SW to the output, a divider from the output to FB (0.6 V). Simulated averaged over its switching; it finds the diode on SW. EN high to run.",
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
  info: { Package: "SOT-23-6 (pin 6 NC)", "Switch limit": "4 A peak, ~2 A average from the input", Output: "up to 28 V", Source: "MT3608 datasheet (Aerosemi)" },
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
  keywords: ["LDO", "regulator", "voltage regulator", "linear regulator", "1117"],
  description:
    "onsemi's 1 A low-dropout regulator, SOT-223, fixed 1.5–12 V (Arduino Uno's 5 V). About 1 V of dropout (0.95 V at 100 mA, 1.07 V at 800 mA), 1.5 A into a short, 6 mA of its own, 20 V at most on its input.",
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
    Package: "SOT-223: 1 GND/ADJ, 2 OUT (and the tab), 3 IN",
    Accuracy: "±1 % at 25 °C, ±2 % over line, load and temperature",
    Source: "onsemi NCP1117/D: electrical characteristics, absolute maximum ratings, ordering information",
    Thermal: "shuts down at 175 °C, junction at 25 °C + P · 160 °C/W; assumed, to be checked: back on at 160 °C, a 2 s time constant",
    "Not modelled": "the safe-operating-area limit, the ambient temperature (25 °C), the ground current's rise with load, line and load regulation, ripple rejection, the adjustable part, reverse current from OUT to IN",
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
  keywords: ["LDO", "regulator", "voltage regulator", "linear regulator", "low noise"],
  description:
    "TI's 150 mA low-noise LDO with shutdown, SOT-23-5, fixed 1.8–5 V (Arduino Uno's 3.3 V). 180 mV of dropout at 150 mA, 375 mA into a short, 69 µA of its own; ON/OFF high to run, low for 1 µA. 16 V in, 18 V at most.",
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
    Package: "SOT-23-5 (DBV): 1 IN, 2 GND, 3 ON/OFF, 4 BYPASS, 5 OUT",
    Accuracy: "±0.5 % (new chip)",
    Source: "TI SLVS522S (May 2025), §5.1, 5.3, 5.5, the new chip's figures",
    Thermal: "off at 170 °C, back at 150 °C, junction at 25 °C + P · 178.6 °C/W; assumed, to be checked: a 1 s time constant",
    "Not modelled": "the ambient temperature (25 °C), the input's UVLO (2.2 V rising), the ground current's rise with load (765 µA at 150 mA), the bypass pin's noise, the legacy chip's figures",
  },
}

export const powerIcs = [tp4056Chip, dw03Chip, mt3608Chip, ncp1117Chip, lp2985Chip]
