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
  { id: "ws2812b", name: "WS2812B", description: "Addressable RGB LED, 5 V, 5050 (also 3535 Mini, 2020)", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812B", "WS2812B-V5", "WS2812B-V6", "WS2812B-V7", "WS2812B-Mini", "WS2812B-2020") },
  { id: "ws2812", name: "WS2812", description: "Addressable RGB LED, 5 V, 4-pin 5050 (2020)", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812") },
  { id: "ws2812-6pin", name: "WS2812 (6-pin)", description: "The original 2012 WS2812: separate VCC for the die and VDD for the LEDs", category: LEDS, layout: "pixel-6pin", shape: PIXEL, parts: parts("WS2812-6P") },
  { id: "ws2812s", name: "WS2812S", description: "Addressable RGB LED, 6-pin 5050, separate die and LED supplies", category: LEDS, layout: "pixel-6pin", shape: PIXEL, parts: parts("WS2812S") },
  { id: "ws2812a", name: "WS2812A", description: "Addressable RGB LED, 5054, 34 mA", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812A") },
  { id: "ws2812c", name: "WS2812C", description: "Addressable RGB LED, 5 mA (5050, 2020)", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812C", "WS2812C-2020") },
  { id: "ws2812d", name: "WS2812D", description: "Addressable RGB LED, 5 mm and 8 mm through-hole", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812D-F5", "WS2812D-F8") },
  { id: "ws2812e", name: "WS2812E", description: "Addressable RGB LED, 5050", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("WS2812E", "WS2812E-V5") },
  { id: "sk6812", name: "SK6812", description: "Addressable RGB LED, WS2812-compatible, 5050", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("SK6812") },
  { id: "sk6812rgbw", name: "SK6812RGBW", description: "Addressable RGB + white LED, 32-bit GRBW, 5050", category: LEDS, layout: "pixel", shape: PIXEL, parts: parts("SK6812RGBW") },
  { id: "ws2813", name: "WS2813", description: "Addressable RGB LED with a backup data input BIN", category: LEDS, layout: "pixel-backup", shape: PIXEL, parts: parts("WS2813", "WS2813C", "WS2813-2016", "WS2813E", "WS2813-Mini", "WS2813A-V7") },
  { id: "ws2813b", name: "WS2813B", description: "Addressable RGB LED with backup data in and out (BI/BO)", category: LEDS, layout: "pixel-relay", shape: PIXEL, parts: parts("WS2813B-V5", "WS2813B-V6", "WS2813C-2121") },
  { id: "ws2813b-rgbw", name: "WS2813B-RGBW", description: "Addressable RGB + white LED with a backup input", category: LEDS, layout: "pixel-backup", shape: PIXEL, parts: parts("WS2813B-RGBW") },
  { id: "ws2815", name: "WS2815", description: "12 V addressable RGB LED with a backup input; VCC from its own regulator", category: LEDS, layout: "ws2815", shape: PIXEL, parts: parts("WS2815") },
  { id: "ws2815b", name: "WS2815B", description: "12 V addressable LED with DIN1 + DIN2, RGB and RGBW", category: LEDS, layout: "pixel-backup-12v", shape: PIXEL, parts: parts("WS2815B", "WS2815B-RGBW") },
  { id: "ws2815b-4pin", name: "WS2815B (4-pin)", description: "12 V addressable LED, single data line, RGB and RGBW", category: LEDS, layout: "pixel-12v", shape: PIXEL, parts: parts("WS2815B-4P", "WS2815B-RGBW-4P") },
  { id: "ws2816", name: "WS2816", description: "16-bit addressable RGB LED with BI/BO (5050, 2121)", category: LEDS, layout: "pixel-relay", shape: PIXEL, parts: parts("WS2816B", "WS2816C-2121") },
  { id: "ws2916", name: "WS2916", description: "16-bit addressable RGB LED with current gain, BI/BO", category: LEDS, layout: "pixel-relay", shape: PIXEL, parts: parts("WS2916A", "WS2916B") },
  { id: "ws2916a-rgbw", name: "WS2916A-RGBW", description: "16-bit addressable RGB + white LED with current gain and a backup input", category: LEDS, layout: "pixel-backup", shape: PIXEL, parts: parts("WS2916A-RGBW") },
  // --- modules ---
  { id: "led-stick-8", name: "LED stick ×8", description: "8 addressable LEDs in a row", category: LEDS, layout: "module", shape: { kind: "stick", count: 8 }, parts: MODULE_PARTS },
  { id: "led-ring-12", name: "LED ring ×12", description: "12 addressable LEDs in a ring", category: LEDS, layout: "module", shape: { kind: "ring", count: 12 }, parts: MODULE_PARTS },
  { id: "led-ring-16", name: "LED ring ×16", description: "16 addressable LEDs in a ring", category: LEDS, layout: "module", shape: { kind: "ring", count: 16 }, parts: MODULE_PARTS },
  { id: "led-ring-24", name: "LED ring ×24", description: "24 addressable LEDs in a ring", category: LEDS, layout: "module", shape: { kind: "ring", count: 24 }, parts: MODULE_PARTS },
  { id: "led-matrix-8x8", name: "LED matrix 8×8", description: "64 addressable LEDs, rows left to right", category: LEDS, layout: "module", shape: { kind: "matrix", columns: 8, rows: 8 }, parts: MODULE_PARTS },
  // --- drivers ---
  { id: "ws2811", name: "WS2811", description: "3-channel constant-current LED driver, single-wire", category: DRIVERS, layout: "driver-3", shape: DRIVER, parts: parts("WS2811", "WS2811-2011") },
  { id: "ws2913", name: "WS2913", description: "3-channel 16-bit LED driver with current gain", category: DRIVERS, layout: "driver-3", shape: DRIVER, parts: parts("WS2913") },
  { id: "ws2818", name: "WS2818", description: "3-channel LED driver with DIN1 + DIN2", category: DRIVERS, layout: "driver-3-backup", shape: DRIVER, parts: parts("WS2818B", "WS2818F") },
  { id: "ws2814", name: "WS2814", description: "4-channel RGBW LED driver", category: DRIVERS, layout: "driver-4", shape: DRIVER, parts: parts("WS2814A", "WS2814F") },
  { id: "ws2814b", name: "WS2814B", description: "4-channel RGBW LED driver with DIN + BIN", category: DRIVERS, layout: "driver-4-backup", shape: DRIVER, parts: parts("WS2814B") },
  { id: "ws2805", name: "WS2805", description: "5-channel RGB + two whites LED driver with DIN + BIN", category: DRIVERS, layout: "driver-5-backup", shape: DRIVER, parts: parts("WS2805") },
  { id: "ws2914", name: "WS2914", description: "16-bit RGBW LED driver with current gain, W on two pins, DIN + BIN", category: DRIVERS, layout: "driver-5-backup", shape: DRIVER, parts: parts("WS2914") },
  { id: "ws2915", name: "WS2915", description: "5-channel 16-bit LED driver with current gain", category: DRIVERS, layout: "driver-5", shape: DRIVER, parts: parts("WS2915") },
  { id: "ws2801", name: "WS2801", description: "3-channel LED driver with clock and data inputs", category: DRIVERS, layout: "ws2801", shape: DRIVER, parts: parts("WS2801") },
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
