import type { Point } from "../types"
import {
  contains,
  crossLineThrough,
  HALF_CELL,
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

export type Normalised = { wires: readonly WireSegment[]; added: readonly WireSegment[]; removed: readonly WireSegment[] }

const randomId: NewId = () => crypto.randomUUID()

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

type Span = { lo: number; hi: number }

class WireIndex {
  readonly byLine = new Map<LineKey, number[]>()
  readonly cutsOnLine = new Map<LineKey, number[]>()
  readonly pinsAt = new Map<string, number>()
  readonly wires: readonly WireSegment[]
  private readonly indexed = new Set<number>()

  constructor(wires: readonly WireSegment[]) {
    this.wires = wires
  }

  add(i: number) {
    if (this.indexed.has(i)) return
    this.indexed.add(i)
    const s = this.wires[i]
    push(this.byLine, lineOf(s), i)
    this.cut(s.a)
    this.cut(s.b)
  }

  addPin(pin: WirePin) {
    const key = pointKey(pin.at)
    this.pinsAt.set(key, (this.pinsAt.get(key) ?? 0) + 1)
    if (!pin.socket) this.cut(pin.at)
  }

  private cut(p: Point) {
    push(this.cutsOnLine, horizontalLine(p.y), p.x)
    push(this.cutsOnLine, verticalLine(p.x), p.y)
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
    const at = line[0] === "h" ? p.x : p.y
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
  const note = (p: Point) => {
    rows.add(p.y)
    columns.add(p.x)
  }
  for (const p of touched.points ?? []) note(p)
  for (const t of touched.segments ?? []) {
    note(t.a)
    note(t.b)
  }
  const index = new WireIndex(wires)
  for (let i = 0; i < wires.length; i++) {
    const { a, b } = wires[i]
    if (a.y === b.y ? rows.has(a.y) : columns.has(a.x)) index.add(i)
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
  for (const [line, span] of spans) (line[0] === "h" ? rows : columns).push(Number(line.slice(1)), span.lo, span.hi)
  const wires = index.wires
  for (let i = 0; i < wires.length; i++) {
    const { a, b } = wires[i]
    const horizontal = a.y === b.y
    const crossing = horizontal ? columns : rows
    if (!crossing.length) continue
    const at = horizontal ? a.y : a.x
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
    const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
    for (let k = 0; k < crossing.length; k += 3) {
      const fixed = crossing[k]
      if (fixed >= lo && fixed <= hi && at >= crossing[k + 1] && at <= crossing[k + 2]) {
        index.add(i)
        break
      }
    }
  }
  const rowSpans = new Map<number, Span>()
  const columnSpans = new Map<number, Span>()
  for (const [line, span] of spans) (line[0] === "h" ? rowSpans : columnSpans).set(Number(line.slice(1)), span)
  for (const pin of pins) {
    const { x, y } = pin.at
    const row = rowSpans.get(y)
    const column = columnSpans.get(x)
    if ((row && x >= row.lo && x <= row.hi) || (column && y >= column.lo && y <= column.hi)) index.addPin(pin)
  }
}

const isZeroLength = (s: WireSegment) => samePoint(s.a, s.b)

function assertDrawable(s: WireSegment) {
  if (!isOrthogonal(s)) throw new Error(`wire ${s.id} runs neither horizontally nor vertically: (${s.a.x}, ${s.a.y}) → (${s.b.x}, ${s.b.y})`)
  if (!onLattice(s.a) || !onLattice(s.b)) throw new Error(`wire ${s.id} has an end off the half-cell lattice: (${s.a.x}, ${s.a.y}) → (${s.b.x}, ${s.b.y})`)
}

function assertUniqueIds(wires: readonly WireSegment[]) {
  const seen = new Set<string>()
  for (const s of wires) {
    if (seen.has(s.id)) throw new Error(`two wires share the id ${s.id}`)
    seen.add(s.id)
  }
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
  return !index.passesThrough(p, crossLineThrough(run.line, p))
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
  for (const c of index.cutsOnLine.get(line) ?? []) {
    if (c <= min || c >= max) continue
    if (!Number.isInteger(c / HALF_CELL)) throw new Error(`a pin at ${c} on ${line} lies on a wire but off the half-cell lattice`)
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
  const forward = isHorizontal(source) ? source.a.x <= source.b.x : source.a.y <= source.b.y
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
  const raw = (gone.size ? previous.filter((s) => !gone.has(s)) : previous).concat(add)
  const result = normaliseEdit(raw, pins, { segments: [...add, ...remove], points: edit.points }, newId)
  const replaced = new Set(result.removed)
  const fresh = new Set(add)
  return {
    wires: result.wires,
    added: [...add.filter((s) => !replaced.has(s)), ...result.added],
    removed: [...remove, ...result.removed.filter((s) => !fresh.has(s))],
  }
}
