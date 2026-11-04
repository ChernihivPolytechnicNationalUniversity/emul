import { GRID, objectIndex, objectPins, objectRect, ownBodies, resolvePinIn, routeObstacles, unionOf, type Point } from "./geometry"
import { frozenCandidates, isJunction, laidAgain, wirePins, type Lay } from "./freeze"
import { legacyNets } from "./nets"
import { fieldRouter } from "./placement"
import { pinKey, type LegacySchematic, type LegacyWire, type PlacedObject, type Schematic } from "./types"
import { listed, nameOf, pinName } from "./upgrade-names"
import { clearOf, Conductors } from "./wires/conductors"
import { pinPartition, wireNets } from "./wires/graph"
import { normalise } from "./wires/normal-form"
import { pointKey, type WirePin, type WireSegment } from "./wires/segment"

export { corners, frozenCandidates, isJunction, JUNCTION, wirePins } from "./freeze"

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y

type Laid = Lay & { net: string; pts: Point[] }

function expectedNets(doc: LegacySchematic): (key: string) => string {
  const nets = legacyNets(doc.objects, doc.wires, GRID)
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k)
    if (p === undefined || p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  const join = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }
  const netOf = (key: string) => nets.netOfPin(key) ?? key
  const firstAt = new Map<string, string>()
  for (const o of doc.objects)
    for (const p of objectPins(o, GRID)) {
      const at = pointKey(p.point)
      const other = firstAt.get(at)
      if (other === undefined) firstAt.set(at, p.key)
      else join(netOf(other), netOf(p.key))
    }
  return (key) => find(netOf(key))
}

function throughMissingPins(doc: LegacySchematic, byId: ReadonlyMap<string, PlacedObject>, newId: () => string): { wires: LegacyWire[]; notes: string[] } {
  const real = (w: LegacyWire, end: "from" | "to") => !!resolvePinIn(byId, w[end], GRID)
  const ghostly = doc.wires.filter((w) => !real(w, "from") || !real(w, "to"))
  if (!ghostly.length) return { wires: doc.wires, notes: [] }
  const drawn = doc.wires.filter((w) => !ghostly.includes(w))
  const joined = expectedNets({ ...doc, wires: drawn })
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k)
    if (p === undefined || p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  const join = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const w of ghostly) join(pinKey(w.from.object, w.from.pin), pinKey(w.to.object, w.to.pin))
  const members = new Map<string, { key: string; ref: LegacyWire["from"] }[]>()
  const missing = new Map<string, string[]>()
  for (const w of ghostly)
    for (const end of ["from", "to"] as const) {
      const key = pinKey(w[end].object, w[end].pin)
      const root = find(key)
      if (real(w, end)) {
        const list = members.get(root) ?? []
        if (!list.some((m) => m.key === key)) list.push({ key, ref: w[end] })
        members.set(root, list)
      } else missing.set(root, [...new Set([...(missing.get(root) ?? []), key])])
    }
  const nets = new Map<string, string>()
  const netOf = (key: string) => {
    let net = joined(key)
    while (nets.has(net) && nets.get(net) !== net) net = nets.get(net)!
    return net
  }
  const wires = [...drawn]
  const notes: string[] = []
  for (const [root, list] of members) {
    const added: string[] = []
    for (const m of list.slice(1)) {
      const a = netOf(list[0].key)
      const b = netOf(m.key)
      if (a === b) continue
      nets.set(b, a)
      wires.push({ id: newId(), from: list[0].ref, to: m.ref })
      added.push(pinName(m.key, byId))
    }
    if (added.length) notes.push(`${pinName(list[0].key, byId)} was joined to ${listed(added)} through ${listed((missing.get(root) ?? []).map((key) => pinName(key, byId)))}, which ${(missing.get(root) ?? []).length === 1 ? "is" : "are"} not in the file any more; a wire joins them directly now.`)
  }
  return { wires, notes }
}

const PASSES_STUCK_FIRST = 8

const FRUITLESS_PASSES = 2

export type FrozenWires = { doc: Schematic; notes: string[]; routes: ReadonlyMap<string, readonly Point[]>; faithful: boolean }

export function wiresAsSegments(doc: LegacySchematic, newId: () => string = () => crypto.randomUUID()): FrozenWires {
  const byId = objectIndex(doc.objects)
  const objects = doc.objects.filter((o) => !isJunction(o))
  const pins = wirePins(objects)
  const netOf = expectedNets(doc)
  const rejoined = throughMissingPins(doc, byId, newId)
  const field = new Conductors()
  const wiredEnds = new Set(rejoined.wires.flatMap((w) => [pinKey(w.from.object, w.from.pin), pinKey(w.to.object, w.to.pin)]))
  for (const p of pins) field.addFixed({ at: p.at, net: netOf(p.key), socket: !!p.socket && !wiredEnds.has(p.key) })
  for (const j of doc.objects.filter(isJunction)) for (const p of objectPins(j, GRID)) field.addFixed({ at: p.point, net: netOf(p.key), socket: false })
  const routes = new Map(fieldRouter().routeAll(doc.objects, rejoined.wires, GRID).map((r) => [r.id, r.pts]))
  const laid: Laid[] = []
  for (const wire of rejoined.wires) {
    const route = routes.get(wire.id)
    const from = resolvePinIn(byId, wire.from, GRID)
    const to = resolvePinIn(byId, wire.to, GRID)
    if (!route || !from || !to) continue
    const bodies = [...routeObstacles(doc.objects, GRID, wire.from.object, wire.to.object), ...ownBodies(byId, GRID, wire.from.object, wire.to.object)]
    const candidates = frozenCandidates(route, bodies)
    const net = netOf(pinKey(wire.from.object, wire.from.pin))
    laid.push({ wire, net, own: new Set([net]), from: from.point, to: to.point, fromObject: wire.from.object, toObject: wire.to.object, candidates, pts: candidates[0] })
  }
  laid.forEach((l, i) => field.lay(i, l.net, l.pts))
  const offenders = new Set<number>()
  laid.forEach((l, i) => {
    const clash = field.clashes(l.own, l.pts)
    if (clash.points || clash.wires.size) offenders.add(i)
    for (const j of clash.wires) offenders.add(j)
  })
  for (const i of offenders) field.lift(i)
  const extent = unionOf(doc.objects.map((o) => objectRect(o, GRID)))
  const layInTurn = (order: readonly number[]) => {
    const relaid: number[] = []
    const stuck: number[] = []
    const pts = new Map<number, Point[]>()
    for (const i of order) {
      const l = laid[i]
      const kept = l.candidates.find((c) => clearOf(field, l.own, c))
      const found = kept ?? laidAgain(l, byId, doc.objects, field, extent)
      if (!kept && found) relaid.push(i)
      if (!found) stuck.push(i)
      pts.set(i, found ?? l.candidates[0])
      field.lay(i, l.net, pts.get(i)!)
    }
    return { relaid, stuck, pts }
  }
  let order = [...offenders].sort((a, b) => a - b)
  let last = layInTurn(order)
  let best = last
  let fruitless = 0
  for (let pass = 1; pass < PASSES_STUCK_FIRST && best.stuck.length && fruitless < FRUITLESS_PASSES; pass++) {
    for (const i of order) field.lift(i)
    const stuckNow = new Set(last.stuck)
    order = [...last.stuck, ...order.filter((i) => !stuckNow.has(i))]
    last = layInTurn(order)
    if (last.stuck.length < best.stuck.length) {
      best = last
      fruitless = 0
    } else fruitless++
  }
  for (const [i, pts] of best.pts) laid[i].pts = pts
  const relaidWires = best.relaid.sort((a, b) => a - b)
  const stuck = best.stuck.sort((a, b) => a - b)
  const segments: WireSegment[] = []
  const used = new Set<string>()
  for (const l of laid)
    for (let k = 1; k < l.pts.length; k++) {
      const a = l.pts[k - 1]
      const b = l.pts[k]
      if (same(a, b)) continue
      const id = used.has(l.wire.id) ? `${l.wire.id}~${k}` : l.wire.id
      used.add(id)
      segments.push(l.wire.color ? { id, a, b, color: l.wire.color } : { id, a, b })
    }
  const wires = normalise(segments, pins, undefined, newId)
  const upgraded: Schematic = { ...doc, objects, wires: [...wires] }
  const notes: string[] = [...rejoined.notes]
  const ends = (l: Laid) => `${pinName(pinKey(l.wire.from.object, l.wire.from.pin), byId)} and ${pinName(pinKey(l.wire.to.object, l.wire.to.pin), byId)}`
  for (const i of relaidWires) notes.push(`The wire between ${ends(laid[i])} ran over another net's wire or pin where it was drawn; it is laid again so the circuit stays as it was.`)
  for (const i of stuck) notes.push(`The wire between ${ends(laid[i])} could not be laid clear of another net: check its connections.`)
  const astray = astrayParts(upgraded, pins, netOf, byId)
  if (astray.length) notes.push(`The circuit round ${listed(astray)} could not be kept exactly: check its connections.`)
  return { doc: upgraded, notes, routes: new Map(laid.map((l) => [l.wire.id, l.pts])), faithful: !astray.length }
}

function astrayParts(upgraded: Schematic, pins: readonly WirePin[], netOf: (key: string) => string, byId: ReadonlyMap<string, PlacedObject>): string[] {
  const now = new Map<string, string>()
  for (const group of pinPartition(wireNets(upgraded.wires, pins))) for (const key of group) now.set(key, group[0])
  const was = new Map<string, string[]>()
  for (const p of pins) was.set(netOf(p.key), [...(was.get(netOf(p.key)) ?? []), p.key])
  const firstOf = new Map<string, string>()
  for (const group of was.values()) {
    const sorted = [...group].sort()
    for (const key of sorted) firstOf.set(key, sorted[0])
  }
  const wrong = new Set<string>()
  const groupNow = new Map<string, string[]>()
  for (const p of pins) {
    const n = now.get(p.key) ?? p.key
    groupNow.set(n, [...(groupNow.get(n) ?? []), p.key])
  }
  for (const group of groupNow.values()) {
    const owners = new Set(group.map((key) => firstOf.get(key)))
    if (owners.size > 1) for (const key of group) wrong.add(key)
  }
  for (const group of was.values()) {
    const owners = new Set(group.map((key) => now.get(key) ?? key))
    if (owners.size > 1) for (const key of group) wrong.add(key)
  }
  return [...new Set([...wrong].map((key) => key.slice(0, key.indexOf(":"))))].flatMap((id) => (byId.has(id) ? [nameOf(byId.get(id)!)] : [])).sort()
}
