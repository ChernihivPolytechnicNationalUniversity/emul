import { GRID, objectRect, type Point } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import { footprints } from "@/schematic/placement"
import { getDef } from "@/schematic/registry"
import type { Schematic } from "@/schematic/types"
import { wireNets } from "@/schematic/wires/graph"
import type { WirePin, WireSegment } from "@/schematic/wires/segment"

export type Shape = { readonly crossings: number; readonly bends: number; readonly length: number }

export type Order = "bends before length" | "length before bends"

type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
type Lead = readonly [Point, Point]

const STEPS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
]

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y
const key = (p: Point) => `${p.x},${p.y}`
const show = (p: Point) => `(${p.x / GRID}, ${p.y / GRID})`

function crossesBox(p: Point, q: Point, r: Box): boolean {
  if (p.y === q.y) return p.y > r.y && p.y < r.y + r.h && Math.max(p.x, q.x) > r.x && Math.min(p.x, q.x) < r.x + r.w
  return p.x > r.x && p.x < r.x + r.w && Math.max(p.y, q.y) > r.y && Math.min(p.y, q.y) < r.y + r.h
}

const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x
const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })

function meeting(p: Point, q: Point, [c, d]: Lead): Point[] {
  const e = minus(q, p)
  const f = minus(d, c)
  const denominator = cross(e, f)
  const w = minus(c, p)
  if (Math.abs(denominator) > 1e-9) {
    const t = cross(w, f) / denominator
    const u = cross(w, e) / denominator
    return t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9 ? [] : [{ x: p.x + e.x * t, y: p.y + e.y * t }]
  }
  if (Math.abs(cross(w, e)) > 1e-9) return []
  const length = e.x * e.x + e.y * e.y
  const along = (o: Point) => ((o.x - p.x) * e.x + (o.y - p.y) * e.y) / length
  const lo = Math.max(0, Math.min(along(c), along(d)))
  const hi = Math.min(1, Math.max(along(c), along(d)))
  if (hi < lo - 1e-9) return []
  const at = (t: number) => ({ x: p.x + e.x * t, y: p.y + e.y * t })
  return hi - lo > 1e-9 ? [at(lo), at(hi)] : [at(lo)]
}

const near = (p: Point, q: Point) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6

type Scene = {
  readonly from: Point
  readonly to: Point
  readonly bodies: readonly Box[]
  readonly leads: readonly Lead[]
  readonly pins: ReadonlyMap<string, readonly WirePin[]>
  readonly foreign: readonly WireSegment[]
  readonly out: (p: Point) => Point | undefined
  readonly shunts: readonly Lead[]
  readonly window: Box
}

function sceneOf(doc: Schematic, from: Point, to: Point): Scene {
  const pins = wirePins(doc.objects)
  const nets = wireNets(doc.wires, pins)
  const netAt = (p: Point) => {
    const pin = pins.find((q) => same(q.at, p))
    if (pin) return nets.netOfPin(pin.key) ?? `pin:${pin.key}`
    const s = doc.wires.find((w) => onWire(w, p))
    return s ? (nets.netOfSegment(s.id) ?? `wire:${s.id}`) : undefined
  }
  const own = new Set([netAt(from), netAt(to)].filter((n): n is string => n !== undefined))
  const foreign = doc.wires.filter((s) => !own.has(nets.netOfSegment(s.id) ?? `wire:${s.id}`))
  const bodies: Box[] = []
  const leads: Lead[] = []
  for (const o of doc.objects) {
    const f = footprints(o, GRID)
    if (!f) continue
    if (!getDef(o.def)?.pinsAreSockets) {
      bodies.push(f.body.box)
      leads.push(...f.leads)
    }
  }
  const boxes = [...doc.objects.map((o) => objectRect(o, GRID)), ...doc.wires.map((s) => ({ x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.a.x - s.b.x), h: Math.abs(s.a.y - s.b.y) })), { x: from.x, y: from.y, w: 0, h: 0 }, { x: to.x, y: to.y, w: 0, h: 0 }]
  const margin = 6 * GRID
  const x0 = Math.floor(Math.min(...boxes.map((b) => b.x)) / GRID) * GRID - margin
  const y0 = Math.floor(Math.min(...boxes.map((b) => b.y)) / GRID) * GRID - margin
  const x1 = Math.ceil(Math.max(...boxes.map((b) => b.x + b.w)) / GRID) * GRID + margin
  const y1 = Math.ceil(Math.max(...boxes.map((b) => b.y + b.h)) / GRID) * GRID + margin
  const byPoint = new Map<string, WirePin[]>()
  for (const p of pins) byPoint.set(key(p.at), [...(byPoint.get(key(p.at)) ?? []), p])
  const shunts = pins.flatMap((p): Lead[] => (p.shunt ? [[p.at, { x: p.at.x + p.shunt.x, y: p.at.y + p.shunt.y }]] : []))
  return { from, to, bodies, leads, pins: byPoint, foreign, out: (p) => byPoint.get(key(p))?.[0]?.out, shunts, window: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } }
}

function onWire(s: WireSegment, p: Point): "end" | "interior" | null {
  if (same(s.a, p) || same(s.b, p)) return "end"
  if (s.a.y === s.b.y) return p.y === s.a.y && p.x > Math.min(s.a.x, s.b.x) && p.x < Math.max(s.a.x, s.b.x) ? "interior" : null
  return p.x === s.a.x && p.y > Math.min(s.a.y, s.b.y) && p.y < Math.max(s.a.y, s.b.y) ? "interior" : null
}

type Arrival = { readonly fault: string | null; readonly crossing: number; readonly straightOnly: boolean }

function arrive(scene: Scene, p: Point, d: Point): Arrival {
  const q = { x: p.x + d.x * GRID, y: p.y + d.y * GRID }
  const fault = (why: string): Arrival => ({ fault: `${show(p)}→${show(q)}: ${why}`, crossing: 0, straightOnly: false })
  if (same(p, scene.from)) {
    const out = scene.out(p)
    if (out && out.x === -d.x && out.y === -d.y) return fault("leaves its pin into its own part")
  }
  if (same(q, scene.to)) {
    const out = scene.out(q)
    if (out && out.x === d.x && out.y === d.y) return fault("enters its pin from inside its own part")
  }
  for (const r of scene.bodies) if (crossesBox(p, q, r)) return fault("runs through a body")
  for (const lead of scene.leads) {
    const allowed = [scene.from, scene.to].find((end) => same(end, lead[0]))
    if (meeting(p, q, lead).some((at) => !allowed || !near(at, allowed))) return fault("touches a part's lead")
  }
  for (const shunt of scene.shunts) if (meeting(p, q, shunt).some((at) => !near(at, scene.to) && !near(at, scene.from))) return fault(`runs onto the jumper's shunt at ${show(shunt[0])}`)
  let straightOnly = false
  for (const pin of scene.pins.get(key(q)) ?? []) {
    if (same(q, scene.to)) continue
    if (!pin.socket) return fault(`passes over the pin ${pin.key}`)
    if (pin.out && d.x * pin.out.x + d.y * pin.out.y === 0) return fault(`passes along the header column at ${pin.key}`)
    straightOnly = true
  }
  let crossing = 0
  for (const s of scene.foreign) {
    const hits = meeting(p, q, [s.a, s.b])
    if (!hits.length) continue
    if (hits.length > 1) return fault(`runs along another net's wire ${s.id}`)
    const at = hits[0]
    if (same(at, s.a) || same(at, s.b)) return fault(`touches the end of another net's wire ${s.id}`)
    if (near(at, q)) straightOnly = true
    if (!near(at, p)) crossing++
  }
  return { fault: null, crossing, straightOnly }
}

const unit = (p: Point, q: Point): Point => ({ x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) })

export function shapeOf(doc: Schematic, points: readonly Point[]): Shape & { readonly faults: readonly string[] } {
  const faults: string[] = []
  if (!points.length) return { crossings: 0, bends: 0, length: 0, faults: ["no points"] }
  const scene = sceneOf(doc, points[0], points[points.length - 1])
  let crossings = 0
  let bends = 0
  let length = 0
  const seen = new Set([key(points[0])])
  let heading: Point | null = null
  let straightOnly = false
  for (const p of points) if (p.x % GRID || p.y % GRID) faults.push(`${show(p)} is off the whole-cell grid`)
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (same(a, b)) {
      faults.push(`a piece of no length at ${show(a)}`)
      continue
    }
    if (a.x !== b.x && a.y !== b.y) {
      faults.push(`${show(a)}→${show(b)} is not horizontal or vertical`)
      continue
    }
    const d = unit(a, b)
    if (heading && (heading.x !== d.x || heading.y !== d.y)) {
      if (heading.x === -d.x && heading.y === -d.y) faults.push(`turns straight back at ${show(a)}`)
      if (straightOnly) faults.push(`turns at ${show(a)}, on another net's wire or a socket`)
      bends++
    }
    heading = d
    const steps = (Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / GRID
    if (!Number.isInteger(steps)) continue
    for (let at = a; !same(at, b); ) {
      const next = { x: at.x + d.x * GRID, y: at.y + d.y * GRID }
      const step = arrive(scene, at, d)
      if (step.fault) faults.push(step.fault)
      crossings += step.crossing
      straightOnly = step.straightOnly
      if (seen.has(key(next))) faults.push(`comes back to ${show(next)}`)
      seen.add(key(next))
      length++
      at = next
    }
  }
  return { crossings, bends, length, faults }
}

class Heap {
  private readonly items: { cost: number; state: number }[] = []

  get size() {
    return this.items.length
  }

  push(cost: number, state: number) {
    const items = this.items
    items.push({ cost, state })
    let at = items.length - 1
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (items[parent].cost <= items[at].cost) break
      ;[items[parent], items[at]] = [items[at], items[parent]]
      at = parent
    }
  }

  pop(): { cost: number; state: number } {
    const items = this.items
    const top = items[0]
    const last = items.pop()!
    if (items.length) {
      items[0] = last
      let at = 0
      for (;;) {
        const l = 2 * at + 1
        const r = l + 1
        let least = at
        if (l < items.length && items[l].cost < items[least].cost) least = l
        if (r < items.length && items[r].cost < items[least].cost) least = r
        if (least === at) break
        ;[items[least], items[at]] = [items[at], items[least]]
        at = least
      }
    }
    return top
  }
}

const CROSSING_IN_BENDS = 1.5

export function bestShape(doc: Schematic, from: Point, to: Point, order: Order = "bends before length"): Shape | null {
  if (same(from, to)) return { crossings: 0, bends: 0, length: 0 }
  const scene = sceneOf(doc, from, to)
  const { window } = scene
  const columns = window.w / GRID + 1
  const rows = window.h / GRID + 1
  const indexOf = (p: Point) => {
    const i = (p.x - window.x) / GRID
    const j = (p.y - window.y) / GRID
    return i >= 0 && j >= 0 && i < columns && j < rows ? j * columns + i : -1
  }
  const pointOf = (cell: number): Point => ({ x: window.x + (cell % columns) * GRID, y: window.y + Math.floor(cell / columns) * GRID })
  const bendWeight = order === "bends before length" ? 1e4 : 1
  const lengthWeight = order === "bends before length" ? 1 : 1e3
  const best = new Map<number, number>()
  const shapes = new Map<number, Shape & { straightOnly: boolean }>()
  const heap = new Heap()
  const start = indexOf(from) * 5 + 4
  best.set(start, 0)
  shapes.set(start, { crossings: 0, bends: 0, length: 0, straightOnly: false })
  heap.push(0, start)
  while (heap.size) {
    const { cost, state } = heap.pop()
    if (cost > (best.get(state) ?? Infinity)) continue
    const cell = Math.floor(state / 5)
    const heading = state % 5
    const here = pointOf(cell)
    const shape = shapes.get(state)!
    if (same(here, to)) return { crossings: shape.crossings, bends: shape.bends, length: shape.length }
    for (let step = 0; step < 4; step++) {
      if (heading !== 4 && step === (heading + 2) % 4) continue
      const turned = heading !== 4 && step !== heading
      if (turned && shape.straightOnly) continue
      const d = STEPS[step]
      const next = { x: here.x + d.x * GRID, y: here.y + d.y * GRID }
      const at = indexOf(next)
      if (at < 0) continue
      const arrival = arrive(scene, here, d)
      if (arrival.fault) continue
      const nextShape = { crossings: shape.crossings + arrival.crossing, bends: shape.bends + (turned ? 1 : 0), length: shape.length + 1, straightOnly: arrival.straightOnly }
      const nextCost = (nextShape.crossings * CROSSING_IN_BENDS + nextShape.bends) * bendWeight + nextShape.length * lengthWeight
      const nextState = at * 5 + step
      if (nextCost >= (best.get(nextState) ?? Infinity)) continue
      best.set(nextState, nextCost)
      shapes.set(nextState, nextShape)
      heap.push(nextCost, nextState)
    }
  }
  return null
}

export const cells = (points: readonly Point[] | null | undefined) => points?.map((p) => [p.x / GRID, p.y / GRID] as const) ?? null
