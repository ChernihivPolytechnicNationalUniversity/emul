import { buildNets } from "@/schematic/nets"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Point, Schematic } from "@/schematic/types"

export type Partition = string[][]

const JUNCTION = "junction"

export const isJunctionObject = (o: PlacedObject) => o.def === JUNCTION

export function stableNames(objects: readonly PlacedObject[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  const taken = new Map<string, number>()
  const unnamed = new Map<string, number>()
  for (const o of objects) {
    const ref = o.props?.ref
    let name: string
    if (ref) {
      const seen = (taken.get(ref) ?? 0) + 1
      taken.set(ref, seen)
      name = seen === 1 ? ref : `${ref}#${seen}`
    } else {
      const n = (unnamed.get(o.def) ?? 0) + 1
      unnamed.set(o.def, n)
      name = `${o.def}#${n}`
    }
    names.set(o.id, name)
  }
  return names
}

export function duplicateRefs(objects: readonly PlacedObject[]): string[] {
  const seen = new Map<string, number>()
  for (const o of objects) if (o.props?.ref) seen.set(o.props.ref, (seen.get(o.props.ref) ?? 0) + 1)
  return [...seen].filter(([, n]) => n > 1).map(([ref]) => ref)
}

const byKey = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true })

export function canonical(groups: Iterable<Iterable<string>>): Partition {
  return [...groups]
    .map((g) => [...new Set(g)].sort(byKey))
    .filter((g) => g.length > 1)
    .sort((a, b) => byKey(a[0], b[0]))
}

export function renamed(objects: readonly PlacedObject[], groups: Iterable<Iterable<string>>): Partition {
  const names = stableNames(objects)
  const junctions = new Set(objects.filter(isJunctionObject).map((o) => o.id))
  const keyOf = (key: string) => {
    const split = key.indexOf(":")
    const object = key.slice(0, split)
    if (junctions.has(object)) return null
    return `${names.get(object) ?? object}.${key.slice(split + 1)}`
  }
  return canonical([...groups].map((g) => [...g].flatMap((k) => keyOf(k) ?? [])))
}

export function pinPartition(doc: Schematic, grid: number): Partition {
  const nets = buildNets(doc.objects, doc.wires, grid)
  const groups = new Map<string, string[]>()
  for (const o of doc.objects) {
    const def = getDef(o.def)
    for (const pin of def?.pins ?? []) {
      const key = `${o.id}:${pin.id}`
      const net = nets.netOfPin(key)
      if (net === undefined) continue
      const group = groups.get(net)
      if (group) group.push(key)
      else groups.set(net, [key])
    }
  }
  return renamed(doc.objects, groups.values())
}

export type RefPin = { key: string; at: Point; socket?: boolean }
export type RefSegment = { a: Point; b: Point }

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y

const isEndOf = (p: Point, s: RefSegment) => same(p, s.a) || same(p, s.b)

const LEGACY_DIAGONAL_SLACK = 1e-6

function onSegment(p: Point, s: RefSegment): boolean {
  if (s.a.y === s.b.y) return p.y === s.a.y && p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x)
  if (s.a.x === s.b.x) return p.x === s.a.x && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y)
  if (isEndOf(p, s)) return true
  const cross = (s.b.x - s.a.x) * (p.y - s.a.y) - (s.b.y - s.a.y) * (p.x - s.a.x)
  const within = p.x >= Math.min(s.a.x, s.b.x) && p.x <= Math.max(s.a.x, s.b.x) && p.y >= Math.min(s.a.y, s.b.y) && p.y <= Math.max(s.a.y, s.b.y)
  return within && Math.abs(cross) <= LEGACY_DIAGONAL_SLACK * Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y)
}

export function pinOnSegmentConnects(pin: RefPin, s: RefSegment): boolean {
  if (!onSegment(pin.at, s)) return false
  return !pin.socket || isEndOf(pin.at, s)
}

export const segmentsConnect = (s: RefSegment, t: RefSegment) => onSegment(s.a, t) || onSegment(s.b, t) || onSegment(t.a, s) || onSegment(t.b, s)

export function geometricGroups(pins: readonly RefPin[], segments: readonly RefSegment[]): string[][] {
  const n = pins.length + segments.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (i: number, j: number) => {
    const a = find(i)
    const b = find(j)
    if (a !== b) parent[a] = b
  }
  const P = pins.length
  for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) if (same(pins[i].at, pins[j].at)) union(i, j)
  for (let i = 0; i < P; i++) for (let s = 0; s < segments.length; s++) if (pinOnSegmentConnects(pins[i], segments[s])) union(i, P + s)
  for (let s = 0; s < segments.length; s++) for (let t = s + 1; t < segments.length; t++) if (segmentsConnect(segments[s], segments[t])) union(P + s, P + t)
  const groups = new Map<number, string[]>()
  for (let i = 0; i < P; i++) {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(pins[i].key)
    else groups.set(root, [pins[i].key])
  }
  return [...groups.values()]
}

const runsOn = (p: Point, q: Point, r: Point) => (p.x === q.x && q.x === r.x && Math.sign(q.y - p.y) === Math.sign(r.y - q.y)) || (p.y === q.y && q.y === r.y && Math.sign(q.x - p.x) === Math.sign(r.x - q.x))

export function polylineSegments(pts: readonly Point[]): RefSegment[] {
  const corners: Point[] = []
  for (const p of pts) {
    if (corners.length && same(corners[corners.length - 1], p)) continue
    if (corners.length > 1 && runsOn(corners[corners.length - 2], corners[corners.length - 1], p)) corners[corners.length - 1] = p
    else corners.push(p)
  }
  const out: RefSegment[] = []
  for (let i = 1; i < corners.length; i++) out.push({ a: corners[i - 1], b: corners[i] })
  return out
}

export function partitionDiff(want: Partition, got: Partition): { missing: string[][]; extra: string[][] } {
  const key = (g: string[]) => g.join(" ")
  const wanted = new Set(want.map(key))
  const gotten = new Set(got.map(key))
  return { missing: want.filter((g) => !gotten.has(key(g))), extra: got.filter((g) => !wanted.has(key(g))) }
}
