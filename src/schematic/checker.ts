import { placedFields, type PlacedField } from "./fields"
import { GRID, objectRect, type Point, type Rect } from "./geometry"
import { footprints, type Lead } from "./placement"
import { pinsForObject, translationOf } from "./pin-index"
import { getDef, pinName } from "./registry"
import type { ComponentDef, PlacedObject, Schematic } from "./types"
import { wireOrder, wiringOf, type Wiring } from "./wire-edits"
import { WireGraph } from "./wires/graph"
import { exactPointCode as codeOf, type WirePin, type WireSegment } from "./wires/segment"

export type CheckKind = "dangling-end" | "unconnected-pin" | "wire-through-body" | "field-on-wire" | "field-on-body" | "fields-overlap" | "parallel-too-close"

export const CHECK_KINDS: readonly CheckKind[] = ["dangling-end", "unconnected-pin", "wire-through-body", "field-on-wire", "field-on-body", "fields-overlap", "parallel-too-close"]

export type CheckLevel = "warning" | "note"

export const LEVEL_OF: Record<CheckKind, CheckLevel> = {
  "dangling-end": "warning",
  "unconnected-pin": "warning",
  "wire-through-body": "warning",
  "field-on-wire": "note",
  "field-on-body": "note",
  "fields-overlap": "note",
  "parallel-too-close": "note",
}

export type Finding = { kind: CheckKind; at: Point; objects: readonly string[]; segments: readonly string[]; text: string; pin?: string; fields?: readonly string[] }

const HALF = GRID / 2
const EPS = 1e-6

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

const CELL_SPAN = 2 ** 26
const CELL_BIAS = 2 ** 25

const cellKey = (i: number, j: number) => (i + CELL_BIAS) * CELL_SPAN + (j + CELL_BIAS)

const NOTHING: ReadonlySet<never> = new Set()

export class Buckets<T> {
  private readonly cells = new Map<number, Set<T>>()
  private readonly size: number
  constructor(size: number) {
    this.size = size
  }
  add(r: Rect, item: T) {
    const i1 = Math.floor((r.x + r.w) / this.size)
    const j0 = Math.floor(r.y / this.size)
    const j1 = Math.floor((r.y + r.h) / this.size)
    for (let i = Math.floor(r.x / this.size); i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = cellKey(i, j)
      const cell = this.cells.get(key)
      if (cell) cell.add(item)
      else this.cells.set(key, new Set([item]))
    }
  }
  clear() { this.cells.clear() }
  remove(r: Rect, item: T) {
    const i1 = Math.floor((r.x + r.w) / this.size)
    const j0 = Math.floor(r.y / this.size)
    const j1 = Math.floor((r.y + r.h) / this.size)
    for (let i = Math.floor(r.x / this.size); i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const key = cellKey(i, j)
      const cell = this.cells.get(key)
      cell?.delete(item)
      if (!cell?.size) this.cells.delete(key)
    }
  }
  visit(r: Rect, see: (item: T) => void) {
    const i1 = Math.floor((r.x + r.w) / this.size)
    const j0 = Math.floor(r.y / this.size)
    const j1 = Math.floor((r.y + r.h) / this.size)
    for (let i = Math.floor(r.x / this.size); i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const cell = this.cells.get(cellKey(i, j))
      if (cell) for (const item of cell) see(item)
    }
  }
  near(r: Rect): ReadonlySet<T> {
    const i0 = Math.floor(r.x / this.size)
    const i1 = Math.floor((r.x + r.w) / this.size)
    const j0 = Math.floor(r.y / this.size)
    const j1 = Math.floor((r.y + r.h) / this.size)
    if (i0 === i1 && j0 === j1) return this.cells.get(cellKey(i0, j0)) ?? NOTHING
    const found = new Set<T>()
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const cell = this.cells.get(cellKey(i, j))
      if (cell) for (const item of cell) found.add(item)
    }
    return found
  }
}

const BUCKET = 16 * GRID

type Body = { object: PlacedObject; contour: readonly (readonly Point[])[]; leads: readonly Lead[]; pins: readonly WirePin[]; box: Rect }

const judged = (o: PlacedObject) => {
  const def = getDef(o.def)
  return !!def && !def.pins.every((p) => p.kind === "node")
}

const bodyCache = new WeakMap<PlacedObject, { def: ReturnType<typeof getDef>; body: Body }>()

function bodiesOf(objects: readonly PlacedObject[]): Body[] {
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

function danglingEnds(doc: Schematic, wiring: Wiring): Finding[] {
  const open = wiring.dangling
  if (!open.length) return []
  const endsAt = new Map<number | string, string[]>(open.map((p) => [codeOf(p), []]))
  for (const s of doc.wires) {
    endsAt.get(codeOf(s.a))?.push(s.id)
    endsAt.get(codeOf(s.b))?.push(s.id)
  }
  return open.map((at) => ({ kind: "dangling-end", at, objects: [], segments: endsAt.get(codeOf(at))!, text: "A wire end that meets nothing" }))
}

const MOST_PINS_ALL_NEEDED = 3

const electricalPins = (def: ComponentDef) => def.pins.filter((pin) => pin.kind !== "nc" && pin.kind !== "node")

function unconnectedPins(doc: Schematic, wiring: Wiring): Finding[] {
  const found: Finding[] = []
  for (const o of doc.objects) {
    const def = getDef(o.def)
    if (!def || !def.model?.length || def.pinsAreSockets || def.chip) continue
    if (electricalPins(def).length > MOST_PINS_ALL_NEEDED) continue
    const indexed = wiring.index.objects.get(o.id)
    if (!indexed) continue
    for (const placed of pinsForObject(indexed)) {
      if (placed.kind === "nc" || placed.kind === "node") continue
      const net = wiring.view.netOfPin(placed.key)
      const alone = !net || (wiring.view.pinsOf(net).length <= 1 && wiring.view.segmentsOf(net).length === 0)
      if (!alone) continue
      const pin = placed.key.slice(o.id.length + 1)
      found.push({ kind: "unconnected-pin", at: placed.at, objects: [o.id], segments: [], pin, text: `${pinName(doc.objects as PlacedObject[], { object: o.id, pin })} is not connected` })
    }
  }
  return found
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

function bodyBuckets(bodies: readonly Body[]): Buckets<Body> {
  const near = new Buckets<Body>(BUCKET)
  for (const b of bodies) near.add(b.box, b)
  return near
}

function wiresThroughBodies(doc: Schematic, near: Buckets<Body>): Finding[] {
  const found: Finding[] = []
  for (const s of doc.wires) {
    const box = boxOfSegment(s)
    for (const body of near.near(box)) {
      if (getDef(body.object.def)?.pinsAreSockets) continue
      if (!boxesMeet(body.box, box)) continue
      if (runsThrough(s, body)) found.push({ kind: "wire-through-body", at: middleOf(box), objects: [body.object.id], segments: [s.id], text: `A wire runs through ${refOf(body.object)}` })
    }
  }
  return found
}

function fieldFindings(doc: Schematic, near: Buckets<Body>): Finding[] {
  const fields = doc.objects.flatMap((o) => placedFields(o, GRID))
  const wires = new Buckets<WireSegment>(BUCKET)
  for (const s of doc.wires) wires.add(boxOfSegment(s), s)
  let byObject: Map<string, PlacedObject> | undefined
  const found: Finding[] = []
  const named = (f: PlacedField) => `${refOf((byObject ??= new Map(doc.objects.map((o) => [o.id, o]))).get(f.object)!)}'s ${f.key === "ref" ? "designator" : "value"}`
  for (const f of fields) {
    const crossed = [...wires.near(f.box)].filter((s) => wireCrossesBox(s, f.box))
    if (crossed.length) found.push({ kind: "field-on-wire", at: middleOf(f.box), objects: [f.object], segments: crossed.map((s) => s.id), fields: [`${f.object}:${f.key}`], text: `${named(f)} lies on a wire` })
    const under = [...near.near(f.box)].filter(
      (b) => boxesMeet(f.box, b.box) && (b.contour.some((corners) => fieldCrossesContour(f.box, corners)) || b.pins.some((p) => holds(f.box, p.at)) || b.leads.some((lead) => fieldCrossesLead(f.box, lead))),
    ).sort((a, b) => a.object.id.localeCompare(b.object.id))
    if (under.length) found.push({ kind: "field-on-body", at: middleOf(f.box), objects: [f.object, ...under.map((b) => b.object.id).filter((id) => id !== f.object)], segments: [], fields: [`${f.object}:${f.key}`], text: `${named(f)} lies on ${under.map((b) => refOf(b.object)).join(", ")}` })
  }
  const placed = new Buckets<PlacedField>(BUCKET)
  for (const f of fields) placed.add(f.box, f)
  const seen = new Set<string>()
  for (const f of fields) {
    for (const g of placed.near(f.box)) {
      if (g === f || !boxesOverlap(f.box, g.box)) continue
      const fields = [`${f.object}:${f.key}`, `${g.object}:${g.key}`].sort()
      const pair = fields.join("|")
      if (seen.has(pair)) continue
      seen.add(pair)
      found.push({ kind: "fields-overlap", at: middleOf(f.box), objects: [...new Set([f.object, g.object])], segments: [], fields, text: `${named(f)} and ${named(g)} overlap` })
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
      const list = lines.get(line)
      if (list) list.push(s)
      else lines.set(line, [s])
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

const KIND_ORDER = new Map(CHECK_KINDS.map((k, i) => [k, i]))

const membershipOf = (f: Finding) => JSON.stringify([f.objects, f.segments, f.fields, f.pin])

const inReadingOrder = (a: Finding, b: Finding) => KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! || a.at.x - b.at.x || a.at.y - b.at.y || membershipOf(a).localeCompare(membershipOf(b))

const MARK_PLACES_PER_UNIT = 1e6

const settled = (v: number) => Math.round(v * MARK_PLACES_PER_UNIT) / MARK_PLACES_PER_UNIT

const placedAt = (f: Finding, x: number, y: number): Finding => ({ ...f, at: { x: settled(x), y: settled(y) } })

const canonical = (f: Finding): Finding => ({ ...f, objects: [...f.objects].sort(), segments: [...f.segments].sort() })

export function checked(doc: Schematic, wiring: Wiring = wiringOf(new WireGraph(), doc)): readonly Finding[] {
  const bodies = bodyBuckets(bodiesOf(doc.objects))
  return [...danglingEnds(doc, wiring), ...unconnectedPins(doc, wiring), ...wiresThroughBodies(doc, bodies), ...fieldFindings(doc, bodies), ...parallelRuns(doc)].map((f) => canonical(placedAt(f, f.at.x, f.at.y))).sort(inReadingOrder)
}


type CheckedItem = { object?: PlacedObject; segment?: WireSegment; box: Rect }

function ordered<T>(items: readonly T[], rank: (item: T) => number): T[] {
  return items.map((item) => ({ item, rank: rank(item) })).sort((a, b) => a.rank - b.rank).map((ranked) => ranked.item)
}

function merged(kept: readonly Finding[], found: readonly Finding[]): Finding[] {
  const out: Finding[] = []
  let i = 0
  let j = 0
  while (i < kept.length && j < found.length) out.push(inReadingOrder(kept[i], found[j]) <= 0 ? kept[i++] : found[j++])
  while (i < kept.length) out.push(kept[i++])
  while (j < found.length) out.push(found[j++])
  return out
}

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
      this.findings = this.findings.map((f) => placedAt(f, f.at.x + shift.x, f.at.y + shift.y))
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
      for (const item of changed) this.near.visit(item.box, (nearby) => { if (boxesMeet(item.box, nearby.box)) targets.add(nearby) })
      const local = new Set(targets)
      for (const item of targets) this.near.visit(item.box, (nearby) => { if (boxesMeet(item.box, nearby.box)) local.add(nearby) })
      const objects = new Set<string>()
      const segments = new Set<string>()
      for (const item of targets) {
        if (item.object) objects.add(item.object.id)
        if (item.segment) segments.add(item.segment.id)
      }
      const affected = (f: Finding) => f.objects.some((id) => objects.has(id)) || f.segments.some((id) => segments.has(id))
      const segmentOrder = wireOrder(doc.wires)
      const liveObjects: PlacedObject[] = []
      const liveSegments: WireSegment[] = []
      if (!this.offset.x && !this.offset.y) for (const item of local) {
        if (item.object && this.objects.get(item.object.id) === item) liveObjects.push(item.object)
        if (item.segment && this.segments.get(item.segment.id) === item) liveSegments.push(item.segment)
      } else {
        const objectIds = new Set<string>()
        const segmentIds = new Set<string>()
        for (const item of local) {
          if (item.object) objectIds.add(item.object.id)
          if (item.segment) segmentIds.add(item.segment.id)
        }
        for (const id of objectIds) { const o = wiring.index.objects.get(id); if (o) liveObjects.push(o) }
        for (const id of segmentIds) { const s = wiring.segmentsById.get(id); if (s) liveSegments.push(s) }
      }
      const subset = { ...doc, objects: ordered(liveObjects, (o) => wiring.index.rank(o)), wires: ordered(liveSegments, (s) => segmentOrder.get(s)!) }
      const ends = new Set<number | string>()
      for (const s of subset.wires) { ends.add(codeOf(s.a)); ends.add(codeOf(s.b)) }
      const localWiring: Wiring = Object.create(wiring, { activePins: { value: subset.objects.flatMap((o) => wiring.activeOf(o.id)) }, dangling: { value: wiring.dangling.filter((p) => ends.has(codeOf(p))) } })
      this.findings = merged(this.findings.filter((f) => !affected(f)), checked(subset, localWiring).filter(affected))
    }
    this.source = doc
    return this.findings
  }
}
