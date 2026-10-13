import { WATSON_STAGE_TAU, WATSON_SUSTAINED_STAGES } from "@/sim/engine"

export function sustainedStep(seconds: number) {
  const x = Math.max(0, seconds) / WATSON_STAGE_TAU
  let term = 1
  let sum = 1
  for (let k = 1; k < WATSON_SUSTAINED_STAGES; k++) {
    term *= x / k
    sum += term
  }
  return 1 - Math.exp(-x) * sum
}

export function sustainedReaches(fraction: number) {
  let lo = 0
  let hi = 1
  while (hi - lo > 1e-7) {
    const mid = (lo + hi) / 2
    if (sustainedStep(mid) < fraction) lo = mid
    else hi = mid
  }
  return hi
}

export const EYE_SETTLED = sustainedReaches(0.99)

export function sustainedPwm(hz: number, duty: number, harmonics = 2000) {
  const phases = 1000
  const out = new Float64Array(phases)
  for (let m = 1; m <= harmonics; m++) {
    const c = Math.sin(Math.PI * m * duty) / (Math.PI * m)
    const w = 2 * Math.PI * m * hz * WATSON_STAGE_TAU
    const magnitude = (1 + w * w) ** (-WATSON_SUSTAINED_STAGES / 2)
    const lag = WATSON_SUSTAINED_STAGES * Math.atan(w)
    for (let p = 0; p < phases; p++) out[p] += 2 * c * magnitude * Math.cos(2 * Math.PI * m * (p / phases - duty / 2) - lag)
  }
  for (let p = 0; p < phases; p++) out[p] += duty
  return { min: Math.min(...out), max: Math.max(...out), mean: duty }
}
