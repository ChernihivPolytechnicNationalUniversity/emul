/**
 * Addressable LEDs and their constant-current drivers, one component per pin-compatible group
 * of parts (`src/sim/addressable/products.ts`): the part is picked in the inspector, the
 * behaviour is `src/sim/addressable/chain.ts`. Drawn as functional symbols — data in on the
 * left, data and outputs out on the right, supplies on top, ground below — with the package
 * pin numbers in the pin notes; pixels show their latched colour on the field.
 *
 * The analog face: the supply carries the LEDs' (or the die's) current as a live load; data
 * inputs are high-impedance pins rated to the part's input maximum; data outputs drive from
 * the die's rail; each constant-current output is a sink the model gates; a driver's VDD has
 * its shunt regulator, a WS2815's VCC its series one.
 */
import { SINK_K, sinkGate, SUPPLY_KEY } from "@/sim/addressable/light"
import { chipCount, partOf, PRODUCTS, type Layout as LayoutId, type Product } from "@/sim/addressable/products"
import { PixelIcon, PixelMatrixIcon, PixelRingIcon, PixelStickIcon, ChipIcon } from "../icons"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind, Side } from "../types"

type PinSpec = { id: string; label: string; kind?: PinKind; note: string }

/** Pins of each group: data in (left), data and light out (right), supplies (top), ground (bottom). */
type Layout = { left: PinSpec[]; right: PinSpec[]; top: PinSpec[]; bottom: PinSpec[] }

const GND: PinSpec = { id: "GND", label: "GND", kind: "gnd", note: "Ground" }
const VSS: PinSpec = { id: "GND", label: "VSS", kind: "gnd", note: "Ground (5050: pin 3; 2020: pin 2; F5/F8: pin 3)" }
const PIXEL_VDD: PinSpec = { id: "VDD", label: "VDD", kind: "power", note: "Supply for the die and the LEDs (5050: pin 1; 2020: pin 4; F5/F8: pin 2)" }
const PIXEL_DIN: PinSpec = { id: "DIN", label: "DIN", note: "Data in (5050: pin 4; 2020: pin 3; F5/F8: pin 4)" }
const PIXEL_DO: PinSpec = { id: "DO", label: "DOUT", note: "Data out to the next DIN (5050: pin 2; 2020: pin 1; F5/F8: pin 1)" }

const OUT = (ch: string, pin: number | string): PinSpec => ({ id: `OUT${ch}`, label: `OUT${ch}`, note: `Constant-current sink for the ${ch} LED's cathode (pin ${pin})` })

const LAYOUTS: Record<Exclude<LayoutId, "module">, Layout> = {
  pixel: { left: [PIXEL_DIN], right: [PIXEL_DO], top: [PIXEL_VDD], bottom: [VSS] },
  "pixel-12v": {
    left: [{ id: "DIN", label: "DIN", note: "Data in, 5.7 V max (pin 4)" }],
    right: [{ id: "DO", label: "DOUT", note: "Data out at the die's 5 V (pin 2)" }],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "+12 V (pin 1)" }],
    bottom: [{ ...GND, label: "VSS", note: "Ground (pin 3)" }],
  },
  "pixel-6pin": {
    left: [{ id: "DIN", label: "DIN", note: "Data in (pin 2)" }],
    right: [{ id: "DO", label: "DOUT", note: "Data out (pin 1)" }],
    top: [
      { id: "VCC", label: "VCC", kind: "power", note: "Supply of the control circuit (pin 3)" },
      { id: "VDD", label: "VDD", kind: "power", note: "Supply of the LEDs (pin 5)" },
    ],
    bottom: [{ ...GND, label: "VSS", note: "Ground (pin 6); pin 4 is NC" }],
  },
  "pixel-backup": {
    left: [
      { id: "DIN", label: "DIN", note: "Data in from the previous DOUT (pin 4; WS2916A-RGBW pin 3)" },
      { id: "BIN", label: "BIN", note: "Backup data in: the previous pixel's DIN; the first pixel's to GND (pin 6; WS2916A-RGBW pin 2)" },
    ],
    right: [{ id: "DO", label: "DOUT", note: "Data out (pin 3; WS2916A-RGBW pin 6)" }],
    top: [
      { id: "VCC", label: "VCC", kind: "power", note: "Pin 1: the die's supply through 150–390 Ω (WS2813 V1.4, Mini, B-RGBW); NC on the 2016 WS2813, WS2813E, A-V7, WS2916A-RGBW" },
      { id: "VDD", label: "VDD", kind: "power", note: "+5 V for the LEDs (pin 2; WS2916A-RGBW pin 4)" },
    ],
    bottom: [{ ...GND, note: "Ground (pin 5; WS2916A-RGBW pin 1)" }],
  },
  "pixel-backup-12v": {
    left: [
      { id: "DIN", label: "DIN", note: "Data in, 5.7 V max (DIN1, pin 4; RGBW: pin 3)" },
      { id: "BIN", label: "BIN", note: "Backup data in (DIN2, pin 6; RGBW: pin 2); the first pixel's to GND" },
    ],
    right: [{ id: "DO", label: "DOUT", note: "Data out at the die's 5 V (pin 3; RGBW: pin 6)" }],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "+12 V (pin 2; RGBW: pin 4)" }],
    bottom: [{ ...GND, note: "Ground (pin 5; RGBW: pin 1)" }],
  },
  ws2815: {
    left: [
      { id: "DIN", label: "DIN", note: "Data in (pin 4)" },
      { id: "BIN", label: "BIN", note: "Backup data in: the previous pixel's DIN; the first pixel's to GND (pin 6)" },
    ],
    right: [{ id: "DO", label: "DO", note: "Data out at the die's 5 V (pin 3)" }],
    top: [
      { id: "VCC", label: "VCC", kind: "power", note: "The die's own supply: leave open or put a filter capacitor to GND (pin 1)" },
      { id: "VDD", label: "VDD", kind: "power", note: "+12 V for the LEDs (pin 2)" },
    ],
    bottom: [{ ...GND, note: "Ground (pin 5)" }],
  },
  "pixel-relay": {
    left: [
      { id: "DIN", label: "DI", note: "Data in from the previous DO (5050: pin 4; 2121: pin 2)" },
      { id: "BIN", label: "BI", note: "Backup data in from the previous BO; the first pixel's to GND (5050: pin 6; 2121: pin 1)" },
    ],
    right: [
      { id: "DO", label: "DO", note: "Data out (5050: pin 3; 2121: pin 4)" },
      { id: "BO", label: "BO", note: "Backup data out to the next BI: repeats this pixel's input (5050: pin 1; 2121: pin 5)" },
    ],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "Supply, called VCC on some sheets (5050: pin 2; 2121: pin 3)" }],
    bottom: [{ ...GND, note: "Ground (5050: pin 5; 2121: pin 6)" }],
  },
  "driver-3": {
    left: [
      { id: "DIN", label: "DIN", note: "Data in (pin 6)" },
      { id: "SET", label: "SET", note: "Pin 7: NC on the 2017 WS2811; on the 2011 one, to VDD for 400 kHz; on WS2913, to VDD for the 16-bit mode" },
    ],
    right: [OUT("R", 1), OUT("G", 2), OUT("B", 3), { id: "DO", label: "DO", note: "Data out (pin 5)" }],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "Supply (pin 8): 5 V through ≤ 100 Ω, or 12 V through 2.7 kΩ to the built-in regulator" }],
    bottom: [{ ...GND, note: "Ground (pin 4)" }],
  },
  "driver-3-backup": {
    left: [
      { id: "DIN", label: "DIN1", note: "Data in (pin 5)" },
      { id: "BIN", label: "DIN2", note: "Backup data in: the previous chip's DIN1; the first chip's to GND (pin 7)" },
    ],
    right: [OUT("R", 1), OUT("G", 2), OUT("B", 3), { id: "DO", label: "DO", note: "Data out (pin 4)" }],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "Supply (pin 8): 150 Ω from 5 V, 3.3 kΩ from 12 V, 7.5 kΩ from 24 V" }],
    bottom: [{ ...GND, note: "Ground (pin 6)" }],
  },
  "driver-4": {
    left: [{ id: "DIN", label: "DIN", note: "Data in (pin 6)" }],
    right: [OUT("R", 1), OUT("G", 2), OUT("B", 3), OUT("W", 8), { id: "DO", label: "DOUT", note: "Data out (pin 5)" }],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "Supply (pin 7): 100 Ω from 5 V, 2.7 kΩ from 12 V, 8.2 kΩ from 24 V" }],
    bottom: [{ ...GND, note: "Ground (pin 4)" }],
  },
  "driver-4-backup": {
    left: [
      { id: "DIN", label: "DIN", note: "Data in (pin 8)" },
      { id: "BIN", label: "BIN", note: "Backup data in: the previous chip's DIN; the first chip's to GND (pin 9)" },
    ],
    right: [OUT("R", 1), OUT("G", 2), OUT("B", 3), OUT("W", 4), { id: "DO", label: "DOUT", note: "Data out (pin 6)" }],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "Supply (pin 10): 100 Ω from 5 V, 3.3 kΩ from 12 V, 7.5 kΩ from 24 V" }],
    bottom: [{ ...GND, note: "Ground (pins 5 and 7)" }],
  },
  "driver-5-backup": {
    left: [
      { id: "DIN", label: "DIN", note: "Data in (pin 9)" },
      { id: "BIN", label: "BIN", note: "Backup data in: the previous chip's DIN; the first chip's to GND (pin 8; FDIN on WS2914)" },
    ],
    right: [OUT("R", 1), OUT("G", 2), OUT("B", 3), OUT("W1", 4), OUT("W2", 5), { id: "DO", label: "DOUT", note: "Data out (pin 7)" }],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "Supply (pin 10): 150 Ω from 5 V, 3.3–4.7 kΩ from 12 V, 7.5–10 kΩ from 24 V" }],
    bottom: [{ ...GND, note: "Ground (pin 6)" }],
  },
  "driver-5": {
    left: [
      { id: "DIN", label: "DIN", note: "Data in (pin 9)" },
      { id: "SET", label: "SET", note: "Pin 8: open for 5 channels; grounded selects a 4-channel mode the model does not have" },
    ],
    right: [OUT("R", 1), OUT("G", 2), OUT("B", 3), OUT("W1", 4), OUT("W2", 5), { id: "DO", label: "DO", note: "Data out (pin 7)" }],
    top: [{ id: "VDD", label: "VDD", kind: "power", note: "Supply (pin 10): 150 Ω from 5 V, 4.7 kΩ from 12 V, 10 kΩ from 24 V" }],
    bottom: [{ ...GND, note: "Ground (pin 6)" }],
  },
  ws2801: {
    left: [
      { id: "CKI", label: "CKI", note: "Clock in, data read on the rising edge, ≤ 25 MHz (pin 1)" },
      { id: "SDI", label: "SDI", note: "Data in (pin 2)" },
      { id: "POL", label: "POL", note: "Output polarity, 30 kΩ pull-up: open or high normal, low inverted (pin 3)" },
      { id: "RFB", label: "RFB", note: "R current set: resistor to GND, I = 0.6 V / R (pin 4)" },
      { id: "GFB", label: "GFB", note: "G current set (pin 5)" },
      { id: "BFB", label: "BFB", note: "B current set (pin 6)" },
    ],
    right: [
      { id: "ROUT", label: "ROUT", note: "R sink (pin 10)" },
      { id: "GOUT", label: "GOUT", note: "G sink (pin 9)" },
      { id: "BOUT", label: "BOUT", note: "B sink (pin 8)" },
      { id: "CKO", label: "CKO", note: "Clock out to the next CKI (pin 13)" },
      { id: "SDO", label: "SDO", note: "Data out to the next SDI (pin 12)" },
    ],
    top: [{ id: "VCC", label: "VCC", kind: "power", note: "3.3–5.5 V (pin 14); above 6 V through a resistor and a zener" }],
    bottom: [{ ...GND, note: "Ground (pin 7); pin 11 is NC" }],
  },
}

const MODULE_LAYOUT: Layout = {
  left: [{ id: "DIN", label: "DIN", note: "Data in to the first LED" }],
  right: [{ id: "DO", label: "DOUT", note: "Data out of the last LED" }],
  top: [{ id: "VDD", label: "5V", kind: "power", note: "Supply of every LED" }],
  bottom: [GND],
}

const layoutOf = (p: Product) => (p.layout === "module" ? MODULE_LAYOUT : LAYOUTS[p.layout])

// --- symbol -------------------------------------------------------------------------------------

type Geometry = { width: number; height: number; pins: PinDef[]; body: BodyShape[]; parts: PartDef[] }

/** Pins on the four sides of a box from (1, 0.5) to (width − 1, height − 0.5). */
function placePins(layout: Layout, width: number, height: number, top0 = 1): PinDef[] {
  const pins: PinDef[] = []
  const side = (list: PinSpec[], s: Side) =>
    list.forEach((p, i) => {
      // Side pins a cell apart from `top0` down; top and bottom pins two cells apart, centred.
      const along = s === "left" || s === "right" ? top0 + i : Math.floor(width / 2) - (list.length - 1) + 2 * i
      const x = s === "left" ? 1 : s === "right" ? width - 1 : along
      const y = s === "top" ? 0 : s === "bottom" ? height : along
      const labelAt: Side = s === "left" ? "right" : s === "right" ? "left" : s === "top" ? "right" : "right"
      pins.push({ id: p.id, label: p.label, x, y, side: s, labelAt, kind: p.kind ?? "digital", note: p.note })
    })
  side(layout.left, "left")
  side(layout.right, "right")
  side(layout.top, "top")
  side(layout.bottom, "bottom")
  return pins
}

/**
 * Room a side pin's name takes inside the body, cells: "DOUT" at the largest size the field
 * draws names at (0.8 cell, 0.6 em a character) plus its gap from the pin.
 */
const NAME_ROOM = 2.5

const frame = (width: number, height: number): BodyShape => ({ type: "rect", x: 1, y: 0.5, w: width - 2, h: height - 1, rx: 0.2, fill: "board" })

function geometry(p: Product): Geometry {
  const layout = layoutOf(p)
  const shape = p.shape
  switch (shape.kind) {
    case "pixel": {
      const rows = Math.max(layout.left.length, layout.right.length)
      const width = 9
      const height = rows + 4
      return {
        width,
        height,
        pins: placePins(layout, width, height, 2),
        body: [frame(width, height), { type: "text", x: width / 2, y: height - 0.85, text: "{part}", size: 0.3 }, { type: "text", x: width - 0.6, y: 0.15, text: "{ref}", size: 0.3, muted: true }],
        parts: [{ type: "pixel", id: "P0", label: "", x: width / 2, y: height / 2 + 0.1, index: 0, size: 1.3 }],
      }
    }
    case "driver": {
      const rows = Math.max(layout.left.length, layout.right.length)
      const width = 8
      const height = rows + 3
      return {
        width,
        height,
        pins: placePins(layout, width, height, 2),
        body: [
          frame(width, height),
          { type: "text", x: width / 2, y: height / 2 + 0.1, text: "{part}", size: 0.36 },
          { type: "text", x: width / 2, y: height / 2 + 0.65, text: "LED driver", size: 0.24, muted: true },
          { type: "text", x: width - 0.6, y: 0.15, text: "{ref}", size: 0.3, muted: true },
        ],
        parts: [],
      }
    }
    case "stick": {
      // Pixels a cell apart, the names' room clear on both sides.
      const first = 1 + NAME_ROOM + 0.4
      const width = Math.ceil(first + shape.count - 1 + 0.4 + NAME_ROOM + 1)
      const height = 4
      return {
        width,
        height,
        pins: placePins(layout, width, height, 2),
        body: [frame(width, height), { type: "text", x: width / 2, y: height - 0.75, text: "{part} ×" + shape.count, size: 0.26, muted: true }],
        parts: Array.from({ length: shape.count }, (_, i) => ({ type: "pixel" as const, id: `P${i}`, label: `D${i + 1}`, x: first + i, y: 1.8, index: i, size: 0.8 })),
      }
    }
    case "ring": {
      // Pixels a cell apart round the circle, the first at the top, going clockwise.
      const radius = Math.max(2, shape.count / (2 * Math.PI))
      const size = Math.ceil(2 * (radius + 0.4 + NAME_ROOM + 1))
      const width = size % 2 ? size + 1 : size
      const height = width
      const c = width / 2
      return {
        width,
        height,
        pins: placePins(layout, width, height, Math.floor(c)),
        body: [
          frame(width, height),
          { type: "circle", cx: c, cy: c, r: radius + 0.6, fill: "none" },
          { type: "circle", cx: c, cy: c, r: radius - 0.6, fill: "none" },
          { type: "text", x: c, y: c + 0.1, text: "{part}", size: 0.3, muted: true },
        ],
        parts: Array.from({ length: shape.count }, (_, i) => {
          const a = (2 * Math.PI * i) / shape.count - Math.PI / 2
          return { type: "pixel" as const, id: `P${i}`, label: `D${i + 1}`, x: c + radius * Math.cos(a), y: c + radius * Math.sin(a), index: i, size: 0.75 }
        }),
      }
    }
    case "matrix": {
      const first = 1 + NAME_ROOM + 0.4
      const width = Math.ceil(first + shape.columns - 1 + 0.4 + NAME_ROOM + 1)
      const height = shape.rows + 3
      return {
        width,
        height,
        pins: placePins(layout, width, height, Math.floor(height / 2)),
        body: [frame(width, height), { type: "text", x: width / 2, y: height - 0.7, text: "{part} " + `${shape.columns}×${shape.rows}`, size: 0.26, muted: true }],
        parts: Array.from({ length: shape.columns * shape.rows }, (_, i) => ({
          type: "pixel" as const,
          id: `P${i}`,
          label: `D${i + 1}`,
          x: first + (i % shape.columns),
          y: 1.5 + Math.floor(i / shape.columns),
          index: i,
          size: 0.8,
        })),
      }
    }
  }
}

// --- electrical model ---------------------------------------------------------------------------

function model(p: Product, layout: Layout): Element[] {
  const spec = (props: Record<string, string>) => partOf(p, props)
  const first = p.parts[0]
  const pins = new Set([...layout.left, ...layout.right, ...layout.top, ...layout.bottom].map((x) => x.id))
  const els: Element[] = []
  const pixel = first.light.kind === "pixel"
  const supply = pixel ? "VDD" : first.logic.pin
  // The supply: what the LEDs (a pixel) or the die (a driver) draw, as a live load; past the
  // absolute maximum the die shorts.
  els.push({ kind: "R", a: supply, b: "GND", value: 1e9, live: SUPPLY_KEY, limits: { voltage: (props) => spec(props).supply.abs, fail: "short" } })
  if (first.regulator !== undefined) els.push({ kind: "REG", in: "VDD", out: "VCC", gnd: "GND", value: first.regulator, imax: 0.05 })
  else if (pins.has("VCC") && supply !== "VCC") els.push({ kind: "R", a: "VCC", b: "GND", value: 10e3, hidden: true, limits: { voltage: (props) => spec(props).supply.abs, fail: "short" } })
  // A driver's shunt regulator: VDD from 12 or 24 V through a resistor settles at the clamp.
  if (first.clamp !== undefined) els.push({ kind: "D", anode: "GND", cathode: supply, vf: 0.7, zener: (props) => spec(props).clamp ?? 100, limits: { power: 0.5, tau: 1, fail: "short" } })
  const rail = first.regulator !== undefined ? { vddNode: "VCC" } : pixel && first.supply.abs > 6 ? { vdd: 5 } : { vddNode: first.logic.pin }
  const inputMax = (props: Record<string, string>) => spec(props).inputMax
  for (const pin of ["DIN", "BIN", "SET", "CKI", "SDI", "POL"]) if (pins.has(pin)) els.push({ kind: "GPIO", node: pin, ...rail, limits: { voltage: inputMax, fail: "open" } })
  for (const pin of ["DO", "BO", "CKO", "SDO"]) if (pins.has(pin)) els.push({ kind: "GPIO", node: pin, ...rail, limits: { voltage: inputMax, fail: "open" } })
  if (first.strap?.pullUp) els.push({ kind: "R", a: first.strap.pin, b: first.logic.pin, value: first.strap.pullUp, hidden: true })
  if (first.light.kind === "sink") {
    const light = first.light
    light.outputs.forEach((o, i) => {
      const gate = sinkGate(0, i)
      els.push({ kind: "GPIO", node: gate, vdd: 2 })
      els.push({ kind: "M", polarity: "nmos", g: gate, d: o.pin, s: "GND", vth: 1, k: SINK_K, lambda: 0, limits: { voltage: (props) => (spec(props).light as { withstand: number }).withstand, fail: "short" } })
      if (o.feedback) els.push({ kind: "GPIO", node: o.feedback, vdd: 1 })
    })
  }
  return els
}

// --- definitions --------------------------------------------------------------------------------

function iconOf(p: Product) {
  switch (p.shape.kind) {
    case "ring":
      return PixelRingIcon
    case "matrix":
      return PixelMatrixIcon
    case "stick":
      return PixelStickIcon
    case "driver":
      return ChipIcon
    default:
      return PixelIcon
  }
}

function addressableDef(p: Product): ComponentDef {
  const g = geometry(p)
  const layout = layoutOf(p)
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    category: p.category,
    keywords: p.parts.map((s) => s.part),
    icon: iconOf(p),
    prefix: p.shape.kind === "driver" ? "U" : "LED",
    // The number printed on the part: the table's keys tell revisions apart ("-2016", "-6P").
    derive: (props) => ({ part: partOf(p, props).part.replace(/-(6P|2016|2011|4P)$/, "").replace("-RGBW-4P", "-RGBW") }),
    defaults: { value: p.parts[0].part, ...(chipCount(p.shape) === 1 ? { fault: "ok" } : {}) },
    fields: [
      // Revisions and packages of the part; a part with one has nothing to pick.
      ...(p.parts.length > 1 ? [{ key: "value", label: "Part", type: "select" as const, options: p.parts.map((s) => ({ value: s.part, label: s.label })) }] : []),
      // A single chip can be marked dead: what a broken pixel does to the rest of a chain, and what a backup line saves.
      ...(chipCount(p.shape) === 1 ? [{ key: "fault", label: "Chip", type: "select" as const, options: [{ value: "ok", label: "Working" }, { value: "dead", label: "Dead (no output)" }] }] : []),
    ],
    width: g.width,
    height: g.height,
    pins: g.pins,
    body: g.body,
    parts: g.parts,
    model: model(p, layout),
    hideIdle: true,
  }
}

export const addressableComponents: ComponentDef[] = PRODUCTS.map(addressableDef)

/** Whether a definition id is one of these (the inspector shows their latched words). */
export const isAddressableDef = (id: string) => PRODUCTS.some((p) => p.id === id)
