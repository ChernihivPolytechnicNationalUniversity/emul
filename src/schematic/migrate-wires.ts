import { GRID, objectIndex, objectPins, objectRect, resolvePinIn, unionOf, type Point } from "./geometry"
import { corners, isJunction, laidAgain, wirePins, type Lay } from "./freeze"
import { pinContacts } from "./contacts"
import { legacyNets } from "./nets"
import { bodiesOf, closedBodies, crossable, runsThrough } from "./body-crossing"
import { getDef } from "./registry"
import { pinKey, type LegacySchematic, type LegacyWire, type PlacedObject, type Schematic } from "./types"
import { listed, nameOf, pinName, refOf } from "./upgrade-names"
import { clearOf, Conductors } from "./wires/conductors"
import { pinPartition, WireGraph, wireNets } from "./wires/graph"
import { normalise } from "./wires/normal-form"
import { HALF_CELL, onLattice, passesInside, pointKey, seededIds, type WirePin, type WireSegment } from "./wires/segment"
import { routeThroughBends, type RouteEnd } from "./wires/router"
import { wiringOf } from "./wire-edits"

export { corners, isJunction, JUNCTION, wirePins } from "./freeze"

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y

function asDrawn(through: readonly Point[]): Point[] {
  const out: Point[] = [through[0]]
  for (const p of through.slice(1)) {
    const last = out[out.length - 1]
    if (last.x !== p.x && last.y !== p.y) out.push({ x: p.x, y: last.y })
    out.push(p)
  }
  return corners(out)
}

type Laid = Lay & { net: string; pts: Point[]; ends: readonly [RouteEnd, RouteEnd] }

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

const CONTACT_TOLERANCE = 0.01

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
  const joined = new Map<string, string>()
  const root = (net: string): string => {
    const up = joined.get(net)
    if (up === undefined || up === net) return net
    const top = root(up)
    joined.set(net, top)
    return top
  }
  const touchesAPad = [...at.values()].filter((group) => group.length > 1 && group.some((g) => g.nc))
  for (const group of touchesAPad) for (const g of group.slice(1)) {
    const a = root(netOf(group[0].key))
    const b = root(netOf(g.key))
    if (a !== b) joined.set(a < b ? b : a, a < b ? a : b)
  }
  const realNets = new Map<string, Set<string>>()
  for (const net of real) realNets.set(root(net), (realNets.get(root(net)) ?? new Set()).add(net))
  const out = new Map<string, Why>()
  for (const group of touchesAPad) {
    if ((realNets.get(root(netOf(group[0].key)))?.size ?? 0) < 2) continue
    const pad = group.find((g) => g.nc)!
    const stays = [...group].sort((a, b) => objectPins(b.object, GRID).length - objectPins(a.object, GRID).length)[0].object.id
    for (const g of group)
      if (g.object.id !== stays && !out.has(g.object.id))
        out.set(g.object.id, (distance, byId) => `${nameOf(g.object)} moved ${distance}: its pin ${g.key.slice(g.key.indexOf(":") + 1)} sat on ${pinName(pad.key, byId)}, a pad marked not connected that joins it to another net, and a pin on a pad joins it now.`)
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
  const contactGroups = new Map<string, string[]>()
  for (const [key, group] of pinContacts(doc.objects, GRID).groups) contactGroups.set(group, [...(contactGroups.get(group) ?? []), key])
  for (const group of contactGroups.values())
    for (const a of group) {
      if (touching.has(a)) continue
      const b = group.find((q) => objectOf(q) !== objectOf(a))
      if (b && touching.get(b) !== a) touching.set(a, b)
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
  const pointOf = (key: string) => objectPins(now.get(objectOf(key))!, GRID).find((p) => p.key === key)!.point
  const stillTouching = (a: string, b: string) => {
    const p = pointOf(a)
    const q = pointOf(b)
    return Math.abs(p.x - q.x) < CONTACT_TOLERANCE && Math.abs(p.y - q.y) < CONTACT_TOLERANCE
  }
  const wires = [...doc.wires]
  for (const [a, b] of touching) {
    if ((!why.has(objectOf(a)) && !why.has(objectOf(b))) || stillTouching(a, b)) continue
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
  const wiredEnds = new Set(rejoined.wires.flatMap((w) => [pinKey(w.from.object, w.from.pin), pinKey(w.to.object, w.to.pin)]))
  const wiredSockets = new Set(pins.filter((p) => p.socket && wiredEnds.has(p.key)).map((p) => p.key))
  const hubs = new Map(doc.objects.filter(isJunction).map((j) => [j.id, j]))
  const hubPins = [...hubs.values()].flatMap((j) => objectPins(j, GRID).filter((p) => wiredEnds.has(p.key)).map((p) => ({ at: p.point, net: netOf(p.key) })))
  const wiring = wiringOf(new WireGraph(), { objects, wires: [], ...(doc.library && { library: doc.library }) })
  const endOf = (ref: LegacyWire["from"], point: Point): RouteEnd => (hubs.has(ref.object) ? { at: point } : { pin: ref })
  const laid: Laid[] = []
  for (const wire of rejoined.wires) {
    const from = resolvePinIn(byId, wire.from, GRID)
    const to = resolvePinIn(byId, wire.to, GRID)
    if (!from || !to) continue
    const net = netOf(pinKey(wire.from.object, wire.from.pin))
    const drawn = asDrawn([from.point, ...(wire.points ?? []), to.point])
    laid.push({ wire, net, own: new Set([net]), from: from.point, to: to.point, fromObject: wire.from.object, toObject: wire.to.object, candidates: [drawn], pts: drawn, ends: [endOf(wire.from, from.point), endOf(wire.to, to.point)] })
  }
  const extent = unionOf(doc.objects.map((o) => objectRect(o, GRID)))
  const closed = closedBodies(objects)
  const layInTurn = (order: readonly number[]) => {
    const field = new Conductors()
    for (const p of pins) field.addFixed({ at: p.at, net: netOf(p.key), socket: !!p.socket && !wiredEnds.has(p.key), ...(p.out && !p.shunt && { along: p.out }) })
    for (const j of hubs.values()) for (const p of objectPins(j, GRID)) if (wiredEnds.has(p.key)) field.addFixed({ at: p.point, net: netOf(p.key), socket: false })
    const segments: { net: string; segment: WireSegment }[] = []
    const relaid: number[] = []
    const unbent: number[] = []
    const stuck: number[] = []
    const crossed = new Map<number, string[]>()
    const pts = new Map<number, Point[]>()
    const routed = (l: Laid, bends: readonly Point[]) => {
      const stops = hubPins.filter((h) => h.net !== l.net).map((h) => h.at)
      const around = { extra: segments.filter((s) => s.net !== l.net).map((s) => s.segment), own: segments.filter((s) => s.net === l.net).map((s) => s.segment), taken: wiredSockets, stops, passable: (pin: WirePin) => !pin.socket && netOf(pin.key) === l.net }
      const route = routeThroughBends(wiring, l.ends[0], l.ends[1], bends, around, (key) => netOf(key) === l.net)
      return route && clearOf(field, l.own, route) ? corners(route) : null
    }
    for (const i of order) {
      const l = laid[i]
      const bends = l.wire.points ?? []
      const throughBends = routed(l, bends)
      const clean = throughBends ?? (bends.length ? routed(l, []) : null)
      const again = clean ? null : laidAgain(l, byId, doc.objects, field, extent, closed)
      const found = clean ?? again?.path ?? null
      if (again && !again.strict) crossed.set(i, whatItCrosses(again.path, byId, objects, pins))
      if (!throughBends && clean) unbent.push(i)
      if (!clean && found) relaid.push(i)
      if (!found) stuck.push(i)
      const kept = found ?? l.pts
      pts.set(i, kept)
      field.lay(i, l.net, kept)
      for (let k = 1; k < kept.length; k++) segments.push({ net: l.net, segment: { id: `${i}.${k}`, a: kept[k - 1], b: kept[k] } })
    }
    return { relaid, unbent, stuck, pts, crossed }
  }
  let order = laid.map((_, i) => i)
  let last = layInTurn(order)
  let best = last
  let fruitless = 0
  for (let pass = 1; pass < PASSES_STUCK_FIRST && best.stuck.length && fruitless < FRUITLESS_PASSES; pass++) {
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
  const unbentWires = best.unbent.sort((a, b) => a - b)
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
  for (const i of [...unbentWires, ...relaidWires].sort((a, b) => a - b)) {
    const through = best.crossed.get(i)
    notes.push(`The wire between ${ends(laid[i])} ran over another net's wire or pin where it was drawn; it is laid again so the circuit stays as it was${through?.length ? `, though only across ${listed(through)}: check it` : ""}.`)
  }
  for (const i of stuck) notes.push(`The wire between ${ends(laid[i])} could not be laid clear of another net: check its connections.`)
  const astray = astrayParts(upgraded, pins.filter((p) => p.kind !== "nc"), oldNetOf, objectIndex([...saved.objects, ...doc.objects]))
  if (astray.length) notes.push(`The circuit round ${listed(astray)} could not be kept exactly: check its connections.`)
  return { doc: upgraded, notes, routes: new Map(laid.map((l) => [l.wire.id, l.pts])), faithful: !astray.length }
}

const acrossItsRow = (socket: WirePin, horizontal: boolean) => !socket.out || !!socket.shunt || (horizontal ? socket.out.x === 0 : socket.out.y === 0)

function whatItCrosses(path: readonly Point[], byId: ReadonlyMap<string, PlacedObject>, objects: readonly PlacedObject[], pins: readonly WirePin[]): string[] {
  const bodies = bodiesOf(objects).filter(crossable)
  const sockets = pins.filter((p) => p.socket)
  const found = new Set<string>()
  for (let i = 1; i < path.length; i++) {
    const s = { a: path[i - 1], b: path[i] }
    for (const body of bodies) if (runsThrough(s, body)) found.add(`${nameOf(body.object)}'s body`)
    for (const p of sockets) if (passesInside(s, p.at) && acrossItsRow(p, s.a.y === s.b.y)) found.add(`${nameOf(byId.get(refOf(p.key).object)!)}'s sockets`)
  }
  return [...found].sort()
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
