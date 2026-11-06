import { placedFields, type PlacedField } from "./fields"
import { GRID, objectRect, type Point, type Rect } from "./geometry"
import { footprints, type Lead } from "./placement"
import { pinsForObject, translationOf } from "./pin-index"
import { getDef, pinName } from "./registry"
import type { PlacedObject, Schematic } from "./types"
import { wireOrder, wiringOf, type Wiring } from "./wire-edits"
import { WireGraph } from "./wires/graph"
import type { WireSegment } from "./wires/segment"

export const NO_CONNECT = "no-connect"

export type CheckKind = "dangling-end" | "unconnected-pin" | "four-way" | "wire-through-body" | "field-on-wire" | "field-on-body" | "fields-overlap" | "parallel-too-close"

export const CHECK_KINDS: readonly CheckKind[] = ["dangling-end", "unconnected-pin", "four-way", "wire-through-body", "field-on-wire", "field-on-body", "fields-overlap", "parallel-too-close"]

export type CheckLevel = "warning" | "note"

export const LEVEL_OF: Record<CheckKind, CheckLevel> = {
  "dangling-end": "warning",
  "unconnected-pin": "warning",
  "wire-through-body": "warning",
  "four-way": "note",
  "field-on-wire": "note",
  "field-on-body": "note",
  "fields-overlap": "note",
  "parallel-too-close": "note",
}

export type Finding = { kind: CheckKind; at: Point; objects: readonly string[]; segments: readonly string[]; text: string; pin?: string }

const HALF = GRID / 2
const EPS = 1e-6

const keyOf = (p: Point) => `${p.x},${p.y}`

const isMark = (o: PlacedObject) => o.def === NO_CONNECT

const markAt = (o: PlacedObject): Point => ({ x: o.x + GRID, y: o.y + GRID })

const middleOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

const refOf = (o: PlacedObject) => o.props?.ref || getDef(o.def)?.name || o.id

const axesOf = new WeakMap<readonly Point[], readonly Point[]>()

function edgesOf(points: readonly Point[]): readonly Point[] {
  const cached = axesOf.get(points)
  if (cached) return cached
  const axes: Point[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    if (p.x !== q.x || p.y !== q.y) axes.push({ x: -(q.y - p.y), y: q.x - p.x })
  }
  axesOf.set(points, axes)
  return axes
}

function overlapping(a: readonly Point[], b: readonly Point[]) {
  for (const axes of [edgesOf(a), edgesOf(b)]) for (const axis of axes) {
    let alo = Infinity
    let ahi = -Infinity
    let blo = Infinity
    let bhi = -Infinity
    for (const p of a) { const v = p.x * axis.x + p.y * axis.y; alo = Math.min(alo, v); ahi = Math.max(ahi, v) }
    for (const p of b) { const v = p.x * axis.x + p.y * axis.y; blo = Math.min(blo, v); bhi = Math.max(bhi, v) }
    const slack = EPS * Math.hypot(axis.x, axis.y)
    if (ahi <= blo + slack || bhi <= alo + slack) return false
  }
  return true
}

const boxCorners = new WeakMap<Rect, readonly Point[]>()

function cornersOf(r: Rect): readonly Point[] {
  let corners = boxCorners.get(r)
  if (!corners) boxCorners.set(r, corners = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }])
  return corners
}

const boxOfSegment = (s: WireSegment): Rect => ({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.b.x - s.a.x), h: Math.abs(s.b.y - s.a.y) })

const boxesMeet = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h

const boxesOverlap = (a: Rect, b: Rect) => a.x + a.w > b.x + EPS && b.x + b.w > a.x + EPS && a.y + a.h > b.y + EPS && b.y + b.h > a.y + EPS

const wireCrossesBox = (s: Pick<WireSegment, "a" | "b">, box: Rect) => s.a.y === s.b.y
  ? s.a.y > box.y + EPS && s.a.y < box.y + box.h - EPS && Math.max(s.a.x, s.b.x) > box.x + EPS && Math.min(s.a.x, s.b.x) < box.x + box.w - EPS
  : s.a.x > box.x + EPS && s.a.x < box.x + box.w - EPS && Math.max(s.a.y, s.b.y) > box.y + EPS && Math.min(s.a.y, s.b.y) < box.y + box.h - EPS

const contourBoxes = new WeakMap<readonly Point[], Rect | null>()

function fieldCrossesContour(box: Rect, contour: readonly Point[]) {
  let rectangle = contourBoxes.get(contour)
  if (rectangle === undefined) {
    rectangle = null
    if (contour.length === 4 && contour.every((p, i) => p.x === contour[(i + 1) % 4].x || p.y === contour[(i + 1) % 4].y)) {
      const x = Math.min(...contour.map((p) => p.x))
      const y = Math.min(...contour.map((p) => p.y))
      rectangle = { x, y, w: Math.max(...contour.map((p) => p.x)) - x, h: Math.max(...contour.map((p) => p.y)) - y }
    }
    contourBoxes.set(contour, rectangle)
  }
  return rectangle ? boxesOverlap(box, rectangle) : overlapping(cornersOf(box), contour)
}

const fieldCrossesLead = (box: Rect, lead: Lead) => lead[0].x === lead[1].x || lead[0].y === lead[1].y
  ? wireCrossesBox({ a: lead[0], b: lead[1] }, box)
  : overlapping(cornersOf(box), lead)

const holds = (r: Rect, p: Point) => p.x > r.x + EPS && p.x < r.x + r.w - EPS && p.y > r.y + EPS && p.y < r.y + r.h - EPS

export class Buckets<T> {
  private readonly cells = new Map<string, Set<T>>()
  private readonly size: number
  constructor(size: number) {
    this.size = size
  }
  private keys(r: Rect) {
    const keys: string[] = []
    for (let i = Math.floor(r.x / this.size); i <= Math.floor((r.x + r.w) / this.size); i++)
      for (let j = Math.floor(r.y / this.size); j <= Math.floor((r.y + r.h) / this.size); j++) keys.push(`${i},${j}`)
    return keys
  }
  add(r: Rect, item: T) {
    for (const key of this.keys(r)) {
      const cell = this.cells.get(key)
      if (cell) cell.add(item)
      else this.cells.set(key, new Set([item]))
    }
  }
  clear() { this.cells.clear() }
  remove(r: Rect, item: T) {
    for (const key of this.keys(r)) {
      const cell = this.cells.get(key)
      cell?.delete(item)
      if (!cell?.size) this.cells.delete(key)
    }
  }
  near(r: Rect): Set<T> {
    const found = new Set<T>()
    for (const key of this.keys(r)) for (const item of this.cells.get(key) ?? []) found.add(item)
    return found
  }
}

const BUCKET = 16 * GRID

type Body = { object: PlacedObject; contour: readonly (readonly Point[])[]; leads: readonly Lead[]; pins: readonly Point[]; box: Rect }

const judged = (o: PlacedObject) => {
  const def = getDef(o.def)
  return !!def && !isMark(o) && !def.pinsAreSockets && !def.pins.every((p) => p.kind === "node")
}

const bodyCache = new WeakMap<PlacedObject, { def: ReturnType<typeof getDef>; body: Body }>()

function bodiesOf(objects: readonly PlacedObject[]): Body[] {
  return objects.filter(judged).flatMap((object): Body[] => {
    const def = getDef(object.def)
    const cached = bodyCache.get(object)
    if (cached && cached.def === def) return [cached.body]
    const f = footprints(object, GRID)
    if (!f) return []
    const pins = pinsForObject(object).map((p) => p.at)
    const points = [...f.contour.flatMap((q) => q.corners), ...f.leads.flat(), ...pins]
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    const body = { object, contour: f.outline, leads: f.leads, pins, box }
    bodyCache.set(object, { def, body })
    return [body]
  })
}

function danglingEnds(doc: Schematic, wiring: Wiring, marked: ReadonlySet<string>): Finding[] {
  const endsAt = new Map<string, string[]>()
  for (const s of doc.wires) for (const p of [s.a, s.b]) endsAt.set(keyOf(p), [...(endsAt.get(keyOf(p)) ?? []), s.id])
  return wiring.dangling.filter((p) => !marked.has(keyOf(p))).map((at) => ({ kind: "dangling-end", at, objects: [], segments: endsAt.get(keyOf(at)) ?? [], text: "A wire end that meets nothing" }))
}

function unconnectedPins(doc: Schematic, wiring: Wiring, marked: ReadonlySet<string>): Finding[] {
  const found: Finding[] = []
  for (const o of doc.objects) {
    const def = getDef(o.def)
    if (!def || !def.model?.length || def.pinsAreSockets || def.chip || isMark(o)) continue
    for (const pin of def.pins) {
      if (pin.kind === "nc" || pin.kind === "node") continue
      const key = `${o.id}:${pin.id}`
      const placed = wiring.index.pin(key)
      if (!placed || marked.has(keyOf(placed.at))) continue
      const net = wiring.view.netOfPin(key)
      const alone = !net || (wiring.view.pinsOf(net).length <= 1 && wiring.view.segmentsOf(net).length === 0)
      if (alone) found.push({ kind: "unconnected-pin", at: placed.at, objects: [o.id], segments: [], pin: pin.id, text: `${pinName(doc.objects as PlacedObject[], { object: o.id, pin: pin.id })} is not connected` })
    }
  }
  return found
}

function fourWays(doc: Schematic, wiring: Wiring): Finding[] {
  const count = new Map<string, { at: Point; n: number; segments: string[]; objects: Set<string> }>()
  const bump = (at: Point) => {
    const key = keyOf(at)
    let c = count.get(key)
    if (!c) count.set(key, (c = { at, n: 0, segments: [], objects: new Set() }))
    c.n++
    return c
  }
  for (const s of doc.wires) for (const p of [s.a, s.b]) bump(p).segments.push(s.id)
  for (const p of wiring.activePins) bump(p.at).objects.add(p.key.slice(0, p.key.indexOf(":")))
  return [...count.values()].filter((c) => c.n >= 4).map((c) => ({ kind: "four-way", at: c.at, objects: [...c.objects].sort((a, b) => doc.objects.findIndex((o) => o.id === a) - doc.objects.findIndex((o) => o.id === b)), segments: c.segments, text: `${c.n} conductors meet at one point: two T's read more clearly` }))
}

function insideOf(s: WireSegment, corners: readonly Point[]): readonly [number, number] | null {
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

function runsThrough(s: WireSegment, body: Body) {
  const length = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)
  const slack = EPS / Math.max(length, EPS)
  return body.contour.some((corners) => {
    const inside = insideOf(s, corners)
    if (!inside) return false
    const [lo, hi] = inside
    const fromPinA = lo <= slack && hi < 1 - slack && body.pins.some((p) => samePoint(p, s.a))
    const fromPinB = hi >= 1 - slack && lo > slack && body.pins.some((p) => samePoint(p, s.b))
    return !fromPinA && !fromPinB
  })
}

function wiresThroughBodies(doc: Schematic, bodies: readonly Body[]): Finding[] {
  const near = new Buckets<Body>(BUCKET)
  for (const b of bodies) near.add(b.box, b)
  const found: Finding[] = []
  for (const s of doc.wires) {
    for (const body of near.near(boxOfSegment(s))) {
      if (!boxesMeet(body.box, boxOfSegment(s))) continue
      if (runsThrough(s, body)) found.push({ kind: "wire-through-body", at: middleOf(boxOfSegment(s)), objects: [body.object.id], segments: [s.id], text: `A wire runs through ${refOf(body.object)}` })
    }
  }
  return found
}

function fieldFindings(doc: Schematic, bodies: readonly Body[]): Finding[] {
  const fields = doc.objects.filter((o) => !isMark(o)).flatMap((o) => placedFields(o, GRID))
  const wires = new Buckets<WireSegment>(BUCKET)
  for (const s of doc.wires) wires.add(boxOfSegment(s), s)
  const near = new Buckets<Body>(BUCKET)
  for (const b of bodies) near.add(b.box, b)
  const byObject = new Map(doc.objects.map((o) => [o.id, o]))
  const found: Finding[] = []
  const named = (f: PlacedField) => `${refOf(byObject.get(f.object)!)}'s ${f.key === "ref" ? "designator" : "value"}`
  for (const f of fields) {
    const crossed = [...wires.near(f.box)].filter((s) => wireCrossesBox(s, f.box))
    if (crossed.length) found.push({ kind: "field-on-wire", at: middleOf(f.box), objects: [f.object], segments: crossed.map((s) => s.id), text: `${named(f)} lies on a wire` })
    const under = [...near.near(f.box)].filter(
      (b) => boxesMeet(f.box, b.box) && (b.contour.some((corners) => fieldCrossesContour(f.box, corners)) || b.pins.some((p) => holds(f.box, p)) || b.leads.some((lead) => fieldCrossesLead(f.box, lead))),
    )
    if (under.length) found.push({ kind: "field-on-body", at: middleOf(f.box), objects: [f.object, ...under.map((b) => b.object.id).filter((id) => id !== f.object)], segments: [], text: `${named(f)} lies on ${under.map((b) => refOf(b.object)).join(", ")}` })
  }
  const placed = new Buckets<PlacedField>(BUCKET)
  for (const f of fields) placed.add(f.box, f)
  const seen = new Set<string>()
  for (const f of fields) {
    for (const g of placed.near(f.box)) {
      if (g === f || !boxesOverlap(f.box, g.box)) continue
      const pair = [`${f.object}:${f.key}`, `${g.object}:${g.key}`].sort().join("|")
      if (seen.has(pair)) continue
      seen.add(pair)
      found.push({ kind: "fields-overlap", at: middleOf(f.box), objects: [...new Set([f.object, g.object])], segments: [], text: `${named(f)} and ${named(g)} overlap` })
    }
  }
  return found
}

function parallelRuns(doc: Schematic): Finding[] {
  const found: Finding[] = []
  for (const axis of ["x", "y"] as const) {
    const across = axis === "x" ? "y" : "x"
    const lines = new Map<number, WireSegment[]>()
    for (const s of doc.wires) {
      if (s.a[across] !== s.b[across] || s.a[axis] === s.b[axis]) continue
      const line = s.a[across]
      lines.set(line, [...(lines.get(line) ?? []), s])
    }
    for (const [line, segments] of lines) {
      for (const other of lines.get(line + HALF) ?? []) {
        for (const s of segments) {
          const lo = Math.max(Math.min(s.a[axis], s.b[axis]), Math.min(other.a[axis], other.b[axis]))
          const hi = Math.min(Math.max(s.a[axis], s.b[axis]), Math.max(other.a[axis], other.b[axis]))
          if (hi - lo <= EPS) continue
          const at = axis === "x" ? { x: (lo + hi) / 2, y: line + HALF / 2 } : { x: line + HALF / 2, y: (lo + hi) / 2 }
          found.push({ kind: "parallel-too-close", at, objects: [], segments: [s.id, other.id], text: "Two wires run side by side half a cell apart" })
        }
      }
    }
  }
  return found
}

export function checked(doc: Schematic, wiring: Wiring = wiringOf(new WireGraph(), doc)): readonly Finding[] {
  const marked = new Set(doc.objects.filter(isMark).map((o) => keyOf(markAt(o))))
  const bodies = bodiesOf(doc.objects)
  const order = new Map(CHECK_KINDS.map((k, i) => [k, i]))
  return [...danglingEnds(doc, wiring, marked), ...unconnectedPins(doc, wiring, marked), ...fourWays(doc, wiring), ...wiresThroughBodies(doc, bodies), ...fieldFindings(doc, bodies), ...parallelRuns(doc)].sort(
    (a, b) => order.get(a.kind)! - order.get(b.kind)! || a.at.x - b.at.x || a.at.y - b.at.y,
  )
}


type CheckedItem = { object?: PlacedObject; segment?: WireSegment; box: Rect }

const checkedBox = (o: PlacedObject): Rect => {
  const boxes = [objectRect(o, GRID), ...placedFields(o, GRID).map((f) => f.box)]
  const x = Math.min(...boxes.map((b) => b.x)) - GRID
  const y = Math.min(...boxes.map((b) => b.y)) - GRID
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x + GRID, h: Math.max(...boxes.map((b) => b.y + b.h)) - y + GRID }
}

export class KeptChecker {
  private readonly near = new Buckets<CheckedItem>(BUCKET)
  private readonly objects = new Map<string, CheckedItem>()
  private readonly segments = new Map<string, CheckedItem>()
  private findings: readonly Finding[] = []
  private source: Schematic | undefined
  private offset = { x: 0, y: 0 }
  private indexed = false
  private definitions: string | undefined

  update(doc: Schematic, wiring: Wiring): readonly Finding[] {
    if (this.definitions !== wiring.index.version) {
      this.near.clear()
      this.objects.clear()
      this.segments.clear()
      this.source = undefined
      this.offset = { x: 0, y: 0 }
      this.indexed = false
      this.definitions = wiring.index.version
    }
    if (this.source?.objects === doc.objects && this.source.wires === doc.wires && this.source.library === doc.library) return this.findings
    const shift = translationOf(doc.objects, doc.wires)
    if (shift && shift.from === this.source?.objects && shift.fromWires === this.source.wires) {
      this.offset = { x: this.offset.x + shift.x, y: this.offset.y + shift.y }
      this.findings = this.findings.map((f) => ({ ...f, at: { x: f.at.x + shift.x, y: f.at.y + shift.y } }))
      this.source = doc
      return this.findings
    }
    if (doc.objects.length <= 64 && doc.wires.length <= 200) {
      this.near.clear()
      this.objects.clear()
      this.segments.clear()
      this.indexed = false
      this.offset = { x: 0, y: 0 }
      this.source = doc
      return this.findings = checked(doc, wiring)
    }
    if (!this.indexed) { this.source = undefined; this.indexed = true }
    const delta = wiring.changes
    if ((this.offset.x || this.offset.y) && (!delta || this.source?.objects !== delta.from.objects || this.source.wires !== delta.from.wires)) {
      this.near.clear()
      this.objects.clear()
      this.segments.clear()
      this.offset = { x: 0, y: 0 }
      this.source = undefined
    }
    const changed: CheckedItem[] = []
    const replace = (map: Map<string, CheckedItem>, id: string, item: CheckedItem) => {
      item = { ...item, box: { ...item.box, x: item.box.x - this.offset.x, y: item.box.y - this.offset.y } }
      const previous = map.get(id)
      if (previous?.object === item.object && previous?.segment === item.segment) return
      if (previous) { this.near.remove(previous.box, previous); changed.push(previous) }
      map.set(id, item)
      this.near.add(item.box, item)
      changed.push(item)
    }
    if (delta && this.source?.objects === delta.from.objects && this.source.wires === delta.from.wires) {
      for (const [map, ids] of [[this.objects, delta.objects.before.map((o) => o.id)], [this.segments, delta.wires.removed.map((s) => s.id)]] as const) {
        for (const id of ids) {
          const old = map.get(id)
          if (!old) continue
          map.delete(id)
          this.near.remove(old.box, old)
          changed.push(old)
        }
      }
      for (const object of delta.objects.after) replace(this.objects, object.id, { object, box: checkedBox(object) })
      for (const segment of delta.wires.added) {
        const b = boxOfSegment(segment)
        replace(this.segments, segment.id, { segment, box: { x: b.x - GRID, y: b.y - GRID, w: b.w + 2 * GRID, h: b.h + 2 * GRID } })
      }
    } else {
      const objectIds = new Set(doc.objects.map((o) => o.id))
      const segmentIds = new Set(doc.wires.map((s) => s.id))
      for (const [map, ids] of [[this.objects, objectIds], [this.segments, segmentIds]] as const) {
        for (const [id, item] of map) if (!ids.has(id)) { map.delete(id); this.near.remove(item.box, item); changed.push(item) }
      }
      for (const object of doc.objects) {
        if (this.objects.get(object.id)?.object !== object) replace(this.objects, object.id, { object, box: checkedBox(object) })
      }
      for (const segment of doc.wires) {
        if (this.segments.get(segment.id)?.segment !== segment) {
          const b = boxOfSegment(segment)
          replace(this.segments, segment.id, { segment, box: { x: b.x - GRID, y: b.y - GRID, w: b.w + 2 * GRID, h: b.h + 2 * GRID } })
        }
      }
    }
    if (!this.source || this.source.library !== doc.library || changed.length > (doc.objects.length + doc.wires.length) / 2) {
      this.findings = checked(doc, wiring)
    } else if (changed.length) {
      const targets = new Set<CheckedItem>(changed)
      for (const item of changed) for (const nearby of this.near.near(item.box)) if (boxesMeet(item.box, nearby.box)) targets.add(nearby)
      const local = new Set(targets)
      for (const item of targets) for (const nearby of this.near.near(item.box)) if (boxesMeet(item.box, nearby.box)) local.add(nearby)
      const objects = new Set([...targets].flatMap((item) => item.object ? [item.object.id] : []))
      const segments = new Set([...targets].flatMap((item) => item.segment ? [item.segment.id] : []))
      const localObjects = new Set([...local].flatMap((item) => item.object ? [item.object.id] : []))
      const localSegments = new Set([...local].flatMap((item) => item.segment ? [item.segment.id] : []))
      const affected = (f: Finding) => f.objects.some((id) => objects.has(id)) || f.segments.some((id) => segments.has(id))
      const segmentOrder = wireOrder(doc.wires)
      const subset = { ...doc, objects: [...localObjects].flatMap((id) => wiring.index.objects.get(id) ? [wiring.index.objects.get(id)!] : []).sort((a, b) => wiring.index.rank(a) - wiring.index.rank(b)), wires: [...localSegments].flatMap((id) => wiring.segmentsById.get(id) ? [wiring.segmentsById.get(id)!] : []).sort((a, b) => segmentOrder.get(a)! - segmentOrder.get(b)!) }
      const ends = new Set(subset.wires.flatMap((s) => [keyOf(s.a), keyOf(s.b)]))
      const localWiring: Wiring = Object.create(wiring, { activePins: { value: subset.objects.flatMap((o) => pinsForObject(o)) }, dangling: { value: wiring.dangling.filter((p) => ends.has(keyOf(p))) } })
      const order = new Map(CHECK_KINDS.map((k, i) => [k, i]))
      this.findings = [...this.findings.filter((f) => !affected(f)), ...checked(subset, localWiring).filter(affected)].sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || a.at.x - b.at.x || a.at.y - b.at.y)
    }
    this.source = doc
    return this.findings
  }
}
