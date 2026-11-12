import { GRID } from "../grid"
import type { Point } from "../types"
import type { WireColorKey } from "../wire-colors"
import type { WireNets } from "./graph"
import { LATTICE_ACROSS_H, LATTICE_ACROSS_V, LATTICE_END, LATTICE_PASS, latticeBoxAround, routeOnLattice } from "./lattice-route"
import type { NewId, WireEdit } from "./normal-form"
import { along, contains, cross, diagonalLine, HALF_CELL, highOf, isDiagonal, isHorizontal, lineOf, lowOf, pointOnLine, samePoint, slopeKey, slopeOf, type LineKey, type Slope, type WirePin, type WireSegment } from "./segment"
import { columnCode, latticeAlong, pointCode, rowCode, type WireSheet } from "./sheet"

export type DragBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export type DragRequest = {
  readonly pins: Iterable<string>
  readonly wires?: Iterable<string>
  readonly heading?: (key: string) => Point | undefined
  readonly body?: (key: string) => DragBox | undefined
  readonly avoid?: (a: Point, b: Point) => boolean
  readonly solid?: (box: DragBox) => readonly DragBox[]
  readonly rerouteConflicts?: boolean
  readonly keepFarEnds?: boolean
  readonly detach?: boolean
}

export type DragMove = {
  readonly pin: (key: string, at: Point) => Point
  readonly point: (at: Point) => Point
  readonly heading?: (key: string, heading: Point) => Point
  readonly offset?: Point
}

export type DragPieceKind = "moved" | "stretched" | "jog" | "added"

export type DragPiece = { readonly id: string; readonly a: Point; readonly b: Point; readonly color?: WireColorKey; readonly kind: DragPieceKind; readonly net: string; readonly source?: string }

export type DragContact = "along" | "over" | "end" | "pin" | "crossing" | "body"

export type DragConflict = { readonly at: Point; readonly reason: DragContact; readonly piece?: string; readonly pin?: string; readonly nets: readonly [string, string] }

export type DragReroute = {
  readonly soft?: boolean
  readonly from: Point
  readonly to: Point
  readonly net: string
  readonly pieces: readonly string[]
  readonly run: readonly WireSegment[]
  readonly color?: WireColorKey
  readonly source?: string
  readonly leave?: Point
  readonly arrive?: Point
}

export type DragFrame = {
  readonly pieces: readonly DragPiece[]
  readonly replaced: ReadonlySet<string>
  readonly pins: ReadonlyMap<string, Point>
  readonly blocked: boolean
  readonly conflicts: readonly DragConflict[]
  readonly reroutes: readonly DragReroute[]
  readonly joins: readonly (readonly [string, string])[]
}

export type DragUnlaid = { readonly at: Point; readonly from: Point; readonly net: string; readonly kept: boolean }

export type DragCommit = { readonly edit: WireEdit; readonly pins: readonly WirePin[]; readonly joins: readonly (readonly [string, string])[]; readonly unlaid: readonly DragUnlaid[] }

const ZERO: Point = { x: 0, y: 0 }
const REROUTE_MARGIN = 10
const WIDER_REROUTE = 24
const plus = (p: Point, q: Point): Point => ({ x: p.x + q.x, y: p.y + q.y })
const minus = (p: Point, q: Point): Point => ({ x: p.x - q.x, y: p.y - q.y })
const dot = (p: Point, q: Point) => p.x * q.x + p.y * q.y
const isZero = (p: Point) => p.x === 0 && p.y === 0
const otherEnd = (s: WireSegment, p: Point) => (samePoint(s.a, p) ? s.b : s.a)
const taxicab = (p: Point, q: Point) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y)
const randomId: NewId = () => crypto.randomUUID()

const pieceOf = (id: string, a: Point, b: Point, kind: DragPieceKind, net: string, color?: WireColorKey, source?: string): DragPiece => ({
  id,
  a,
  b,
  kind,
  net,
  ...(color ? { color } : {}),
  ...(source ? { source } : {}),
})

export const translate = (offset: Point): DragMove => ({ pin: (_key, at) => plus(at, offset), point: (at) => plus(at, offset), offset })

const asMove = (move: Point | DragMove): DragMove => ("pin" in move ? move : translate(move))

export function normalOffset(segment: WireSegment, pointer: Point): Point {
  const snapped = (v: number) => Math.round(v / GRID) * GRID + 0
  if (isDiagonal(segment)) return { x: snapped(pointer.x), y: snapped(pointer.y) }
  return isHorizontal(segment) ? { x: 0, y: snapped(pointer.y) } : { x: snapped(pointer.x), y: 0 }
}

type MovingPoint = {
  readonly key: number
  readonly at: Point
  readonly pins: readonly WirePin[]
  readonly anchors: readonly WirePin[]
  readonly rigid: readonly WireSegment[]
  readonly loose: readonly WireSegment[]
  readonly kind: "moving" | "anchored" | "branch"
}

type FarEnd = { readonly key: number; readonly at: Point; readonly kind: "fixed" | "dangling" | "free"; readonly segments: readonly WireSegment[] }

type Rejoined = { readonly at: Point; readonly halves: readonly [WireSegment, WireSegment] }

type Probe = { readonly id: string; readonly a: Point; readonly b: Point; readonly net: string; readonly rigidA: boolean; readonly rigidB: boolean; readonly own?: WireSegment }

type Touch = { readonly at: Point; readonly own: string; readonly net: string }

type Verdict = { readonly conflicts: DragConflict[]; readonly touches: Touch[] }

type FrameMark = { readonly along: number; readonly at: Point; readonly net: string; readonly socket: boolean }

type Placed = { readonly a: Point; readonly net: string; readonly lo: number; readonly hi: number }

class FrameIndex {
  private readonly runs = new Map<LineKey, Placed[]>()
  private readonly marks = new Map<LineKey, FrameMark[]>()
  private readonly points = new Map<number, FrameMark[]>()
  private readonly slopes = new Map<string, Slope>()

  addPiece(a: Point, b: Point, net: string) {
    const extent = { a, b }
    const line = lineOf(extent)
    if (isDiagonal(extent)) {
      const slope = slopeOf(extent)
      this.slopes.set(slopeKey(slope), slope)
    }
    const placed = { a, net, lo: lowOf(extent), hi: highOf(extent) }
    const list = this.runs.get(line)
    if (list) list.push(placed)
    else this.runs.set(line, [placed])
    this.addMark(a, net, false)
    this.addMark(b, net, false)
  }

  addMark(at: Point, net: string, socket: boolean) {
    this.markOn(rowCode(at.y), { along: at.x, at, net, socket })
    this.markOn(columnCode(at.x), { along: at.y, at, net, socket })
    const code = pointCode(at)
    const list = this.points.get(code)
    const mark = { along: at.x, at, net, socket }
    if (list) list.push(mark)
    else this.points.set(code, [mark])
  }

  private markOn(line: LineKey, mark: FrameMark) {
    const list = this.marks.get(line)
    if (list) list.push(mark)
    else this.marks.set(line, [mark])
  }

  onLine(line: LineKey): readonly Placed[] {
    return this.runs.get(line) ?? []
  }

  marksAlong(extent: { a: Point; b: Point }): readonly FrameMark[] {
    if (!isDiagonal(extent)) return this.marks.get(extent.a.y === extent.b.y ? rowCode(extent.a.y) : columnCode(extent.a.x)) ?? []
    const out: FrameMark[] = []
    for (const at of latticeAlong(extent)) for (const mark of this.points.get(pointCode(at)) ?? []) out.push(mark)
    return out
  }

  othersAt(p: Point, net: string, into: string[]) {
    for (const r of this.runs.get(rowCode(p.y)) ?? []) if (r.net !== net && r.lo <= p.x && p.x <= r.hi) into.push(r.net)
    for (const r of this.runs.get(columnCode(p.x)) ?? []) if (r.net !== net && r.lo <= p.y && p.y <= r.hi) into.push(r.net)
    for (const slope of this.slopes.values()) for (const r of this.runs.get(diagonalLine(slope, p)) ?? []) if (r.net !== net && r.lo <= p.x && p.x <= r.hi) into.push(r.net)
    for (const m of this.points.get(pointCode(p)) ?? []) if (m.net !== net) into.push(m.net)
  }
}

type Path = { readonly points: readonly Point[]; readonly length: number; readonly bends: number }

function pathsBetween(from: Point, to: Point): Path[] {
  if (samePoint(from, to)) return [{ points: [from], length: 0, bends: 0 }]
  const length = taxicab(from, to)
  if (from.x === to.x || from.y === to.y) return [{ points: [from, to], length, bends: 0 }]
  return [
    { points: [from, { x: to.x, y: from.y }, to], length, bends: 1 },
    { points: [from, { x: from.x, y: to.y }, to], length, bends: 1 },
  ]
}

function pointsOn(s: WireSegment, near: Point, reach: number): Point[] {
  if (isDiagonal(s)) {
    const steps = latticeAlong(s)
    const by = (p: Point) => Math.hypot(p.x - near.x, p.y - near.y)
    const nearest = steps.reduce((best, p) => (by(p) < by(best) ? p : best), steps[0])
    return steps.filter((p) => p === steps[0] || p === steps[steps.length - 1] || by(p) <= by(nearest) + reach * GRID)
  }
  const horizontal = isHorizontal(s)
  const lo = lowOf(s)
  const hi = highOf(s)
  const at = Math.max(lo, Math.min(hi, horizontal ? near.x : near.y))
  const out = new Set<number>([at, lo, hi])
  for (let k = 1; k <= reach; k++) {
    if (at - k * GRID >= lo) out.add(at - k * GRID)
    if (at + k * GRID <= hi) out.add(at + k * GRID)
  }
  return [...out].map((v) => (horizontal ? { x: v, y: s.a.y } : { x: s.a.x, y: v }))
}

const ahead = (path: Path, from: Point, heading: Point | undefined) => !heading || path.points.every((p) => dot(minus(p, from), heading) >= 0)

const leavesAlong = (path: Path, heading: Point | undefined) => (heading && path.points.length > 1 && dot(minus(path.points[1], path.points[0]), heading) > 0 ? 0 : 1)

const firstLegHorizontal = (path: Path) => (path.points.length > 1 && path.points[1].y === path.points[0].y ? 0 : 1)

const preferred = (paths: Path[], heading: Point | undefined): Path[] =>
  paths
    .map((path) => ({ path, rank: path.length * 16 + path.bends * 4 + leavesAlong(path, heading) * 2 + firstLegHorizontal(path) }))
    .sort((p, q) => p.rank - q.rank)
    .map(({ path }) => path)

const crossesBox = (a: Point, b: Point, box: DragBox) =>
  Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.w && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.h

const withinExtentOf = (s: WireSegment, a: Point, b: Point) =>
  isDiagonal(s)
    ? contains(s, a) && contains(s, b)
    : isHorizontal(s)
    ? a.y === s.a.y && b.y === s.a.y && Math.min(a.x, b.x) >= lowOf(s) && Math.max(a.x, b.x) <= highOf(s)
    : a.x === s.a.x && b.x === s.a.x && Math.min(a.y, b.y) >= lowOf(s) && Math.max(a.y, b.y) <= highOf(s)

const clashOf = (probe: Probe, at: Point, other: string, reason: DragContact): DragConflict => ({ at, reason, piece: probe.id, nets: [probe.net, other] })

const onLineOf = (probe: Probe, along: number): Point => pointOnLine(lineOf(probe), along)

type Split = {
  readonly source: WireSegment
  readonly net: string
  readonly horizontal: boolean
  readonly fixedAfter: Point
  readonly movingAfter: Point
  readonly movingRigid: boolean
  readonly candidates: readonly number[]
  readonly order: number
  readonly tie: number
  readonly leave?: Point
  readonly arrive?: Point
}

type Shaped = { readonly s: WireSegment; readonly da: Point; readonly db: Point }

const EMPTY_FRAME: DragFrame = { pieces: [], replaced: new Set(), pins: new Map(), blocked: false, conflicts: [], reroutes: [], joins: [] }

export class DragPlan {
  private readonly moving = new Map<number, MovingPoint>()
  private readonly farEnds = new Map<number, FarEnd>()
  private readonly rigid: WireSegment[] = []
  private readonly rigidSet = new Set<WireSegment>()
  private readonly carriedPins = new Set<string>()
  private readonly rejoined: Rejoined[] = []
  readonly unplugged: WirePin[] = []
  readonly sheet: WireSheet
  private readonly nets: WireNets
  private readonly request: DragRequest

  constructor(sheet: WireSheet, nets: WireNets, request: DragRequest) {
    this.sheet = sheet
    this.nets = nets
    this.request = request
    const gathered = new Map<number, { at: Point; pins: WirePin[] }>()
    const gather = (at: Point) => {
      const key = pointCode(at)
      let entry = gathered.get(key)
      if (!entry) gathered.set(key, (entry = { at, pins: [] }))
      return entry
    }
    const carried = new Set<string>()
    for (const key of request.pins) carried.add(key)
    for (const key of carried) {
      const pin = sheet.pin(key)
      if (!pin) throw new Error(`the drag carries pin ${key}, which is not on the sheet`)
      if (this.carriedPins.has(key)) continue
      this.carriedPins.add(key)
      const staying = sheet.pinsAt(pin.at).filter((p) => !carried.has(p.key))
      if (staying.length && (pin.socket || staying.some((p) => p.socket))) this.unplugged.push(pin)
      else gather(pin.at).pins.push(pin)
    }
    const carriedWires = new Set<WireSegment>()
    for (const id of request.wires ?? []) {
      const s = sheet.segment(id)
      if (!s) throw new Error(`the drag carries wire ${id}, which is not on the sheet`)
      carriedWires.add(s)
      gather(s.a)
      gather(s.b)
    }
    const detach = !!request.detach
    for (const [key, entry] of gathered) {
      const own: WireSegment[] = []
      const loose: WireSegment[] = []
      const left: WireSegment[] = []
      for (const s of sheet.endsAt(entry.at)) {
        if (carriedWires.has(s) || (!detach && gathered.has(pointCode(otherEnd(s, entry.at))))) {
          own.push(s)
          this.rigidSet.add(s)
        } else if (detach) left.push(s)
        else loose.push(s)
      }
      if (detach) {
        const halves = straightThrough(sheet, entry.at, left)
        if (halves) this.rejoined.push({ at: entry.at, halves })
      }
      const anchors = detach ? [] : sheet.pinsAt(entry.at).filter((p) => !this.carriedPins.has(p.key))
      const kind = anchors.length ? "anchored" : entry.pins.length && loose.length >= 2 ? "branch" : "moving"
      this.moving.set(key, { key, at: entry.at, pins: entry.pins, anchors, rigid: own, loose, kind })
    }
    this.rigid.push(...this.rigidSet)
    for (const point of this.moving.values()) {
      for (const s of point.loose) {
        const far = otherEnd(s, point.at)
        const key = pointCode(far)
        if (this.farEnds.has(key)) continue
        const segments = sheet.endsAt(far)
        const kind = sheet.pinsAt(far).length ? "fixed" : segments.length === 1 ? "dangling" : "free"
        this.farEnds.set(key, { key, at: far, kind, segments })
      }
    }
  }

  get size() {
    return { pins: this.carriedPins.size, points: this.moving.size, rigid: this.rigid.length, farEnds: this.farEnds.size }
  }

  get reach(): ReadonlySet<string> {
    const out = new Set<string>()
    for (const s of this.rigid) out.add(s.id)
    for (const point of this.moving.values()) for (const s of point.loose) out.add(s.id)
    for (const far of this.farEnds.values()) for (const s of far.segments) out.add(s.id)
    for (const { halves } of this.rejoined) for (const s of halves) out.add(s.id)
    return out
  }

  frame(move: Point | DragMove): DragFrame {
    return new FrameBuilder(this, asMove(move)).build()
  }

  commit(move: Point | DragMove, newId: NewId = randomId, options: { keepUnlaid?: boolean } = {}): DragCommit | null {
    const released = this.release(move, !!options.keepUnlaid)
    if (!released) return null
    const { frame, pieces, rerouted, kept, unlaid } = released
    return { edit: this.editOf(frame, pieces, rerouted, newId, kept), pins: [...frame.pins].map(([key, at]) => ({ ...this.sheet.pin(key)!, at })), joins: frame.joins, unlaid }
  }

  lands(move: Point | DragMove): boolean {
    return this.release(move) !== null
  }

  nearestClean(offset: Point, reach = 4): Point | null {
    const candidates: { at: Point; rank: number }[] = []
    for (let dx = -reach; dx <= reach; dx++)
      for (let dy = -reach; dy <= reach; dy++) {
        const at = { x: offset.x + dx * GRID, y: offset.y + dy * GRID }
        candidates.push({ at, rank: (dx * dx + dy * dy) * 1e9 + Math.hypot(at.x, at.y) })
      }
    candidates.sort((p, q) => p.rank - q.rank)
    return candidates.find(({ at }) => this.lands(at))?.at ?? null
  }

  private release(move: Point | DragMove, keepUnlaid = false): { frame: DragFrame; pieces: readonly DragPiece[]; rerouted: readonly WireSegment[]; kept: ReadonlySet<string>; unlaid: readonly DragUnlaid[] } | null {
    const builder = new FrameBuilder(this, asMove(move))
    const frame = builder.build()
    if (frame.blocked) return null
    let pieces: readonly DragPiece[] = frame.pieces
    const rerouted: WireSegment[] = []
    const kept = new Set<string>()
    const unlaid: DragUnlaid[] = []
    const hard = frame.reroutes.filter((r) => !r.soft)
    const waiting = new Set(hard.flatMap((r) => r.pieces))
    const laid = new Map<DragReroute, readonly DragPiece[]>()
    const fail = (reroute: DragReroute): boolean => {
      if (reroute.soft) return true
      if (!keepUnlaid) return false
      const source = reroute.source !== undefined ? this.sheet.segment(reroute.source) : undefined
      const whole = [...(source ? [source] : []), ...reroute.run]
      const others = pieces.filter((p) => !waiting.has(p.id))
      let cut = 0
      while (cut < whole.length && !builder.clearInPlace(whole.slice(cut), others)) cut++
      if (whole.length && cut === whole.length) return false
      const stay = whole.slice(cut)
      for (const s of stay) kept.add(s.id)
      for (const s of whole.slice(0, cut)) if (s !== source) rerouted.push(s)
      builder.keepInPlace(stay)
      unlaid.push({ at: reroute.to, from: reroute.from, net: reroute.net, kept: stay.length > 0 })
      return true
    }
    for (const reroute of [...hard, ...frame.reroutes.filter((r) => r.soft)]) {
      for (const id of reroute.pieces) waiting.delete(id)
      const routed = builder.reroute(reroute, pieces.filter((p) => !waiting.has(p.id)), reroute.soft ? reroute.run : [])
      const gone = new Set(reroute.pieces)
      if (reroute.soft && !routed) continue
      if (routed) {
        pieces = [...pieces.filter((p) => !gone.has(p.id)), ...routed]
        rerouted.push(...reroute.run)
        laid.set(reroute, routed)
        continue
      }
      pieces = pieces.filter((p) => !gone.has(p.id))
      if (!fail(reroute)) return null
    }
    const joined = new Set(frame.joins.map(([a, b]) => `${a}\u0000${b}`))
    for (let round = 0; round < 8; round++) {
      const removed = new Set([...[...frame.replaced].filter((id) => !kept.has(id)), ...rerouted.filter((s) => !kept.has(s.id)).map((s) => s.id)])
      const touching = builder.foreignContacts(pieces, removed, joined)
      if (!touching.size) break
      if (!keepUnlaid) return null
      const culprits = [...laid].filter(([, routed]) => routed.some((p) => touching.has(p)))
      for (const [reroute, routed] of culprits) {
        laid.delete(reroute)
        const drop = new Set(routed)
        pieces = pieces.filter((p) => !drop.has(p))
        for (const s of reroute.run) {
          const at = rerouted.indexOf(s)
          if (at >= 0) rerouted.splice(at, 1)
        }
        if (reroute.soft) {
          pieces = [...pieces, ...frame.pieces.filter((p) => reroute.pieces.includes(p.id))]
          continue
        }
        const wider = builder.reroute(reroute, pieces, [], WIDER_REROUTE)
        if (wider && !builder.foreignContacts([...pieces, ...wider], new Set([...[...frame.replaced].filter((id) => !kept.has(id)), ...rerouted.filter((s) => !kept.has(s.id)).map((s) => s.id), ...reroute.run.map((s) => s.id)]), joined).size) {
          pieces = [...pieces, ...wider]
          rerouted.push(...reroute.run)
          laid.set(reroute, wider)
          continue
        }
        if (!fail(reroute)) return null
      }
      const owned = new Set([...laid.values()].flat())
      for (const piece of touching) {
        if (owned.has(piece) || !pieces.includes(piece)) continue
        const source = piece.source !== undefined ? this.sheet.segment(piece.source) : undefined
        pieces = pieces.filter((p) => p !== piece && (source === undefined || p.source !== source.id))
        const clean = !!source && builder.clearInPlace([source], pieces)
        if (source && !clean) return null
        if (clean) {
          kept.add(source.id)
          builder.keepInPlace([source])
        }
        const target = [...frame.pins.values()].find((at) => samePoint(at, piece.a) || samePoint(at, piece.b)) ?? piece.b
        unlaid.push({ at: target, from: samePoint(target, piece.a) ? piece.b : piece.a, net: piece.net, kept: clean })
      }
    }
    return { frame, pieces, rerouted, kept, unlaid }
  }

  private editOf(frame: DragFrame, pieces: readonly DragPiece[], rerouted: readonly WireSegment[], newId: NewId, stay: ReadonlySet<string> = new Set()): WireEdit {
    if (!pieces.length && !frame.replaced.size && !frame.pins.size) return {}
    const kept = new Set<string>(stay)
    const unchanged = new Set<DragPiece>()
    for (const piece of pieces) {
      if (!piece.source || kept.has(piece.source)) continue
      const stored = this.sheet.segment(piece.source)!
      const same = (samePoint(stored.a, piece.a) && samePoint(stored.b, piece.b)) || (samePoint(stored.a, piece.b) && samePoint(stored.b, piece.a))
      if (!same) continue
      kept.add(piece.source)
      unchanged.add(piece)
    }
    const remove = [...[...frame.replaced].filter((id) => !kept.has(id)).map((id) => this.sheet.segment(id)!), ...rerouted.filter((s) => !kept.has(s.id))]
    const add: WireSegment[] = []
    for (const piece of pieces) {
      if (unchanged.has(piece)) continue
      const id = piece.source && piece.id === piece.source && !kept.has(piece.source) ? piece.source : newId()
      add.push(piece.color ? { id, a: piece.a, b: piece.b, color: piece.color } : { id, a: piece.a, b: piece.b })
    }
    const points: Point[] = []
    for (const point of this.moving.values()) points.push(point.at)
    for (const pin of this.unplugged) points.push(pin.at)
    for (const at of frame.pins.values()) points.push(at)
    return { add, remove, points }
  }

  netOfSegment(s: WireSegment): string {
    return this.nets.netOfSegment(s.id) ?? `wire:${s.id}`
  }

  netOfPin(pin: WirePin): string {
    return this.nets.netOfPin(pin.key) ?? `pin:${pin.key}`
  }

  isCarried(pin: WirePin) {
    return this.carriedPins.has(pin.key)
  }

  headingOf(key: string): Point | undefined {
    return this.request.heading?.(key)
  }

  bodyOf(key: string): DragBox | undefined {
    return this.request.body?.(key)
  }

  avoids(a: Point, b: Point): boolean {
    return !!this.request.avoid?.(a, b)
  }

  solidIn(box: DragBox): readonly DragBox[] {
    return this.request.solid?.(box) ?? []
  }

  get reroutesConflicts(): boolean {
    return !!this.request.rerouteConflicts || !!this.request.keepFarEnds
  }

  get keepsFarEnds(): boolean {
    return !!this.request.keepFarEnds
  }

  get points(): Iterable<MovingPoint> {
    return this.moving.values()
  }

  movingAt(key: number): MovingPoint | undefined {
    return this.moving.get(key)
  }

  farAt(key: number): FarEnd | undefined {
    return this.farEnds.get(key)
  }

  get rigidSegments(): readonly WireSegment[] {
    return this.rigid
  }

  get rejoinedThrough(): readonly Rejoined[] {
    return this.rejoined
  }

  isRigid(s: WireSegment) {
    return this.rigidSet.has(s)
  }
}

function straightThrough(sheet: WireSheet, at: Point, left: readonly WireSegment[]): readonly [WireSegment, WireSegment] | null {
  if (left.length !== 2 || sheet.pinsAt(at).length) return null
  const [first, second] = left
  return lineOf(first) === lineOf(second) && first.color === second.color ? [first, second] : null
}

export function planDrag(sheet: WireSheet, nets: WireNets, request: DragRequest): DragPlan {
  return new DragPlan(sheet, nets, request)
}

class FrameBuilder {
  private readonly plan: DragPlan
  private readonly move: DragMove
  private readonly sheet: WireSheet
  private readonly targets = new Map<number, Point>()
  private readonly pinTargets = new Map<string, Point>()
  private readonly follows = new Set<number>()
  private readonly stays = new Map<number, { pieces: DragPiece[]; target: Point }>()
  private readonly requests = new Map<number, { x?: number; y?: number }>()
  private readonly shifts = new Map<number, Point>()
  private readonly gone = new Set<WireSegment>()
  private readonly replaced = new Set<string>()
  private readonly shaped: Shaped[] = []
  private readonly pieces: DragPiece[] = []
  private readonly index = new FrameIndex()
  private readonly conflicts: DragConflict[] = []
  private readonly reroutes: DragReroute[] = []
  private readonly touches = new Map<number, { at: Point; own: Set<string>; others: Set<string> }>()
  private readonly splits: Split[] = []

  constructor(plan: DragPlan, move: DragMove) {
    this.plan = plan
    this.move = move
    this.sheet = plan.sheet
  }

  build(): DragFrame {
    if (this.resolveTargets()) return EMPTY_FRAME
    for (const s of this.plan.rigidSegments) this.gone.add(s)
    for (const { halves } of this.plan.rejoinedThrough) for (const s of halves) this.gone.add(s)
    for (const point of this.plan.points) {
      if (point.kind !== "moving") continue
      this.follows.add(point.key)
      for (const s of point.loose) this.gone.add(s)
    }
    this.decideBranches()
    this.shiftFarEnds()
    this.collectAffected()
    this.placePins()
    this.placeRejoined()
    this.placeRigid()
    this.placeStays()
    this.placeShaped()
    this.joinAnchors()
    this.joinSiblings()
    this.placeSplits()
    return this.result()
  }

  private resolveTargets(): boolean {
    let still = true
    for (const pin of this.plan.unplugged) {
      const at = this.move.pin(pin.key, pin.at)
      this.pinTargets.set(pin.key, at)
      if (!samePoint(at, pin.at)) still = false
    }
    for (const point of this.plan.points) {
      for (const pin of point.pins) {
        const at = this.move.pin(pin.key, pin.at)
        this.pinTargets.set(pin.key, at)
        if (!samePoint(at, pin.at)) still = false
      }
      const target = point.pins.length ? this.pinTargets.get(point.pins[0].key)! : this.move.point(point.at)
      this.targets.set(point.key, target)
      if (!samePoint(target, point.at)) still = false
    }
    return still
  }

  private result(): DragFrame {
    const joins: [string, string][] = []
    const seen = new Set<string>()
    for (const touch of this.touches.values()) {
      if (touch.others.size >= 2) {
        const [first, second] = [...touch.others]
        this.conflicts.push({ at: touch.at, reason: "crossing", nets: [first, second] })
        continue
      }
      for (const other of touch.others)
        for (const own of touch.own) {
          const pair: [string, string] = own < other ? [own, other] : [other, own]
          const key = `${pair[0]}\u0000${pair[1]}`
          if (seen.has(key)) continue
          seen.add(key)
          joins.push(pair)
        }
    }
    return { pieces: this.pieces, replaced: this.replaced, pins: this.pinTargets, blocked: this.conflicts.length > 0, conflicts: this.conflicts, reroutes: this.reroutes, joins }
  }

  private targetOf(point: MovingPoint): Point {
    return this.targets.get(point.key)!
  }

  private headingAfter(pin: WirePin): Point | undefined {
    const heading = this.plan.headingOf(pin.key)
    if (!heading) return undefined
    return this.move.heading ? this.move.heading(pin.key, heading) : heading
  }

  private bodyAfter(pin: WirePin): DragBox | undefined {
    const body = this.plan.bodyOf(pin.key)
    const offset = this.move.offset
    return body && offset ? { ...body, x: body.x + offset.x, y: body.y + offset.y } : undefined
  }

  private touch(at: Point, own: string, other: string) {
    const key = pointCode(at)
    let entry = this.touches.get(key)
    if (!entry) this.touches.set(key, (entry = { at, own: new Set(), others: new Set() }))
    entry.own.add(own)
    entry.others.add(other)
  }

  private decideBranches() {
    for (const point of this.plan.points) {
      if (point.kind !== "branch") continue
      const stay = this.stayJoint(point)
      if (stay) {
        this.stays.set(point.key, stay)
        continue
      }
      this.follows.add(point.key)
      for (const s of point.loose) this.gone.add(s)
    }
  }

  private stayJoint(point: MovingPoint): { pieces: DragPiece[]; target: Point } | null {
    const pin = point.pins[0]
    const target = this.targetOf(point)
    const heading = this.headingAfter(pin)
    const body = this.bodyAfter(pin)
    const net = this.plan.netOfPin(pin)
    const tried = new Set<number>()
    for (const reach of [0, 6]) {
      const candidates: Path[] = []
      for (const s of point.loose)
        for (const on of pointsOn(s, target, reach)) {
          const code = pointCode(on)
          if (tried.has(code)) continue
          tried.add(code)
          candidates.push(...pathsBetween(target, on))
        }
      for (const path of preferred(candidates, heading)) {
        if (!ahead(path, target, heading)) continue
        const pieces = this.jointPieces(point, path, net, point.loose[0].color)
        if (body && pieces.some((p) => crossesBox(p.a, p.b, body))) continue
        if (this.trial(pieces, target)) return { pieces, target }
      }
    }
    return null
  }

  private jointPieces(point: MovingPoint, path: Path, net: string, color: WireColorKey | undefined): DragPiece[] {
    const out: DragPiece[] = []
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1]
      const b = path.points[i]
      if (!samePoint(a, b)) out.push(pieceOf(`${point.at.x},${point.at.y}~joint${i}`, a, b, "added", net, color))
    }
    return out
  }

  private shiftFarEnds() {
    if (this.plan.keepsFarEnds) return
    for (const point of this.plan.points) {
      if (!this.follows.has(point.key)) continue
      const moved = minus(this.targetOf(point), point.at)
      for (const s of point.loose) {
        const far = this.plan.farAt(pointCode(otherEnd(s, point.at)))!
        if (far.kind === "fixed") continue
        if (far.kind === "dangling") {
          if (!this.shifts.has(far.key)) this.shifts.set(far.key, moved)
          continue
        }
        if (isDiagonal(s)) continue
        const request = this.requests.get(far.key) ?? {}
        if (isHorizontal(s)) request.y ??= moved.y
        else request.x ??= moved.x
        this.requests.set(far.key, request)
      }
    }
    for (const [key, request] of this.requests) {
      const shift = { x: request.x ?? 0, y: request.y ?? 0 }
      if (isZero(shift)) continue
      this.shifts.set(key, shift)
      const far = this.plan.farAt(key)!
      for (const s of far.segments) {
        const beyond = otherEnd(s, far.at)
        const at = pointCode(beyond)
        if (this.plan.movingAt(at) || this.plan.farAt(at) || this.shifts.has(at)) continue
        if (this.sheet.endsAt(beyond).length === 1 && this.sheet.pinsAt(beyond).length === 0) this.shifts.set(at, shift)
      }
    }
  }

  private displacement(s: WireSegment, end: Point): Point {
    const key = pointCode(end)
    const point = this.plan.movingAt(key)
    if (point) return this.plan.isRigid(s) || this.follows.has(key) ? minus(this.targetOf(point), point.at) : ZERO
    return this.shifts.get(key) ?? ZERO
  }

  private isRigidEnd(s: WireSegment, end: Point) {
    const key = pointCode(end)
    return !!this.plan.movingAt(key) && (this.plan.isRigid(s) || this.follows.has(key))
  }

  private collectAffected() {
    const touched = new Set<WireSegment>()
    for (const point of this.plan.points) if (this.follows.has(point.key)) for (const s of point.loose) touched.add(s)
    for (const key of this.requests.keys()) if (this.shifts.has(key)) for (const s of this.plan.farAt(key)!.segments) touched.add(s)
    for (const s of this.plan.rigidSegments) touched.delete(s)
    for (const s of touched) {
      const da = this.displacement(s, s.a)
      const db = this.displacement(s, s.b)
      if (isZero(da) && isZero(db)) {
        this.gone.delete(s)
        continue
      }
      this.gone.add(s)
      this.replaced.add(s.id)
      this.shaped.push({ s, da, db })
    }
    for (const s of this.plan.rigidSegments) this.replaced.add(s.id)
  }

  private placePins() {
    const lists = [...[...this.plan.points].map((point) => point.pins), this.plan.unplugged]
    for (const pins of lists) {
      for (const pin of pins) {
        const at = this.pinTargets.get(pin.key)!
        const net = this.plan.netOfPin(pin)
        for (const s of this.sheet.through(at)) {
          if (this.gone.has(s)) continue
          if (pin.socket && !samePoint(s.a, at) && !samePoint(s.b, at)) continue
          const other = this.plan.netOfSegment(s)
          if (other !== net) this.touch(at, net, other)
        }
        for (const p of this.sheet.pinsAt(at)) {
          if (this.plan.isCarried(p)) continue
          const other = this.plan.netOfPin(p)
          if (other !== net) this.touch(at, net, other)
        }
        const others: string[] = []
        this.index.othersAt(at, net, others)
        for (const other of others) this.conflicts.push({ at, reason: "pin", pin: pin.key, nets: [net, other] })
        this.index.addMark(at, net, !!pin.socket)
      }
    }
  }

  private placeRejoined() {
    for (const { at, halves } of this.plan.rejoinedThrough) {
      const [first, second] = halves
      for (const s of halves) this.replaced.add(s.id)
      this.place(pieceOf(first.id, otherEnd(first, at), otherEnd(second, at), "stretched", this.plan.netOfSegment(first), first.color, first.id), false, false)
    }
  }

  private placeRigid() {
    for (const s of this.plan.rigidSegments) {
      const a = plus(s.a, this.displacement(s, s.a))
      const b = plus(s.b, this.displacement(s, s.b))
      const net = this.plan.netOfSegment(s)
      if (samePoint(a, b)) continue
      const landsA = this.landing(s.a)
      const landsB = this.landing(s.b)
      if (a.x === b.x || a.y === b.y || isDiagonal(s)) {
        this.place(pieceOf(s.id, a, b, "moved", net, s.color, s.id), landsA, landsB)
        continue
      }
      const corner = isHorizontal(s) ? { x: b.x, y: a.y } : { x: a.x, y: b.y }
      this.place(pieceOf(s.id, a, corner, "moved", net, s.color, s.id), landsA, false)
      this.place(pieceOf(`${s.id}~turn`, corner, b, "moved", net, s.color, s.id), false, landsB)
    }
  }

  private placeStays() {
    for (const stay of this.stays.values()) for (const piece of stay.pieces) this.place(piece, samePoint(piece.a, stay.target), samePoint(piece.b, stay.target))
  }

  private placeShaped() {
    for (const { s, da, db } of this.shaped) {
      const horizontal = isHorizontal(s)
      const net = this.plan.netOfSegment(s)
      const across = (d: Point) => (horizontal ? d.y : d.x)
      if (isDiagonal(s) || across(da) === across(db)) {
        const piece = pieceOf(s.id, plus(s.a, da), plus(s.b, db), "stretched", net, s.color, s.id)
        const rigidA = this.isRigidEnd(s, s.a)
        const rigidB = this.isRigidEnd(s, s.b)
        if (!this.plan.reroutesConflicts) this.place(piece, rigidA, rigidB)
        else this.placeOrReroute(piece, rigidA, rigidB)
        continue
      }
      const aMoves = Math.abs(across(da)) > Math.abs(across(db)) || (Math.abs(across(da)) === Math.abs(across(db)) && across(db) === 0)
      const [moving, fixed, dMoving, dFixed] = aMoves ? [s.a, s.b, da, db] : [s.b, s.a, db, da]
      this.splits.push(this.splitOf(s, net, moving, fixed, dMoving, dFixed))
    }
  }

  private probeOf(piece: DragPiece, rigidA: boolean, rigidB: boolean): Probe {
    const source = piece.source !== undefined ? this.sheet.segment(piece.source) : undefined
    return { id: piece.id, a: piece.a, b: piece.b, net: piece.net, rigidA, rigidB, own: source && withinExtentOf(source, piece.a, piece.b) ? source : undefined }
  }

  private place(piece: DragPiece, rigidA: boolean, rigidB: boolean) {
    if (samePoint(piece.a, piece.b)) return
    const verdict = this.examine(this.probeOf(piece, rigidA, rigidB))
    this.conflicts.push(...verdict.conflicts)
    for (const t of verdict.touches) this.touch(t.at, t.own, t.net)
    this.keep(piece)
  }

  private placeOrReroute(piece: DragPiece, rigidA: boolean, rigidB: boolean) {
    if (samePoint(piece.a, piece.b)) return
    const verdict = this.examine(this.probeOf(piece, rigidA, rigidB))
    const soft = !verdict.conflicts.length
    if (soft) {
      for (const t of verdict.touches) this.touch(t.at, t.own, t.net)
      this.keep(piece)
      if (!this.plan.avoids(piece.a, piece.b)) return
    }
    this.reroutePiece(piece, rigidA, rigidB, soft)
  }

  private reroutePiece(piece: DragPiece, rigidA: boolean, rigidB: boolean, soft: boolean) {
    const [near, to] = rigidA && !rigidB ? [piece.b, piece.a] : [piece.a, piece.b]
    const source = piece.source !== undefined ? this.sheet.segment(piece.source) : undefined
    const unshifted = source && (samePoint(source.a, near) || samePoint(source.b, near))
    const { run, end: from } = unshifted ? this.runBeyond(near, source) : { run: [], end: near }
    const fixedPins = this.sheet.pinsAt(from).filter((p) => !this.plan.isCarried(p))
    const leave = fixedPins.map((p) => this.plan.headingOf(p.key)).find((h) => h)
    const carriedAt = [...this.pinTargets].find(([, at]) => samePoint(at, to))
    const arrive = carriedAt ? this.headingAfter(this.sheet.pin(carriedAt[0])!) : undefined
    if (soft) {
      this.reroutes.push({ soft, from, to, net: piece.net, pieces: [piece.id], run, color: piece.color, source: piece.source, leave, arrive })
      return
    }
    for (const s of run) this.gone.add(s)
    this.pieces.push(piece)
    this.reroutes.push({ from, to, net: piece.net, pieces: [piece.id], run, color: piece.color, source: piece.source, leave, arrive })
  }

  private runBeyond(start: Point, via: WireSegment): { run: WireSegment[]; end: Point } {
    const run: WireSegment[] = []
    let end = start
    let through = via
    for (;;) {
      if (this.sheet.pinsAt(end).length || this.plan.movingAt(pointCode(end)) || this.shifts.has(pointCode(end))) break
      const ends = this.sheet.endsAt(end)
      if (ends.length !== 2) break
      const next = ends[0] === through ? ends[1] : ends[0]
      if (this.gone.has(next) || run.includes(next)) break
      run.push(next)
      through = next
      end = otherEnd(next, end)
    }
    return { run, end }
  }

  foreignContacts(pieces: readonly DragPiece[], removed: ReadonlySet<string>, joined: ReadonlySet<string>): Set<DragPiece> {
    const out = new Set<DragPiece>()
    const allowed = (a: string, b: string) => a === b || joined.has(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
    const isEnd = (a: Point, b: Point, p: Point) => samePoint(a, p) || samePoint(b, p)
    const byLine = new Map<LineKey, DragPiece[]>()
    const add = <T>(map: Map<LineKey, T[]>, line: LineKey, item: T) => {
      const list = map.get(line)
      if (list) list.push(item)
      else map.set(line, [item])
    }
    const slanted: DragPiece[] = []
    for (const p of pieces) {
      if (samePoint(p.a, p.b)) continue
      add(byLine, lineOf(p), p)
      if (isDiagonal(p)) slanted.push(p)
    }
    const targets: { at: Point; pin: WirePin }[] = []
    const targetsByLine = new Map<LineKey, { at: Point; pin: WirePin }[]>()
    for (const [key, at] of this.pinTargets) {
      const pin = this.sheet.pin(key)!
      targets.push({ at, pin })
      add(targetsByLine, rowCode(at.y), { at, pin })
      add(targetsByLine, columnCode(at.x), { at, pin })
    }
    const piecesThrough = (at: Point): DragPiece[] => {
      const found: DragPiece[] = []
      for (const line of [rowCode(at.y), columnCode(at.x)])
        for (const q of byLine.get(line) ?? []) {
          const along = line === rowCode(at.y) && q.a.y === q.b.y ? at.x : at.y
          if ((line === rowCode(at.y)) === (q.a.y === q.b.y) && along >= lowOf(q) && along <= highOf(q)) found.push(q)
        }
      for (const q of slanted) if (contains(q, at)) found.push(q)
      return found
    }
    for (const p of pieces) {
      if (samePoint(p.a, p.b)) continue
      const line = lineOf(p)
      const lo = lowOf(p)
      const hi = highOf(p)
      const bad = (net: string) => !allowed(p.net, net)
      let found = false
      for (const s of this.sheet.alongSegment(p)) if (!removed.has(s.id) && bad(this.plan.netOfSegment(s)) && Math.min(hi, highOf(s)) - Math.max(lo, lowOf(s)) > 0) found = true
      for (const mark of this.sheet.marksOn(p)) {
        if (mark.segment) {
          if (!removed.has(mark.segment.id) && bad(this.plan.netOfSegment(mark.segment))) found = true
        } else if (mark.pin && !this.plan.isCarried(mark.pin) && (!mark.pin.socket || isEnd(p.a, p.b, mark.at)) && bad(this.plan.netOfPin(mark.pin))) found = true
      }
      for (const end of [p.a, p.b]) for (const s of this.sheet.through(end)) if (!removed.has(s.id) && bad(this.plan.netOfSegment(s))) found = true
      for (const q of byLine.get(line) ?? []) {
        if (q === p || !bad(q.net)) continue
        if (Math.min(hi, highOf(q)) - Math.max(lo, lowOf(q)) >= 0) found = true
      }
      for (const end of [p.a, p.b])
        for (const q of piecesThrough(end))
          if (q !== p && bad(q.net)) {
            found = true
            out.add(q)
          }
      const onIt = isDiagonal(p) ? targets.filter(({ at }) => contains(p, at)) : (targetsByLine.get(line) ?? []).filter(({ at }) => along(p, at) >= lo && along(p, at) <= hi)
      for (const { at, pin } of onIt) if ((!pin.socket || isEnd(p.a, p.b, at)) && bad(this.plan.netOfPin(pin))) found = true
      if (found) out.add(p)
    }
    return out
  }

  clearInPlace(segments: readonly WireSegment[], pieces: readonly DragPiece[]): boolean {
    const overlap = (s: { a: Point; b: Point }, t: { a: Point; b: Point }) => !samePoint(t.a, t.b) && cross(s.a, s.b, t.a) === 0 && cross(s.a, s.b, t.b) === 0 && Math.min(highOf(s), highOf(t)) - Math.max(lowOf(s), lowOf(t)) > 0 && lineOf(s) === lineOf(t)
    for (const s of segments) {
      const net = this.plan.netOfSegment(s)
      for (const p of pieces) {
        if (p.net === net) continue
        if (overlap(s, p) || contains(s, p.a) || contains(s, p.b) || contains(p, s.a) || contains(p, s.b)) return false
      }
      for (const [key, at] of this.pinTargets) {
        const pin = this.sheet.pin(key)!
        if (this.plan.netOfPin(pin) !== net && contains(s, at)) return false
      }
    }
    return true
  }

  private keep(piece: DragPiece) {
    this.pieces.push(piece)
    this.index.addPiece(piece.a, piece.b, piece.net)
  }

  private trial(pieces: readonly DragPiece[], rigidEnd: Point | undefined): Touch[] | null {
    const touches: Touch[] = []
    for (const piece of pieces) {
      if (samePoint(piece.a, piece.b)) continue
      const verdict = this.examine(this.probeOf(piece, !!rigidEnd && samePoint(piece.a, rigidEnd), !!rigidEnd && samePoint(piece.b, rigidEnd)))
      if (verdict.conflicts.length) return null
      touches.push(...verdict.touches)
    }
    return touches
  }

  private settle(pieces: readonly DragPiece[], touches: readonly Touch[]) {
    for (const piece of pieces) if (!samePoint(piece.a, piece.b)) this.keep(piece)
    for (const t of touches) this.touch(t.at, t.own, t.net)
  }

  private examine(probe: Probe): Verdict {
    const conflicts: DragConflict[] = []
    const touches: Touch[] = []
    const line = lineOf(probe)
    const lo = lowOf(probe)
    const hi = highOf(probe)
    if (!probe.own) {
      for (const s of this.sheet.alongSegment(probe)) {
        if (this.gone.has(s)) continue
        const other = this.plan.netOfSegment(s)
        if (other !== probe.net && Math.min(hi, highOf(s)) - Math.max(lo, lowOf(s)) > 0) conflicts.push(clashOf(probe, onLineOf(probe, Math.max(lo, lowOf(s))), other, "along"))
      }
      for (const mark of this.sheet.marksOn(probe)) {
        const at = along(probe, mark.at)
        if (at <= lo || at >= hi) continue
        let other: string
        if (mark.segment) {
          if (this.gone.has(mark.segment)) continue
          other = this.plan.netOfSegment(mark.segment)
        } else {
          const pin = mark.pin!
          if (this.plan.isCarried(pin) || pin.socket) continue
          other = this.plan.netOfPin(pin)
        }
        if (other !== probe.net) conflicts.push(clashOf(probe, mark.at, other, "over"))
      }
    }
    for (const placed of this.index.onLine(line))
      if (placed.net !== probe.net && Math.min(hi, placed.hi) - Math.max(lo, placed.lo) > 0) conflicts.push(clashOf(probe, onLineOf(probe, Math.max(lo, placed.lo)), placed.net, "along"))
    for (const mark of this.index.marksAlong(probe)) {
      const at = along(probe, mark.at)
      if (at > lo && at < hi && !mark.socket && mark.net !== probe.net) conflicts.push(clashOf(probe, mark.at, mark.net, "over"))
    }
    this.examineEnd(probe, probe.a, probe.rigidA, conflicts, touches)
    this.examineEnd(probe, probe.b, probe.rigidB, conflicts, touches)
    return { conflicts, touches }
  }

  private examineEnd(probe: Probe, end: Point, rigid: boolean, conflicts: DragConflict[], touches: Touch[]) {
    for (const s of this.sheet.through(end)) {
      if (this.gone.has(s)) continue
      const other = this.plan.netOfSegment(s)
      if (other === probe.net) continue
      if (rigid) touches.push({ at: end, own: probe.net, net: other })
      else conflicts.push(clashOf(probe, end, other, "end"))
    }
    for (const p of this.sheet.pinsAt(end)) {
      if (this.plan.isCarried(p)) continue
      const other = this.plan.netOfPin(p)
      if (other === probe.net) continue
      if (rigid) touches.push({ at: end, own: probe.net, net: other })
      else conflicts.push(clashOf(probe, end, other, "end"))
    }
    const others: string[] = []
    this.index.othersAt(end, probe.net, others)
    for (const other of others) conflicts.push(clashOf(probe, end, other, "end"))
  }

  private splitOf(s: WireSegment, net: string, moving: Point, fixed: Point, dMoving: Point, dFixed: Point): Split {
    const horizontal = isHorizontal(s)
    const along = (p: Point) => (horizontal ? p.x : p.y)
    const fixedAfter = plus(fixed, dFixed)
    const movingAfter = plus(moving, dMoving)
    const movingRigid = this.isRigidEnd(s, moving)
    const fixedPins = this.sheet.pinsAt(fixed).filter((p) => !this.plan.isCarried(p))
    const dogleg = movingRigid && fixedPins.length > 0 && isZero(dFixed)
    const from = along(fixedAfter)
    const to = along(movingAfter)
    const direction = Math.sign(to - from)
    const within = (t: number) => (direction === 0 ? t === from : (t - from) * direction >= 0 && (to - t) * direction >= 0)
    const candidates: number[] = []
    const add = (t: number) => {
      if (within(t) && !candidates.includes(t)) candidates.push(t)
    }
    let leave: Point | undefined
    if (dogleg) {
      leave = fixedPins.map((p) => this.plan.headingOf(p.key)).find((h) => h)
      const jog = horizontal ? { x: 0, y: dMoving.y - dFixed.y } : { x: dMoving.x - dFixed.x, y: 0 }
      if (leave && dot(jog, leave) > 0) add(from)
      for (let t = from + direction * GRID; direction !== 0 && within(t); t += direction * GRID) add(t)
      add(to)
      add(from)
    } else {
      const start = Math.max(Math.min(from, to), Math.min(Math.max(from, to), along(moving)))
      add(start)
      for (let t = start - direction * GRID; direction !== 0 && within(t); t -= direction * GRID) add(t)
      add(from)
      add(to)
    }
    const jogDirection = Math.sign(horizontal ? movingAfter.y - fixedAfter.y : movingAfter.x - fixedAfter.x)
    const line = horizontal ? s.a.y : s.a.x
    const arrive = movingRigid ? this.plan.movingAt(pointCode(moving))?.pins.map((p) => this.headingAfter(p)).find((h) => h) : undefined
    return { source: s, net, horizontal, fixedAfter, movingAfter, movingRigid, candidates, order: (horizontal ? 0 : 1e12) - jogDirection * line, tie: along(fixed), leave, arrive }
  }

  private splitPieces(split: Split, t: number): DragPiece[] {
    const { source, horizontal, fixedAfter, movingAfter } = split
    const at = (along: number, across: number): Point => (horizontal ? { x: along, y: across } : { x: across, y: along })
    const fixedLine = horizontal ? fixedAfter.y : fixedAfter.x
    const movingLine = horizontal ? movingAfter.y : movingAfter.x
    const parts = [
      { role: "jog", a: at(t, fixedLine), b: at(t, movingLine), kind: "jog" as const },
      { role: "moved", a: at(t, movingLine), b: movingAfter, kind: "stretched" as const },
      { role: "rest", a: fixedAfter, b: at(t, fixedLine), kind: "stretched" as const },
    ].filter((p) => !samePoint(p.a, p.b))
    const main = parts.find((p) => p.role === "moved") ?? parts.find((p) => p.role === "rest") ?? parts[0]
    return parts.map((p) => pieceOf(p === main ? source.id : `${source.id}~${p.role}`, p.a, p.b, p.kind, split.net, source.color, source.id))
  }

  private placeSplits() {
    const ordered = [...this.splits].sort((p, q) => p.order - q.order || p.tie - q.tie)
    for (const split of ordered) {
      const rigid = split.movingRigid ? split.movingAfter : undefined
      let placed = false
      const clear = (pieces: readonly DragPiece[]) => !pieces.some((p) => this.plan.avoids(p.a, p.b))
      let settled: readonly DragPiece[] = []
      for (const pass of [true, false]) {
        for (const t of split.candidates) {
          const pieces = this.splitPieces(split, t)
          if (pass && !clear(pieces)) continue
          const touches = this.trial(pieces, rigid)
          if (!touches) continue
          this.settle(pieces, touches)
          placed = true
          settled = pass ? [] : pieces
          break
        }
        if (placed) break
      }
      if (placed && settled.length && this.plan.reroutesConflicts) {
        const { run, end } = this.privateRun(split)
        const leave = run.length ? this.sheet.pinsAt(end).map((p) => this.plan.headingOf(p.key)).find((h) => h) : split.leave
        this.reroutes.push({ soft: true, from: end, to: split.movingAfter, net: split.net, pieces: settled.map((p) => p.id), run, color: split.source.color, source: split.source.id, leave, arrive: split.arrive })
      }
      if (placed) continue
      const pieces = this.splitPieces(split, split.candidates[0] ?? (split.horizontal ? split.fixedAfter.x : split.fixedAfter.y))
      this.pieces.push(...pieces)
      const { run, end } = this.privateRun(split)
      const leave = run.length ? this.sheet.pinsAt(end).map((p) => this.plan.headingOf(p.key)).find((h) => h) : split.leave
      this.reroutes.push({ from: end, to: split.movingAfter, net: split.net, pieces: pieces.map((p) => p.id), run, color: split.source.color, source: split.source.id, leave, arrive: split.arrive })
    }
  }

  private landing(end: Point): boolean {
    const point = this.plan.movingAt(pointCode(end))
    return !point || point.pins.length > 0 || point.kind !== "anchored"
  }

  private joinAnchors() {
    for (const point of this.plan.points) {
      if (point.kind !== "anchored") continue
      const target = this.targetOf(point)
      if (samePoint(target, point.at)) continue
      const net = this.plan.netOfPin(point.anchors[0])
      const anchorHeading = point.anchors.map((p) => this.plan.headingOf(p.key)).find((h) => h)
      const carriedHeading = point.pins.map((p) => this.headingAfter(p)).find((h) => h)
      const color = point.rigid[0]?.color ?? point.loose[0]?.color
      const paths = this.anchorPaths(point.at, target, anchorHeading)
      const tidy = (path: Path) => (ahead(path, point.at, anchorHeading) && ahead(path, target, carriedHeading) ? 0 : 1)
      let placed = false
      const ordered = [...preferred(paths.filter((path) => tidy(path) === 0), anchorHeading), ...preferred(paths.filter((path) => tidy(path) === 1), anchorHeading)]
      for (const path of ordered) {
        const pieces = this.jointPieces(point, path, net, color)
        const touches = this.trial(pieces, point.pins.length ? target : undefined)
        if (!touches) continue
        this.settle(pieces, touches)
        placed = true
        break
      }
      if (placed) continue
      const pieces = this.jointPieces(point, ordered[0], net, color)
      this.pieces.push(...pieces)
      this.reroutes.push({ from: point.at, to: target, net, pieces: pieces.map((p) => p.id), run: [], color, leave: anchorHeading, arrive: carriedHeading })
    }
  }

  private joinSiblings() {
    for (const point of this.plan.points) {
      if (point.pins.length < 2) continue
      const first = this.pinTargets.get(point.pins[0].key)!
      const seen = new Set<number>([pointCode(first)])
      for (const pin of point.pins.slice(1)) {
        const target = this.pinTargets.get(pin.key)!
        if (seen.has(pointCode(target))) continue
        seen.add(pointCode(target))
        const net = this.plan.netOfPin(pin)
        const heading = this.headingAfter(point.pins[0])
        const paths = preferred(this.anchorPaths(first, target, heading), heading)
        let placed = false
        for (const path of paths) {
          const pieces = this.jointPieces(point, path, net, undefined).map((p) => ({ ...p, id: `${p.id}~${pin.key}` }))
          const touches = this.trial(pieces, undefined)
          if (!touches) continue
          this.settle(pieces, touches)
          placed = true
          break
        }
        if (placed) continue
        const pieces = this.jointPieces(point, paths[0], net, undefined).map((p) => ({ ...p, id: `${p.id}~${pin.key}` }))
        this.pieces.push(...pieces)
        this.reroutes.push({ from: first, to: target, net, pieces: pieces.map((p) => p.id), run: [], leave: heading, arrive: this.headingAfter(pin) })
      }
    }
  }

  private privateRun(split: Split): { run: WireSegment[]; end: Point } {
    const run: WireSegment[] = []
    let end = split.fixedAfter
    let through = split.source
    if (!samePoint(end, split.source.a) && !samePoint(end, split.source.b)) return { run, end }
    for (;;) {
      if (this.sheet.pinsAt(end).length || this.plan.movingAt(pointCode(end)) || this.shifts.has(pointCode(end))) break
      const ends = this.sheet.endsAt(end)
      if (ends.length !== 2) break
      const next = ends[0] === through ? ends[1] : ends[0]
      if (this.gone.has(next) || run.includes(next)) break
      run.push(next)
      through = next
      end = otherEnd(next, end)
    }
    return { run, end }
  }

  private anchorPaths(from: Point, to: Point, heading: Point | undefined): Path[] {
    const paths = pathsBetween(from, to)
    if (!heading || (heading.x !== 0 && heading.y !== 0)) return paths
    const gap = dot(minus(to, from), heading)
    for (let lead = GRID; lead < gap; lead += GRID) {
      const out = plus(from, { x: heading.x * lead, y: heading.y * lead })
      const turn = heading.x !== 0 ? { x: out.x, y: to.y } : { x: to.x, y: out.y }
      if (samePoint(turn, to) || samePoint(turn, out)) continue
      paths.push({ points: [from, out, turn, to], length: taxicab(from, to), bends: 2 })
    }
    return paths
  }

  keepInPlace(segments: readonly WireSegment[]) {
    for (const s of segments) this.gone.delete(s)
  }

  reroute(reroute: DragReroute, pieces: readonly DragPiece[], replacing: readonly WireSegment[] = [], margin = REROUTE_MARGIN): DragPiece[] | null {
    const gone = new Set(reroute.pieces)
    const others = pieces.filter((p) => !gone.has(p.id))
    const box = latticeBoxAround([reroute.from, reroute.to], margin * GRID)
    for (const s of replacing) this.gone.add(s)
    const flags = this.latticeFlags(box, reroute.net, others, [reroute.from, reroute.to])
    for (const s of replacing) this.gone.delete(s)
    const path = routeOnLattice({ from: reroute.from, to: reroute.to, leave: reroute.leave, arrive: reroute.arrive }, { box, flags })
    if (!path) return null
    const out: DragPiece[] = []
    for (let i = 1; i < path.length; i++) {
      const id = i === 1 && reroute.source ? reroute.source : `${reroute.pieces[0] ?? "route"}~route${i}`
      out.push(pieceOf(id, path[i - 1], path[i], "added", reroute.net, reroute.color, reroute.source))
    }
    return out
  }

  private latticeFlags(box: DragBox, net: string, pieces: readonly DragPiece[], ends: readonly Point[] = []): (p: Point) => number {
    const columns = Math.round(box.w / HALF_CELL) + 1
    const rows = Math.round(box.h / HALF_CELL) + 1
    const flags = new Uint8Array(columns * rows)
    const cell = (p: Point) => {
      const i = (p.x - box.x) / HALF_CELL
      const j = (p.y - box.y) / HALF_CELL
      return i >= 0 && j >= 0 && i < columns && j < rows && Number.isInteger(i) && Number.isInteger(j) ? j * columns + i : -1
    }
    const flag = (p: Point, bit: number) => {
      const at = cell(p)
      if (at >= 0) flags[at] |= bit
    }
    const run = (a: Point, b: Point) => {
      const horizontal = a.y === b.y
      const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
      const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
      const first = Math.max(lo + HALF_CELL, horizontal ? box.x : box.y)
      const last = Math.min(hi - HALF_CELL, horizontal ? box.x + box.w : box.y + box.h)
      for (let v = first; v <= last; v += HALF_CELL) flag(horizontal ? { x: v, y: a.y } : { x: a.x, y: v }, horizontal ? LATTICE_ACROSS_H : LATTICE_ACROSS_V)
      flag(a, LATTICE_END)
      flag(b, LATTICE_END)
    }
    for (let y = box.y; y <= box.y + box.h; y += HALF_CELL)
      for (const s of this.sheet.along(rowCode(y), box.x, box.x + box.w)) if (!this.gone.has(s) && this.plan.netOfSegment(s) !== net) run(s.a, s.b)
    for (let x = box.x; x <= box.x + box.w; x += HALF_CELL) {
      for (const s of this.sheet.along(columnCode(x), box.y, box.y + box.h)) if (!this.gone.has(s) && this.plan.netOfSegment(s) !== net) run(s.a, s.b)
      for (const mark of this.sheet.marks(columnCode(x), box.y, box.y + box.h)) {
        const pin = mark.pin
        if (!pin || this.plan.isCarried(pin) || this.plan.netOfPin(pin) === net) continue
        flag(pin.at, pin.socket ? LATTICE_PASS : LATTICE_END)
      }
    }
    const slant = (s: { a: Point; b: Point }) => {
      for (const at of latticeAlong(s)) flag(at, samePoint(at, s.a) || samePoint(at, s.b) ? LATTICE_END : LATTICE_PASS)
    }
    for (const s of this.sheet.slantsWithin(box)) if (!this.gone.has(s) && this.plan.netOfSegment(s) !== net) slant(s)
    for (const piece of pieces) {
      if (piece.net === net || samePoint(piece.a, piece.b)) continue
      if (isDiagonal(piece)) slant(piece)
      else run(piece.a, piece.b)
    }
    for (const [key, at] of this.pinTargets) {
      const pin = this.sheet.pin(key)!
      if (this.plan.netOfPin(pin) !== net) flag(at, pin.socket ? LATTICE_PASS : LATTICE_END)
    }
    const strictlyIn = (p: Point, r: DragBox) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h
    for (const body of this.plan.solidIn(box)) {
      if (ends.some((p) => strictlyIn(p, body))) continue
      for (let y = Math.max(box.y, Math.ceil(body.y / HALF_CELL) * HALF_CELL); y <= Math.min(box.y + box.h, body.y + body.h); y += HALF_CELL)
        for (let x = Math.max(box.x, Math.ceil(body.x / HALF_CELL) * HALF_CELL); x <= Math.min(box.x + box.w, body.x + body.w); x += HALF_CELL) if (strictlyIn({ x, y }, body)) flag({ x, y }, LATTICE_END)
    }
    return (p: Point) => {
      const at = cell(p)
      return at >= 0 ? flags[at] : 0
    }
  }
}
