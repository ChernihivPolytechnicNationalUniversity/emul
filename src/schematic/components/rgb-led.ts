import { LedIcon } from "../icons"
import type { BodyShape, ComponentDef, Element, PinDef } from "../types"
import { PART_NUMBER, RATED_TEST_CURRENT, AMBIENT, type RgbDie, L154A4SURKQBDZGW, COMMON_CATHODE_LEAD, ambientOf, deratedCurrent, intensityVsAmbient, luminousIntensity, chromaticityColor, type DieLight, rgbLedGlow } from "@/sim/rgb-led-light"
import { DOCS } from "../datasheets/docs"
import type { Datasheet } from "../types"

const WIDTH = 4
const HEIGHT = 6
const ROWS: Record<RgbDie["id"], number> = { R: 1, B: 3, G: 5 }
const BUS = 1
const CATHODE_BAR = 1.6
const ANODE_SIDE = 2.4
const HALF = 0.5
const COMMON_ROW = 3

const byLead = [...L154A4SURKQBDZGW].sort((a, b) => a.lead - b.lead)

const commonCathode: PinDef = { id: "K", label: "K", x: 0, y: COMMON_ROW, side: "left", labelAt: "top", kind: "gnd", connectorPin: COMMON_CATHODE_LEAD }
const pins: PinDef[] = [
  ...byLead.map((die): PinDef => ({ id: die.id, label: die.id, x: WIDTH, y: ROWS[die.id], side: "right", labelAt: "top", kind: "digital", connectorPin: die.lead })),
  commonCathode,
].sort((a, b) => (a.connectorPin ?? 0) - (b.connectorPin ?? 0))

const rows = Object.values(ROWS)
const leads = rows.map((y) => `M${BUS} ${y} H${CATHODE_BAR} M${ANODE_SIDE} ${y} H${WIDTH}`).join(" ")
const bars = rows.map((y) => `M${CATHODE_BAR} ${y - HALF} V${y + HALF}`).join(" ")
const bus = `M${BUS} ${Math.min(...rows)} V${Math.max(...rows)} M0 ${COMMON_ROW} H${BUS}`
const triangle = (y: number): BodyShape => ({ type: "path", d: `M${ANODE_SIDE} ${y - HALF} L${CATHODE_BAR} ${y} L${ANODE_SIDE} ${y + HALF} Z`, fill: "foreground" })
const LIGHT_ARROWS: BodyShape = { type: "path", d: "M2.3 0.45 L2.7 0.05 M2.5 0.05 H2.7 V0.25 M2.75 0.6 L3.15 0.2 M2.95 0.2 H3.15 V0.4" }

const dieLimits = (die: RgbDie) => ({
  current: (props: Record<string, string>) => deratedCurrent(die, ambientOf(props)),
  surge: die.ratings.peakCurrent,
  power: die.ratings.power,
  voltage: die.ratings.reverseVolts,
  fail: "open" as const,
  fatal: false,
})

const model: Element[] = [
  ...L154A4SURKQBDZGW.map((die): Element => ({
    kind: "D",
    anode: die.id,
    cathode: "K",
    vf: die.junctionVoltsAt10mA,
    emission: die.emission,
    rs: die.seriesOhms,
    part: die.id,
    limits: dieLimits(die),
  })),
  ...L154A4SURKQBDZGW.map((die): Element => ({ kind: "C", a: die.id, b: "K", value: die.capacitance, euler: true, hidden: true })),
]

export const rgbLed: ComponentDef = {
  id: "rgb-led",
  name: "RGB LED, common cathode",
  description: "Common-cathode 5 mm full-colour lamp",
  keywords: [PART_NUMBER, "RGB", "full colour", "full color", "common cathode", "Kingbright", "5 mm"],
  category: "leds",
  icon: LedIcon,
  prefix: "LED",
  width: WIDTH,
  height: HEIGHT,
  defaults: { temp: String(AMBIENT.reference) },
  fields: [
    { key: "temp", label: "Ambient temperature", type: "range", min: AMBIENT.min, max: AMBIENT.max, step: 1, unit: "°C" },
  ],
  pins,
  body: [
    { type: "path", d: `${leads} ${bars} ${bus}` },
    ...rows.map(triangle),
    LIGHT_ARROWS,
    { type: "text", x: 1.5, y: 0.28, text: "{ref}", size: 0.35, anchor: "end" },
    { type: "text", x: 2, y: 5.85, text: PART_NUMBER, size: 0.3, muted: true },
  ],
  parts: [{ type: "led", id: "RGB", label: "", x: 2, y: COMMON_ROW, color: "white", style: "glow", mix: L154A4SURKQBDZGW.map((die) => die.id) }],
  model,
}

export const rgbLeds: ComponentDef[] = [rgbLed]

export { PART_NUMBER, RATED_TEST_CURRENT, AMBIENT, type RgbDie, L154A4SURKQBDZGW, COMMON_CATHODE_LEAD, ambientOf, deratedCurrent, intensityVsAmbient, luminousIntensity, chromaticityColor, type DieLight, rgbLedGlow }

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = rgbLeds

// Datasheet records: the documents this file's parts cite, and what their models leave out (the notes above, item by item).
// The key numbers with their pages are still to be added (specs).
const RECORDS: Record<string, Datasheet> = {
  "rgb-led": {
    maker: "Kingbright",
    docs: [DOCS["kb-l154a4surkqbdzgw"]],
    specs: [],
    characteristics: [
      { kind: "forwardVoltage", value: { typ: 1.95, max: 2.5 }, at: [{ load: { amps: 20e-3 } }], colour: "red", cite: { page: 2, at: "Electrical / Optical" } },
      { kind: "forwardVoltage", value: { typ: 3.3, max: 4.1 }, at: [{ load: { amps: 20e-3 } }], colour: "green", cite: { page: 2, at: "Electrical / Optical" } },
      { kind: "forwardVoltage", value: { typ: 3.3, max: 4 }, at: [{ load: { amps: 20e-3 } }], colour: "blue", cite: { page: 2, at: "Electrical / Optical" } },
      { kind: "forwardCurrent", limit: { max: 30e-3 }, colour: "red", cite: { page: 2, at: "Abs Max" } },
      { kind: "forwardCurrent", limit: { max: 25e-3 }, colour: "green", cite: { page: 2, at: "Abs Max" } },
      { kind: "forwardCurrent", limit: { max: 30e-3 }, colour: "blue", cite: { page: 2, at: "Abs Max" } },
      { kind: "reverseVoltage", limit: { max: 5 }, cite: { page: 2, at: "Abs Max" } },
    ],
    modelled: [
      { what: "Common cathode on lead 2", cite: { page: 1, at: "Package Dimensions" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Anode leads R1, B3, G4", cite: { page: 1, at: "Package Dimensions" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Dies follow digitised I–V curves", cite: { page: 3, at: "Forward Current vs. Forward Voltage (blue p. 4, green p. 5)" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "±0.1 V on dashed part", cite: { page: 3, at: "Forward Current vs. Forward Voltage (blue p. 4, green p. 5)" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Each die burns open alone", cite: { page: 2, at: "Absolute Maximum Ratings" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Past derated DC or peak", cite: { page: 2, at: "Absolute Maximum Ratings" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Or at 5 V reversed", cite: { page: 2, at: "Absolute Maximum Ratings" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Derating curve to 85 °C", cite: { page: 3, at: "Forward Current Derating Curve" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Junction C 35/100/45 pF", cite: { page: 2, at: "Electrical / Optical Characteristics" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Intensity follows current, ambient curves", cite: { page: 3, at: "Luminous Intensity vs. Forward Current" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Glow mixes dominant wavelengths", cite: { page: 3, at: "Luminous Intensity vs. Forward Current" }, test: "tests/sim/rgb-led.test.ts" },
      { what: "Ambient −40 to +85 °C", cite: { page: 2, at: "Absolute Maximum Ratings" }, test: "tests/sim/rgb-led.test.ts" },
    ],
    notModelled: [
      { what: "Viewing angle, no beam drawn", cite: { page: 2, at: "Selection Guide" } },
      { what: "Spectral half-width", cite: { page: 2, at: "Electrical / Optical Characteristics" } },
      { what: "Electrostatic discharge damage", cite: { page: 1 } },
      { what: "Ageing over the part's life", cite: { page: 1, at: "Features" } },
      { what: "Soldering heat (260 °C)", cite: { page: 2, at: "Absolute Maximum Ratings" } },
    ],
  },
}
for (const def of defs) def.datasheet ??= RECORDS[def.id]
