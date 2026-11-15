import type { Point } from "@/schematic/types"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"
import { canonical, geometricGroups } from "./pin-partition"

const LATTICE = 12

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y
const flat = (s: WireSegment) => s.a.y === s.b.y
const upright = (s: WireSegment) => s.a.x === s.b.x
const key = (p: Point) => `${p.x},${p.y}`
const show = (p: Point) => `(${p.x / LATTICE}, ${p.y / LATTICE})`
const showSegment = (s: WireSegment) => `${s.id} ${show(s.a)}→${show(s.b)}${s.color ? ` ${s.color}` : ""}`

function covers(s: WireSegment, p: Point, open: boolean): boolean {
  const lo = (u: number, v: number) => (open ? u < v : u <= v)
  if (flat(s)) return p.y === s.a.y && lo(Math.min(s.a.x, s.b.x), p.x) && lo(p.x, Math.max(s.a.x, s.b.x))
  if (upright(s)) return p.x === s.a.x && lo(Math.min(s.a.y, s.b.y), p.y) && lo(p.y, Math.max(s.a.y, s.b.y))
  return false
}

const interior = (s: WireSegment, p: Point) => covers(s, p, true)
const onIt = (s: WireSegment, p: Point) => covers(s, p, false)

export function normalFormViolations(wires: readonly WireSegment[], pins: readonly WirePin[]): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const s of wires) {
    if (ids.has(s.id)) out.push(`id ${s.id} used twice`)
    ids.add(s.id)
    if (same(s.a, s.b)) out.push(`N1: ${showSegment(s)} has no length`)
    else if (flat(s) === upright(s)) out.push(`N1: ${showSegment(s)} is not horizontal or vertical`)
    for (const p of [s.a, s.b]) if (!Number.isInteger(p.x / LATTICE) || !Number.isInteger(p.y / LATTICE)) out.push(`N1: ${showSegment(s)} ends off the lattice`)
  }
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const s = wires[i]
      const t = wires[j]
      const collinear = (flat(s) && flat(t) && s.a.y === t.a.y) || (upright(s) && upright(t) && s.a.x === t.a.x)
      if (!collinear) continue
      const along = (p: Point) => (flat(s) ? p.x : p.y)
      const overlap = Math.min(Math.max(along(s.a), along(s.b)), Math.max(along(t.a), along(t.b))) - Math.max(Math.min(along(s.a), along(s.b)), Math.min(along(t.a), along(t.b)))
      if (overlap > 0) out.push(`N2: ${showSegment(s)} and ${showSegment(t)} overlap`)
    }
  }
  const ends = [...wires.flatMap((s) => [s.a, s.b]), ...pins.filter((p) => !p.socket).map((p) => p.at)]
  for (const s of wires) for (const p of ends) if (interior(s, p)) out.push(`N3: a conductor end at ${show(p)} lies inside ${showSegment(s)}`)
  const endsAt = new Map<string, WireSegment[]>()
  for (const s of wires) for (const p of [s.a, s.b]) endsAt.set(key(p), [...(endsAt.get(key(p)) ?? []), s])
  for (const [at, meeting] of endsAt) {
    if (meeting.length !== 2) continue
    const [s, t] = meeting
    const p = same(s.a, t.a) || same(s.a, t.b) ? s.a : s.b
    const collinear = (flat(s) && flat(t)) || (upright(s) && upright(t))
    const pinned = pins.some((pin) => key(pin.at) === at)
    const crossed = wires.some((u) => u !== s && u !== t && onIt(u, p))
    if (collinear && !pinned && !crossed && s.color === t.color) out.push(`N4: ${showSegment(s)} and ${showSegment(t)} meet at ${show(p)} with nothing else there`)
  }
  return out
}

function endCount(wires: readonly WireSegment[], pins: readonly WirePin[]) {
  const count = new Map<string, { at: Point; ends: number; pins: number }>()
  const at = (p: Point) => {
    let entry = count.get(key(p))
    if (!entry) count.set(key(p), (entry = { at: p, ends: 0, pins: 0 }))
    return entry
  }
  for (const s of wires) for (const p of [s.a, s.b]) at(p).ends++
  for (const pin of pins) at(pin.at).pins++
  return [...count.values()]
}

const byPosition = (a: Point, b: Point) => a.x - b.x || a.y - b.y

export const bruteJunctions = (wires: readonly WireSegment[], pins: readonly WirePin[]) =>
  endCount(wires, pins)
    .filter((e) => e.ends + e.pins >= 3)
    .map((e) => e.at)
    .sort(byPosition)

export const bruteDangling = (wires: readonly WireSegment[], pins: readonly WirePin[]) =>
  endCount(wires, pins)
    .filter((e) => e.ends === 1 && e.pins === 0)
    .map((e) => e.at)
    .sort(byPosition)

export const sortedPoints = (points: readonly Point[]) => [...points].sort(byPosition)

export const referencePartition = (wires: readonly WireSegment[], pins: readonly WirePin[]) =>
  canonical(geometricGroups(pins.map((p) => ({ key: p.key, at: p.at, socket: p.socket })), wires.map((s) => ({ a: s.a, b: s.b }))))

export function geometryOf(wires: readonly WireSegment[]): string[] {
  return wires
    .map((s) => {
      const [p, q] = byPosition(s.a, s.b) <= 0 ? [s.a, s.b] : [s.b, s.a]
      return `${show(p)}→${show(q)}${s.color ? ` ${s.color}` : ""}`
    })
    .sort()
}

export function random(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)],
    chance: (p: number) => next() < p,
  }
}

export function counter(prefix: string) {
  let n = 0
  return () => `${prefix}${++n}`
}

export function paintOf(wires: readonly WireSegment[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of wires) {
    if (same(s.a, s.b)) continue
    const horizontal = flat(s)
    const fixed = horizontal ? s.a.y : s.a.x
    const lo = Math.min(horizontal ? s.a.x : s.a.y, horizontal ? s.b.x : s.b.y)
    const hi = Math.max(horizontal ? s.a.x : s.a.y, horizontal ? s.b.x : s.b.y)
    for (let at = lo; at < hi; at += LATTICE) {
      const unit = `${horizontal ? "h" : "v"}${fixed / LATTICE}:${at / LATTICE}`
      if (!(unit in out)) out[unit] = s.color ?? "auto"
    }
  }
  return out
}
