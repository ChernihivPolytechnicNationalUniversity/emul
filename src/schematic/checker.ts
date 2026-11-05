import { placedFields, type PlacedField } from "./fields"
import { GRID, type Point, type Rect } from "./geometry"
import { footprints, type Lead } from "./placement"
import { getDef, pinName } from "./registry"
import type { PlacedObject, Schematic } from "./types"
import { wiringOf, type Wiring } from "./wire-edits"
import { WireGraph } from "./wires/graph"
import type { WireSegment } from "./wires/segment"

export const NO_CONNECT = "no-connect"

export type CheckKind = "dangling-end" | "unconnected-pin" | "four-way" | "wire-through-body" | "field-on-wire" | "field-on-body" | "fields-overlap" | "parallel-too-close"

export const CHECK_KINDS: readonly CheckKind[] = ["dangling-end", "unconnected-pin", "four-way", "wire-through-body", "field-on-wire", "field-on-body", "fields-overlap", "parallel-too-close"]

export type Finding = { kind: CheckKind; at: Point; objects: readonly string[]; segments: readonly string[]; text: string; pin?: string }

const HALF = GRID / 2
const EPS = 1e-6

const keyOf = (p: Point) => `${p.x},${p.y}`

const isMark = (o: PlacedObject) => o.def === NO_CONNECT

const markAt = (o: PlacedObject): Point => ({ x: o.x + GRID, y: o.y + GRID })

const middleOf = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

const refOf = (o: PlacedObject) => o.props?.ref || getDef(o.def)?.name || o.id

function projections(points: readonly Point[], axis: Point) {
  let lo = Infinity
  let hi = -Infinity
  for (const p of points) {
    const v = p.x * axis.x + p.y * axis.y
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi] as const
}

function edgesOf(points: readonly Point[]): Point[] {
  const axes: Point[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    if (p.x !== q.x || p.y !== q.y) axes.push({ x: -(q.y - p.y), y: q.x - p.x })
  }
  return axes
}

function overlapping(a: readonly Point[], b: readonly Point[]) {
  for (const axis of [...edgesOf(a), ...edgesOf(b)]) {
    const [alo, ahi] = projections(a, axis)
    const [blo, bhi] = projections(b, axis)
    const scale = Math.hypot(axis.x, axis.y)
    if (ahi <= blo + EPS * scale || bhi <= alo + EPS * scale) return false
  }
  return true
}

const cornersOf = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
]

const segmentPoints = (s: WireSegment): Point[] => [s.a, s.b]

const boxOfSegment = (s: WireSegment): Rect => ({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.b.x - s.a.x), h: Math.abs(s.b.y - s.a.y) })

const boxesMeet = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h

const holds = (r: Rect, p: Point) => p.x > r.x + EPS && p.x < r.x + r.w - EPS && p.y > r.y + EPS && p.y < r.y + r.h - EPS

class Buckets<T> {
  private readonly cells = new Map<string, T[]>()
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
      if (cell) cell.push(item)
      else this.cells.set(key, [item])
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

function bodiesOf(objects: readonly PlacedObject[], wiring: Wiring): Body[] {
  const pinsOf = new Map<string, Point[]>()
  for (const p of wiring.pins) {
    const owner = p.key.slice(0, p.key.indexOf(":"))
    const list = pinsOf.get(owner)
    if (list) list.push(p.at)
    else pinsOf.set(owner, [p.at])
  }
  return objects.filter(judged).flatMap((object): Body[] => {
    const f = footprints(object, GRID)
    if (!f) return []
    const pins = pinsOf.get(object.id) ?? []
    const points = [...f.contour.flatMap((q) => q.corners), ...f.leads.flat(), ...pins]
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => p.y)
    const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    return [{ object, contour: f.outline, leads: f.leads, pins, box }]
  })
}

function danglingEnds(doc: Schematic, wiring: Wiring, marked: ReadonlySet<string>): Finding[] {
  const endsAt = new Map<string, string[]>()
  for (const s of doc.wires) for (const p of [s.a, s.b]) endsAt.set(keyOf(p), [...(endsAt.get(keyOf(p)) ?? []), s.id])
  return wiring.dangling.filter((p) => !marked.has(keyOf(p))).map((at) => ({ kind: "dangling-end", at, objects: [], segments: endsAt.get(keyOf(at)) ?? [], text: "A wire end that meets nothing" }))
}

function unconnectedPins(doc: Schematic, wiring: Wiring, marked: ReadonlySet<string>): Finding[] {
  const found: Finding[] = []
  const pinsByKey = new Map(wiring.pins.map((p) => [p.key, p]))
  for (const o of doc.objects) {
    const def = getDef(o.def)
    if (!def || !def.model?.length || def.pinsAreSockets || isMark(o)) continue
    for (const pin of def.pins) {
      if (pin.kind === "nc" || pin.kind === "node") continue
      const key = `${o.id}:${pin.id}`
      const placed = pinsByKey.get(key)
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
  for (const p of wiring.pins) bump(p.at).objects.add(p.key.slice(0, p.key.indexOf(":")))
  return [...count.values()].filter((c) => c.n >= 4).map((c) => ({ kind: "four-way", at: c.at, objects: [...c.objects], segments: c.segments, text: `${c.n} conductors meet at one point: two T's read more clearly` }))
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
    const box = cornersOf(f.box)
    const crossed = [...wires.near(f.box)].filter((s) => boxesMeet(f.box, boxOfSegment(s)) && overlapping(segmentPoints(s), box))
    if (crossed.length) found.push({ kind: "field-on-wire", at: middleOf(f.box), objects: [f.object], segments: crossed.map((s) => s.id), text: `${named(f)} lies on a wire` })
    const under = [...near.near(f.box)].filter(
      (b) => boxesMeet(f.box, b.box) && (b.contour.some((corners) => overlapping(box, corners)) || b.pins.some((p) => holds(f.box, p)) || b.leads.some(([p, q]) => overlapping(box, [p, q]))),
    )
    if (under.length) found.push({ kind: "field-on-body", at: middleOf(f.box), objects: [f.object, ...under.map((b) => b.object.id).filter((id) => id !== f.object)], segments: [], text: `${named(f)} lies on ${under.map((b) => refOf(b.object)).join(", ")}` })
  }
  const placed = new Buckets<PlacedField>(BUCKET)
  for (const f of fields) placed.add(f.box, f)
  const seen = new Set<string>()
  for (const f of fields) {
    for (const g of placed.near(f.box)) {
      if (g === f) continue
      const pair = [`${f.object}:${f.key}`, `${g.object}:${g.key}`].sort().join("|")
      if (seen.has(pair) || !overlapping(cornersOf(f.box), cornersOf(g.box))) continue
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
  const bodies = bodiesOf(doc.objects, wiring)
  const order = new Map(CHECK_KINDS.map((k, i) => [k, i]))
  return [...danglingEnds(doc, wiring, marked), ...unconnectedPins(doc, wiring, marked), ...fourWays(doc, wiring), ...wiresThroughBodies(doc, bodies), ...fieldFindings(doc, bodies), ...parallelRuns(doc)].sort(
    (a, b) => order.get(a.kind)! - order.get(b.kind)! || a.at.x - b.at.x || a.at.y - b.at.y,
  )
}
