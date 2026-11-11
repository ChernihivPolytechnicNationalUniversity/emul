import { JUNCTION, wirePins, wiresAsSegments } from "./migrate-wires"
import { getMeta, need, withLibrary } from "./registry"
import { withFieldAt, type FieldKey } from "./fields"
import type { TextAnchor } from "./geometry"
import type { LegacySchematic, LegacyWire, PartState, PinRef, PlacedObject, Rotation, Schematic } from "./types"
import { normalise } from "./wires/normal-form"
import type { WireSegment } from "./wires/segment"

type Straight = { readonly from: PinRef; readonly to: PinRef }

type Built = { doc: Schematic; hubs: PlacedObject[]; connections: LegacyWire[]; straights: Straight[]; key: string; wires: readonly WireSegment[] }

const built = new WeakMap<Schematic, Built>()

const fingerprint = (state: Built) =>
  `${state.doc.objects.map((o) => `${o.id}|${o.def}|${o.x}|${o.y}|${o.rotation ?? 0}|${o.mirror ? 1 : 0}|${o.props?.ref ?? ""}|${o.props?.value ?? ""}`).join(";")}#${state.hubs.map((o) => `${o.x},${o.y}`).join(";")}#${state.connections.map((w) => `${w.id}|${w.from.object}:${w.from.pin}|${w.to.object}:${w.to.pin}|${(w.points ?? []).map((p) => `${p.x},${p.y}`).join(" ")}|${w.color ?? ""}`).join(",")}#${state.straights.map((w) => `${w.from.object}:${w.from.pin}>${w.to.object}:${w.to.pin}`).join(",")}#${(state.doc.library ?? []).map((m) => `${m.id}:${m.built}:${m.name}`).join(",")}`

function frozen(state: Built): readonly WireSegment[] {
  const key = fingerprint(state)
  if (key === state.key) return state.wires
  let piece = 0
  const { doc, notes, faithful } = withLibrary(state.doc.library, () => wiresAsSegments({ objects: [...state.doc.objects, ...state.hubs], wires: state.connections, parts: {}, library: state.doc.library }, () => `~${piece++}`))
  if (!faithful) throw new Error(`the wiring drawn cannot be laid without changing the circuit: ${notes.filter((n) => !n.includes("laid again")).join(" ")}`)
  const placed = new Map(state.doc.objects.map((o) => [o.id, o]))
  const moved = doc.objects.filter((o) => placed.has(o.id) && (placed.get(o.id)!.x !== o.x || placed.get(o.id)!.y !== o.y))
  if (moved.length) throw new Error(`the drawing places parts where no wire can end on their pins: ${moved.map((o) => o.props?.ref ?? o.id).join(", ")}`)
  state.key = key
  state.wires = Object.freeze(state.straights.length ? withStraights(doc.wires, doc.objects, state.straights, () => `~${piece++}`) : doc.wires)
  return state.wires
}

function withStraights(wires: readonly WireSegment[], objects: readonly PlacedObject[], straights: readonly Straight[], newId: () => string): readonly WireSegment[] {
  const pins = wirePins(objects)
  const at = new Map(pins.map((p) => [p.key, p.at] as const))
  const end = (ref: PinRef) => {
    const point = at.get(`${ref.object}:${ref.pin}`)
    if (!point) throw new Error(`a straight wire ends on ${ref.object}:${ref.pin}, which is no pin of the drawing`)
    return point
  }
  const added = straights.map((w): WireSegment => ({ id: newId(), a: end(w.from), b: end(w.to) }))
  return normalise([...wires, ...added], pins, { segments: added }, newId)
}

function stateOf(doc: Schematic): Built {
  const state = built.get(doc)
  if (!state) throw new Error("this document was not made by the builder")
  return state
}

export const connections = (doc: Schematic): readonly LegacyWire[] => stateOf(doc).connections

export function legacyOf(doc: Schematic): LegacySchematic {
  const state = stateOf(doc)
  return { objects: [...doc.objects, ...state.hubs], wires: [...state.connections], parts: doc.parts, ...(doc.library && { library: doc.library }) }
}

export function rewire(doc: Schematic, change: (wire: LegacyWire) => LegacyWire | null) {
  const state = stateOf(doc)
  const next = state.connections.flatMap((w) => change(w) ?? [])
  state.connections.splice(0, state.connections.length, ...next)
}

export function connect(doc: Schematic, ...wires: LegacyWire[]) {
  stateOf(doc).connections.push(...wires)
}

export function disconnect(doc: Schematic, ...wires: LegacyWire[]) {
  const state = stateOf(doc)
  const gone = new Set(wires)
  state.connections.splice(0, state.connections.length, ...state.connections.filter((w) => !gone.has(w)))
}

export function absorb(doc: Schematic, other: Schematic) {
  const into = stateOf(doc)
  const from = stateOf(other)
  doc.objects.push(...other.objects)
  into.hubs.push(...from.hubs)
  into.connections.push(...from.connections)
  into.straights.push(...from.straights)
}

function registered(doc: Schematic, hubs: PlacedObject[], connections: LegacyWire[], straights: Straight[] = []): Built {
  const state: Built = { doc, hubs, connections, straights, key: "", wires: Object.freeze([]) }
  Object.defineProperty(doc, "wires", { enumerable: true, configurable: true, get: () => frozen(state) })
  built.set(doc, state)
  return state
}

export function copied(doc: Schematic): Schematic {
  const state = stateOf(doc)
  const { objects, parts, library, hubs, connections, straights } = structuredClone({ objects: doc.objects, parts: doc.parts, library: doc.library, hubs: state.hubs, connections: state.connections, straights: state.straights })
  const copy = { objects, parts, ...(library && { library }) } as unknown as Schematic
  registered(copy, hubs, connections, straights)
  return copy
}

/** Small DSL over the document: place components by cell, wire them by pin. */
export type HandPlacedField = readonly [ref: string, key: FieldKey, x: number, y: number, anchor?: TextAnchor]

export function placedByHand(doc: Schematic, grid: number, fields: readonly HandPlacedField[]): Schematic {
  for (const o of doc.objects) for (const [ref, key, x, y, anchor] of fields) if (o.props?.ref === ref) o.fieldAt = withFieldAt(o, key, { x: x * grid, y: y * grid }, grid, need(o.def), anchor).fieldAt
  return doc
}

export function builder(grid: number) {
  const parts: Record<string, PartState> = {}
  const doc = { objects: [], parts } as unknown as Schematic
  const state = registered(doc, [], [])
  const counts = new Map<string, number>()
  const place = (def: string, x: number, y: number, props: Record<string, string> = {}, rotation?: Rotation) => {
    const d = getMeta(def)
    const obj: PlacedObject = { id: crypto.randomUUID(), def, x: x * grid, y: y * grid, props }
    if (rotation) obj.rotation = rotation
    if (d?.prefix && !props.ref) {
      const n = (counts.get(d.prefix) ?? 0) + 1
      counts.set(d.prefix, n)
      obj.props = { ...props, ref: `${d.prefix}${n}` }
    }
    ;(def === JUNCTION ? state.hubs : doc.objects).push(obj)
    return obj
  }
  const node = (x: number, y: number): PlacedObject => {
    const hub: PlacedObject = { id: crypto.randomUUID(), def: JUNCTION, x: (x - 1) * grid, y: (y - 1) * grid }
    state.hubs.push(hub)
    return hub
  }
  /** `bends` are cell coordinates the wire is forced through. */
  const wire = (a: PlacedObject, pinA: string, b: PlacedObject, pinB: string, bends: [number, number][] = []) => {
    const w: LegacyWire = {
      id: crypto.randomUUID(),
      from: { object: a.id, pin: a.def === JUNCTION ? "J" : pinA },
      to: { object: b.id, pin: b.def === JUNCTION ? "J" : pinB },
      points: bends.length ? bends.map(([x, y]) => ({ x: x * grid, y: y * grid })) : undefined,
    }
    state.connections.push(w)
    return w
  }
  const field = (o: PlacedObject, key: FieldKey, x: number, y: number) => {
    Object.assign(o, withFieldAt(o, key, { x: x * grid, y: y * grid }, grid, need(o.def)))
  }
  const straight = (a: PlacedObject, pinA: string, b: PlacedObject, pinB: string): void => {
    state.straights.push({ from: { object: a.id, pin: pinA }, to: { object: b.id, pin: pinB } })
  }
  return { doc, place, wire, node, field, straight }
}
