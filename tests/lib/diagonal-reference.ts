import type { Point } from "@/schematic/types"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { canonical } from "./pin-partition"

const LATTICE = 12

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y
const key = (p: Point) => `${p.x},${p.y}`
const show = (p: Point) => `(${p.x / LATTICE}, ${p.y / LATTICE})`
const showSegment = (s: WireSegment) => `${s.id} ${show(s.a)}→${show(s.b)}${s.color ? ` ${s.color}` : ""}`
const onLattice = (p: Point) => Number.isInteger(p.x / LATTICE) && Number.isInteger(p.y / LATTICE)

const lattice = (p: Point) => ({ x: p.x / LATTICE, y: p.y / LATTICE })

function cross(o: Point, a: Point, b: Point): number {
  const u = lattice(o)
  const v = lattice(a)
  const w = lattice(b)
  return (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x)
}

const between = (v: number, a: number, b: number) => v >= Math.min(a, b) && v <= Math.max(a, b)

export const exactlyOn = (s: { a: Point; b: Point }, p: Point) => onLattice(p) && cross(s.a, s.b, p) === 0 && between(p.x, s.a.x, s.b.x) && between(p.y, s.a.y, s.b.y)

export const exactlyInside = (s: { a: Point; b: Point }, p: Point) => exactlyOn(s, p) && !same(p, s.a) && !same(p, s.b)

const gcd = (a: number, b: number): number => (b === 0 ? Math.abs(a) : gcd(b, a % b))

export function latticeSteps(s: { a: Point; b: Point }): Point[] {
  const a = lattice(s.a)
  const b = lattice(s.b)
  const g = gcd(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
  const out: Point[] = []
  for (let k = 0; k <= g; k++) out.push({ x: (a.x + ((b.x - a.x) / g) * k) * LATTICE, y: (a.y + ((b.y - a.y) / g) * k) * LATTICE })
  return out
}

export const latticeInside = (s: { a: Point; b: Point }) => latticeSteps(s).slice(1, -1)

const direction = (s: { a: Point; b: Point }) => ({ x: s.b.x - s.a.x, y: s.b.y - s.a.y })

const parallel = (s: { a: Point; b: Point }, t: { a: Point; b: Point }) => {
  const d = lattice(direction(s))
  const e = lattice(direction(t))
  return d.x * e.y - d.y * e.x === 0
}

export const collinear = (s: { a: Point; b: Point }, t: { a: Point; b: Point }) => parallel(s, t) && cross(s.a, s.b, t.a) === 0

function overlapLength(s: { a: Point; b: Point }, t: { a: Point; b: Point }): number {
  const d = direction(s)
  const along = (p: Point) => p.x * d.x + p.y * d.y
  const lo = Math.max(Math.min(along(s.a), along(s.b)), Math.min(along(t.a), along(t.b)))
  const hi = Math.min(Math.max(along(s.a), along(s.b)), Math.max(along(t.a), along(t.b)))
  return hi - lo
}

export function diagonalNormalFormViolations(wires: readonly WireSegment[], pins: readonly WirePin[]): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const s of wires) {
    if (ids.has(s.id)) out.push(`id ${s.id} used twice`)
    ids.add(s.id)
    if (same(s.a, s.b)) out.push(`N1: ${showSegment(s)} has no length`)
    for (const p of [s.a, s.b]) if (!onLattice(p)) out.push(`N1: ${showSegment(s)} ends off the lattice`)
  }
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const s = wires[i]
      const t = wires[j]
      if (same(s.a, s.b) || same(t.a, t.b) || !collinear(s, t)) continue
      if (overlapLength(s, t) > 0) out.push(`N2: ${showSegment(s)} and ${showSegment(t)} overlap`)
    }
  }
  const ends = [...wires.flatMap((s) => [s.a, s.b]), ...pins.filter((p) => !p.socket).map((p) => p.at)]
  for (const s of wires) for (const p of ends) if (exactlyInside(s, p)) out.push(`N3: a conductor end at ${show(p)} lies inside ${showSegment(s)}`)
  const endsAt = new Map<string, WireSegment[]>()
  for (const s of wires) for (const p of [s.a, s.b]) endsAt.set(key(p), [...(endsAt.get(key(p)) ?? []), s])
  for (const [at, meeting] of endsAt) {
    if (meeting.length !== 2) continue
    const [s, t] = meeting
    const p = same(s.a, t.a) || same(s.a, t.b) ? s.a : s.b
    const pinned = pins.some((pin) => key(pin.at) === at)
    const crossed = wires.some((u) => u !== s && u !== t && exactlyOn(u, p))
    if (collinear(s, t) && !pinned && !crossed && s.color === t.color) out.push(`N4: ${showSegment(s)} and ${showSegment(t)} meet at ${show(p)} with nothing else there`)
  }
  return out
}

const connects = (s: { a: Point; b: Point }, t: { a: Point; b: Point }) => exactlyOn(t, s.a) || exactlyOn(t, s.b) || exactlyOn(s, t.a) || exactlyOn(s, t.b)

const pinJoins = (pin: { at: Point; socket?: boolean }, s: { a: Point; b: Point }) => exactlyOn(s, pin.at) && (!pin.socket || same(pin.at, s.a) || same(pin.at, s.b))

export function diagonalPartition(wires: readonly { a: Point; b: Point }[], pins: readonly { key: string; at: Point; socket?: boolean }[]): string[][] {
  const segments = wires.filter((s) => !same(s.a, s.b))
  const n = pins.length + segments.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (i: number, j: number) => {
    parent[find(i)] = find(j)
  }
  const P = pins.length
  for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) if (same(pins[i].at, pins[j].at)) union(i, j)
  for (let i = 0; i < P; i++) for (let s = 0; s < segments.length; s++) if (pinJoins(pins[i], segments[s])) union(i, P + s)
  for (let s = 0; s < segments.length; s++) for (let t = s + 1; t < segments.length; t++) if (connects(segments[s], segments[t])) union(P + s, P + t)
  const groups = new Map<number, string[]>()
  for (let i = 0; i < P; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), pins[i].key])
  return canonical([...groups.values()].filter((g) => g.length > 1))
}

export function diagonalPaint(wires: readonly WireSegment[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of wires) {
    if (same(s.a, s.b)) continue
    const steps = latticeSteps(s)
    for (let k = 1; k < steps.length; k++) {
      const [p, q] = [steps[k - 1], steps[k]].sort((u, v) => u.x - v.x || u.y - v.y)
      const unit = `${show(p)}→${show(q)}`
      if (!(unit in out)) out[unit] = s.color ?? "auto"
    }
  }
  return out
}

export function crossingOf(s: { a: Point; b: Point }, t: { a: Point; b: Point }): Point | null {
  const d = direction(s)
  const e = direction(t)
  const denominator = d.x * e.y - d.y * e.x
  if (denominator === 0) return null
  const u = ((t.a.x - s.a.x) * e.y - (t.a.y - s.a.y) * e.x) / denominator
  const v = ((t.a.x - s.a.x) * d.y - (t.a.y - s.a.y) * d.x) / denominator
  if (u < 0 || u > 1 || v < 0 || v > 1) return null
  return { x: s.a.x + d.x * u, y: s.a.y + d.y * u }
}
