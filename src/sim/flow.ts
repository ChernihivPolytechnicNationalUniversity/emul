import type { Wire } from "@/schematic/types"
import { pinKey } from "@/schematic/types"
import type { GroundTie, Netlist } from "./netlist"

export type FlowNet = Pick<Netlist, "pinNet" | "groundTies" | "contacts" | "conductorOf" | "partShorts">

export type Flow = { wires: Map<string, number>; leads: Map<string, number> }

type Factors = { lu: Float64Array; pivot: Int32Array; n: number; singular: boolean }

type Incidence = { wire: string; into: 1 | -1 }

type Inside = { keys: readonly string[]; planeOf: ReadonlyMap<string, string>; contacted: readonly string[]; ties: ReadonlySet<string>; row: ReadonlyMap<string, number>; factors: Factors }

type Sink = { vertex: string; ties: number }

type Component = {
  vertices: readonly string[]
  wires: readonly string[]
  row: ReadonlyMap<string, number>
  sinks: readonly Sink[]
  ties: number
  factors: Factors
  leads: readonly string[]
}

const SINGULAR = 1e-12

const TIE_RANK: Record<GroundTie, number> = { reference: 1, schematic: 2 }

function factorised(matrix: Float64Array, n: number): Factors {
  const lu = Float64Array.from(matrix)
  const pivot = new Int32Array(n)
  for (let col = 0; col < n; col++) {
    let p = col
    for (let r = col + 1; r < n; r++) if (Math.abs(lu[r * n + col]) > Math.abs(lu[p * n + col])) p = r
    pivot[col] = p
    if (Math.abs(lu[p * n + col]) < SINGULAR) return { lu, pivot, n, singular: true }
    if (p !== col)
      for (let c = 0; c < n; c++) {
        const t = lu[col * n + c]
        lu[col * n + c] = lu[p * n + c]
        lu[p * n + c] = t
      }
    for (let r = col + 1; r < n; r++) {
      const f = lu[r * n + col] / lu[col * n + col]
      lu[r * n + col] = f
      if (f === 0) continue
      for (let c = col + 1; c < n; c++) lu[r * n + c] -= f * lu[col * n + c]
    }
  }
  return { lu, pivot, n, singular: false }
}

function solvedWith({ lu, pivot, n, singular }: Factors, rhs: Float64Array): Float64Array {
  const x = new Float64Array(n)
  if (singular) return x
  const b = Float64Array.from(rhs)
  for (let col = 0; col < n; col++) {
    const p = pivot[col]
    if (p === col) continue
    const t = b[col]
    b[col] = b[p]
    b[p] = t
  }
  let first = 0
  while (first < n && b[first] === 0) first++
  for (let r = first; r < n; r++) {
    let s = b[r]
    for (let c = first; c < r; c++) s -= lu[r * n + c] * b[c]
    b[r] = s
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let c = r + 1; c < n; c++) s -= lu[r * n + c] * x[c]
    x[r] = s / lu[r * n + r]
  }
  return x
}

function laplacian(nodes: readonly string[], edges: readonly (readonly [string, string])[], grounded: string): { row: Map<string, number>; factors: Factors } {
  const row = new Map<string, number>()
  for (const k of nodes) if (k !== grounded) row.set(k, row.size)
  const m = row.size
  const matrix = new Float64Array(m * m)
  for (const [a, b] of edges) {
    const i = row.get(a)
    const j = row.get(b)
    if (i !== undefined) matrix[i * m + i] += 1
    if (j !== undefined) matrix[j * m + j] += 1
    if (i !== undefined && j !== undefined) {
      matrix[i * m + j] -= 1
      matrix[j * m + i] -= 1
    }
  }
  return { row, factors: factorised(matrix, m) }
}

function potentials(row: ReadonlyMap<string, number>, factors: Factors, entering: (node: string) => number): (node: string) => number {
  const b = new Float64Array(row.size)
  for (const [k, i] of row) b[i] = entering(k)
  const phi = solvedWith(factors, b)
  return (k) => {
    const i = row.get(k)
    return i === undefined ? 0 : phi[i]
  }
}

const contactHub = (group: string) => `\0contact:${group}`

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

export class FlowSolver {
  private readonly members = new Map<string, string[]>()
  private readonly ends = new Map<string, readonly [string, string]>()
  private readonly incident = new Map<string, Incidence[]>()
  private readonly components: Component[] = []
  private readonly componentOf = new Map<string, Component>()
  private readonly shortsIn = new Map<string, (readonly string[])[]>()
  private readonly inShort = new Set<string>()
  private readonly insides = new Map<string, Inside>()
  readonly leadPins: readonly string[]
  private readonly net: FlowNet

  constructor(wires: readonly Wire[], net: FlowNet) {
    this.net = net
    for (const [key, conductor] of net.conductorOf) push(this.members, conductor, key)
    for (const group of net.partShorts) {
      push(this.shortsIn, this.conductor(group[0]), group)
      for (const key of group) this.inShort.add(key)
    }
    const adjacent = new Map<string, string[]>()
    const wiresOf = new Map<string, string[]>()
    for (const w of wires) {
      const from = pinKey(w.from.object, w.from.pin)
      const to = pinKey(w.to.object, w.to.pin)
      const a = this.conductor(from)
      const b = this.conductor(to)
      if (net.pinNet.get(from) === undefined || a === b) continue
      this.ends.set(w.id, [a, b])
      push(this.incident, from, { wire: w.id, into: -1 })
      push(this.incident, to, { wire: w.id, into: 1 })
      push(adjacent, a, b)
      push(adjacent, b, a)
      push(wiresOf, a, w.id)
    }
    const leadPins = new Set<string>()
    for (const key of [...this.incident.keys(), ...net.conductorOf.keys(), ...net.groundTies.keys()]) if (net.pinNet.has(key) && (this.inShort.has(key) || net.groundTies.has(key))) leadPins.add(key)
    this.leadPins = [...leadPins]
    const leadsAt = new Map<string, string[]>()
    for (const key of this.leadPins) push(leadsAt, this.conductor(key), key)

    const seen = new Set<string>()
    const starts = [...adjacent.keys(), ...leadsAt.keys()]
    for (const start of starts) {
      if (seen.has(start)) continue
      const vertices: string[] = []
      const stack = [start]
      seen.add(start)
      while (stack.length) {
        const v = stack.pop()!
        vertices.push(v)
        for (const other of adjacent.get(v) ?? []) {
          if (seen.has(other)) continue
          seen.add(other)
          stack.push(other)
        }
      }
      const rank = (k: string) => TIE_RANK[net.groundTies.get(k)!] ?? 0
      const best = Math.max(0, ...vertices.flatMap((v) => this.keysAt(v).map(rank)))
      const sinks = best > 0 ? vertices.map((vertex) => ({ vertex, ties: this.keysAt(vertex).filter((k) => rank(k) === best).length })).filter((sink) => sink.ties > 0) : []
      const componentWires = vertices.flatMap((v) => wiresOf.get(v) ?? [])
      const { row, factors } = laplacian(
        vertices,
        componentWires.map((id) => this.ends.get(id)!),
        sinks[0]?.vertex ?? vertices[0],
      )
      const ties = sinks.reduce((sum, sink) => sum + sink.ties, 0)
      const component: Component = { vertices, wires: componentWires, row, sinks, ties, factors, leads: vertices.flatMap((v) => leadsAt.get(v) ?? []) }
      this.components.push(component)
      for (const v of vertices) this.componentOf.set(v, component)
    }
  }

  private conductor(key: string): string {
    return this.net.conductorOf.get(key) ?? key
  }

  private keysAt(vertex: string): readonly string[] {
    return this.members.get(vertex) ?? [vertex]
  }

  currents(terminal: (key: string) => number): Flow {
    const flow: Flow = { wires: new Map(), leads: new Map() }
    for (const component of this.components) this.solve(component, terminal, flow)
    return flow
  }

  unit(key: string): Flow {
    const flow: Flow = { wires: new Map(), leads: new Map() }
    const component = this.componentOf.get(this.conductor(key))
    if (component) this.solve(component, (k) => (k === key ? 1 : 0), flow)
    return flow
  }

  private solve(component: Component, terminal: (key: string) => number, flow: Flow) {
    const entering = new Map<string, number>()
    let imbalance = 0
    let driven = false
    for (const v of component.vertices) {
      let amps = 0
      for (const k of this.keysAt(v)) {
        const t = terminal(k)
        if (t !== 0) driven = true
        amps -= t
      }
      if (amps !== 0) entering.set(v, amps)
      imbalance += amps
    }
    if (!driven) return
    const perTie = component.ties ? imbalance / component.ties : 0
    const sunk = new Map(component.sinks.map(({ vertex, ties }) => [vertex, perTie * ties]))
    for (const [v, amps] of sunk) entering.set(v, (entering.get(v) ?? 0) - amps)
    const phi = potentials(component.row, component.factors, (v) => entering.get(v) ?? 0)
    for (const id of component.wires) {
      const [a, b] = this.ends.get(id)!
      flow.wires.set(id, phi(a) - phi(b))
    }
    const into = (pin: string) => (this.incident.get(pin) ?? []).reduce((sum, { wire, into }) => sum + into * flow.wires.get(wire)!, 0)
    const contactsAt = new Map<string, Map<string, number>>()
    for (const pin of component.leads) {
      if (!this.net.contacts.has(pin)) {
        flow.leads.set(pin, into(pin))
        continue
      }
      const vertex = this.conductor(pin)
      let through = contactsAt.get(vertex)
      if (!through) {
        through = this.throughContacts(vertex, terminal, into, sunk.get(vertex) ?? 0)
        contactsAt.set(vertex, through)
      }
      flow.leads.set(pin, into(pin) + (through.get(pin) ?? 0))
    }
  }

  private inside(vertex: string): Inside {
    const known = this.insides.get(vertex)
    if (known) return known
    const keys = this.keysAt(vertex)
    const nodes = [...keys]
    const edges: [string, string][] = []
    const planeOf = new Map<string, string>()
    ;(this.shortsIn.get(vertex) ?? []).forEach((group, i) => {
      const plane = `\0short${i}`
      nodes.push(plane)
      for (const key of group) {
        edges.push([plane, key])
        planeOf.set(key, plane)
      }
    })
    const contacted: string[] = []
    for (const key of keys) {
      const group = this.net.contacts.get(key)
      if (group === undefined) continue
      const hub = contactHub(group)
      if (!nodes.includes(hub)) nodes.push(hub)
      edges.push([hub, key])
      contacted.push(key)
    }
    const rank = (k: string) => TIE_RANK[this.net.groundTies.get(k)!] ?? 0
    const best = Math.max(0, ...keys.map(rank))
    const ties = new Set(best > 0 ? keys.filter((k) => rank(k) === best) : [])
    const inside: Inside = { keys, planeOf, contacted, ties, ...laplacian(nodes, edges, nodes[0]) }
    this.insides.set(vertex, inside)
    return inside
  }

  private throughContacts(vertex: string, terminal: (key: string) => number, into: (pin: string) => number, sunk: number): Map<string, number> {
    const { keys, planeOf, contacted, ties, row, factors } = this.inside(vertex)
    const entering = new Map<string, number>()
    const add = (node: string, amps: number) => entering.set(node, (entering.get(node) ?? 0) + amps)
    for (const key of keys) {
      add(key, into(key))
      add(planeOf.get(key) ?? key, -terminal(key) - (ties.has(key) ? sunk / ties.size : 0))
    }
    const phi = potentials(row, factors, (node) => entering.get(node) ?? 0)
    const out = new Map<string, number>()
    for (const key of contacted) out.set(key, phi(contactHub(this.net.contacts.get(key)!)) - phi(key))
    return out
  }
}
