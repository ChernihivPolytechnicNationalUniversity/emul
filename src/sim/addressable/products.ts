/**
 * The components the palette places: one per part, as a simulator's library lists them —
 * WS2811 and WS2913 are two components even though they share a pinout. A component's
 * `parts` are the revisions and packages of that one part, picked in the inspector. `layout`
 * names the pinout the symbol and the electrical model are built from (shared by every part
 * wired the same way); `chips` > 1 is a module (a stick, a ring, a matrix) wired DO → DIN inside.
 */
import { ALL_PARTS } from "./parts"
import type { ChipSpec } from "./spec"

export type ProductShape =
  | { kind: "pixel" }
  | { kind: "driver" }
  | { kind: "stick"; count: number }
  | { kind: "ring"; count: number }
  | { kind: "matrix"; columns: number; rows: number }

/** Pinouts: which pins a symbol has and how the model wires them. */
export type Layout = "pixel" | "pixel-12v" | "pixel-6pin" | "pixel-backup" | "pixel-backup-12v" | "ws2815" | "pixel-relay" | "module" | "driver-3" | "driver-3-backup" | "driver-4" | "driver-4-backup" | "driver-5-backup" | "driver-5" | "ws2801"

export type Product = {
  id: string
  name: string
  description: string
  /** Search words the short description leaves out. */
  keywords?: string[]
  category: "Addressable LEDs" | "LED drivers"
  layout: Layout
  parts: readonly ChipSpec[]
  shape: ProductShape
}

const byPart = new Map(ALL_PARTS.map((s) => [s.part, s]))
const parts = (...names: string[]) =>
  names.map((n) => {
    const s = byPart.get(n)
    if (!s) throw new Error(`no such part: ${n}`)
    return s
  })

const PIXEL = { kind: "pixel" } as const
const DRIVER = { kind: "driver" } as const
const LEDS = "Addressable LEDs" as const
const DRIVERS = "LED drivers" as const

/** 5 V WS2812B-class parts the usual modules are built from. */
const MODULE_PARTS = parts("WS2812B", "WS2812B-V5", "WS2812B-V6", "WS2812B-V7", "WS2812B-Mini", "WS2812B-2020", "WS2812C", "WS2812E", "WS2812E-V5", "SK6812", "SK6812RGBW")

export const PRODUCTS: Product[] = [
  // --- integrated LEDs ---
  { id: "ws2812b", name: "WS2812B", description: "Addressable RGB LED, 5 V", keywords: ["5050", "3535", "2020"], category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812B", "WS2812B-V5", "WS2812B-V6", "WS2812B-V7", "WS2812B-Mini", "WS2812B-2020") },
  { id: "ws2812", name: "WS2812", description: "Addressable RGB LED, 4-pin", keywords: ["5050", "2020"], category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812") },
  { id: "ws2812-6pin", name: "WS2812 (6-pin)", description: "Original 6-pin addressable RGB LED", category: LEDS, layout: "pixel-6pin", shape: PIXEL, parts: parts("WS2812-6P") },
  { id: "ws2812s", name: "WS2812S", description: "Addressable RGB LED, 6-pin", keywords: ["5050"], category: LEDS, layout: "pixel-6pin", shape: PIXEL, parts: parts("WS2812S") },
  { id: "ws2812a", name: "WS2812A", description: "Addressable RGB LED, 5054", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812A") },
  { id: "ws2812c", name: "WS2812C", description: "Low-current addressable RGB LED", keywords: ["5050", "2020"], category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812C", "WS2812C-2020") },
  { id: "ws2812d", name: "WS2812D", description: "Through-hole addressable RGB LED", keywords: ["5 mm", "8 mm"], category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812D-F5", "WS2812D-F8") },
  { id: "ws2812e", name: "WS2812E", description: "Addressable RGB LED, 5050", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812E", "WS2812E-V5") },
  { id: "sk6812", name: "SK6812", description: "Addressable RGB LED, WS2812-compatible, 5050", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("SK6812") },
  { id: "sk6812rgbw", name: "SK6812RGBW", description: "Addressable RGBW LED, 5050", keywords: ["white", "GRBW"], category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("SK6812RGBW") },
  { id: "ws2813", name: "WS2813", description: "Addressable RGB LED, backup input", keywords: ["BIN"], category: LEDS, layout: "pixel-backup", shape: PIXEL, parts: parts("WS2813", "WS2813C", "WS2813-2016", "WS2813E", "WS2813-Mini", "WS2813A-V7") },
  { id: "ws2813b", name: "WS2813B", description: "Addressable RGB LED with BI/BO", keywords: ["backup"], category: LEDS, layout: "pixel-relay", shape: PIXEL, parts: parts("WS2813B-V5", "WS2813B-V6", "WS2813C-2121") },
  { id: "ws2813b-rgbw", name: "WS2813B-RGBW", description: "Addressable RGBW LED, backup input", keywords: ["white"], category: LEDS, layout: "pixel-backup", shape: PIXEL, parts: parts("WS2813B-RGBW") },
  { id: "ws2815", name: "WS2815", description: "12 V addressable RGB LED", keywords: ["backup", "BIN"], category: LEDS, layout: "ws2815", shape: PIXEL, parts: parts("WS2815") },
  { id: "ws2815b", name: "WS2815B", description: "12 V dual-input addressable LED", keywords: ["DIN2", "RGBW", "backup"], category: LEDS, layout: "pixel-backup-12v", shape: PIXEL, parts: parts("WS2815B", "WS2815B-RGBW") },
  { id: "ws2815b-4pin", name: "WS2815B (4-pin)", description: "12 V single-input addressable LED", keywords: ["RGBW"], category: LEDS, layout: "pixel-12v", shape: PIXEL, parts: parts("WS2815B-4P", "WS2815B-RGBW-4P") },
  { id: "ws2816", name: "WS2816", description: "16-bit addressable RGB LED", keywords: ["BI/BO", "5050", "2121"], category: LEDS, layout: "pixel-relay", shape: PIXEL, parts: parts("WS2816B", "WS2816C-2121") },
  { id: "ws2916", name: "WS2916", description: "16-bit RGB LED, current gain", keywords: ["BI/BO"], category: LEDS, layout: "pixel-relay", shape: PIXEL, parts: parts("WS2916A", "WS2916B") },
  { id: "ws2916a-rgbw", name: "WS2916A-RGBW", description: "16-bit addressable RGBW LED", keywords: ["white", "current gain", "backup"], category: LEDS, layout: "pixel-backup", shape: PIXEL, parts: parts("WS2916A-RGBW") },
  // --- modules ---
  { id: "led-stick-8", name: "LED stick ×8", description: "Stick of 8 addressable LEDs", category: LEDS, layout: "module", shape: { kind: "stick", count: 8 }, parts: MODULE_PARTS },
  { id: "led-ring-12", name: "LED ring ×12", description: "Ring of 12 addressable LEDs", category: LEDS, layout: "module", shape: { kind: "ring", count: 12 }, parts: MODULE_PARTS },
  { id: "led-ring-16", name: "LED ring ×16", description: "Ring of 16 addressable LEDs", category: LEDS, layout: "module", shape: { kind: "ring", count: 16 }, parts: MODULE_PARTS },
  { id: "led-ring-24", name: "LED ring ×24", description: "Ring of 24 addressable LEDs", category: LEDS, layout: "module", shape: { kind: "ring", count: 24 }, parts: MODULE_PARTS },
  { id: "led-matrix-8x8", name: "LED matrix 8×8", description: "8×8 addressable LED matrix", category: LEDS, layout: "module", shape: { kind: "matrix", columns: 8, rows: 8 }, parts: MODULE_PARTS },
  // --- drivers ---
  { id: "ws2811", name: "WS2811", description: "3-channel constant-current LED driver, single-wire", category: DRIVERS, layout: "driver-3", shape: DRIVER, parts: parts("WS2811", "WS2811-2011") },
  { id: "ws2913", name: "WS2913", description: "3-channel 16-bit LED driver", keywords: ["current gain"], category: DRIVERS, layout: "driver-3", shape: DRIVER, parts: parts("WS2913") },
  { id: "ws2818", name: "WS2818", description: "3-channel dual-input LED driver", keywords: ["DIN2", "backup"], category: DRIVERS, layout: "driver-3-backup", shape: DRIVER, parts: parts("WS2818B", "WS2818F") },
  { id: "ws2814", name: "WS2814", description: "4-channel RGBW LED driver", category: DRIVERS, layout: "driver-4", shape: DRIVER, parts: parts("WS2814A", "WS2814F") },
  { id: "ws2814b", name: "WS2814B", description: "4-channel RGBW dual-input LED driver", keywords: ["BIN", "backup"], category: DRIVERS, layout: "driver-4-backup", shape: DRIVER, parts: parts("WS2814B") },
  { id: "ws2805", name: "WS2805", description: "5-channel RGBWW LED driver", keywords: ["white", "BIN", "backup"], category: DRIVERS, layout: "driver-5-backup", shape: DRIVER, parts: parts("WS2805") },
  { id: "ws2914", name: "WS2914", description: "16-bit RGBW LED driver", keywords: ["current gain", "BIN", "backup"], category: DRIVERS, layout: "driver-5-backup", shape: DRIVER, parts: parts("WS2914") },
  { id: "ws2915", name: "WS2915", description: "5-channel 16-bit LED driver", keywords: ["current gain"], category: DRIVERS, layout: "driver-5", shape: DRIVER, parts: parts("WS2915") },
  { id: "ws2801", name: "WS2801", description: "3-channel two-wire LED driver", keywords: ["clock", "SPI"], category: DRIVERS, layout: "ws2801", shape: DRIVER, parts: parts("WS2801") },
]

const byId = new Map(PRODUCTS.map((p) => [p.id, p]))

export const productById = (id: string) => byId.get(id)

/** Chips in one object of a product. */
export function chipCount(shape: ProductShape): number {
  switch (shape.kind) {
    case "stick":
    case "ring":
      return shape.count
    case "matrix":
      return shape.columns * shape.rows
    default:
      return 1
  }
}

/** The part an object of a product is, by its props (the first of the list by default). */
export const partOf = (product: Product, props: Record<string, string>) => product.parts.find((p) => p.part === props.value) ?? product.parts[0]

// --- datasheet numbers ---------------------------------------------------------------------------

/**
 * Where a number is: the PDF page (url#page=N, 1-based) of the product's first document, or of
 * `doc` (a DocRecord key the product's record lists).
 */
export type SheetAt = { page: number; doc?: string }
/** A number as printed: base SI (V, A, Hz, s, m, °C). */
export type SheetValue = { min?: number; typ?: number; max?: number } & SheetAt
/** One value per LED colour. */
export type SheetColours = Partial<Record<"R" | "G" | "B", { min?: number; typ?: number; max?: number }>> & SheetAt

/**
 * The key numbers of a product, read from its datasheet (the first document of its record unless
 * a cite names another), each with its page; the inspector's characteristics and the record's
 * not-modelled list are generated from this table (src/schematic/components/addressable.ts).
 * A field the sheet does not give is absent: nothing here is filled in from another part.
 */
export type SheetNumbers = {
  /** Operating supply (the "Ratings" row Worldsemi prints under absolute maximum); `abs` when a separate maximum is printed. */
  supply: SheetValue & { abs?: number; absPage?: number }
  /** Forward voltage of each LED in the package. */
  forwardVoltage?: SheetColours
  /** LED current (a pixel) or sink current (a driver) per channel, or for the package when the sheet gives the sum. */
  current?: SheetValue & { per?: "channel" | "package"; abs?: number; absPage?: number }
  /** White channel current, when it differs. */
  currentWhite?: SheetValue
  /** Dominant wavelength of each colour. */
  wavelength?: SheetColours
  /** Constant-current feedback voltage (WS2801's xFB pins). */
  feedback?: SheetValue
  /** Data rate (single wire) or clock (two wire). */
  rate?: SheetValue
  /** Reset / latch low time that ends a frame. */
  reset?: SheetValue
  /** Input high threshold: a fraction of a rail, or volts. */
  vih?: ({ times: number; rail: "VDD" | "VCC" } | { volts: number; typ?: true }) & SheetAt
  /** Operating temperature. */
  temperature?: SheetValue
  /** DIN → DO (or CKI → CKO) propagation. */
  delay?: SheetValue & { path: readonly [string, string] }
  /** Supply current with the outputs off. */
  quiescent?: SheetValue
  /** Pages of numbers the model leaves out. */
  intensity?: SheetAt
  /** The switching table's fall time and input capacitance. */
  switching?: SheetAt
  /** Further features the sheet describes that the model leaves out, each in five words at most. */
  left?: readonly ({ what: string } & SheetAt)[]
}

const ns = 1e-9
const us = 1e-6
const mA = 1e-3
const nm = 1e-9
const DIN_DO = ["DIN", "DO"] as const

/** WS2812B (2013), the sheet the modules' default part comes from. */
const WS2812B_2013: SheetNumbers = {
  supply: { min: 3.5, max: 5.3, page: 2 },
  forwardVoltage: { R: { min: 2.0, max: 2.2 }, G: { min: 3.0, max: 3.4 }, B: { min: 3.0, max: 3.4 }, page: 3 },
  wavelength: { R: { min: 620 * nm, max: 625 * nm }, G: { min: 522 * nm, max: 525 * nm }, B: { min: 465 * nm, max: 467 * nm }, page: 3 },
  rate: { typ: 800e3, page: 1 },
  reset: { min: 50 * us, page: 3 },
  vih: { times: 0.7, rail: "VDD", page: 3 },
  temperature: { min: -25, max: 80, page: 2 },
  delay: { max: 300 * ns, path: DIN_DO, page: 3 },
  intensity: { page: 3 },
  switching: { page: 3 },
  left: [{ what: "Reverse-connection protection", page: 1 }],
}

export const SHEETS: Record<string, SheetNumbers> = {
  ws2812b: WS2812B_2013,
  "led-stick-8": WS2812B_2013,
  "led-ring-12": WS2812B_2013,
  "led-ring-16": WS2812B_2013,
  "led-ring-24": WS2812B_2013,
  "led-matrix-8x8": WS2812B_2013,
  ws2812: {
    supply: { min: 3.7, max: 5.3, page: 2 },
    current: { typ: 12.5 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, typ: 623 * nm, max: 625 * nm }, G: { min: 520 * nm, typ: 523 * nm, max: 525 * nm }, B: { min: 449 * nm, typ: 451 * nm, max: 454 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 3 },
    vih: { times: 0.7, rail: "VDD", page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 2 },
    quiescent: { max: 0.6 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 2 },
  },
  "ws2812-6pin": {
    supply: { min: 4.5, max: 5.5, abs: 6, page: 3 },
    forwardVoltage: { R: { min: 1.8, max: 2.2 }, G: { min: 3.0, max: 3.2 }, B: { min: 3.2, max: 3.4 }, page: 4 },
    current: { typ: 18.5 * mA, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 50 * us, page: 4 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -25, max: 80, page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    intensity: { page: 4 },
    switching: { page: 3 },
  },
  ws2812s: {
    supply: { min: 3.7, max: 5.3, page: 2 },
    current: { min: 15.5 * mA, typ: 16.5 * mA, max: 17.5 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, max: 630 * nm }, G: { min: 520 * nm, max: 530 * nm }, B: { min: 465 * nm, max: 475 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 3 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -25, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.7 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 3 },
  },
  ws2812a: {
    supply: { min: 3.7, max: 5.7, page: 3 },
    current: { typ: 34 * mA, page: 4 },
    wavelength: { R: { min: 622 * nm, typ: 624 * nm, max: 627 * nm }, G: { min: 524 * nm, typ: 526 * nm, max: 529 * nm }, B: { min: 463 * nm, typ: 465 * nm, max: 468 * nm }, page: 4 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 65, page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 4 },
    quiescent: { typ: 0.6 * mA, page: 3 },
    intensity: { page: 4 },
    switching: { page: 4 },
  },
  ws2812c: {
    supply: { min: 3.7, max: 5.3, page: 2 },
    current: { typ: 5 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, max: 630 * nm }, G: { min: 515 * nm, max: 525 * nm }, B: { min: 465 * nm, max: 475 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 3 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -25, max: 65, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.6 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 3 },
  },
  ws2812d: {
    supply: { min: 3.7, max: 5.3, page: 2 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 4 },
    vih: { volts: 2.7, page: 3 },
    temperature: { min: -25, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    switching: { page: 3 },
  },
  ws2812e: {
    supply: { min: 3.7, max: 5.3, page: 2 },
    current: { typ: 16 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, max: 630 * nm }, G: { min: 515 * nm, max: 525 * nm }, B: { min: 465 * nm, max: 475 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 3 },
    vih: { times: 0.7, rail: "VDD", page: 2 },
    temperature: { min: -25, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 2 },
    quiescent: { typ: 0.7 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 2 },
  },
  sk6812: {
    supply: { typ: 5.2, page: 4 },
    forwardVoltage: { R: { min: 2.0, max: 2.2 }, G: { min: 3.0, max: 3.3 }, B: { min: 3.0, max: 3.3 }, page: 5 },
    rate: { typ: 800e3, page: 4 },
    reset: { typ: 80 * us, page: 5 },
    vih: { volts: 3.4, typ: true, page: 4 },
    temperature: { min: -40, max: 85, page: 3 },
    delay: { max: 500 * ns, path: DIN_DO, page: 4 },
    quiescent: { typ: 1 * mA, page: 4 },
    intensity: { page: 5 },
    left: [
      { what: "Power polarity protection", page: 2 },
      { what: "4 kV ESD rating", page: 3 },
    ],
  },
  sk6812rgbw: {
    supply: { min: 3.5, max: 5.5, page: 4 },
    wavelength: { R: { min: 620 * nm, max: 630 * nm }, G: { min: 515 * nm, max: 525 * nm }, B: { min: 460 * nm, max: 470 * nm }, page: 3 },
    rate: { typ: 800e3, page: 4 },
    reset: { typ: 80 * us, page: 5 },
    vih: { volts: 3.4, page: 4 },
    temperature: { min: -40, max: 85, page: 4 },
    delay: { max: 500 * ns, path: DIN_DO, page: 4 },
    quiescent: { typ: 1 * mA, page: 4 },
    left: [
      { what: "White colour temperature bins", page: 3 },
      { what: "Output rise and fall", page: 4 },
      { what: "Reflow and moisture handling", page: 13 },
    ],
  },
  ws2813: {
    supply: { min: 3.7, max: 5.3, page: 2 },
    current: { typ: 16 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, max: 625 * nm }, G: { min: 515 * nm, max: 525 * nm }, B: { min: 465 * nm, max: 475 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 3 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -25, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.7 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 3 },
  },
  ws2813b: {
    supply: { min: 3.7, max: 5.3, page: 2 },
    current: { typ: 16 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, typ: 623 * nm, max: 630 * nm }, G: { min: 510 * nm, typ: 520 * nm, max: 520 * nm }, B: { min: 465 * nm, typ: 471 * nm, max: 475 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 3 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { max: 0.6 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 3 },
  },
  "ws2813b-rgbw": {
    supply: { min: 3.7, max: 5.3, page: 2 },
    current: { typ: 15 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, max: 630 * nm }, G: { min: 515 * nm, max: 525 * nm }, B: { min: 465 * nm, max: 475 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -25, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { max: 0.6 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 3 },
    left: [{ what: "White colour temperature", page: 3 }],
  },
  // The akizuki copy of "WS2815B" V1.0 is the 6-pin part with pin 1 VCC, the WS2815 pinout.
  ws2815: {
    supply: { min: 9.5, max: 13.5, page: 2 },
    current: { typ: 10 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, max: 625 * nm }, G: { min: 515 * nm, max: 525 * nm }, B: { min: 465 * nm, max: 475 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 3 },
    // Printed 0.7VDD beside VIL 0.3 VCC: the die's rail, pin 1 VCC ("IC power supply"); 0.7 × the 12 V VDD would be past p. 2's 5.3 V input.
    vih: { times: 0.7, rail: "VCC", page: 3 },
    temperature: { min: -25, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 2.1 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 3 },
  },
  ws2815b: {
    supply: { min: 9.5, max: 13.5, page: 2 },
    current: { typ: 12 * mA, page: 3 },
    wavelength: { R: { min: 620 * nm, typ: 623 * nm, max: 630 * nm }, G: { min: 510 * nm, typ: 520 * nm, max: 520 * nm }, B: { min: 465 * nm, typ: 471 * nm, max: 475 * nm }, page: 3 },
    rate: { typ: 800e3, page: 1 },
    reset: { min: 280 * us, page: 3 },
    vih: { volts: 2.7, page: 3 },
    temperature: { min: -40, max: 65, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { max: 2 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 3 },
    left: [{ what: "Rated power consumption", page: 2 }],
  },
  ws2816: {
    supply: { min: 3.3, max: 5.5, page: 2 },
    current: { typ: 20 * mA, per: "package", page: 3 },
    wavelength: { R: { min: 620 * nm, max: 625 * nm }, G: { min: 520 * nm, max: 525 * nm }, B: { min: 467 * nm, max: 472 * nm }, page: 3 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 65, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.7 * mA, max: 1 * mA, page: 3 },
    intensity: { page: 3 },
    switching: { page: 3 },
    left: [
      { what: "Internal 4-bit gamma correction", page: 1 },
      { what: "120° viewing angle", page: 3 },
    ],
  },
  ws2916: {
    supply: { min: 3.7, max: 5.3, page: 3 },
    current: { typ: 16 * mA, per: "package", page: 3 },
    wavelength: { R: { min: 620 * nm, max: 630 * nm }, G: { min: 525 * nm, max: 530 * nm }, B: { min: 465 * nm, max: 475 * nm }, page: 4 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.55, rail: "VDD", page: 3 },
    temperature: { min: -25, max: 65, page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.6 * mA, page: 3 },
    intensity: { page: 4 },
    switching: { page: 3 },
  },
  "ws2916a-rgbw": {
    supply: { min: 3.5, max: 5.7, page: 3 },
    current: { typ: 30 * mA, page: 4 },
    currentWhite: { typ: 60 * mA, page: 4 },
    wavelength: { R: { min: 620 * nm, max: 630 * nm }, G: { min: 520 * nm, max: 530 * nm }, B: { min: 465 * nm, max: 475 * nm }, page: 4 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.55, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 85, page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 4 },
    quiescent: { typ: 0.3 * mA, page: 3 },
    intensity: { page: 4 },
    switching: { page: 4 },
    left: [{ what: "White colour temperature", page: 4 }],
  },
  // --- drivers ---
  ws2811: {
    supply: { min: 3.5, max: 5.5, page: 2 },
    current: { min: 15.5 * mA, typ: 16.5 * mA, max: 17.5 * mA, page: 3 },
    rate: { typ: 800e3, page: 3 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -25, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.6 * mA, page: 3 },
    switching: { page: 3 },
  },
  ws2818: {
    supply: { min: 3.5, max: 5.8, page: 2 },
    current: { min: 14.5 * mA, typ: 16 * mA, max: 17.5 * mA, page: 3 },
    rate: { min: 600e3, page: 3 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.5, rail: "VDD", page: 3 },
    temperature: { min: -25, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.35 * mA, page: 3 },
    switching: { page: 3 },
  },
  ws2814: {
    supply: { min: 3.7, max: 5.8, page: 2 },
    current: { min: 13.5 * mA, typ: 15.5 * mA, max: 17.5 * mA, page: 3 },
    rate: { typ: 800e3, page: 3 },
    reset: { min: 350 * us, page: 3 },
    vih: { times: 0.7, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.6 * mA, page: 3 },
    switching: { page: 3 },
    left: [{ what: "2.5 kV ESD rating", page: 2 }],
  },
  ws2814b: {
    supply: { min: 3.7, max: 5.8, page: 3 },
    current: { min: 13.5 * mA, typ: 15.5 * mA, max: 17.5 * mA, page: 3 },
    rate: { min: 600e3, page: 3 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.55, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 85, page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.4 * mA, page: 3 },
    switching: { page: 3 },
  },
  ws2805: {
    supply: { min: 3.5, max: 5.8, page: 3 },
    current: { min: 14.5 * mA, typ: 16 * mA, max: 17.5 * mA, page: 3 },
    rate: { typ: 800e3, page: 3 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.55, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 85, page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.6 * mA, page: 3 },
    switching: { page: 3 },
  },
  ws2913: {
    supply: { min: 3.5, max: 5.7, page: 2 },
    current: { min: 15 * mA, typ: 17 * mA, max: 19 * mA, page: 3 },
    rate: { typ: 800e3, page: 3 },
    reset: { min: 280 * us, page: 3 },
    vih: { times: 0.55, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 85, page: 2 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.8 * mA, page: 3 },
    switching: { page: 3 },
    left: [
      { what: "Delayed output turn-on", page: 1 },
      { what: "Channel current mismatch", page: 3 },
    ],
  },
  ws2914: {
    supply: { min: 3.5, max: 5.7, page: 3 },
    current: { min: 28 * mA, typ: 30 * mA, max: 35 * mA, page: 3 },
    currentWhite: { min: 58 * mA, typ: 60 * mA, max: 70 * mA, page: 3 },
    rate: { typ: 800e3, page: 3 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.6, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 85, page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.3 * mA, page: 3 },
    switching: { page: 3 },
    left: [{ what: "W1 W2 in parallel", page: 3 }],
  },
  ws2915: {
    supply: { min: 3.5, max: 5.7, page: 3 },
    current: { typ: 30 * mA, page: 3 },
    rate: { typ: 800e3, page: 3 },
    reset: { min: 280 * us, page: 4 },
    vih: { times: 0.55, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 85, page: 3 },
    delay: { max: 300 * ns, path: DIN_DO, page: 3 },
    quiescent: { typ: 0.3 * mA, page: 3 },
    switching: { page: 3 },
    left: [
      { what: "Grounded SET 4-channel mode", page: 2 },
      { what: "Channel current mismatch", page: 3 },
    ],
  },
  ws2801: {
    supply: { min: 3.3, max: 5.5, abs: 6, absPage: 2, page: 3 },
    current: { min: 5 * mA, max: 30 * mA, abs: 50 * mA, absPage: 2, page: 3 },
    feedback: { min: 0.582, typ: 0.6, max: 0.618, page: 3 },
    rate: { max: 25e6, page: 2 },
    reset: { min: 500 * us, page: 14 },
    vih: { times: 0.8, rail: "VDD", page: 3 },
    temperature: { min: -40, max: 85, page: 1 },
    delay: { typ: 8 * ns, path: ["CKI", "CKO"], page: 4 },
    quiescent: { typ: 1 * mA, max: 1.5 * mA, page: 3 },
    left: [
      { what: "Constant-voltage drive mode", page: 2 },
      { what: "Output current rise time", page: 4 },
      { what: "Hot swap", page: 1 },
    ],
  },
}
