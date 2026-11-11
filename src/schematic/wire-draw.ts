import { GRID, objectRect, type Rect } from "./geometry"
import { footprint } from "./placement"
import type { PinRef, PlacedObject, Point, Schematic } from "./types"
import type { WireColorKey } from "./wire-colors"
import { pinToPinPoints, withSegments, type NewId, type Wiring } from "./wire-edits"
import { highOf, lowOf, samePoint, type WireSegment } from "./wires/segment"
import { columnCode, rowCode } from "./wires/sheet"
import { bodiesOf, crossedBody, segmentBox } from "./body-crossing"

export type DrawEnd =
  | { readonly kind: "pin"; readonly key: string; readonly at: Point }
  | { readonly kind: "end"; readonly at: Point }
  | { readonly kind: "wire"; readonly at: Point; readonly segment: string }
  | { readonly kind: "crossing"; readonly at: Point }
  | { readonly kind: "field"; readonly at: Point }

export type Axis = "x" | "y"

type Click = { readonly added: number; readonly axis: Axis | null; readonly flipped: boolean }

export type Drawing = {
  readonly from: DrawEnd
  readonly heading?: Point
  readonly corners: readonly Point[]
  readonly clicks: readonly Click[]
  readonly cursor: Point
  readonly axis: Axis | null
  readonly flipped: boolean
  readonly color?: WireColorKey
}

export type DrawRefusal = { readonly refused: "along" | "over" | "corner" | "crossing" | "socket" | "body" | "nothing"; readonly at: Point; readonly nets: readonly string[] }

export type DrawPreview = { readonly points: readonly Point[]; readonly refused: DrawRefusal | null; readonly routed: boolean }

export const isRefusal = (value: unknown): value is DrawRefusal => typeof value === "object" && value !== null && "refused" in value

const randomId: NewId = () => crypto.randomUUID()

export const PASTE_REFUSED = { title: "Nowhere clean to paste", why: "Every place near the paste lays a pasted wire along another net's wire or over its pin." }

export const DRAW_REFUSED: Record<DrawRefusal["refused"], { title: string; why: string }> = {
  along: { title: "Not along another net's wire", why: "A wire lying on another net's wire would join the two without saying so. End the wire on it to join them on purpose." },
  over: { title: "Not across another net's pin", why: "A wire passing over a pin would connect it. End the wire on the pin to connect it on purpose." },
  corner: { title: "No corner on another net", why: "A bend on another net's pin or wire would join the two. Place the corner on empty field." },
  crossing: { title: "Not on a crossing", why: "Two wires crossing are not connected. Use the junction tool (J) to join them there." },
  socket: { title: "Another net's wire passes this socket", why: "Ending a wire here would join that wire too. Until the wire that passes can step aside by itself, move it first." },
  body: { title: "Not through a part", why: "A wire goes round a part's body, never across it. Lay a corner beside the part." },
  nothing: { title: "No wire to lay", why: "The wire would have no length." },
}

const other = (axis: Axis): Axis => (axis === "x" ? "y" : "x")

const isEndOf = (s: WireSegment, p: Point) => samePoint(s.a, p) || samePoint(s.b, p)

export function drawEndAt(wiring: Wiring, at: Point): DrawEnd {
  const sheet = wiring.sheet
  const pin = sheet.pinsAt(at)[0]
  if (pin) return { kind: "pin", key: pin.key, at }
  const through = sheet.through(at)
  if (!through.length) return { kind: "field", at }
  const passing = through.filter((s) => !isEndOf(s, at))
  if (passing.length >= 2) return { kind: "crossing", at }
  if (passing.length === 1) return { kind: "wire", at, segment: passing[0].id }
  const ends = sheet.endsAt(at)
  return ends.length === 1 ? { kind: "end", at } : { kind: "wire", at, segment: ends[0].id }
}

const axisAligned = (p: Point | undefined) => !!p && (p.x === 0) !== (p.y === 0)

export function startDrawing(wiring: Wiring, from: DrawEnd, color?: WireColorKey): Drawing | DrawRefusal {
  if (from.kind === "crossing") return { refused: "crossing", at: from.at, nets: [] }
  const out = from.kind === "pin" ? wiring.sheet.pin(from.key)?.out : undefined
  return { from, ...(axisAligned(out) && { heading: out }), corners: [], clicks: [], cursor: from.at, axis: null, flipped: false, ...(color && { color }) }
}

const lastOf = (d: Drawing) => d.corners.at(-1) ?? d.from.at

export function pointerAt(d: Drawing, at: Point): Drawing {
  if (d.axis !== null) return { ...d, cursor: at }
  const last = lastOf(d)
  const dx = Math.abs(at.x - last.x)
  const dy = Math.abs(at.y - last.y)
  if (!dx && !dy) return { ...d, cursor: at }
  return { ...d, cursor: at, axis: dx >= dy ? "x" : "y" }
}

export const flipPosture = (d: Drawing): Drawing => ({ ...d, flipped: !d.flipped })

function firstAxis(d: Drawing, to: Point): Axis {
  const last = lastOf(d)
  let axis: Axis
  if (!d.corners.length && d.heading) {
    const along: Axis = d.heading.x !== 0 ? "x" : "y"
    const ahead = (to.x - last.x) * d.heading.x + (to.y - last.y) * d.heading.y > 0
    axis = ahead ? along : other(along)
  } else axis = d.axis ?? (Math.abs(to.x - last.x) >= Math.abs(to.y - last.y) ? "x" : "y")
  return d.flipped ? other(axis) : axis
}

function withoutRepeats(points: readonly Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) if (!out.length || !samePoint(out[out.length - 1], p)) out.push(p)
  return out
}

function pointsTo(d: Drawing, to: Point): Point[] {
  const last = lastOf(d)
  const corner = firstAxis(d, to) === "x" ? { x: to.x, y: last.y } : { x: last.x, y: to.y }
  return withoutRepeats([d.from.at, ...d.corners, corner, to])
}

export function withoutCorner(d: Drawing): Drawing {
  const click = d.clicks.at(-1)
  if (!click) return d
  return { ...d, corners: d.corners.slice(0, d.corners.length - click.added), clicks: d.clicks.slice(0, -1), axis: click.axis, flipped: click.flipped }
}

const keyOf = (key: string): PinRef => {
  const at = key.indexOf(":")
  return { object: key.slice(0, at), pin: key.slice(at + 1) }
}

function netOfEnd(wiring: Wiring, end: DrawEnd): string | undefined {
  const view = wiring.view
  if (end.kind === "pin") return view.netOfPin(end.key) ?? `pin:${end.key}`
  if (end.kind === "wire") return view.netOfSegment(end.segment) ?? `wire:${end.segment}`
  if (end.kind === "end") {
    const s = wiring.sheet.endsAt(end.at)[0]
    return s && (view.netOfSegment(s.id) ?? `wire:${s.id}`)
  }
  return undefined
}

function refusalOf(wiring: Wiring, from: DrawEnd, target: DrawEnd, points: readonly Point[]): DrawRefusal | null {
  if (target.kind === "crossing") return { refused: "crossing", at: target.at, nets: [] }
  const sheet = wiring.sheet
  const view = wiring.view
  const own = new Set([netOfEnd(wiring, from), netOfEnd(wiring, target)].filter((n): n is string => n !== undefined))
  const segmentNet = (s: WireSegment) => view.netOfSegment(s.id) ?? `wire:${s.id}`
  const pinNet = (key: string) => view.netOfPin(key) ?? `pin:${key}`
  const refuse = (refused: DrawRefusal["refused"], at: Point, net: string): DrawRefusal => ({ refused, at, nets: [...own, net] })
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const horizontal = a.y === b.y
    const line = horizontal ? rowCode(a.y) : columnCode(a.x)
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
    const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
    const on = (v: number): Point => (horizontal ? { x: v, y: a.y } : { x: a.x, y: v })
    for (const s of sheet.along(line, lo, hi)) {
      const net = segmentNet(s)
      if (!own.has(net) && Math.min(hi, highOf(s)) - Math.max(lo, lowOf(s)) > 0) return refuse("along", on(Math.max(lo, lowOf(s))), net)
    }
    for (const mark of sheet.marks(line, lo, hi)) {
      const v = horizontal ? mark.at.x : mark.at.y
      if (v <= lo || v >= hi) continue
      if (mark.segment) {
        const net = segmentNet(mark.segment)
        if (!own.has(net)) return refuse("over", mark.at, net)
      } else if (mark.pin && !mark.pin.socket) {
        const net = pinNet(mark.pin.key)
        if (!own.has(net)) return refuse("over", mark.at, net)
      }
    }
  }
  for (const end of [points[0], points[points.length - 1]]) {
    if (!sheet.pinsAt(end).some((pin) => pin.socket)) continue
    for (const s of sheet.through(end)) if (!samePoint(s.a, end) && !samePoint(s.b, end) && !own.has(segmentNet(s))) return refuse("socket", end, segmentNet(s))
  }
  const vertices = target.kind === "field" ? points.slice(1) : points.slice(1, -1)
  for (const v of vertices) {
    for (const pin of sheet.pinsAt(v)) if (!own.has(pinNet(pin.key))) return refuse("corner", v, pinNet(pin.key))
    for (const s of sheet.through(v)) if (!own.has(segmentNet(s))) return refuse("corner", v, segmentNet(s))
  }
  return null
}

const crossesRect = (a: Point, b: Point, r: Rect) => Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h

export type Near = (area: Rect) => readonly PlacedObject[]

const drawnBody = (o: PlacedObject): Rect => footprint(o, GRID)?.box ?? objectRect(o, GRID)

function crossesABody(doc: Schematic, points: readonly Point[], near?: Near): boolean {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const area = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
    for (const o of near ? near(area) : doc.objects) if (crossesRect(a, b, drawnBody(o))) return true
  }
  return false
}

const completions = new WeakMap<Schematic, Map<string, Point[] | null>>()

function routedPoints(doc: Schematic, wiring: Wiring, d: Drawing, target: DrawEnd, plain: readonly Point[], near?: Near): Point[] | null {
  if (d.from.kind !== "pin" || target.kind !== "pin" || d.corners.length) return null
  if (!crossesABody(doc, plain, near)) return null
  let known = completions.get(doc)
  if (!known) completions.set(doc, (known = new Map()))
  const key = `${d.from.key}>${target.key}`
  if (!known.has(key)) known.set(key, pinToPinPoints(doc, keyOf(d.from.key), keyOf(target.key), [], wiring))
  return known.get(key)!
}

function throughABody(doc: Schematic, points: readonly Point[], near?: Near): DrawRefusal | null {
  for (let i = 1; i < points.length; i++) {
    const s = { a: points[i - 1], b: points[i] }
    const box = segmentBox(s)
    const crossed = crossedBody(s, bodiesOf(near ? near(box) : doc.objects))
    if (crossed) return { refused: "body", at: { x: crossed.box.x + crossed.box.w / 2, y: crossed.box.y + crossed.box.h / 2 }, nets: [] }
  }
  return null
}

export function previewOf(doc: Schematic, wiring: Wiring, d: Drawing, target?: DrawEnd, near?: Near): DrawPreview {
  const end = target ?? { kind: "field", at: d.cursor }
  const plain = pointsTo(d, end.at)
  const routed = routedPoints(doc, wiring, d, end, plain, near)
  const points = routed ? withoutRepeats(routed) : plain
  const refused = refusalOf(wiring, d.from, end, points) ?? throughABody(doc, points, near)
  return { points, refused, routed: !!routed }
}

export function withCorner(doc: Schematic, wiring: Wiring, d: Drawing, at: Point): Drawing | DrawRefusal {
  const points = pointsTo(d, at)
  const refused = refusalOf(wiring, d.from, { kind: "field", at }, points) ?? throughABody(doc, points)
  if (refused) return refused
  const corners = points.slice(1)
  if (corners.length === d.corners.length) return { ...d, cursor: at }
  const last = corners.at(-1)!
  const before = points.at(-2)!
  const axis: Axis = last.y === before.y ? "y" : "x"
  return { ...d, cursor: at, corners, clicks: [...d.clicks, { added: corners.length - d.corners.length, axis: d.axis, flipped: d.flipped }], axis, flipped: false }
}

export function drawnTo(doc: Schematic, wiring: Wiring, d: Drawing, target: DrawEnd, newId: NewId = randomId, near?: Near): Schematic | DrawRefusal {
  const { points, refused } = previewOf(doc, wiring, d, target, near)
  if (refused) return refused
  if (points.length < 2) return { refused: "nothing", at: target.at, nets: [] }
  const color = d.color
  const segments: WireSegment[] = []
  for (let i = 1; i < points.length; i++) segments.push(color ? { id: newId(), a: points[i - 1], b: points[i], color } : { id: newId(), a: points[i - 1], b: points[i] })
  return withSegments(doc, segments, [], [points[0], points[points.length - 1]], newId)
}

export function laysClear(wiring: Wiring, segments: readonly { readonly a: Point; readonly b: Point }[], doc?: Schematic): boolean {
  const sheet = wiring.sheet
  for (const { a, b } of segments) {
    if (samePoint(a, b)) continue
    if (doc && throughABody(doc, [a, b])) return false
    const horizontal = a.y === b.y
    const line = horizontal ? rowCode(a.y) : columnCode(a.x)
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y)
    const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y)
    for (const s of sheet.along(line, lo, hi)) if (Math.min(hi, highOf(s)) - Math.max(lo, lowOf(s)) > 0) return false
    for (const mark of sheet.marks(line, lo, hi)) {
      const v = horizontal ? mark.at.x : mark.at.y
      if (v > lo && v < hi && (mark.segment || !mark.pin?.socket)) return false
    }
  }
  return true
}
