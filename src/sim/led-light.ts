/**
 * How an indicator LED looks at a given current: whether an eye in a lit room sees it on, and how
 * bright it reads. Documents in docs/led-model (not in git):
 *
 * Light against current, relative to the 20 mA every datasheet below rates at, read off the log-log
 * "relative luminous intensity vs forward current" curves:
 *   AlGaInP (red, orange, yellow, yellow-green): OSRAM LS Q976 p.7, curve OHL00556, 0.1–20 mA.
 *   InGaN (blue, green, white): OSRAM LB Q39G v1.7 p.7, curve OHL03549, 1–20 mA (given relative to
 *   5 mA; rescaled to 20 mA here). No InGaN curve found goes below 1 mA: under it the 1–2 mA slope
 *   is carried on (undocumented, see the Decisions in docs/led-model).
 *
 * The technology is told by the forward voltage: AlGaInP parts rate 1.95–2.1 V at 20 mA, InGaN
 * 2.8–3.3 V (Kingbright APT1608SURCK/SYCK/CGCK vs ZGCK/QBC/QWF, Lite-On LTST-C191, Vishay VLMx1300).
 *
 * Seen as on: luminance over the 0603 lens (1.6 × 0.8 mm, Kingbright APT1608 drawing) at least 10 %
 * above its surroundings, MIL-STD-1472F §5.2.2.1.8; the surroundings a white page in a 500 lx office
 * (EN 12464-1), ≈130 cd/m² (L = ρE/π, Cornell DEA3500 lighting notes). Rated intensity at 20 mA:
 * Kingbright APT1608SURCK 80 mcd (AlGaInP), APT1608QBC/D 100 mcd (InGaN), typical.
 *
 * Brightness drawn: Stevens' power law, perceived brightness ∝ luminance^β, with β = 0.5 (the point-
 * source exponent; an 0603 at arm's length subtends ~11′, under ISO 24550's 20′ "small indicator"),
 * 1 at the rated 20 mA.
 */

export type LedTechnology = "AlGaInP" | "InGaN"

export const LED_RATED_AMPS = 20e-3

/** [mA, intensity relative to 20 mA], ascending. */
const CURVES: Record<LedTechnology, readonly [number, number][]> = {
  AlGaInP: [
    [0.1, 0.0052],
    [0.3, 0.0155],
    [1, 0.051],
    [5, 0.27],
    [20, 1],
  ],
  InGaN: [
    [1, 0.24 / 2.85],
    [2, 0.45 / 2.85],
    [5, 1 / 2.85],
    [10, 1.71 / 2.85],
    [20, 1],
  ],
}

const RATED_MCD: Record<LedTechnology, number> = { AlGaInP: 80, InGaN: 100 }

const SURROUND_CD_PER_M2 = 130
const ABOVE_SURROUND = 1.1
const LENS_M2 = 1.6e-3 * 0.8e-3
/** Intensity at which the lens is 10 % brighter than the page around it, mcd (≈ 0.18). */
export const LED_VISIBLE_MCD = ABOVE_SURROUND * SURROUND_CD_PER_M2 * LENS_M2 * 1e3

const STEVENS_POINT_SOURCE = 0.5

/** Below this forward voltage (the diode model's, at 10 mA) the die is AlGaInP. */
const INGAN_FROM_VF = 2.4

export function ledTechnology(vf: number): LedTechnology {
  return vf < INGAN_FROM_VF ? "AlGaInP" : "InGaN"
}

/** Luminous intensity relative to the rated 20 mA, by log-log interpolation; outside the curve its end slope carries on. */
export function relativeIntensity(amps: number, tech: LedTechnology): number {
  if (!(amps > 0)) return 0
  const ma = amps * 1e3
  const c = CURVES[tech]
  let i = 1
  while (i < c.length - 1 && ma > c[i][0]) i++
  const [x0, y0] = c[i - 1]
  const [x1, y1] = c[i]
  const slope = Math.log(y1 / y0) / Math.log(x1 / x0)
  return y0 * Math.pow(ma / x0, slope)
}

export function ledLight(amps: number, vf: number): { on: boolean; level: number; mcd: number } {
  const tech = ledTechnology(vf)
  const rel = relativeIntensity(amps, tech)
  const mcd = rel * RATED_MCD[tech]
  return { on: mcd >= LED_VISIBLE_MCD, level: Math.min(1, Math.pow(rel, STEVENS_POINT_SOURCE)), mcd }
}

/** Current at which an LED of this forward voltage starts to be seen on (the inverse of `ledLight(…).on`). */
export function ledVisibleAmps(vf: number): number {
  let lo = 1e-9
  let hi = LED_RATED_AMPS
  for (let k = 0; k < 60; k++) {
    const mid = Math.sqrt(lo * hi)
    if (ledLight(mid, vf).on) hi = mid
    else lo = mid
  }
  return hi
}
