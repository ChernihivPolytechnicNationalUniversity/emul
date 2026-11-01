import { STM32F407VG } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind } from "../types"
import { LED_COLORS } from "./basic"

/**
 * STM32F4-Discovery (MB997, STM32F407VGT6). Sources (docs/stm32f4-discovery/board-checklist.md):
 * UM1472 Rev 9, the MB997 schematics B.2–G-01, the BOMs, and ST's rev-E Altium board file for
 * every position. The user's board is PCB rev A, which no ST document covers; its layout and
 * silkscreen match rev B–E, so those are used.
 *
 * Scale: 1 cell = 2.54 mm. The board is 66 × 97 mm; it sits at (0.508, 0.685) cells so that the
 * 2.54 mm headers P1 and P2 (P1 pin 1 at 6.33, 33.82 mm) fall on whole cells.
 */

const ORIGIN = { x: 0.508, y: 0.685 }
const at = (xMm: number, yMm: number) => ({ x: ORIGIN.x + xMm / 2.54, y: ORIGIN.y + yMm / 2.54 })
const BOARD_MM = { w: 66, h: 97 }

/** [header pin, label, MCU pin, note] */
type Row = [number, string, string?, string?]

/** UM1472 Table 7 / SCH-B sheet 1: odd pins in the left column, even in the right, on both headers. */
const P1: Row[] = [
  [1, "GND"], [2, "GND"], [3, "VDD"], [4, "VDD"], [5, "GND"], [6, "NRST", "NRST"],
  [7, "PC1", "PC1"], [8, "PC0", "PC0", "OTG_FS power switch EN̅ (STMPS2141), 10 kΩ pull-up to 3V"],
  [9, "PC3", "PC3", "MP45DT02 DOUT (PDM)"], [10, "PC2", "PC2"],
  [11, "PA1", "PA1"], [12, "PA0", "PA0", "B1 USER (330 Ω, 220 kΩ pull-down)"],
  [13, "PA3", "PA3"], [14, "PA2", "PA2"],
  [15, "PA5", "PA5", "SPI1_SCK → accelerometer"], [16, "PA4", "PA4", "I2S3_WS → CS43L22 LRCK"],
  [17, "PA7", "PA7", "SPI1_MOSI → accelerometer"], [18, "PA6", "PA6", "SPI1_MISO ← accelerometer"],
  [19, "PC5", "PC5"], [20, "PC4", "PC4"], [21, "PB1", "PB1"], [22, "PB0", "PB0"],
  [23, "GND"], [24, "PB2", "PB2", "BOOT1, 10 kΩ pull-up"],
  [25, "PE7", "PE7"], [26, "PE8", "PE8"], [27, "PE9", "PE9"], [28, "PE10", "PE10"],
  [29, "PE11", "PE11"], [30, "PE12", "PE12"], [31, "PE13", "PE13"], [32, "PE14", "PE14"],
  [33, "PE15", "PE15"], [34, "PB10", "PB10", "MP45DT02 CLK"], [35, "PB11", "PB11"], [36, "PB12", "PB12"],
  [37, "PB13", "PB13"], [38, "PB14", "PB14"], [39, "PB15", "PB15"], [40, "PD8", "PD8"],
  [41, "PD9", "PD9"], [42, "PD10", "PD10"], [43, "PD11", "PD11"], [44, "PD12", "PD12", "LD4 green (510 Ω)"],
  [45, "PD13", "PD13", "LD3 orange (680 Ω)"], [46, "PD14", "PD14", "LD5 red (680 Ω)"],
  [47, "PD15", "PD15", "LD6 blue (680 Ω)"], [48, "NC"], [49, "GND"], [50, "GND"],
]
const P2: Row[] = [
  [1, "GND"], [2, "GND"], [3, "5V"], [4, "5V"], [5, "3V"], [6, "3V"],
  [7, "PH0", undefined, "OSC_IN: reaches the header only through SB13, open as shipped"],
  [8, "PH1", undefined, "OSC_OUT: reaches the header only through SB14, open as shipped"],
  [9, "PC14", "PC14", "X3 (32.768 kHz) not fitted; through SB16"], [10, "PC15", "PC15", "X3 not fitted; through SB15"],
  [11, "PE6", "PE6"], [12, "PC13", "PC13"], [13, "PE4", "PE4"], [14, "PE5", "PE5"],
  [15, "PE2", "PE2"], [16, "PE3", "PE3", "Accelerometer CS"], [17, "PE0", "PE0", "Accelerometer INT1"], [18, "PE1", "PE1", "Accelerometer INT2"],
  [19, "PB8", "PB8"], [20, "PB9", "PB9", "I2C1_SDA → CS43L22, 4.7 kΩ pull-up"],
  [21, "BOOT0", "BOOT0", "510 Ω to GND (SB18), 10 kΩ to VDD"], [22, "VDD"],
  [23, "PB6", "PB6", "I2C1_SCL → CS43L22, 4.7 kΩ pull-up"], [24, "PB7", "PB7"],
  [25, "PB4", "PB4"], [26, "PB5", "PB5"], [27, "PD7", "PD7"], [28, "PB3", "PB3", "SWO to the ST-LINK (SB12)"],
  [29, "PD5", "PD5", "OTG_FS over-current (STMPS2141 FAULT̅), 47 kΩ pull-up, LD8"], [30, "PD6", "PD6"],
  [31, "PD3", "PD3"], [32, "PD4", "PD4", "CS43L22 RESET̅, 10 kΩ pull-down"],
  [33, "PD1", "PD1"], [34, "PD2", "PD2"], [35, "PC12", "PC12", "I2S3_SD → CS43L22"], [36, "PD0", "PD0"],
  [37, "PC10", "PC10", "I2S3_CK → CS43L22"], [38, "PC11", "PC11"], [39, "PA14", "PA14", "SWCLK (ST-LINK)"], [40, "PA15", "PA15"],
  [41, "PA10", "PA10", "OTG_FS_ID"], [42, "PA13", "PA13", "SWDIO (ST-LINK)"], [43, "PA8", "PA8"], [44, "PA9", "PA9", "OTG_FS VBUS"],
  [45, "PC8", "PC8"], [46, "PC9", "PC9"], [47, "PC6", "PC6"], [48, "PC7", "PC7", "I2S3_MCK → CS43L22"],
  [49, "GND"], [50, "GND"],
]

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "GND") return "gnd"
  if (/^(VDD|5V|3V)$/.test(label)) return "power"
  if (!mcu) return "nc"
  return "digital"
}

const WIDTH = 27
const HEIGHT = 40
/** Header columns in cells: P1 at 6.33/8.87 mm, P2 at 57.13/59.67 mm; pin 1 row at 33.82 mm. */
const COL = { p1Odd: 3, p1Even: 4, p2Odd: 23, p2Even: 24 }
const TOP = 14

function header(connector: "P1" | "P2", rows: Row[]): PinDef[] {
  return rows.map(([pin, label, mcu, note]) => {
    const odd = pin % 2 === 1
    const x = connector === "P1" ? (odd ? COL.p1Odd : COL.p1Even) : odd ? COL.p2Odd : COL.p2Even
    const outer = connector === "P1" ? odd : !odd
    const side = connector === "P1" ? "left" : "right"
    return {
      id: `${connector}-${pin}`,
      label,
      x,
      y: TOP + Math.floor((pin - 1) / 2),
      side,
      labelAt: outer ? side : side === "left" ? "right" : "left",
      kind: kindOf(label, mcu),
      stub: connector === "P1" ? x : WIDTH - x,
      mcu: mcu === "BOOT0" ? undefined : mcu,
      connector,
      connectorPin: pin,
      note,
    } satisfies PinDef
  })
}

const pins: PinDef[] = [...header("P1", P1), ...header("P2", P2)]

const corner = at(0, 0)
const mcu = at(32.66, 48.54)
const x2 = at(30.6, 33.3)
const stlink = at(28.4, 24.3)
const codec = at(27.0, 76.71)
const accel = at(33.51, 65.89)
const jack = at(17.76, 91.44)
const otg = at(36.81, 92.05)
const jp1 = at(17.61, 42.54)
const cn2 = at(6.33, 11.3)
const cn3 = at(47.3, 16.88)

const body: BodyShape[] = [
  { type: "rect", x: corner.x, y: corner.y, w: BOARD_MM.w / 2.54, h: BOARD_MM.h / 2.54, rx: 0.3, fill: "board" },
  // ST-LINK/V2 (STM32F103, X1) across the top third, cut off by CN3's jumpers.
  { type: "rect", x: corner.x + 0.3, y: corner.y + 0.3, w: BOARD_MM.w / 2.54 - 0.6, h: 10.4, rx: 0.3, fill: "zone" },
  { type: "rect", x: stlink.x - 1.4, y: stlink.y - 1.4, w: 2.8, h: 2.8, rx: 0.15, fill: "chip" },
  { type: "text", x: stlink.x, y: stlink.y + 0.1, text: "STM32F103", size: 0.28, inverse: true },
  { type: "text", x: at(42, 0).x, y: at(0, 25.5).y, text: "ST-LINK", size: 0.36, muted: true },
  { type: "rect", x: cn2.x - 0.4, y: cn2.y - 0.4, w: 0.8, h: 5 * 1 + 0.8, rx: 0.1, fill: "connector" },
  { type: "text", x: cn2.x + 1.1, y: cn2.y + 2.6, text: "SWD", size: 0.35, rotate: -90, muted: true },
  { type: "rect", x: cn3.x - 0.4, y: cn3.y - 0.4, w: 0.8, h: 3 + 0.8, rx: 0.1, fill: "connector" },
  { type: "text", x: cn3.x + 1.6, y: cn3.y + 1.5, text: "CN3", size: 0.3, muted: true },
  // HSE X2 (8 MHz HC-49) and the MCU (LQFP100, 14 × 14 mm, rotated 180°).
  { type: "rect", x: x2.x - 2, y: x2.y - 0.75, w: 4, h: 1.5, rx: 0.7, fill: "connector" },
  { type: "text", x: x2.x, y: x2.y + 0.12, text: "8.000", size: 0.32, muted: true },
  { type: "rect", x: mcu.x - 2.76, y: mcu.y - 2.76, w: 5.51, h: 5.51, rx: 0.15, fill: "chip" },
  { type: "text", x: mcu.x, y: mcu.y - 0.3, text: "STM32F407VG", size: 0.42, inverse: true },
  { type: "text", x: mcu.x, y: mcu.y + 0.6, text: "LQFP100 · 168 MHz", size: 0.28, inverse: true },
  // JP1 Idd, the accelerometer, the codec, the audio jack and the OTG connector.
  { type: "text", x: jp1.x - 1, y: jp1.y + 0.1, text: "Idd", size: 0.3, muted: true, anchor: "end" },
  { type: "rect", x: accel.x - 0.4, y: accel.y - 0.4, w: 0.8, h: 0.8, rx: 0.05, fill: "chip" },
  { type: "rect", x: codec.x - 1.1, y: codec.y - 1.1, w: 2.2, h: 2.2, rx: 0.1, fill: "chip" },
  { type: "text", x: codec.x, y: codec.y + 0.1, text: "CS43L22", size: 0.26, inverse: true },
  { type: "rect", x: jack.x - 1.2, y: jack.y - 1.6, w: 2.4, h: 3.6, rx: 0.2, fill: "connector" },
  { type: "text", x: jack.x, y: jack.y + 0.1, text: "CN4", size: 0.3, muted: true },
  { type: "rect", x: otg.x - 1.2, y: otg.y - 0.9, w: 2.4, h: 1.8, rx: 0.2, fill: "connector" },
  { type: "text", x: otg.x, y: otg.y - 1.2, text: "CN5 OTG", size: 0.28, muted: true },
  // Header names and the silkscreen.
  { type: "text", x: (COL.p1Odd + COL.p1Even) / 2, y: TOP - 1, text: "P1", size: 0.4, muted: true },
  { type: "text", x: (COL.p2Odd + COL.p2Even) / 2, y: TOP - 1, text: "P2", size: 0.4, muted: true },
  { type: "text", x: corner.x + BOARD_MM.w / 2.54 / 2, y: at(0, 29.6).y, text: "www.st.com/stm32f4-discovery", size: 0.34, printed: true },
  { type: "text", x: at(52, 0).x, y: at(0, 18).y, text: "MB997A", size: 0.3, printed: true },
]

/**
 * The MB997's Everlight 0603 LEDs (part numbers from the B02/G01 BOMs; datasheets in
 * docs/stm32f4-discovery, "Electro-Optical Characteristics" p.3): blue 19-217/BHC VF 2.50–3.10 V at
 * 5 mA, orange 19-217/S2C 1.70–2.20 V at 5 mA, green 19-213SYGC 2.00 V typ at 20 mA, red 19-213/R6C
 * 1.75–2.35 V at 20 mA; the middle of each range where no typical is given. The diode model's vf is
 * at 10 mA; the board runs them at 0.3–2 mA, below every curve's first point.
 *
 * Blue on the 2.9 V VDD through 680 Ω comes out at about 0.3–0.4 mA, roughly 1–2 % of its rated
 * brightness by the "relative luminous intensity" curve: LD6 is the dim one on a real board too.
 */
const VF = { red: 2.05, orange: 1.95, green: 2.0, blue: 2.8 }
const orange = { css: "#f97316" }
const ld = (id: string, xMm: number, yMm: number, color: string, mcuPin?: string, pin?: string): PartDef => ({ type: "led", id, label: id, ...at(xMm, yMm), color, mcu: mcuPin, pin })

const parts: PartDef[] = [
  ld("LD1", 16.4, 7.38, LED_COLORS.red.css),
  ld("LD2", 41.56, 12.34, LED_COLORS.red.css),
  ld("LD3", 33.51, 61.72, orange.css, "PD13", "P1-45"),
  ld("LD4", 29.34, 65.91, LED_COLORS.green.css, "PD12", "P1-44"),
  ld("LD5", 37.65, 65.91, LED_COLORS.red.css, "PD14", "P1-46"),
  ld("LD6", 33.51, 70.1, LED_COLORS.blue.css, "PD15", "P1-47"),
  ld("LD7", 29.19, 94.7, LED_COLORS.green.css),
  ld("LD8", 44.4, 94.7, LED_COLORS.red.css, "PD5", "P2-29"),
  { type: "button", id: "B1", label: "User", ...at(20.96, 65.23), mcu: "PA0", pin: "P1-12" },
  { type: "button", id: "B2", label: "Reset", ...at(45.04, 65.23), mcu: "NRST", pin: "P1-6" },
  { type: "switch", id: "JP1", label: "JP1 Idd: the MCU's VDD from the 3V rail; take it off to put an ammeter across", x: jp1.x, y: jp1.y - 0.5, span: 1, vertical: true, initial: { on: true } },
  { type: "usb", id: "USB", label: "CN1 USB (ST-LINK)", ...at(33.36, 0.5), side: "top", initial: { on: true } },
]

// --- electrical model ---------------------------------------------------------

const gndPins = pins.filter((p) => p.kind === "gnd").map((p) => p.id)
const GND = gndPins[0]
const V5 = "P2-3"
const V3 = "P2-5"
const VDD = "P1-3"
const NRST = "P1-6"
const BOOT0 = "P2-21"

/** D1/D3 BAT60JFILM: VF 0.28 V typ at 10 mA (BAT60J Ed. 6A, static electrical characteristics). */
const D_VF = 0.28
/** U1 LD3985M33R: dropout 60 mV typ at 150 mA, peak output current 550 mA typ (DocID9587 Rev 17, Table 4). */
const LDO = { dropout: 0.06, imax: 0.55 }

/** [the chip's pin node, the header pin on its MCU line] (SCH-B sheets 4 and 6). */
export const ONBOARD: [string, string][] = [
  ["$U5-SCK", "P1-15"],
  ["$U5-MOSI", "P1-17"],
  ["$U5-MISO", "P1-18"],
  ["$U5-CS", "P2-16"],
  ["$U5-INT1", "P2-17"],
  ["$U5-INT2", "P2-18"],
  ["$U9-CLK", "P1-34"],
  ["$U9-DOUT", "P1-9"],
  ["$U7-SDA", "P2-20"],
  ["$U7-SCL", "P2-23"],
  ["$U7-RESET", "P2-32"],
  ["$U7-MCLK", "P2-48"],
  ["$U7-SCLK", "P2-37"],
  ["$U7-SDIN", "P2-35"],
  ["$U7-LRCK", "P1-16"],
]

const led = (from: string, part: string, vf: number, r: number): Element[] => [
  { kind: "R", a: from, b: `$${part}k`, value: r },
  { kind: "D", anode: `$${part}k`, cathode: GND, vf, part },
]

const model: Element[] = [
  { kind: "SHORT", nodes: gndPins },
  { kind: "GND", node: GND },
  { kind: "SHORT", nodes: ["P2-3", "P2-4"] },
  { kind: "SHORT", nodes: ["P2-5", "P2-6"] },
  { kind: "SHORT", nodes: ["P1-3", "P1-4", "P2-22"] },
  // Power (UM1472 §7.4, SCH-B sheet 2): CN1's VBUS → D1 → 5V (in or out) → U1 LD3985M33R → D3 → 3V
  // → JP1 → VDD. The host port is taken as a USB 2.0 port's 500 mA.
  { kind: "V", plus: "$usb", minus: GND, value: 5 },
  { kind: "SW", a: "$usb", b: "$usbsw", part: "USB", closed: "on" },
  { kind: "REG", in: "$usbsw", out: "$u5v", gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "D", anode: "$u5v", cathode: V5, vf: D_VF },
  { kind: "REG", in: V5, out: "$u1", gnd: GND, value: 3.3, dropout: LDO.dropout, imax: LDO.imax },
  { kind: "D", anode: "$u1", cathode: V3, vf: D_VF },
  { kind: "SW", a: V3, b: VDD, part: "JP1", closed: "on" },
  // LD2 PWR on the 3V rail (R14 1 kΩ).
  ...led(V3, "LD2", VF.red, 1e3),
  // User LEDs, active high (R40 510 Ω, R36/R41/R42 680 Ω; SCH-B sheet 6).
  ...led("P1-44", "LD4", VF.green, 510),
  ...led("P1-45", "LD3", VF.orange, 680),
  ...led("P1-46", "LD5", VF.red, 680),
  ...led("P1-47", "LD6", VF.blue, 680),
  // LD8 from 3V through R67 620 Ω into the FAULT̅ node on PD5 (R51 47 kΩ pull-up): lit when PD5 is low.
  { kind: "R", a: V3, b: "$LD8a", value: 620 },
  { kind: "D", anode: "$LD8a", cathode: "P2-29", vf: VF.red, part: "LD8" },
  { kind: "R", a: V3, b: "P2-29", value: 47e3 },
  // B1 USER: VDD → R38 100 Ω → switch → node; R39 220 kΩ to GND; R35 330 Ω → SB20 → PA0. C38 not fitted.
  { kind: "SW", a: VDD, b: "$b1", part: "B1", closed: "pressed" },
  { kind: "R", a: "$b1", b: "$b1n", value: 100 },
  { kind: "R", a: "$b1n", b: GND, value: 220e3 },
  { kind: "R", a: "$b1n", b: "P1-12", value: 330 },
  // B2 RESET: NRST → SB1 → switch → GND, C37 100 nF on NRST.
  { kind: "SW", a: NRST, b: GND, part: "B2", closed: "pressed" },
  { kind: "C", a: NRST, b: GND, value: 100e-9 },
  // BOOT0: R30 510 Ω to GND (SB18 on) and R31 10 kΩ to VDD; BOOT1 (PB2): R34 10 kΩ to VDD.
  { kind: "R", a: BOOT0, b: GND, value: 510 },
  { kind: "R", a: BOOT0, b: VDD, value: 10e3 },
  { kind: "R", a: "P1-24", b: VDD, value: 10e3 },
  // I²C1 pull-ups for the codec (R29 on PB6, R33 on PB9, 4.7 kΩ to VDD).
  { kind: "R", a: "P2-23", b: VDD, value: 4.7e3 },
  { kind: "R", a: "P2-20", b: VDD, value: 4.7e3 },
  // CS43L22 RESET̅ (PD4): R43 10 kΩ pull-down. STMPS2141 EN̅ (PC0): R45 10 kΩ pull-up to 3V.
  { kind: "R", a: "P2-32", b: GND, value: 10e3 },
  { kind: "R", a: "P1-8", b: V3, value: 10e3 },
  // The on-board chips' own pins (their models in src/sim/boards.ts), each on its MCU pin's line
  // and powered from the 3V rail: U5 accelerometer, U9 microphone, U7 CS43L22.
  ...ONBOARD.flatMap(([chip, header]): Element[] => [
    { kind: "SHORT", nodes: [chip, header] },
    { kind: "GPIO", node: chip, vddNode: V3, gndNode: GND },
  ]),
  ...mcuModel(STM32F407VG, { vdd: VDD, gnd: GND, nrst: NRST, boot0: BOOT0, pads: pins.filter((p) => p.mcu && p.mcu !== "NRST").map((p) => p.id) }),
]

export const stm32f4Discovery: ComponentDef = {
  id: "stm32f4-discovery",
  name: "STM32F4-Discovery",
  description: "STM32F407VG",
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
  chip: STM32F407VG.id,
  // The user's board is MB997A: a LIS302DL. Flat on the desk, quiet room, a 1 kHz tone if raised.
  defaults: { accel: "lis302dl", roll: "0", pitch: "0", sound: "0", tone: "1000" },
  fields: [
    {
      key: "accel",
      label: "Accelerometer",
      type: "select",
      options: [
        { value: "lis302dl", label: "LIS302DL (MB997 A/B)" },
        { value: "lis3dsh", label: "LIS3DSH (MB997 C–E)" },
      ],
    },
    { key: "roll", label: "Roll (about X)", type: "range", min: -180, max: 180, step: 5, unit: "°" },
    { key: "pitch", label: "Pitch (about Y)", type: "range", min: -90, max: 90, step: 5, unit: "°" },
    { key: "sound", label: "Sound at the microphone", type: "range", min: 0, max: 120, step: 1, unit: "dB SPL" },
    { key: "tone", label: "Tone", type: "range", min: 100, max: 8000, step: 100, unit: "Hz" },
  ],
  mcuPower: VDD,
  mcuReset: NRST,
  mcuBoot0: BOOT0,
  // X2 8 MHz crystal and the ST-LINK's 8 MHz MCO both on PH0 (R25 and R68 fitted, UM1472 §7.11.1):
  // HSE works as a crystal or in bypass. X3 (LSE) is not fitted on any revision.
  mcuClocks: { hse: { hz: 8e6, kind: "any", startup: 2e-3 }, lse: null },
  info: {
    MCU: "STM32F407VGT6, Cortex-M4F 168 MHz, 1 MB Flash, 192 KB SRAM (128 KB + 64 KB CCM)",
    LEDs: "LD4 green PD12, LD3 orange PD13, LD5 red PD14, LD6 blue PD15 (active high); LD8 red on PD5 (OTG over-current)",
    Buttons: "B1 USER on PA0 (high when pressed, no debounce capacitor), B2 RESET",
    Audio: "CS43L22: I2C1 PB6/PB9 (0x4A), I2S3 PC7/PC10/PC12/PA4, RESET̅ PD4",
    Accelerometer: "LIS302DL (rev A/B) or LIS3DSH (rev C–E): SPI1 PA5/PA6/PA7, CS PE3, INT PE0/PE1",
    Microphone: "MP45DT02: CLK PB10, PDM PC3",
    "USB OTG FS": "DM PA11, DP PA12, VBUS PA9, ID PA10, power EN̅ PC0, over-current PD5",
    Modelled: "LIS302DL/LIS3DSH on SPI (Roll/Pitch below), CS43L22 on I²C and I²S to the bench speaker, MP45DT02 PDM microphone (Sound below)",
    "Not modelled": "The accelerometers' click/free-fall engines, state machines and FIFO; the CS43L22's speaker path, tone/limiter and analog performance; the microphone's frequency response; USB OTG (STMPS2141, LD7, LD8 over-current); the ST-LINK (LD1 COM, SWD, its MCO as a separate source); MCK as a 256·Fs square (the codec takes 256·Fs while it is driven)",
    Source: "ST UM1472 Rev 9, MB997 schematics B.2–G-01, rev-E board file",
  },
}
