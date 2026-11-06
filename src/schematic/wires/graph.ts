import type { PinKind, Point } from "../types"
import { pointKey, type WirePin, type WireSegment } from "./segment"

export type WireNets = {
  readonly nets: readonly string[]
  netOfPin: (key: string) => string | undefined
  netOfSegment: (id: string) => string | undefined
  pinsOf: (net: string) => readonly string[]
  segmentsOf: (net: string) => readonly string[]
  kindsOf: (net: string) => ReadonlySet<PinKind>
  connected: (key: string) => boolean
  junctions: () => readonly Point[]
  dangling: () => readonly Point[]
  token: (net: string) => object | undefined
  segment: (id: string) => WireSegment | undefined
  pin: (key: string) => WirePin | undefined
  offset: () => Point
}

export type WireDelta = {
  added?: readonly WireSegment[]
  removed?: readonly WireSegment[]
  pinsAdded?: readonly WirePin[]
  pinsRemoved?: readonly WirePin[]
}

type Vertex = { at: Point; ends: Set<string>; pins: Set<string> }

type Net = { segments: Set<string>; pins: Set<string> }

const EMPTY: readonly string[] = []
const NO_KINDS: ReadonlySet<PinKind> = new Set()

const sameOut = (a: WirePin, b: WirePin) => a.out === b.out || (!!a.out && !!b.out && a.out.x === b.out.x && a.out.y === b.out.y)

const samePinEntry = (a: WirePin, b: WirePin) => a === b || (a.key === b.key && a.at.x === b.at.x && a.at.y === b.at.y && !!a.socket === !!b.socket && a.kind === b.kind && sameOut(a, b))

const isJunction = (v: Vertex) => v.ends.size + v.pins.size >= 3

const isDangling = (v: Vertex) => v.ends.size === 1 && v.pins.size === 0

const isNet = (net: Net) => net.segments.size > 0 || net.pins.size > 1

export class WireGraph {
  changedNets: ReadonlySet<string> = new Set()
  private segments = new Map<string, WireSegment>()
  private pins = new Map<string, WirePin>()
  private vertices = new Map<string, Vertex>()
  private netOfSegment = new Map<string, string>()
  private netOfPin = new Map<string, string>()
  private members = new Map<string, Net>()
  private junctionPoints = new Map<string, Point>()
  private danglingPoints = new Map<string, Point>()
  private nextNet = 0
  private version = 0
  private moved: Point = { x: 0, y: 0 }
  private lastWires: readonly WireSegment[] | null = null
  private lastPins: readonly WirePin[] | null = null
  private netList: readonly string[] | null = null
  private kinds = new Map<string, ReadonlySet<PinKind>>()
  private junctionList: readonly Point[] | null = null
  private danglingList: readonly Point[] | null = null
  private view: WireNets = this.viewAt(0)

  snapshot(): WireNets {
    const copy = new WireGraph()
    copy.segments = new Map(this.segments)
    copy.pins = new Map(this.pins)
    copy.netOfSegment = new Map(this.netOfSegment)
    copy.netOfPin = new Map(this.netOfPin)
    copy.members = new Map(this.members)
    copy.junctionPoints = new Map(this.junctionPoints)
    copy.danglingPoints = new Map(this.danglingPoints)
    copy.moved = this.moved
    return copy.view
  }

  of(wires: readonly WireSegment[], pins: readonly WirePin[]): WireNets {
    if (wires === this.lastWires && pins === this.lastPins) return this.view
    const shift = this.translationTo(wires, pins)
    if (shift) return this.translate(shift, wires, pins)
    const added: WireSegment[] = []
    const pinsAdded: WirePin[] = []
    for (const s of wires) if (this.segments.get(s.id) !== s) added.push(s)
    for (const p of pins) {
      const known = this.pins.get(p.key)
      if (!known || !samePinEntry(known, p)) pinsAdded.push(p)
    }
    const unchanged = !added.length && !pinsAdded.length && wires.length === this.segments.size && pins.length === this.pins.size
    const view = unchanged ? this.view : this.apply(this.difference(wires, pins, added, pinsAdded))
    this.lastWires = wires
    this.lastPins = pins
    return view
  }

  ofDelta(wires: readonly WireSegment[], delta: WireDelta): WireNets {
    const view = this.apply(delta)
    this.lastWires = wires
    this.lastPins = null
    return view
  }

  ofEdit(wires: readonly WireSegment[], pins: readonly WirePin[], edit: { from: readonly WireSegment[]; added: readonly WireSegment[]; removed: readonly WireSegment[] }): WireNets {
    const lastPins = this.lastPins
    if (edit.from !== this.lastWires || !lastPins || lastPins.length !== pins.length) return this.of(wires, pins)
    const pinsAdded: WirePin[] = []
    const pinsRemoved: WirePin[] = []
    const incoming = new Map(pins.map((p) => [p.key, p]))
    for (const p of pins) {
      const before = this.pins.get(p.key)
      if (before && samePinEntry(before, p)) continue
      pinsAdded.push(p)
      if (before) pinsRemoved.push(before)
    }
    for (const p of lastPins) if (!incoming.has(p.key)) pinsRemoved.push(p)
    const view = this.apply({ added: edit.added, removed: edit.removed, pinsAdded, pinsRemoved })
    this.lastWires = wires
    this.lastPins = pins
    return view
  }

  private translationTo(wires: readonly WireSegment[], pins: readonly WirePin[]): Point | null {
    if (wires.length !== this.segments.size || pins.length !== this.pins.size || !(wires.length + pins.length)) return null
    const first = wires.length ? this.segments.get(wires[0].id) : this.pins.get(pins[0].key)
    if (!first) return null
    const shift = "a" in first ? { x: wires[0].a.x - first.a.x, y: wires[0].a.y - first.a.y } : { x: pins[0].at.x - first.at.x, y: pins[0].at.y - first.at.y }
    if (!shift.x && !shift.y) return null
    const moved = (p: Point, q: Point) => q.x - p.x === shift.x && q.y - p.y === shift.y
    for (const s of wires) {
      const was = this.segments.get(s.id)
      if (!was || was.color !== s.color || !moved(was.a, s.a) || !moved(was.b, s.b)) return null
    }
    const seen = new Set<string>()
    for (const p of pins) {
      const was = this.pins.get(p.key)
      if (!was || seen.has(p.key) || !moved(was.at, p.at) || !!was.socket !== !!p.socket || was.kind !== p.kind || !sameOut(was, p)) return null
      seen.add(p.key)
    }
    return shift
  }

  private translate(shift: Point, wires: readonly WireSegment[], pins: readonly WirePin[]): WireNets {
    this.changedNets = new Set(this.members.keys())
    const by = (p: Point): Point => ({ x: p.x + shift.x, y: p.y + shift.y })
    this.segments = new Map(wires.map((s) => [s.id, s]))
    this.pins = new Map(pins.map((p) => [p.key, p]))
    const shifted = (points: Map<string, Point>) => new Map([...points].map(([key, point]) => [key, by(point)] as const))
    this.junctionPoints = shifted(this.junctionPoints)
    this.danglingPoints = shifted(this.danglingPoints)
    this.moved = by(this.moved)
    this.junctionList = null
    this.danglingList = null
    this.view = this.viewAt(++this.version)
    this.lastWires = wires
    this.lastPins = pins
    return this.view
  }

  private difference(wires: readonly WireSegment[], pins: readonly WirePin[], added: WireSegment[], pinsAdded: WirePin[]): WireDelta {
    const incoming = new Map<string, WireSegment>()
    for (const s of wires) {
      if (incoming.has(s.id)) throw new Error(`two wires share the id ${s.id}`)
      incoming.set(s.id, s)
    }
    const incomingPins = new Map<string, WirePin>()
    for (const p of pins) {
      if (incomingPins.has(p.key)) throw new Error(`two pins share the key ${p.key}`)
      incomingPins.set(p.key, p)
    }
    const removed: WireSegment[] = []
    const pinsRemoved: WirePin[] = []
    for (const [id, s] of this.segments) if (incoming.get(id) !== s) removed.push(s)
    for (const [key, p] of this.pins) {
      const next = incomingPins.get(key)
      if (!next || !samePinEntry(p, next)) pinsRemoved.push(p)
    }
    return { added, removed, pinsAdded, pinsRemoved }
  }

  apply(delta: WireDelta): WireNets {
    const added = delta.added ?? []
    const removed = delta.removed ?? []
    const pinsAdded = delta.pinsAdded ?? []
    const pinsRemoved = delta.pinsRemoved ?? []
    this.check(added, removed, pinsAdded, pinsRemoved)
    this.lastWires = null
    this.lastPins = null
    if (!added.length && !removed.length && !pinsAdded.length && !pinsRemoved.length) { this.changedNets = new Set(); return this.view }

    const dirtyNets = new Set<string>()
    const dirtyPoints = new Map<string, Point>()
    for (const s of removed) {
      const net = this.netOfSegment.get(s.id)
      if (net) dirtyNets.add(net)
      this.detachSegment(s, dirtyPoints)
    }
    for (const p of pinsRemoved) {
      const net = this.netOfPin.get(p.key)
      if (net) dirtyNets.add(net)
      this.detachPin(p, dirtyPoints)
    }
    for (const s of added) this.attachSegment(s, dirtyPoints)
    for (const p of pinsAdded) this.attachPin(p, dirtyPoints)

    const before = new Set(dirtyNets)
    for (const s of added) for (const p of [s.a, s.b]) {
      const vertex = this.vertices.get(this.keyAt(p))
      for (const id of vertex?.ends ?? []) { const net = this.netOfSegment.get(id); if (net) before.add(net) }
      for (const key of vertex?.pins ?? []) { const net = this.netOfPin.get(key); if (net) before.add(net) }
    }
    for (const p of pinsAdded) {
      const vertex = this.vertices.get(this.keyAt(p.at))
      for (const id of vertex?.ends ?? []) { const net = this.netOfSegment.get(id); if (net) before.add(net) }
      for (const key of vertex?.pins ?? []) { const net = this.netOfPin.get(key); if (net) before.add(net) }
    }
    for (const net of dirtyNets) this.members.delete(net)
    const starts: Vertex[] = []
    for (const key of dirtyPoints.keys()) {
      const v = this.vertices.get(key)
      if (v) starts.push(v)
    }
    this.reflood(starts)
    for (const v of starts) {
      for (const id of v.ends) { const net = this.netOfSegment.get(id); if (net) before.add(net) }
      for (const key of v.pins) { const net = this.netOfPin.get(key); if (net) before.add(net) }
    }
    this.changedNets = before
    for (const [key, point] of dirtyPoints) this.restatus(key, point)
    this.netList = null
    this.kinds = new Map()
    this.junctionList = null
    this.danglingList = null
    this.view = this.viewAt(++this.version)
    return this.view
  }

  private check(added: readonly WireSegment[], removed: readonly WireSegment[], pinsAdded: readonly WirePin[], pinsRemoved: readonly WirePin[]) {
    const leaving = new Set<string>()
    for (const s of removed) {
      if (this.segments.get(s.id) !== s) throw new Error(`wire ${s.id} is removed but is not in the graph`)
      if (leaving.has(s.id)) throw new Error(`wire ${s.id} is removed twice`)
      leaving.add(s.id)
    }
    const arriving = new Set<string>()
    for (const s of added) {
      if (arriving.has(s.id) || (this.segments.has(s.id) && !leaving.has(s.id))) throw new Error(`two wires share the id ${s.id}`)
      arriving.add(s.id)
    }
    const pinsLeaving = new Set<string>()
    for (const p of pinsRemoved) {
      const held = this.pins.get(p.key)
      if (!held || !samePinEntry(held, p)) throw new Error(`pin ${p.key} is removed but is not in the graph as given`)
      if (pinsLeaving.has(p.key)) throw new Error(`pin ${p.key} is removed twice`)
      pinsLeaving.add(p.key)
    }
    const pinsArriving = new Set<string>()
    for (const p of pinsAdded) {
      if (pinsArriving.has(p.key) || (this.pins.has(p.key) && !pinsLeaving.has(p.key))) throw new Error(`two pins share the key ${p.key}`)
      pinsArriving.add(p.key)
    }
  }

  private keyAt(p: Point): string { return this.moved.x || this.moved.y ? pointKey({ x: p.x - this.moved.x, y: p.y - this.moved.y }) : pointKey(p) }

  private vertexAt(p: Point): Vertex {
    const key = this.keyAt(p)
    let v = this.vertices.get(key)
    if (!v) this.vertices.set(key, v = { at: { x: p.x - this.moved.x, y: p.y - this.moved.y }, ends: new Set(), pins: new Set() })
    return v
  }

  private release(key: string) {
    const v = this.vertices.get(key)
    if (v && v.ends.size === 0 && v.pins.size === 0) this.vertices.delete(key)
  }

  private attachSegment(s: WireSegment, dirty: Map<string, Point>) {
    this.segments.set(s.id, s)
    for (const p of [s.a, s.b]) {
      this.vertexAt(p).ends.add(s.id)
      dirty.set(this.keyAt(p), p)
    }
  }

  private detachSegment(s: WireSegment, dirty: Map<string, Point>) {
    this.segments.delete(s.id)
    this.netOfSegment.delete(s.id)
    for (const p of [s.a, s.b]) {
      const key = this.keyAt(p)
      this.vertices.get(key)?.ends.delete(s.id)
      dirty.set(key, p)
      this.release(key)
    }
  }

  private attachPin(p: WirePin, dirty: Map<string, Point>) {
    this.pins.set(p.key, p)
    this.vertexAt(p.at).pins.add(p.key)
    dirty.set(this.keyAt(p.at), p.at)
  }

  private detachPin(p: WirePin, dirty: Map<string, Point>) {
    const held = this.pins.get(p.key) ?? p
    this.pins.delete(p.key)
    this.netOfPin.delete(p.key)
    const key = this.keyAt(held.at)
    this.vertices.get(key)?.pins.delete(p.key)
    dirty.set(key, held.at)
    this.release(key)
  }

  private flood(start: Vertex, visited: Set<string>): { net: Net; olds: Set<string> } {
    const net: Net = { segments: new Set(), pins: new Set() }
    const olds = new Set<string>()
    const note = (old: string | undefined) => {
      if (old !== undefined) olds.add(old)
    }
    const stack = [start]
    visited.add(pointKey(start.at))
    while (stack.length) {
      const v = stack.pop()!
      for (const key of v.pins) {
        net.pins.add(key)
        note(this.netOfPin.get(key))
      }
      for (const id of v.ends) {
        if (net.segments.has(id)) continue
        net.segments.add(id)
        note(this.netOfSegment.get(id))
        const s = this.segments.get(id)!
        for (const end of [s.a, s.b]) {
          const key = this.keyAt(end)
          if (visited.has(key)) continue
          visited.add(key)
          stack.push(this.vertices.get(key)!)
        }
      }
    }
    return { net, olds }
  }

  private reflood(starts: readonly Vertex[]) {
    const visited = new Set<string>()
    const found: { net: Net; olds: Set<string> }[] = []
    for (const start of starts) if (!visited.has(pointKey(start.at))) found.push(this.flood(start, visited))
    for (const { olds } of found) for (const old of olds) this.members.delete(old)
    const claimed = new Set<string>()
    for (const { net, olds } of found) {
      if (!isNet(net)) {
        for (const key of net.pins) this.netOfPin.delete(key)
        continue
      }
      let id: string | undefined
      for (const old of olds) {
        if (claimed.has(old)) continue
        id = old
        break
      }
      id ??= `net${this.nextNet++}`
      claimed.add(id)
      this.members.set(id, net)
      for (const s of net.segments) this.netOfSegment.set(s, id)
      for (const p of net.pins) this.netOfPin.set(p, id)
    }
  }

  private restatus(key: string, point: Point) {
    const v = this.vertices.get(key)
    if (v && isJunction(v)) this.junctionPoints.set(key, point)
    else this.junctionPoints.delete(key)
    if (v && isDangling(v)) this.danglingPoints.set(key, point)
    else this.danglingPoints.delete(key)
  }

  private kindsOfNet(net: string): ReadonlySet<PinKind> {
    const known = this.kinds.get(net)
    if (known) return known
    const own = new Set<PinKind>()
    for (const key of this.members.get(net)?.pins ?? []) {
      const kind = this.pins.get(key)?.kind
      if (kind && kind !== "nc") own.add(kind)
    }
    const set = own.size ? own : NO_KINDS
    this.kinds.set(net, set)
    return set
  }

  private viewAt(version: number): WireNets {
    const now = () => {
      if (this.version !== version) throw new Error("this view of the wires is out of date: the graph has taken an edit since")
      return this
    }
    return {
      get nets() {
        const g = now()
        return (g.netList ??= [...g.members.keys()])
      },
      netOfPin: (key) => now().netOfPin.get(key),
      netOfSegment: (id) => now().netOfSegment.get(id),
      pinsOf: (net) => {
        const m = now().members.get(net)
        return m ? [...m.pins] : EMPTY
      },
      segmentsOf: (net) => {
        const m = now().members.get(net)
        return m ? [...m.segments] : EMPTY
      },
      kindsOf: (net) => now().kindsOfNet(net),
      connected: (key) => now().netOfPin.has(key),
      junctions: () => {
        const g = now()
        return (g.junctionList ??= [...g.junctionPoints.values()])
      },
      dangling: () => {
        const g = now()
        return (g.danglingList ??= [...g.danglingPoints.values()])
      },
      token: (net) => now().members.get(net),
      segment: (id) => now().segments.get(id),
      pin: (key) => now().pins.get(key),
      offset: () => now().moved,
    }
  }
}

export function wireNets(wires: readonly WireSegment[], pins: readonly WirePin[]): WireNets {
  return new WireGraph().of(wires, pins)
}

export const junctionsOf = (nets: WireNets) => nets.junctions()

export const danglingEnds = (nets: WireNets) => nets.dangling()

export function pinPartition(nets: WireNets): string[][] {
  return nets.nets
    .map((net) => [...nets.pinsOf(net)].sort())
    .filter((group) => group.length > 1)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
