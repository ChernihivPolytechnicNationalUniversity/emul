import { srgbEncode } from "@/lib/srgb"
import { LedIcon } from "../icons"
import type { BodyShape, ComponentDef, Element, PinDef } from "../types"

export const PART_NUMBER = "L-154A4SURKQBDZGW"
export const RATED_TEST_CURRENT = 0.02
export const AMBIENT = { min: -40, max: 85, reference: 25 }

type Knot = readonly [celsius: number, amps: number]

export type RgbDie = {
  id: "R" | "G" | "B"
  lead: number
  colour: string
  material: string
  emission: number
  junctionVoltsAt10mA: number
  seriesOhms: number
  capacitance: number
  dominantNm: number
  chromaticity: readonly [x: number, y: number]
  millicandelaAt20mA: number
  intensityPerKelvin: readonly [linear: number, quadratic: number]
  ratings: { power: number; current: number; peakCurrent: number; reverseVolts: number }
  derating: readonly Knot[]
}

export const L154A4SURKQBDZGW: readonly RgbDie[] = [
  {
    id: "R",
    lead: 1,
    colour: "Hyper Red",
    material: "AlGaInP on GaAs",
    emission: 2.796,
    junctionVoltsAt10mA: 1.8938,
    seriesOhms: 0.513,
    capacitance: 35e-12,
    dominantNm: 630,
    chromaticity: [0.70792, 0.29203],
    millicandelaAt20mA: 200,
    intensityPerKelvin: [-0.01247, 5.656e-5],
    ratings: { power: 0.075, current: 0.03, peakCurrent: 0.185, reverseVolts: 5 },
    derating: [
      [25, 0.03],
      [75.5, 0.01],
      [85, 0.00604],
    ],
  },
  {
    id: "G",
    lead: 4,
    colour: "Green",
    material: "InGaN on sapphire",
    emission: 9.625,
    junctionVoltsAt10mA: 3.116,
    seriesOhms: 0,
    capacitance: 45e-12,
    dominantNm: 525,
    chromaticity: [0.11416, 0.82621],
    millicandelaAt20mA: 1300,
    intensityPerKelvin: [-0.00397, 1.054e-5],
    ratings: { power: 0.1025, current: 0.025, peakCurrent: 0.15, reverseVolts: 5 },
    derating: [
      [25, 0.025],
      [85, 0.00485],
    ],
  },
  {
    id: "B",
    lead: 3,
    colour: "Blue",
    material: "InGaN",
    emission: 7.271,
    junctionVoltsAt10mA: 2.8811,
    seriesOhms: 13.79,
    capacitance: 100e-12,
    dominantNm: 465,
    chromaticity: [0.1355, 0.03988],
    millicandelaAt20mA: 300,
    intensityPerKelvin: [-0.00201, 5.15e-6],
    ratings: { power: 0.12, current: 0.03, peakCurrent: 0.15, reverseVolts: 5 },
    derating: [
      [25, 0.03],
      [85, 0.00614],
    ],
  },
]

export const COMMON_CATHODE_LEAD = 2

export function ambientOf(props: Record<string, string>): number {
  const celsius = Number(props.temp)
  return Number.isFinite(celsius) ? Math.min(AMBIENT.max, Math.max(AMBIENT.min, celsius)) : AMBIENT.reference
}

export function deratedCurrent(die: RgbDie, celsius: number): number {
  const knots = die.derating
  if (celsius <= knots[0][0]) return knots[0][1]
  for (let k = 1; k < knots.length; k++) {
    const [t0, i0] = knots[k - 1]
    const [t1, i1] = knots[k]
    if (celsius <= t1) return i0 + ((i1 - i0) * (celsius - t0)) / (t1 - t0)
  }
  return knots[knots.length - 1][1]
}

export function intensityVsAmbient(die: RgbDie, celsius: number): number {
  const dt = celsius - AMBIENT.reference
  const [linear, quadratic] = die.intensityPerKelvin
  return Math.max(0, 1 + linear * dt + quadratic * dt * dt)
}

export function luminousIntensity(die: RgbDie, amps: number, celsius = AMBIENT.reference): number {
  return die.millicandelaAt20mA * (Math.max(0, amps) / RATED_TEST_CURRENT) * intensityVsAmbient(die, celsius)
}

const XYZ_TO_LINEAR_SRGB = [
  [3.2406, -1.5372, -0.4986],
  [-0.9689, 1.8758, 0.0415],
  [0.0557, -0.204, 1.057],
] as const

export type DieLight = { level: number; amps?: number } | undefined

export function rgbLedGlow(lights: readonly DieLight[], celsius = AMBIENT.reference, dies: readonly RgbDie[] = L154A4SURKQBDZGW): { color: string; level: number } | null {
  const xyz = [0, 0, 0]
  let level = 0
  dies.forEach((die, i) => {
    const light = lights[i]
    if (!light || light.level <= 0) return
    const relative = intensityVsAmbient(die, celsius)
    level = Math.max(level, light.level * relative)
    const luminance = luminousIntensity(die, light.amps ?? 0, celsius)
    const [x, y] = die.chromaticity
    xyz[0] += (luminance * x) / y
    xyz[1] += luminance
    xyz[2] += (luminance * (1 - x - y)) / y
  })
  if (level <= 0 || xyz[1] <= 0) return null
  const linear = XYZ_TO_LINEAR_SRGB.map((row) => Math.max(0, row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2]))
  const peak = Math.max(...linear)
  const [r, g, b] = linear.map((c) => Math.round(255 * srgbEncode(c / peak)))
  return { color: `rgb(${r} ${g} ${b})`, level: Math.min(1, level) }
}

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
  description: `Kingbright ${PART_NUMBER}, a 5 mm full-colour lamp: Hyper Red AlGaInP, blue and green InGaN dies on leads 1, 3 and 4, the common cathode on lead 2. Each die follows the datasheet's I–V curve, burns on its own past its ratings (30, 30 and 25 mA DC derated above 25 °C, 185, 150 and 150 mA peak, 5 V reversed), and the package glows in the mix of the light the three emit.`,
  keywords: [PART_NUMBER, "RGB", "full colour", "full color", "common cathode", "Kingbright"],
  category: "Semiconductors",
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
