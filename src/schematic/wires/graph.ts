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

const samePinEntry = (a: WirePin, b: WirePin) => a === b || (a.key === b.key && a.at.x === b.at.x && a.at.y === b.at.y && !!a.socket === !!b.socket && a.kind === b.kind)

function changedWindow<T>(before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean): [readonly T[], readonly T[]] {
  const shorter = Math.min(before.length, after.length)
  let head = 0
  while (head < shorter && same(before[head], after[head])) head++
  let tail = 0
  while (tail < shorter - head && same(before[before.length - 1 - tail], after[after.length - 1 - tail])) tail++
  return [before.slice(head, before.length - tail), after.slice(head, after.length - tail)]
}

const isJunction = (v: Vertex) => v.ends.size + v.pins.size >= 3

const isDangling = (v: Vertex) => v.ends.size === 1 && v.pins.size === 0

const isNet = (net: Net) => net.segments.size > 0 || net.pins.size > 1

export class WireGraph {
  private segments = new Map<string, WireSegment>()
  private pins = new Map<string, WirePin>()
  private vertices = new Map<string, Vertex>()
  private netOfSegment = new Map<string, string>()
  private netOfPin = new Map<string, string>()
  private members = new Map<string, Net>()
  private junctionPoints = new Map<string, Point>()
  private danglingPoints = new Map<string, Point>()
  private nextNet = 0
  private lastWires: readonly WireSegment[] = []
  private lastPins: readonly WirePin[] = []
  private netList: readonly string[] | null = null
  private kinds = new Map<string, ReadonlySet<PinKind>>()
  private junctionList: readonly Point[] | null = null
  private danglingList: readonly Point[] | null = null
  private view: WireNets = this.viewOf(this.lastWires, this.lastPins)

  of(wires: readonly WireSegment[], pins: readonly WirePin[]): WireNets {
    if (wires === this.lastWires && pins === this.lastPins) return this.view
    const [oldSegments, newSegments] = changedWindow(this.lastWires, wires, (a, b) => a === b)
    const [oldPins, newPins] = changedWindow(this.lastPins, pins, samePinEntry)
    const kept = new Set(newSegments)
    const before = new Set(oldSegments)
    const oldByKey = new Map(oldPins.map((p) => [p.key, p]))
    const newByKey = new Map(newPins.map((p) => [p.key, p]))
    return this.apply(
      {
        added: newSegments.filter((s) => !before.has(s)),
        removed: oldSegments.filter((s) => !kept.has(s)),
        pinsAdded: newPins.filter((p) => !oldByKey.has(p.key) || !samePinEntry(oldByKey.get(p.key)!, p)),
        pinsRemoved: oldPins.filter((p) => !newByKey.has(p.key) || !samePinEntry(p, newByKey.get(p.key)!)),
      },
      wires,
      pins,
    )
  }

  apply(delta: WireDelta, wires: readonly WireSegment[], pins: readonly WirePin[]): WireNets {
    const added = delta.added ?? []
    const removed = delta.removed ?? []
    const pinsAdded = delta.pinsAdded ?? []
    const pinsRemoved = delta.pinsRemoved ?? []
    this.check(added, removed, pinsAdded, pinsRemoved)
    this.lastWires = wires
    this.lastPins = pins
    if (!added.length && !removed.length && !pinsAdded.length && !pinsRemoved.length) return this.view

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

    for (const net of dirtyNets) this.members.delete(net)
    const starts: Vertex[] = []
    for (const key of dirtyPoints.keys()) {
      const v = this.vertices.get(key)
      if (v) starts.push(v)
    }
    this.reflood(starts)
    for (const [key, point] of dirtyPoints) this.restatus(key, point)
    this.netList = null
    this.kinds = new Map()
    this.junctionList = null
    this.danglingList = null
    this.view = this.viewOf(wires, pins)
    return this.view
  }

  private check(added: readonly WireSegment[], removed: readonly WireSegment[], pinsAdded: readonly WirePin[], pinsRemoved: readonly WirePin[]) {
    const leaving = new Set<string>()
    for (const s of removed) {
      if (this.segments.get(s.id) !== s) throw new Error(`wire ${s.id} is removed but is not in the graph`)
      leaving.add(s.id)
    }
    const arriving = new Set<string>()
    for (const s of added) {
      if (arriving.has(s.id) || (this.segments.has(s.id) && !leaving.has(s.id))) throw new Error(`two wires share the id ${s.id}`)
      arriving.add(s.id)
    }
    const pinsLeaving = new Set<string>()
    for (const p of pinsRemoved) {
      if (!this.pins.has(p.key)) throw new Error(`pin ${p.key} is removed but is not in the graph`)
      pinsLeaving.add(p.key)
    }
    const pinsArriving = new Set<string>()
    for (const p of pinsAdded) {
      if (pinsArriving.has(p.key) || (this.pins.has(p.key) && !pinsLeaving.has(p.key))) throw new Error(`two pins share the key ${p.key}`)
      pinsArriving.add(p.key)
    }
  }

  private vertexAt(p: Point): Vertex {
    const key = pointKey(p)
    let v = this.vertices.get(key)
    if (!v) this.vertices.set(key, (v = { at: p, ends: new Set(), pins: new Set() }))
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
      dirty.set(pointKey(p), p)
    }
  }

  private detachSegment(s: WireSegment, dirty: Map<string, Point>) {
    this.segments.delete(s.id)
    this.netOfSegment.delete(s.id)
    for (const p of [s.a, s.b]) {
      const key = pointKey(p)
      this.vertices.get(key)?.ends.delete(s.id)
      dirty.set(key, p)
      this.release(key)
    }
  }

  private attachPin(p: WirePin, dirty: Map<string, Point>) {
    this.pins.set(p.key, p)
    this.vertexAt(p.at).pins.add(p.key)
    dirty.set(pointKey(p.at), p.at)
  }

  private detachPin(p: WirePin, dirty: Map<string, Point>) {
    const held = this.pins.get(p.key) ?? p
    this.pins.delete(p.key)
    this.netOfPin.delete(p.key)
    const key = pointKey(held.at)
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
          const key = pointKey(end)
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

  private viewOf(wires: readonly WireSegment[], pins: readonly WirePin[]): WireNets {
    const graph = this
    const now = () => {
      if (graph.lastWires !== wires || graph.lastPins !== pins) graph.of(wires, pins)
      return graph
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
