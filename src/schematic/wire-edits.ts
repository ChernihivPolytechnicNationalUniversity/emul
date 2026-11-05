import { flowVertices, runsOf, type Circuit, type FlowRun, type Run } from "./circuit"
import { frozenCandidates, JUNCTION, laidAgain, wirePins } from "./freeze"
import { GRID, objectIndex, objectPins, objectRect, ownBodies, routeObstacles, snap, unionOf, type Point, type RoutedWire } from "./geometry"
import type { NetMap } from "./nets"
import { leadEnd, turnsAtPins, type PinCorner, type TurnPins } from "./wire-look"
import { fieldRouter } from "./placement"
import { getDef, getLibraryVersion, withLibrary } from "./registry"
import type { ComponentDef, HdlModule, LegacyWire, PartState, PinRef, PlacedObject, Schematic } from "./types"
import type { WireColorKey } from "./wire-colors"
import { clearOf, Conductors } from "./wires/conductors"
import { WireGraph, type WireNets } from "./wires/graph"
import { WireSheet } from "./wires/sheet"
import { commitEdit, normalise, normaliseEdit } from "./wires/normal-form"
import { contains, pointKey, samePoint, seededIds, type WirePin, type WireSegment } from "./wires/segment"

const pinCache = new WeakMap<PlacedObject, { def: ComponentDef | undefined; pins: readonly WirePin[] }>()

export function pinsOf(objects: readonly PlacedObject[]): WirePin[] {
  const out: WirePin[] = []
  for (const o of objects) {
    const def = getDef(o.def)
    let cached = pinCache.get(o)
    if (!cached || cached.def !== def) pinCache.set(o, (cached = { def, pins: def ? wirePins([o]) : [] }))
    out.push(...cached.pins)
  }
  return out
}

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

type Committed = { from: readonly WireSegment[]; added: readonly WireSegment[]; removed: readonly WireSegment[] }

const committed = new WeakMap<readonly WireSegment[], Committed>()

export function withSegments(doc: Schematic, add: readonly WireSegment[], remove: readonly WireSegment[] = [], points: readonly Point[] = [], newId: NewId = randomId): Schematic {
  if (!add.length && !remove.length && !points.length) return doc
  const result = commitEdit(doc.wires, pinsOf(doc.objects), { add, remove, points }, newId)
  if (result.wires === doc.wires) return doc
  const wires = [...result.wires]
  committed.set(wires, { from: doc.wires, added: result.added, removed: result.removed })
  return { ...doc, wires }
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

export function placedObject(doc: Schematic, object: PlacedObject, newId: NewId = randomId): Schematic {
  return withSegments({ ...doc, objects: [...doc.objects, object] }, [], [], pinPoints([object]), newId)
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

function travelling(doc: Schematic, carried: ReadonlySet<string>, known?: Wiring, given?: WireNets): Set<string> {
  const wiring = given ? undefined : knownFor(doc, known)
  const pins = pinsOf(doc.objects.filter((o) => carried.has(o.id)))
  const view = given ?? wiring?.view ?? viewOf(doc)
  const carriedPins = new Set<string>()
  const carriedAt = new Set<string>()
  const nets = new Set<string>()
  for (const p of pins) {
    carriedPins.add(p.key)
    carriedAt.add(pointKey(p.at))
    const net = view.netOfPin(p.key)
    if (net !== undefined) nets.add(net)
  }
  const out = new Set<string>()
  const runsOfNet = (net: string): readonly Run[] => {
    if (!wiring) return runsOf(view.segmentsOf(net).map((id) => view.segment(id)!), view.pinsOf(net).map((key) => view.pin(key)!))
    const runs = new Set<Run>()
    for (const id of view.segmentsOf(net)) runs.add(wiring.runBySegment.get(id)!)
    return [...runs]
  }
  for (const net of nets) {
    if (view.pinsOf(net).every((key) => carriedPins.has(key))) for (const id of view.segmentsOf(net)) out.add(id)
    for (const run of runsOfNet(net)) {
      const ends = [run.points[0], run.points[run.points.length - 1]]
      if (ends.every((p) => carriedAt.has(pointKey(p)))) for (const t of run.segments) out.add(t.id)
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
  return withSegments({ ...doc, objects }, [], [], [...pinPoints(before), ...pinPoints(after)], newId)
}

const shiftedBy = (p: Readonly<Point>, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy })

function translatedWhole(doc: Schematic, from: ReadonlyMap<string, Point>, dx: number, dy: number): Schematic {
  return {
    ...doc,
    objects: doc.objects.map((o) => ({ ...o, x: from.get(o.id)!.x + dx, y: from.get(o.id)!.y + dy })),
    wires: doc.wires.map((s) => ({ ...s, a: shiftedBy(s.a, dx, dy), b: shiftedBy(s.b, dx, dy) })),
  }
}

export function moved(doc: Schematic, from: ReadonlyMap<string, Point>, dx: number, dy: number, newId: NewId = randomId, known?: Wiring): Schematic {
  if (!dx && !dy) return doc
  if (from.size === doc.objects.length && doc.objects.every((o) => from.has(o.id))) return translatedWhole(doc, from, dx, dy)
  const carried = new Set(from.keys())
  const wires = travelling(doc, carried, known)
  const before = doc.objects.filter((o) => carried.has(o.id))
  const objects = doc.objects.map((o) => {
    const p = from.get(o.id)
    return p ? { ...o, x: p.x + dx, y: p.y + dy } : o
  })
  const after = objects.filter((o) => carried.has(o.id))
  const remove = doc.wires.filter((s) => wires.has(s.id))
  const add = remove.map((s) => ({ ...s, a: { x: s.a.x + dx, y: s.a.y + dy }, b: { x: s.b.x + dx, y: s.b.y + dy } }))
  return withSegments({ ...doc, objects }, add, remove, [...pinPoints(before), ...pinPoints(after)], newId)
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
  view: WireNets
  runs: readonly Run[]
  routes: readonly RoutedWire[]
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
    ...look,
    runOf,
    routeOf,
    corners: look.turned.corners.map(([p, q]) => ({ at: view.pin(p)!.at, a: leadEnd(view.pin(p)!), b: leadEnd(view.pin(q)!) })),
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
  const vertices = flowVertices(runs, pins)
  const flowOf = new Map(vertices.runs.map((r) => [r.id, r]))
  const ends = new Set(segments.flatMap((t) => [pointKey(t.a), pointKey(t.b)]))
  const firstAt = new Map<string, string>()
  const contacts: (readonly [string, string])[] = []
  for (const pin of pins) {
    const at = pointKey(pin.at)
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
    flowOf,
    runIds: runs.map((r) => r.id),
    pinVertex: runs.length ? vertices.pins : [],
    wired: pins.filter((pin) => ends.has(pointKey(pin.at))).map((pin) => pin.key),
    group: pins.length > 1 ? pins.map((pin) => pin.key).sort() : null,
    contacts,
    corners: turns.corners,
    turned: turns.pins,
  }
  if (token) looks.set(token, { look, at })
  return look
}

const EMPTY_IDS: readonly string[] = []

export const wiringOf = (graph: WireGraph, doc: Pick<Schematic, "objects" | "wires" | "library">): Wiring => withLibrary(doc.library, () => derivedWiring(graph, doc))

function derivedWiring(graph: WireGraph, doc: Pick<Schematic, "objects" | "wires" | "library">): Wiring {
  const pins = pinsOf(doc.objects)
  const edit = committed.get(doc.wires)
  const view = edit ? graph.ofEdit(doc.wires, pins, edit) : graph.of(doc.wires, pins)
  const lookByNet = new Map<string, NetLook>()
  for (const net of view.nets) lookByNet.set(net, lookOf(view, net))
  const runs: Run[] = []
  const routes: RoutedWire[] = []
  const flowRuns: FlowRun[] = []
  const runBySegment = new Map<string, Run>()
  const netOfRun = new Map<string, string>()
  const netsWithRuns: string[] = []
  const seenNets = new Set<string>()
  for (const s of doc.wires) {
    if (runBySegment.has(s.id)) continue
    const net = view.netOfSegment(s.id)!
    const look = lookByNet.get(net)!
    const run = look.runOf.get(s.id)!
    for (const t of run.segments) runBySegment.set(t.id, run)
    runs.push(run)
    routes.push(look.routeOf.get(run.id)!)
    flowRuns.push(look.flowOf.get(run.id)!)
    if (!seenNets.has(net)) {
      seenNets.add(net)
      netsWithRuns.push(net)
    }
    netOfRun.set(run.id, net)
  }
  const groups: (readonly string[])[] = []
  const wired: string[] = []
  const flowPins: Record<string, string> = {}
  const corners: PinCorner[] = []
  for (const look of lookByNet.values()) {
    if (look.group) groups.push(look.group)
    for (const key of look.wired) wired.push(key)
    for (const [key, vertex] of look.pinVertex) flowPins[key] = vertex
    for (const corner of look.corners) corners.push(corner)
  }
  groups.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  wired.sort()
  let contacts: Map<string, string> | null = null
  const nets: NetMap = {
    netOfPin: (key) => view.netOfPin(key),
    netOfWire: (id) => netOfRun.get(id),
    wiresOf: (net) => lookByNet.get(net)?.runIds ?? EMPTY_IDS,
    pinsOf: (net) => view.pinsOf(net),
    kindsOf: (net) => view.kindsOf(net),
    nets: netsWithRuns,
    get contacts() {
      if (!contacts) {
        contacts = new Map()
        for (const look of lookByNet.values()) for (const [key, root] of look.contacts) contacts.set(key, root)
      }
      return contacts
    },
    connected: (key) => view.netOfPin(key) !== undefined,
  }
  return {
    source: { objects: doc.objects, wires: doc.wires },
    pins,
    view,
    runs,
    routes,
    runBySegment,
    nets,
    circuit: { objects: doc.objects, library: doc.library, nets: groups, wired, flow: { runs: flowRuns, pins: flowPins } },
    dots: view.junctions(),
    dangling: view.dangling(),
    corners,
    graph,
    get sheet() {
      return sheetOf(graph, doc.wires, pins)
    },
  }
}

type KeptSheet = { sheet: WireSheet; wires: readonly WireSegment[]; pins: readonly WirePin[] }

const sheets = new WeakMap<WireGraph, KeptSheet>()

const SHEET_STEPS = 16

function editsBetween(from: readonly WireSegment[], to: readonly WireSegment[]): Committed[] | null {
  const steps: Committed[] = []
  for (let at = to; at !== from; ) {
    const edit = committed.get(at)
    if (!edit || steps.length >= SHEET_STEPS) return null
    steps.push(edit)
    at = edit.from
  }
  return steps.reverse()
}

export function sheetOf(graph: WireGraph, wires: readonly WireSegment[], pins: readonly WirePin[]): WireSheet {
  const kept = sheets.get(graph)
  if (kept && kept.wires === wires && kept.pins === pins) return kept.sheet
  const steps = kept && kept.pins.length === pins.length ? editsBetween(kept.wires, wires) : null
  if (!kept || !steps) {
    const sheet = WireSheet.of(wires, pins)
    sheets.set(graph, { sheet, wires, pins })
    return sheet
  }
  for (const step of steps) kept.sheet.apply({ added: step.added, removed: step.removed })
  if (kept.pins !== pins) {
    const pinsAdded: WirePin[] = []
    const pinsRemoved: WirePin[] = []
    for (let i = 0; i < pins.length; i++) {
      if (pins[i] === kept.pins[i]) continue
      pinsRemoved.push(kept.pins[i])
      pinsAdded.push(pins[i])
    }
    kept.sheet.apply({ pinsAdded, pinsRemoved })
  }
  kept.wires = wires
  kept.pins = pins
  return kept.sheet
}

export const sheetReflects = (graph: WireGraph, wires: readonly WireSegment[]) => sheets.get(graph)?.wires === wires
