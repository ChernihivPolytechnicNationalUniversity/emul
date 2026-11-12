import { GRID } from "../grid"
import { bodiesOf, runsThrough, type Body } from "../body-crossing"
import { getDef } from "../registry"
import type { PinRef, PlacedObject, Point, Schematic } from "../types"
import { withSegments, wiringOf, type NewId, type Wiring } from "../wire-edits"
import { WireGraph } from "./graph"
import { alongOut, headerOfPin, type HeaderSide } from "./headers"
import { contains, HALF_CELL, onLattice, samePoint, type WirePin, type WireSegment } from "./segment"
import { columnCode, rowCode } from "./sheet"

export type RouteEnd = { readonly pin: PinRef } | { readonly at: Point }

export type RerouteRefusal = { readonly refused: "no-clean-path" | "no-way"; readonly at: Point }

export const REROUTE_REFUSED: Record<RerouteRefusal["refused"], { title: string; why: string }> = {
  "no-clean-path": { title: "Not re-routed", why: "Every way between the wire's ends would run along another net's wire, pass over its pin or bend on it, so the wire stays as it was." },
  "no-way": { title: "Not re-routed", why: "Every other way between the wire's ends would leave a pin backwards, cross a part or a header's sockets, or come back over itself, so the wire stays as it was." },
}

export const isRerouteRefusal = (value: unknown): value is RerouteRefusal => typeof value === "object" && value !== null && "refused" in value

export type RouteAround = { readonly ignore?: ReadonlySet<string>; readonly extra?: readonly WireSegment[]; readonly taken?: ReadonlySet<string>; readonly stops?: readonly Point[]; readonly passable?: (pin: WirePin) => boolean; readonly own?: readonly WireSegment[] }

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
const OWN_H = 64
const OWN_V = 128

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

type Context = { readonly wiring: Wiring; readonly ignore: ReadonlySet<string>; readonly extra: readonly WireSegment[]; readonly taken: ReadonlySet<string>; readonly stops: readonly Point[]; readonly passable: (pin: WirePin) => boolean; readonly own: readonly WireSegment[] }

const NOTHING_TAKEN: ReadonlySet<string> = new Set()

const NO_PIN_PASSABLE = () => false

const contextOf = (wiring: Wiring, around: RouteAround): Context => ({ wiring, ignore: around.ignore ?? new Set(), extra: around.extra ?? [], taken: around.taken ?? NOTHING_TAKEN, stops: around.stops ?? [], passable: around.passable ?? NO_PIN_PASSABLE, own: around.own ?? [] })

const pinsAt = (context: Context, p: Point) => context.wiring.index.at(p).filter((pin) => !context.passable(pin))

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
    else this.slant(s)
  }

  private slant(s: { readonly a: Point; readonly b: Point }) {
    const [c0, c1] = this.columnRange(Math.min(s.a.x, s.b.x) - GRID, Math.max(s.a.x, s.b.x), false)
    const [r0, r1] = this.rowRange(Math.min(s.a.y, s.b.y) - GRID, Math.max(s.a.y, s.b.y), false)
    const edge = (p: Point, q: Point, block: Uint8Array, crossing: Uint8Array, at: number) => {
      const hits = meetings(p, q, s.a, s.b)
      if (hits.length !== 1 || near(hits[0], p) || near(hits[0], q)) return
      if (near(hits[0], s.a) || near(hits[0], s.b)) block[at] = 1
      else crossing[at]++
    }
    for (let j = r0; j <= r1; j++)
      for (let i = c0; i <= c1; i++) {
        const p = { x: this.x0 + i * GRID, y: this.y0 + j * GRID }
        const cell = j * this.cols + i
        if (contains(s, p)) this.node[cell] |= samePoint(p, s.a) || samePoint(p, s.b) ? STOP : THROUGH_H | THROUGH_V | NO_TURN
        if (i + 1 < this.cols) edge(p, { x: p.x + GRID, y: p.y }, this.hBlock, this.hCross, cell)
        if (j + 1 < this.rows) edge(p, { x: p.x, y: p.y + GRID }, this.vBlock, this.vCross, cell)
      }
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

  ownWire(s: { readonly a: Point; readonly b: Point }) {
    if (samePoint(s.a, s.b)) return
    const horizontal = s.a.y === s.b.y
    if (!horizontal && s.a.x !== s.b.x) return
    const line = horizontal ? s.a.y : s.a.x
    const lo = horizontal ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y)
    const hi = horizontal ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y)
    const offset = (line - (horizontal ? this.y0 : this.x0)) / GRID
    const [n0, n1] = horizontal ? this.columnRange(lo, hi, true) : this.rowRange(lo, hi, true)
    if (Number.isInteger(offset)) {
      if (offset < 0 || offset >= (horizontal ? this.rows : this.cols)) return
      for (let k = n0; k <= n1; k++) this.node[horizontal ? offset * this.cols + k : k * this.cols + offset] |= horizontal ? OWN_H : OWN_V
      return
    }
    const below = Math.floor(offset)
    if (offset - below !== 0.5 || below < 0 || below + 1 >= (horizontal ? this.rows : this.cols)) return
    for (let k = n0; k <= n1; k++) (horizontal ? this.vCross : this.hCross)[horizontal ? below * this.cols + k : k * this.cols + below]++
  }

  pin(p: WirePin, taken: boolean) {
    const i = (p.at.x - this.x0) / GRID
    const j = (p.at.y - this.y0) / GRID
    const horizontalOut = !!p.out && p.out.y === 0
    const verticalOut = !!p.out && p.out.x === 0
    if (Number.isInteger(i) && Number.isInteger(j)) {
      if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return
      const cell = j * this.cols + i
      this.node[cell] |= !p.socket || !p.out || taken ? STOP : p.shunt ? NO_TURN | NO_H | NO_V : NO_TURN | (horizontalOut ? NO_V : NO_H)
      if (p.shunt) this.lead([p.at, plus(p.at, p.shunt, 1)])
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

  body(body: Body) {
    const box = body.box
    const [c0, c1] = this.columnRange(box.x - GRID, box.x + box.w + GRID, false)
    const [r0, r1] = this.rowRange(box.y - GRID, box.y + box.h + GRID, false)
    for (let j = r0; j <= r1; j++)
      for (let i = c0; i <= c1; i++) {
        const p = { x: this.x0 + i * GRID, y: this.y0 + j * GRID }
        if (i + 1 < this.cols && closedBy(body, p, { x: p.x + GRID, y: p.y })) this.hBlock[j * this.cols + i] = 1
        if (j + 1 < this.rows && closedBy(body, p, { x: p.x, y: p.y + GRID })) this.vBlock[j * this.cols + i] = 1
      }
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

const OUTLINE_BAND = GRID / 4

function alongOutline(body: Body, a: Point, b: Point): boolean {
  const horizontal = a.y === b.y
  const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
  const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
  const line = horizontal ? a.y : a.x
  return body.contour.some((corners) =>
    corners.some((p, i) => {
      const q = corners[(i + 1) % corners.length]
      if (horizontal ? Math.abs(p.y - q.y) > EPS : Math.abs(p.x - q.x) > EPS) return false
      if (Math.abs((horizontal ? p.y : p.x) - line) >= OUTLINE_BAND - EPS) return false
      const elo = horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y)
      const ehi = horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y)
      return Math.min(hi, ehi) - Math.max(lo, elo) > EPS
    }),
  )
}

const closedBy = (body: Body, a: Point, b: Point) => runsThrough({ a, b }, body) || alongOutline(body, a, b)

function bodiesNear(wiring: Wiring, box: Box): Body[] {
  return bodiesOf(wiring.index.spatial.query(box).filter((o) => !getDef(o.def)?.pinsAreSockets))
}

function fieldOf(context: Context, box: Box, ends: readonly End[]): Field {
  const { wiring, ignore, extra } = context
  const field = new Field(box)
  const sheet = wiring.sheet
  const x1 = box.x + box.w
  const y1 = box.y + box.h
  for (let y = box.y; y <= y1; y += HALF_CELL) for (const s of sheet.along(rowCode(y), box.x, x1)) if (!ignore.has(s.id)) field.wire(s)
  for (let x = box.x; x <= x1; x += HALF_CELL) for (const s of sheet.along(columnCode(x), box.y, y1)) if (!ignore.has(s.id)) field.wire(s)
  for (const s of sheet.slantsWithin(box)) if (!ignore.has(s.id)) field.wire(s)
  for (const s of extra) field.wire(s)
  for (const s of context.own) field.ownWire(s)
  for (const p of wiring.index.within(box)) if (!context.passable(p)) field.pin(p, context.taken.has(p.key))
  for (const at of context.stops) field.pin({ key: "", at }, true)
  for (const end of ends) if (end.header) field.zone(end.header)
  for (const body of bodiesNear(wiring, box)) {
    const b = body.box
    if (b.x > x1 || b.y > y1 || b.x + b.w < box.x || b.y + b.h < box.y) continue
    field.body(body)
    for (const lead of body.leads) field.lead(lead)
  }
  return field
}

function crossingsOn(context: Context, a: Point, b: Point, own: Point): number {
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
  const seen = new Set<WireSegment>()
  let crossed = 0
  const meet = (s: WireSegment): boolean => {
    if (seen.has(s)) return true
    seen.add(s)
    const hits = meetings(a, b, s.a, s.b).filter((m) => !near(m, own))
    if (!hits.length) return true
    if (hits.length > 1 || near(hits[0], a) || near(hits[0], b) || near(hits[0], s.a) || near(hits[0], s.b)) return false
    crossed++
    return true
  }
  for (const [k, line] of lines.entries()) {
    const span = k === 0 ? [lo, hi] : horizontal ? [a.y, a.y] : [a.x, a.x]
    for (const s of wiring.sheet.along(line, span[0], span[1])) if (!ignore.has(s.id) && !meet(s)) return -1
  }
  for (const s of wiring.sheet.slantsWithin(box)) if (!ignore.has(s.id) && !meet(s)) return -1
  for (const s of extra) if (!meet(s)) return -1
  for (const p of wiring.index.within(box)) if (!near(p.at, own) && !context.passable(p)) return -1
  for (const at of context.stops) if (!near(at, own) && meetings(a, b, at, at).length) return -1
  for (const body of bodiesNear(wiring, box)) {
    if (runsThrough({ a, b }, body)) return -1
    for (const [pin, inner] of body.leads) if (meetings(a, b, pin, inner).length) return -1
  }
  return crossed
}

const segmentClear = (context: Context, a: Point, b: Point, own: Point) => crossingsOn(context, a, b, own) === 0

const SLIP_REACH_CELLS = 6

type SlipAt = { readonly side: number; readonly landing: Point; readonly half: Point; readonly back: Point; readonly k: number; readonly crossings: number }

function slipsAt(context: Context, end: End): SlipAt[] {
  const pin = end.pin
  const header = end.header
  if (!pin?.socket || !pin.out || !header) return []
  const outer = plus(pin.at, pin.out, GRID)
  if (!context.wiring.index.at(outer).some((p) => p.socket && objectOfPin(context.wiring, p.key) === objectOfPin(context.wiring, pin.key))) return []
  if (!wiresTouching(context, outer).length && !context.wiring.index.at(outer).some((p) => context.taken.has(p.key))) return []
  const first = header.clearAt - alongOut(pin.at, pin.out)
  if (!Number.isInteger(first) || first < 2) return []
  const found: SlipAt[] = []
  for (const side of [1, -1]) {
    const across = { x: header.across.x * side, y: header.across.y * side }
    const half = plus(pin.at, across, HALF_CELL)
    if (!segmentClear(context, pin.at, half, pin.at)) continue
    for (let k = first; k <= first + SLIP_REACH_CELLS; k++) {
      const back = plus(half, pin.out, k * GRID)
      const landing = plus(back, across, HALF_CELL)
      const crossings = crossingsOn(context, half, back, pin.at)
      if (crossings < 0) {
        if (crossingsOn(context, half, plus(back, pin.out, -GRID), pin.at) < 0) break
        continue
      }
      if (!segmentClear(context, back, landing, pin.at)) continue
      if (wiresTouching(context, landing).length || pinsAt(context, landing).length) continue
      found.push({ side, landing, half, back, k, crossings })
      break
    }
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
    if (wiresTouching(context, landing).length || pinsAt(context, landing).length) return
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

const slipCost = (s: SlipAt) => 2 * PRIMARY_BEND + s.crossings * CROSSING * PRIMARY + (2 * s.k + 2)

function search(field: Field, from: End, to: End, startSlips: readonly SlipAt[], endSlips: readonly SlipAt[], startEscapes: readonly Escape[], endEscapes: readonly Escape[]): Search {
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
    ...startSlips.map((s) => ({ landing: s.landing, heading: dirIndex({ x: Math.sign(s.landing.x - s.back.x), y: Math.sign(s.landing.y - s.back.y) }), points: [s.half, s.back], cost: slipCost(s) })),
    ...startEscapes.map((e) => ({ landing: e.landing, heading: e.heading, points: e.corners, cost: e.cost })),
  ]
  const ends = [
    ...endSlips.flatMap((s) => {
      const cell = field.cellOf(s.landing)
      return cell < 0 ? [] : [{ landing: s.landing, heading: dirIndex({ x: Math.sign(s.back.x - s.landing.x), y: Math.sign(s.back.y - s.landing.y) }), points: [s.back, s.half], cost: slipCost(s), cell }]
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
    if (next === startCell) return BLOCKED
    const horizontal = step % 2 === 0
    const edge = step === 0 || step === 1 ? cell : next
    if ((horizontal ? field.hBlock : field.vBlock)[edge]) return BLOCKED
    let crossings = (horizontal ? field.hCross : field.vCross)[edge]
    if (!turned && heading !== START && field.node[cell] & (horizontal ? OWN_V : OWN_H)) crossings++
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
  const clean = candidates.filter((c) => !comesBack(c.points))
  if (!clean.length) return null
  clean.sort((a, b) => b.ok - a.ok || Number(b.axis) - Number(a.axis) || a.first - b.first || compareLists(a.points, b.points))
  return clean[0].points
}

function comesBack(points: readonly Point[]): boolean {
  const seen = new Set([`${points[0].x},${points[0].y}`])
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dx = Math.sign(b.x - a.x) * HALF_CELL
    const dy = Math.sign(b.y - a.y) * HALF_CELL
    for (let k = 1; k <= halfStepsOf(a, b); k++) {
      const code = `${a.x + dx * k},${a.y + dy * k}`
      if (seen.has(code)) return true
      seen.add(code)
    }
  }
  return false
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
  const context = contextOf(wiring, around)
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
  for (let pad = FIRST_PAD_CELLS; ; pad = Math.min(2 * pad, LAST_PAD_CELLS)) {
    const field = fieldOf(context, windowAround(reach, pad), [a, b])
    const found = search(field, a, b, startSlips, endSlips, startEscapes, endEscapes)
    if (!found.overflow || pad >= LAST_PAD_CELLS) return chosen(a, b, found)
    if (!Number.isFinite(found.best) && !search(field, b, a, endSlips, startSlips, endEscapes, startEscapes).overflow) return null
  }
}

export function routeThrough(wiring: Wiring, ends: readonly RouteEnd[], around: RouteAround = {}): Point[] | null {
  const extra = [...(around.extra ?? [])]
  const points: Point[] = []
  for (let i = 1; i < ends.length; i++) {
    const later = ends.slice(i + 1).flatMap((end) => ("at" in end ? [end.at] : []))
    const leg = routeAround(wiring, ends[i - 1], ends[i], { ...around, extra, stops: [...(around.stops ?? []), ...later] })
    if (!leg) return null
    for (let k = 1; k < leg.length; k++) extra.push({ id: `leg ${i}.${k}`, a: leg[k - 1], b: leg[k] })
    points.push(...(points.length ? leg.slice(1) : leg))
  }
  return points
}

const endKeyOf = (end: RouteEnd) => ("pin" in end ? keyOf(end.pin) : undefined)

const sortsFirst = (wiring: Wiring, a: RouteEnd, b: RouteEnd) => {
  const ka = endKeyOf(a)
  const kb = endKeyOf(b)
  if (ka === undefined || kb === undefined) return kb === undefined
  return byOrder(wiring)(ka, kb) <= 0
}

const NO_PIN_OF_ITS_OWN = () => false

export function routeThroughBends(wiring: Wiring, from: RouteEnd, to: RouteEnd, bends: readonly Point[], around: RouteAround = {}, ownPin: (key: string) => boolean = NO_PIN_OF_ITS_OWN): Point[] | null {
  const [a, b, through] = sortsFirst(wiring, from, to) ? [from, to, bends] : [to, from, [...bends].reverse()]
  const context = contextOf(wiring, around)
  const pointOf = (end: RouteEnd) => ("pin" in end ? wiring.index.pin(keyOf(end.pin))?.at : end.at)
  const onAnEnd = (p: Point) => [a, b].some((end) => {
    const q = pointOf(end)
    return !!q && samePoint(p, q)
  })
  const between = through.filter((p, i) => !onAnEnd(p) && (i === 0 || !samePoint(p, through[i - 1])))
  const free = (p: Point) => isWhole(p) && wiring.index.at(p).every((pin) => ownPin(pin.key)) && !wiresTouching(context, p).length && !context.stops.some((q) => samePoint(p, q))
  if (!between.every(free)) return null
  const ends = [a, ...between.map((at): RouteEnd => ({ at })), b]
  return routeThrough(wiring, ends, around)
}

export function routeBetween(doc: Schematic, from: RouteEnd, to: RouteEnd, known?: Wiring): readonly Point[] | null {
  return routeAround(wiringFor(doc, known), from, to)
}

const UNNAMED_LAST = "\uffff"

function orderOf(wiring: Wiring, key: string): string {
  const id = key.slice(0, key.indexOf(":"))
  const pin = key.slice(key.indexOf(":") + 1)
  const o = wiring.index.objects.get(id)
  const name = o?.props?.ref || `${UNNAMED_LAST}${o?.def ?? ""}@${o?.x ?? ""},${o?.y ?? ""}`
  return `${name}\u0000${pin}\u0000${id}`
}

const byOrder = (wiring: Wiring) => (a: string, b: string) => {
  const p = orderOf(wiring, a)
  const q = orderOf(wiring, b)
  return p < q ? -1 : p > q ? 1 : 0
}

const endKey = (wiring: Wiring, p: Point) => [...wiring.sheet.pinsAt(p)].map((pin) => pin.key).sort(byOrder(wiring))[0]

export function runEnds(wiring: Wiring, points: readonly Point[]): [RouteEnd, RouteEnd] {
  const ends = [points[0], points[points.length - 1]].map((p) => ({ p, key: endKey(wiring, p) }))
  ends.sort((a, b) => (a.key !== undefined ? 0 : 1) - (b.key !== undefined ? 0 : 1) || (a.key !== undefined && b.key !== undefined ? byOrder(wiring)(a.key, b.key) : 0) || comparePoints(a.p, b.p))
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
  if (!route) return { refused: blockedByAnotherNet(wiring, run, from, to) ? "no-clean-path" : "no-way", at: a }
  if (sameRoute(route, run.points) || sameRoute([...route].reverse(), run.points)) return doc
  const color = wiring.segmentsById.get(segment)?.color
  const laid: WireSegment[] = []
  for (let i = 1; i < route.length; i++) laid.push(color ? { id: newId(), a: route[i - 1], b: route[i], color } : { id: newId(), a: route[i - 1], b: route[i] })
  return withSegments(doc, laid, run.segments, [a, b], newId)
}

function blockedByAnotherNet(wiring: Wiring, run: { readonly segments: readonly WireSegment[] }, from: RouteEnd, to: RouteEnd): boolean {
  const own = wiring.view.netOfSegment(run.segments[0].id)
  const ignore = new Set(run.segments.map((s) => s.id))
  for (const s of wiring.segmentsById.values()) if (wiring.view.netOfSegment(s.id) !== own) ignore.add(s.id)
  return !!routeAround(wiring, from, to, { ignore, passable: (pin) => !pin.socket && wiring.view.netOfPin(pin.key) !== own })
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
