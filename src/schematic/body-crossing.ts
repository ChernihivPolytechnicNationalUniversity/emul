import { GRID, type Point, type Rect } from "./geometry"
import { footprints, type Lead } from "./placement"
import { pinsForObject } from "./pin-index"
import { getDef } from "./registry"
import type { PlacedObject } from "./types"
import type { Closed } from "./wires/clear-path"
import { contains, crossingOf, segmentsMeet, type WirePin } from "./wires/segment"

const EPS = 1e-6

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

export function runsThrough(s: Segment, body: Body) {
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
