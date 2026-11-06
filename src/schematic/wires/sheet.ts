import type { Point } from "../types"
import type { WireDelta } from "./graph"
import { highOf, isHorizontal, lowOf, type WirePin, type WireSegment } from "./segment"

export type SheetMark = { readonly at: Point; readonly segment?: WireSegment; readonly pin?: WirePin }

export type LineCode = number

const SPAN = 2 ** 25

export const pointCode = (p: Point) => (p.x + SPAN) * 2 ** 26 + (p.y + SPAN)

export const rowCode = (y: number): LineCode => y * 2

export const columnCode = (x: number): LineCode => x * 2 + 1

export const lineCodeOf = (s: { a: Point; b: Point }): LineCode => (isHorizontal(s as WireSegment) ? rowCode(s.a.y) : columnCode(s.a.x))

type Placed = { readonly mark: SheetMark; readonly along: number; readonly line: LineCode }

function firstAtLeast<T>(list: readonly T[], value: number, key: (item: T) => number, strictly = false): number {
  let top = 0
  let bottom = list.length
  while (top < bottom) {
    const middle = (top + bottom) >> 1
    const at = key(list[middle])
    if (at < value || (strictly && at === value)) top = middle + 1
    else bottom = middle
  }
  return top
}

const alongOf = (placed: Placed) => placed.along

class Line {
  private readonly runs: WireSegment[] = []
  private readonly placed: Placed[] = []
  private reach: number[] = []
  private reachStale = false

  copy(): Line {
    const line = new Line()
    line.load(this.runs, this.placed)
    return line
  }

  get empty() {
    return this.runs.length === 0 && this.placed.length === 0
  }

  load(runs: readonly WireSegment[], placed: readonly Placed[]) {
    this.runs.push(...runs)
    this.runs.sort((s, t) => lowOf(s) - lowOf(t))
    this.placed.push(...placed)
    this.placed.sort((m, n) => m.along - n.along)
    this.reachStale = true
  }

  addRun(s: WireSegment) {
    this.runs.splice(firstAtLeast(this.runs, lowOf(s), lowOf), 0, s)
    this.reachStale = true
  }

  removeRun(s: WireSegment) {
    for (let i = firstAtLeast(this.runs, lowOf(s), lowOf); i < this.runs.length && lowOf(this.runs[i]) === lowOf(s); i++) {
      if (this.runs[i] !== s) continue
      this.runs.splice(i, 1)
      this.reachStale = true
      return
    }
  }

  addMark(placed: Placed) {
    this.placed.splice(firstAtLeast(this.placed, placed.along, alongOf), 0, placed)
  }

  removeMark(placed: Placed) {
    for (let i = firstAtLeast(this.placed, placed.along, alongOf); i < this.placed.length && this.placed[i].along === placed.along; i++) {
      if (this.placed[i] !== placed) continue
      this.placed.splice(i, 1)
      return
    }
  }

  overlapping(lo: number, hi: number, into: WireSegment[]) {
    const runs = this.runs
    if (this.reachStale) {
      this.reachStale = false
      let furthest = -Infinity
      this.reach = runs.map((s) => (furthest = Math.max(furthest, highOf(s))))
    }
    for (let i = firstAtLeast(runs, hi, lowOf, true) - 1; i >= 0 && this.reach[i] >= lo; i--) if (highOf(runs[i]) >= lo) into.push(runs[i])
  }

  within(lo: number, hi: number, into: SheetMark[]) {
    const placed = this.placed
    for (let i = firstAtLeast(placed, lo, alongOf); i < placed.length && placed[i].along <= hi; i++) into.push(placed[i].mark)
  }
}

const NONE: readonly never[] = []

export class WireSheet {
  pinSource?: { pin(key: string): WirePin | undefined; at(point: Point): readonly WirePin[]; within(box: { x: number; y: number; w: number; h: number }): readonly WirePin[] }
  segmentSource?: ReadonlyMap<string, WireSegment>
  private offset = { x: 0, y: 0 }
  private segments = new Map<string, WireSegment>()
  private pins = new Map<string, WirePin>()
  private ends = new Map<number, WireSegment[]>()
  private pinsAtPoint = new Map<number, WirePin[]>()
  private lines = new Map<LineCode, Line>()
  private placed = new Map<WireSegment | WirePin, Placed[]>()

  static of(wires: readonly WireSegment[], pins: readonly WirePin[]): WireSheet {
    const sheet = new WireSheet()
    const runs = new Map<LineCode, WireSegment[]>()
    const marks = new Map<LineCode, Placed[]>()
    const gather = <T>(into: Map<LineCode, T[]>, line: LineCode, item: T) => {
      const list = into.get(line)
      if (list) list.push(item)
      else into.set(line, [item])
    }
    const place = (owner: WireSegment | WirePin, at: Point, mark: SheetMark) => {
      const entries: Placed[] = [
        { mark, along: at.x, line: rowCode(at.y) },
        { mark, along: at.y, line: columnCode(at.x) },
      ]
      for (const placed of entries) gather(marks, placed.line, placed)
      const known = sheet.placed.get(owner)
      if (known) known.push(...entries)
      else sheet.placed.set(owner, entries)
    }
    for (const s of wires) {
      if (sheet.segments.has(s.id)) throw new Error(`two wires share the id ${s.id}`)
      sheet.segments.set(s.id, s)
      gather(runs, lineCodeOf(s), s)
      for (const end of [s.a, s.b]) {
        gather(sheet.ends, pointCode(end), s)
        place(s, end, { at: end, segment: s })
      }
    }
    for (const p of pins) {
      if (sheet.pins.has(p.key)) throw new Error(`two pins share the key ${p.key}`)
      sheet.pins.set(p.key, p)
      gather(sheet.pinsAtPoint, pointCode(p.at), p)
      place(p, p.at, { at: p.at, pin: p })
    }
    for (const code of new Set([...runs.keys(), ...marks.keys()])) sheet.line(code).load(runs.get(code) ?? [], marks.get(code) ?? [])
    return sheet
  }

  private shared = false
  private ownedMaps = true
  private ownedLines = new Set<LineCode>()

  snapshot(): WireSheet {
    const copy = new WireSheet()
    copy.segments = this.segments
    copy.pins = this.pins
    copy.ends = this.ends
    copy.pinsAtPoint = this.pinsAtPoint
    copy.lines = this.lines
    copy.placed = this.placed
    copy.pinSource = this.pinSource
    copy.segmentSource = this.segmentSource
    copy.offset = this.offset
    copy.shared = this.shared = true
    copy.ownedMaps = this.ownedMaps = false
    this.ownedLines = new Set()
    return copy
  }

  private ownMaps() {
    if (this.ownedMaps) return
    this.segments = new Map(this.segments)
    this.pins = new Map(this.pins)
    this.ends = new Map(this.ends)
    this.pinsAtPoint = new Map(this.pinsAtPoint)
    this.lines = new Map(this.lines)
    this.placed = new Map(this.placed)
    this.ownedMaps = true
  }

  get size() {
    return this.segments.size
  }

  shift(x: number, y: number): this {
    this.offset = { x: this.offset.x + x, y: this.offset.y + y }
    return this
  }

  private local(p: Point): Point { return { x: p.x - this.offset.x, y: p.y - this.offset.y } }
  private world(p: Point): Point { return { x: p.x + this.offset.x, y: p.y + this.offset.y } }

  apply(delta: WireDelta): this {
    this.ownMaps()
    if (this.offset.x || this.offset.y) delta = {
      ...delta,
      added: delta.added?.map((s) => ({ ...s, a: this.local(s.a), b: this.local(s.b) })),
      pinsAdded: delta.pinsAdded?.map((p) => ({ ...p, at: this.local(p.at) })),
    }
    for (const s of delta.removed ?? []) this.detachSegment(s)
    for (const p of delta.pinsRemoved ?? []) this.detachPin(p)
    for (const s of delta.added ?? []) this.attachSegment(s)
    for (const p of delta.pinsAdded ?? []) this.attachPin(p)
    return this
  }

  segment(id: string): WireSegment | undefined {
    return this.segmentSource?.get(id) ?? this.segments.get(id)
  }

  pin(key: string): WirePin | undefined {
    return this.pinSource?.pin(key) ?? this.pins.get(key)
  }

  endsAt(p: Point): readonly WireSegment[] {
    return this.segmentSource || this.offset.x || this.offset.y ? (this.ends.get(pointCode(this.local(p))) ?? NONE).map((s) => this.segment(s.id)!) : this.ends.get(pointCode(p)) ?? NONE
  }

  pinsAt(p: Point): readonly WirePin[] {
    return this.pinSource?.at(p) ?? this.pinsAtPoint.get(pointCode(this.local(p))) ?? NONE
  }

  along(line: LineCode, lo: number, hi: number): WireSegment[] {
    const out: WireSegment[] = []
    const horizontal = line % 2 === 0
    const along = horizontal ? this.offset.x : this.offset.y
    const code = horizontal ? rowCode(line / 2 - this.offset.y) : columnCode((line - 1) / 2 - this.offset.x)
    this.lines.get(code)?.overlapping(lo - along, hi - along, out)
    return this.segmentSource || this.offset.x || this.offset.y ? out.map((s) => this.segment(s.id)!) : out
  }

  through(p: Point): WireSegment[] {
    return [...this.along(rowCode(p.y), p.x, p.x), ...this.along(columnCode(p.x), p.y, p.y)]
  }

  marks(line: LineCode, lo: number, hi: number): SheetMark[] {
    const out: SheetMark[] = []
    const horizontal = line % 2 === 0
    const along = horizontal ? this.offset.x : this.offset.y
    const code = horizontal ? rowCode(line / 2 - this.offset.y) : columnCode((line - 1) / 2 - this.offset.x)
    this.lines.get(code)?.within(lo - along, hi - along, out)
    if (this.segmentSource || this.offset.x || this.offset.y) for (let i = 0; i < out.length; i++) {
      const mark = out[i]
      out[i] = mark.segment ? { at: this.world(mark.at), segment: this.segment(mark.segment.id)! } : { at: this.world(mark.at), pin: this.pin(mark.pin!.key)! }
    }
    if (this.pinSource) {
      const horizontal = line % 2 === 0
      const at = horizontal ? line / 2 : (line - 1) / 2
      const box = horizontal ? { x: lo, y: at, w: hi - lo, h: 0 } : { x: at, y: lo, w: 0, h: hi - lo }
      for (const pin of this.pinSource.within(box)) if (!this.pins.has(pin.key)) out.push({ at: pin.at, pin })
    }
    return out
  }

  private line(code: LineCode): Line {
    let line = this.lines.get(code)
    if (!line) this.lines.set(code, (line = new Line()))
    else if (this.shared && !this.ownedLines.has(code)) { this.lines.set(code, line = line.copy()); this.ownedLines.add(code) }
    return line
  }

  private release(code: LineCode) {
    if (this.lines.get(code)?.empty) this.lines.delete(code)
  }

  private mark(owner: WireSegment | WirePin, at: Point, mark: SheetMark) {
    const entries: Placed[] = [
      { mark, along: at.x, line: rowCode(at.y) },
      { mark, along: at.y, line: columnCode(at.x) },
    ]
    for (const placed of entries) this.line(placed.line).addMark(placed)
    const known = this.placed.get(owner)
    if (known) known.push(...entries)
    else this.placed.set(owner, entries)
  }

  private unmark(owner: WireSegment | WirePin) {
    const entries = this.placed.get(owner)
    if (!entries) return
    this.placed.delete(owner)
    for (const placed of entries) {
      this.line(placed.line).removeMark(placed)
      this.release(placed.line)
    }
  }

  private attachSegment(s: WireSegment) {
    const known = this.segments.get(s.id)
    if (known) this.detachSegment(known)
    this.segments.set(s.id, s)
    this.line(lineCodeOf(s)).addRun(s)
    for (const end of [s.a, s.b]) {
      const code = pointCode(end)
      const list = this.ends.get(code)
      this.ends.set(code, list ? [...list, s] : [s])
      this.mark(s, end, { at: end, segment: s })
    }
  }

  private detachSegment(s: WireSegment) {
    const held = this.segments.get(s.id)
    if (!held) return
    this.segments.delete(s.id)
    const code = lineCodeOf(held)
    this.line(code).removeRun(held)
    this.release(code)
    for (const end of [held.a, held.b]) {
      const at = pointCode(end)
      const list = this.ends.get(at)?.filter((t) => t !== held)
      if (list?.length) this.ends.set(at, list)
      else this.ends.delete(at)
    }
    this.unmark(held)
  }

  private attachPin(p: WirePin) {
    const known = this.pins.get(p.key)
    if (known) this.detachPin(known)
    this.pins.set(p.key, p)
    const code = pointCode(p.at)
    const list = this.pinsAtPoint.get(code)
    this.pinsAtPoint.set(code, list ? [...list, p] : [p])
    this.mark(p, p.at, { at: p.at, pin: p })
  }

  private detachPin(p: WirePin) {
    const held = this.pins.get(p.key)
    if (!held) return
    this.pins.delete(p.key)
    const code = pointCode(held.at)
    const list = this.pinsAtPoint.get(code)?.filter((q) => q !== held)
    if (list?.length) this.pinsAtPoint.set(code, list)
    else this.pinsAtPoint.delete(code)
    this.unmark(held)
  }
}
