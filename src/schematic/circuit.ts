import { wirePins } from "./migrate-wires"
import { withLibrary } from "./registry"
import type { HdlModule, PlacedObject, Point, Schematic } from "./types"
import { pinPartition, wireNets } from "./wires/graph"
import { pointKey, samePoint, type WirePin, type WireSegment } from "./wires/segment"

export type Run = { id: string; segments: readonly WireSegment[]; points: readonly Point[] }

export type FlowRun = { id: string; a: string; b: string }

export type FlowGraph = { runs: readonly FlowRun[]; pins: Readonly<Record<string, string>> }

export type Circuit = { objects: readonly PlacedObject[]; library?: HdlModule[]; nets: readonly (readonly string[])[]; wired: readonly string[]; flow: FlowGraph }

export const isCircuit = (doc: Schematic | Circuit): doc is Circuit => "nets" in doc

const other = (s: WireSegment, p: Point) => (samePoint(s.a, p) ? s.b : s.a)

export function runsOf(wires: readonly WireSegment[], pins: readonly WirePin[]): Run[] {
  if (wires.length === 1) {
    const segment = wires[0]
    const points = [segment.a, segment.b]
    return [{ id: segment.id, segments: [segment], points: backwards(points) ? points.reverse() : points }]
  }
  const ends = new Map<string, WireSegment[]>()
  for (const s of wires)
    for (const p of [s.a, s.b]) {
      const key = pointKey(p)
      const list = ends.get(key)
      if (list) list.push(s)
      else ends.set(key, [s])
    }
  const pinned = new Set(pins.map((p) => pointKey(p.at)))
  const through = (p: Point) => {
    const key = pointKey(p)
    const list = ends.get(key)!
    return list.length === 2 && !pinned.has(key) && list[0].color === list[1].color ? list : null
  }
  const seen = new Set<WireSegment>()
  const walk = (from: Point, via: WireSegment, chain: WireSegment[]): Point[] => {
    const out: Point[] = []
    let at = from
    let seg = via
    for (;;) {
      const pair = through(at)
      const next = pair && (pair[0] === seg ? pair[1] : pair[0])
      if (!next || seen.has(next)) return out
      seen.add(next)
      chain.push(next)
      at = other(next, at)
      out.push(at)
      seg = next
    }
  }
  const runs: Run[] = []
  for (const s of wires) {
    if (seen.has(s)) continue
    seen.add(s)
    const before: WireSegment[] = []
    const after: WireSegment[] = []
    const back = walk(s.a, s, before)
    const ahead = walk(s.b, s, after)
    const segments = [...before.reverse(), s, ...after]
    let id = s.id
    for (const t of segments) if (t.id < id) id = t.id
    const points = [...back.reverse(), s.a, s.b, ...ahead]
    runs.push(backwards(points) ? { id, segments: segments.reverse(), points: points.reverse() } : { id, segments, points })
  }
  return runs
}

const before = (p: Point, q: Point) => p.x < q.x || (p.x === q.x && p.y < q.y)

function backwards(points: readonly Point[]): boolean {
  const first = points[0]
  const last = points[points.length - 1]
  if (!samePoint(first, last)) return before(last, first)
  return points.length > 2 && before(points[points.length - 2], points[1])
}

export function flowVertices(runs: readonly Run[], pins: readonly WirePin[]): { runs: FlowRun[]; pins: (readonly [string, string])[] } {
  const names = new Map<string, string>()
  const offer = (at: Point, name: string) => {
    const key = pointKey(at)
    const was = names.get(key)
    if (was === undefined || name < was) names.set(key, name)
  }
  for (const p of pins) offer(p.at, `p:${p.key}`)
  for (const r of runs) {
    offer(r.points[0], `r:${r.id}:a`)
    offer(r.points[r.points.length - 1], `r:${r.id}:b`)
  }
  const nameAt = (at: Point) => names.get(pointKey(at))!
  return {
    runs: runs.map((r) => ({ id: r.id, a: nameAt(r.points[0]), b: nameAt(r.points[r.points.length - 1]) })),
    pins: pins.map((p) => [p.key, nameAt(p.at)] as const),
  }
}

export function flowGraph(runs: readonly Run[], pins: readonly WirePin[]): FlowGraph {
  const vertices = flowVertices(runs, pins)
  return { runs: vertices.runs, pins: Object.fromEntries(vertices.pins) }
}

export function circuitOf(doc: Pick<Schematic, "objects" | "wires" | "library">): Circuit {
  return withLibrary(doc.library, () => {
    const pins = wirePins(doc.objects)
    const view = wireNets(doc.wires, pins)
    const ends = new Set(doc.wires.flatMap((s) => [pointKey(s.a), pointKey(s.b)]))
    const wired = pins.filter((p) => ends.has(pointKey(p.at))).map((p) => p.key).sort()
    const wiredNets = new Set(doc.wires.map((s) => view.netOfSegment(s.id)))
    const flowPins = pins.filter((p) => wiredNets.has(view.netOfPin(p.key)))
    return { objects: doc.objects, library: doc.library, nets: pinPartition(view), wired, flow: flowGraph(runsOf(doc.wires, pins), flowPins) }
  })
}

export const circuitIn = (doc: Schematic | Circuit): Circuit => (isCircuit(doc) ? doc : circuitOf(doc))
