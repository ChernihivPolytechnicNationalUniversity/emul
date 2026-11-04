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

type Placed = { mark: SheetMark; along: number }

class Line {
  readonly runs = new Set<WireSegment>()
  readonly marks = new Set<Placed>()
  private byStart: WireSegment[] = []
  private reach: number[] = []
  private markOrder: Placed[] = []
  private stale = false

  touch() {
    this.stale = true
  }

  get empty() {
    return this.runs.size === 0 && this.marks.size === 0
  }

  private settle() {
    if (!this.stale) return
    this.stale = false
    this.byStart = [...this.runs].sort((s, t) => lowOf(s) - lowOf(t))
    let furthest = -Infinity
    this.reach = this.byStart.map((s) => (furthest = Math.max(furthest, highOf(s))))
    this.markOrder = [...this.marks].sort((m, n) => m.along - n.along)
  }

  overlapping(lo: number, hi: number, into: WireSegment[]) {
    this.settle()
    const starts = this.byStart
    let top = 0
    let bottom = starts.length
    while (top < bottom) {
      const middle = (top + bottom) >> 1
      if (lowOf(starts[middle]) <= hi) top = middle + 1
      else bottom = middle
    }
    for (let i = top - 1; i >= 0 && this.reach[i] >= lo; i--) if (highOf(starts[i]) >= lo) into.push(starts[i])
  }

  within(lo: number, hi: number, into: SheetMark[]) {
    this.settle()
    const order = this.markOrder
    let top = 0
    let bottom = order.length
    while (top < bottom) {
      const middle = (top + bottom) >> 1
      if (order[middle].along < lo) top = middle + 1
      else bottom = middle
    }
    for (let i = top; i < order.length && order[i].along <= hi; i++) into.push(order[i].mark)
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
    return new WireSheet().apply({ added: wires, pinsAdded: pins })
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
    const entries = this.placed.get(owner) ?? []
    for (const [code, along] of [[rowCode(at.y), at.x], [columnCode(at.x), at.y]] as const) {
      const placed = { mark, along }
      const line = this.line(code)
      line.marks.add(placed)
      line.touch()
      entries.push(placed)
    }
    this.placed.set(owner, entries)
  }

  private unmark(owner: WireSegment | WirePin, points: readonly Point[]) {
    const entries = this.placed.get(owner)
    if (!entries) return
    this.placed.delete(owner)
    for (const at of points) {
      for (const code of [rowCode(at.y), columnCode(at.x)]) {
        const line = this.lines.get(code)
        if (!line) continue
        for (const placed of entries) line.marks.delete(placed)
        line.touch()
        this.release(code)
      }
    }
  }

  private attachSegment(s: WireSegment) {
    const known = this.segments.get(s.id)
    if (known) this.detachSegment(known)
    this.segments.set(s.id, s)
    const line = this.line(lineCodeOf(s))
    line.runs.add(s)
    line.touch()
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
    const line = this.lines.get(code)
    if (line) {
      line.runs.delete(held)
      line.touch()
      this.release(code)
    }
    for (const end of [held.a, held.b]) {
      const at = pointCode(end)
      const list = this.ends.get(at)?.filter((t) => t !== held)
      if (list?.length) this.ends.set(at, list)
      else this.ends.delete(at)
    }
    this.unmark(held, [held.a, held.b])
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
    this.unmark(held, [held.at])
  }
}
