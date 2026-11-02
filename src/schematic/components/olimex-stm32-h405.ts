import { STM32F405RG } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind } from "../types"
import { LED_COLORS } from "./basic"

/**
 * Olimex STM32-H405, Rev. C (STM32F405RGT6). Sources (docs/olimex-h405/board-checklist.md): the
 * user manual (rev B, 2016), the Rev. C schematic and the Rev. C dimension drawing (mil).
 *
 * Scale: 1 cell = 2.54 mm. The board is 60.96 × 34.29 mm with the USB-B sticking out 6.86 mm on
 * the left; it sits at (3.25, 0.75) cells so that the 0.1" headers EXT1 (bottom edge) and EXT2
 * (top edge) fall on whole cells. The headers are male pins under the board; seen from the top.
 */

const ORIGIN = { x: 3.25, y: 0.75 }
const at = (xMm: number, yMm: number) => ({ x: ORIGIN.x + xMm / 2.54, y: ORIGIN.y + yMm / 2.54 })
const BOARD_MM = { w: 60.96, h: 34.29 }

/** [pin, label, MCU pin, note] — UM §6.3.1/§6.3.2, checked against the schematic. */
type Row = [number, string, string?, string?]

const EXT1: Row[] = [
  [1, "PA11", "PA11", "USB D− (22 Ω)"], [2, "PA8", "PA8"], [3, "PA12", "PA12", "USB D+ (22 Ω)"], [4, "PA9", "PA9", "Not VBUS on this board"],
  [5, "3.3V"], [6, "GND"], [7, "PA10", "PA10"], [8, "PC10", "PC10"],
  [9, "PC11", "PC11", "DISC: low with VBUS present switches 1.5 kΩ onto D+"], [10, "PC12", "PC12", "STAT LED (lit when low)"],
  [11, "PD2", "PD2"], [12, "PB5", "PB5"], [13, "PB6", "PB6"], [14, "PA6", "PA6"],
  [15, "PB7", "PB7"], [16, "PB8", "PB8"], [17, "PB9", "PB9"], [18, "PA5", "PA5"],
  [19, "PC0", "PC0"], [20, "PC1", "PC1"], [21, "PB0", "PB0"], [22, "PA7", "PA7"],
  [23, "VBAT", undefined, "Jumpered to 3.3V (VBAT solder jumper closed)"], [24, "PC13", "PC13"], [25, "RST", "NRST"], [26, "PB1", "PB1"],
]
const EXT2: Row[] = [
  [1, "VDDA", undefined, "3.3V through the ferrite L1"], [2, "PC2", "PC2"], [3, "AGND"], [4, "PA0", "PA0", "BUT (560 Ω, 10 kΩ pull-up; low when pressed)"],
  [5, "3.3V"], [6, "GND"], [7, "PA2", "PA2"], [8, "PA1", "PA1"],
  [9, "PC3", "PC3"], [10, "PA3", "PA3"], [11, "PA4", "PA4"], [12, "PC4", "PC4", "USB_P: VBUS through 15k/22k (USBP_E closed)"],
  [13, "PC5", "PC5"], [14, "PB10", "PB10"], [15, "PB11", "PB11"], [16, "PB13", "PB13"],
  [17, "PB12", "PB12"], [18, "PB14", "PB14"], [19, "PB15", "PB15"], [20, "PC6", "PC6"],
  [21, "PC7", "PC7"], [22, "PC8", "PC8"], [23, "+5V_USB", undefined, "Raw USB VBUS, before D1"], [24, "PC9", "PC9"],
  [25, "GND"], [26, "VIN", undefined, "Regulator input, no reverse-polarity diode"],
]

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "GND" || label === "AGND") return "gnd"
  if (/^(3\.3V|VDDA|VBAT|\+5V_USB|VIN)$/.test(label)) return "power"
  return mcu ? "digital" : "nc"
}

const WIDTH = 28
const HEIGHT = 15

/**
 * Pad centres in mil (DIM): EXT2 odd x = 1875 − 50(n−1) at y 225, even x = 1875 − 50(n−2) at y 125;
 * EXT1 odd x = 675 + 50(n−1) at y 1125, even x = 675 + 50(n−2) at y 1225.
 */
function header(connector: "EXT1" | "EXT2", rows: Row[]): PinDef[] {
  return rows.map(([pin, label, mcu, note]) => {
    const odd = pin % 2 === 1
    const k = odd ? pin - 1 : pin - 2
    const mil = connector === "EXT2" ? { x: 1875 - 50 * k, y: odd ? 225 : 125 } : { x: 675 + 50 * k, y: odd ? 1125 : 1225 }
    const p = at(mil.x * 0.0254, mil.y * 0.0254)
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    const top = connector === "EXT2"
    return {
      id: `${connector}-${pin}`,
      label,
      x,
      y,
      side: top ? "top" : "bottom",
      labelAt: top ? (odd ? "bottom" : "top") : odd ? "top" : "bottom",
      kind: kindOf(label, mcu),
      stub: top ? y : HEIGHT - y,
      mcu,
      connector,
      connectorPin: pin,
      note,
    } satisfies PinDef
  })
}

const pins: PinDef[] = [...header("EXT2", EXT2), ...header("EXT1", EXT1)]

const corner = at(0, 0)
const u1 = at(30.48, 17.145)
const q1 = at(45.8, 18.4)
const vr = at(4.85, 4.45)
const usb = at(-6.86, 11.1)
const jtag = at(52.1, 0.7)

const body: BodyShape[] = [
  { type: "rect", x: corner.x, y: corner.y, w: BOARD_MM.w / 2.54, h: BOARD_MM.h / 2.54, rx: 0.15, fill: "board" },
  // USB-B (AMP 787616-1), 6.86 mm past the left edge.
  { type: "rect", x: usb.x, y: usb.y, w: 16.5 / 2.54, h: 12.2 / 2.54, rx: 0.15, fill: "connector" },
  // VR LM1117 (SOT-223), U1 STM32F405RGT6 (LQFP64, 10 × 10 mm, pin 1 bottom-right), Q1 8 MHz HC-49 upright.
  { type: "rect", x: vr.x - 1.2, y: vr.y - 1.2, w: 2.4, h: 2.4, rx: 0.1, fill: "chip" },
  { type: "text", x: vr.x, y: vr.y + 2, text: "VR", size: 0.35, printed: true },
  { type: "rect", x: u1.x - 1.97, y: u1.y - 1.97, w: 3.94, h: 3.94, rx: 0.1, fill: "chip" },
  { type: "text", x: u1.x, y: u1.y - 0.2, text: "STM32F405", size: 0.36, inverse: true },
  { type: "text", x: u1.x, y: u1.y + 0.5, text: "RGT6", size: 0.3, inverse: true },
  { type: "rect", x: q1.x - 1, y: q1.y - 2.3, w: 2, h: 4.6, rx: 0.9, fill: "connector" },
  { type: "text", x: q1.x, y: q1.y + 0.1, text: "8.000", size: 0.3, muted: true, rotate: -90 },
  // 20-pin JTAG box header on the right edge.
  { type: "rect", x: jtag.x, y: jtag.y, w: 8.8 / 2.54, h: 33 / 2.54, rx: 0.15, fill: "connector" },
  { type: "text", x: jtag.x + 1.7, y: jtag.y + 6.5, text: "JTAG", size: 0.4, muted: true, rotate: -90 },
  // Silkscreen.
  // Silkscreen, moved off the header rows the field labels: the address up the gap between Q1 and JTAG.
  { type: "text", x: at(50.4, 0).x, y: at(0, 18).y, text: "WWW.OLIMEX.COM (C) 2013", size: 0.28, printed: true, rotate: -90 },
  { type: "text", x: at(30.5, 0).x, y: at(0, 23.2).y, text: "STM32-H405 Rev. C", size: 0.28, printed: true },
  { type: "text", x: at(15.4, 0).x, y: at(0, 4.6).y, text: "EXT2", size: 0.3, muted: true, anchor: "end" },
  { type: "text", x: at(15.4, 0).x, y: at(0, 30.1).y, text: "EXT1", size: 0.3, muted: true, anchor: "end" },
]

const parts: PartDef[] = [
  { type: "led", id: "PWR", label: "PWR", ...at(3.56, 28.1), color: LED_COLORS.red.css },
  { type: "led", id: "STAT", label: "STAT", ...at(3.56, 31.75), color: LED_COLORS.green.css, mcu: "PC12", pin: "EXT1-10" },
  { type: "button", id: "BUT", label: "BUT", ...at(15.24, 21.21), mcu: "PA0", pin: "EXT2-4" },
  { type: "button", id: "RESET", label: "RESET", ...at(15.24, 12.45), size: 1.1, mcu: "NRST", pin: "EXT1-25" },
  { type: "usb", id: "USB", label: "USB", ...at(-6.86, 17.145), side: "left", initial: { on: true } },
]

// --- electrical model ---------------------------------------------------------

const GND = "EXT1-6"
const V33 = "EXT1-5"
const VIN = "EXT2-26"
const V5USB = "EXT2-23"
const NRST = "EXT1-25"

/**
 * D1 1N5819S: about 0.18 V at 10 mA, read off Vishay doc 88525 Fig. 3 (the tables start at 0.1 A; no
 * datasheet covers the "S" variant). VR LM1117-ADJ (TI SNOS412Q Table 7.5): VREF 1.25 V, adjust-pin
 * current 60 µA through R9, so VOUT = 1.25 × (1 + 390/240) + 60 µA × 390 Ω ≈ 3.30 V; dropout 1.1 V at
 * 100 mA; current limit 1.2 A typical.
 */
const D1_VF = 0.18
const LM1117 = { vout: 1.25 * (1 + 390 / 240) + 60e-6 * 390, dropout: 1.1, imax: 1.2 }

const model: Element[] = [
  { kind: "SHORT", nodes: [GND, "EXT2-6", "EXT2-25", "EXT2-3"] },
  { kind: "GND", node: GND },
  { kind: "SHORT", nodes: [V33, "EXT2-5", "EXT2-1", "EXT1-23"] },
  // USB VBUS (a USB 2.0 host port, 500 mA) → +5V_USB → D1 → VIN → LM1117 → 3.3V. EXT2-26 feeds VIN directly.
  { kind: "V", plus: "$usb", minus: GND, value: 5 },
  { kind: "SW", a: "$usb", b: "$usbsw", part: "USB", closed: "on" },
  { kind: "REG", in: "$usbsw", out: V5USB, gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "D", anode: V5USB, cathode: VIN, vf: D1_VF },
  { kind: "REG", in: VIN, out: V33, gnd: GND, value: LM1117.vout, dropout: LM1117.dropout, imax: LM1117.imax },
  // PWR: 3.3V → LED → R7 2 kΩ → GND. STAT: 3.3V → LED → R4 2 kΩ → LED_E (closed) → PC12. Colours:
  // STAT green (schematic "led0603/green"), PWR red (UM §5.3); no part numbers, so the palette's forward voltages.
  { kind: "D", anode: V33, cathode: "$pwrk", vf: LED_COLORS.red.vf, part: "PWR" },
  { kind: "R", a: "$pwrk", b: GND, value: 2e3 },
  { kind: "D", anode: V33, cathode: "$statk", vf: LED_COLORS.green.vf, part: "STAT" },
  { kind: "R", a: "$statk", b: "EXT1-10", value: 2e3 },
  // BUT: R18 10 kΩ from 3.3V to the node, switch and C18 100 nF to GND, R19 560 Ω to PA0.
  { kind: "R", a: V33, b: "$but", value: 10e3 },
  { kind: "SW", a: "$but", b: GND, part: "BUT", closed: "pressed" },
  { kind: "C", a: "$but", b: GND, value: 100e-9 },
  { kind: "R", a: "$but", b: "EXT2-4", value: 560 },
  // RESET: R8 10 kΩ pull-up, C19 100 nF, switch to GND.
  { kind: "R", a: NRST, b: V33, value: 10e3 },
  { kind: "C", a: NRST, b: GND, value: 100e-9 },
  { kind: "SW", a: NRST, b: GND, part: "RESET", closed: "pressed" },
  // USB_P: +5V_USB → R1 15 kΩ → node → R29 22 kΩ → GND; USBP_E closed → PC4.
  { kind: "R", a: V5USB, b: "EXT2-12", value: 15e3 },
  { kind: "R", a: "EXT2-12", b: GND, value: 22e3 },
  // JTAG pull-ups, 10 kΩ to 3.3V on TMS PA13, TCK PA14, TDI PA15, TDO PB3, TRST PB4 (none reaches a header).
  ...["$PA13", "$PA14", "$PA15", "$PB3", "$PB4"].map((pad): Element => ({ kind: "R", a: pad, b: V33, value: 10e3 })),
  // BOOT1 (PB2) through R28 33 kΩ to GND (B1_L). PB2 reaches no header.
  { kind: "R", a: "$PB2", b: GND, value: 33e3 },
  ...mcuModel(STM32F405RG, { vdd: V33, gnd: GND, nrst: NRST, pads: ["$PA13", "$PA14", "$PA15", "$PB3", "$PB4", "$PB2", ...pins.filter((p) => p.mcu && p.mcu !== "NRST").map((p) => p.id)] }),
]

export const olimexStm32H405: ComponentDef = {
  id: "olimex-stm32-h405",
  name: "Olimex STM32-H405",
  description: "STM32F405RG",
  category: "Boards",
  icon: BoardIcon,
  prefix: "U",
  width: WIDTH,
  height: HEIGHT,
  body,
  pins,
  parts,
  model,
  hideIdle: true,
  pinsAreSockets: true,
  chip: STM32F405RG.id,
  mcuPower: V33,
  mcuReset: NRST,
  mcuVbat: "EXT1-23",
  // Q1 8 MHz crystal (C12/C13 27 pF) and Q2 32.768 kHz crystal under the board; startup DS8626 Tables 32/33.
  mcuClocks: { hse: { hz: 8e6, kind: "crystal", startup: 2e-3 }, lse: { hz: 32768, kind: "crystal", startup: 2 } },
  info: {
    MCU: "STM32F405RGT6, Cortex-M4F 168 MHz, 1 MB Flash, 192 KB SRAM (128 KB + 64 KB CCM)",
    LEDs: "STAT green on PC12 (lit when low, 2 kΩ), PWR red",
    Buttons: "BUT on PA0 (10 kΩ pull-up, 100 nF, low when pressed), RESET",
    USB: "D− PA11, D+ PA12 (22 Ω); VBUS sensed on PC4 through 15k/22k, not on PA9; no ID; PC11 low switches a 1.5 kΩ D+ pull-up in",
    Boot: "BOOT0 and BOOT1 (PB2) each through 33 kΩ to the B0_L/B1_L solder jumpers' GND side",
    "Not modelled": "USB (the device stack and the PC11 D+ pull-up transistors), the boot solder jumpers as switches, JTAG",
    Source: "Olimex STM32-H405 user manual rev B, Rev. C schematic and dimension drawing",
  },
}
