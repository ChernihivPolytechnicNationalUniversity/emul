import { flowVertices, runsOf, type Circuit, type FlowRun, type Run } from "./circuit"
import { frozenCandidates, JUNCTION, laidAgain } from "./freeze"
import { GRID, objectIndex, objectPins, objectRect, ownBodies, routeObstacles, snap, unionOf, type Point, type RoutedWire } from "./geometry"
import type { NetMap } from "./nets"
import { leadEnd, turnsAtPins, type PinCorner, type TurnPins } from "./wire-look"
import { fieldRouter } from "./placement"
import { getLibraryVersion, withLibrary } from "./registry"
import type { HdlModule, LegacyWire, PartState, PinRef, PlacedObject, Schematic } from "./types"
import type { WireColorKey } from "./wire-colors"
import { clearOf, Conductors } from "./wires/conductors"
import { WireGraph, type WireNets } from "./wires/graph"
import { OverlayMap } from "./wires/overlay-map"
import { lineCodeOf, columnCode, rowCode, WireSheet } from "./wires/sheet"
import { commitEdit, normalise, normaliseEdit } from "./wires/normal-form"
import { splicedAt } from "./splice"
import { contains, exactPointCode, highOf, lowOf, samePoint, seededIds, type PointCode, type WirePin, type WireSegment } from "./wires/segment"

export { pinsOf } from "./pin-index"
import { documentPins, editedObjects, translatedObjects, translationOf, pinsOf, type PinState } from "./pin-index"

const graphs = new WeakMap<readonly WireSegment[], { pins: readonly PlacedObject[]; definitions: number; view: WireNets }>()

export function viewOf(doc: Pick<Schematic, "objects" | "wires">, graph?: WireGraph): WireNets {
  if (graph) return graph.of(doc.wires, pinsOf(doc.objects))
  const known = graphs.get(doc.wires)
  const definitions = getLibraryVersion()
  if (known && known.pins === doc.objects && known.definitions === definitions) return known.view
  const view = new WireGraph().of(doc.wires, pinsOf(doc.objects))
  graphs.set(doc.wires, { pins: doc.objects, definitions, view })
  return view
}

export type NewId = () => string

const randomId: NewId = () => crypto.randomUUID()

const segmentsAlong = (pts: readonly Point[], color: WireColorKey | undefined, newId: NewId): WireSegment[] => {
  const out: WireSegment[] = []
  for (let i = 1; i < pts.length; i++) if (!samePoint(pts[i - 1], pts[i])) out.push(color ? { id: newId(), a: pts[i - 1], b: pts[i], color } : { id: newId(), a: pts[i - 1], b: pts[i] })
  return out
}

function conductorsOf(doc: Schematic, view: WireNets, pins: readonly WirePin[]): Conductors {
  const conductors = new Conductors()
  for (const p of pins) conductors.addFixed({ at: p.at, net: view.netOfPin(p.key) ?? `pin:${p.key}`, socket: !!p.socket })
  doc.wires.forEach((s, i) => conductors.lay(i, view.netOfSegment(s.id) ?? `wire:${s.id}`, [s.a, s.b]))
  return conductors
}

function laid(doc: Schematic, wire: LegacyWire, own: ReadonlySet<string>, objects: readonly PlacedObject[], view: WireNets, pins: readonly WirePin[]): Point[] | null {
  const byId = objectIndex(objects)
  const route = fieldRouter().routeAll(objects, [wire], GRID)[0]
  const fromPin = objectPins(byId.get(wire.from.object)!, GRID).find((p) => p.pin.id === wire.from.pin)
  const toPin = objectPins(byId.get(wire.to.object)!, GRID).find((p) => p.pin.id === wire.to.pin)
  if (!route || !fromPin || !toPin) return null
  const conductors = conductorsOf(doc, view, pins)
  const bodies = [...routeObstacles(objects, GRID, wire.from.object, wire.to.object), ...ownBodies(byId, GRID, wire.from.object, wire.to.object)]
  const candidates = frozenCandidates(route.pts, bodies)
  const clean = candidates.find((c) => clearOf(conductors, own, c))
  if (clean) return clean
  const extent = unionOf(objects.map((o) => objectRect(o, GRID)))
  return laidAgain({ wire, own, from: fromPin.point, to: toPin.point, fromObject: wire.from.object, toObject: wire.to.object, candidates }, byId, objects, conductors, extent)
}

const netOrSelf = (view: WireNets, key: string) => view.netOfPin(key) ?? `pin:${key}`

type Committed = { added: readonly WireSegment[]; removed: readonly WireSegment[] }
type Revision = { previous?: WeakRef<Revision>; edit?: Committed }

const committed = new WeakMap<readonly WireSegment[], Revision>()

function revisionOf(wires: readonly WireSegment[]): Revision {
  let revision = committed.get(wires)
  if (!revision) committed.set(wires, revision = {})
  return revision
}

const wireOrders = new WeakMap<readonly WireSegment[], ReadonlyMap<WireSegment, number>>()
const orderParents = new WeakMap<ReadonlyMap<WireSegment, number>, object>()
const orderIdentities = new WeakMap<ReadonlyMap<WireSegment, number>, object>()

function orderIdentity(order: ReadonlyMap<WireSegment, number>): object {
  let identity = orderIdentities.get(order)
  if (!identity) orderIdentities.set(order, identity = {})
  return identity
}

export function wireOrder(wires: readonly WireSegment[]): ReadonlyMap<WireSegment, number> {
  let order = wireOrders.get(wires)
  if (!order) wireOrders.set(wires, order = new Map(wires.map((s, i) => [s, i])))
  return order
}

export const keepsRanks = (order: ReadonlyMap<WireSegment, number>, previous: ReadonlyMap<WireSegment, number>) => order === previous || orderParents.get(order) === orderIdentity(previous)

export function withSegments(doc: Schematic, add: readonly WireSegment[], remove: readonly WireSegment[] = [], points: readonly Point[] = [], newId: NewId = randomId): Schematic {
  if (!add.length && !remove.length && !points.length) return doc
  if (!doc.wires.length && !add.length) return doc
  const result = doc.objects.length <= 64 && doc.wires.length <= 200 ? commitEdit(doc.wires, pinsOf(doc.objects), { add, remove, points }, newId) : localCommit(doc, add, remove, points, newId)
  if (!result.added.length && !result.removed.length && !add.length && !remove.length) return doc
  if (result.wires === doc.wires) return doc
  const wires = result.wires as WireSegment[]
  committed.set(wires, { previous: new WeakRef(revisionOf(doc.wires)), edit: { added: result.added, removed: result.removed } })
  return { ...doc, wires }
}

const latestSheets = new WeakMap<Revision, WireSheet>()
const sheetSources = new WeakMap<WireSheet, Revision>()

export function keepSheet(wires: readonly WireSegment[], sheet: WireSheet) {
  const revision = revisionOf(wires)
  latestSheets.set(revision, sheet)
  sheetSources.set(sheet, revision)
}

function nearbySheet(wires: readonly WireSegment[]) {
  let source = revisionOf(wires)
  const steps: Committed[] = []
  for (let i = 0; i < 16; i++) {
    const held = latestSheets.get(source)
    if (held && sheetSources.get(held) === source) return { sheet: held, steps: steps.reverse() }
    const previous = source.previous?.deref()
    if (!source.edit || !previous) return undefined
    steps.push(source.edit)
    source = previous
  }
}

export function segmentsOnLine(wires: readonly WireSegment[], line: number, lo: number, hi: number): readonly WireSegment[] {
  return segmentsFrom(wires, nearbySheet(wires), line, lo, hi)
}

function segmentsFrom(wires: readonly WireSegment[], known: ReturnType<typeof nearbySheet>, line: number, lo: number, hi: number): readonly WireSegment[] {
  if (known && !known.steps.length) return known.sheet.along(line, lo, hi)
  if (!known) return wires.filter((s) => lineCodeOf(s) === line && Math.min(s.a.x === s.b.x ? s.a.y : s.a.x, s.a.x === s.b.x ? s.b.y : s.b.x) <= hi && Math.max(s.a.x === s.b.x ? s.a.y : s.a.x, s.a.x === s.b.x ? s.b.y : s.b.x) >= lo)
  const out = new Set(known.sheet.along(line, lo, hi))
  for (const step of known.steps) {
    for (const s of step.removed) out.delete(s)
    for (const s of step.added) if (lineCodeOf(s) === line && (s.a.x === s.b.x ? Math.min(s.a.y, s.b.y) <= hi && Math.max(s.a.y, s.b.y) >= lo : Math.min(s.a.x, s.b.x) <= hi && Math.max(s.a.x, s.b.x) >= lo)) out.add(s)
  }
  return [...out]
}

function positionOf(wires: readonly WireSegment[], order: ReadonlyMap<WireSegment, number>, segment: WireSegment): number {
  const rank = order.get(segment)
  if (rank === undefined) return -1
  let lo = 0
  let hi = wires.length
  while (lo < hi) {
    const middle = (lo + hi) >> 1
    if (order.get(wires[middle])! < rank) lo = middle + 1
    else hi = middle
  }
  return wires[lo] === segment ? lo : wires.indexOf(segment)
}

function localCommit(doc: Schematic, add: readonly WireSegment[], remove: readonly WireSegment[], points: readonly Point[], newId: NewId) {
  const known = nearbySheet(doc.wires)
  const near = new Set<WireSegment>()
  const visited = new Set<PointCode>()
  const along = (line: number, lo: number, hi: number) => segmentsFrom(doc.wires, known, line, lo, hi)
  const through = (p: Point) => {
    const key = exactPointCode(p)
    if (visited.has(key)) return
    visited.add(key)
    for (const s of along(rowCode(p.y), p.x, p.x)) near.add(s)
    for (const s of along(columnCode(p.x), p.y, p.y)) near.add(s)
  }
  const sheet = known && !known.steps.length ? known.sheet : undefined
  const throughAll = (list: readonly Point[]) => {
    if (!sheet) { for (const p of list) through(p); return }
    const rows = new Map<number, number[]>()
    const columns = new Map<number, number[]>()
    for (const p of list) {
      const key = exactPointCode(p)
      if (visited.has(key)) continue
      visited.add(key)
      const row = rows.get(p.y)
      if (row) row.push(p.x)
      else rows.set(p.y, [p.x])
      const column = columns.get(p.x)
      if (column) column.push(p.y)
      else columns.set(p.x, [p.y])
    }
    const passing = (line: number, at: number[]) => {
      let lo = at[0]
      let hi = at[0]
      for (const v of at) { if (v < lo) lo = v; if (v > hi) hi = v }
      for (const s of sheet.along(line, lo, hi)) {
        if (at.length === 1) { near.add(s); continue }
        const low = lowOf(s)
        const high = highOf(s)
        if (at.some((v) => v >= low && v <= high)) near.add(s)
      }
    }
    for (const [y, xs] of rows) passing(rowCode(y), xs)
    for (const [x, ys] of columns) passing(columnCode(x), ys)
  }
  throughAll(points)
  for (const s of [...add, ...remove]) {
    through(s.a)
    through(s.b)
    const along = s.a.y === s.b.y ? "x" : "y"
    for (const t of segmentsFrom(doc.wires, known, lineCodeOf(s), Math.min(s.a[along], s.b[along]), Math.max(s.a[along], s.b[along]))) near.add(t)
  }
  if (!near.size && !add.length && !remove.length) return { wires: doc.wires, added: [], removed: [] }
  const spans = [...near, ...add]
  const index = documentPins(doc.objects)
  const pins = new Map<string, WirePin>()
  for (const s of spans) {
    const box = { x: Math.min(s.a.x, s.b.x), y: Math.min(s.a.y, s.b.y), w: Math.abs(s.a.x - s.b.x), h: Math.abs(s.a.y - s.b.y) }
    for (const pin of index.within(box)) pins.set(pin.key, pin)
    if (known) {
      const axis = s.a.y === s.b.y ? "x" : "y"
      for (const segment of known.sheet.segmentsMarked(lineCodeOf(s), Math.min(s.a[axis], s.b[axis]), Math.max(s.a[axis], s.b[axis]))) near.add(segment)
      through(s.a)
      through(s.b)
    }
  }
  if (known) throughAll([...pins.values()].map((pin) => pin.at))
  if (!known) return commitEdit(doc.wires, [...pins.values()], { add, remove, points }, newId)
  const order = wireOrder(doc.wires)
  const selected = [...near].filter((s) => order.has(s)).sort((s, t) => order.get(s)! - order.get(t)!)
  const result = commitEdit(selected, [...pins.values()], { add, remove, points }, newId)
  const localIds = new Set([...selected, ...add].map((s) => s.id))
  const groups = new Map<string, WireSegment[]>()
  let owner = ""
  for (const s of result.wires) {
    if (localIds.has(s.id)) owner = s.id
    const group = groups.get(owner)
    if (group) group.push(s)
    else groups.set(owner, [s])
  }
  const ranks = new Map<WireSegment, number>()
  let ordered = true
  const rankPieces = (pieces: readonly WireSegment[], lo: number, hi: number) => {
    let previous = -Infinity
    pieces.forEach((piece, i) => {
      const rank = lo + (hi - lo) * i / pieces.length
      if (rank <= previous || rank >= hi) ordered = false
      ranks.set(piece, rank)
      previous = rank
    })
  }
  const originals = new Set([...selected, ...remove])
  const originalIds = new Set([...originals].map((segment) => segment.id))
  const patches: { at: number; pieces: readonly WireSegment[] }[] = []
  for (const source of originals) {
    const pieces = groups.get(source.id) ?? []
    if (pieces.length === 1 && pieces[0] === source) continue
    const at = positionOf(doc.wires, order, source)
    if (at >= 0) {
      const lo = order.get(source)!
      const hi = order.get(doc.wires[at + 1]) ?? lo + 1
      rankPieces(pieces, lo, hi)
      patches.push({ at, pieces })
    }
  }
  patches.sort((a, b) => a.at - b.at)
  let tail = (order.get(doc.wires.at(-1)!) ?? -1) + 1
  const appended: WireSegment[] = []
  for (const segment of add) if (!originalIds.has(segment.id)) {
    const pieces = groups.get(segment.id) ?? []
    rankPieces(pieces, tail, tail + 1)
    tail++
    for (const piece of pieces) appended.push(piece)
  }
  let wires: WireSegment[]
  if (!appended.length && patches.every((patch) => patch.pieces.length === 1)) {
    wires = doc.wires.slice()
    for (const { at, pieces } of patches) wires[at] = pieces[0]
  } else {
    let size = doc.wires.length + appended.length
    for (const { pieces } of patches) size += pieces.length - 1
    wires = new Array<WireSegment>(size)
    let next = 0
    let filled = 0
    for (const { at, pieces } of patches) {
      while (next < at) wires[filled++] = doc.wires[next++]
      for (const piece of pieces) wires[filled++] = piece
      next = at + 1
    }
    while (next < doc.wires.length) wires[filled++] = doc.wires[next++]
    for (const piece of appended) wires[filled++] = piece
  }
  if (ordered) {
    const next = new OverlayMap(order, ranks, new Set([...remove, ...result.removed]))
    wireOrders.set(wires, next)
    orderParents.set(next, orderIdentity(order))
  }
  return { wires, added: result.added, removed: result.removed }
}

export const NO_WIRE_LAID = { title: "No wire laid", why: "Every way to that pin would touch another net's wire or pin." }

export function connectPins(doc: Schematic, from: PinRef, to: PinRef, points: readonly Point[] = [], color?: WireColorKey, newId: NewId = randomId, known?: Wiring): Schematic {
  if (from.object === to.object && from.pin === to.pin) return doc
  const wiring = knownFor(doc, known)
  const view = wiring?.view ?? viewOf(doc)
  const own = new Set([netOrSelf(view, `${from.object}:${from.pin}`), netOrSelf(view, `${to.object}:${to.pin}`)])
  const pts = laid(doc, { id: "wire", from, to, points: [...points] }, own, doc.objects, view, wiring?.pins ?? pinsOf(doc.objects))
  if (!pts) return doc
  return withSegments(doc, segmentsAlong(pts, color, newId), [], [], newId)
}

export function pinToPinPoints(doc: Schematic, from: PinRef, to: PinRef, points: readonly Point[] = [], known?: Wiring): Point[] | null {
  const wiring = knownFor(doc, known)
  const view = wiring?.view ?? viewOf(doc)
  const own = new Set([netOrSelf(view, `${from.object}:${from.pin}`), netOrSelf(view, `${to.object}:${to.pin}`)])
  return laid(doc, { id: "wire", from, to, points: [...points] }, own, doc.objects, view, wiring?.pins ?? pinsOf(doc.objects))
}

export function nearestOn(s: WireSegment, at: Point): Point {
  const horizontal = s.a.y === s.b.y
  const lo = horizontal ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y)
  const hi = horizontal ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y)
  const along = Math.min(hi, Math.max(lo, snap(horizontal ? at.x : at.y, GRID)))
  return horizontal ? { x: along, y: s.a.y } : { x: s.a.x, y: along }
}

export function tapWireAt(doc: Schematic, segmentId: string, at: Point, from: PinRef, points: readonly Point[] = [], color?: WireColorKey, newId: NewId = randomId, known?: Wiring): Schematic {
  const tapped = doc.wires.find((s) => s.id === segmentId)
  if (!tapped) return doc
  const wiring = knownFor(doc, known)
  const view = wiring?.view ?? viewOf(doc)
  const fromKey = `${from.object}:${from.pin}`
  const point = nearestOn(tapped, at)
  const hub: PlacedObject = { id: "tap", def: JUNCTION, x: point.x - GRID, y: point.y - GRID }
  const own = new Set([netOrSelf(view, fromKey), view.netOfSegment(tapped.id) ?? `wire:${tapped.id}`])
  const pts = laid(doc, { id: "wire", from, to: { object: hub.id, pin: "J" }, points: [...points] }, own, [...doc.objects, hub], view, wiring?.pins ?? pinsOf(doc.objects))
  if (!pts) return doc
  return withSegments(doc, segmentsAlong(pts, color ?? tapped.color, newId), [], [point], newId)
}

export function recoloured(doc: Schematic, entries: Iterable<readonly [string, WireColorKey | undefined]>, newId: NewId = randomId): Schematic {
  const next = new Map(entries)
  const changed: WireSegment[] = []
  const wires = doc.wires.map((s) => {
    if (!next.has(s.id) || s.color === next.get(s.id)) return s
    const color = next.get(s.id)
    const painted: WireSegment = color ? { id: s.id, a: s.a, b: s.b, color } : { id: s.id, a: s.a, b: s.b }
    changed.push(painted)
    return painted
  })
  if (!changed.length) return doc
  return { ...doc, wires: [...normaliseEdit(wires, pinsOf(doc.objects), { segments: changed }, newId).wires] }
}

const pinPoints = (objects: readonly PlacedObject[]) => objects.flatMap((o) => objectPins(o, GRID).map((p) => p.point))

export function removed(doc: Schematic, objectIds: ReadonlySet<string>, segmentIds: ReadonlySet<string>, newId: NewId = randomId): Schematic {
  const gone = doc.objects.filter((o) => objectIds.has(o.id))
  const remaining: Schematic = {
    ...doc,
    objects: doc.objects.filter((o) => !objectIds.has(o.id)),
    parts: Object.fromEntries(Object.entries(doc.parts).filter(([k]) => !objectIds.has(k.split(":")[0]))),
  }
  return withSegments(remaining, [], doc.wires.filter((s) => segmentIds.has(s.id)), pinPoints(gone), newId)
}

export function placedObject(doc: Schematic, object: PlacedObject, newId: NewId = randomId, options: { suppressSplice?: boolean } = {}): Schematic {
  const next = withSegments({ ...doc, objects: [...doc.objects, object] }, [], [], pinPoints([object]), newId)
  return options.suppressSplice ? next : splicedAt(next, [object.id], newId)
}

export function withModule(doc: Schematic, module: HdlModule, newId: NewId = randomId): Schematic {
  const modules = doc.library ?? []
  const i = modules.findIndex((m) => m.id === module.id)
  const library = i < 0 ? [...modules, module] : modules.map((m, k) => (k === i ? module : m))
  const next: Schematic = { ...doc, library }
  const instances = doc.objects.filter((o) => o.def === module.id)
  if (!instances.length) return next
  const before = withLibrary(doc.library, () => pinPoints(instances))
  return withLibrary(library, () => withSegments(next, [], [], [...before, ...pinPoints(instances)], newId))
}

export function inNormalForm(doc: Schematic): Schematic {
  const ids = doc.wires.map((s) => s.id)
  const wires = normalise(doc.wires, pinsOf(doc.objects), undefined, seededIds(ids, new Set(ids)))
  return wires === doc.wires ? doc : { ...doc, wires: [...wires] }
}

const knownFor = (doc: Pick<Schematic, "objects" | "wires">, known?: Wiring) => (known && known.source.objects === doc.objects && known.source.wires === doc.wires ? known : undefined)

function objectsIn(doc: Pick<Schematic, "objects">, ids: ReadonlySet<string>, wiring?: Wiring): PlacedObject[] {
  const byId = wiring?.index.objects ?? objectIndex(doc.objects)
  const objects = [...ids].flatMap((id) => { const object = byId.get(id); return object ? [object] : [] })
  return objects.length > 1 ? objects.sort((a, b) => doc.objects.indexOf(a) - doc.objects.indexOf(b)) : objects
}

function travelling(doc: Schematic, carried: ReadonlySet<string>, known?: Wiring, given?: WireNets): Set<string> {
  const wiring = given ? undefined : knownFor(doc, known)
  const objects = objectsIn(doc, carried, wiring)
  const pins = wiring ? objects.flatMap((o) => wiring.activeOf(o.id)) : pinsOf(objects)
  const view = given ?? wiring?.view ?? viewOf(doc)
  const carriedAt = new Set<number | string>()
  const nets = new Set<string>()
  for (const p of pins) {
    carriedAt.add(exactPointCode(p.at))
    const net = view.netOfPin(p.key)
    if (net !== undefined) nets.add(net)
  }
  const ids = new Set(objects.map((o) => o.id))
  const out = new Set<string>()
  const runsOfNet = (net: string): readonly Run[] => {
    if (!wiring) return runsOf(view.segmentsOf(net).map((id) => view.segment(id)!), view.pinsOf(net).map((key) => view.pin(key)!))
    const runs = new Set<Run>()
    for (const id of view.segmentsOf(net)) runs.add(wiring.runBySegment.get(id)!)
    return [...runs]
  }
  for (const net of nets) {
    if (view.pinsOf(net).every((key) => ids.has(key.slice(0, key.indexOf(":"))))) for (const id of view.segmentsOf(net)) out.add(id)
    for (const run of runsOfNet(net)) {
      if (carriedAt.has(exactPointCode(run.points[0])) && carriedAt.has(exactPointCode(run.points[run.points.length - 1]))) for (const t of run.segments) out.add(t.id)
    }
  }
  return out
}

export const travellingWires = (doc: Schematic, carried: ReadonlySet<string>, known?: Wiring): ReadonlySet<string> => travelling(doc, carried, known)

export const travellingIn = (doc: Schematic, carried: ReadonlySet<string>, view: WireNets): ReadonlySet<string> => travelling(doc, carried, undefined, view)

export function detachedMove(doc: Schematic, from: ReadonlyMap<string, Point>, dx: number, dy: number, newId: NewId = randomId): Schematic {
  if (!dx && !dy) return doc
  const before = doc.objects.filter((o) => from.has(o.id))
  const objects = doc.objects.map((o) => {
    const p = from.get(o.id)
    return p ? { ...o, x: p.x + dx, y: p.y + dy } : o
  })
  const after = objects.filter((o) => from.has(o.id))
  return withSegments({ ...doc, objects: editedObjects(doc.objects, objects, from.keys()) }, [], [], [...pinPoints(before), ...pinPoints(after)], newId)
}

const shiftedBy = (p: Readonly<Point>, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy })

function translatedWhole(doc: Schematic, from: ReadonlyMap<string, Point>, dx: number, dy: number): Schematic {
  const wires = doc.wires.map((s) => ({ ...s, a: shiftedBy(s.a, dx, dy), b: shiftedBy(s.b, dx, dy) }))
  return {
    ...doc,
    objects: translatedObjects(doc.objects, doc.objects.map((o) => ({ ...o, x: from.get(o.id)!.x + dx, y: from.get(o.id)!.y + dy })), dx, dy, doc.wires, wires),
    wires,
  }
}

export function moved(doc: Schematic, from: ReadonlyMap<string, Point>, dx: number, dy: number, newId: NewId = randomId, known?: Wiring): Schematic {
  if (!dx && !dy) return doc
  if (from.size === doc.objects.length && doc.objects.every((o) => from.has(o.id))) return translatedWhole(doc, from, dx, dy)
  const carried = new Set(from.keys())
  const wires = travelling(doc, carried, known)
  const wiring = knownFor(doc, known)
  const before = objectsIn(doc, carried, wiring)
  const after: PlacedObject[] = []
  const shiftedTo = (o: PlacedObject) => {
    const p = from.get(o.id)!
    const moved = { ...o, x: p.x + dx, y: p.y + dy }
    after.push(moved)
    return moved
  }
  const placed = wiring && before.every((o) => doc.objects[wiring.index.rank(o)] === o)
  let objects: PlacedObject[]
  if (placed) {
    objects = doc.objects.slice()
    for (const o of before) objects[wiring.index.rank(o)] = shiftedTo(o)
  } else objects = doc.objects.map((o) => (from.has(o.id) ? shiftedTo(o) : o))
  const remove = wires.size ? doc.wires.filter((s) => wires.has(s.id)) : []
  const add = remove.map((s) => ({ ...s, a: { x: s.a.x + dx, y: s.a.y + dy }, b: { x: s.b.x + dx, y: s.b.y + dy } }))
  const points = doc.wires.length ? [...pinPoints(before), ...pinPoints(after)] : []
  return withSegments({ ...doc, objects: editedObjects(doc.objects, objects, from.keys()) }, add, remove, points, newId)
}

export function reoriented(before: Schematic, after: Schematic, ids: ReadonlySet<string>, newId: NewId = randomId): Schematic {
  if (after === before) return before
  const turned = (doc: Schematic) => doc.objects.filter((o) => ids.has(o.id))
  return withSegments(after, [], [], [...pinPoints(turned(before)), ...pinPoints(turned(after))], newId)
}

export type Clip = { objects: PlacedObject[]; wires: WireSegment[]; parts: Record<string, PartState> }

export function clipOf(doc: Schematic, ids: ReadonlySet<string>, known?: Wiring, segments: ReadonlySet<string> = new Set()): Clip | null {
  if (!ids.size && !segments.size) return null
  const objects = doc.objects.filter((o) => ids.has(o.id))
  const wires = ids.size ? travelling(doc, ids, known) : new Set<string>()
  for (const id of segments) wires.add(id)
  const parts = Object.fromEntries(Object.entries(doc.parts).filter(([k]) => ids.has(k.split(":")[0])))
  return { objects, wires: doc.wires.filter((s) => wires.has(s.id)), parts }
}

export const segmentAt = (wires: readonly WireSegment[], p: Point) => wires.find((s) => contains(s, p))

export type Wiring = {
  source: { readonly objects: readonly PlacedObject[]; readonly wires: readonly WireSegment[] }
  pins: readonly WirePin[]
  changes?: { from: Wiring["source"]; objects: { before: readonly PlacedObject[]; after: readonly PlacedObject[] }; wires: { added: readonly WireSegment[]; removed: readonly WireSegment[] } }
  activePins: readonly WirePin[]
  activeOf: (object: string) => readonly WirePin[]
  index: import("./pin-index").DocumentPins
  view: WireNets
  runs: readonly Run[]
  routes: readonly RoutedWire[]
  runById: ReadonlyMap<string, Run>
  segmentsById: ReadonlyMap<string, WireSegment>
  changedRoutes: readonly RoutedWire[]
  removedRoutes: readonly string[]
  runBySegment: ReadonlyMap<string, Run>
  nets: NetMap
  circuit: Circuit
  dots: readonly Point[]
  dangling: readonly Point[]
  corners: readonly PinCorner[]
  readonly sheet: WireSheet
  graph: WireGraph
}

type NetLook = {
  runOf: ReadonlyMap<string, Run>
  routeOf: ReadonlyMap<string, RoutedWire>
  flowOf: ReadonlyMap<string, FlowRun>
  electrical: { runs: ReadonlyMap<string, FlowRun>; pins: readonly (readonly [string, string])[] }
  runIds: readonly string[]
  pinVertex: readonly (readonly [string, string])[]
  wired: readonly string[]
  group: readonly string[] | null
  contacts: readonly (readonly [string, string])[]
  corners: readonly PinCorner[]
  turned: TurnPins
}

const looks = new WeakMap<object, { look: NetLook; at: Point }>()

const sameShift = (p: Point, q: Point) => p.x === q.x && p.y === q.y

function shiftedLook(look: NetLook, d: Point, view: WireNets): NetLook {
  const electrical = look.electrical
  const by = (p: Readonly<Point>): Point => ({ x: p.x + d.x, y: p.y + d.y })
  const runs = new Map<string, Run>()
  const runOf = new Map<string, Run>()
  for (const [id, run] of look.runOf) {
    let moved = runs.get(run.id)
    if (!moved) runs.set(run.id, (moved = { id: run.id, segments: run.segments.map((s) => view.segment(s.id)!), points: run.points.map(by) }))
    runOf.set(id, moved)
  }
  const routeOf = new Map<string, RoutedWire>()
  for (const [id, route] of look.routeOf) {
    const pins = look.turned.leads.get(id)
    const leads = pins && { ...(pins.start && { start: leadEnd(view.pin(pins.start)!) }), ...(pins.end && { end: leadEnd(view.pin(pins.end)!) }) }
    routeOf.set(id, leads ? { id, pts: route.pts.map(by), owner: [], leads } : { id, pts: route.pts.map(by), owner: [] })
  }
  return {
    runOf,
    routeOf,
    electrical,
    get flowOf() { return electrical.runs },
    runIds: look.runIds,
    get pinVertex() { return electrical.pins },
    wired: look.wired,
    group: look.group,
    contacts: look.contacts,
    corners: look.turned.corners.map(([p, q]) => ({ at: view.pin(p)!.at, a: leadEnd(view.pin(p)!), b: leadEnd(view.pin(q)!) })),
    turned: look.turned,
  }
}

function lookOf(view: WireNets, net: string): NetLook {
  const token = view.token(net)
  const known = token && looks.get(token)
  const at = view.offset()
  if (known && sameShift(known.at, at)) return known.look
  if (known) {
    const look = shiftedLook(known.look, { x: at.x - known.at.x, y: at.y - known.at.y }, view)
    looks.set(token, { look, at })
    return look
  }
  const segments = view.segmentsOf(net).map((id) => view.segment(id)!)
  const pins = view.pinsOf(net).map((key) => view.pin(key)!)
  const runs = runsOf(segments, pins)
  const turns = turnsAtPins(runs, pins)
  const runOf = new Map<string, Run>()
  const routeOf = new Map<string, RoutedWire>()
  for (const run of runs) {
    for (const t of run.segments) runOf.set(t.id, run)
    const leads = turns.leads.get(run.id)
    routeOf.set(run.id, leads ? { id: run.id, pts: [...run.points], owner: [], leads } : { id: run.id, pts: [...run.points], owner: [] })
  }
  let vertices: ReturnType<typeof flowVertices> | undefined
  let flowOf: Map<string, FlowRun> | undefined
  const flow = () => vertices ??= flowVertices(runs, pins)
  const electrical = {
    get runs() { return flowOf ??= new Map(flow().runs.map((r) => [r.id, r])) },
    get pins() { return runs.length ? flow().pins : [] },
  }
  const ends = new Set<PointCode>()
  for (const s of segments) { ends.add(exactPointCode(s.a)); ends.add(exactPointCode(s.b)) }
  const firstAt = new Map<PointCode, string>()
  const contacts: (readonly [string, string])[] = []
  for (const pin of pins) {
    const at = exactPointCode(pin.at)
    const first = firstAt.get(at)
    if (first === undefined) firstAt.set(at, pin.key)
    else {
      if (!contacts.some(([key]) => key === first)) contacts.push([first, first])
      contacts.push([pin.key, first])
    }
  }
  const look: NetLook = {
    runOf,
    routeOf,
    electrical,
    get flowOf() { return electrical.runs },
    runIds: runs.map((r) => r.id),
    get pinVertex() { return electrical.pins },
    wired: pins.filter((pin) => ends.has(exactPointCode(pin.at))).map((pin) => pin.key),
    group: pins.length > 1 ? pins.map((pin) => pin.key).sort() : null,
    contacts,
    corners: turns.corners,
    turned: turns.pins,
  }
  if (token) looks.set(token, { look, at })
  return look
}

const EMPTY_IDS: readonly string[] = []

const NO_PINS: readonly WirePin[] = []

export const wiringOf = (graph: WireGraph, doc: Pick<Schematic, "objects" | "wires" | "library">): Wiring => withLibrary(doc.library, () => derivedWiring(graph, doc))

class Deferred<T> {
  private value: T | undefined
  private build: (() => T) | undefined

  constructor(build: () => T) { this.build = build }

  read(): T {
    if (this.build) { this.value = this.build(); this.build = undefined }
    return this.value!
  }
}

type CircuitCollections = { nets: Deferred<Circuit["nets"]>; wired: Deferred<Circuit["wired"]>; flow: Deferred<Circuit["flow"]> }

const assemblies = new WeakMap<WireGraph, { wiring: Wiring; looks: ReadonlyMap<string, NetLook>; routeOf: ReadonlyMap<string, RoutedWire>; netByRun: ReadonlyMap<string, string>; view: WireNets; pins: PinState; collections: CircuitCollections }>()

function derivedWiring(graph: WireGraph, doc: Pick<Schematic, "objects" | "wires" | "library">): Wiring {
  const previous = assemblies.get(graph)
  const index = documentPins(doc.objects)
  const definitionsChanged = !!previous && previous.wiring.index.version !== index.version
  const steps = previous && editsBetween(previous.wiring.source.wires, doc.wires)
  const additions = new Set<WireSegment>()
  const removals = new Set<WireSegment>()
  for (const step of steps ?? []) {
    for (const s of step.removed) { if (!additions.delete(s)) removals.add(s) }
    for (const s of step.added) { if (!removals.delete(s)) additions.add(s) }
  }
  const edit = steps ? { from: previous!.wiring.source.wires, added: [...additions], removed: [...removals] } : undefined
  const active = index.active(doc.wires, previous?.wiring.index, edit, previous?.pins, previous?.wiring.source.wires)
  let pins: readonly WirePin[] | undefined
  const delta = previous && steps && index.pinDelta ? { added: edit!.added, removed: edit!.removed, pinsAdded: index.pinDelta.added, pinsRemoved: index.pinDelta.removed } : undefined
  const segmentChanges = new Map((edit?.added ?? doc.wires).map((s) => [s.id, s]))
  const segmentsById: ReadonlyMap<string, WireSegment> = previous && steps ? new OverlayMap(previous.wiring.segmentsById, segmentChanges, new Set(edit!.removed.map((s) => s.id))) : new Map(doc.wires.map((s) => [s.id, s]))
  const view = delta ? graph.ofDelta(doc.wires, delta) : edit ? graph.ofEdit(doc.wires, pins = active.pins, edit) : graph.of(doc.wires, pins = active.pins)
  const sameView = previous?.view === view
  const dirty = sameView ? new Set<string>() : graph.changedNets
  const lookChanges = new Map<string, NetLook>()
  const removedNets = new Set<string>()
  const changedRuns = new Map<string, Run>()
  const changedNetByRun = new Map<string, string>()
  const changedById = new Map<string, Run>()
  const changedRoutes = new Map<string, RoutedWire>()
  const removedSegments = new Set<string>()
  const removedRuns = new Set<string>()
  const removedCorners = new Set<PinCorner>()
  const changedCorners: PinCorner[] = []
  for (const net of previous ? dirty : view.nets) {
    const old = previous?.looks.get(net)
    if (old) {
      for (const id of old.runOf.keys()) removedSegments.add(id)
      for (const id of old.routeOf.keys()) removedRuns.add(id)
      for (const corner of old.corners) removedCorners.add(corner)
    }
    const look = view.token(net) ? lookOf(view, net) : undefined
    if (!look) { removedNets.add(net); continue }
    lookChanges.set(net, look)
    changedCorners.push(...look.corners)
    for (const [id, run] of look.runOf) { changedRuns.set(id, run); changedById.set(run.id, run); changedNetByRun.set(run.id, net) }
    for (const [id, route] of look.routeOf) changedRoutes.set(id, route)
  }
  const lookByNet: ReadonlyMap<string, NetLook> = previous ? new OverlayMap(previous.looks, lookChanges, removedNets) : lookChanges
  const runBySegment: ReadonlyMap<string, Run> = previous ? new OverlayMap(previous.wiring.runBySegment, changedRuns, removedSegments) : changedRuns
  const routeOf: ReadonlyMap<string, RoutedWire> = previous ? new OverlayMap(previous.routeOf, changedRoutes, removedRuns) : changedRoutes
  const netByRun: ReadonlyMap<string, string> = previous ? new OverlayMap(previous.netByRun, changedNetByRun, removedRuns) : changedNetByRun
  const runById: ReadonlyMap<string, Run> = previous ? new OverlayMap(previous.wiring.runById, changedById, removedRuns) : changedById
  let ordered: { runs: Run[]; routes: RoutedWire[]; nets: string[] } | undefined
  const orderedRuns = () => {
    if (ordered) return ordered
    const runs: Run[] = []
    const routes: RoutedWire[] = []
    const nets: string[] = []
    const seenRuns = new Set<string>()
    const seenNets = new Set<string>()
    for (const s of doc.wires) {
      const run = runBySegment.get(s.id)!
      if (seenRuns.has(run.id)) continue
      seenRuns.add(run.id)
      runs.push(run)
      routes.push(routeOf.get(run.id)!)
      const net = netByRun.get(run.id)!
      if (!seenNets.has(net)) { seenNets.add(net); nets.push(net) }
    }
    return ordered = { runs, routes, nets }
  }
  let circuit: Circuit | undefined
  const shift = translationOf(doc.objects, doc.wires)
  const translated = !definitionsChanged && previous && shift?.from === previous.wiring.source.objects && shift.fromWires === previous.wiring.source.wires
  const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((item, i) => item === b[i])
  let groupsChanged = !previous
  let wiredChanged = !previous
  let flowChanged = !previous
  for (const net of translated ? [] : dirty) {
    const old = previous?.looks.get(net)
    const next = lookByNet.get(net)
    if (!groupsChanged && !sameList(old?.group ?? [], next?.group ?? [])) groupsChanged = true
    if (!wiredChanged && !sameList([...(old?.wired ?? [])].sort(), [...(next?.wired ?? [])].sort())) wiredChanged = true
    if (!flowChanged) {
      if (wiredChanged || !sameList([...(old?.runIds ?? [])].sort(), [...(next?.runIds ?? [])].sort())) flowChanged = true
      else {
        const runs = (look: NetLook | undefined) => [...(look?.flowOf.values() ?? [])].map((r) => `${r.id}:${r.a}:${r.b}`).sort()
        const pins = (look: NetLook | undefined) => (look?.pinVertex ?? []).map(([p, v]) => `${p}:${v}`).sort()
        if (!sameList(runs(old), runs(next)) || !sameList(pins(old), pins(next))) flowChanged = true
      }
    }
  }
  const collections: CircuitCollections = {
    nets: !groupsChanged ? previous!.collections.nets : new Deferred(() => [...lookByNet.values()].flatMap((look) => look.group ? [look.group] : []).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    wired: !wiredChanged ? previous!.collections.wired : new Deferred(() => [...lookByNet.values()].flatMap((look) => look.wired).sort()),
    flow: !flowChanged ? previous!.collections.flow : new Deferred(() => ({ runs: orderedRuns().runs.map((run) => lookByNet.get(netByRun.get(run.id)!)!.flowOf.get(run.id)!), pins: Object.fromEntries([...lookByNet.values()].flatMap((look) => look.pinVertex)) })),
  }
  const makeCircuit = (): Circuit => ({ objects: doc.objects, library: doc.library, get nets() { return collections.nets.read() }, get wired() { return collections.wired.read() }, get flow() { return collections.flow.read() } })
  const corners = previous ? [...previous.wiring.corners.filter((corner) => !removedCorners.has(corner)), ...changedCorners] : changedCorners
  let contacts: Map<string, string> | null = null
  const nets: NetMap = {
    netOfPin: (key) => view.netOfPin(key),
    netOfWire: (id) => { const run = runById.get(id); return run && view.netOfSegment(run.segments[0].id) },
    wiresOf: (net) => lookByNet.get(net)?.runIds ?? EMPTY_IDS,
    pinsOf: (net) => view.pinsOf(net),
    kindsOf: (net) => view.kindsOf(net),
    get nets() { return orderedRuns().nets },
    get contacts() {
      if (!contacts) {
        contacts = new Map()
        for (const look of lookByNet.values()) for (const [key, root] of look.contacts) contacts.set(key, root)
      }
      return contacts
    },
    connected: (key) => view.netOfPin(key) !== undefined,
  }
  if (definitionsChanged) sheets.delete(graph)
  const kept = sheets.get(graph)
  let sheet: WireSheet
  if (shift && translated && kept && kept.wires === previous.wiring.source.wires) {
    sheet = kept.sheet.shift(shift.x, shift.y)
    kept.wires = doc.wires
    kept.pins = pins
  } else if (delta && kept && kept.wires === previous?.wiring.source.wires) {
    sheet = kept.sheet.apply(delta)
    kept.wires = doc.wires
    kept.pins = pins
  } else sheet = sheetOf(graph, doc.wires, pins ??= active.pins)
  sheet.pinSource = index
  sheet.segmentSource = segmentsById
  keepSheet(doc.wires, sheet)
  const wiring: Wiring = {
    source: { objects: doc.objects, wires: doc.wires },
    get pins() { return index.all },
    changes: previous && steps && !definitionsChanged ? { from: previous.wiring.source, objects: index.changes(previous.wiring.index), wires: edit! } : undefined,
    get activePins() { return active.pins },
    activeOf: (object) => active.byOwner.get(object) ?? NO_PINS,
    index,
    view: withIndexPins(view, index),
    get runs() { return orderedRuns().runs },
    get routes() { return orderedRuns().routes },
    runById,
    segmentsById,
    changedRoutes: [...changedRoutes.values()],
    removedRoutes: [...removedRuns],
    runBySegment,
    nets,
    get circuit() { return circuit ??= makeCircuit() },
    dots: view.junctions(),
    dangling: view.dangling(),
    corners,
    graph,
    sheet,
  }
  assemblies.set(graph, { wiring, looks: lookByNet, routeOf, netByRun, view, pins: active, collections })
  void wiring.sheet
  return wiring
}

function withIndexPins(view: WireNets, index: import("./pin-index").DocumentPins): WireNets {
  const nets: WireNets = Object.create(view)
  Object.defineProperty(nets, "pin", { value: (key: string) => { void view.nets; return view.pin(key) ?? index.pin(key) } })
  return nets
}

type KeptSheet = { sheet: WireSheet; wires: readonly WireSegment[]; pins: readonly WirePin[] | undefined }

const sheets = new WeakMap<WireGraph, KeptSheet>()

const SHEET_STEPS = 16

function editsBetween(from: readonly WireSegment[], to: readonly WireSegment[]): Committed[] | null {
  if (from === to) return []
  const sourceRevision = revisionOf(from)
  const targetRevision = revisionOf(to)
  if (targetRevision.edit && targetRevision.previous?.deref() === sourceRevision) return [targetRevision.edit]
  if (sourceRevision.edit && sourceRevision.previous?.deref() === targetRevision) return [{ added: sourceRevision.edit.removed, removed: sourceRevision.edit.added }]
  const ancestors = new Map<Revision, number>()
  let source = sourceRevision
  const backwards: Committed[] = []
  for (let i = 0; i <= SHEET_STEPS; i++) {
    ancestors.set(source, backwards.length)
    const previous = source.previous?.deref()
    if (!source.edit || !previous) break
    backwards.push({ added: source.edit.removed, removed: source.edit.added })
    source = previous
  }
  const forward: Committed[] = []
  for (let target = targetRevision; forward.length <= SHEET_STEPS;) {
    const before = ancestors.get(target)
    if (before !== undefined) return [...backwards.slice(0, before), ...forward.reverse()]
    const previous = target.previous?.deref()
    if (!target.edit || !previous) return null
    forward.push(target.edit)
    target = previous
  }
  return null
}

export function sheetOf(graph: WireGraph, wires: readonly WireSegment[], pins: readonly WirePin[]): WireSheet {
  const kept = sheets.get(graph)
  if (kept && kept.wires === wires && kept.pins === pins) return kept.sheet
  const steps = kept && kept.pins && kept.pins.length === pins.length ? editsBetween(kept.wires, wires) : null
  if (!kept || !steps) {
    const sheet = WireSheet.of(wires, pins)
    sheets.set(graph, { sheet, wires, pins })
    return sheet
  }
  for (const step of steps) kept.sheet.apply({ added: step.added, removed: step.removed })
  if (kept.pins !== pins) {
    const pinsAdded: WirePin[] = []
    const pinsRemoved: WirePin[] = []
    const incoming = new Set(pins.map((p) => p.key))
    for (const p of pins) {
      const before = kept.sheet.pin(p.key)
      if (before === p) continue
      if (before) pinsRemoved.push(before)
      pinsAdded.push(p)
    }
    for (const p of kept.pins ?? []) if (!incoming.has(p.key)) pinsRemoved.push(p)
    kept.sheet.apply({ pinsAdded, pinsRemoved })
  }
  kept.wires = wires
  kept.pins = pins
  return kept.sheet
}

export const sheetReflects = (graph: WireGraph, wires: readonly WireSegment[]) => sheets.get(graph)?.wires === wires
