import { BatteryIcon } from "../icons"
import { dw03, mt3608, tp4056 } from "../power-model"
import { parseValue } from "@/sim/units"
import { LED_COLORS } from "./basic"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef } from "../types"


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
  description:
    "TP4056 Li-ion charger (1 A from USB-C or IN+, trickle below 2.9 V, stops at C/10), DW03 protection (4.3 V, 2.4 V, 3.5 A, short) and an MT3608 boost to the output set by the trimmer (4.2–28 V).",
  category: "Power",
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
  info: {
    Charger: "TP4056, 1 A (R_PROG 1.2 kΩ), 4.2 V ±1 %, trickle 100 mA below 2.9 V, ends at 100 mA, recharges at 4.05 V",
    Protection: "DW03: overcharge 4.3 V, over-discharge 2.4 V, overcurrent 3.5 A, short circuit 20 A, 40 mΩ",
    Boost: "MT3608, 4.2–28 V by the trimmer, ~2 A from the cell (5 W)",
    Input: "USB-C or IN+/IN−, 4.5–6.5 V",
    Size: "23.5 × 19 mm",
    Source: "Datasheets: TP4056 (NanJing Top Power), DW03 (PJSEMI), MT3608 (Aerosemi)",
  },
}
