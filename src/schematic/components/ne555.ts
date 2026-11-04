import { NE555 } from "@/sim/ne555"
import { TimerIcon } from "../icons"
import { pinNumbers } from "../pin-numbers"
import type { ComponentDef, PinDef } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

const W = 10
const H = 10
const DIP = "PDIP-8"

const PINS: PinDef[] = [
  { id: "RESET", label: "RESET", x: 4, y: 1, side: "top", labelAt: "bottom", kind: "digital", inverted: true, connector: DIP, connectorPin: 4, note: "Active low: below about 0.7 V the output is low and DISCH conducts; tie to VCC when unused" },
  { id: "VCC", label: "VCC", x: 7, y: 1, side: "top", labelAt: "bottom", kind: "power", connector: DIP, connectorPin: 8, note: "4.5–16 V, 18 V absolute maximum" },
  { id: "DIS", label: "DISCH", x: 1, y: 3, side: "left", labelAt: "right", kind: "analog", connector: DIP, connectorPin: 7, note: "Discharge: open collector to GND while the output is low" },
  { id: "THRES", label: "THRES", x: 1, y: 5, side: "left", labelAt: "right", kind: "analog", connector: DIP, connectorPin: 6, note: "Threshold: above CONT (2/3 VCC) the output goes low" },
  { id: "TRIG", label: "TRIG", x: 1, y: 7, side: "left", labelAt: "right", kind: "analog", connector: DIP, connectorPin: 2, note: "Trigger: below CONT/2 (1/3 VCC) the output goes high, whatever THRES says" },
  { id: "OUT", label: "OUT", x: 9, y: 5, side: "right", labelAt: "left", kind: "digital", connector: DIP, connectorPin: 3, note: "Output, ±200 mA; ±225 mA absolute maximum" },
  { id: "GND", label: "GND", x: 4, y: 9, side: "bottom", labelAt: "top", kind: "gnd", connector: DIP, connectorPin: 1 },
  { id: "CTRL", label: "CONT", x: 7, y: 9, side: "bottom", labelAt: "top", kind: "analog", connector: DIP, connectorPin: 5, note: "Control voltage, 2/3 VCC through the divider; decouple with 10 nF to GND" },
]

export const ne555: ComponentDef = {
  id: "ne555",
  name: "NE555",
  keywords: ["555", "555 timer", "timer", "NE555P", "astable", "monostable"],
  description:
    "Precision timer, PDIP-8 (TI NE555): timing from microseconds to hours, astable or monostable, the period and duty cycle set by the resistors and capacitor wired to it; CONT moves both thresholds (2/3 and 1/3 VCC). 4.5–16 V; the output sinks or sources up to 200 mA. No settings: select it while running to read frequency, period and duty.",
  category: "ics",
  icon: TimerIcon,
  prefix: "U",
  width: W,
  height: H,
  pins: PINS,
  body: [
    { type: "rect", x: 1, y: 1, w: W - 2, h: H - 2, rx: 0.2, fill: "board" },
    { type: "text", x: 5.4, y: 4, text: "NE555", size: 0.4 },
    { type: "text", x: 5.4, y: 4.7, text: "timer", size: 0.22, muted: true },
    { type: "text", x: W - 1.4, y: 1.3, text: "{ref}", size: 0.26, muted: true, anchor: "end" },
    ...pinNumbers(PINS),
  ],
  parts: [],
  model: [
    {
      kind: "TMR",
      vcc: "VCC",
      gnd: "GND",
      trig: "TRIG",
      thres: "THRES",
      ctrl: "CTRL",
      lo: "$lo",
      reset: "RESET",
      out: "OUT",
      dis: "DIS",
      limits: { voltage: NE555.absolute, current: NE555.current, power: NE555.power, tau: 1, fail: "short" },
    },
    { kind: "R", a: "VCC", b: "CTRL", value: NE555.divider, hidden: true },
    { kind: "R", a: "CTRL", b: "$lo", value: NE555.divider, hidden: true },
    { kind: "R", a: "$lo", b: "GND", value: NE555.divider, hidden: true },
    { kind: "D", anode: "GND", cathode: "VCC", vf: 0.7, hidden: true, limits: { current: 0.05, fail: "short" } },
  ],
  info: { Package: "PDIP-8", Source: "TI NE555 datasheet SLFS022K (2026), typical characteristics at 25 °C" },
}

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [ne555]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "ne555": {
    maker: "Texas Instruments",
    package: "PDIP-8",
    docs: [DOCS["ti-slfs022k"]],
    specs: [
      { label: "Supply", value: "4.5–16 V (18 V abs max)", cite: { page: 4, at: "§5.3 Recommended Operating Conditions; §5.1" } },
      { label: "Output current", value: "±200 mA (±225 mA abs max)", cite: { page: 4, at: "§5.3 Recommended Operating Conditions; §5.1" } },
      { label: "Thresholds", value: "2/3 and 1/3 VCC: 3.3 V / 1.67 V at 5 V", cite: { page: 5, at: "§5.5 Electrical Characteristics" } },
      { label: "Output high", value: "VCC − 1.7 V at 100 mA (13.3 V at 15 V)", cite: { page: 6, at: "§5.5 Electrical Characteristics" } },
      { label: "Supply current", value: "3 mA at 5 V, 10 mA at 15 V (output low, no load)", cite: { page: 6, at: "§5.5 Electrical Characteristics" } },
      { label: "Timing range", value: "10 µs to hours; < 1 mHz to 100 kHz", cite: { page: 10, at: "§6.1 Overview" } },
    ],
    modelled: [
      { what: "Thresholds at 2/3, 1/3 VCC", cite: { page: 5, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ne555.test.ts" },
      { what: "CONT drive moves both thresholds", cite: { page: 3, at: "Table 4-1" }, test: "tests/sim/ne555.test.ts" },
      { what: "Supply current per the table", cite: { page: 6, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ne555.test.ts" },
      { what: "Sink voltage per Figures 5-1–5-3", cite: { page: 8, at: "Figures 5-1 to 5-3" }, test: "tests/sim/ne555.test.ts" },
      { what: "Darlington drop below VCC", cite: { page: 8, at: "Figure 5-4" }, test: "tests/sim/ne555.test.ts" },
      { what: "DISCH saturates at 0.15 V", cite: { page: 5, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ne555.test.ts" },
      { what: "Low RESET forces output low", cite: { page: 5, at: "§5.5 Electrical Characteristics" }, test: "tests/sim/ne555.test.ts" },
      { what: "Astable timing independent of VCC", cite: { page: 12, at: "§6.3.2 Astable Operation" }, test: "tests/sim/ne555.test.ts" },
      { what: "Monostable pulse, not retriggerable", cite: { page: 11, at: "§6.3.1 Monostable Operation" }, test: "tests/sim/ne555.test.ts" },
      { what: "Dies past 18 V", cite: { page: 4, at: "§5.1, §5.3" }, test: "tests/sim/ne555.test.ts" },
      { what: "Shorted output destroys it", cite: { page: 4, at: "§5.1, §5.3" }, test: "tests/sim/ne555.test.ts" },
      { what: "Reversed supply fails short", test: "tests/sim/ne555.test.ts" },
    ],
    notModelled: [
      { what: "Typical values, not min–max", cite: { page: 5, at: "§5.5 Electrical Characteristics" } },
      { what: "Rise, fall and propagation delay", cite: { page: 7, at: "§5.6 Switching Characteristics" } },
      { what: "10 µs comparator storage time", cite: { page: 11, at: "§6.3.1 Monostable Operation" } },
      { what: "Temperature drift and curves", cite: { page: 7, at: "§5.6 Switching Characteristics" } },
      { what: "Timing's supply-voltage sensitivity", cite: { page: 7, at: "§5.6 Switching Characteristics" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
