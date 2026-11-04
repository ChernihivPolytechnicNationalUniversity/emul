/**
 * 24Cxx serial EEPROM (24AA/24LC/AT24C datasheets): A0–A2 set the I²C address, SDA/SCL are
 * the open-drain bus, WP high blocks writes. Drawn as a functional symbol (bus on the left,
 * address straps on the right) with the DIP-8 pin numbers in the notes. The behaviour lives
 * in `src/sim/digital.ts` (Eeprom24); this is the symbol and the analog face of the pins.
 */
import { MemoryIcon } from "../icons"
import type { ComponentDef } from "../types"
import { DOCS } from "../datasheets/docs"

const W = 6
const H = 6

const EEPROM_PIN = { voltage: 6.5, fail: "open" } as const

export const eeprom24c: ComponentDef = {
  id: "eeprom-24c",
  name: "EEPROM 24Cxx",
  description: "I²C serial EEPROM",
  keywords: ["EEPROM", "24C02", "24LC256", "AT24C", "I2C", "memory", "storage"],
  category: "ics",
  icon: MemoryIcon,
  prefix: "U",
  defaults: { value: "24C02" },
  fields: [
    {
      key: "value",
      label: "Part",
      type: "select",
      options: [
        { value: "24C01", label: "24C01 · 128 B" },
        { value: "24C02", label: "24C02 · 256 B" },
        { value: "24C04", label: "24C04 · 512 B" },
        { value: "24C08", label: "24C08 · 1 KB" },
        { value: "24C16", label: "24C16 · 2 KB" },
        { value: "24C32", label: "24C32 · 4 KB" },
        { value: "24C64", label: "24C64 · 8 KB" },
        { value: "24C128", label: "24C128 · 16 KB" },
        { value: "24C256", label: "24C256 · 32 KB" },
      ],
    },
  ],
  width: W,
  height: H,
  pins: [
    { id: "SCL", label: "SCL", x: 1, y: 1, side: "left", labelAt: "right", kind: "digital", note: "I²C clock (DIP pin 6)" },
    { id: "SDA", label: "SDA", x: 1, y: 2, side: "left", labelAt: "right", kind: "digital", note: "I²C data, open drain (DIP pin 5)" },
    { id: "WP", label: "WP", x: 1, y: 4, side: "left", labelAt: "right", kind: "digital", note: "Write protect, high = read only (DIP pin 7)" },
    { id: "A0", label: "A0", x: W - 1, y: 1, side: "right", labelAt: "left", kind: "digital", note: "Address bit 0 (DIP pin 1)" },
    { id: "A1", label: "A1", x: W - 1, y: 2, side: "right", labelAt: "left", kind: "digital", note: "Address bit 1 (DIP pin 2)" },
    { id: "A2", label: "A2", x: W - 1, y: 3, side: "right", labelAt: "left", kind: "digital", note: "Address bit 2 (DIP pin 3)" },
    { id: "VCC", label: "VCC", x: 3, y: 0, side: "top", labelAt: "right", kind: "power", note: "1.7–5.5 V (DIP pin 8)" },
    { id: "GND", label: "GND", x: 3, y: H, side: "bottom", labelAt: "right", kind: "gnd", note: "DIP pin 4" },
  ],
  body: [
    // Light body so the pin names (drawn inside by the renderer) stay readable, like the MCU symbol.
    { type: "rect", x: 1, y: 0.5, w: W - 2, h: H - 1, rx: 0.2, fill: "board" },
    { type: "text", x: W / 2, y: 3.15, text: "{value}", size: 0.4 },
    { type: "text", x: W / 2, y: 5.2, text: "I²C EEPROM", size: 0.24, muted: true },
    { type: "text", x: W / 2 + 1.4, y: 0.15, text: "{ref}", size: 0.3, muted: true },
  ],
  parts: [],
  model: [
    // Supply: a few hundred µA active, and the pins as 3.3 V logic. SDA is open drain: the
    // part pulls low or lets go; SCL, A0–A2 and WP only listen.
    // Absolute maximum 6.5 V on VCC and on any pin (24Cxx datasheets): past that the die is gone.
    { kind: "R", a: "VCC", b: "GND", value: 10e3, limits: { voltage: 6.5, fail: "short" } },
    { kind: "GPIO", node: "SDA", vdd: 3.3, limits: EEPROM_PIN },
    { kind: "GPIO", node: "SCL", vdd: 3.3, limits: EEPROM_PIN },
    { kind: "GPIO", node: "A0", vdd: 3.3, limits: EEPROM_PIN },
    { kind: "GPIO", node: "A1", vdd: 3.3, limits: EEPROM_PIN },
    { kind: "GPIO", node: "A2", vdd: 3.3, limits: EEPROM_PIN },
    { kind: "GPIO", node: "WP", vdd: 3.3, limits: EEPROM_PIN },
  ],
  datasheet: {
    maker: "Microchip",
    docs: [DOCS["mchp-ds21709j"], DOCS["mchp-ds21203m"]],
    specs: [],
    characteristics: [
      { kind: "supply", value: { min: 1.7, max: 5.5 }, limit: { max: 6.5 }, cite: { page: 1, at: "Device Selection Table" }, limitCite: { page: 2, at: "Absolute Maximum Ratings" } },
      { kind: "busClock", value: { max: 400e3 }, cite: { page: 3, at: "Table 1-2" } },
      { kind: "address", set: [0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57], cite: { doc: "mchp-ds21203m", page: 8, at: "Device Addressing" } },
      { kind: "eeprom", value: { max: 32768 }, cite: { doc: "mchp-ds21203m", page: 1, at: "Description" } },
      { kind: "execution", value: { max: 5e-3 }, cite: { page: 3, at: "Table 1-2" } },
      { kind: "supplyCurrent", value: { typ: 0.1e-3, max: 3e-3 }, at: [{ supply: 5.5 }], cite: { page: 2, at: "Table 1-1" } },
      { kind: "quiescent", value: { max: 1e-6 }, cite: { page: 2, at: "Table 1-1" } },
      { kind: "temperature", value: { min: -40, max: 85 }, cite: { page: 1, at: "Temperature Ranges" } },
    ],
    modelled: [
      { what: "Address 1010 A2 A1 A0", cite: { doc: "mchp-ds21203m", page: 8, at: "Device Addressing" }, test: "tests/sim/open746-peripherals.test.ts" },
      { what: "Byte and page writes", cite: { page: 8, at: "Page Write" }, test: "tests/sim/nucleo-i2c.test.ts" },
      { what: "Page writes wrap within page", cite: { page: 8, at: "Page Write" } },
      { what: "Random and sequential reads", cite: { page: 10, at: "Read Operation" }, test: "tests/sim/mcu-i2c-v2.test.ts" },
      { what: "NACKs during 5 ms write", cite: { page: 9, at: "Acknowledge Polling" }, test: "tests/firmware/mcu-i2c.test.ts" },
      { what: "Keeps bytes through power-off", test: "tests/sim/nucleo-i2c.test.ts" },
      { what: "WP high blocks writes", cite: { page: 5, at: "Write-Protect (WP)" } },
      { what: "Sizes 24C01 to 24C256" },
      { what: "Block select on 24C04–24C16" },
      { what: "Two-byte address from 24C32", cite: { doc: "mchp-ds21203m", page: 8, at: "Device Addressing" } },
      { what: "Dead past 6.5 V", cite: { page: 2, at: "Absolute Maximum Ratings" } },
    ],
    notModelled: [
      { what: "24XX02 ignores A0–A2 pins", cite: { page: 5, at: "A0, A1, A2" } },
      { what: "No bus timing checks", cite: { page: 3, at: "Table 1-2" } },
      { what: "100 kHz below 2.5 V", cite: { page: 3, at: "Table 1-2" } },
      { what: "Supply current is fixed", cite: { page: 2, at: "Table 1-1" } },
      { what: "Thresholds fixed for 3.3 V", cite: { page: 2, at: "Table 1-1" } },
      { what: "Endurance and data retention", cite: { page: 1, at: "Features" } },
    ],
  },
}

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [eeprom24c]
