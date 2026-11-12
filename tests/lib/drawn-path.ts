import type { Point } from "@/schematic/geometry"

const STEPS_PER_CURVE = 96

export type Flat = { readonly points: readonly Point[]; readonly at: readonly number[]; readonly length: number }

const COMMAND = /[MLQ]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

export function flatten(d: string): Flat {
  const tokens = d.match(COMMAND) ?? []
  const points: Point[] = []
  let i = 0
  const read = (): Point => {
    const p = { x: Number(tokens[i]), y: Number(tokens[i + 1]) }
    i += 2
    return p
  }
  while (i < tokens.length) {
    const command = tokens[i++]
    if (command === "M") {
      if (points.length) throw new Error(`a second subpath in ${d}`)
      points.push(read())
    } else if (command === "L") points.push(read())
    else if (command === "Q") {
      const from = points[points.length - 1]
      const control = read()
      const to = read()
      for (let k = 1; k <= STEPS_PER_CURVE; k++) {
        const t = k / STEPS_PER_CURVE
        const u = 1 - t
        points.push({ x: u * u * from.x + 2 * u * t * control.x + t * t * to.x, y: u * u * from.y + 2 * u * t * control.y + t * t * to.y })
      }
    } else throw new Error(`unknown command ${command} in ${d}`)
  }
  const at = [0]
  for (let k = 1; k < points.length; k++) at.push(at[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y))
  return { points, at, length: at[at.length - 1] ?? 0 }
}

export function pointAt(flat: Flat, s: number): Point {
  const { points, at } = flat
  if (s <= 0) return points[0]
  if (s >= flat.length) return points[points.length - 1]
  let lo = 0
  let hi = at.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (at[mid] <= s) lo = mid
    else hi = mid
  }
  const span = at[hi] - at[lo]
  const t = span ? (s - at[lo]) / span : 0
  return { x: points[lo].x + (points[hi].x - points[lo].x) * t, y: points[lo].y + (points[hi].y - points[lo].y) * t }
}

export function arcLengthOf(flat: Flat, p: Point): number {
  let best = Infinity
  let s = 0
  for (let k = 1; k < flat.points.length; k++) {
    const a = flat.points[k - 1]
    const b = flat.points[k]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
    const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
    if (d < best) {
      best = d
      s = flat.at[k - 1] + Math.sqrt(len2) * t
    }
  }
  return s
}

export function worstGapAlong(part: Flat, whole: Flat, from: number, step = 0.25): number {
  let worst = 0
  const samples = Math.max(1, Math.ceil(part.length / step))
  for (let k = 0; k <= samples; k++) {
    const u = (part.length * k) / samples
    const p = pointAt(part, u)
    const q = pointAt(whole, from + u)
    worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y))
  }
  return worst
}
