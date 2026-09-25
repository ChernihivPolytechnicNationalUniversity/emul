import { ChipIcon } from "../icons"
import { dw03, mt3608, tp4056 } from "../power-model"
import type { BodyShape, ComponentDef } from "../types"

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
  category: "Power ICs",
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
  category: "Power ICs",
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
  description:
    "1.2 MHz boost, SOT-23-6: the inductor from the supply to SW, a Schottky from SW to the output, a divider from the output to FB (0.6 V). Simulated averaged over its switching; it finds the diode on SW. EN high to run.",
  category: "Power ICs",
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

export const powerIcs = [tp4056Chip, dw03Chip, mt3608Chip]
