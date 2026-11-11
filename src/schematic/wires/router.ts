import { GRID } from "../grid"
import { footprints } from "../placement"
import { getDef } from "../registry"
import type { PinRef, PlacedObject, Point, Schematic } from "../types"
import { withSegments, wiringOf, type NewId, type Wiring } from "../wire-edits"
import { WireGraph } from "./graph"
import { alongOut, headerOfPin, type HeaderSide } from "./headers"
import { HALF_CELL, onLattice, samePoint, type WirePin, type WireSegment } from "./segment"
import { columnCode, rowCode } from "./sheet"

export type RouteEnd = { readonly pin: PinRef } | { readonly at: Point }

export type RerouteRefusal = { readonly refused: "no-clean-path"; readonly at: Point }

export const REROUTE_REFUSED: Record<RerouteRefusal["refused"], { title: string; why: string }> = {
  "no-clean-path": { title: "Not re-routed", why: "Every way between the wire's ends would run along another net's wire, pass over its pin or bend on it, so the wire stays as it was." },
}

export const isRerouteRefusal = (value: unknown): value is RerouteRefusal => typeof value === "object" && value !== null && "refused" in value

export type RouteAround = { readonly ignore?: ReadonlySet<string>; readonly extra?: readonly WireSegment[] }

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

const DIRS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
]

const START = 4
const HEADINGS = 5
const BEND = 2
const CROSSING = 3
const PRIMARY = 2 ** 24
const WHOLE_STEP = 2
const FIRST_PAD_CELLS = 6
const LAST_PAD_CELLS = 128
const EPS = 1e-6

const STOP = 1
const NO_H = 2
const NO_V = 4
const THROUGH_H = 8
const THROUGH_V = 16
const NO_TURN = 32

const dirIndex = (d: Point) => DIRS.findIndex((e) => e.x === d.x && e.y === d.y)
const opposite = (h: number) => (h + 2) % 4
const isWhole = (p: Point) => Number.isInteger(p.x / GRID) && Number.isInteger(p.y / GRID)
const plus = (p: Point, d: Point, k: number): Point => ({ x: p.x + d.x * k, y: p.y + d.y * k })
const comparePoints = (p: Point, q: Point) => p.x - q.x || p.y - q.y

function compareLists(a: readonly Point[], b: readonly Point[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = comparePoints(a[i], b[i])
    if (c) return c
  }
  return a.length - b.length
}

const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x

function meetings(p: Point, q: Point, c: Point, d: Point): Point[] {
  const e = { x: q.x - p.x, y: q.y - p.y }
  const f = { x: d.x - c.x, y: d.y - c.y }
  const w = { x: c.x - p.x, y: c.y - p.y }
  const denominator = cross(e, f)
  if (Math.abs(denominator) > EPS) {
    const t = cross(w, f) / denominator
    const u = cross(w, e) / denominator
    return t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS ? [] : [{ x: p.x + e.x * t, y: p.y + e.y * t }]
  }
  if (Math.abs(cross(w, e)) > EPS) return []
  const length = e.x * e.x + e.y * e.y
  const along = (o: Point) => ((o.x - p.x) * e.x + (o.y - p.y) * e.y) / length
  const lo = Math.max(0, Math.min(along(c), along(d)))
  const hi = Math.min(1, Math.max(along(c), along(d)))
  if (hi < lo - EPS) return []
  return [plus(p, e, lo), plus(p, e, hi)]
}

const near = (p: Point, q: Point) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS

class Heap {
  private readonly keys: number[] = []
  private readonly states: number[] = []
  private readonly costs: number[] = []

  get size() {
    return this.keys.length
  }

  get key() {
    return this.keys[0]
  }

  push(key: number, state: number, cost: number) {
    let at = this.keys.length
    this.keys.push(key)
    this.states.push(state)
    this.costs.push(cost)
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (this.keys[parent] <= key) break
      this.keys[at] = this.keys[parent]
      this.states[at] = this.states[parent]
      this.costs[at] = this.costs[parent]
      at = parent
    }
    this.keys[at] = key
    this.states[at] = state
    this.costs[at] = cost
  }

  pop(): { state: number; cost: number } {
    const top = { state: this.states[0], cost: this.costs[0] }
    const key = this.keys.pop()!
    const state = this.states.pop()!
    const cost = this.costs.pop()!
    if (!this.keys.length) return top
    let at = 0
    for (;;) {
      const left = 2 * at + 1
      if (left >= this.keys.length) break
      const child = left + 1 < this.keys.length && this.keys[left + 1] < this.keys[left] ? left + 1 : left
      if (this.keys[child] >= key) break
      this.keys[at] = this.keys[child]
      this.states[at] = this.states[child]
      this.costs[at] = this.costs[child]
      at = child
    }
    this.keys[at] = key
    this.states[at] = state
    this.costs[at] = cost
    return top
  }
}

type End = { readonly at: Point; readonly pin?: WirePin; readonly header?: HeaderSide | null; readonly socketPassed: boolean }

type Slip = { readonly landing: Point; readonly heading: number; readonly points: readonly Point[]; readonly cost: number }

type Context = { readonly wiring: Wiring; readonly ignore: ReadonlySet<string>; readonly extra: readonly WireSegment[] }

const keyOf = (ref: PinRef) => `${ref.object}:${ref.pin}`

const objectOfPin = (wiring: Wiring, key: string) => wiring.index.objects.get(key.slice(0, key.indexOf(":")))

const pinOn = (wiring: Wiring) => (object: PlacedObject, id: string) => wiring.index.pin(`${object.id}:${id}`)

function wiresTouching(context: Context, p: Point): WireSegment[] {
  const found = context.wiring.sheet.through(p).filter((s) => !context.ignore.has(s.id))
  for (const s of context.extra) if (meetings(s.a, s.b, p, p).length) found.push(s)
  return found
}

function headerFor(wiring: Wiring, pin: WirePin): HeaderSide | null {
  if (!pin.socket) return null
  const object = objectOfPin(wiring, pin.key)
  return object ? headerOfPin(object, pin.key.slice(pin.key.indexOf(":") + 1), pinOn(wiring)) : null
}

function endOf(context: Context, end: RouteEnd): End | null {
  const { wiring } = context
  const pin = "pin" in end ? wiring.index.pin(keyOf(end.pin)) : [...wiring.index.at(end.at)].sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0))[0]
  const at = "pin" in end ? pin?.at : end.at
  if (!at || !(isWhole(at) || (pin && onLattice(at)))) return null
  const socketPassed = !!pin?.socket && wiresTouching(context, at).some((s) => !samePoint(s.a, at) && !samePoint(s.b, at))
  return { at, pin, header: pin && headerFor(wiring, pin), socketPassed }
}

class Field {
  readonly x0: number
  readonly y0: number
  readonly cols: number
  readonly rows: number
  readonly node: Uint8Array
  readonly hBlock: Uint8Array
  readonly vBlock: Uint8Array
  readonly hCross: Uint8Array
  readonly vCross: Uint8Array

  constructor(box: Box) {
    this.x0 = box.x
    this.y0 = box.y
    this.cols = Math.round(box.w / GRID) + 1
    this.rows = Math.round(box.h / GRID) + 1
    const size = this.cols * this.rows
    this.node = new Uint8Array(size)
    this.hBlock = new Uint8Array(size)
    this.vBlock = new Uint8Array(size)
    this.hCross = new Uint8Array(size)
    this.vCross = new Uint8Array(size)
  }

  cellOf(p: Point): number {
    const i = (p.x - this.x0) / GRID
    const j = (p.y - this.y0) / GRID
    return Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < this.cols && j < this.rows ? j * this.cols + i : -1
  }

  pointOf(cell: number): Point {
    return { x: this.x0 + (cell % this.cols) * GRID, y: this.y0 + Math.floor(cell / this.cols) * GRID }
  }

  neighbour(cell: number, step: number): number {
    const i = cell % this.cols
    const j = (cell - i) / this.cols
    const ni = i + DIRS[step].x
    const nj = j + DIRS[step].y
    return ni >= 0 && nj >= 0 && ni < this.cols && nj < this.rows ? nj * this.cols + ni : -1
  }

  private columnRange(lo: number, hi: number, strict: boolean): [number, number] {
    const first = strict ? Math.floor((lo - this.x0) / GRID) + 1 : Math.ceil((lo - this.x0) / GRID)
    const last = strict ? Math.ceil((hi - this.x0) / GRID) - 1 : Math.floor((hi - this.x0) / GRID)
    return [Math.max(0, first), Math.min(this.cols - 1, last)]
  }

  private rowRange(lo: number, hi: number, strict: boolean): [number, number] {
    const first = strict ? Math.floor((lo - this.y0) / GRID) + 1 : Math.ceil((lo - this.y0) / GRID)
    const last = strict ? Math.ceil((hi - this.y0) / GRID) - 1 : Math.floor((hi - this.y0) / GRID)
    return [Math.max(0, first), Math.min(this.rows - 1, last)]
  }

  wire(s: { readonly a: Point; readonly b: Point }) {
    if (samePoint(s.a, s.b)) return
    if (s.a.y === s.b.y) this.run(s.a.y, Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x), true)
    else if (s.a.x === s.b.x) this.run(s.a.x, Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y), false)
  }

  private run(line: number, lo: number, hi: number, horizontal: boolean) {
    const origin = horizontal ? this.y0 : this.x0
    const start = horizontal ? this.x0 : this.y0
    const span = horizontal ? this.cols : this.rows
    const offset = (line - origin) / GRID
    const block = horizontal ? this.hBlock : this.vBlock
    const crossing = horizontal ? this.vCross : this.hCross
    const across = horizontal ? this.vBlock : this.hBlock
    const index = (k: number, at: number) => (horizontal ? at * this.cols + k : k * this.cols + at)
    if (Number.isInteger(offset)) {
      if (offset < 0 || offset >= (horizontal ? this.rows : this.cols)) return
      const [first, last] = horizontal ? this.columnRange(lo - GRID, hi, true) : this.rowRange(lo - GRID, hi, true)
      for (let k = first; k <= last; k++) {
        const from = start + k * GRID
        if (Math.min(hi, from + GRID) - Math.max(lo, from) > EPS && k < span - 1) block[index(k, offset)] = 1
      }
      const [n0, n1] = horizontal ? this.columnRange(lo, hi, false) : this.rowRange(lo, hi, false)
      for (let k = n0; k <= n1; k++) {
        const v = start + k * GRID
        this.node[index(k, offset)] |= v === lo || v === hi ? STOP : horizontal ? THROUGH_H : THROUGH_V
      }
      return
    }
    const below = Math.floor(offset)
    if (offset - below !== 0.5 || below < 0 || below + 1 >= (horizontal ? this.rows : this.cols)) return
    const [n0, n1] = horizontal ? this.columnRange(lo, hi, false) : this.rowRange(lo, hi, false)
    for (let k = n0; k <= n1; k++) {
      const v = start + k * GRID
      if (v === lo || v === hi) across[index(k, below)] = 1
      else crossing[index(k, below)]++
    }
  }

  pin(p: WirePin) {
    const i = (p.at.x - this.x0) / GRID
    const j = (p.at.y - this.y0) / GRID
    const horizontalOut = !!p.out && p.out.y === 0
    const verticalOut = !!p.out && p.out.x === 0
    if (Number.isInteger(i) && Number.isInteger(j)) {
      if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return
      const cell = j * this.cols + i
      this.node[cell] |= !p.socket || !p.out ? STOP : NO_TURN | (horizontalOut ? NO_V : NO_H)
      return
    }
    if (Number.isInteger(j) && j >= 0 && j < this.rows) {
      const k = Math.floor(i)
      if (k >= 0 && k + 1 < this.cols && (!p.socket || !horizontalOut)) this.hBlock[j * this.cols + k] = 1
    } else if (Number.isInteger(i) && i >= 0 && i < this.cols) {
      const k = Math.floor(j)
      if (k >= 0 && k + 1 < this.rows && (!p.socket || !verticalOut)) this.vBlock[k * this.cols + i] = 1
    }
  }

  body(box: Box) {
    const [r0, r1] = this.rowRange(box.y, box.y + box.h, true)
    const [c0, c1] = this.columnRange(box.x - GRID, box.x + box.w, true)
    for (let j = r0; j <= r1; j++) for (let i = c0; i <= Math.min(c1, this.cols - 2); i++) this.hBlock[j * this.cols + i] = 1
    const [k0, k1] = this.columnRange(box.x, box.x + box.w, true)
    const [s0, s1] = this.rowRange(box.y - GRID, box.y + box.h, true)
    for (let i = k0; i <= k1; i++) for (let j = s0; j <= Math.min(s1, this.rows - 2); j++) this.vBlock[j * this.cols + i] = 1
  }

  lead([pin, inner]: readonly [Point, Point]) {
    const [c0, c1] = this.columnRange(Math.min(pin.x, inner.x) - GRID, Math.max(pin.x, inner.x), false)
    const [r0, r1] = this.rowRange(Math.min(pin.y, inner.y) - GRID, Math.max(pin.y, inner.y), false)
    for (let j = r0; j <= r1; j++)
      for (let i = c0; i <= c1; i++) {
        const p = { x: this.x0 + i * GRID, y: this.y0 + j * GRID }
        const touches = (q: Point) => meetings(p, q, pin, inner).some((m) => !near(m, pin))
        if (i + 1 < this.cols && touches({ x: p.x + GRID, y: p.y })) this.hBlock[j * this.cols + i] = 1
        if (j + 1 < this.rows && touches({ x: p.x, y: p.y + GRID })) this.vBlock[j * this.cols + i] = 1
      }
  }

  zone(header: HeaderSide) {
    const horizontal = header.out.y === 0
    const corners = [header.outerAt, header.clearAt].flatMap((t) => [header.from, header.to].map((u) => ({ x: (t * header.out.x + u * header.across.x) * GRID, y: (t * header.out.y + u * header.across.y) * GRID })))
    const xs = corners.map((p) => p.x)
    const ys = corners.map((p) => p.y)
    const [c0, c1] = this.columnRange(Math.min(...xs), Math.max(...xs), false)
    const [r0, r1] = this.rowRange(Math.min(...ys), Math.max(...ys), false)
    for (let j = r0; j <= r1; j++)
      for (let i = c0; i <= c1; i++) {
        const p = { x: this.x0 + i * GRID, y: this.y0 + j * GRID }
        const t = alongOut(p, header.out)
        const u = (p.x * header.across.x + p.y * header.across.y) / GRID
        if (t > header.outerAt + EPS && t < header.clearAt - EPS && u >= header.from - EPS && u <= header.to + EPS) this.node[j * this.cols + i] |= NO_TURN | (horizontal ? NO_V : NO_H)
      }
  }
}

function fieldOf(context: Context, box: Box, ends: readonly End[]): Field {
  const { wiring, ignore, extra } = context
  const field = new Field(box)
  const sheet = wiring.sheet
  const x1 = box.x + box.w
  const y1 = box.y + box.h
  for (let y = box.y; y <= y1; y += HALF_CELL) for (const s of sheet.along(rowCode(y), box.x, x1)) if (!ignore.has(s.id)) field.wire(s)
  for (let x = box.x; x <= x1; x += HALF_CELL) for (const s of sheet.along(columnCode(x), box.y, y1)) if (!ignore.has(s.id)) field.wire(s)
  for (const s of extra) field.wire(s)
  for (const p of wiring.index.within(box)) field.pin(p)
  for (const end of ends) if (end.header) field.zone(end.header)
  for (const o of wiring.index.spatial.query(box)) {
    const def = getDef(o.def)
    if (!def || def.pinsAreSockets) continue
    const f = footprints(o, GRID)
    if (!f) continue
    const b = f.body.box
    if (b.x > x1 || b.y > y1 || b.x + b.w < box.x || b.y + b.h < box.y) continue
    field.body(b)
    for (const lead of f.leads) field.lead(lead)
  }
  return field
}

function segmentClear(context: Context, a: Point, b: Point, own: Point): boolean {
  const { wiring, ignore, extra } = context
  const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
  const horizontal = a.y === b.y
  const lines: number[] = []
  if (horizontal) {
    lines.push(rowCode(a.y))
    for (let x = box.x; x <= box.x + box.w; x += HALF_CELL) lines.push(columnCode(x))
  } else {
    lines.push(columnCode(a.x))
    for (let y = box.y; y <= box.y + box.h; y += HALF_CELL) lines.push(rowCode(y))
  }
  const lo = horizontal ? box.x : box.y
  const hi = horizontal ? box.x + box.w : box.y + box.h
  const touchesOutsideOwn = (s: { a: Point; b: Point }) => meetings(a, b, s.a, s.b).some((m) => !near(m, own))
  for (const [k, line] of lines.entries()) {
    const span = k === 0 ? [lo, hi] : horizontal ? [a.y, a.y] : [a.x, a.x]
    for (const s of wiring.sheet.along(line, span[0], span[1])) if (!ignore.has(s.id) && touchesOutsideOwn(s)) return false
  }
  for (const s of extra) if (touchesOutsideOwn(s)) return false
  for (const p of wiring.index.within(box)) if (!near(p.at, own)) return false
  for (const o of wiring.index.spatial.query(box)) {
    const def = getDef(o.def)
    if (!def || def.pinsAreSockets) continue
    const f = footprints(o, GRID)
    if (!f) continue
    const r = f.body.box
    const inside = horizontal ? a.y > r.y + EPS && a.y < r.y + r.h - EPS && hi > r.x + EPS && lo < r.x + r.w - EPS : a.x > r.x + EPS && a.x < r.x + r.w - EPS && hi > r.y + EPS && lo < r.y + r.h - EPS
    if (inside) return false
    for (const [pin, inner] of f.leads) if (meetings(a, b, pin, inner).length) return false
  }
  return true
}

function slipsAt(context: Context, end: End): { readonly side: number; readonly landing: Point; readonly half: Point; readonly back: Point; readonly k: number }[] {
  const pin = end.pin
  const header = end.header
  if (!pin?.socket || !pin.out || !header) return []
  const outer = plus(pin.at, pin.out, GRID)
  if (!context.wiring.index.at(outer).some((p) => p.socket && objectOfPin(context.wiring, p.key) === objectOfPin(context.wiring, pin.key))) return []
  if (!wiresTouching(context, outer).length) return []
  const k = header.clearAt - alongOut(pin.at, pin.out)
  if (!Number.isInteger(k) || k < 2) return []
  const found: { side: number; landing: Point; half: Point; back: Point; k: number }[] = []
  for (const side of [1, -1]) {
    const across = { x: header.across.x * side, y: header.across.y * side }
    const half = plus(pin.at, across, HALF_CELL)
    const back = plus(half, pin.out, k * GRID)
    const landing = plus(back, across, HALF_CELL)
    if (!segmentClear(context, pin.at, half, pin.at) || !segmentClear(context, half, back, pin.at) || !segmentClear(context, back, landing, pin.at)) continue
    if (wiresTouching(context, landing).length || context.wiring.index.at(landing).length) continue
    found.push({ side, landing, half, back, k })
  }
  return found
}

type Escape = { readonly landing: Point; readonly heading: number; readonly corners: readonly Point[]; readonly cost: number; readonly turnedOut: boolean }

const halfStepsOf = (from: Point, to: Point) => (Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) / HALF_CELL

function escapesFrom(context: Context, end: End): Escape[] {
  const pin = end.pin
  if (isWhole(end.at) || !pin) return []
  const out = pin.out && pin.out.x * pin.out.y === 0 ? pin.out : null
  const offAlong = (d: Point) => (d.x ? !Number.isInteger(end.at.x / GRID) : !Number.isInteger(end.at.y / GRID))
  const axes: Point[] = out ? [out] : [{ x: 1, y: 0 }, { x: 0, y: 1 }]
  const first = out && offAlong(out) ? [plus(end.at, out, HALF_CELL)] : [end.at]
  const across = out ? { x: Math.abs(out.y), y: Math.abs(out.x) } : null
  const found: Escape[] = []
  const tryPath = (drawn: readonly Point[]) => {
    const route = drawn.filter((p, i) => i === 0 || !samePoint(p, drawn[i - 1]))
    const landing = route[route.length - 1]
    if (route.length < 2 || !isWhole(landing)) return
    for (let i = 1; i < route.length; i++) if (!segmentClear(context, route[i - 1], route[i], end.at)) return
    if (wiresTouching(context, landing).length || context.wiring.index.at(landing).length) return
    const corners = route.slice(1, -1)
    const last = route[route.length - 2]
    const heading = dirIndex({ x: Math.sign(landing.x - last.x), y: Math.sign(landing.y - last.y) })
    const cost = corners.length * PRIMARY_BEND + halfStepsOf(end.at, route[1]) + corners.reduce((sum, p, i) => sum + halfStepsOf(p, route[i + 2]), 0)
    found.push({ landing, heading, corners, cost, turnedOut: false })
    if (out && heading !== dirIndex(out)) found.push({ landing, heading: dirIndex(out), corners: [...corners, landing], cost: cost + PRIMARY_BEND, turnedOut: true })
  }
  if (across) {
    const start = first[0]
    if (isWhole(start)) tryPath([end.at, start])
    else for (const side of [1, -1]) tryPath([end.at, start, plus(start, across, side * HALF_CELL)])
  } else
    for (const [a, b] of [[axes[0], axes[1]], [axes[1], axes[0]]])
      for (const sa of [1, -1])
        for (const sb of [1, -1]) {
          const p1 = offAlong(a) ? plus(end.at, a, sa * HALF_CELL) : end.at
          tryPath([end.at, p1, offAlong(b) ? plus(p1, b, sb * HALF_CELL) : p1])
        }
  return found
}

type Search = { field: Field; g: Float64Array; best: number; overflow: boolean; startCell: number; targetCell: number; starts: readonly Slip[]; ends: readonly (Slip & { readonly cell: number })[] }

const PRIMARY_BEND = BEND * PRIMARY

function search(context: Context, from: End, to: End, box: Box, startSlips: ReturnType<typeof slipsAt>, endSlips: ReturnType<typeof slipsAt>, startEscapes: readonly Escape[], endEscapes: readonly Escape[]): Search {
  const field = fieldOf(context, box, [from, to])
  const states = field.cols * field.rows * HEADINGS
  const g = new Float64Array(states).fill(Infinity)
  const startCell = field.cellOf(from.at)
  const targetCell = field.cellOf(to.at)
  const startOut = from.pin?.out ? dirIndex(from.pin.out) : -1
  const targetOut = to.pin?.out ? dirIndex(to.pin.out) : -1
  const goal = to.at
  const lowerBends = (p: Point, heading: number) => {
    const dx = goal.x - p.x
    const dy = goal.y - p.y
    if (!dx && !dy) return 0
    if (heading === START) return dx && dy ? 1 : 0
    const d = DIRS[heading]
    const ahead = dx * d.x + dy * d.y
    const side = dx * d.y - dy * d.x
    if (!side) return ahead > 0 ? 0 : 2
    return ahead >= 0 ? 1 : 2
  }
  const estimate = (p: Point, heading: number) => lowerBends(p, heading) * PRIMARY_BEND + ((Math.abs(goal.x - p.x) + Math.abs(goal.y - p.y)) / GRID) * WHOLE_STEP
  const starts: Slip[] = [
    ...startSlips.map((s) => ({ landing: s.landing, heading: dirIndex({ x: Math.sign(s.landing.x - s.back.x), y: Math.sign(s.landing.y - s.back.y) }), points: [s.half, s.back], cost: 2 * PRIMARY_BEND + (2 * s.k + 2) })),
    ...startEscapes.map((e) => ({ landing: e.landing, heading: e.heading, points: e.corners, cost: e.cost })),
  ]
  const ends = [
    ...endSlips.flatMap((s) => {
      const cell = field.cellOf(s.landing)
      return cell < 0 ? [] : [{ landing: s.landing, heading: dirIndex({ x: Math.sign(s.back.x - s.landing.x), y: Math.sign(s.back.y - s.landing.y) }), points: [s.back, s.half], cost: 2 * PRIMARY_BEND + (2 * s.k + 2), cell }]
    }),
    ...endEscapes.flatMap((e) => {
      const cell = field.cellOf(e.landing)
      if (cell < 0 || e.turnedOut) return []
      const points = [...e.corners].reverse()
      const next = points[0] ?? to.at
      return [{ landing: e.landing, heading: dirIndex({ x: Math.sign(next.x - e.landing.x), y: Math.sign(next.y - e.landing.y) }), points, cost: e.cost, cell }]
    }),
  ]
  const result: Search = { field, g, best: Infinity, overflow: false, startCell, targetCell, starts, ends }
  if ((startCell < 0 && !starts.length) || (targetCell < 0 && !ends.length)) return result
  const heap = new Heap()
  const open = (state: number, cost: number, p: Point, heading: number) => {
    if (cost >= g[state]) return
    g[state] = cost
    heap.push(cost + estimate(p, heading), state, cost)
  }
  if (startCell >= 0) open(startCell * HEADINGS + START, 0, from.at, START)
  for (const s of starts) {
    const cell = field.cellOf(s.landing)
    if (cell >= 0) open(cell * HEADINGS + s.heading, s.cost, s.landing, s.heading)
  }
  const stepCost = stepCosts(field, startCell, targetCell, startOut, targetOut)
  while (heap.size && heap.key <= result.best) {
    const { state, cost } = heap.pop()
    if (cost > g[state]) continue
    const cell = Math.floor(state / HEADINGS)
    const heading = state % HEADINGS
    if (cell === targetCell) {
      result.best = Math.min(result.best, cost)
      continue
    }
    for (const end of ends) if (end.cell === cell) {
      const extra = endSlipCost(heading, end)
      if (extra >= 0) result.best = Math.min(result.best, cost + extra)
    }
    const here = field.pointOf(cell)
    for (let step = 0; step < 4; step++) {
      const w = stepCost(cell, heading, step)
      if (w === BLOCKED) continue
      if (w === OUTSIDE) {
        const turned = heading !== START && step !== heading
        const out = plus(here, DIRS[step], GRID)
        if (cost + (turned ? PRIMARY_BEND : 0) + WHOLE_STEP + estimate(out, step) <= result.best) result.overflow = true
        continue
      }
      const next = field.neighbour(cell, step)
      open(next * HEADINGS + step, cost + w, field.pointOf(next), step)
    }
  }
  return result
}

function endSlipCost(heading: number, end: { readonly heading: number; readonly cost: number }): number {
  if (heading === opposite(end.heading)) return -1
  return end.cost + (heading !== START && heading !== end.heading ? PRIMARY_BEND : 0)
}

const BLOCKED = -1
const OUTSIDE = -2

function stepCosts(field: Field, startCell: number, targetCell: number, startOut: number, targetOut: number) {
  return (cell: number, heading: number, step: number): number => {
    if (heading !== START && step === opposite(heading)) return BLOCKED
    const turned = heading !== START && step !== heading
    if (turned && cell !== startCell && field.node[cell] & NO_TURN) return BLOCKED
    if (heading === START && cell === startCell && startOut >= 0 && step === opposite(startOut)) return BLOCKED
    const next = field.neighbour(cell, step)
    if (next < 0) return OUTSIDE
    const horizontal = step % 2 === 0
    const edge = step === 0 || step === 1 ? cell : next
    if ((horizontal ? field.hBlock : field.vBlock)[edge]) return BLOCKED
    let crossings = (horizontal ? field.hCross : field.vCross)[edge]
    if (next === targetCell) {
      if (targetOut === step) return BLOCKED
    } else {
      const flags = field.node[next]
      if (flags & STOP || flags & (horizontal ? NO_H : NO_V)) return BLOCKED
      if (flags & (horizontal ? THROUGH_V : THROUGH_H)) crossings++
    }
    return (turned ? PRIMARY_BEND : 0) + crossings * CROSSING * PRIMARY + WHOLE_STEP
  }
}

type Tail = { readonly points: readonly Point[]; readonly lastOk: number }

function chosen(from: End, to: End, found: Search): Point[] | null {
  const { field, g, best, startCell, targetCell, starts, ends } = found
  if (!Number.isFinite(best)) return null
  const startOut = from.pin?.out ? dirIndex(from.pin.out) : -1
  const targetOut = to.pin?.out ? dirIndex(to.pin.out) : -1
  const stepCost = stepCosts(field, startCell, targetCell, startOut, targetOut)
  const onPath = new Uint8Array(g.length)
  const stack: number[] = []
  const mark = (state: number) => {
    if (onPath[state]) return
    onPath[state] = 1
    stack.push(state)
  }
  if (targetCell >= 0) for (let h = 0; h < HEADINGS; h++) if (g[targetCell * HEADINGS + h] === best) mark(targetCell * HEADINGS + h)
  for (const end of ends)
    for (let h = 0; h < HEADINGS; h++) {
      const state = end.cell * HEADINGS + h
      const extra = endSlipCost(h, end)
      if (extra >= 0 && g[state] + extra === best) mark(state)
    }
  while (stack.length) {
    const state = stack.pop()!
    const heading = state % HEADINGS
    if (heading === START) continue
    const cell = Math.floor(state / HEADINGS)
    const before = field.neighbour(cell, opposite(heading))
    if (before < 0) continue
    for (let h = 0; h < HEADINGS; h++) {
      if (h === START && before !== startCell) continue
      const prior = before * HEADINGS + h
      if (!Number.isFinite(g[prior])) continue
      const w = stepCost(before, h, heading)
      if (w >= 0 && g[prior] + w === g[state]) mark(prior)
    }
  }
  const header = to.header
  const okAt = (p: Point) => (!header ? 1 : alongOut(p, header.out) === header.clearAt ? 2 : 0)
  const tails = new Map<number, Tail>()
  const better = (a: Tail, b: Tail) => a.lastOk - b.lastOk || -compareLists(a.points, b.points)
  const order: number[] = []
  for (let state = 0; state < onPath.length; state++) if (onPath[state]) order.push(state)
  order.sort((a, b) => g[b] - g[a])
  for (const state of order) {
    const cell = Math.floor(state / HEADINGS)
    const heading = state % HEADINGS
    let kept: Tail | null = null
    const offer = (t: Tail) => {
      if (!kept || better(t, kept) > 0) kept = t
    }
    if (cell === targetCell) offer({ points: [], lastOk: 1 })
    for (const end of ends) {
      if (end.cell !== cell) continue
      const extra = endSlipCost(heading, end)
      if (extra < 0 || g[state] + extra !== best) continue
      const turned = heading !== START && heading !== end.heading
      offer({ points: [...(turned ? [end.landing] : []), ...end.points], lastOk: 2 })
    }
    if (cell !== targetCell)
      for (let step = 0; step < 4; step++) {
        const w = stepCost(cell, heading, step)
        if (w < 0) continue
        const next = field.neighbour(cell, step) * HEADINGS + step
        const tail = tails.get(next)
        if (!onPath[next] || !tail || g[state] + w !== g[next]) continue
        const turned = heading !== START && step !== heading
        const here = field.pointOf(cell)
        offer(turned ? { points: [here, ...tail.points], lastOk: tail.points.length ? tail.lastOk : okAt(here) } : tail)
      }
    if (kept) tails.set(state, kept)
  }
  type Candidate = { points: Point[]; first: number; axis: boolean; ok: number }
  const candidates: Candidate[] = []
  const startHeader = from.header
  const firstOk = (p: Point | undefined) => (!startHeader || !p ? 1 : alongOut(p, startHeader.out) === startHeader.clearAt ? 1 : 0)
  const lastOk = (corners: readonly Point[]) => (!header || !corners.length ? 1 : alongOut(corners[corners.length - 1], header.out) === header.clearAt ? 1 : 0)
  const candidate = (corners: Point[], first: number, axis: boolean, slipStart: boolean, slipEnd: boolean) => {
    const points = [from.at, ...corners, to.at].filter((p, i, all) => i === 0 || !samePoint(p, all[i - 1]))
    candidates.push({ points, first, axis, ok: (slipStart ? 1 : firstOk(corners[0])) + (slipEnd ? 1 : lastOk(corners)) })
  }
  const startState = startCell * HEADINGS + START
  if (startCell >= 0 && onPath[startState])
    for (let step = 0; step < 4; step++) {
      let cell = startCell
      let heading = START
      for (let m = 1; ; m++) {
        const w = stepCost(cell, heading, step)
        const next = field.neighbour(cell, step)
        const state = next * HEADINGS + step
        if (w < 0 || !onPath[state] || g[cell * HEADINGS + heading] + w !== g[state]) break
        cell = next
        heading = step
        const here = field.pointOf(cell)
        const axis = startOut >= 0 && step === startOut
        if (cell === targetCell) candidate([], Infinity, axis, false, false)
        for (const end of ends) {
          if (end.cell !== cell) continue
          const extra = endSlipCost(heading, end)
          if (extra < 0 || g[state] + extra !== best) continue
          const turned = heading !== end.heading
          candidate([...(turned ? [end.landing] : []), ...end.points], turned ? m : m + 0.5, axis, false, true)
        }
        for (let turn = 0; turn < 4; turn++) {
          if (turn === step || turn === opposite(step)) continue
          const tw = stepCost(cell, heading, turn)
          if (tw < 0) continue
          const after = field.neighbour(cell, turn) * HEADINGS + turn
          const tail = tails.get(after)
          if (!onPath[after] || !tail || g[state] + tw !== g[after]) continue
          candidate([here, ...tail.points], m, axis, false, isEndSlip(tail, ends))
        }
      }
    }
  for (const s of starts) {
    const state = field.cellOf(s.landing) * HEADINGS + s.heading
    if (!onPath[state] || g[state] !== s.cost) continue
    const tail = tails.get(state)
    if (!tail) continue
    candidate([...s.points, ...tail.points], 0.5, false, true, isEndSlip(tail, ends))
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.ok - a.ok || Number(b.axis) - Number(a.axis) || a.first - b.first || compareLists(a.points, b.points))
  return candidates[0].points
}

const isEndSlip = (tail: Tail, ends: readonly Slip[]) => ends.some((e) => e.points.length > 0 && tail.points.length >= e.points.length && e.points.every((p, i) => near(tail.points[tail.points.length - e.points.length + i], p)))

function windowAround(points: readonly Point[], pad: number): Box {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.floor(Math.min(...xs) / GRID) * GRID - pad * GRID
  const y = Math.floor(Math.min(...ys) / GRID) * GRID - pad * GRID
  const x1 = Math.ceil(Math.max(...xs) / GRID) * GRID + pad * GRID
  const y1 = Math.ceil(Math.max(...ys) / GRID) * GRID + pad * GRID
  return { x, y, w: x1 - x, h: y1 - y }
}

const knownFor = (doc: Pick<Schematic, "objects" | "wires">, known?: Wiring) => (known && known.source.objects === doc.objects && known.source.wires === doc.wires ? known : undefined)

function wiringFor(doc: Schematic, known?: Wiring): Wiring {
  return knownFor(doc, known) ?? wiringOf(new WireGraph(), doc)
}

export function routeAround(wiring: Wiring, from: RouteEnd, to: RouteEnd, around: RouteAround = {}): Point[] | null {
  const context: Context = { wiring, ignore: around.ignore ?? new Set(), extra: around.extra ?? [] }
  const a = endOf(context, from)
  const b = endOf(context, to)
  if (!a || !b) return null
  if (samePoint(a.at, b.at)) return [a.at]
  if (a.socketPassed || b.socketPassed) return null
  const startSlips = slipsAt(context, a)
  const endSlips = slipsAt(context, b)
  const startEscapes = escapesFrom(context, a)
  const endEscapes = escapesFrom(context, b)
  if ((!isWhole(a.at) && !startEscapes.length) || (!isWhole(b.at) && !endEscapes.length)) return null
  const reach = [a.at, b.at, ...startSlips.flatMap((s) => [s.landing, s.back]), ...endSlips.flatMap((s) => [s.landing, s.back]), ...startEscapes.map((e) => e.landing), ...endEscapes.map((e) => e.landing)]
  for (let pad = FIRST_PAD_CELLS; ; pad *= 2) {
    const found = search(context, a, b, windowAround(reach, pad), startSlips, endSlips, startEscapes, endEscapes)
    if (Number.isFinite(found.best) || !found.overflow || pad >= LAST_PAD_CELLS) return chosen(a, b, found)
  }
}

export function routeBetween(doc: Schematic, from: RouteEnd, to: RouteEnd, known?: Wiring): readonly Point[] | null {
  return routeAround(wiringFor(doc, known), from, to)
}

const endKey = (wiring: Wiring, p: Point) => [...wiring.sheet.pinsAt(p)].map((pin) => pin.key).sort()[0]

export function runEnds(wiring: Wiring, points: readonly Point[]): [RouteEnd, RouteEnd] {
  const ends = [points[0], points[points.length - 1]].map((p) => ({ p, key: endKey(wiring, p) }))
  ends.sort((a, b) => (a.key !== undefined ? 0 : 1) - (b.key !== undefined ? 0 : 1) || (a.key !== undefined && b.key !== undefined ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : 0) || comparePoints(a.p, b.p))
  const routeEnd = (e: { p: Point; key: string | undefined }): RouteEnd => (e.key ? { pin: { object: e.key.slice(0, e.key.indexOf(":")), pin: e.key.slice(e.key.indexOf(":") + 1) } } : { at: e.p })
  return [routeEnd(ends[0]), routeEnd(ends[1])]
}

const sameRoute = (a: readonly Point[], b: readonly Point[]) => a.length === b.length && a.every((p, i) => samePoint(p, b[i]))

export function rerouted(doc: Schematic, segment: string, newId: NewId, known?: Wiring): Schematic | RerouteRefusal {
  const wiring = wiringFor(doc, known)
  const run = wiring.runBySegment.get(segment)
  if (!run) return doc
  const a = run.points[0]
  const b = run.points[run.points.length - 1]
  if (samePoint(a, b)) return withSegments(doc, [], run.segments, [a], newId)
  const [from, to] = runEnds(wiring, run.points)
  const route = routeAround(wiring, from, to, { ignore: new Set(run.segments.map((s) => s.id)) })
  if (!route) return { refused: "no-clean-path", at: a }
  if (sameRoute(route, run.points) || sameRoute([...route].reverse(), run.points)) return doc
  const color = wiring.segmentsById.get(segment)?.color
  const laid: WireSegment[] = []
  for (let i = 1; i < route.length; i++) laid.push(color ? { id: newId(), a: route[i - 1], b: route[i], color } : { id: newId(), a: route[i - 1], b: route[i] })
  return withSegments(doc, laid, run.segments, [a, b], newId)
}

export function reroutedRuns(doc: Schematic, segments: Iterable<string>, newId: NewId, known?: Wiring): { doc: Schematic; refused: RerouteRefusal | null } {
  let next = doc
  let refused: RerouteRefusal | null = null
  const done = new Set<string>()
  const runOf = (wiring: Wiring, id: string) => wiring.runBySegment.get(id)
  for (const id of segments) {
    const wiring = wiringFor(next, next === doc ? known : undefined)
    const run = runOf(wiring, id)
    if (!run || done.has(run.id)) continue
    for (const s of run.segments) done.add(s.id)
    done.add(run.id)
    const result = rerouted(next, id, newId, wiring)
    if (isRerouteRefusal(result)) refused ??= result
    else next = result
  }
  return { doc: next, refused }
}
