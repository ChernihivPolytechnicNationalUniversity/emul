import type { Point } from "../types"
import {
  along,
  alongLine,
  contains,
  cross,
  diagonalLine,
  diagonalOf,
  HALF_CELL,
  highOf,
  horizontalLine,
  isDiagonalLine,
  isHorizontalLine,
  lineCoordinate,
  lineOf,
  lowOf,
  onLattice,
  exactPointCode,
  type PointCode,
  pointOnLine,
  samePoint,
  segmentsMeet,
  slopeKey,
  slopeOf,
  type Slope,
  verticalLine,
  type LineKey,
  type WirePin,
  type WireSegment,
} from "./segment"

export type Touched = { segments?: readonly WireSegment[]; points?: readonly Point[] }

export type NewId = () => string

export type Normalised = { wires: readonly WireSegment[]; added: readonly WireSegment[]; removed: readonly WireSegment[] }

const randomId: NewId = () => crypto.randomUUID()

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

type Span = { lo: number; hi: number }

const slanted = (s: { a: Point; b: Point }) => s.a.x !== s.b.x && s.a.y !== s.b.y

class WireIndex {
  readonly byLine = new Map<LineKey, number[]>()
  readonly cutsOnLine = new Map<LineKey, number[]>()
  readonly pinsAt = new Map<PointCode, number>()
  readonly wires: readonly WireSegment[]
  private readonly indexed = new Set<number>()
  private readonly cutPoints: Point[] = []
  private readonly slopes = new Map<string, Slope>()
  private readonly projected = new Set<string>()

  constructor(wires: readonly WireSegment[]) {
    this.wires = wires
  }

  has(i: number) {
    return this.indexed.has(i)
  }

  add(i: number) {
    if (this.indexed.has(i)) return
    this.indexed.add(i)
    const s = this.wires[i]
    push(this.byLine, lineOf(s), i)
    if (slanted(s)) {
      const slope = slopeOf(s)
      this.slopes.set(slopeKey(slope), slope)
    }
    this.cut(s.a)
    this.cut(s.b)
  }

  addPin(pin: WirePin) {
    const key = exactPointCode(pin.at)
    this.pinsAt.set(key, (this.pinsAt.get(key) ?? 0) + 1)
    if (!pin.socket) this.cut(pin.at)
  }

  private cut(p: Point) {
    push(this.cutsOnLine, horizontalLine(p.y), p.x)
    push(this.cutsOnLine, verticalLine(p.x), p.y)
    this.cutPoints.push(p)
  }

  cutsOn(line: LineKey): readonly number[] {
    if (isDiagonalLine(line)) {
      const { slope } = diagonalOf(line)
      const key = slopeKey(slope)
      if (!this.projected.has(key)) {
        this.projected.add(key)
        for (const p of this.cutPoints) push(this.cutsOnLine, diagonalLine(slope, p), p.x)
      }
    }
    return this.cutsOnLine.get(line) ?? []
  }

  linesThrough(p: Point): LineKey[] {
    const lines: LineKey[] = [horizontalLine(p.y), verticalLine(p.x)]
    for (const slope of this.slopes.values()) lines.push(diagonalLine(slope, p))
    return lines
  }

  private reach = new Map<LineKey, { starts: number[]; furthest: number[] }>()

  passesThrough(p: Point, line: LineKey): boolean {
    let known = this.reach.get(line)
    if (!known) {
      const order = [...(this.byLine.get(line) ?? [])].sort((i, j) => lowOf(this.wires[i]) - lowOf(this.wires[j]))
      const starts = order.map((i) => lowOf(this.wires[i]))
      const furthest: number[] = []
      for (const i of order) furthest.push(Math.max(furthest[furthest.length - 1] ?? -Infinity, highOf(this.wires[i])))
      this.reach.set(line, (known = { starts, furthest }))
    }
    const at = alongLine(line, p)
    let lo = 0
    let hi = known.starts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (known.starts[mid] <= at) lo = mid + 1
      else hi = mid
    }
    return lo > 0 && known.furthest[lo - 1] >= at
  }
}

function wholeIndex(wires: readonly WireSegment[], pins: readonly WirePin[]): WireIndex {
  const index = new WireIndex(wires)
  for (let i = 0; i < wires.length; i++) index.add(i)
  for (const pin of pins) index.addPin(pin)
  return index
}

function collinearWith(wires: readonly WireSegment[], touched: Touched): WireIndex {
  const rows = new Set<number>()
  const columns = new Set<number>()
  const points: Point[] = []
  const note = (p: Point) => {
    rows.add(p.y)
    columns.add(p.x)
    points.push(p)
  }
  for (const p of touched.points ?? []) note(p)
  for (const t of touched.segments ?? []) {
    note(t.a)
    note(t.b)
  }
  const index = new WireIndex(wires)
  for (let i = 0; i < wires.length; i++) {
    const s = wires[i]
    const { a, b } = s
    if (a.y === b.y ? rows.has(a.y) : a.x === b.x ? columns.has(a.x) : points.some((p) => cross(a, b, p) === 0)) index.add(i)
  }
  return index
}

function spansOf(wires: readonly WireSegment[], members: ReadonlySet<number>): Map<LineKey, Span> {
  const spans = new Map<LineKey, Span>()
  for (const i of members) {
    const line = lineOf(wires[i])
    const span = spans.get(line)
    if (span) {
      span.lo = Math.min(span.lo, lowOf(wires[i]))
      span.hi = Math.max(span.hi, highOf(wires[i]))
    } else spans.set(line, { lo: lowOf(wires[i]), hi: highOf(wires[i]) })
  }
  return spans
}

function aroundRuns(index: WireIndex, pins: readonly WirePin[], spans: ReadonlyMap<LineKey, Span>) {
  const rows: number[] = []
  const columns: number[] = []
  const slants: { a: Point; b: Point }[] = []
  for (const [line, span] of spans) {
    if (isDiagonalLine(line)) slants.push({ a: pointOnLine(line, span.lo), b: pointOnLine(line, span.hi) })
    else (isHorizontalLine(line) ? rows : columns).push(lineCoordinate(line), span.lo, span.hi)
  }
  const wires = index.wires
  for (let i = 0; i < wires.length; i++) {
    if (index.has(i)) continue
    const s = wires[i]
    const { a, b } = s
    if (slanted(s)) {
      if (meetsAny(s, rows, columns, slants)) index.add(i)
      continue
    }
    const horizontal = a.y === b.y
    const crossing = horizontal ? columns : rows
    const at = horizontal ? a.y : a.x
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
    const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
    let met = false
    for (let k = 0; k < crossing.length; k += 3) {
      const fixed = crossing[k]
      if (fixed >= lo && fixed <= hi && at >= crossing[k + 1] && at <= crossing[k + 2]) {
        met = true
        break
      }
    }
    if (met || (slants.length && slants.some((t) => segmentsMeet(s, t)))) index.add(i)
  }
  const rowSpans = new Map<number, Span>()
  const columnSpans = new Map<number, Span>()
  for (const [line, span] of spans) if (!isDiagonalLine(line)) (isHorizontalLine(line) ? rowSpans : columnSpans).set(lineCoordinate(line), span)
  for (const pin of pins) {
    const { x, y } = pin.at
    const row = rowSpans.get(y)
    const column = columnSpans.get(x)
    if ((row && x >= row.lo && x <= row.hi) || (column && y >= column.lo && y <= column.hi) || slants.some((t) => contains(t, pin.at))) index.addPin(pin)
  }
}

function meetsAny(s: WireSegment, rows: readonly number[], columns: readonly number[], slants: readonly { a: Point; b: Point }[]): boolean {
  for (let k = 0; k < rows.length; k += 3) if (segmentsMeet(s, { a: { x: rows[k + 1], y: rows[k] }, b: { x: rows[k + 2], y: rows[k] } })) return true
  for (let k = 0; k < columns.length; k += 3) if (segmentsMeet(s, { a: { x: columns[k], y: columns[k + 1] }, b: { x: columns[k], y: columns[k + 2] } })) return true
  return slants.some((t) => segmentsMeet(s, t))
}

const isZeroLength = (s: WireSegment) => samePoint(s.a, s.b)

function assertDrawable(s: WireSegment) {
  if (!onLattice(s.a) || !onLattice(s.b)) throw new Error(`wire ${s.id} has an end off the half-cell lattice: (${s.a.x}, ${s.a.y}) → (${s.b.x}, ${s.b.y})`)
}

function assertUniqueIds(wires: readonly WireSegment[]) {
  const seen = new Set<string>()
  for (const s of wires) {
    if (seen.has(s.id)) throw new Error(`two wires share the id ${s.id}`)
    seen.add(s.id)
  }
}

function hitsThrough(index: WireIndex, points: readonly Point[]): (number[] | undefined)[] {
  const wires = index.wires
  const rows = new Map<number, number[]>()
  const columns = new Map<number, number[]>()
  points.forEach((p, k) => {
    push(rows, p.y, k)
    push(columns, p.x, k)
  })
  const across: (number[] | undefined)[] = []
  const down: (number[] | undefined)[] = []
  const gather = (lines: Map<number, number[]>, key: (at: number) => LineKey, into: (number[] | undefined)[]) => {
    for (const [at, group] of lines) {
      const onLine = index.byLine.get(key(at))
      if (!onLine) continue
      for (const i of onLine) for (const k of group) if (contains(wires[i], points[k])) (into[k] ??= []).push(i)
    }
  }
  gather(rows, horizontalLine, across)
  gather(columns, verticalLine, down)
  const hits = points.map((_, k) => across[k] && down[k] ? [...across[k], ...down[k]] : across[k] ?? down[k])
  for (const [line, onLine] of index.byLine) {
    if (!isDiagonalLine(line)) continue
    points.forEach((p, k) => {
      for (const i of onLine) if (contains(wires[i], p)) (hits[k] ??= []).push(i)
    })
  }
  return hits
}

function affected(index: WireIndex, touched: Touched): Set<number> {
  const out = new Set<number>()
  const wires = index.wires
  const segments = touched.segments ?? []
  const queries: Point[] = [...(touched.points ?? [])]
  const firstEnd = queries.length
  for (const t of segments) queries.push(t.a, t.b)
  const hits = hitsThrough(index, queries)
  const through = (k: number) => {
    for (const i of hits[k] ?? []) out.add(i)
  }
  for (let k = 0; k < firstEnd; k++) through(k)
  segments.forEach((t, n) => {
    through(firstEnd + 2 * n)
    through(firstEnd + 2 * n + 1)
    if (isZeroLength(t)) return
    const lo = lowOf(t)
    const hi = highOf(t)
    for (const i of index.byLine.get(lineOf(t)) ?? []) if (lowOf(wires[i]) <= hi && highOf(wires[i]) >= lo) out.add(i)
  })
  return out
}

type Run = { line: LineKey; lo: number; hi: number; primary: number; color: WireSegment["color"] }

function mergeable(index: WireIndex, run: Run, at: number, next: WireSegment): boolean {
  if (run.color !== next.color) return false
  const p = pointOnLine(run.line, at)
  if (index.pinsAt.has(exactPointCode(p))) return false
  for (const line of index.linesThrough(p)) if (line !== run.line && index.passesThrough(p, line)) return false
  return true
}

class LowestFirst {
  private readonly heap: number[] = []

  get size() {
    return this.heap.length
  }

  peek() {
    return this.heap[0]
  }

  push(value: number) {
    const heap = this.heap
    heap.push(value)
    let at = heap.length - 1
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (heap[parent] <= value) break
      heap[at] = heap[parent]
      at = parent
    }
    heap[at] = value
  }

  pop() {
    const heap = this.heap
    const last = heap.pop()!
    if (!heap.length) return
    let at = 0
    for (;;) {
      const left = 2 * at + 1
      if (left >= heap.length) break
      const child = left + 1 < heap.length && heap[left + 1] < heap[left] ? left + 1 : left
      if (heap[child] >= last) break
      heap[at] = heap[child]
      at = child
    }
    heap[at] = last
  }
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
  const offLattice = new Set<number>()
  const diagonal = isDiagonalLine(line)
  for (const c of index.cutsOn(line)) {
    if (c <= min || c >= max) continue
    if (diagonal ? !onLattice(pointOnLine(line, c)) : !Number.isInteger(c / HALF_CELL)) offLattice.add(c)
    cuts.add(c)
  }
  const stops = [...cuts].sort((a, b) => a - b)
  const open = new LowestFirst()
  let next = 0
  let run: Run | null = null
  for (let k = 0; k + 1 < stops.length; k++) {
    const lo = stops[k]
    const hi = stops[k + 1]
    while (next < byStart.length && lowOf(wires[byStart[next]]) <= lo) open.push(byStart[next++])
    while (open.size && highOf(wires[open.peek()]) <= lo) open.pop()
    if (open.size && offLattice.has(lo)) throw new Error(`a pin at ${lo} on ${diagonal ? line : `${isHorizontalLine(line) ? "h" : "v"}${lineCoordinate(line)}`} lies on a wire but off the half-cell lattice`)
    if (!open.size) {
      if (run) emit(run)
      run = null
      continue
    }
    const owner = open.peek()
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
  const forward = along(source, source.a) <= along(source, source.b)
  const [a, b] = forward ? [lo, hi] : [hi, lo]
  return source.color ? { id, a, b, color: source.color } : { id, a, b }
}

const sameExtent = (s: WireSegment, run: Run) => lowOf(s) === run.lo && highOf(s) === run.hi

export function normaliseEdit(wires: readonly WireSegment[], pins: readonly WirePin[], touched?: Touched, newId: NewId = randomId): Normalised {
  const suspects = touched ? (touched.segments ?? []) : wires
  const dropped = suspects.some(isZeroLength) ? wires.filter(isZeroLength) : []
  const base = dropped.length ? wires.filter((s) => !isZeroLength(s)) : wires
  if (!touched) assertUniqueIds(base)
  let index: WireIndex
  let members: Set<number>
  if (touched) {
    index = collinearWith(base, touched)
    members = affected(index, touched)
    aroundRuns(index, pins, spansOf(base, members))
  } else {
    index = wholeIndex(base, pins)
    members = new Set(base.keys())
  }
  if (members.size === 0) return { wires: base, added: [], removed: dropped }
  const byLine = new Map<LineKey, number[]>()
  for (const i of members) {
    assertDrawable(base[i])
    push(byLine, lineOf(base[i]), i)
  }
  const runs = new Map<number, Run[]>()
  for (const [line, onLine] of byLine) runsOnLine(index, line, onLine, (run) => push(runs, run.primary, run))
  const out: WireSegment[] = []
  const added: WireSegment[] = []
  const removed: WireSegment[] = [...dropped]
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
    removed.push(source)
    mine.forEach((run, k) => {
      const piece = segmentOf(source, run, k === 0 ? source.id : newId())
      out.push(piece)
      added.push(piece)
    })
  }
  if (!added.length && !removed.length) return { wires, added, removed }
  return { wires: out, added, removed }
}

export const normalise = (wires: readonly WireSegment[], pins: readonly WirePin[], touched?: Touched, newId: NewId = randomId): readonly WireSegment[] =>
  normaliseEdit(wires, pins, touched, newId).wires

export type WireEdit = { add?: readonly WireSegment[]; remove?: readonly WireSegment[]; points?: readonly Point[] }

export function commitEdit(previous: readonly WireSegment[], pins: readonly WirePin[], edit: WireEdit, newId: NewId = randomId): Normalised {
  const add = edit.add ?? []
  const remove = edit.remove ?? []
  const gone = new Set(remove)
  const replacing = new Map(add.map((s) => [s.id, s]))
  const inPlace = new Set<WireSegment>()
  const raw: WireSegment[] = []
  for (const s of previous) {
    if (!gone.has(s)) raw.push(s)
    else {
      const next = replacing.get(s.id)
      if (next && !inPlace.has(next)) {
        raw.push(next)
        inPlace.add(next)
      }
    }
  }
  for (const s of add) if (!inPlace.has(s)) raw.push(s)
  const result = normaliseEdit(raw, pins, { segments: [...add, ...remove], points: edit.points }, newId)
  const replaced = new Set(result.removed)
  const fresh = new Set(add)
  const added = new Set([...add.filter((s) => !replaced.has(s)), ...result.added])
  const removed = new Set([...remove, ...result.removed.filter((s) => !fresh.has(s))])
  for (const s of added) {
    if (!removed.has(s)) continue
    added.delete(s)
    removed.delete(s)
  }
  return { wires: result.wires, added: [...added], removed: [...removed] }
}
