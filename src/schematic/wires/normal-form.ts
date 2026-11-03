import type { Point } from "../types"
import {
  contains,
  crossLineThrough,
  highOf,
  horizontalLine,
  isHorizontal,
  isOrthogonal,
  lineOf,
  lowOf,
  onLattice,
  pointKey,
  pointOnLine,
  samePoint,
  verticalLine,
  type LineKey,
  type WirePin,
  type WireSegment,
} from "./segment"

export type Touched = { segments?: readonly WireSegment[]; points?: readonly Point[] }

export type NewId = () => string

const randomId: NewId = () => crypto.randomUUID()

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

type Region = { rows: ReadonlySet<number>; columns: ReadonlySet<number> }

const crossesAny = (lo: number, hi: number, lines: ReadonlySet<number>) => {
  for (const at of lines) if (at >= lo && at <= hi) return true
  return false
}

function reaches(s: WireSegment, region: Region): boolean {
  if (isHorizontal(s)) return region.rows.has(s.a.y) || crossesAny(Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x), region.columns)
  return region.columns.has(s.a.x) || crossesAny(Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y), region.rows)
}

class WireIndex {
  readonly byLine = new Map<LineKey, number[]>()
  readonly cutsOnLine = new Map<LineKey, number[]>()
  readonly pinsAt = new Map<string, number>()
  readonly wires: readonly WireSegment[]

  constructor(wires: readonly WireSegment[], pins: readonly WirePin[], region: Region | null) {
    this.wires = wires
    for (let i = 0; i < wires.length; i++) {
      const s = wires[i]
      if (region && !reaches(s, region)) continue
      push(this.byLine, lineOf(s), i)
      this.cut(s.a)
      this.cut(s.b)
    }
    for (const pin of pins) {
      if (region && !region.rows.has(pin.at.y) && !region.columns.has(pin.at.x)) continue
      const key = pointKey(pin.at)
      this.pinsAt.set(key, (this.pinsAt.get(key) ?? 0) + 1)
      if (!pin.socket) this.cut(pin.at)
    }
  }

  private cut(p: Point) {
    push(this.cutsOnLine, horizontalLine(p.y), p.x)
    push(this.cutsOnLine, verticalLine(p.x), p.y)
  }

  segmentsThrough(p: Point, line: LineKey): number {
    let count = 0
    for (const i of this.byLine.get(line) ?? []) if (contains(this.wires[i], p)) count++
    return count
  }
}

function regionOf(touched: Touched): Region {
  const rows = new Set<number>()
  const columns = new Set<number>()
  const note = (p: Point) => {
    rows.add(p.y)
    columns.add(p.x)
  }
  for (const p of touched.points ?? []) note(p)
  for (const t of touched.segments ?? []) {
    note(t.a)
    note(t.b)
  }
  return { rows, columns }
}

const isZeroLength = (s: WireSegment) => samePoint(s.a, s.b)

function assertDrawable(s: WireSegment) {
  if (!isOrthogonal(s)) throw new Error(`wire ${s.id} runs neither horizontally nor vertically: (${s.a.x}, ${s.a.y}) → (${s.b.x}, ${s.b.y})`)
  if (!onLattice(s.a) || !onLattice(s.b)) throw new Error(`wire ${s.id} has an end off the half-cell lattice: (${s.a.x}, ${s.a.y}) → (${s.b.x}, ${s.b.y})`)
}

function affected(index: WireIndex, touched: Touched): Set<number> {
  const out = new Set<number>()
  const wires = index.wires
  const through = (p: Point) => {
    for (const line of [horizontalLine(p.y), verticalLine(p.x)]) for (const i of index.byLine.get(line) ?? []) if (contains(wires[i], p)) out.add(i)
  }
  for (const p of touched.points ?? []) through(p)
  for (const t of touched.segments ?? []) {
    through(t.a)
    through(t.b)
    if (isZeroLength(t) || !isOrthogonal(t)) continue
    const lo = lowOf(t)
    const hi = highOf(t)
    for (const i of index.byLine.get(lineOf(t)) ?? []) if (lowOf(wires[i]) <= hi && highOf(wires[i]) >= lo) out.add(i)
  }
  return out
}

type Run = { line: LineKey; lo: number; hi: number; primary: number; color: WireSegment["color"] }

function mergeable(index: WireIndex, run: Run, at: number, next: WireSegment): boolean {
  if (run.color !== next.color) return false
  const p = pointOnLine(run.line, at)
  if (index.pinsAt.has(pointKey(p))) return false
  return index.segmentsThrough(p, crossLineThrough(run.line, p)) === 0
}

function runsOnLine(index: WireIndex, line: LineKey, members: readonly number[], emit: (run: Run) => void) {
  const wires = index.wires
  const byStart = [...members].sort((i, j) => lowOf(wires[i]) - lowOf(wires[j]) || i - j)
  const cuts = new Set<number>()
  let min = Infinity
  let max = -Infinity
  for (const i of byStart) {
    const lo = lowOf(wires[i])
    const hi = highOf(wires[i])
    cuts.add(lo)
    cuts.add(hi)
    if (lo < min) min = lo
    if (hi > max) max = hi
  }
  for (const c of index.cutsOnLine.get(line) ?? []) if (c > min && c < max) cuts.add(c)
  const stops = [...cuts].sort((a, b) => a - b)
  const active: number[] = []
  let next = 0
  let run: Run | null = null
  for (let k = 0; k + 1 < stops.length; k++) {
    const lo = stops[k]
    const hi = stops[k + 1]
    while (next < byStart.length && lowOf(wires[byStart[next]]) <= lo) active.push(byStart[next++])
    let owner = -1
    for (let a = active.length - 1; a >= 0; a--) {
      const i = active[a]
      if (highOf(wires[i]) <= lo) {
        active.splice(a, 1)
        continue
      }
      if (owner < 0 || i < owner) owner = i
    }
    if (owner < 0) {
      if (run) emit(run)
      run = null
      continue
    }
    if (run && run.hi === lo && mergeable(index, run, lo, wires[owner])) {
      run.hi = hi
      if (owner < run.primary) run.primary = owner
      continue
    }
    if (run) emit(run)
    run = { line, lo, hi, primary: owner, color: wires[owner].color }
  }
  if (run) emit(run)
}

function segmentOf(source: WireSegment, run: Run, id: string): WireSegment {
  const lo = pointOnLine(run.line, run.lo)
  const hi = pointOnLine(run.line, run.hi)
  const forward = isHorizontal(source) ? source.a.x <= source.b.x : source.a.y <= source.b.y
  const [a, b] = forward ? [lo, hi] : [hi, lo]
  return source.color ? { id, a, b, color: source.color } : { id, a, b }
}

const sameExtent = (s: WireSegment, run: Run) => lowOf(s) === run.lo && highOf(s) === run.hi

export function normalise(wires: readonly WireSegment[], pins: readonly WirePin[], touched?: Touched, newId: NewId = randomId): readonly WireSegment[] {
  const base = wires.some(isZeroLength) ? wires.filter((s) => !isZeroLength(s)) : wires
  const index = new WireIndex(base, pins, touched ? regionOf(touched) : null)
  const members = touched ? affected(index, touched) : new Set(base.keys())
  if (members.size === 0) return base
  const byLine = new Map<LineKey, number[]>()
  for (const i of members) {
    assertDrawable(base[i])
    push(byLine, lineOf(base[i]), i)
  }
  const runs = new Map<number, Run[]>()
  for (const [line, onLine] of byLine) runsOnLine(index, line, onLine, (run) => push(runs, run.primary, run))
  const out: WireSegment[] = []
  let changed = base !== wires
  for (let i = 0; i < base.length; i++) {
    const source = base[i]
    if (!members.has(i)) {
      out.push(source)
      continue
    }
    const mine = runs.get(i) ?? []
    if (mine.length === 1 && sameExtent(source, mine[0])) {
      out.push(source)
      continue
    }
    changed = true
    mine.forEach((run, k) => out.push(segmentOf(source, run, k === 0 ? source.id : newId())))
  }
  return changed ? out : wires
}
