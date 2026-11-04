import { GRID } from "../grid"
import type { Point } from "../types"
import type { WireColorKey } from "../wire-colors"
import type { WireNets } from "./graph"
import { LATTICE_ACROSS_H, LATTICE_ACROSS_V, LATTICE_END, LATTICE_PASS, latticeBoxAround, routeOnLattice } from "./lattice-route"
import type { NewId, WireEdit } from "./normal-form"
import { HALF_CELL, highOf, isHorizontal, lowOf, samePoint, type WirePin, type WireSegment } from "./segment"
import { columnCode, lineCodeOf, pointCode, rowCode, type LineCode, type WireSheet } from "./sheet"

export type DragBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export type DragRequest = {
  readonly pins: Iterable<string>
  readonly wires?: Iterable<string>
  readonly heading?: (key: string) => Point | undefined
  readonly body?: (key: string) => DragBox | undefined
}

export type DragMove = {
  readonly pin: (key: string, at: Point) => Point
  readonly point: (at: Point) => Point
  readonly heading?: (key: string, heading: Point) => Point
  readonly offset?: Point
}

export type DragPieceKind = "moved" | "stretched" | "jog" | "added"

export type DragPiece = { readonly id: string; readonly a: Point; readonly b: Point; readonly color?: WireColorKey; readonly kind: DragPieceKind; readonly net: string; readonly source?: string }

export type DragContact = "along" | "over" | "end" | "pin" | "crossing"

export type DragConflict = { readonly at: Point; readonly reason: DragContact; readonly piece?: string; readonly pin?: string; readonly nets: readonly [string, string] }

export type DragReroute = {
  readonly from: Point
  readonly to: Point
  readonly net: string
  readonly pieces: readonly string[]
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

export type DragCommit = { readonly edit: WireEdit; readonly pins: readonly WirePin[]; readonly joins: readonly (readonly [string, string])[] }

const ZERO: Point = { x: 0, y: 0 }
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

type Probe = { readonly id: string; readonly a: Point; readonly b: Point; readonly net: string; readonly rigidA: boolean; readonly rigidB: boolean; readonly own?: WireSegment }

type Touch = { readonly at: Point; readonly own: string; readonly net: string }

type Verdict = { readonly conflicts: DragConflict[]; readonly touches: Touch[] }

type FrameMark = { readonly along: number; readonly at: Point; readonly net: string; readonly socket: boolean }

type Placed = { readonly a: Point; readonly net: string; readonly lo: number; readonly hi: number }

class FrameIndex {
  private readonly runs = new Map<LineCode, Placed[]>()
  private readonly marks = new Map<LineCode, FrameMark[]>()

  addPiece(a: Point, b: Point, net: string) {
    const extent = { a, b }
    const line = lineCodeOf(extent)
    const horizontal = a.y === b.y
    const placed = { a, net, lo: horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y), hi: horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y) }
    const list = this.runs.get(line)
    if (list) list.push(placed)
    else this.runs.set(line, [placed])
    this.addMark(a, net, false)
    this.addMark(b, net, false)
  }

  addMark(at: Point, net: string, socket: boolean) {
    this.markOn(rowCode(at.y), { along: at.x, at, net, socket })
    this.markOn(columnCode(at.x), { along: at.y, at, net, socket })
  }

  private markOn(line: LineCode, mark: FrameMark) {
    const list = this.marks.get(line)
    if (list) list.push(mark)
    else this.marks.set(line, [mark])
  }

  onLine(line: LineCode): readonly Placed[] {
    return this.runs.get(line) ?? []
  }

  marksOn(line: LineCode): readonly FrameMark[] {
    return this.marks.get(line) ?? []
  }

  othersAt(p: Point, net: string, into: string[]) {
    for (const r of this.runs.get(rowCode(p.y)) ?? []) if (r.net !== net && r.lo <= p.x && p.x <= r.hi) into.push(r.net)
    for (const r of this.runs.get(columnCode(p.x)) ?? []) if (r.net !== net && r.lo <= p.y && p.y <= r.hi) into.push(r.net)
    for (const m of this.marks.get(rowCode(p.y)) ?? []) if (m.net !== net && m.along === p.x) into.push(m.net)
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
  isHorizontal(s)
    ? a.y === s.a.y && b.y === s.a.y && Math.min(a.x, b.x) >= lowOf(s) && Math.max(a.x, b.x) <= highOf(s)
    : a.x === s.a.x && b.x === s.a.x && Math.min(a.y, b.y) >= lowOf(s) && Math.max(a.y, b.y) <= highOf(s)

const clashOf = (probe: Probe, at: Point, other: string, reason: DragContact): DragConflict => ({ at, reason, piece: probe.id, nets: [probe.net, other] })

const onLineOf = (probe: Probe, along: number): Point => (probe.a.y === probe.b.y ? { x: along, y: probe.a.y } : { x: probe.a.x, y: along })

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
    for (const key of request.pins) {
      const pin = sheet.pin(key)
      if (!pin) throw new Error(`the drag carries pin ${key}, which is not on the sheet`)
      if (this.carriedPins.has(key)) continue
      this.carriedPins.add(key)
      gather(pin.at).pins.push(pin)
    }
    const carriedWires = new Set<WireSegment>()
    for (const id of request.wires ?? []) {
      const s = sheet.segment(id)
      if (!s) throw new Error(`the drag carries wire ${id}, which is not on the sheet`)
      carriedWires.add(s)
      gather(s.a)
      gather(s.b)
    }
    for (const [key, entry] of gathered) {
      const own: WireSegment[] = []
      const loose: WireSegment[] = []
      for (const s of sheet.endsAt(entry.at)) {
        if (carriedWires.has(s) || gathered.has(pointCode(otherEnd(s, entry.at)))) {
          own.push(s)
          this.rigidSet.add(s)
        } else loose.push(s)
      }
      const anchors = sheet.pinsAt(entry.at).filter((p) => !this.carriedPins.has(p.key))
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

  frame(move: Point | DragMove): DragFrame {
    return new FrameBuilder(this, asMove(move)).build()
  }

  commit(move: Point | DragMove, newId: NewId = randomId): DragCommit | null {
    const builder = new FrameBuilder(this, asMove(move))
    const frame = builder.build()
    if (frame.blocked) return null
    let pieces: readonly DragPiece[] = frame.pieces
    for (const reroute of frame.reroutes) {
      const routed = builder.reroute(reroute, pieces)
      if (!routed) return null
      const gone = new Set(reroute.pieces)
      pieces = [...pieces.filter((p) => !gone.has(p.id)), ...routed]
    }
    return { edit: this.editOf(frame, pieces, newId), pins: [...frame.pins].map(([key, at]) => ({ ...this.sheet.pin(key)!, at })), joins: frame.joins }
  }

  private editOf(frame: DragFrame, pieces: readonly DragPiece[], newId: NewId): WireEdit {
    if (!pieces.length && !frame.replaced.size && !frame.pins.size) return {}
    const kept = new Set<string>()
    const unchanged = new Set<DragPiece>()
    for (const piece of pieces) {
      if (!piece.source || kept.has(piece.source)) continue
      const stored = this.sheet.segment(piece.source)!
      const same = (samePoint(stored.a, piece.a) && samePoint(stored.b, piece.b)) || (samePoint(stored.a, piece.b) && samePoint(stored.b, piece.a))
      if (!same) continue
      kept.add(piece.source)
      unchanged.add(piece)
    }
    const remove = [...frame.replaced].filter((id) => !kept.has(id)).map((id) => this.sheet.segment(id)!)
    const add: WireSegment[] = []
    for (const piece of pieces) {
      if (unchanged.has(piece)) continue
      const id = piece.source && piece.id === piece.source && !kept.has(piece.source) ? piece.source : newId()
      add.push(piece.color ? { id, a: piece.a, b: piece.b, color: piece.color } : { id, a: piece.a, b: piece.b })
    }
    const points: Point[] = []
    for (const point of this.moving.values()) points.push(point.at)
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

  isRigid(s: WireSegment) {
    return this.rigidSet.has(s)
  }
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
    for (const point of this.plan.points) {
      if (point.kind !== "moving") continue
      this.follows.add(point.key)
      for (const s of point.loose) this.gone.add(s)
    }
    this.decideBranches()
    this.shiftFarEnds()
    this.collectAffected()
    this.placePins()
    this.placeRigid()
    this.placeStays()
    this.placeShaped()
    this.joinAnchors()
    this.placeSplits()
    return this.result()
  }

  private resolveTargets(): boolean {
    let still = true
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
    for (const point of this.plan.points) {
      for (const pin of point.pins) {
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

  private placeRigid() {
    for (const s of this.plan.rigidSegments) {
      const a = plus(s.a, this.displacement(s, s.a))
      const b = plus(s.b, this.displacement(s, s.b))
      const net = this.plan.netOfSegment(s)
      if (samePoint(a, b)) continue
      if (a.x === b.x || a.y === b.y) {
        this.place(pieceOf(s.id, a, b, "moved", net, s.color, s.id), true, true)
        continue
      }
      const corner = isHorizontal(s) ? { x: b.x, y: a.y } : { x: a.x, y: b.y }
      this.place(pieceOf(s.id, a, corner, "moved", net, s.color, s.id), true, false)
      this.place(pieceOf(`${s.id}~turn`, corner, b, "moved", net, s.color, s.id), false, true)
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
      if (across(da) === across(db)) {
        this.place(pieceOf(s.id, plus(s.a, da), plus(s.b, db), "stretched", net, s.color, s.id), this.isRigidEnd(s, s.a), this.isRigidEnd(s, s.b))
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
    const horizontal = probe.a.y === probe.b.y
    const line = horizontal ? rowCode(probe.a.y) : columnCode(probe.a.x)
    const lo = horizontal ? Math.min(probe.a.x, probe.b.x) : Math.min(probe.a.y, probe.b.y)
    const hi = horizontal ? Math.max(probe.a.x, probe.b.x) : Math.max(probe.a.y, probe.b.y)
    if (!probe.own) {
      for (const s of this.sheet.along(line, lo, hi)) {
        if (this.gone.has(s)) continue
        const other = this.plan.netOfSegment(s)
        if (other !== probe.net && Math.min(hi, highOf(s)) - Math.max(lo, lowOf(s)) > 0) conflicts.push(clashOf(probe, onLineOf(probe, Math.max(lo, lowOf(s))), other, "along"))
      }
      for (const mark of this.sheet.marks(line, lo, hi)) {
        const along = horizontal ? mark.at.x : mark.at.y
        if (along <= lo || along >= hi) continue
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
    for (const mark of this.index.marksOn(line)) if (mark.along > lo && mark.along < hi && !mark.socket && mark.net !== probe.net) conflicts.push(clashOf(probe, mark.at, mark.net, "over"))
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
      for (const t of split.candidates) {
        const pieces = this.splitPieces(split, t)
        const touches = this.trial(pieces, rigid)
        if (!touches) continue
        this.settle(pieces, touches)
        placed = true
        break
      }
      if (placed) continue
      const pieces = this.splitPieces(split, split.candidates[0] ?? (split.horizontal ? split.fixedAfter.x : split.fixedAfter.y))
      this.pieces.push(...pieces)
      this.reroutes.push({ from: split.fixedAfter, to: split.movingAfter, net: split.net, pieces: pieces.map((p) => p.id), color: split.source.color, source: split.source.id, leave: split.leave, arrive: split.arrive })
    }
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
        const touches = this.trial(pieces, target)
        if (!touches) continue
        this.settle(pieces, touches)
        placed = true
        break
      }
      if (placed) continue
      const pieces = this.jointPieces(point, ordered[0], net, color)
      this.pieces.push(...pieces)
      this.reroutes.push({ from: point.at, to: target, net, pieces: pieces.map((p) => p.id), color, leave: anchorHeading, arrive: carriedHeading })
    }
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

  reroute(reroute: DragReroute, pieces: readonly DragPiece[]): DragPiece[] | null {
    const gone = new Set(reroute.pieces)
    const others = pieces.filter((p) => !gone.has(p.id))
    const box = latticeBoxAround([reroute.from, reroute.to], 10 * GRID)
    const flags = this.latticeFlags(box, reroute.net, others)
    const path = routeOnLattice({ from: reroute.from, to: reroute.to, leave: reroute.leave, arrive: reroute.arrive }, { box, flags })
    if (!path) return null
    const out: DragPiece[] = []
    for (let i = 1; i < path.length; i++) {
      const id = i === 1 && reroute.source ? reroute.source : `${reroute.pieces[0] ?? "route"}~route${i}`
      out.push(pieceOf(id, path[i - 1], path[i], "added", reroute.net, reroute.color, reroute.source))
    }
    return out
  }

  private latticeFlags(box: DragBox, net: string, pieces: readonly DragPiece[]): (p: Point) => number {
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
    for (const piece of pieces) if (piece.net !== net && !samePoint(piece.a, piece.b)) run(piece.a, piece.b)
    for (const [key, at] of this.pinTargets) {
      const pin = this.sheet.pin(key)!
      if (this.plan.netOfPin(pin) !== net) flag(at, pin.socket ? LATTICE_PASS : LATTICE_END)
    }
    return (p: Point) => {
      const at = cell(p)
      return at >= 0 ? flags[at] : 0
    }
  }
}
