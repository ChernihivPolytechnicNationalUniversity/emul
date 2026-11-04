/** The L-154A4SURKQBDZGW RGB LED's dies as its datasheet gives them, and the colour they mix to: read by the part and by the field that draws its glow. */
import { srgbEncode } from "@/lib/srgb"

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

/** The colour of a light at CIE 1931 chromaticity (x, y), brightest channel at full, as CSS. */
export function chromaticityColor([x, y]: readonly [number, number]): string {
  const xyz = [x / y, 1, (1 - x - y) / y]
  const linear = XYZ_TO_LINEAR_SRGB.map((row) => Math.max(0, row[0] * xyz[0] + row[1] * xyz[1] + row[2] * xyz[2]))
  const peak = Math.max(...linear)
  const [r, g, b] = linear.map((c) => Math.round(255 * srgbEncode(c / peak)))
  return `rgb(${r} ${g} ${b})`
}

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
