import { HC595_INPUTS, HC595_OUTPUTS } from "@/sim/hc595"
import { ShiftRegisterIcon } from "../icons"
import { pinNumbers } from "../pin-numbers"
import type { ComponentDef, Element, PinDef } from "../types"

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

const PINS: PinDef[] = [
  ...INPUT_PINS,
  ...OUTPUT_PINS,
  { id: "VCC", label: "VCC", x: 4, y: 1, side: "top", labelAt: "bottom", kind: "power", connector: "PDIP-16", connectorPin: 16, note: "2–6 V (HCT 4.5–5.5 V), 7 V absolute; ±70 mA through VCC and GND" },
  { id: "GND", label: "GND", x: 4, y: H - 1, side: "bottom", labelAt: "top", kind: "gnd", connector: "PDIP-16", connectorPin: 8 },
]

const CLAMP = { current: 0.02, tau: 1, fail: "short" } as const

const OUTPUT_LIMITS = { voltage: 7, current: 0.035, tau: 1, fail: "open" } as const

export const HC595_LINKS = { vcc: 0, gnd: 1 } as const

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

export const hc595: ComponentDef = {
  id: "hc595",
  name: "74HC595",
  description:
    "8-bit serial-in, parallel-out shift register with a 3-state output register, PDIP-16 (TI SN74HC595): SER shifts in on SRCLK, RCLK latches QA–QH, SRCLR clears the shift register, OE floats the outputs, QH' feeds the next chip. 17 ns at 4.5 V, ±6 mA rated drive (±35 mA absolute). Part: 74HC595 for 2–6 V with CMOS inputs; 74HCT595 for 4.5–5.5 V with TTL inputs a 3.3 V MCU can drive.",
  category: "Logic ICs",
  icon: ShiftRegisterIcon,
  prefix: "U",
  defaults: { value: "74HC595" },
  fields: [
    {
      key: "value",
      label: "Part",
      type: "select",
      options: [
        { value: "74HC595", label: "74HC595 · 2–6 V, CMOS inputs" },
        { value: "74HCT595", label: "74HCT595 · 5 V, TTL inputs" },
      ],
    },
  ],
  width: W,
  height: H,
  pins: [
    ...PINS,
  ],
  body: [
    { type: "rect", x: 1, y: 1, w: W - 2, h: H - 2, rx: 0.2, fill: "board" },
    { type: "text", x: 1.5, y: 10, text: "{value}", size: 0.36, anchor: "start" },
    { type: "text", x: 1.5, y: 10.65, text: "shift register", size: 0.22, muted: true, anchor: "start" },
    { type: "text", x: W - 1.4, y: 1.3, text: "{ref}", size: 0.26, muted: true, anchor: "end" },
    ...pinNumbers(PINS),
  ],
  parts: [],
  model,
  info: { Package: "PDIP-16", Source: "TI SN74HC595 (SCLS041J), Nexperia 74HC_HCT595 (rev. 12)" },
}
