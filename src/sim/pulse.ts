export type PulseTiming = { period: number; width: number; delay: number }

export type PulseEdge = { time: number; level: boolean }

type PulseShape = { frequency: number; duty: number; delay: number }

const periodOf = (source: PulseShape) => (source.frequency > 0 ? 1 / source.frequency : Infinity)
const widthOf = (source: PulseShape) => {
  const duty = Math.min(1, Math.max(0, source.duty))
  return duty > 0 ? duty * periodOf(source) : 0
}

export function pulseTiming(source: PulseShape): PulseTiming {
  return { period: periodOf(source), width: widthOf(source), delay: Math.max(0, source.delay) }
}

function cycleAt(t: number, period: number, delay: number): number {
  let k = Math.floor((t - delay) / period)
  while (delay + (k + 1) * period <= t) k++
  while (k > 0 && delay + k * period > t) k--
  return k
}

export function pulseHigh(t: number, source: PulseShape): boolean {
  const period = periodOf(source)
  const width = widthOf(source)
  const delay = Math.max(0, source.delay)
  if (width <= 0 || t < delay) return false
  if (width >= period) return true
  return t < delay + cycleAt(t, period, delay) * period + width
}

export function nextPulseEdge(t: number, { period, width, delay }: PulseTiming): PulseEdge | null {
  if (width <= 0) return null
  if (t < delay) return { time: delay, level: true }
  if (width >= period) return null
  const k = cycleAt(t, period, delay)
  const fall = delay + k * period + width
  if (t < fall) return { time: fall, level: false }
  return { time: delay + (k + 1) * period, level: true }
}
