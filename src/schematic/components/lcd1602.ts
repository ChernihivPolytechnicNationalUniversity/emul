/**
 * 16 × 2 character LCD modules (`src/sim/hd44780.ts` holds the controller, the glass and their
 * sources): the 16-pin parallel module, and the same module on the common PCF8574 I²C backpack.
 *
 * Electrical face: the Vishay LCD-016M002B's supply (4.7–5.3 V, 1.2 mA typical, 7 V absolute),
 * the controller's inputs (Hitachi: VCC + 0.3 V absolute, pull-up MOS current 125 µA typical at
 * 5 V on DB0–DB7, RS and R/W — 40 kΩ from 5 V — none on E; DB outputs VOL 0.4 V at 1.2 mA), the
 * backlight LED (Vishay edge-lit: VF 4.2 V typical at 20 mA, 40 mA maximum) behind the 100 Ω R8
 * that "almost all" eBay 1602 modules carry (forum.arduino.cc; Vishay's own module has none).
 */
import { CharacterLcdIcon } from "../icons"
import type { BodyShape, ComponentDef, ModelElement as Element, PinDef } from "../types"

const W = 20
const H = 9

/** The backlight LED: VF 4.2 V at 20 mA (Vishay), the engine's default emission for the curve's shape. */
const BACKLIGHT_EMISSION = 1.8
const BACKLIGHT_VJ10 = 4.2 - BACKLIGHT_EMISSION * 0.025852 * Math.log(2)
const BACKLIGHT_LIMITS = { current: 0.04, fail: "open" } as const

/** 5 V at the 1.2 mA typical supply current. */
const MODULE_LOAD = 5 / 1.2e-3

const CONTROLLER_INPUT = { aboveSupply: 0.3, voltage: 7, fail: "short" } as const

const GLASS_FIELDS = [
  { key: "glass", label: "Glass", type: "select" as const, options: [{ value: "blue", label: "Blue (negative, transmissive)" }, { value: "yellow-green", label: "Yellow-green (positive)" }] },
  { key: "temp", label: "Ambient temperature", type: "range" as const, min: 0, max: 50, step: 1, unit: "°C" },
]

const screenBody = (w: number, h: number): BodyShape[] => [
  { type: "rect", x: 0.5, y: 1.4, w: w - 1, h: h - 1.9, rx: 0.3, fill: "board" },
  { type: "rect", x: 1.6, y: 2.6, w: w - 3.2, h: h - 4.4, rx: 0.15, fill: "chip" },
  { type: "text", x: w - 0.6, y: 0.35, text: "{ref}", size: 0.32, muted: true, anchor: "end" },
]

const backlight = (a: string, k: string): Element[] => [
  { kind: "R", a, b: "$r8", value: 100, label: "R8 backlight resistor" },
  { kind: "D", anode: "$r8", cathode: k, vf: BACKLIGHT_VJ10, emission: BACKLIGHT_EMISSION, part: "BL", label: "Backlight LED", limits: BACKLIGHT_LIMITS },
]

const PARALLEL_PINS: { id: string; label: string; note: string; kind?: PinDef["kind"] }[] = [
  { id: "VSS", label: "VSS", note: "Ground", kind: "gnd" },
  { id: "VDD", label: "VDD", note: "+5 V (4.7–5.3 V), 1.2 mA typical; 7 V absolute", kind: "power" },
  { id: "V0", label: "V0", note: "Contrast: VDD − V0 of 4.2 V (3.8–4.6 V) at 25 °C", kind: "analog" },
  { id: "RS", label: "RS", note: "Register select: 0 instruction, 1 data; 125 µA pull-up" },
  { id: "RW", label: "R/W", note: "0 write, 1 read; 125 µA pull-up" },
  { id: "E", label: "E", note: "Enable: data latched on the falling edge; no pull-up" },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ id: `D${i}`, label: `D${i}`, note: `Data bus bit ${i}${i < 4 ? " (unused in 4-bit mode)" : ""}; 125 µA pull-up` })),
  { id: "A", label: "A", note: "Backlight anode, through the module's 100 Ω R8" },
  { id: "K", label: "K", note: "Backlight cathode", kind: "gnd" },
]

const parallelPins: PinDef[] = PARALLEL_PINS.map((p, k) => ({ id: p.id, label: p.label, x: 2 + k, y: 0, side: "top", labelAt: "bottom", kind: p.kind ?? "digital", connector: "16-pin header", connectorPin: k + 1, note: p.note }))

export const lcd1602: ComponentDef = {
  id: "lcd-1602",
  name: "LCD 1602 (HD44780)",
  description:
    "16 × 2 character LCD, HD44780-compatible controller, 8- or 4-bit parallel bus. Initialise it by instruction, wait out the busy flag (an instruction sent while busy is lost), and set V0 for VDD − V0 ≈ 4.2 V — at 5 V on V0's pot, with V0 on ground the unlit dots darken, and the module is blank on 3.3 V.",
  category: "Displays",
  keywords: ["LCD", "1602", "16x2", "HD44780", "character", "KS0066", "ST7066", "LCD1602"],
  icon: CharacterLcdIcon,
  prefix: "DS",
  width: W,
  height: H,
  defaults: { glass: "blue", temp: "25" },
  fields: GLASS_FIELDS,
  pins: parallelPins,
  body: screenBody(W, H),
  parts: [{ type: "screen", id: "GLASS", label: "Display", x: 2, y: 3, w: W - 4, h: H - 5.2, backlight: "BL" }],
  model: [
    { kind: "R", a: "VDD", b: "VSS", value: MODULE_LOAD, label: "Module supply", limits: { voltage: 7, fail: "short" } },
    ...["RS", "RW", "E", "V0"].map((node): Element => ({ kind: "GPIO", node, vddNode: "VDD", gndNode: "VSS", limits: CONTROLLER_INPUT })),
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): Element => ({ kind: "GPIO", node: `D${i}`, vddNode: "VDD", gndNode: "VSS", drive: { ohms: 0.4 / 1.2e-3 }, limits: CONTROLLER_INPUT })),
    ...["RS", "RW", "D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"].map((node): Element => ({ kind: "R", a: "VDD", b: node, value: 5 / 125e-6, hidden: true, label: `${node} pull-up` })),
    ...backlight("A", "K"),
  ],
  info: { Source: "Hitachi HD44780U ADE-207-272(Z); Sitronix ST7066U (clear display time); Vishay LCD-016M002B (doc 37217, 01-Oct-02); R8: forum.arduino.cc" },
}

const I2C_W = 20
const I2C_H = 9

export const lcd1602I2c: ComponentDef = {
  id: "lcd-1602-i2c",
  name: "LCD 1602 with I²C backpack",
  description:
    "The 16 × 2 module on a PCF8574 backpack: P0 RS, P1 R/W, P2 E, P3 backlight, P4–P7 D4–D7, so the controller runs in 4-bit mode. Address 0x27 (0x3F with a PCF8574AT), A0–A2 pads open; 4.7 kΩ pull-ups on SDA and SCL to VCC; 100 kHz. If the glass is blank or shows blocks, turn the contrast pot.",
  category: "Displays",
  keywords: ["LCD", "1602", "16x2", "I2C", "IIC", "PCF8574", "backpack", "HD44780", "LCD1602", "0x27", "0x3F"],
  icon: CharacterLcdIcon,
  prefix: "DS",
  width: I2C_W,
  height: I2C_H,
  defaults: { glass: "blue", temp: "25", chip: "PCF8574T", a0: "open", a1: "open", a2: "open", contrast: "16", jumper: "fitted" },
  derive: (props) => ({ address: `0x${((props.chip === "PCF8574AT" ? 0x38 : 0x20) | (props.a0 === "bridged" ? 0 : 1) | (props.a1 === "bridged" ? 0 : 2) | (props.a2 === "bridged" ? 0 : 4)).toString(16).toUpperCase()}` }),
  fields: [
    { key: "contrast", label: "Contrast pot (wiper from ground)", type: "range", min: 0, max: 100, step: 1, unit: "%" },
    { key: "chip", label: "Expander", type: "select", options: [{ value: "PCF8574T", label: "PCF8574T · 0x20–0x27" }, { value: "PCF8574AT", label: "PCF8574AT · 0x38–0x3F" }] },
    ...(["a0", "a1", "a2"] as const).map((k) => ({ key: k, label: `${k.toUpperCase()} pad`, type: "select" as const, options: [{ value: "open", label: "Open (1)" }, { value: "bridged", label: "Bridged (0)" }] })),
    { key: "jumper", label: "Backlight jumper", type: "select", options: [{ value: "fitted", label: "Fitted" }, { value: "removed", label: "Removed" }] },
    ...GLASS_FIELDS,
  ],
  pins: [
    { id: "GND", label: "GND", x: 0, y: 3, side: "left", labelAt: "right", kind: "gnd" },
    { id: "VCC", label: "VCC", x: 0, y: 4, side: "left", labelAt: "right", kind: "power", note: "+5 V for the module; the PCF8574 takes 2.5–6 V, 7 V absolute" },
    { id: "SDA", label: "SDA", x: 0, y: 5, side: "left", labelAt: "right", kind: "digital", note: "4.7 kΩ pull-up to VCC on the backpack" },
    { id: "SCL", label: "SCL", x: 0, y: 6, side: "left", labelAt: "right", kind: "digital", note: "4.7 kΩ pull-up to VCC on the backpack; 100 kHz maximum" },
  ],
  body: [
    ...screenBody(I2C_W, I2C_H),
    { type: "text", x: 1.2, y: I2C_H - 0.35, text: "PCF8574 · {address}", size: 0.28, muted: true, anchor: "start" },
  ],
  parts: [{ type: "screen", id: "GLASS", label: "Display", x: 2, y: 3, w: I2C_W - 4, h: I2C_H - 5.2, backlight: "BL" }],
  model: [
    { kind: "R", a: "VCC", b: "GND", value: MODULE_LOAD, label: "Module supply", limits: { voltage: 7, fail: "short" } },
    // The contrast pot (10 kΩ on the boards; the schematic prints no value): VCC to ground, V0 on the wiper.
    { kind: "R", a: "VCC", b: "$v0", value: (p) => Math.max(1, 10e3 * (1 - Number(p.contrast ?? 16) / 100)), hidden: true, label: "Contrast pot, upper" },
    { kind: "R", a: "$v0", b: "GND", value: (p) => Math.max(1, (10e3 * Number(p.contrast ?? 16)) / 100), hidden: true, label: "Contrast pot, lower" },
    { kind: "GPIO", node: "SDA", vddNode: "VCC", gndNode: "GND", drive: { ohms: 0.4 / 3e-3 }, limits: { aboveSupply: 0.5, voltage: 7, fail: "short" } },
    { kind: "GPIO", node: "SCL", vddNode: "VCC", gndNode: "GND", limits: { aboveSupply: 0.5, voltage: 7, fail: "short" } },
    { kind: "R", a: "VCC", b: "SDA", value: 4.7e3, label: "SDA pull-up" },
    { kind: "R", a: "VCC", b: "SCL", value: 4.7e3, label: "SCL pull-up" },
    { kind: "R", a: "VCC", b: "$a", value: (p) => (p.jumper === "removed" ? 1e12 : 1e-3), hidden: true, label: "Backlight jumper" },
    ...backlight("$a", "$k"),
    { kind: "R", a: "$k", b: "GND", value: 1e9, live: "$bl", label: "Backlight transistor (8050)" },
  ],
  info: { Source: "NXP PCF8574/74A Rev. 5; TI SCPS068K; backpack schematic as playembedded.org redraws it; module as LCD 1602" },
}

export const lcdModules: ComponentDef[] = [lcd1602, lcd1602I2c]
