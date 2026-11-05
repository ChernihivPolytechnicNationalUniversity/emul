import { GRID, objectRect, snap, type FlipAxis, type Rect, type Turn } from "./geometry"
import { flipLine, flipSelection, selectionStep, turnedAbout, turnedSelection, turnPivot } from "./orient"
import { designatorRects, footprint } from "./placement"
import { SpatialIndex } from "./spatial"
import type { PlacedObject, Point, Schematic } from "./types"
import { detachedMove, moved, pinsOf, travellingIn, travellingWires, wiringOf, withSegments, type NewId, type Wiring } from "./wire-edits"
import { normalOffset, planDrag, translate, type DragBox, type DragCommit, type DragConflict, type DragFrame, type DragMove, type DragPlan } from "./wires/drag"
import { WireGraph, type WireNets } from "./wires/graph"
import { HALF_CELL, samePoint, type WirePin, type WireSegment } from "./wires/segment"
import { WireSheet } from "./wires/sheet"

export type Carried = { readonly objects: ReadonlySet<string>; readonly wires?: ReadonlySet<string> }

export type Unlaid = { readonly at: Point; readonly net: string; readonly pin?: string; readonly kept: boolean }

export type Landed = { readonly doc: Schematic; readonly unlaid: readonly Unlaid[]; readonly at: Point; readonly refused?: readonly DragConflict[] }

export type DragOptions = { readonly detach?: boolean; readonly index?: SpatialIndex }

const randomId: NewId = () => crypto.randomUUID()

export const UNLAID = { title: "wire left where it was", why: "Laying it to the new place would have touched another net's wire or pin, so nothing was joined: the wire stays where it was and the pin is open. Draw it again or move the part." }

export const WIRES_REFUSED = { title: "Not done: the wires could not follow", why: "Laying them again would have joined another net or deleted a wire, so nothing changed. Move the part to a clearer spot first." }

export const CONTACT_OPENED = { title: "contact opened", why: "No wire could join those pins again without touching another net, so they are open now. Draw the wire or move the part." }

export const TURN_REFUSED = { title: "Not turned", why: "Turning it would put a pin on a crossing of two wires or on another net's wire, so nothing changed." }

export const WIRE_MOVE_REFUSED = { title: "Wire not moved", why: "There it would lie along another net's wire or end on another net's pin, so it stayed where it was." }

export const DRAG_REFUSED = { title: "Nowhere clean to put it", why: "Every place near the drop puts a pin on a crossing of two wires or lays a wire along another net's wire." }

const ZERO: Point = { x: 0, y: 0 }

const EMPTY_FRAME: DragFrame = { pieces: [], replaced: new Set(), pins: new Map(), blocked: false, conflicts: [], reroutes: [], joins: [] }

const objectOf = (key: string) => key.slice(0, key.indexOf(":"))

function isCurrent(doc: Schematic, wiring: Wiring | undefined): wiring is Wiring {
  if (!wiring || wiring.source.objects !== doc.objects || wiring.source.wires !== doc.wires) return false
  try {
    void wiring.view.nets
    return true
  } catch {
    return false
  }
}

export const currentWiring = (doc: Schematic, wiring?: Wiring): Wiring => (isCurrent(doc, wiring) ? wiring : wiringOf(new WireGraph(), doc))

const axisAligned = (p: Point | undefined) => (p && (p.x === 0) !== (p.y === 0) ? p : undefined)

const otherEnd = (s: WireSegment, p: Point) => (samePoint(s.a, p) ? s.b : s.a)

type Hanging = { readonly pin: WirePin; readonly segments: readonly WireSegment[] }

function hangingChains(sheet: WireSheet, pins: readonly WirePin[]): Hanging[] {
  const out: Hanging[] = []
  for (const pin of pins)
    for (const first of sheet.endsAt(pin.at)) {
      const chain = [first]
      let at = otherEnd(first, pin.at)
      let through = first
      for (;;) {
        if (sheet.pinsAt(at).length) break
        const ends = sheet.endsAt(at)
        if (ends.length === 1) {
          out.push({ pin, segments: chain })
          break
        }
        if (ends.length !== 2) break
        through = ends[0] === through ? ends[1] : ends[0]
        if (chain.includes(through)) break
        chain.push(through)
        at = otherEnd(through, at)
      }
    }
  return out
}

const hangingRuns = (sheet: WireSheet, pins: readonly WirePin[]): Set<string> => new Set(hangingChains(sheet, pins).flatMap((h) => h.segments.map((s) => s.id)))

function freeChain(sheet: WireSheet, first: WireSegment): WireSegment[] | null {
  const chain = [first]
  for (const start of [first.a, first.b]) {
    let at = start
    let through = first
    for (;;) {
      if (sheet.pinsAt(at).length) return null
      const ends = sheet.endsAt(at)
      if (ends.length === 1) break
      if (ends.length !== 2) return null
      through = ends[0] === through ? ends[1] : ends[0]
      if (chain.includes(through)) return null
      chain.push(through)
      at = otherEnd(through, at)
    }
  }
  return chain
}

function withWholeFreeChains(sheet: WireSheet, wires: ReadonlySet<string>): ReadonlySet<string> {
  if (!wires.size) return wires
  const whole = new Set(wires)
  for (const id of wires) {
    const segment = sheet.segment(id)
    const chain = segment && freeChain(sheet, segment)
    if (chain) for (const s of chain) whole.add(s.id)
  }
  return whole
}

const drawnBody = (o: PlacedObject): Rect => footprint(o, GRID)?.box ?? objectRect(o, GRID)

const crosses = (a: Point, b: Point, r: Rect) => Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h

class Surroundings {
  private index: SpatialIndex | undefined
  private readonly objects: readonly PlacedObject[]
  private readonly carried: ReadonlySet<string>
  private readonly extra: readonly Rect[]

  constructor(doc: Schematic, carried: ReadonlySet<string>, extra: readonly Rect[] = [], index?: SpatialIndex) {
    this.index = index
    this.objects = doc.objects
    this.carried = carried
    this.extra = extra
  }

  private query(box: Rect): PlacedObject[] {
    this.index ??= new SpatialIndex(this.objects, GRID)
    return this.index.query(box).filter((o) => !this.carried.has(o.id))
  }

  private near(a: Point, b: Point): readonly PlacedObject[] {
    const x = Math.min(a.x, b.x) - 3 * GRID
    const y = Math.min(a.y, b.y) - 3 * GRID
    return this.query({ x, y, w: Math.abs(a.x - b.x) + 6 * GRID, h: Math.abs(a.y - b.y) + 6 * GRID })
  }

  avoid = (a: Point, b: Point): boolean => {
    for (const o of this.near(a, b)) if (crosses(a, b, drawnBody(o)) || designatorRects(o, GRID).some((r) => crosses(a, b, r))) return true
    return this.extra.some((r) => crosses(a, b, r))
  }

  solid = (box: DragBox): readonly DragBox[] => [...this.query(box).map(drawnBody), ...this.extra]
}

function carriedPins(doc: Schematic, objects: ReadonlySet<string>): WirePin[] {
  return pinsOf(doc.objects.filter((o) => objects.has(o.id)))
}

function unlaidOf(commit: DragCommit, pinAt: (at: Point) => string | undefined): Unlaid[] {
  return commit.unlaid.map((u) => {
    const pin = pinAt(u.at)
    return { at: u.at, net: u.net, kept: u.kept, ...(pin && { pin }) }
  })
}

function committed(doc: Schematic, objects: PlacedObject[], commit: DragCommit, newId: NewId): Schematic {
  const { add = [], remove = [], points = [] } = commit.edit
  return withSegments({ ...doc, objects }, add, remove, points, newId)
}

function nearestWhere(offset: Point, clean: (at: Point) => boolean, reach = 4, axis?: "x" | "y"): Point | null {
  const candidates: { at: Point; rank: number }[] = []
  for (let dx = -reach; dx <= reach; dx++)
    for (let dy = -reach; dy <= reach; dy++) {
      if ((axis === "x" && dy) || (axis === "y" && dx)) continue
      const at = { x: offset.x + dx * GRID, y: offset.y + dy * GRID }
      candidates.push({ at, rank: (dx * dx + dy * dy) * 1e9 + Math.hypot(at.x, at.y) })
    }
  candidates.sort((p, q) => p.rank - q.rank)
  return candidates.find(({ at }) => clean(at))?.at ?? null
}

export class PartDrag {
  private readonly doc: Schematic
  private readonly wiring: Wiring
  private readonly from: ReadonlyMap<string, Point>
  private readonly plan: DragPlan | null
  private readonly relaying: () => DragPlan
  private readonly detach: boolean
  private readonly whole: boolean
  private last: { key: string; frame: DragFrame } | null = null

  constructor(doc: Schematic, wiring: Wiring | undefined, carried: Carried, options: DragOptions = {}) {
    this.doc = doc
    this.wiring = currentWiring(doc, wiring)
    this.from = new Map(doc.objects.filter((o) => carried.objects.has(o.id)).map((o) => [o.id, { x: o.x, y: o.y }] as const))
    this.detach = !!options.detach
    this.whole = this.from.size === doc.objects.length && !carried.wires?.size
    if (this.detach || this.whole || !this.from.size) {
      this.plan = null
      this.relaying = () => {
        throw new Error("this drag lays no wires")
      }
      return
    }
    const sheet = this.wiring.sheet
    const pins = carriedPins(doc, carried.objects)
    const wires = new Set([...travellingWires(doc, carried.objects, this.wiring), ...(carried.wires ?? []), ...hangingRuns(sheet, pins)])
    const rects = new Map(doc.objects.filter((o) => carried.objects.has(o.id)).map((o) => [o.id, objectRect(o, GRID)] as const))
    const around = new Surroundings(doc, carried.objects, [], options.index)
    const request = {
      pins: pins.map((p) => p.key),
      wires,
      heading: (key: string) => axisAligned(sheet.pin(key)?.out),
      body: (key: string) => rects.get(objectOf(key)),
      avoid: around.avoid,
      solid: around.solid,
    }
    this.plan = planDrag(sheet, this.wiring.view, request)
    let relaying: DragPlan | null = null
    this.relaying = () => (relaying ??= planDrag(sheet, this.wiring.view, { ...request, rerouteConflicts: true }))
  }

  get stale(): boolean {
    return !!this.plan && !isCurrent(this.doc, this.wiring)
  }

  get touched(): ReadonlySet<string> {
    return this.plan?.reach ?? new Set()
  }

  frame(dx: number, dy: number): DragFrame {
    if (!this.plan || this.stale) return EMPTY_FRAME
    const key = `${dx},${dy}`
    if (this.last?.key !== key) this.last = { key, frame: this.plan.frame({ x: dx, y: dy }) }
    return this.last.frame
  }

  blocked(dx: number, dy: number): boolean {
    return this.frame(dx, dy).blocked
  }

  landed(dx: number, dy: number, newId: NewId = randomId): Landed {
    const plan = this.plan
    if (this.detach) return { doc: detachedMove(this.doc, this.from, dx, dy, newId), unlaid: [], at: { x: dx, y: dy } }
    if (!plan) return { doc: moved(this.doc, this.from, dx, dy, newId, this.wiring), unlaid: [], at: { x: dx, y: dy } }
    if (this.stale) return { doc: this.doc, unlaid: [], at: ZERO, refused: [] }
    const asked = { x: dx, y: dy }
    const clean = this.blocked(dx, dy) ? nearestWhere(asked, (p) => !this.blocked(p.x, p.y)) : asked
    const at = clean ?? asked
    if (!at.x && !at.y) return { doc: this.doc, unlaid: [], at }
    const commit = clean ? plan.commit(translate(at), newId, { keepUnlaid: true }) : this.relaying().commit(translate(at), newId, { keepUnlaid: true })
    if (!commit) return { doc: this.doc, unlaid: [], at: ZERO, refused: this.frame(dx, dy).conflicts }
    const objects = this.doc.objects.map((o) => {
      const p = this.from.get(o.id)
      return p ? { ...o, x: p.x + at.x, y: p.y + at.y } : o
    })
    const targets = new Map(commit.pins.map((p) => [`${p.at.x},${p.at.y}`, p.key] as const))
    return { doc: committed(this.doc, objects, commit, newId), unlaid: unlaidOf(commit, (p) => targets.get(`${p.x},${p.y}`)), at }
  }
}

export class SegmentDrag {
  private readonly doc: Schematic
  private readonly segment: WireSegment | undefined
  private readonly plan: DragPlan | null
  private readonly free: boolean
  private last: { key: string; frame: DragFrame } | null = null

  private readonly wiring: Wiring

  get stale(): boolean {
    return !isCurrent(this.doc, this.wiring)
  }

  get touched(): ReadonlySet<string> {
    return this.plan?.reach ?? new Set()
  }

  constructor(doc: Schematic, wiring: Wiring | undefined, segment: string, index?: SpatialIndex) {
    this.doc = doc
    const current = currentWiring(doc, wiring)
    this.wiring = current
    const sheet = current.sheet
    this.segment = sheet.segment(segment)
    const chain = this.segment ? freeChain(sheet, this.segment) : null
    this.free = chain !== null
    const around = new Surroundings(doc, new Set(), [], index)
    const wires = chain ? chain.map((s) => s.id) : [segment]
    this.plan = this.segment ? planDrag(sheet, current.view, { pins: [], wires, heading: (key) => axisAligned(sheet.pin(key)?.out), avoid: around.avoid, solid: around.solid }) : null
  }

  offsetOf(dx: number, dy: number): Point {
    if (!this.segment) return ZERO
    return this.free ? { x: snap(dx, GRID), y: snap(dy, GRID) } : normalOffset(this.segment, { x: dx, y: dy })
  }

  frame(dx: number, dy: number): DragFrame {
    if (!this.plan || this.stale) return EMPTY_FRAME
    const offset = this.offsetOf(dx, dy)
    const key = `${offset.x},${offset.y}`
    if (this.last?.key !== key) this.last = { key, frame: this.plan.frame(offset) }
    return this.last.frame
  }

  landed(dx: number, dy: number, newId: NewId = randomId): Landed {
    const plan = this.plan
    const asked = this.offsetOf(dx, dy)
    if (!plan || !this.segment || (!asked.x && !asked.y)) return { doc: this.doc, unlaid: [], at: ZERO }
    if (this.stale) return { doc: this.doc, unlaid: [], at: ZERO, refused: [] }
    const axis = this.free ? undefined : asked.x ? "x" : "y"
    const at = this.frame(dx, dy).blocked ? nearestWhere(asked, (p) => !plan.frame(p).blocked && (p.x !== 0 || p.y !== 0), 4, axis) : asked
    if (!at) return { doc: this.doc, unlaid: [], at: ZERO, refused: this.frame(dx, dy).conflicts }
    const commit = plan.commit(at, newId, { keepUnlaid: true })
    if (!commit) return { doc: this.doc, unlaid: [], at: ZERO, refused: plan.frame(at).conflicts }
    return { doc: committed(this.doc, this.doc.objects, commit, newId), unlaid: unlaidOf(commit, () => undefined), at }
  }
}

const onHalfCell = (p: Point): Point => ({ x: snap(p.x, HALF_CELL), y: snap(p.y, HALF_CELL) })

type Base = { readonly view: WireNets; readonly sheet: WireSheet }

type Shape = { readonly degrees?: number; readonly wires?: ReadonlySet<string> }

function reshaped(base: Schematic, wiring: Base, ids: ReadonlySet<string>, target: Schematic, point: (at: Point) => Point, newId: NewId, index?: SpatialIndex, shape: Shape = {}): Landed {
  const sheet = wiring.sheet
  const pins = carriedPins(base, ids)
  const after = new Map(pinsOf(target.objects.filter((o) => ids.has(o.id))).map((p) => [p.key, p] as const))
  const square = shape.degrees === undefined || shape.degrees % 90 === 0
  const hanging = hangingChains(sheet, pins)
  const tail = new Map<string, Point>()
  for (const { pin, segments } of hanging) {
    const to = after.get(pin.key)?.at ?? pin.at
    const d = { x: to.x - pin.at.x, y: to.y - pin.at.y }
    for (const s of segments) for (const p of [s.a, s.b]) tail.set(`${p.x},${p.y}`, { x: p.x + d.x, y: p.y + d.y })
  }
  const wires = new Set([...(square ? travellingIn(base, ids, wiring.view) : []), ...hanging.flatMap((h) => h.segments.map((s) => s.id)), ...(shape.wires ?? [])])
  const targetRects = target.objects.filter((o) => ids.has(o.id)).map(drawnBody)
  const around = new Surroundings(base, ids, targetRects, index)
  const request = {
    pins: pins.map((p) => p.key),
    wires,
    heading: (key: string) => axisAligned(sheet.pin(key)?.out),
    avoid: around.avoid,
    solid: around.solid,
    rerouteConflicts: true,
  }
  const move: DragMove = {
    pin: (key, at) => after.get(key)?.at ?? at,
    point: (at) => tail.get(`${at.x},${at.y}`) ?? onHalfCell(point(at)),
    heading: (key, heading) => axisAligned(after.get(key)?.out) ?? heading,
  }
  const plan = planDrag(sheet, wiring.view, request)
  const commit = plan.commit(move, newId, { keepUnlaid: true }) ?? planDrag(sheet, wiring.view, { ...request, keepFarEnds: true }).commit(move, newId, { keepUnlaid: true })
  if (!commit) return { doc: base, unlaid: [], at: ZERO, refused: plan.frame(move).conflicts }
  const targets = new Map(commit.pins.map((p) => [`${p.at.x},${p.at.y}`, p.key] as const))
  return { doc: committed(base, target.objects, commit, newId), unlaid: unlaidOf(commit, (p) => targets.get(`${p.x},${p.y}`)), at: ZERO }
}

export class TurnRun {
  private readonly start: Schematic
  private readonly live: Wiring | undefined
  private own: Base | null = null
  private readonly ids: ReadonlySet<string>
  private steps = 0
  private last: Landed

  private readonly index: SpatialIndex | undefined
  private readonly wires: ReadonlySet<string>

  constructor(doc: Schematic, wiring: Wiring | undefined, ids: ReadonlySet<string>, index?: SpatialIndex, wires: ReadonlySet<string> = new Set()) {
    this.start = doc
    this.live = wiring
    this.ids = ids
    this.index = index
    this.wires = withWholeFreeChains(this.wiring().sheet, wires)
    this.last = { doc, unlaid: [], at: ZERO }
  }

  private wiring(): Base {
    if (this.own) return this.own
    if (isCurrent(this.start, this.live)) return this.live
    const pins = pinsOf(this.start.objects)
    return (this.own = { view: new WireGraph().of(this.start.wires, pins), sheet: WireSheet.of(this.start.wires, pins) })
  }

  get base(): Schematic {
    return this.start
  }

  get doc(): Schematic {
    return this.last.doc
  }

  turned(turn: Turn, newId: NewId = randomId): Landed {
    const steps = this.steps + turn
    if (steps === 0) {
      this.steps = 0
      this.last = { doc: this.start, unlaid: [], at: ZERO }
      return this.last
    }
    const boxes = wireBoxes(this.start, this.wires)
    const pivot = turnPivot(this.start, this.ids, GRID, boxes)
    if (!pivot) return this.last
    const step = selectionStep(this.start, this.ids, this.wires.size > 0)
    const target = turnedSelection(this.start, this.ids, steps, GRID, { pivot, step })
    const degrees = steps * step
    const landed = reshaped(this.start, this.wiring(), this.ids, target, (at) => turnedAbout(at, pivot, degrees), newId, this.index, { degrees, wires: this.wires })
    if (landed.refused) return { ...this.last, refused: landed.refused }
    this.steps = steps
    this.last = landed
    return landed
  }
}

export function flippedWithWires(doc: Schematic, wiring: Wiring | undefined, ids: ReadonlySet<string>, axis: FlipAxis, newId: NewId = randomId, index?: SpatialIndex, wires: ReadonlySet<string> = new Set()): Landed {
  const base = currentWiring(doc, wiring)
  const whole = withWholeFreeChains(base.sheet, wires)
  const boxes = wireBoxes(doc, whole)
  const line = flipLine(doc, ids, axis, GRID, boxes)
  if (line === null) return { doc, unlaid: [], at: ZERO }
  const target = flipSelection(doc, ids, axis, GRID, boxes.length ? line : undefined)
  const mirrored = (at: Point): Point => (axis === "horizontal" ? { x: line - at.x, y: at.y } : { x: at.x, y: line - at.y })
  return reshaped(doc, base, ids, target, mirrored, newId, index, { wires: whole })
}

function wireBoxes(doc: Schematic, wires: ReadonlySet<string>): Rect[] {
  if (!wires.size) return []
  return doc.wires.filter((s) => wires.has(s.id)).map((s) => ({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.a.x - s.b.x), h: Math.abs(s.a.y - s.b.y) }))
}
