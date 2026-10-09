import { CurrentCurve, LogCurrentCurve } from "./curve"

export const NE555 = {
  operating: 1.8,
  minimum: 4.5,
  maximum: 16,
  absolute: 18,
  resetThreshold: 0.7,
  triggerBias: 0.5e-6,
  thresholdBias: 30e-9,
  resetGrounded: 0.4e-3,
  resetAtSupply: 0.1e-3,
  biasKnee: 0.3,
  quiescentSlope: 0.633e-3,
  quiescentLowKnee: 0.79,
  quiescentHighKnee: 2.37,
  quiescentSoftness: 0.3,
  dischargeScale: 3,
  power: 1.27,
  current: 0.225,
  divider: 5e3,
}

const SOURCE_DROP = new LogCurrentCurve([
  [1e-3, 1.3],
  [2e-3, 1.32],
  [5e-3, 1.36],
  [10e-3, 1.4],
  [20e-3, 1.43],
  [50e-3, 1.5],
  [100e-3, 1.62],
  [150e-3, 1.95],
  [200e-3, 2.5],
  [300e-3, 4.5],
])

const SINK_AT = [5, 10, 15] as const
const SINK = [
  new CurrentCurve([
    [0, 0],
    [1e-3, 0.0067],
    [10e-3, 0.046],
    [20e-3, 0.091],
    [30e-3, 0.14],
    [40e-3, 0.27],
    [45e-3, 0.45],
    [50e-3, 0.59],
    [55e-3, 0.93],
    [60e-3, 1.22],
    [70e-3, 1.58],
    [100e-3, 1.62],
    [200e-3, 2],
    [300e-3, 4],
  ]),
  new CurrentCurve([
    [0, 0],
    [1e-3, 0.0056],
    [10e-3, 0.04],
    [50e-3, 0.18],
    [60e-3, 0.25],
    [70e-3, 0.33],
    [80e-3, 0.6],
    [100e-3, 1.47],
    [200e-3, 2.2],
    [300e-3, 4.2],
  ]),
  new CurrentCurve([
    [0, 0],
    [1e-3, 0.0051],
    [10e-3, 0.045],
    [20e-3, 0.077],
    [30e-3, 0.11],
    [50e-3, 0.178],
    [70e-3, 0.28],
    [90e-3, 0.44],
    [100e-3, 0.6],
    [200e-3, 2.5],
    [300e-3, 4.5],
  ]),
]

const scratch = new Float64Array(2)

export function outputSource(drop: number, out: Float64Array) {
  SOURCE_DROP.amps(drop, out)
}

export function outputSink(volts: number, supply: number, out: Float64Array) {
  if (supply <= SINK_AT[0]) {
    const drive = Math.max(0.05, (supply - 1.4) / (SINK_AT[0] - 1.4))
    SINK[0].amps(volts, out)
    out[0] *= drive
    out[1] *= drive
    return
  }
  if (supply >= SINK_AT[2]) return SINK[2].amps(volts, out)
  const lo = supply < SINK_AT[1] ? 0 : 1
  const w = (supply - SINK_AT[lo]) / (SINK_AT[lo + 1] - SINK_AT[lo])
  SINK[lo].amps(volts, out)
  SINK[lo + 1].amps(volts, scratch)
  out[0] += (scratch[0] - out[0]) * w
  out[1] += (scratch[1] - out[1]) * w
}

export function dischargeSink(volts: number, supply: number, out: Float64Array) {
  outputSink(volts, supply, out)
  out[0] /= NE555.dischargeScale
  out[1] /= NE555.dischargeScale
}

export function quiescent(supply: number, high: boolean, out: Float64Array) {
  const knee = high ? NE555.quiescentHighKnee : NE555.quiescentLowKnee
  const s = NE555.quiescentSoftness
  const x = (supply - knee) / s
  const soft = x > 30 ? x : Math.log1p(Math.exp(x))
  out[0] = NE555.quiescentSlope * s * soft
  out[1] = NE555.quiescentSlope / (1 + Math.exp(-x))
}

export function bias(amps: number, headroom: number, out: Float64Array) {
  if (headroom <= 0) {
    out[0] = 0
    out[1] = 0
    return
  }
  const e = Math.exp(-headroom / NE555.biasKnee)
  out[0] = amps * (1 - e)
  out[1] = (amps / NE555.biasKnee) * e
}

export function supplyShare(supply: number) {
  return Math.min(1, Math.max(0, supply - (NE555.operating - 1)))
}

export function nextLatch(high: boolean, reset: boolean, set: boolean, clear: boolean): boolean {
  if (reset) return false
  if (set) return true
  if (clear) return false
  return high
}
