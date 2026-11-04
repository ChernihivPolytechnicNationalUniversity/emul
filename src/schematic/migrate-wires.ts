import { GRID, objectIndex, objectPins, objectRect, ownBodies, resolvePinIn, routeObstacles, unionOf, type Point } from "./geometry"
import { frozenCandidates, hasDiagonal, isJunction, laidAgain, wirePins, type Lay } from "./freeze"
import { legacyNets } from "./nets"
import { getDef } from "./registry"
import { fieldRouter } from "./placement"
import { pinKey, type LegacySchematic, type LegacyWire, type PlacedObject, type Schematic } from "./types"
import { listed, nameOf, pinName, refOf } from "./upgrade-names"
import { clearOf, Conductors } from "./wires/conductors"
import { pinPartition, wireNets } from "./wires/graph"
import { normalise } from "./wires/normal-form"
import { HALF_CELL, onLattice, pointKey, seededIds, type WirePin, type WireSegment } from "./wires/segment"

export { corners, frozenCandidates, isJunction, JUNCTION, wirePins } from "./freeze"

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y

type Laid = Lay & { net: string; pts: Point[]; straightened: boolean }

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

function distinctIds(wires: readonly LegacyWire[]): LegacyWire[] {
  const seen = new Set<string>()
  return wires.map((w) => {
    let id = w.id
    while (seen.has(id)) id = `${id}~`
    seen.add(id)
    return id === w.id ? w : { ...w, id }
  })
}

const MOST_HALF_CELLS_OFF = 80

let offsets: [number, number][] | null = null

function offsetsByDistance(): [number, number][] {
  if (offsets) return offsets
  const out: [number, number][] = []
  for (let dx = -MOST_HALF_CELLS_OFF; dx <= MOST_HALF_CELLS_OFF; dx++) for (let dy = -MOST_HALF_CELLS_OFF; dy <= MOST_HALF_CELLS_OFF; dy++) out.push([dx, dy])
  offsets = out.sort((a, b) => a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2 || a[1] - b[1] || a[0] - b[0])
  return offsets
}

const QUARTERS = ["", "a quarter of a cell", "half a cell", "three quarters of a cell"]

const distanceIn = (dx: number, dy: number) => {
  const quarters = Math.max(1, Math.round((Math.hypot(dx, dy) / GRID) * 4))
  return quarters < 4 ? QUARTERS[quarters] : `${quarters / 4} cell${quarters === 4 ? "" : "s"}`
}

const onWholeCells = (p: Point) => Number.isInteger(p.x / GRID) && Number.isInteger(p.y / GRID)

const objectOf = (key: string) => key.slice(0, key.indexOf(":"))

type Why = (distance: string, byId: ReadonlyMap<string, PlacedObject>) => string

function offTheGrid(doc: LegacySchematic): Map<string, Why> {
  const out = new Map<string, Why>()
  for (const o of doc.objects) if (objectPins(o, GRID).some((p) => !onLattice(p.point))) out.set(o.id, (distance) => `${nameOf(o)} moved ${distance}: it stood off the grid, where no wire can end on its pins.`)
  return out
}

function onPadsOtherNetsUse(doc: LegacySchematic, netOf: (key: string) => string): Map<string, Why> {
  const real = new Set<string>()
  const at = new Map<string, { key: string; object: PlacedObject; nc: boolean }[]>()
  for (const o of doc.objects) {
    if (isJunction(o)) continue
    for (const p of objectPins(o, GRID)) {
      if (p.pin.kind !== "nc") real.add(netOf(p.key))
      const list = at.get(pointKey(p.point)) ?? []
      list.push({ key: p.key, object: o, nc: p.pin.kind === "nc" })
      at.set(pointKey(p.point), list)
    }
  }
  const out = new Map<string, Why>()
  for (const group of at.values()) {
    const pad = group.find((g) => g.nc)
    if (!pad || new Set(group.map((g) => netOf(g.key)).filter((net) => real.has(net))).size < 2) continue
    const stays = [...group].sort((a, b) => objectPins(b.object, GRID).length - objectPins(a.object, GRID).length)[0].object.id
    for (const g of group)
      if (g.object.id !== stays && !out.has(g.object.id))
        out.set(g.object.id, (distance, byId) => `${nameOf(g.object)} moved ${distance}: its pin ${g.key.slice(g.key.indexOf(":") + 1)} sat on ${pinName(pad.key, byId)}, a pad marked not connected that another net's wire uses, and a pin on a pad joins it now.`)
  }
  return out
}

function partsMoved(doc: LegacySchematic, why: ReadonlyMap<string, Why>, netOf: (key: string) => string, newId: () => string): { objects: PlacedObject[]; wires: LegacyWire[]; notes: string[] } {
  if (!why.size) return { objects: doc.objects, wires: doc.wires, notes: [] }
  const byId = objectIndex(doc.objects)
  const taken = new Map<string, string>()
  const take = (o: PlacedObject) => {
    for (const p of objectPins(o, GRID)) taken.set(pointKey(p.point), netOf(p.key))
  }
  for (const o of doc.objects) if (!why.has(o.id)) take(o)
  const touching = new Map<string, string>()
  const pinsAt = new Map<string, { key: string; nc: boolean }[]>()
  for (const o of doc.objects) for (const p of objectPins(o, GRID)) pinsAt.set(pointKey(p.point), [...(pinsAt.get(pointKey(p.point)) ?? []), { key: p.key, nc: p.pin.kind === "nc" }])
  for (const group of pinsAt.values())
    for (const a of group) {
      if (a.nc || touching.has(a.key)) continue
      const b = group.find((q) => q.key !== a.key && !q.nc && netOf(q.key) === netOf(a.key) && objectOf(q.key) !== objectOf(a.key))
      if (b && touching.get(b.key) !== a.key) touching.set(a.key, b.key)
    }
  const notes: string[] = []
  const objects = doc.objects.map((o) => {
    const reason = why.get(o.id)
    if (!reason) return o
    const onItsGrid = getDef(o.def)?.pinsAreSockets ? onLattice : onWholeCells
    const x0 = Math.round(o.x / HALF_CELL) * HALF_CELL
    const y0 = Math.round(o.y / HALF_CELL) * HALF_CELL
    const fits = (placed: PlacedObject) => objectPins(placed, GRID).every((p) => onItsGrid(p.point) && (taken.get(pointKey(p.point)) ?? netOf(p.key)) === netOf(p.key))
    let best: PlacedObject | null = null
    let nearest = Infinity
    let firstRing = Infinity
    for (const [dx, dy] of offsetsByDistance()) {
      const ring = Math.max(Math.abs(dx), Math.abs(dy))
      if (ring > firstRing + 1) break
      const placed = { ...o, x: x0 + dx * HALF_CELL, y: y0 + dy * HALF_CELL }
      const distance = Math.hypot(placed.x - o.x, placed.y - o.y)
      if (distance === 0 || distance >= nearest || !fits(placed)) continue
      best = placed
      nearest = distance
      firstRing = Math.min(firstRing, ring)
    }
    if (!best) return o
    take(best)
    notes.push(reason(distanceIn(best.x - o.x, best.y - o.y), byId))
    return best
  })
  const now = new Map(objects.map((o) => [o.id, o]))
  const pointOf = (key: string) => {
    const o = now.get(objectOf(key))!
    return pointKey(objectPins(o, GRID).find((p) => p.key === key)!.point)
  }
  const wires = [...doc.wires]
  for (const [a, b] of touching) {
    if ((!why.has(objectOf(a)) && !why.has(objectOf(b))) || pointOf(a) === pointOf(b)) continue
    wires.push({ id: newId(), from: refOf(a), to: refOf(b) })
    notes.push(`${pinName(a, byId)} and ${pinName(b, byId)} touched where they stood before; a wire joins them now.`)
  }
  return { objects, wires, notes }
}

const PASSES_STUCK_FIRST = 8

const FRUITLESS_PASSES = 2

export type FrozenWires = { doc: Schematic; notes: string[]; routes: ReadonlyMap<string, readonly Point[]>; faithful: boolean }

export function wiresAsSegments(saved: LegacySchematic, ids?: () => string): FrozenWires {
  const named = { ...saved, wires: distinctIds(saved.wires) }
  const newId = ids ?? seededIds([...named.objects.map((o) => o.id), ...named.wires.map((w) => w.id)], new Set(named.wires.map((w) => w.id)))
  const before = legacyNets(named.objects, named.wires, GRID)
  const oldNetOf = (key: string) => before.netOfPin(key) ?? key
  const placed = partsMoved(named, new Map([...offTheGrid(named), ...onPadsOtherNetsUse(named, oldNetOf)]), oldNetOf, newId)
  const doc = { ...named, objects: placed.objects, wires: placed.wires }
  const byId = objectIndex(doc.objects)
  const objects = doc.objects.filter((o) => !isJunction(o))
  const pins = wirePins(objects)
  const netOf = expectedNets(doc)
  const rejoined = throughMissingPins(doc, byId, newId)
  const field = new Conductors()
  const wiredEnds = new Set(rejoined.wires.flatMap((w) => [pinKey(w.from.object, w.from.pin), pinKey(w.to.object, w.to.pin)]))
  for (const p of pins) field.addFixed({ at: p.at, net: netOf(p.key), socket: !!p.socket && !wiredEnds.has(p.key) })
  for (const j of doc.objects.filter(isJunction)) for (const p of objectPins(j, GRID)) if (wiredEnds.has(p.key)) field.addFixed({ at: p.point, net: netOf(p.key), socket: false })
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
    laid.push({ wire, net, own: new Set([net]), from: from.point, to: to.point, fromObject: wire.from.object, toObject: wire.to.object, candidates, pts: candidates[0], straightened: hasDiagonal(route) })
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
  const pieceOf = (wire: string, k: number) => {
    let id = `${wire}~${k}`
    while (used.has(id)) id = `${id}~`
    return id
  }
  for (const l of laid)
    for (let k = 1; k < l.pts.length; k++) {
      const a = l.pts[k - 1]
      const b = l.pts[k]
      if (same(a, b)) continue
      const id = used.has(l.wire.id) ? pieceOf(l.wire.id, k) : l.wire.id
      used.add(id)
      segments.push(l.wire.color ? { id, a, b, color: l.wire.color } : { id, a, b })
    }
  const wires = normalise(segments, pins, undefined, newId)
  const upgraded: Schematic = { ...doc, objects, wires: [...wires] }
  const notes: string[] = [...placed.notes, ...rejoined.notes]
  const ends = (l: Laid) => `${pinName(pinKey(l.wire.from.object, l.wire.from.pin), byId)} and ${pinName(pinKey(l.wire.to.object, l.wire.to.pin), byId)}`
  for (const i of relaidWires)
    notes.push(
      laid[i].straightened
        ? `The wire between ${ends(laid[i])}, straightened where it left a pin at 45°, would have touched another net's wire or pin; it is laid again so the circuit stays as it was.`
        : `The wire between ${ends(laid[i])} ran over another net's wire or pin where it was drawn; it is laid again so the circuit stays as it was.`,
    )
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
