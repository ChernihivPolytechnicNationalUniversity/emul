import { STM32F401CC, STM32F401CE, STM32F411CE, type ChipProfile } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { ComponentDef, Element, PartDef, PinDef, PinKind } from "../types"
import { LED_COLORS } from "./basic"
import { boardArt } from "./weact-blackpill-art"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

/**
 * WeAct Studio Black Pill, MiniF4x1Cx V3.1, with an STM32F411CEU6, F401CCU6 or F401CEU6: one PCB for all three
 * ("STM32F4X1CXU6" on every schematic from V2.0 to V3.1, docs/blackpill-f401/f401-vs-f411.md §0). Sources
 * (docs/blackpill-f411/SUMMARY.md): the V3.1 schematic (MiniF4x1Cx_V31 SchDoc, 2021-04-17) and the V3.1 board-shape
 * drawing (BS31).
 *
 * Scale: 1 cell = 2.54 mm. The board is 52.81 × 20.78 mm, USB-C on the left as BS31 draws it. It sits
 * at ORIGIN so that the two 20-pin rows (pin 1 at x 1.40 mm, rows at y 2.77 and 17.97 mm) fall on
 * whole cells. The headers are male pins under the board; seen from the top.
 */

const ORIGIN = { x: 1 - 1.4 / 2.54 + 1, y: 2 - 2.77 / 2.54 }
const at = (xMm: number, yMm: number) => ({
  x: ORIGIN.x + xMm / 2.54,
  y: ORIGIN.y + yMm / 2.54,
})

/** [silk label, MCU pin, note] in header order, pin 1 (square pad) on the USB end. S31 P1/P2, BS31 silk. */
type Row = [string, string?, string?]

const P1: Row[] = [
  ["5V", undefined, "USB VBUS after D4 (B5819WS); an input when powered from here"],
  ["G"],
  ["3V3", undefined, "ME6231A33 output, 500 mA"],
  ["B10", "PB10"],
  ["B2", "PB2", "BOOT1: R3 10 kΩ to GND"],
  ["B1", "PB1"],
  ["B0", "PB0"],
  ["A7", "PA7", "SPI flash DI (footprint U3, not fitted)"],
  ["A6", "PA6", "SPI flash DO (footprint U3, not fitted)"],
  ["A5", "PA5", "SPI flash CLK (footprint U3, not fitted)"],
  ["A4", "PA4", "SPI flash /CS (footprint U3, not fitted)"],
  ["A3", "PA3"],
  ["A2", "PA2"],
  ["A1", "PA1"],
  ["A0", "PA0", "KEY through R1 330 Ω to GND when pressed; no pull-up on the board"],
  ["R", "NRST", "NRST button to GND, C3 100 nF; no external pull-up (R4 not fitted)"],
  ["C15", "PC15", "LSE crystal Y1 (OSC32_OUT)"],
  ["C14", "PC14", "LSE crystal Y1 (OSC32_IN)"],
  ["C13", "PC13", "Blue LED C13 through R5 1.5 kΩ from 3V3 (lit when low)"],
  ["VB", undefined, "VBAT through BAT54C D1 (3V3 and VB diode-ORed)"],
]
const P2: Row[] = [
  ["B12", "PB12"],
  ["B13", "PB13"],
  ["B14", "PB14"],
  ["B15", "PB15"],
  ["A8", "PA8"],
  ["A9", "PA9"],
  ["A10", "PA10"],
  ["A11", "PA11", "USB D−"],
  ["A12", "PA12", "USB D+"],
  ["A15", "PA15"],
  ["B3", "PB3"],
  ["B4", "PB4"],
  ["B5", "PB5"],
  ["B6", "PB6"],
  ["B7", "PB7"],
  ["B8", "PB8"],
  ["B9", "PB9"],
  ["5V"],
  ["G"],
  ["3V3"],
]

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "G") return "gnd"
  if (label === "5V" || label === "3V3" || label === "VB") return "power"
  return mcu ? "digital" : "nc"
}

const WIDTH = 24
const HEIGHT = 10

/** Pad centres (BS31 p1): x = 1.40 + 2.54 (n − 1) mm; P1 at y 2.77 mm, P2 at y 17.97 mm. */
function header(connector: "P1" | "P2", rows: Row[]): PinDef[] {
  return rows.map(([label, mcu, note], i) => {
    const p = at(1.4 + 2.54 * i, connector === "P1" ? 2.77 : 17.97)
    const x = Math.round(p.x)
    const y = Math.round(p.y)
    const top = connector === "P1"
    return {
      id: `${connector}-${i + 1}`,
      label,
      x,
      y,
      side: top ? "top" : "bottom",
      labelAt: top ? "top" : "bottom",
      kind: kindOf(label, mcu),
      stub: top ? y : HEIGHT - y,
      mcu,
      connector,
      connectorPin: i + 1,
      note,
      printed: true,
    } satisfies PinDef
  })
}

/**
 * P3, the SWD header (S31): 1 3V3, 2 SWDIO = PA13, 3 SWCLK = PA14, 4 GND, silk "3V3 DIO SCK GND". The pads sit
 * at x 45.88 mm, y 14.14 / 11.60 / 9.06 / 6.52 mm (BS31): 19.5 cells across, 6.5 … 3.5 down, to 0.06 mm.
 */
const P3: PinDef[] = (
  [
    [1, "3V3", undefined, "3.3 V rail"],
    [2, "DIO", "PA13", "SWDIO (JTMS), AF0 with the pull-up after reset (RM0383 §8.3.2, GPIOA_PUPDR 0x6400 0000)"],
    [3, "SCK", "PA14", "SWCLK (JTCK), AF0 with the pull-down after reset (RM0383 §8.3.2)"],
    [4, "GND"],
  ] as const
).map(([pin, label, mcu, note]) => ({
  id: `P3-${pin}`,
  label,
  x: 19.5,
  y: 7.5 - pin,
  side: "right",
  labelAt: "left",
  kind: label === "GND" ? "gnd" : label === "3V3" ? "power" : "digital",
  stub: WIDTH - 19.5,
  mcu,
  connector: "P3",
  connectorPin: pin,
  note,
  printed: true,
}))

// Part centres from BS31 p1 and the official top render (mm from the outline's top-left).
const parts: PartDef[] = [
  {
    type: "button",
    id: "NRST",
    label: "NRST",
    ...at(15.1, 8.0),
    size: 0.9,
    mcu: "NRST",
    pin: "P1-16",
    printed: true,
  },
  {
    type: "button",
    id: "BOOT0",
    label: "BOOT0",
    ...at(15.1, 12.7),
    size: 0.9,
    printed: true,
  },
  {
    type: "button",
    id: "KEY",
    label: "KEY",
    ...at(41.1, 12.3),
    size: 0.9,
    mcu: "PA0",
    pin: "P1-15",
    printed: true,
  },
  {
    type: "led",
    id: "C13",
    label: "C13",
    ...at(41.8, 5.6),
    color: LED_COLORS.blue.css,
    mcu: "PC13",
    pin: "P1-19",
    printed: true,
  },
  {
    type: "led",
    id: "PWR",
    label: "PWR",
    ...at(41.8, 15.4),
    color: LED_COLORS.red.css,
    printed: true,
  },
  {
    type: "usb",
    id: "USB",
    label: "USB-C",
    ...at(-0.7, 10.4),
    side: "left",
    initial: { on: true },
  },
]

// --- electrical model ---------------------------------------------------------

const GND = "P1-2"
const V33 = "P1-3"
const V5 = "P1-1"
const NRST = "P1-16"
const VBAT = "$VBAT"
const BOOT0 = "$BOOT0"

/**
 * D4 B5819WS (SOD-323 1N5819): 0.18 V at 10 mA, the same reading of Vishay doc 88525 Fig. 3 the H405
 * uses (no B5819WS curve at hand). LDO U2 ME6231A33M3G (Microne datasheet p1): 3.3 V, 500 mA, dropout
 * 125 mV at 100 mA. D1 BAT54C: 0.24 V, the BAT54 maximum at 0.1 mA (the backup domain draws µA).
 */
const D4_VF = 0.18
const ME6231 = { vout: 3.3, dropout: 0.125, imax: 0.5 }
const BAT54_VF = 0.24

const model = (chip: ChipProfile, pins: PinDef[]): Element[] => [
  { kind: "SHORT", nodes: [GND, "P2-19", "P3-4"] },
  { kind: "GND", node: GND },
  { kind: "SHORT", nodes: [V33, "P2-20", "P3-1"] },
  { kind: "SHORT", nodes: [V5, "P2-18"] },
  // USB-C VBUS (a USB 2.0 host port, 500 mA; CC1/CC2 R7/R8 5.1 kΩ ask for default power) → D4 → 5V → U2 → 3V3.
  { kind: "V", plus: "$usb", minus: GND, value: 5 },
  { kind: "SW", a: "$usb", b: "$usbsw", part: "USB", closed: "on" },
  {
    kind: "REG",
    in: "$usbsw",
    out: "$vbus",
    gnd: GND,
    value: 5,
    dropout: 0,
    imax: 0.5,
  },
  { kind: "D", anode: "$vbus", cathode: V5, vf: D4_VF },
  {
    kind: "REG",
    in: V5,
    out: V33,
    gnd: GND,
    value: ME6231.vout,
    dropout: ME6231.dropout,
    imax: ME6231.imax,
  },
  // PWR: 3V3 → R6 5.1 kΩ → red LED D3 → GND. C13: 3V3 → R5 1.5 kΩ → blue LED D2 → PC13. No part numbers: palette Vf.
  { kind: "R", a: V33, b: "$pwra", value: 5.1e3 },
  {
    kind: "D",
    anode: "$pwra",
    cathode: GND,
    vf: LED_COLORS.red.vf,
    part: "PWR",
  },
  { kind: "R", a: V33, b: "$c13a", value: 1.5e3 },
  {
    kind: "D",
    anode: "$c13a",
    cathode: "P1-19",
    vf: LED_COLORS.blue.vf,
    part: "C13",
  },
  // KEY: PA0 → R1 330 Ω → switch → GND.
  { kind: "R", a: "P1-15", b: "$key", value: 330 },
  { kind: "SW", a: "$key", b: GND, part: "KEY", closed: "pressed" },
  // NRST: switch and C3 100 nF to GND; R4 10 kΩ pull-up not fitted, so the MCU's own pull-up holds it.
  { kind: "C", a: NRST, b: GND, value: 100e-9 },
  { kind: "SW", a: NRST, b: GND, part: "NRST", closed: "pressed" },
  // BOOT0: R2 10 kΩ ∥ C1 100 nF to GND, switch to 3V3.
  { kind: "R", a: BOOT0, b: GND, value: 10e3 },
  { kind: "C", a: BOOT0, b: GND, value: 100e-9 },
  { kind: "SW", a: BOOT0, b: V33, part: "BOOT0", closed: "pressed" },
  // BOOT1 (PB2, header P1-5): R3 10 kΩ to GND.
  { kind: "R", a: "P1-5", b: GND, value: 10e3 },
  // VBAT: D1 BAT54C, anodes on 3V3 and VB, common cathode on VBAT; C2 100 nF.
  { kind: "D", anode: V33, cathode: VBAT, vf: BAT54_VF },
  { kind: "D", anode: "P1-20", cathode: VBAT, vf: BAT54_VF },
  { kind: "C", a: VBAT, b: GND, value: 100e-9 },
  ...mcuModel(chip, {
    vdd: V33,
    gnd: GND,
    nrst: NRST,
    boot0: BOOT0,
    pads: [...pins.filter((p) => p.mcu && p.mcu !== "NRST").map((p) => p.id)],
  }),
]

/** F411: PA0 and PB5 are TC, not 5 V tolerant (DS10314 Table 8); on the F401 every pad is FT (DS9716/DS10086 Table 8). */
function rows(chip: ChipProfile): { p1: Row[]; p2: Row[] } {
  if (chip.line !== "f411") return { p1: P1, p2: P2 }
  const tc = (r: Row): Row => (r[1] === "PA0" || r[1] === "PB5" ? [r[0], r[1], [r[2], "Not 5 V tolerant (DS10314 Table 8: TC)"].filter(Boolean).join(". ")] : r)
  return { p1: P1.map(tc), p2: P2.map(tc) }
}

function blackPill(chip: ChipProfile, id: string, mcu: string): ComponentDef {
  const { p1, p2 } = rows(chip)
  const pins: PinDef[] = [...header("P1", p1), ...header("P2", p2), ...P3]
  return {
    id,
    name: `WeAct Black Pill ${chip.name.slice(5, 9)}${chip.line === "f401" ? chip.name.slice(9, 11) : ""}`,
    description: chip.name.slice(0, 11),
    keywords: ["STM32", chip.name.slice(0, 11), "Black Pill", "WeAct", "Cortex-M4"],
    board: { vendor: "WeAct Studio", mcu: chip.name.slice(0, 11), mhz: chip.line === "f411" ? 100 : 84, volts: 3.3, tags: ["USB-C"], photo: "weact-blackpill-f411.webp", core: "Cortex-M4F", memory: BLACKPILL_MEMORY[chip.name.slice(0, 11)], onBoard: ["LED", "user button", "USB-C"], alias: "Black Pill" },
    category: "boards",
    icon: BoardIcon,
    prefix: "U",
    width: WIDTH,
    height: HEIGHT,
    body: boardArt({ p1: P1.map((r) => r[0]), p2: P2.map((r) => r[0]) }, chip.name),
    pins,
    parts,
    model: model(chip, pins),
    hideIdle: true,
    pinsAreSockets: true,
    chip: chip.id,
    mcuPower: V33,
    mcuReset: NRST,
    mcuBoot0: BOOT0,
    mcuVbat: VBAT,
    // Y2 25 MHz (9 pF load, C11/C12 8 pF) on PH0/PH1; Y1 32.768 kHz (6 pF, C9/C10 1.5 pF) on PC14/PC15.
    mcuClocks: {
      hse: { hz: 25e6, kind: "crystal", startup: 2e-3 },
      lse: { hz: 32768, kind: "crystal", startup: 2 },
    },
    info: {
      MCU: mcu,
      LEDs: "C13 blue on PC13 (lit when low, 1.5 kΩ), PWR red",
      Buttons: "KEY on PA0 (330 Ω to GND, no pull-up: enable the internal one; low when pressed), NRST, BOOT0 (to 3V3, 10 kΩ pull-down)",
      USB: "USB-C: D− PA11, D+ PA12, CC1/CC2 5.1 kΩ; VBUS → D4 → 5V → ME6231A33 → 3V3",
      "Not modelled":
        "USB (the device stack and the ROM DFU bootloader), the W25Qxx SPI flash footprint U3 (not fitted), the SWD wire protocol (P3's pins work as PA13/PA14; the built-in debugger reaches the core directly), the SB1 solder bridge across D4",
      Source: "WeAct MiniF4x1Cx V3.1 schematic and board-shape drawing",
    },
  }
}

/** Flash / RAM of each Black Pill's MCU (its notes in `info`). */
const BLACKPILL_MEMORY: Record<string, string> = { STM32F411CE: "512 KB / 128 KB", STM32F401CE: "512 KB / 96 KB", STM32F401CC: "256 KB / 64 KB" }

export const weactBlackpillF411 = blackPill(STM32F411CE, "weact-blackpill-f411", "STM32F411CEU6, Cortex-M4F 100 MHz, 512 KB Flash, 128 KB SRAM; HSE 25 MHz, LSE 32.768 kHz")
export const weactBlackpillF401cc = blackPill(STM32F401CC, "weact-blackpill-f401cc", "STM32F401CCU6, Cortex-M4F 84 MHz, 256 KB Flash, 64 KB SRAM; HSE 25 MHz, LSE 32.768 kHz")
export const weactBlackpillF401ce = blackPill(STM32F401CE, "weact-blackpill-f401ce", "STM32F401CEU6, Cortex-M4F 84 MHz, 512 KB Flash, 96 KB SRAM; HSE 25 MHz, LSE 32.768 kHz")

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [weactBlackpillF411, weactBlackpillF401ce, weactBlackpillF401cc]

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "weact-blackpill-f411": {
    maker: "WeAct Studio",
    docs: [DOCS["weact-minif4x1-v31"], DOCS["microne-me6231"], DOCS["vishay-88525"], DOCS["st-ds10314"], DOCS["st-rm0383"]],
    specs: [],
    modelled: [],
    notModelled: [{ what: "No USB or DFU bootloader" }, { what: "U3 SPI flash not fitted" }, { what: "No SWD wire protocol" }, { what: "No SB1 solder bridge" }],
  },
  "weact-blackpill-f401ce": {
    maker: "WeAct Studio",
    docs: [DOCS["weact-minif4x1-v31"], DOCS["microne-me6231"], DOCS["vishay-88525"], DOCS["st-ds10086"], DOCS["st-rm0383"]],
    specs: [],
    modelled: [],
    notModelled: [{ what: "No USB or DFU bootloader" }, { what: "U3 SPI flash not fitted" }, { what: "No SWD wire protocol" }, { what: "No SB1 solder bridge" }],
  },
  "weact-blackpill-f401cc": {
    maker: "WeAct Studio",
    docs: [DOCS["weact-minif4x1-v31"], DOCS["microne-me6231"], DOCS["vishay-88525"], DOCS["st-ds9716"], DOCS["st-rm0383"]],
    specs: [],
    modelled: [],
    notModelled: [{ what: "No USB or DFU bootloader" }, { what: "U3 SPI flash not fitted" }, { what: "No SWD wire protocol" }, { what: "No SB1 solder bridge" }],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
