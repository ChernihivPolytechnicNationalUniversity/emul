/**
 * SSD1306 OLED modules (`src/sim/ssd1306.ts` holds the controller and its sources): the 0.96"
 * 128 × 64 and 0.91" 128 × 32 four-pin I²C boards, and the 0.96" seven-pin SPI board.
 *
 * No maker documents these boards. As the vendor manuals and forums describe them: a 3.3 V
 * regulator feeding the controller so the board takes 3.3–5 V, I²C pull-ups on the board (10 kΩ,
 * the value most often reported, to the regulated rail), on the I²C boards an RC on RES# (10 kΩ,
 * 100 nF) that resets the controller at power-up, and on the SPI board RES# brought out to be
 * pulsed by the host. The controller's inputs carry the sheet's VDD + 0.3 V absolute maximum.
 */
import { OLED_SUPPLY_KEY } from "@/sim/ssd1306"
import { OledIcon } from "../icons"
import type { ComponentDef, ModelElement, PinDef } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

/**
 * SDA, SCL and the SPI inputs: Table 11-1 rates Vin to VDD + 0.3 V, where the pins' ESD diodes
 * to VDD start to conduct; past it they carry the excess into VDD, and what breaks the chip is
 * that current, not the volts. Solomon gives no figure for it: JESD78's latch-up I-test level
 * (±100 mA), which a qualified CMOS part survives, stands in. So a 5 V Arduino's pull-ups
 * (≈ 35 kΩ) on the module's 10 kΩ ones push tens of µA in, as on the bench, harmlessly.
 */
const INPUT_CLAMP = { injection: 0.1, rail: "$vdd" } as const

const COLOUR_FIELD = { key: "colour", label: "Colour", type: "select" as const, options: [{ value: "white", label: "White" }, { value: "blue", label: "Blue" }, { value: "yellow-blue", label: "Yellow top band, blue" }] }

const supply: ModelElement[] = [
  { kind: "REG", in: "VCC", out: "$vdd", gnd: "GND", value: 3.3, label: "3.3 V regulator" },
  { kind: "R", a: "$vdd", b: "GND", value: 1e9, live: OLED_SUPPLY_KEY, label: "SSD1306 and panel" },
]

const body = (w: number, h: number, glassH: number) => [
  { type: "rect" as const, x: 0.6, y: 0.3, w: w - 1.2, h: h - 0.6, rx: 0.3, fill: "board" as const },
  { type: "rect" as const, x: 1.4, y: 1.5, w: w - 2.8, h: glassH + 0.4, rx: 0.1, fill: "chip" as const },
  { type: "text" as const, x: w - 0.8, y: h - 0.7, text: "{ref}", size: 0.32, muted: true, anchor: "end" as const },
]

function i2cModule(id: string, name: string, rows: 64 | 32): ComponentDef {
  const w = 12
  const glassH = rows === 64 ? 4.8 : 2.4
  const h = glassH + 3.2
  const pins: PinDef[] = [
    { id: "GND", label: "GND", x: 3, y: 0, side: "top", labelAt: "bottom", kind: "gnd" },
    { id: "VCC", label: "VCC", x: 5, y: 0, side: "top", labelAt: "bottom", kind: "power", note: "3.3–5 V into the board's 3.3 V regulator" },
    { id: "SCL", label: "SCL", x: 7, y: 0, side: "top", labelAt: "bottom", kind: "digital", note: "I²C clock, 400 kHz maximum; pulled up on the board" },
    { id: "SDA", label: "SDA", x: 9, y: 0, side: "top", labelAt: "bottom", kind: "digital", note: "I²C data; pulled up on the board" },
  ]
  return {
    id,
    name,
    description: `SSD1306 OLED, 128 × ${rows}, on I²C at 0x3C. Dark until the firmware enables the charge pump (8Dh 14h) and turns the display on (AFh); the RAM holds noise until it is cleared. Board details (regulator, pull-ups, RC reset) from vendor and forum descriptions.`,
    category: "displays",
    keywords: ["OLED", "SSD1306", "I2C", "IIC", `128x${rows}`, rows === 64 ? "0.96" : "0.91", "display"],
    icon: OledIcon,
    prefix: "DS",
    width: w,
    height: h,
    defaults: { address: "0x3C", colour: rows === 64 ? "white" : "white" },
    fields: [{ key: "address", label: "Address", type: "select", options: [{ value: "0x3C", label: "0x3C (as shipped)" }, { value: "0x3D", label: "0x3D (resistor moved)" }] }, COLOUR_FIELD],
    pins,
    body: body(w, h, glassH),
    parts: [{ type: "screen", id: "GLASS", label: "Display", x: 1.6, y: 1.7, w: w - 3.2, h: glassH }],
    model: [
      ...supply,
      { kind: "GPIO", node: "SDA", vddNode: "$vdd", gndNode: "GND", drive: { ohms: 0.4 / 3e-3 }, clamp: INPUT_CLAMP },
      { kind: "GPIO", node: "SCL", vddNode: "$vdd", gndNode: "GND", clamp: INPUT_CLAMP },
      { kind: "R", a: "$vdd", b: "SDA", value: 10e3, label: "SDA pull-up" },
      { kind: "R", a: "$vdd", b: "SCL", value: 10e3, label: "SCL pull-up" },
    ],
    info: { Source: "Solomon Systech SSD1306 Rev 1.1; board as vendor manuals and forums describe it (no maker's schematic)" },
  }
}

export const oledI2c = i2cModule("oled-ssd1306-i2c", "OLED 0.96\" I²C (SSD1306)", 64)
export const oledI2c32 = i2cModule("oled-ssd1306-i2c-32", "OLED 0.91\" I²C (SSD1306)", 32)

const SPI_W = 14
const SPI_GLASS = 4.8
const SPI_H = SPI_GLASS + 3.2

export const oledSpi: ComponentDef = {
  id: "oled-ssd1306-spi",
  name: "OLED 0.96\" SPI (SSD1306)",
  description:
    "SSD1306 OLED, 128 × 64, 4-wire SPI: D0 clock (10 MHz max), D1 data, DC picks command or data with every eighth bit, CS selects. Pulse RES low (3 µs or more) before use — nothing on the board does it. Dark until the charge pump (8Dh 14h) and the display (AFh) are on.",
  category: "displays",
  keywords: ["OLED", "SSD1306", "SPI", "128x64", "0.96", "display", "7-pin"],
  icon: OledIcon,
  prefix: "DS",
  width: SPI_W,
  height: SPI_H,
  defaults: { colour: "white" },
  fields: [COLOUR_FIELD],
  pins: [
    { id: "GND", label: "GND", x: 1, y: 0, side: "top", labelAt: "bottom", kind: "gnd" },
    { id: "VCC", label: "VCC", x: 3, y: 0, side: "top", labelAt: "bottom", kind: "power", note: "3.3–5 V into the board's 3.3 V regulator" },
    { id: "D0", label: "D0", x: 5, y: 0, side: "top", labelAt: "bottom", kind: "digital", note: "SCLK" },
    { id: "D1", label: "D1", x: 7, y: 0, side: "top", labelAt: "bottom", kind: "digital", note: "SDIN (MOSI)" },
    { id: "RES", label: "RES", x: 9, y: 0, side: "top", labelAt: "bottom", kind: "digital", inverted: true, note: "Reset, active low: at least 3 µs" },
    { id: "DC", label: "DC", x: 11, y: 0, side: "top", labelAt: "bottom", kind: "digital", note: "Data (1) or command (0)" },
    { id: "CS", label: "CS", x: 13, y: 0, side: "top", labelAt: "bottom", kind: "digital", inverted: true, note: "Chip select, active low" },
  ],
  body: body(SPI_W, SPI_H, SPI_GLASS),
  parts: [{ type: "screen", id: "GLASS", label: "Display", x: 1.6, y: 1.7, w: SPI_W - 3.2, h: SPI_GLASS }],
  model: [...supply, ...["D0", "D1", "RES", "DC", "CS"].map((node): ModelElement => ({ kind: "GPIO", node, vddNode: "$vdd", gndNode: "GND", clamp: INPUT_CLAMP }))],
  info: { Source: "Solomon Systech SSD1306 Rev 1.1; board as vendor manuals and forums describe it (no maker's schematic)" },
}

export const oledModules: ComponentDef[] = [oledI2c, oledI2c32, oledSpi]

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = oledModules

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "oled-ssd1306-i2c": {
    maker: "Solomon Systech",
    docs: [DOCS["solomon-ssd1306"]],
    specs: [
      { label: "Logic supply VDD", value: "1.65–3.3 V", cite: { page: 48, at: "Table 12-1" } },
      { label: "VDD (abs max)", value: "−0.3 to +4 V", cite: { page: 47, at: "Table 11-1" } },
      { label: "Input voltage (abs max)", value: "VSS − 0.3 to VDD + 0.3 V", cite: { page: 47, at: "Table 11-1" } },
      { label: "I²C clock", value: "2.5 µs cycle min (400 kHz)", cite: { page: 54, at: "Table 13-6" } },
      { label: "Address", value: "0x3C or 0x3D (SA0)", cite: { page: 19, at: "§8.1.5" } },
      { label: "Segment current", value: "100 µA at contrast FFh", cite: { page: 48, at: "Table 12-1" } },
    ],
    modelled: [
      { what: "Full command table, multi-byte included", cite: { page: 28, at: "Table 9-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Page, horizontal, vertical addressing", cite: { page: 34, at: "§10.1.3" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Offset, start line, scan direction", cite: { page: 38, at: "Table 10-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "DAh 02h interlaces 64-row glass", cite: { page: 40, at: "Table 10-3" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Dark until 8Dh 14h", cite: { page: 62, at: "Charge Pump Regulator" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Brightness and current track contrast", cite: { page: 48, at: "Table 12-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "IDD, ICC and segment current", cite: { page: 48, at: "Table 12-1" }, test: "tests/sim/nucleo-oled.test.ts" },
      { what: "Continuous scroll at frame rate", cite: { page: 44, at: "§10.2.1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "I²C at 0x3C or 0x3D", cite: { page: 20, at: "§8.1.5.2" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Control byte Co and D/C#", cite: { page: 20, at: "§8.1.5.2" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "SCL checked against 2.5 µs", cite: { page: 54, at: "Table 13-6" }, test: "tests/sim/nucleo-oled.test.ts" },
      { what: "400 kHz firmware runs unwarned", cite: { page: 54, at: "Table 13-6" }, test: "tests/sim/nucleo-oled.test.ts" },
    ],
    notModelled: [
      { what: "6800/8080 parallel, 3-wire SPI", cite: { page: 15, at: "Table 8-1" } },
      { what: "I²C set-up, hold, start/stop timing", cite: { page: 54, at: "Table 13-6" } },
      { what: "Oscillator setting (D5h) and spread", cite: { page: 49, at: "Table 13-1" } },
      { what: "Scrolls fixed at 370 kHz", cite: { page: 49, at: "Table 13-1" } },
      { what: "Pre-charge and VCOMH on brightness", cite: { page: 40, at: "§10.1.17" } },
      { what: "Partial vertical scroll area (A3h)", cite: { page: 46, at: "§10.2.5" } },
      { what: "100 ms turn-on after AFh", cite: { page: 27, at: "§8.9" } },
      { what: "Board values from vendors, forums" },
    ],
  },
  "oled-ssd1306-i2c-32": {
    maker: "Solomon Systech",
    docs: [DOCS["solomon-ssd1306"]],
    specs: [
      { label: "Logic supply VDD", value: "1.65–3.3 V", cite: { page: 48, at: "Table 12-1" } },
      { label: "VDD (abs max)", value: "−0.3 to +4 V", cite: { page: 47, at: "Table 11-1" } },
      { label: "Input voltage (abs max)", value: "VSS − 0.3 to VDD + 0.3 V", cite: { page: 47, at: "Table 11-1" } },
      { label: "I²C clock", value: "2.5 µs cycle min (400 kHz)", cite: { page: 54, at: "Table 13-6" } },
      { label: "Address", value: "0x3C or 0x3D (SA0)", cite: { page: 19, at: "§8.1.5" } },
      { label: "Segment current", value: "100 µA at contrast FFh", cite: { page: 48, at: "Table 12-1" } },
    ],
    modelled: [
      { what: "Full command table, multi-byte included", cite: { page: 28, at: "Table 9-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Page, horizontal, vertical addressing", cite: { page: 34, at: "§10.1.3" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Offset, start line, scan direction", cite: { page: 38, at: "Table 10-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "DAh 02h keeps 128×32 upright", cite: { page: 40, at: "Table 10-3" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Dark until 8Dh 14h", cite: { page: 62, at: "Charge Pump Regulator" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Brightness and current track contrast", cite: { page: 48, at: "Table 12-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Continuous scroll at frame rate", cite: { page: 44, at: "§10.2.1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "I²C at 0x3C or 0x3D", cite: { page: 20, at: "§8.1.5.2" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Control byte Co and D/C#", cite: { page: 20, at: "§8.1.5.2" }, test: "tests/sim/ssd1306.test.ts" },
    ],
    notModelled: [
      { what: "6800/8080 parallel, 3-wire SPI", cite: { page: 15, at: "Table 8-1" } },
      { what: "I²C set-up, hold, start/stop timing", cite: { page: 54, at: "Table 13-6" } },
      { what: "Oscillator setting (D5h) and spread", cite: { page: 49, at: "Table 13-1" } },
      { what: "Scrolls fixed at 370 kHz", cite: { page: 49, at: "Table 13-1" } },
      { what: "Pre-charge and VCOMH on brightness", cite: { page: 40, at: "§10.1.17" } },
      { what: "Partial vertical scroll area (A3h)", cite: { page: 46, at: "§10.2.5" } },
      { what: "100 ms turn-on after AFh", cite: { page: 27, at: "§8.9" } },
      { what: "Board values from vendors, forums" },
    ],
  },
  "oled-ssd1306-spi": {
    maker: "Solomon Systech",
    docs: [DOCS["solomon-ssd1306"]],
    specs: [
      { label: "Logic supply VDD", value: "1.65–3.3 V", cite: { page: 48, at: "Table 12-1" } },
      { label: "VDD (abs max)", value: "−0.3 to +4 V", cite: { page: 47, at: "Table 11-1" } },
      { label: "Input voltage (abs max)", value: "VSS − 0.3 to VDD + 0.3 V", cite: { page: 47, at: "Table 11-1" } },
      { label: "SPI clock", value: "100 ns cycle min (10 MHz)", cite: { page: 52, at: "Table 13-4" } },
      { label: "Reset pulse", value: "RES# low 3 µs min", cite: { page: 49, at: "Table 13-1" } },
      { label: "Segment current", value: "100 µA at contrast FFh", cite: { page: 48, at: "Table 12-1" } },
    ],
    modelled: [
      { what: "Full command table, multi-byte included", cite: { page: 28, at: "Table 9-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Page, horizontal, vertical addressing", cite: { page: 34, at: "§10.1.3" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Offset, start line, scan direction", cite: { page: 38, at: "Table 10-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "DAh 02h interlaces 64-row glass", cite: { page: 40, at: "Table 10-3" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Dark until 8Dh 14h", cite: { page: 62, at: "Charge Pump Regulator" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Brightness and current track contrast", cite: { page: 48, at: "Table 12-1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Continuous scroll at frame rate", cite: { page: 44, at: "§10.2.1" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "4-wire SPI with D/C#", cite: { page: 17, at: "§8.1.3" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Idle until RES# pulses", cite: { page: 17, at: "§8.1.3" }, test: "tests/sim/ssd1306.test.ts" },
      { what: "Warns short RES#, fast SCLK", cite: { page: 49, at: "Table 13-1" } },
      { what: "Warns undriven RES#", cite: { page: 49, at: "Table 13-1" } },
    ],
    notModelled: [
      { what: "6800/8080 parallel, 3-wire SPI", cite: { page: 15, at: "Table 8-1" } },
      { what: "SPI timing beyond clock cycle", cite: { page: 52, at: "Table 13-4" } },
      { what: "Oscillator setting (D5h) and spread", cite: { page: 49, at: "Table 13-1" } },
      { what: "Scrolls fixed at 370 kHz", cite: { page: 49, at: "Table 13-1" } },
      { what: "Pre-charge and VCOMH on brightness", cite: { page: 40, at: "§10.1.17" } },
      { what: "Partial vertical scroll area (A3h)", cite: { page: 46, at: "§10.2.5" } },
      { what: "100 ms turn-on after AFh", cite: { page: 27, at: "§8.9" } },
      { what: "Board values from vendors, forums" },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
