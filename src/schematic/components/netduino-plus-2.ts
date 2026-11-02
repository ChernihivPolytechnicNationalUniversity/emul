import { STM32F405RG } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind } from "../types"
import { LED_COLORS } from "./basic"

/**
 * Netduino Plus 2, Rev A (Secret Labs CW0034, STM32F405RGT6). Sources (docs/netduino-plus-2/
 * board-checklist.md): the Rev A schematic, the archived spec page, the Arduino Uno R3 board file
 * for the outline and header pads (Netduino publishes no drawing of its own), photos for the rest.
 *
 * Scale: 1 cell = 2.54 mm. The board is 68.58 × 53.34 mm, headers along the top (digital) and
 * bottom (power, analog) as on an Uno; it sits at (1, 0) cells. The Uno's D8–SCL header is 0.06"
 * off the 0.1" grid of the others (J4 x = 41.656 mm), so it is rounded to the nearest cell.
 */

const ORIGIN = { x: 1, y: 0 }
const BOARD_MM = { w: 68.58, h: 53.34 }
/** The checklist's coordinates have their origin at the bottom-left; the field's at the top-left. */
const at = (xMm: number, yFromBottomMm: number) => ({ x: ORIGIN.x + xMm / 2.54, y: ORIGIN.y + (BOARD_MM.h - yFromBottomMm) / 2.54 })

/** [pin id, label, MCU pin, x of the pad in mm (Uno R3), note] */
type Row = [string, string, string | undefined, number, string?]

const TOP: Row[] = [
  ["D0", "0", "PC7", 63.5, "USART6_RX"], ["D1", "1", "PC6", 60.96, "USART6_TX"], ["D2", "2", "PA3", 58.42, "USART2_RX"], ["D3", "3", "PA2", 55.88, "USART2_TX"],
  ["D4", "4", "PB12", 53.34], ["D5", "5", "PB8", 50.8, "TIM4_CH3"], ["D6", "6", "PB9", 48.26, "TIM4_CH4"], ["D7", "7", "PA1", 45.72, "UART4_RX"],
  ["D8", "8", "PA0", 41.656, "UART4_TX"], ["D9", "9", "PA6", 39.116], ["D10", "10", "PB10", 36.576], ["D11", "11", "PB15", 34.036, "SPI2_MOSI"],
  ["D12", "12", "PB14", 31.496, "SPI2_MISO"], ["D13", "13", "PB13", 28.956, "SPI2_SCK"], ["GND1", "GND", undefined, 26.416], ["AREF", "AREF", undefined, 23.876, "Not connected"],
  ["SDA", "SD", "PB7", 21.336, "I2C1_SDA, no pull-up on the board"], ["SCL", "SC", "PB6", 18.796, "I2C1_SCL, no pull-up on the board"],
]
const BOTTOM: Row[] = [
  ["NC", "", undefined, 27.94], ["IOREF", "IOREF", undefined, 30.48, "Header 3.3 V, switched on by PB2"], ["RESET", "/RESET", undefined, 33.02, "Pulls NRST low through a transistor buffer; an MCU reset does not come back out"],
  ["3V3", "3V3", undefined, 35.56, "Switched on by PB2 (high)"], ["5V", "5V", undefined, 38.1, "Switched on by PB2 (high)"], ["GND2", "GND", undefined, 40.64], ["GND3", "GND", undefined, 43.18], ["VIN", "VIN", undefined, 45.72, "7.5–9 V in, before D1"],
  ["A0", "A0", "PC0", 50.8], ["A1", "A1", "PC1", 53.34], ["A2", "A2", "PC2", 55.88], ["A3", "A3", "PC3", 58.42], ["A4", "A4", "PC4", 60.96], ["A5", "A5", "PC5", 63.5],
]

function kindOf(id: string, mcu?: string): PinKind {
  if (id.startsWith("GND")) return "gnd"
  if (/^(IOREF|3V3|5V|VIN)$/.test(id)) return "power"
  if (/^A\d$/.test(id)) return "analog"
  return mcu || id === "RESET" ? "digital" : "nc"
}

const WIDTH = 29
const HEIGHT = 22

function header(rows: Row[], top: boolean): PinDef[] {
  return rows.map(([id, label, mcu, xMm, note]) => {
    const p = at(xMm, top ? 50.8 : 2.54)
    const y = Math.round(p.y)
    return { id, label, x: Math.round(p.x), y, side: top ? "top" : "bottom", labelAt: top ? "bottom" : "top", kind: kindOf(id, mcu), stub: top ? y : HEIGHT - y, mcu, note } satisfies PinDef
  })
}

const pins: PinDef[] = [...header(TOP, true), ...header(BOTTOM, false)]

const corner = at(0, BOARD_MM.h)
const place = (xMm: number, yMm: number) => at(xMm, yMm)
const rj45 = place(7.7, 39.4)
const enc = place(38.0, 39.3)
const mcu = place(42.0, 22.3)
const usb = place(2.1, 22.6)
const jack = place(4.3, 8.5)
const sd = place(19.0, 10.4)
const y1 = place(38.9, 12.6)
const jtag = place(64.8, 27.3)

const body: BodyShape[] = [
  { type: "rect", x: corner.x, y: corner.y, w: BOARD_MM.w / 2.54, h: BOARD_MM.h / 2.54, rx: 0.3, fill: "board" },
  { type: "rect", x: rj45.x - 4, y: rj45.y - 2.7, w: 6.6, h: 6.2, rx: 0.2, fill: "connector" },
  { type: "text", x: rj45.x - 0.7, y: rj45.y + 0.1, text: "RJ45", size: 0.4, muted: true },
  { type: "rect", x: enc.x - 2, y: enc.y - 1.1, w: 4, h: 2.2, rx: 0.1, fill: "chip" },
  { type: "text", x: enc.x, y: enc.y + 0.1, text: "ENC28J60", size: 0.32, inverse: true },
  { type: "rect", x: mcu.x - 1.97, y: mcu.y - 1.97, w: 3.94, h: 3.94, rx: 0.1, fill: "chip" },
  { type: "text", x: mcu.x, y: mcu.y - 0.2, text: "STM32F405", size: 0.36, inverse: true },
  { type: "text", x: mcu.x, y: mcu.y + 0.5, text: "RGT6", size: 0.3, inverse: true },
  { type: "rect", x: usb.x - 1.3, y: usb.y - 1.2, w: 2.4, h: 2.4, rx: 0.2, fill: "connector" },
  { type: "rect", x: jack.x - 2.4, y: jack.y - 1.8, w: 5, h: 3.6, rx: 0.2, fill: "connector" },
  { type: "text", x: jack.x + 0.1, y: jack.y + 2.6, text: "7.5–9.0V", size: 0.3, printed: true },
  { type: "rect", x: sd.x - 2.3, y: sd.y - 2.2, w: 4.6, h: 4.4, rx: 0.15, fill: "connector" },
  { type: "text", x: sd.x, y: sd.y + 2.9, text: "MicroSD", size: 0.3, printed: true },
  { type: "rect", x: y1.x - 0.9, y: y1.y - 0.6, w: 1.8, h: 1.2, rx: 0.3, fill: "connector" },
  { type: "text", x: y1.x, y: y1.y + 0.12, text: "25.000", size: 0.24, muted: true },
  { type: "rect", x: jtag.x - 1.4, y: jtag.y - 1.1, w: 2.8, h: 2.2, rx: 0.1, fill: "connector" },
  { type: "text", x: at(48, 0).x, y: at(0, 12.5).y, text: "netduino plus 2", size: 0.55, printed: true },
  { type: "text", x: at(66, 0).x, y: at(0, 8.5).y, text: "REV.A", size: 0.3, printed: true, anchor: "end" },
  { type: "text", x: at(48, 0).x, y: at(0, 47.4).y, text: "Digital I/O", size: 0.32, printed: true },
  { type: "text", x: at(57, 0).x, y: at(0, 6).y, text: "Analog In", size: 0.32, printed: true },
]

const parts: PartDef[] = [
  { type: "led", id: "LED", label: "LED", ...place(59.4, 42.1), color: LED_COLORS.blue.css, mcu: "PA10" },
  { type: "led", id: "PWR", label: "PWR", ...place(10.2, 20.0), color: LED_COLORS.white.css, mcu: "PC13" },
  { type: "led", id: "ACT", label: "ACT", ...place(3.4, 48.6), color: LED_COLORS.green.css },
  { type: "button", id: "BTN", label: "BTN", ...place(55.3, 27.1), mcu: "PB11" },
  { type: "usb", id: "USB", label: "USB", x: usb.x - 1.3, y: usb.y, side: "left", initial: { on: true } },
]

// --- electrical model ---------------------------------------------------------

const GND = "GND1"
const V5 = "$5v"
const V33 = "$3v3"
const NRST = "$NRST"

/**
 * Parts whose datasheets are not in the folder, with the value used and why (CW0034 names them):
 * D1 SS15 Schottky (inferred from its marking): taken as the 1N5819's 0.18 V at 10 mA; the
 * NTJD4152P/NTR4101P P-FETs as a −1 V threshold; MMBT3904/3906 as the default small-signal
 * transistor; the Q2 reset buffer's base resistors (not legible) as 10 kΩ.
 */
const SCHOTTKY_VF = 0.18
const PFET = { vth: -1, k: 0.5 }
/** MC33269DT-5.0 (onsemi Rev 29): 5.0 V, 1.0 V dropout at 500 mA, current limit 0.8 A min. ST1S12 (ST DocID14314 Table 6): VFB 0.6 V → 0.6 × (1 + 162k/36k) = 3.3 V, 0.7 A. */
const MC33269 = { value: 5.0, dropout: 1.0, imax: 0.8 }
const ST1S12 = { value: 0.6 * (1 + 162 / 36), dropout: 0.2, imax: 0.7 }

const pfet = (gate: string, from: string, to: string): Element => ({ kind: "M", polarity: "pmos", g: gate, s: from, d: to, vth: PFET.vth, k: PFET.k })

const model: Element[] = [
  { kind: "SHORT", nodes: ["GND1", "GND2", "GND3"] },
  { kind: "GND", node: GND },
  // USB VBUS → F1 500 mA polyfuse → USB5V_F (also PA9, OTG_FS_VBUS) → Q4 → +5V. The LMV7271 hands
  // +5V to VIN above ~6 V; here both feed it and the higher wins.
  { kind: "V", plus: "$usb", minus: GND, value: 5 },
  { kind: "SW", a: "$usb", b: "$usbsw", part: "USB", closed: "on" },
  { kind: "REG", in: "$usbsw", out: "$usb5vf", gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "SHORT", nodes: ["$usb5vf", "$PA9"] },
  { kind: "D", anode: "$usb5vf", cathode: V5, vf: 0.02 },
  { kind: "D", anode: "VIN", cathode: "$vinp", vf: SCHOTTKY_VF },
  { kind: "REG", in: "$vinp", out: V5, gnd: GND, ...MC33269 },
  { kind: "REG", in: V5, out: V33, gnd: GND, ...ST1S12 },
  // Header power: PB2 high → Q3B pulls /PWR_CTRL_HEADERS low → Q5A/Q5B pass 3.3 V and 5 V.
  { kind: "R", a: "$PB2", b: "$q3b", value: 10e3 },
  { kind: "R", a: "$q3b", b: GND, value: 10e3 },
  { kind: "Q", polarity: "npn", b: "$q3b", c: "$hdrg", e: GND },
  { kind: "R", a: "$hdrg", b: V5, value: 10e3 },
  pfet("$hdrg", V33, "3V3"),
  pfet("$hdrg", V5, "5V"),
  { kind: "SHORT", nodes: ["3V3", "IOREF"] },
  // Ethernet power: PC15 low (R12A 10 kΩ pull-up) → Q6A → +3V3_ETHERNET. microSD: PB1 low → Q6B, R7D bleeder.
  { kind: "R", a: "$PC15", b: V33, value: 10e3 },
  pfet("$PC15", V33, "$3v3eth"),
  { kind: "R", a: "$3v3eth", b: GND, value: 100e3 },
  { kind: "R", a: "$PB1", b: V33, value: 10e3 },
  pfet("$PB1", V33, "$3v3sd"),
  { kind: "R", a: "$3v3sd", b: GND, value: 10e3 },
  // User LED: PA10 (R12C 10 kΩ pull-up) → R11C 10 kΩ → Q3A; +5V → D3 blue → R6 1 kΩ → Q3A.
  { kind: "R", a: "$PA10", b: V33, value: 10e3 },
  { kind: "R", a: "$PA10", b: "$q3a", value: 10e3 },
  { kind: "Q", polarity: "npn", b: "$q3a", c: "$ledc", e: GND },
  { kind: "D", anode: V5, cathode: "$ledk", vf: LED_COLORS.blue.vf, part: "LED" },
  { kind: "R", a: "$ledk", b: "$ledc", value: 1e3 },
  // Power LED: +5V → R2 1.5 kΩ → D2 white → GND; Q1 PNP across D2, base through R5 10 kΩ from PC13.
  { kind: "R", a: V5, b: "$pwra", value: 1.5e3 },
  { kind: "D", anode: "$pwra", cathode: GND, vf: LED_COLORS.white.vf, part: "PWR" },
  { kind: "R", a: "$PC13", b: "$q1b", value: 10e3 },
  { kind: "Q", polarity: "pnp", b: "$q1b", c: GND, e: "$pwra" },
  // BTN: +3.3V when pressed, R12D 10 kΩ down; SWITCH1 is BOOT0, PB11 and PC14 at once.
  { kind: "SW", a: V33, b: "$SWITCH1", part: "BTN", closed: "pressed" },
  { kind: "R", a: "$SWITCH1", b: GND, value: 10e3 },
  { kind: "SHORT", nodes: ["$SWITCH1", "$PB11", "$PC14"] },
  // /RESET header: R4B 10 kΩ up → Q2A inverts → Q2B pulls /RESET_MCU (R4D 10 kΩ up, C22 100 nF) low.
  { kind: "R", a: "RESET", b: V33, value: 10e3 },
  { kind: "R", a: "RESET", b: "$q2ab", value: 10e3 },
  { kind: "Q", polarity: "npn", b: "$q2ab", c: "$q2ac", e: GND },
  { kind: "R", a: "$q2ac", b: V33, value: 10e3 },
  { kind: "R", a: "$q2ac", b: "$q2bb", value: 10e3 },
  { kind: "Q", polarity: "npn", b: "$q2bb", c: NRST, e: GND },
  { kind: "R", a: NRST, b: V33, value: 10e3 },
  { kind: "C", a: NRST, b: GND, value: 100e-9 },
  // microSD: card detect PB5 pulled up (low = card in; no card here), DO on PC11 pulled down.
  { kind: "R", a: "$PB5", b: V33, value: 10e3 },
  { kind: "R", a: "$PC11", b: GND, value: 10e3 },
  // U5 ENC28J60's own pins on the MCU's SPI1 lines (its model in src/sim/boards.ts), powered from +3V3_ETHERNET.
  ...([
    ["$U5-CS", "$PC8"],
    ["$U5-SCK", "$PA5"],
    ["$U5-MOSI", "$PA7"],
    ["$U5-MISO", "$PB4"],
    ["$U5-INT", "$PA4"],
    ["$U5-RESET", "$PD2"],
    ["$U5-CLKIN", "$PA8"],
  ] as const).flatMap(([chip, mcu]): Element[] => [
    { kind: "SHORT", nodes: [chip, mcu] },
    { kind: "GPIO", node: chip, vddNode: "$3v3eth", gndNode: GND },
  ]),
  ...mcuModel(STM32F405RG, {
    vdd: V33,
    gnd: GND,
    nrst: NRST,
    boot0: "$SWITCH1",
    pads: [
      ...pins.filter((p) => p.mcu).map((p) => p.id),
      ...["$PA9", "$PA10", "$PC13", "$PB11", "$PC14", "$PC15", "$PB1", "$PB2", "$PB5", "$PA4", "$PA5", "$PA7", "$PA8", "$PB4", "$PC8", "$PD2", "$PB0", "$PC10", "$PC11", "$PC12", "$PA11", "$PA12", "$PA13", "$PA14", "$PA15", "$PB3"],
    ],
  }),
]

export const netduinoPlus2: ComponentDef = {
  id: "netduino-plus-2",
  name: "Netduino Plus 2",
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
  mcuBoot0: "$SWITCH1",
  // Y1 25.000 MHz crystal (C23/C24 18 pF, R13 390 Ω); no LSE (PC14 is the button, PC15 Ethernet power).
  mcuClocks: { hse: { hz: 25e6, kind: "crystal", startup: 2e-3 }, lse: null },
  info: {
    MCU: "STM32F405RGT6, Cortex-M4F 168 MHz, 1 MB Flash, 192 KB SRAM; HSE 25 MHz",
    LEDs: "LED blue on PA10 (high = on, pulled up: lit until firmware drives it low); PWR white (PC13 low turns it off); ACT green from the ENC28J60",
    Button: "BTN: BOOT0, PB11 and PC14 together, high when pressed; held at reset it boots the ST bootloader. No reset button",
    Power: "PB2 high switches the header 3V3/5V on; PC15 low powers the ENC28J60; PB1 low powers the microSD",
    Ethernet: "ENC28J60 on SPI1: SCK PA5, MOSI PA7, MISO PB4, CS PC8, INT PA4, RESET PD2; clock from MCO1 on PA8",
    microSD: "SPI3: SCK PC10, MISO PC11, MOSI PC12, CS PB0; card detect PB5 (low = inserted)",
    "Not modelled": "microSD card, the ENC28J60's network side (no cable to another host: what it sends goes nowhere, nothing arrives), the MCO1 clock as a signal (the ENC28J60 is clocked whenever it is powered), the VIN/USB comparator (both sources feed +5V)",
    Source: "Secret Labs CW0034 Rev A schematic; Arduino Uno R3 board file for the outline",
  },
}
