import { DT } from "./speeds"

const SHORTEST_INTERVAL = 3 * DT
const FEWEST_IMPACTS = 3
const MOST_IMPACTS = 9
const SHORTEST_BURST_SHARE = 0.15
const RESTITUTION_LOW = 0.55
const RESTITUTION_HIGH = 0.8
const CLOSED_SHARE_LOW = 0.15
const CLOSED_SHARE_HIGH = 0.65

export function bounceSeed(part: string, transition: number): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < part.length; i++) hash = Math.imul(hash ^ part.charCodeAt(i), 0x01000193)
  return (hash ^ Math.imul(transition + 1, 0x9e3779b9)) >>> 0
}

export function seededUniform(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function bounceFlips(seed: number, start: number, longest: number): number[] {
  const next = seededUniform(seed)
  const burst = longest * (SHORTEST_BURST_SHARE + (1 - SHORTEST_BURST_SHARE) * next() ** 2)
  const fits = Math.floor(burst / (2 * SHORTEST_INTERVAL))
  const impacts = Math.min(fits, FEWEST_IMPACTS + Math.floor(next() * (MOST_IMPACTS - FEWEST_IMPACTS + 1)))
  if (impacts < 1) return []
  const restitution = RESTITUTION_LOW + (RESTITUTION_HIGH - RESTITUTION_LOW) * next()
  const weights: number[] = []
  for (let i = 0; i < impacts; i++) {
    const flight = restitution ** i
    weights.push(flight * (CLOSED_SHARE_LOW + (CLOSED_SHARE_HIGH - CLOSED_SHARE_LOW) * next()), flight)
  }
  const total = weights.reduce((sum, w) => sum + w, 0)
  const spare = burst - weights.length * SHORTEST_INTERVAL
  const flips: number[] = []
  let at = start
  for (const w of weights) {
    at += SHORTEST_INTERVAL + (spare * w) / total
    flips.push(at)
  }
  return flips
}
