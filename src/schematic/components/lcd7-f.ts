import { DisplayIcon } from "../icons"
import type { BodyShape, ComponentDef, Element, PanelSignal, PinDef } from "../types"

/**
 * Waveshare 7inch Capacitive Touch LCD (F): a 1024 × 600 panel on a 24-bit parallel RGB
 * interface with a GT911 touch controller on I²C, on a 40-pin 0.5 mm FFC. The FFC is drawn as
 * a tail of two rows of twenty (1–20 above 21–40) sticking four cells out of the top edge, the
 * same two rows as the Open746I-C's P15, so the module docks onto the board's FFC (pins
 * touching conduct) or is wired line by line. The picture comes from the LTDC of whichever MCU drives
 * the pixel clock (`src/sim/display.ts`); the GT911 lives in `src/sim/digital.ts`.
 * Scale: 1 cell = 2.54 mm; the module is 165 × 100 mm ≈ 65 × 40 cells, the glass 154 × 86 mm.
 */

const W = 65
const H = 40
/** First FFC pin's column: the module hangs centred under the board when its P15 is at 35. */
const FFC_X = 32

/** [pin, label, signal on the panel, note] */
type Row = [number, string, PanelSignal | "5V" | "GND" | "3V3" | "DISP" | "BL" | "SDA" | "SCL" | "RST" | "INT", string?]
const FFC: Row[] = [
  [1, "5V", "5V", "Unused as shipped (R6 not fitted: the backlight boost runs from 3.3 V)"],
  [2, "5V", "5V"],
  [3, "GND", "GND"],
  [4, "3V3", "3V3", "Panel logic, AVDD boost and the GT911"],
  ...(["R", "G", "B"] as const).flatMap((c, ci) => Array.from({ length: 8 }, (_, i): Row => [5 + ci * 8 + i, `${c}${i}`, `${c}${i}` as PanelSignal])),
  [29, "GND", "GND"],
  [30, "CLK", "CLK", "Pixel clock"],
  [31, "DISP", "DISP", "Backlight enable (100 kΩ pull-down on the module); the board ties it to 3.3 V"],
  [32, "HS", "HS", "Horizontal sync"],
  [33, "VS", "VS", "Vertical sync"],
  [34, "DE", "DE", "Data enable"],
  [35, "BL", "BL", "Backlight PWM (10 kΩ pull-down: off when left open)"],
  [36, "GND", "GND"],
  [37, "SDA", "SDA", "GT911 I²C data, 10 kΩ pull-up on the module"],
  [38, "SCL", "SCL", "GT911 I²C clock, 10 kΩ pull-up"],
  [39, "RST", "RST", "GT911 reset, active low"],
  [40, "INT", "INT", "GT911 interrupt out (input during reset: low selects address 0x5D)"],
]

const pins: PinDef[] = FFC.map(([pin, label, , note]) => ({
  id: String(pin),
  label,
  x: FFC_X + ((pin - 1) % 20),
  y: pin <= 20 ? -4 : -3,
  side: "top",
  labelAt: pin <= 20 ? "top" : "bottom",
  kind: label === "GND" ? "gnd" : label === "5V" || label === "3V3" ? "power" : "digital",
  stub: pin <= 20 ? 3 : 4,
  connector: "FFC",
  connectorPin: pin,
  note,
}))

const signals: Record<string, PanelSignal> = {}
for (const [pin, , sig] of FFC) if (/^[RGB]\d$|^(CLK|HS|VS|DE)$/.test(sig)) signals[String(pin)] = sig as PanelSignal

const body: BodyShape[] = [
  // The module: glass with its bezel, the FFC tail out of the top edge, the name along the bottom.
  { type: "rect", x: 0, y: 0, w: W, h: H, rx: 0.5, fill: "chip" },
  { type: "rect", x: FFC_X - 0.5, y: -5.1, w: 20, h: 5.6, rx: 0.3, fill: "connector" },
  { type: "text", x: W / 2, y: 38.6, text: "7inch Capacitive Touch LCD (F) · 1024 × 600 · 24-bit RGB · GT911", size: 0.42, inverse: true },
  { type: "text", x: W - 2, y: 1.9, text: "{ref}", size: 0.36, inverse: true, anchor: "end" },
]

/** Absolute maximum on the panel's and the GT911's 3.3 V inputs. */
const INPUT = { voltage: 4, fail: "open" } as const
const GND = "3"
const V33 = "4"

const model: Element[] = [
  { kind: "SHORT", nodes: ["1", "2"] },
  { kind: "SHORT", nodes: ["3", "29", "36"] },
  // Panel logic plus the AVDD/VGH/VGL boosts: ~100 mA from 3.3 V.
  { kind: "R", a: V33, b: GND, value: 33, limits: { voltage: 4, fail: "short" } },
  // Backlight: the PT4103 boost runs from 3.3 V (R5 fitted, R6 to 5 V not) and is enabled by
  // DISP, which the module pulls down with 100 kΩ and the board ties to 3.3 V. The LED string
  // is ~0.8 W, ~0.25 A at the 3.3 V pin. The PWM pin only trims the current through an RC
  // into the feedback node (full brightness with it low, ~55 % high): left at full here.
  { kind: "R", a: "31", b: GND, value: 100e3 },
  { kind: "R", a: "35", b: GND, value: 10e3 },
  { kind: "R", a: V33, b: "$bl", value: 2.4, limits: { voltage: 6, fail: "open" } },
  { kind: "D", anode: "$bl", cathode: "$bld", vf: 2.5, part: "BL", limits: { current: 0.6 } },
  { kind: "M", polarity: "nmos", g: "31", d: "$bld", s: GND, vth: 1.2, k: 1, limits: { voltage: 20, current: 1 } },
  // GT911: its pull-ups, the open-drain bus, INT out and RST in.
  { kind: "R", a: "37", b: V33, value: 10e3 },
  { kind: "R", a: "38", b: V33, value: 10e3 },
  { kind: "R", a: "40", b: V33, value: 10e3 },
  { kind: "GPIO", node: "37", vdd: 3.3, limits: INPUT },
  { kind: "GPIO", node: "38", vdd: 3.3, limits: INPUT },
  { kind: "GPIO", node: "39", vdd: 3.3, limits: INPUT },
  { kind: "R", a: "39", b: GND, value: 10e6, hidden: true },
  { kind: "GPIO", node: "40", vdd: 3.3, limits: INPUT },
  // The RGB and sync inputs of the panel, with their input leakage (what makes the nets solvable).
  ...Object.keys(signals).flatMap((pin): Element[] => [
    { kind: "GPIO", node: pin, vdd: 3.3, limits: INPUT },
    { kind: "R", a: pin, b: GND, value: 10e6, hidden: true },
  ]),
]

export const lcd7f: ComponentDef = {
  id: "lcd7-f",
  name: "7inch LCD (F)",
  description: "1024×600 RGB, GT911 touch",
  category: "Displays",
  icon: DisplayIcon,
  prefix: "LCD",
  width: W,
  height: H,
  body,
  pins,
  parts: [
    { type: "led", id: "BL", label: "", x: W / 2, y: H / 2, color: "#ffffff", style: "glow" },
    { type: "display", id: "PANEL", label: "Panel", x: 3.5, y: 2.6, w: 58, h: 34, width: 1024, height: 600, backlight: "BL" },
  ],
  model,
  hideIdle: true,
  panel: { part: "PANEL", width: 1024, height: 600, signals, pixelHz: [25e6, 75e6], power: V33 },
  info: {
    Panel: "1024 × 600, 24-bit parallel RGB (DE mode; HS/VS/DE polarity not checked), pixel clock 25–75 MHz",
    Touch: "GT911, I²C address 0x5D (0x14 with INT high at reset), 16-bit registers: 0x8140 product ID, 0x814E status, 0x814F… points",
    Backlight: "PT4103 boost from the 3.3 V pin (~0.25 A), enabled by DISP; PWM trims the current on the real module, full here",
    Connector: "40-pin 0.5 mm FFC as two rows of twenty (1–20 above 21–40), the same rows as the Open746I-C's P15: dock the module under the board or wire the lines",
    Source: "Waveshare 7inch-Capacitive-Touch-LCD-F schematic (GT911 version)",
  },
}
