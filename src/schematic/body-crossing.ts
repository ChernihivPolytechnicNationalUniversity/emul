import { GRID, type Point, type Rect } from "./geometry"
import { footprints, type Lead } from "./placement"
import { pinsForObject } from "./pin-index"
import { getDef } from "./registry"
import { BoxIndex } from "./spatial"
import type { PlacedObject, Schematic } from "./types"
import type { Closed } from "./wires/clear-path"
import { contains, crossingOf, segmentsMeet, type WirePin } from "./wires/segment"

const EPS = 1e-6

const PART_REACH_CELLS = 128

type Segment = { readonly a: Point; readonly b: Point }

export type Body = { object: PlacedObject; contour: readonly (readonly Point[])[]; leads: readonly Lead[]; pins: readonly WirePin[]; box: Rect }

const judged = (o: PlacedObject) => {
  const def = getDef(o.def)
  return !!def && !def.pins.every((p) => p.kind === "node")
}

const bodyCache = new WeakMap<PlacedObject, { def: ReturnType<typeof getDef>; body: Body }>()

export function bodiesOf(objects: readonly PlacedObject[]): Body[] {
  return objects.filter(judged).flatMap((object): Body[] => {
    const def = getDef(object.def)
    const cached = bodyCache.get(object)
    if (cached && cached.def === def) return [cached.body]
    const f = footprints(object, GRID)
    if (!f) return []
    const pins = pinsForObject(object)
    const points = [...f.contour.flatMap((q) => q.corners), ...f.leads.flat(), ...pins.map((p) => p.at)]
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    const body = { object, contour: f.outline, leads: f.leads, pins, box }
    bodyCache.set(object, { def, body })
    return [body]
  })
}

function insideOf(s: Segment, corners: readonly Point[]): readonly [number, number] | null {
  let lo = 0
  let hi = 1
  const d = { x: s.b.x - s.a.x, y: s.b.y - s.a.y }
  const sign = Math.sign(corners.reduce((sum, p, i) => {
    const q = corners[(i + 1) % corners.length]
    return sum + (p.x * q.y - q.x * p.y)
  }, 0))
  for (let i = 0; i < corners.length; i++) {
    const p = corners[i]
    const q = corners[(i + 1) % corners.length]
    const inward = { x: -(q.y - p.y) * sign, y: (q.x - p.x) * sign }
    const start = (s.a.x - p.x) * inward.x + (s.a.y - p.y) * inward.y
    const rate = d.x * inward.x + d.y * inward.y
    if (Math.abs(rate) < EPS) {
      if (start <= EPS) return null
      continue
    }
    const t = -start / rate
    if (rate > 0) lo = Math.max(lo, t)
    else hi = Math.min(hi, t)
    if (hi - lo <= EPS) return null
  }
  return [lo, hi]
}

const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS

function crossingIntervals(s: Segment, body: Body): [number, number][] {
  const length = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)
  const slack = EPS / Math.max(length, EPS)
  const exitsAt = (at: Point, towards: Point) => body.pins.some((p) => samePoint(p.at, at) && p.out && (towards.x - at.x) * p.out.x + (towards.y - at.y) * p.out.y > EPS)
  return body.contour.flatMap((corners): [number, number][] => {
    const inside = insideOf(s, corners)
    if (!inside) return []
    const [lo, hi] = inside
    const fromPinA = lo <= slack && hi < 1 - slack && exitsAt(s.a, s.b)
    const fromPinB = hi >= 1 - slack && lo > slack && exitsAt(s.b, s.a)
    return fromPinA || fromPinB ? [] : [[lo, hi]]
  })
}

export function runsThrough(s: Segment, body: Body): boolean {
  const length = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)
  const slack = EPS / Math.max(length, EPS)
  const exitsAt = (at: Point, towards: Point) => body.pins.some((p) => samePoint(p.at, at) && p.out && (towards.x - at.x) * p.out.x + (towards.y - at.y) * p.out.y > EPS)
  return body.contour.some((corners) => {
    const inside = insideOf(s, corners)
    if (!inside) return false
    const [lo, hi] = inside
    const fromPinA = lo <= slack && hi < 1 - slack && exitsAt(s.a, s.b)
    const fromPinB = hi >= 1 - slack && lo > slack && exitsAt(s.b, s.a)
    return !fromPinA && !fromPinB
  })
}

export const crossable = (body: Body): boolean => !getDef(body.object.def)?.pinsAreSockets

export const segmentBox = (s: Segment): Rect => ({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.b.x - s.a.x), h: Math.abs(s.b.y - s.a.y) })

export const boxesMeet = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h

export function shiftedBody(body: Body, dx: number, dy: number): Body {
  if (!dx && !dy) return body
  const move = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy })
  return {
    object: body.object,
    contour: body.contour.map((corners) => corners.map(move)),
    leads: body.leads.map(([p, q]) => [move(p), move(q)] as const),
    pins: body.pins.map((p) => ({ ...p, at: move(p.at) })),
    box: { ...body.box, x: body.box.x + dx, y: body.box.y + dy },
  }
}

function liesOn(p: Point, s: Segment): boolean {
  const cross = (s.b.x - s.a.x) * (p.y - s.a.y) - (s.b.y - s.a.y) * (p.x - s.a.x)
  if (Math.abs(cross) > EPS * Math.max(1, Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y))) return false
  return p.x >= Math.min(s.a.x, s.b.x) - EPS && p.x <= Math.max(s.a.x, s.b.x) + EPS && p.y >= Math.min(s.a.y, s.b.y) - EPS && p.y <= Math.max(s.a.y, s.b.y) + EPS
}

const twoTerminal = (body: Body) => getDef(body.object.def)?.pins.length === 2 && body.pins.length === 2

export type SpliceSpan = { readonly horizontal: boolean; readonly line: number; readonly lo: number; readonly hi: number }

export function spliceSpan(body: Body, near: readonly Segment[]): SpliceSpan | null {
  if (!twoTerminal(body)) return null
  const [p, q] = body.pins.map((pin) => pin.at)
  const horizontal = Math.abs(p.y - q.y) < EPS
  if (!horizontal && Math.abs(p.x - q.x) >= EPS) return null
  const line = horizontal ? p.y : p.x
  const across = (pt: Point) => (horizontal ? pt.y : pt.x)
  const coord = (pt: Point) => (horizontal ? pt.x : pt.y)
  const lo = Math.min(coord(p), coord(q))
  const hi = Math.max(coord(p), coord(q))
  const onLine = near.filter((w) => Math.abs(across(w.a) - line) < EPS && Math.abs(across(w.b) - line) < EPS)
  let reach = lo
  for (const [a, b] of onLine.map((w) => [Math.min(coord(w.a), coord(w.b)), Math.max(coord(w.a), coord(w.b))]).sort((u, v) => u[0] - v[0])) if (a <= reach + EPS && b > reach) reach = b
  if (reach < hi - EPS) return null
  const inside = (e: Point) => Math.abs(across(e) - line) < EPS && coord(e) > lo + EPS && coord(e) < hi - EPS
  if (near.some((w) => !onLine.includes(w) && (inside(w.a) || inside(w.b)))) return null
  return { horizontal, line, lo, hi }
}

const withinSpan = (piece: Segment, span: SpliceSpan) => {
  const across = (pt: Point) => (span.horizontal ? pt.y : pt.x)
  const coord = (pt: Point) => (span.horizontal ? pt.x : pt.y)
  return [piece.a, piece.b].every((e) => Math.abs(across(e) - span.line) < EPS && coord(e) >= span.lo - EPS && coord(e) <= span.hi + EPS)
}

export function staysThrough(s: Segment, body: Body, span: SpliceSpan | null = null): boolean {
  const along = (p: Point) => (p.x - s.a.x) * (s.b.x - s.a.x) + (p.y - s.a.y) * (s.b.y - s.a.y)
  const on = body.pins.filter((p) => liesOn(p.at, s)).map((p) => p.at)
  const cuts = [s.a, ...on, s.b].sort((p, q) => along(p) - along(q))
  for (let i = 1; i < cuts.length; i++) {
    const piece = { a: cuts[i - 1], b: cuts[i] }
    if (samePoint(piece.a, piece.b) || (span && withinSpan(piece, span))) continue
    if (runsThrough(piece, body)) return true
  }
  return false
}

function touchesLead(s: Segment, [pin, inner]: Lead): boolean {
  const lead = { a: pin, b: inner }
  if (!segmentsMeet(s, lead)) return false
  const at = crossingOf(s, lead)
  if (at) return !samePoint(at, pin)
  const fromThePin = (end: Point, other: Point) => samePoint(end, pin) && !contains(lead, other)
  return !fromThePin(s.a, s.b) && !fromThePin(s.b, s.a)
}

export function closedBodies(objects: readonly PlacedObject[]): Closed[] {
  return bodiesOf(objects)
    .filter(crossable)
    .map((body) => ({ box: body.box, blocks: (a: Point, b: Point) => runsThrough({ a, b }, body) || body.leads.some((lead) => touchesLead({ a, b }, lead)) }))
}

export function crossedBody(s: Segment, bodies: Iterable<Body>): Body | null {
  const box = segmentBox(s)
  for (const body of bodies) if (crossable(body) && boxesMeet(body.box, box) && runsThrough(s, body)) return body
  return null
}

export type BodyRefusal = { readonly refused: "body"; readonly at: Point; readonly nets: readonly [string, string] }

const geometryOf = (body: Body) => JSON.stringify(body.contour.map((polygon) => polygon.map((p) => [Math.round(p.x / EPS), Math.round(p.y / EPS)]).sort()).sort())

function crossingSpans(s: Segment, body: Body): Segment[] {
  const pointAt = (t: number): Point => ({ x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t })
  return crossingIntervals(s, body).map(([lo, hi]) => ({ a: pointAt(lo), b: pointAt(hi) }))
}

function coveredBy(span: Segment, old: readonly Segment[]): boolean {
  const dx = span.b.x - span.a.x
  const dy = span.b.y - span.a.y
  const length = Math.hypot(dx, dy)
  const along = (p: Point) => ((p.x - span.a.x) * dx + (p.y - span.a.y) * dy) / length
  const onLine = (p: Point) => Math.abs((p.x - span.a.x) * dy - (p.y - span.a.y) * dx) <= EPS * length
  const intervals = old.filter((s) => onLine(s.a) && onLine(s.b)).map((s) => [Math.min(along(s.a), along(s.b)), Math.max(along(s.a), along(s.b))]).sort((a, b) => a[0] - b[0])
  let reach = 0
  for (const [lo, hi] of intervals) {
    if (lo > reach + EPS) break
    reach = Math.max(reach, hi)
    if (reach >= length - EPS) return true
  }
  return false
}

const unionBox = (boxes: readonly Rect[]): Rect | null => {
  if (!boxes.length) return null
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y }
}

export type Touched = { readonly wires: readonly Segment[]; readonly objects: ReadonlySet<string>; readonly coversChecked: boolean }

export function bodyRefusal(before: Schematic, after: Schematic, touched?: Touched): BodyRefusal | null {
  if (before === after || !after.wires.length) return null
  const meets = (w: Segment, r: Rect) => Math.max(w.a.x, w.b.x) >= r.x && Math.min(w.a.x, w.b.x) <= r.x + r.w && Math.max(w.a.y, w.b.y) >= r.y && Math.min(w.a.y, w.b.y) <= r.y + r.h
  const keptWires = touched ? null : new Set(before.wires)
  const keptObjects = touched ? null : new Set(before.objects)
  const freshWires: readonly Segment[] = touched ? touched.wires : after.wires.filter((w) => !keptWires!.has(w))
  const freshBodies = bodiesOf(after.objects.filter((o) => (keptObjects ? !keptObjects.has(o) : touched!.objects.has(o.id)))).filter(crossable)
  if (!freshWires.length && !freshBodies.length) return null
  const previous = new Map<string, Segment[]>()
  let oldBodies: Body[] | undefined
  let oldWires: BoxIndex<Schematic["wires"][number]> | undefined
  const oldSpans = (body: Body) => {
    const key = geometryOf(body)
    let spans = previous.get(key)
    if (spans) return spans
    oldBodies ??= bodiesOf(before.objects).filter(crossable)
    oldWires ??= new BoxIndex(before.wires, segmentBox, 16 * GRID)
    spans = []
    for (const old of oldBodies) {
      if (!boxesMeet(old.box, body.box) || geometryOf(old) !== key) continue
      oldWires.some(old.box, (wire) => {
        spans!.push(...crossingSpans(wire, old))
        return false
      })
    }
    previous.set(key, spans)
    return spans
  }
  const refusalFor = (wire: Segment & { readonly id?: string }, body: Body): BodyRefusal | null => {
    if (!boxesMeet(body.box, segmentBox(wire))) return null
    const spans = crossingSpans(wire, body)
    if (!spans.some((span) => !coveredBy(span, oldSpans(body)))) return null
    return { refused: "body", at: { x: body.box.x + body.box.w / 2, y: body.box.y + body.box.h / 2 }, nets: [wire.id ?? "", body.object.id] }
  }
  const wiresArea = unionBox(freshWires.map(segmentBox))
  if (wiresArea) {
    const reach = PART_REACH_CELLS * GRID
    const close = (o: PlacedObject) => o.x <= wiresArea.x + wiresArea.w && o.x + reach >= wiresArea.x && o.y <= wiresArea.y + wiresArea.h && o.y + reach >= wiresArea.y
    const kept = (o: PlacedObject) => (keptObjects ? keptObjects.has(o) : !touched!.objects.has(o.id))
    const near = bodiesOf(after.objects.filter((o) => close(o) && kept(o))).filter((b) => crossable(b) && boxesMeet(b.box, wiresArea))
    for (const wire of freshWires) for (const body of [...near, ...freshBodies]) {
      const refused = refusalFor(wire, body)
      if (refused) return refused
    }
  }
  const bodiesArea = touched?.coversChecked ? null : unionBox(freshBodies.map((b) => b.box))
  if (bodiesArea) {
    const fresh = new Set(freshWires)
    for (const wire of after.wires) {
      if (!meets(wire, bodiesArea) || fresh.has(wire)) continue
      for (const body of freshBodies) {
        const refused = refusalFor(wire, body)
        if (refused) return refused
      }
    }
  }
  return null
}
