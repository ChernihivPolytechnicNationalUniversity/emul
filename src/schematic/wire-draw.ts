import type { Run } from "./circuit"
import { GRID, objectRect, type Rect } from "./geometry"
import { footprint } from "./placement"
import type { PinRef, PlacedObject, Point, Schematic } from "./types"
import type { WireColorKey } from "./wire-colors"
import { withSegments, type NewId, type Wiring } from "./wire-edits"
import { routeAround, runEnds, type RouteEnd } from "./wires/router"
import { along, greatestDivisor, HALF_CELL, highOf, lineOf, lowOf, pointOnLine, samePoint, type WirePin, type WireSegment } from "./wires/segment"
import { bodiesOf, bodyRefusal, crossedBody, segmentBox } from "./body-crossing"

export type DrawEnd =
  | { readonly kind: "pin"; readonly key: string; readonly at: Point }
  | { readonly kind: "end"; readonly at: Point }
  | { readonly kind: "wire"; readonly at: Point; readonly segment: string }
  | { readonly kind: "crossing"; readonly at: Point }
  | { readonly kind: "field"; readonly at: Point }

export type Axis = "x" | "y"

export type Retraction = { readonly path: readonly Point[]; readonly at: Point }

export type CutBack = { readonly run: string; readonly removed: readonly WireSegment[]; readonly kept: WireSegment | null }

type Click = { readonly added: number; readonly axis: Axis | null; readonly flipped: boolean }

export type LineMode = "90" | "45" | "any"

export const DEFAULT_LINE_MODE: LineMode = "90"

export type Drawing = {
  readonly from: DrawEnd
  readonly heading?: Point
  readonly corners: readonly Point[]
  readonly clicks: readonly Click[]
  readonly cursor: Point
  readonly axis: Axis | null
  readonly flipped: boolean
  readonly color?: WireColorKey
  readonly back?: Retraction
  readonly mode?: LineMode
}

export type DrawRefusal = { readonly refused: "along" | "over" | "corner" | "crossing" | "body" | "socket" | "nothing"; readonly at: Point; readonly nets: readonly string[]; readonly leg?: number }

export type MovedRun = { readonly run: string; readonly points: readonly Point[] }

export type DrawPreview = { readonly points: readonly Point[]; readonly refused: DrawRefusal | null; readonly routed: boolean; readonly moved: readonly MovedRun[] }

export const isRefusal = (value: unknown): value is DrawRefusal => typeof value === "object" && value !== null && "refused" in value

const randomId: NewId = () => crypto.randomUUID()

export const PASTE_REFUSED = { title: "Nowhere clean to paste", why: "The paste would lay a wire through a part's body, along another net's wire or over its pin, so nothing changed." }

export const DRAW_REFUSED: Record<DrawRefusal["refused"], { title: string; why: string }> = {
  along: { title: "Not along another net's wire", why: "A wire lying on another net's wire would join the two without saying so. End the wire on it to join them on purpose." },
  over: { title: "Not across another net's pin", why: "A wire passing over a pin would connect it. End the wire on the pin to connect it on purpose." },
  corner: { title: "No corner on another net", why: "A bend on another net's pin or wire would join the two. Place the corner on empty field." },
  crossing: { title: "Not on a crossing", why: "Two wires crossing are not connected. Use the junction tool (J) to join them there." },
  body: { title: "Not through a part", why: "A wire goes round a part's body, never across it. Lay a corner beside the part." },
  socket: { title: "Another net's wire passes this socket", why: "It has no clean way to step aside, and ending a wire here would join it. Move that wire first." },
  nothing: { title: "No wire to lay", why: "The wire would have no length." },
}

const LINE_MODES: readonly LineMode[] = ["90", "45", "any"]

const LINE_MODE_TAGS: Record<LineMode, string> = { "90": "90°", "45": "45°", any: "∠" }

export const nextLineMode = (mode: LineMode): LineMode => LINE_MODES[(LINE_MODES.indexOf(mode) + 1) % LINE_MODES.length]

export const lineModeTag = (mode: LineMode): string => LINE_MODE_TAGS[mode]

export const withLineMode = (d: Drawing, mode: LineMode): Drawing => ({ ...d, mode })

const modeOf = (d: Drawing): LineMode => d.mode ?? DEFAULT_LINE_MODE

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

function runFrom(wiring: Wiring, end: Point): { id: string; points: readonly Point[]; segments: readonly WireSegment[] } | null {
  const ends = wiring.sheet.endsAt(end)
  if (ends.length !== 1) return null
  const run = wiring.runBySegment.get(ends[0].id)
  if (!run) return null
  if (samePoint(run.points[0], end)) return run
  return { id: run.id, points: [...run.points].reverse(), segments: [...run.segments].reverse() }
}

export function startDrawing(wiring: Wiring, from: DrawEnd, color?: WireColorKey): Drawing | DrawRefusal {
  if (from.kind === "crossing") return { refused: "crossing", at: from.at, nets: [] }
  const out = from.kind === "pin" ? wiring.sheet.pin(from.key)?.out : undefined
  const run = from.kind === "end" ? runFrom(wiring, from.at) : null
  return { from, ...(axisAligned(out) && { heading: out }), corners: [], clicks: [], cursor: from.at, axis: null, flipped: false, ...(color && { color }), ...(run && { back: { path: run.points, at: from.at } }) }
}

const startOf = (d: Drawing) => d.back?.at ?? d.from.at

const lastOf = (d: Drawing) => d.corners.at(-1) ?? startOf(d)

const between = (v: number, a: number, b: number) => v >= Math.min(a, b) && v <= Math.max(a, b)

const onSegment = (p: Point, a: Point, b: Point) => (b.x - a.x) * (p.y - a.y) === (b.y - a.y) * (p.x - a.x) && between(p.x, a.x, b.x) && between(p.y, a.y, b.y)

const onPath = (path: readonly Point[], p: Point) => path.some((q, i) => (i === 0 ? samePoint(q, p) : onSegment(p, path[i - 1], q)))

const retracting = (d: Drawing): Retraction | null => (d.back && !d.corners.length ? d.back : null)

function nearestOnPath(path: readonly Point[], p: Point, grid: number): { at: Point; distance: number } {
  let best = { at: path[0], distance: Math.hypot(p.x - path[0].x, p.y - path[0].y) }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const slanted = a.x !== b.x && a.y !== b.y
    const steps = slanted ? greatestDivisor((b.x - a.x) / HALF_CELL, (b.y - a.y) / HALF_CELL) : Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / grid
    if (!steps) continue
    const length2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length2))
    const k = Math.round(t * steps)
    const at = slanted ? { x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps } : { x: a.x + (b.x - a.x) * (k / steps), y: a.y + (b.y - a.y) * (k / steps) }
    const distance = Math.hypot(p.x - a.x - (b.x - a.x) * t, p.y - a.y - (b.y - a.y) * t)
    if (distance < best.distance) best = { at, distance }
  }
  return best
}

export function backAlong(d: Drawing, pointer: Point, reach: number, grid: number = GRID): Point | null {
  const back = retracting(d)
  if (!back) return null
  const nearest = nearestOnPath(back.path, pointer, grid)
  return nearest.distance <= reach ? nearest.at : null
}

export function pointerAt(d: Drawing, at: Point): Drawing {
  const back = retracting(d)
  if (back && onPath(back.path, at)) return { ...d, cursor: at, axis: null, back: { ...back, at } }
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

function fortyFiveTo(last: Point, to: Point, flipped: boolean): Point[] {
  const dx = to.x - last.x
  const dy = to.y - last.y
  const short = Math.min(Math.abs(dx), Math.abs(dy))
  if (!short || Math.abs(dx) === Math.abs(dy)) return [to]
  const slant = { x: Math.sign(dx) * short, y: Math.sign(dy) * short }
  return [flipped ? { x: last.x + slant.x, y: last.y + slant.y } : { x: to.x - slant.x, y: to.y - slant.y }, to]
}

function legTo(d: Drawing, to: Point): Point[] {
  const last = lastOf(d)
  const mode = modeOf(d)
  if (mode === "any") return [to]
  if (mode === "45") return fortyFiveTo(last, to, d.flipped)
  return [firstAxis(d, to) === "x" ? { x: to.x, y: last.y } : { x: last.x, y: to.y }, to]
}

function pointsTo(d: Drawing, to: Point): Point[] {
  return withoutRepeats([startOf(d), ...d.corners, ...legTo(d, to)])
}

export function cutBack(wiring: Wiring, d: Drawing, newId: NewId = randomId): CutBack | null {
  const back = d.back
  if (!back || samePoint(back.at, d.from.at)) return null
  const run = runFrom(wiring, d.from.at)
  if (!run) return null
  const removed: WireSegment[] = []
  for (let i = 0; i < run.segments.length; i++) {
    const s = run.segments[i]
    const far = run.points[i + 1]
    removed.push(s)
    if (!onSegment(back.at, run.points[i], far)) continue
    if (samePoint(back.at, far)) return { run: run.id, removed, kept: null }
    const kept: WireSegment = { id: newId(), a: back.at, b: far, ...(s.color && { color: s.color }) }
    return { run: run.id, removed, kept }
  }
  return null
}

function atTheCut(wiring: Wiring, d: Drawing, end: DrawEnd): DrawEnd {
  const back = retracting(d)
  if (!back || samePoint(back.at, d.from.at) || !samePoint(end.at, back.at) || end.kind === "pin") return end
  const own = new Set(runFrom(wiring, d.from.at)?.segments.map((s) => s.id))
  const other = wiring.sheet.through(back.at).find((s) => !own.has(s.id) && !isEndOf(s, back.at))
  return other ? { kind: "wire", at: back.at, segment: other.id } : { kind: "field", at: back.at }
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

const NO_IDS: ReadonlySet<string> = new Set()

const acrossItsRow = (pin: WirePin, horizontal: boolean) => !pin.out || (horizontal ? pin.out.x === 0 : pin.out.y === 0)

function refusalOf(wiring: Wiring, from: DrawEnd, target: DrawEnd, points: readonly Point[], ignore: ReadonlySet<string> = NO_IDS): DrawRefusal | null {
  if (target.kind === "crossing") return { refused: "crossing", at: target.at, nets: [] }
  const sheet = wiring.sheet
  const view = wiring.view
  const own = new Set([netOfEnd(wiring, from), netOfEnd(wiring, target)].filter((n): n is string => n !== undefined))
  const segmentNet = (s: WireSegment) => view.netOfSegment(s.id) ?? `wire:${s.id}`
  const pinNet = (key: string) => view.netOfPin(key) ?? `pin:${key}`
  const refuse = (refused: DrawRefusal["refused"], at: Point, net: string, leg?: number): DrawRefusal => ({ refused, at, nets: [...own, net], ...(leg !== undefined && { leg }) })
  for (let i = 1; i < points.length; i++) {
    const leg = { a: points[i - 1], b: points[i] }
    const horizontal = leg.a.y === leg.b.y
    const slanted = !horizontal && leg.a.x !== leg.b.x
    const lo = lowOf(leg)
    const hi = highOf(leg)
    for (const s of sheet.alongSegment(leg)) {
      if (ignore.has(s.id)) continue
      const net = segmentNet(s)
      if (!own.has(net) && Math.min(hi, highOf(s)) - Math.max(lo, lowOf(s)) > 0) return refuse("along", pointOnLine(lineOf(leg), Math.max(lo, lowOf(s))), net, i - 1)
    }
    for (const mark of sheet.marksOn(leg)) {
      const v = along(leg, mark.at)
      if (v <= lo || v >= hi) continue
      if (mark.segment) {
        if (ignore.has(mark.segment.id)) continue
        const net = segmentNet(mark.segment)
        if (!own.has(net)) return refuse("over", mark.at, net, i - 1)
      } else if (mark.pin && (!mark.pin.socket || slanted || !!mark.pin.shunt || acrossItsRow(mark.pin, horizontal))) {
        const net = pinNet(mark.pin.key)
        if (!own.has(net)) return refuse("over", mark.at, net, i - 1)
      }
    }
  }
  const vertices = target.kind === "field" ? points.slice(1) : points.slice(1, -1)
  for (const v of vertices) {
    for (const pin of sheet.pinsAt(v)) if (!own.has(pinNet(pin.key))) return refuse("corner", v, pinNet(pin.key))
    for (const s of sheet.through(v)) if (!ignore.has(s.id) && !own.has(segmentNet(s))) return refuse("corner", v, segmentNet(s))
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

const completions = new WeakMap<Schematic, Map<string, readonly Point[] | null>>()

function completionStart(d: Drawing): RouteEnd | null {
  if (d.back && !samePoint(d.back.at, d.from.at)) return null
  const corner = d.corners.at(-1)
  if (corner) return { at: corner }
  return d.from.kind === "pin" ? { pin: keyOf(d.from.key) } : { at: d.from.at }
}

function pointsBehind(drawn: readonly Point[]): Point[] {
  const behind: Point[] = []
  for (let i = 1; i < drawn.length; i++) {
    const a = drawn[i - 1]
    const b = drawn[i]
    const steps = (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / HALF_CELL
    for (let k = 0; k < steps; k++) behind.push({ x: a.x + Math.sign(b.x - a.x) * HALF_CELL * k, y: a.y + Math.sign(b.y - a.y) * HALF_CELL * k })
  }
  return behind
}

function completion(doc: Schematic, wiring: Wiring, d: Drawing, start: RouteEnd, to: RouteEnd, ignore: ReadonlySet<string>): readonly Point[] | null {
  let known = completions.get(doc)
  if (!known) completions.set(doc, (known = new Map()))
  const drawn = [startOf(d), ...d.corners]
  const target = "pin" in to ? `${to.pin.object}:${to.pin.pin}` : `@${to.at.x},${to.at.y}`
  const key = `${drawn.map((p) => `${p.x},${p.y}`).join(" ")}>${target}|${[...ignore].join(" ")}`
  if (!known.has(key)) {
    const route = routeAround(wiring, start, to, { ignore, stops: pointsBehind(drawn) })
    known.set(key, route && withoutRepeats([...drawn.slice(0, -1), ...route]))
  }
  return known.get(key)!
}

function passingRuns(wiring: Wiring, from: DrawEnd, target: DrawEnd): Run[] {
  const own = new Set([netOfEnd(wiring, from), netOfEnd(wiring, target)].filter((n): n is string => n !== undefined))
  const found = new Map<string, Run>()
  for (const end of [from, target]) {
    if (end.kind !== "pin" || !wiring.sheet.pinsAt(end.at).some((pin) => pin.socket)) continue
    for (const s of wiring.sheet.through(end.at)) {
      if (isEndOf(s, end.at) || own.has(wiring.view.netOfSegment(s.id) ?? `wire:${s.id}`)) continue
      const run = wiring.runBySegment.get(s.id)
      if (run) found.set(run.id, run)
    }
  }
  return [...found.values()]
}

const piecesOf = (points: readonly Point[], id: string): WireSegment[] => points.slice(1).map((b, i) => ({ id: `${id}:${i}`, a: points[i], b }))

type Moved = { readonly run: Run; readonly points: readonly Point[] }

type Plan = Omit<DrawPreview, "moved"> & { readonly moved: readonly Moved[] }

function throughABody(doc: Schematic, points: readonly Point[], near?: Near): DrawRefusal | null {
  for (let i = 1; i < points.length; i++) {
    const s = { a: points[i - 1], b: points[i] }
    const box = segmentBox(s)
    const crossed = crossedBody(s, bodiesOf(near ? near(box) : doc.objects))
    if (crossed) return { refused: "body", at: { x: crossed.box.x + crossed.box.w / 2, y: crossed.box.y + crossed.box.h / 2 }, nets: [], leg: i - 1 }
  }
  return null
}

function planOf(doc: Schematic, wiring: Wiring, d: Drawing, target?: DrawEnd, near?: Near): Plan {
  const end = atTheCut(wiring, d, target ?? { kind: "field", at: d.cursor })
  const passing = passingRuns(wiring, d.from, end)
  const ignore = passing.length ? new Set(passing.flatMap((run) => run.segments.map((s) => s.id))) : NO_IDS
  const refusalFor = (points: readonly Point[]) => refusalOf(wiring, d.from, end, points, ignore) || throughABody(doc, points, near)
  let points: readonly Point[] = pointsTo(d, end.at)
  let refused = refusalFor(points)
  let routed = false
  const start = completionStart(d)
  const fromASocket = d.from.kind === "pin" && wiring.sheet.pinsAt(d.from.at).some((pin) => pin.socket)
  const routeEnd: RouteEnd | null = end.kind === "pin" ? { pin: keyOf(end.key) } : end.kind === "field" && fromASocket ? { at: end.at } : null
  if (modeOf(d) === "90" && start && routeEnd && (refused || crossesABody(doc, points, near))) {
    const route = completion(doc, wiring, d, start, routeEnd, ignore)
    if (route) {
      points = route
      refused = refusalFor(points)
      routed = true
    }
  }
  if (refused || !passing.length) return { points, refused, routed, moved: [] }
  const moved: Moved[] = []
  let around = piecesOf(points, "drawn")
  for (const run of passing) {
    const [from, to] = runEnds(wiring, run.points)
    const route = routeAround(wiring, from, to, { ignore, extra: around })
    const socket = [d.from.at, end.at].find((p) => run.segments.some((s) => !isEndOf(s, p) && onSegment(p, s.a, s.b)))!
    if (!route) return { points, refused: { refused: "socket", at: socket, nets: [wiring.view.netOfSegment(run.segments[0].id) ?? `wire:${run.segments[0].id}`] }, routed, moved: [] }
    moved.push({ run, points: route })
    around = [...around, ...piecesOf(route, run.id)]
  }
  return { points, refused: null, routed, moved }
}

export function previewOf(doc: Schematic, wiring: Wiring, d: Drawing, target?: DrawEnd, near?: Near): DrawPreview {
  const { points, refused, routed, moved } = planOf(doc, wiring, d, target, near)
  return { points, refused, routed, moved: moved.map((m) => ({ run: m.run.id, points: m.points })) }
}

export function withCorner(doc: Schematic, wiring: Wiring, d: Drawing, at: Point): Drawing | DrawRefusal {
  const plain = pointsTo(d, at)
  const refusedPlain = refusalOf(wiring, d.from, { kind: "field", at }, plain) ?? throughABody(doc, plain)
  const plan = refusedPlain ? planOf(doc, wiring, d, { kind: "field", at }) : null
  const routed = plan && plan.routed && !plan.refused && !plan.moved.length
  if (refusedPlain && !routed) return refusedPlain
  const points = routed ? plan.points : plain
  const corners = points.slice(1)
  if (corners.length === d.corners.length) return { ...d, cursor: at }
  const last = corners.at(-1)!
  const before = points.at(-2)!
  const axis: Axis | null = last.y === before.y ? "y" : last.x === before.x ? "x" : null
  return { ...d, cursor: at, corners, clicks: [...d.clicks, { added: corners.length - d.corners.length, axis: d.axis, flipped: d.flipped }], axis, flipped: false }
}

export function drawnTo(doc: Schematic, wiring: Wiring, d: Drawing, target: DrawEnd, newId: NewId = randomId, near?: Near): Schematic | DrawRefusal {
  const back = retracting(d)
  const drawing = back && onPath(back.path, target.at) ? pointerAt(d, target.at) : d
  const { points, refused, moved } = planOf(doc, wiring, drawing, target, near)
  if (refused) return refused
  const cut = cutBack(wiring, drawing, newId)
  if (drawing.back && !samePoint(drawing.back.at, drawing.from.at) && !cut) return { refused: "nothing", at: target.at, nets: [] }
  if (points.length < 2 && !cut) return { refused: "nothing", at: target.at, nets: [] }
  const color = d.color
  const segments: WireSegment[] = cut?.kept ? [cut.kept] : []
  const removed: WireSegment[] = [...(cut?.removed ?? [])]
  const ends: Point[] = [points[0], points[points.length - 1]]
  const lay = (along: readonly Point[], colour: WireColorKey | undefined) => {
    for (let i = 1; i < along.length; i++) segments.push(colour ? { id: newId(), a: along[i - 1], b: along[i], color: colour } : { id: newId(), a: along[i - 1], b: along[i] })
  }
  lay(points, color)
  for (const { run, points: route } of moved) {
    removed.push(...run.segments)
    lay(route, run.segments[0].color)
    ends.push(route[0], route[route.length - 1])
  }
  const result = withSegments(doc, segments, removed, ends, newId)
  return bodyRefusal(doc, result) ?? result
}

export function laysClear(wiring: Wiring, segments: readonly { readonly a: Point; readonly b: Point }[], doc?: Schematic): boolean {
  const sheet = wiring.sheet
  for (const { a, b } of segments) {
    if (samePoint(a, b)) continue
    if (doc && throughABody(doc, [a, b])) return false
    const leg = { a, b }
    const lo = lowOf(leg)
    const hi = highOf(leg)
    for (const s of sheet.alongSegment(leg)) if (Math.min(hi, highOf(s)) - Math.max(lo, lowOf(s)) > 0) return false
    for (const mark of sheet.marksOn(leg)) {
      const v = along(leg, mark.at)
      if (v > lo && v < hi && (mark.segment || !mark.pin?.socket)) return false
    }
  }
  return true
}
