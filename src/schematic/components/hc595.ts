import { HC595_INPUTS, HC595_LINKS, HC595_OUTPUTS, SHIFT_REGISTER_DEFS, shiftRegisterOfDef, type ShiftRegisterPart } from "@/sim/hc595"
import { ShiftRegisterIcon } from "../icons"
import { pinNumbers } from "../pin-numbers"
import type { ComponentDef, Element, PinDef } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

const W = 8
const H = 14

const OUTPUT_DIP = [15, 1, 2, 3, 4, 5, 6, 7]

const INPUT_PINS: PinDef[] = [
  { id: "SER", label: "SER", x: 1, y: 2, side: "left", labelAt: "right", kind: "digital", connector: "PDIP-16", connectorPin: 14, note: "Serial data in, sampled on the rising edge of SRCLK" },
  { id: "SRCLK", label: "SRCLK", x: 1, y: 4, side: "left", labelAt: "right", kind: "digital", connector: "PDIP-16", connectorPin: 11, note: "Shift clock: on the rising edge QA takes SER and every stage moves one on" },
  { id: "SRCLR", label: "SRCLR", x: 1, y: 5, side: "left", labelAt: "right", kind: "digital", inverted: true, connector: "PDIP-16", connectorPin: 10, note: "Shift register clear, active low; the storage register keeps its data" },
  { id: "RCLK", label: "RCLK", x: 1, y: 7, side: "left", labelAt: "right", kind: "digital", connector: "PDIP-16", connectorPin: 12, note: "Storage clock: on the rising edge the shift register is copied to QA–QH" },
  { id: "OE", label: "OE", x: 1, y: 8, side: "left", labelAt: "right", kind: "digital", inverted: true, connector: "PDIP-16", connectorPin: 13, note: "Output enable, active low: high puts QA–QH in high impedance, not QH'" },
]

const OUTPUT_PINS: PinDef[] = [
  ...HC595_OUTPUTS.map(
    (id, k): PinDef => ({ id, label: id, x: W - 1, y: 2 + k, side: "right", labelAt: "left", kind: "digital", connector: "PDIP-16", connectorPin: OUTPUT_DIP[k], note: `Storage register bit ${k}, 3-state, ±35 mA` }),
  ),
  { id: "QHS", label: "QH'", x: W - 1, y: 11, side: "right", labelAt: "left", kind: "digital", connector: "PDIP-16", connectorPin: 9, note: "Serial out from the last shift stage, for the next chip's SER; never 3-state" },
]

const pinsOf = (supply: string): PinDef[] => [
  ...INPUT_PINS,
  ...OUTPUT_PINS,
  { id: "VCC", label: "VCC", x: 4, y: 1, side: "top", labelAt: "bottom", kind: "power", connector: "PDIP-16", connectorPin: 16, note: `${supply}, 7 V absolute; ±70 mA through VCC and GND` },
  { id: "GND", label: "GND", x: 4, y: H - 1, side: "bottom", labelAt: "top", kind: "gnd", connector: "PDIP-16", connectorPin: 8 },
]

const CLAMP = { current: 0.02, tau: 1, fail: "short" } as const

const OUTPUT_LIMITS = { voltage: 7, current: 0.035, tau: 1, fail: "open" } as const


const model: Element[] = [
  { kind: "R", a: "VCC", b: "$vcc", value: 0.05, hidden: true, limits: { current: 0.5, tau: 1, fail: "open", fatal: false } },
  { kind: "R", a: "$gnd", b: "GND", value: 0.05, hidden: true, limits: { current: 0.5, tau: 1, fail: "open", fatal: false } },
  { kind: "R", a: "$vcc", b: "$gnd", value: 100e6, hidden: true, supply: true, limits: { voltage: 7, fail: "short" } },
  ...HC595_OUTPUTS.map((node): Element => ({ kind: "GPIO", node, vddNode: "$vcc", gndNode: "$gnd", drive: { ohms: 29, at: 4.5 }, limits: OUTPUT_LIMITS })),
  { kind: "GPIO", node: "QHS", vddNode: "$vcc", gndNode: "$gnd", drive: { ohms: 44, at: 4.5 }, limits: { ...OUTPUT_LIMITS, current: 0.025 } },
  ...HC595_INPUTS.flatMap((node): Element[] => [
    { kind: "GPIO", node, vddNode: "$vcc", gndNode: "$gnd" },
    { kind: "D", anode: node, cathode: "$vcc", vf: 0.7, hidden: true, limits: CLAMP },
    { kind: "D", anode: "$gnd", cathode: node, vf: 0.7, hidden: true, limits: CLAMP },
  ]),
]

const FUNCTION =
  "8-bit serial-in, parallel-out shift register with a 3-state output register, PDIP-16: SER shifts in on SRCLK, RCLK latches QA–QH, SRCLR clears the shift register, OE floats the outputs, QH' feeds the next chip."

type Variant = { id: keyof typeof SHIFT_REGISTER_DEFS; supply: string; description: string; source: string }

function shiftRegister({ id, supply, description, source }: Variant): ComponentDef {
  const part: ShiftRegisterPart = SHIFT_REGISTER_DEFS[id]
  const pins = pinsOf(supply)
  return {
    id,
    name: part,
    description: `${FUNCTION} ${description}`,
    category: "ics",
    keywords: ["595", "shift register", "serial to parallel", "SIPO"],
    icon: ShiftRegisterIcon,
    prefix: "U",
    width: W,
    height: H,
    pins,
    body: [
      { type: "rect", x: 1, y: 1, w: W - 2, h: H - 2, rx: 0.2, fill: "board" },
      { type: "text", x: 1.5, y: 10, text: part, size: 0.36, anchor: "start" },
      { type: "text", x: 1.5, y: 10.65, text: "shift register", size: 0.22, muted: true, anchor: "start" },
      { type: "text", x: W - 1.4, y: 1.3, text: "{ref}", size: 0.26, muted: true, anchor: "end" },
      ...pinNumbers(pins),
    ],
    parts: [],
    model,
    info: { Package: "PDIP-16", Source: source },
  }
}

export const hc595 = shiftRegister({
  id: "hc595",
  supply: "2–6 V",
  description:
    "TI SN74HC595: 2–6 V with CMOS inputs (a high is 0.7 × VCC, so a 3.3 V MCU does not reliably drive one at 5 V), 17 ns at 4.5 V, ±6 mA rated drive (±35 mA absolute).",
  source: "TI SN74HC595 (SCLS041J), Nexperia 74HC_HCT595 (rev. 12)",
})

export const hct595 = shiftRegister({
  id: "hct595",
  supply: "4.5–5.5 V",
  description: "Nexperia 74HCT595: 5 V only, with TTL inputs (a high is 2 V) that a 3.3 V MCU drives, 25 ns, ±6 mA rated drive (±35 mA absolute).",
  source: "Nexperia 74HC_HCT595 (rev. 12)",
})

export const isShiftRegisterDef = (defId: string) => shiftRegisterOfDef(defId) !== undefined

export { HC595_LINKS }

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [hc595, hct595]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "hc595": {
    maker: "Texas Instruments",
    package: "PDIP-16",
    docs: [DOCS["ti-scls041j"], DOCS["nexperia-74hc595"]],
    specs: [
      { label: "Supply", value: "2–6 V (7 V abs max)", cite: { page: 4, at: "§6.3 Recommended Operating Conditions; §6.1" } },
      { label: "Input high (VIH)", value: "3.15 V at 4.5 V, 4.2 V at 6 V", cite: { page: 4, at: "§6.3 Recommended Operating Conditions" } },
      { label: "Output current", value: "±6 mA at 4.5 V (VOH ≥ 3.98 V)", cite: { page: 5, at: "§6.5 Electrical Characteristics" } },
      { label: "Output current (abs max)", value: "±35 mA a pin, ±70 mA through VCC or GND", cite: { page: 4, at: "§6.1 Absolute Maximum Ratings" } },
      { label: "Max clock", value: "25 MHz at 4.5 V (31 MHz at 25 °C)", cite: { page: 6, at: "§6.6 Timing Requirements" } },
      { label: "Propagation delay", value: "17 ns typ, RCLK to QA–QH at 4.5 V", cite: { page: 8, at: "§6.7 Switching Characteristics" } },
    ],
    modelled: [
      { what: "Shift on SRCLK, latch on RCLK, clear on /SRCLR, 3-state on /OE with QH' always driven", cite: { page: 12, at: "Table 8-1 Function Table" }, test: "tests/sim/hc595.test.ts" },
      { what: "With the clocks tied the storage register runs one clock behind", cite: { page: 6, at: "§6.6 note 1" }, test: "tests/sim/hc595.test.ts" },
      { what: "Outputs change a typical propagation delay after the clock: 17 ns at 4.5 V, 50 ns at 2 V", cite: { page: 8, at: "§6.7 Switching Characteristics" }, test: "tests/sim/hc595.test.ts" },
      { what: "Set-up, hold, pulse-width and recovery times checked against the table, a violation reported", cite: { page: 6, at: "§6.6 Timing Requirements" }, test: "tests/sim/hc595.test.ts" },
      { what: "Inputs switch at the typical levels, between VIL and VIH; 3.3 V logic at 5 V is reported as undefined", cite: { doc: "nexperia-74hc595", page: 7, at: "Table 6 Static characteristics" }, test: "tests/sim/hc595.test.ts" },
      { what: "VOH and VOL at the rated 6 mA and 7.8 mA near typical, within the limits", cite: { page: 5, at: "§6.5 Electrical Characteristics" }, test: "tests/sim/hc595.test.ts" },
      { what: "An output past 35 mA burns; past 7 V on VCC the chip dies", cite: { page: 4, at: "§6.1 Absolute Maximum Ratings" }, test: "tests/sim/hc595.test.ts" },
      { what: "Input clamp diodes to VCC and GND, burning past 20 mA, and phantom power through them", cite: { page: 4, at: "§6.1 Absolute Maximum Ratings" }, test: "tests/sim/hc595.test.ts" },
      { what: "Warns below 2 V or above 6 V, about an open input and a clock edge slower than one solver step", cite: { page: 4, at: "§6.3 Recommended Operating Conditions" }, test: "tests/sim/hc595.test.ts" },
    ],
    notModelled: [
      { what: "The ±70 mA VCC/GND rating: the current is reported, not damage", cite: { page: 4, at: "§6.1 Absolute Maximum Ratings" } },
      { what: "Supply current: the 80 µA quiescent and the 400 pF power-dissipation capacitance", cite: { page: 8, at: "§6.8 Operating Characteristics" } },
      { what: "Output transition time and the slower delays into 150 pF", cite: { page: 8, at: "§6.7 Switching Characteristics" } },
      { what: "Double clocking on a slow input edge: a slow edge is only reported", cite: { page: 4, at: "§6.3 note 2" } },
      { what: "Temperature: timing and drive are the 25 °C typical, not the −40 °C to 85 °C limits", cite: { page: 6, at: "§6.6 Timing Requirements" } },
      { what: "Input capacitance (3 pF) and leakage", cite: { page: 5, at: "§6.5 Electrical Characteristics" } },
    ],
  },
  "hct595": {
    maker: "Nexperia",
    package: "PDIP-16",
    docs: [DOCS["nexperia-74hc595"]],
    specs: [
      { label: "Supply", value: "4.5–5.5 V (7 V abs max)", cite: { page: 7, at: "Table 5 Recommended operating conditions; Table 4" } },
      { label: "Input levels", value: "VIH 2.0 V min, VIL 0.8 V max", cite: { page: 8, at: "Table 6 Static characteristics" } },
      { label: "Output current", value: "±6 mA at 4.5 V (VOH ≥ 3.7 V)", cite: { page: 8, at: "Table 6 Static characteristics" } },
      { label: "Output current (abs max)", value: "±35 mA Qn, ±25 mA Q7S, 70 mA through VCC or GND", cite: { page: 6, at: "Table 4 Limiting values" } },
      { label: "Max clock", value: "52 MHz typ, 30 MHz min at 25 °C", cite: { page: 11, at: "Table 7 Dynamic characteristics" } },
      { label: "Propagation delay", value: "24 ns typ, STCP to Qn", cite: { page: 11, at: "Table 7 Dynamic characteristics" } },
    ],
    modelled: [
      { what: "Shift, latch, clear and 3-state logic of the function table, QH' always driven", cite: { page: 5, at: "Table 3 Function table" }, test: "tests/sim/hc595.test.ts" },
      { what: "TTL input levels switching at the typical 1.6 V rising, 1.2 V falling: a 3.3 V MCU drives it at 5 V", cite: { page: 8, at: "Table 6 Static characteristics" }, test: "tests/sim/hc595.test.ts" },
      { what: "Set-up, hold (3 ns), pulse-width and recovery times checked against the table", cite: { page: 11, at: "Table 7 Dynamic characteristics" }, test: "tests/sim/hc595.test.ts" },
      { what: "Warns away from the 4.5–5.5 V supply range", cite: { page: 7, at: "Table 5 Recommended operating conditions" }, test: "tests/sim/hc595.test.ts" },
      { what: "An output past 35 mA burns; past 7 V on VCC the chip dies", cite: { page: 6, at: "Table 4 Limiting values" }, test: "tests/sim/hc595.test.ts" },
      { what: "Input clamp diodes burning past 20 mA", cite: { page: 6, at: "Table 4 Limiting values" }, test: "tests/sim/hc595.test.ts" },
    ],
    notModelled: [
      { what: "Extra supply current of a TTL-level input held at VCC − 2.1 V (ΔICC, 150 µA typ a clock pin)", cite: { page: 9, at: "Table 6 Static characteristics" } },
      { what: "Supply current: the 80 µA quiescent and the 130 pF power-dissipation capacitance", cite: { page: 11, at: "Table 7 Dynamic characteristics" } },
      { what: "The 70 mA VCC/GND rating: the current is reported, not damage", cite: { page: 6, at: "Table 4 Limiting values" } },
      { what: "Output transition times and load-capacitance dependence of the delays", cite: { page: 11, at: "Table 7 Dynamic characteristics" } },
      { what: "Temperature: timing and drive are the 25 °C typical", cite: { page: 11, at: "Table 7 Dynamic characteristics" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
