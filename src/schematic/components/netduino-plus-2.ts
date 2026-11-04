import { STM32F405RG } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind } from "../types"
import { LED_COLORS } from "./basic"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"
import { NOT_MODELLED as ENC28J60 } from "@/sim/enc28j60"
import { BOARD_MM, boardArt, FRAME, HEADER } from "./netduino-plus-2-art"

/**
 * Netduino Plus 2, Rev A (Secret Labs CW0034, STM32F405RGT6). Sources (docs/netduino-plus-2/
 * board-checklist.md): the Rev A schematic, the archived spec page, the Arduino Uno R3 board file
 * for the outline and header pads (Netduino publishes no drawing of its own), and a top
 * view of the board for everything else; the board drawn to scale in netduino-plus-2-art.ts.
 *
 * Scale: 1 cell = 2.54 mm. The board is 68.58 × 53.34 mm, headers along the top (digital) and
 * bottom (power, analog) as on an Uno; its left edge sits 2 cells in, for the RJ45 that stands
 * past it. The Uno's D8–SCL header is 0.06" off the 0.1" grid of the others (x = 41.656 mm for
 * D8), so its pins are rounded to the nearest cell and the header is drawn there.
 */

/** Board millimetres (y down from the top edge) to cells. */
const cell = (mm: { x: number; y: number }) => ({ x: Math.round((mm.x + FRAME.originX) * FRAME.cellsPerMm * 100) / 100, y: Math.round((mm.y + FRAME.originY) * FRAME.cellsPerMm * 100) / 100 })

/** [pin id, label, MCU pin, x of the pad in mm (Uno R3), note] */
type Row = [string, string, string | undefined, number, string?]

const TOP: Row[] = [
  ["D0", "0", "PC7", 63.5, "USART6_RX"], ["D1", "1", "PC6", 60.96, "USART6_TX"], ["D2", "2", "PA3", 58.42, "USART2_RX"], ["D3", "3", "PA2", 55.88, "USART2_TX"],
  ["D4", "4", "PB12", 53.34], ["D5", "5", "PB8", 50.8, "TIM4_CH3"], ["D6", "6", "PB9", 48.26, "TIM4_CH4"], ["D7", "7", "PA1", 45.72, "UART4_RX"],
  ["D8", "8", "PA0", 41.656, "UART4_TX"], ["D9", "9", "PA6", 39.116], ["D10", "10", "PB10", 36.576], ["D11", "11", "PB15", 34.036, "SPI2_MOSI"],
  ["D12", "12", "PB14", 31.496, "SPI2_MISO"], ["D13", "13", "PB13", 28.956, "SPI2_SCK"], ["GND1", "GND", undefined, 26.416], ["AREF", "AREF", undefined, 23.876, "Not connected (its box on the board is empty)"],
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

const WIDTH = Math.ceil(cell({ x: BOARD_MM.w, y: 0 }).x)
const HEIGHT = 22

/** Every header name is printed on the board, in its box (A0–A5 as 0–5 under "Analog In"). */
function header(rows: Row[], top: boolean): PinDef[] {
  return rows.map(([id, label, mcu, xMm, note]) => {
    const p = cell({ x: xMm, y: top ? HEADER.top : HEADER.bottom })
    const y = Math.round(p.y)
    return { id, label, x: Math.round(p.x), y, side: top ? "top" : "bottom", labelAt: top ? "bottom" : "top", kind: kindOf(id, mcu), stub: top ? y : HEIGHT - y, mcu, note, printed: true } satisfies PinDef
  })
}

const pins: PinDef[] = [...header(TOP, true), ...header(BOTTOM, false)]

const body: BodyShape[] = boardArt()

/** Positions measured on the board (mm from its top-left corner); see netduino-plus-2-art.ts. */
const parts: PartDef[] = [
  { type: "led", id: "LED", label: "LED", ...cell({ x: 60.2, y: 10.45 }), color: LED_COLORS.blue.css, mcu: "PA10", printed: true },
  { type: "led", id: "PWR", label: "PWR", ...cell({ x: 9.55, y: 33.0 }), color: LED_COLORS.white.css, mcu: "PC13", printed: true },
  { type: "led", id: "ACT", label: "ACT", ...cell({ x: 2.7, y: 3.85 }), color: LED_COLORS.green.css, printed: true },
  { type: "button", id: "BTN", label: "BTN", ...cell({ x: 55.45, y: 26.3 }), size: 1.3, mcu: "PB11", printed: true },
  { type: "usb", id: "USB", label: "USB", ...cell({ x: 1.5, y: 30.7 }), side: "left", initial: { on: true } },
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
  board: { vendor: "Secret Labs", mcu: "STM32F405RG", mhz: 168, volts: 3.3, tags: ["Ethernet"], photo: "netduino-plus-2.webp", core: "Cortex-M4F", memory: "1 MB / 192 KB", onBoard: ["Ethernet", "microSD", "LED", "button"] },
  description: "STM32F405RG",
  keywords: ["STM32", "STM32F405RG", "Netduino", "Ethernet", "ENC28J60", "Cortex-M4"],
  category: "boards",
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
    // MCU: STM32F405RGT6, Cortex-M4F 168 MHz, 1 MB Flash, 192 KB SRAM; HSE 25 MHz
    // LEDs: LED blue on PA10 (high = on, pulled up: lit until firmware drives it low); PWR white (PC13 low turns it off);
    //   ACT green from the ENC28J60
    LEDs: "Blue on PA10, starts lit",
    // Button: BTN: BOOT0, PB11 and PC14 together, high when pressed; held at reset it boots the ST bootloader. No reset
    //   button
    Button: "BOOT0, PB11, PC14, active high",
    // Power: PB2 high switches the header 3V3/5V on; PC15 low powers the ENC28J60; PB1 low powers the microSD
    Power: "PB2 high enables header power",
    // Ethernet: ENC28J60 on SPI1: SCK PA5, MOSI PA7, MISO PB4, CS PC8, INT PA4, RESET PD2; clock from MCO1 on PA8
    Ethernet: "ENC28J60 on SPI1, CS PC8",
    // microSD: SPI3: SCK PC10, MISO PC11, MOSI PC12, CS PB0; card detect PB5 (low = inserted)
    microSD: "SPI3, CS PB0, CD PB5",
    // Not modelled: microSD card, the ENC28J60's network side (no cable to another host: what it sends goes nowhere,
    //   nothing arrives), the MCO1 clock as a signal (the ENC28J60 is clocked whenever it is powered), the VIN/USB
    //   comparator (both sources feed +5V), the MiniJTAG header
    // Source: Secret Labs CW0034 Rev A schematic; Arduino Uno R3 board file for the outline
  },
}

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [netduinoPlus2]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "netduino-plus-2": {
    maker: "Secret Labs",
    docs: [DOCS["wildernesslabs-netduino-about"], DOCS["secretlabs-cw0034"], DOCS["mchp-ds39662e"], DOCS["mchp-ds80349c"], DOCS["onsemi-mc33269"], DOCS["st-st1s12"], DOCS["st-ds8626"]],
    specs: [],
    characteristics: [
      { kind: "clock", value: { max: 168e6 }, cite: { doc: "st-ds8626", page: 16, at: "Table 2" } },
      { kind: "flash", value: { typ: 1048576 }, cite: { doc: "st-ds8626", page: 15, at: "Table 2" } },
      { kind: "ram", value: { typ: 196608 }, cite: { doc: "st-ds8626", page: 15, at: "Table 2" } },
      { kind: "ioLevel", value: { typ: 3.3 }, limit: { max: 4 }, cite: { doc: "secretlabs-cw0034", page: 1, at: "5V to 3.3V buck" }, limitCite: { doc: "st-ds8626", page: 80, at: "Table 11" } },
      { kind: "input", value: { min: 7.5, max: 9 }, cite: { doc: "secretlabs-cw0034", page: 1, at: "Power Connector" } },
      { kind: "ioPins", value: { typ: 20 }, cite: { doc: "secretlabs-cw0034", page: 1, at: "Digital and analog headers" } },
      { kind: "outputCurrent", value: { max: 0.5 }, at: [{ temp: 70 }], cite: { doc: "secretlabs-cw0034", page: 1, at: "Header Power Switches" } },
    ],
    modelled: [
      { what: "168 MHz from the crystal", test: "tests/sim/f405-boards-firmware.test.ts" },
      { what: "Blue LED blinks from firmware", test: "tests/sim/f405-boards-firmware.test.ts" },
      { what: "User button read by firmware", test: "tests/sim/f405-boards-firmware.test.ts" },
      { what: "Header rails switched by PB2", cite: { doc: "secretlabs-cw0034", page: 1, at: "Header Power Switches" }, test: "tests/sim/netduino-plus-2.test.ts" },
      { what: "Ethernet controller answers on SPI", test: "tests/sim/f405-boards-firmware.test.ts" },
      { what: "RESET through the buffer", test: "tests/sim/netduino-plus-2.test.ts" },
      { what: "BOOT0 low, button raises it", cite: { doc: "secretlabs-cw0034", page: 1, at: "BOOT0" }, test: "tests/sim/netduino-plus-2.test.ts" },
      { what: "D0–D13 and A0–A5 mapped", test: "tests/sim/netduino-plus-2.test.ts" },
    ],
    notModelled: [{ what: "No microSD card" }, { what: "Ethernet reaches no other host" }, { what: "No MCO1 clock signal" }, { what: "No VIN/USB comparator" }, { what: "No USB device or bootloader" }, { what: "MiniJTAG header does nothing" }, ...ENC28J60.map((what) => ({ part: "ENC28J60", what }))],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
