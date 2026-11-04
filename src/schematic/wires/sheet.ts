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
  private readonly segments = new Map<string, WireSegment>()
  private readonly pins = new Map<string, WirePin>()
  private readonly ends = new Map<number, WireSegment[]>()
  private readonly pinsAtPoint = new Map<number, WirePin[]>()
  private readonly lines = new Map<LineCode, Line>()
  private readonly placed = new Map<WireSegment | WirePin, Placed[]>()

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

  get size() {
    return this.segments.size
  }

  apply(delta: WireDelta): this {
    for (const s of delta.removed ?? []) this.detachSegment(s)
    for (const p of delta.pinsRemoved ?? []) this.detachPin(p)
    for (const s of delta.added ?? []) this.attachSegment(s)
    for (const p of delta.pinsAdded ?? []) this.attachPin(p)
    return this
  }

  segment(id: string): WireSegment | undefined {
    return this.segments.get(id)
  }

  pin(key: string): WirePin | undefined {
    return this.pins.get(key)
  }

  endsAt(p: Point): readonly WireSegment[] {
    return this.ends.get(pointCode(p)) ?? NONE
  }

  pinsAt(p: Point): readonly WirePin[] {
    return this.pinsAtPoint.get(pointCode(p)) ?? NONE
  }

  along(line: LineCode, lo: number, hi: number): WireSegment[] {
    const out: WireSegment[] = []
    this.lines.get(line)?.overlapping(lo, hi, out)
    return out
  }

  through(p: Point): WireSegment[] {
    const out: WireSegment[] = []
    this.lines.get(rowCode(p.y))?.overlapping(p.x, p.x, out)
    this.lines.get(columnCode(p.x))?.overlapping(p.y, p.y, out)
    return out
  }

  marks(line: LineCode, lo: number, hi: number): SheetMark[] {
    const out: SheetMark[] = []
    this.lines.get(line)?.within(lo, hi, out)
    return out
  }

  private line(code: LineCode): Line {
    let line = this.lines.get(code)
    if (!line) this.lines.set(code, (line = new Line()))
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
      this.lines.get(placed.line)?.removeMark(placed)
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
      if (list) list.push(s)
      else this.ends.set(code, [s])
      this.mark(s, end, { at: end, segment: s })
    }
  }

  private detachSegment(s: WireSegment) {
    const held = this.segments.get(s.id)
    if (!held) return
    this.segments.delete(s.id)
    const code = lineCodeOf(held)
    this.lines.get(code)?.removeRun(held)
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
    if (list) list.push(p)
    else this.pinsAtPoint.set(code, [p])
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
