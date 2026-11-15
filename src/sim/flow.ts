import type { FlowGraph } from "@/schematic/circuit"
import type { GroundTie, Netlist } from "./netlist"

export type FlowNet = Pick<Netlist, "pinNet" | "groundTies" | "contacts" | "conductorOf" | "partShorts">

export type Flow = { wires: Map<string, number>; leads: Map<string, number> }

type Factors = { lu: Float64Array; pivot: Int32Array; n: number; singular: boolean }

type Incidence = { run: string; into: 1 | -1 }

type Inside = { keys: readonly string[]; planeOf: ReadonlyMap<string, string>; points: readonly string[]; ties: ReadonlySet<string>; row: ReadonlyMap<string, number>; factors: Factors }

type Sink = { vertex: string; ties: number }

type Component = {
  vertices: readonly string[]
  runs: readonly string[]
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

class Partition {
  private readonly parent = new Map<string, string>()

  find(k: string): string {
    let root = k
    for (let p = this.parent.get(root); p !== undefined && p !== root; p = this.parent.get(root)) root = p
    if (!this.parent.has(k)) this.parent.set(k, k)
    for (let at = k; at !== root; ) {
      const next = this.parent.get(at)!
      this.parent.set(at, root)
      at = next
    }
    return root
  }

  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }

  roots(): Map<string, string> {
    const out = new Map<string, string>()
    for (const k of this.parent.keys()) out.set(k, this.find(k))
    return out
  }
}

export class FlowSolver {
  private readonly pointOf = new Map<string, string>()
  private readonly pinsAt = new Map<string, string[]>()
  private readonly rootOf: ReadonlyMap<string, string>
  private readonly members = new Map<string, string[]>()
  private readonly pointsIn = new Map<string, string[]>()
  private readonly ends = new Map<string, readonly [string, string]>()
  private readonly incident = new Map<string, Incidence[]>()
  private readonly components: Component[] = []
  private readonly componentOf = new Map<string, Component>()
  private readonly shortsIn = new Map<string, (readonly string[])[]>()
  private readonly inShort = new Set<string>()
  private readonly insides = new Map<string, Inside>()
  private readonly runIds: readonly string[]
  readonly leadPins: readonly string[]
  private readonly net: FlowNet

  constructor(flow: FlowGraph, net: FlowNet) {
    this.net = net
    this.runIds = flow.runs.map((r) => r.id)
    for (const [key, point] of Object.entries(flow.pins)) this.pointOf.set(key, point)
    for (const [key, group] of net.contacts) if (!this.pointOf.has(key)) this.pointOf.set(key, contactHub(group))
    const partition = new Partition()
    for (const [key, point] of this.pointOf) {
      partition.union(key, point)
      push(this.pinsAt, point, key)
    }
    for (const [key, conductor] of net.conductorOf) partition.union(key, conductor)
    for (const r of flow.runs) {
      partition.find(r.a)
      partition.find(r.b)
    }
    this.rootOf = partition.roots()
    const keys = new Set([...this.pointOf.keys(), ...net.conductorOf.keys(), ...net.groundTies.keys()])
    for (const key of keys) push(this.members, this.root(key), key)
    for (const point of this.pinsAt.keys()) push(this.pointsIn, this.root(point), point)
    for (const group of net.partShorts) {
      push(this.shortsIn, this.root(group[0]), group)
      for (const key of group) this.inShort.add(key)
    }

    const adjacent = new Map<string, string[]>()
    const runsOf = new Map<string, string[]>()
    for (const r of flow.runs) {
      const a = this.root(r.a)
      const b = this.root(r.b)
      if (a === b) continue
      this.ends.set(r.id, [a, b])
      push(this.incident, r.a, { run: r.id, into: -1 })
      push(this.incident, r.b, { run: r.id, into: 1 })
      push(adjacent, a, b)
      push(adjacent, b, a)
      push(runsOf, a, r.id)
    }
    const leadPins = new Set<string>()
    for (const key of keys) if (net.pinNet.has(key) && (this.inShort.has(key) || net.groundTies.has(key))) leadPins.add(key)
    this.leadPins = [...leadPins]
    const leadsAt = new Map<string, string[]>()
    for (const key of this.leadPins) push(leadsAt, this.root(key), key)

    const rank = (k: string) => {
      const tie = net.groundTies.get(k)
      return tie === undefined ? 0 : TIE_RANK[tie]
    }
    const seen = new Set<string>()
    for (const start of [...adjacent.keys(), ...leadsAt.keys()]) {
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
      if (!vertices.some((v) => this.keysAt(v).some((key) => net.pinNet.has(key)))) continue
      const best = Math.max(0, ...vertices.flatMap((v) => this.keysAt(v).map(rank)))
      const sinks = best > 0 ? vertices.map((vertex) => ({ vertex, ties: this.keysAt(vertex).filter((k) => rank(k) === best).length })).filter((sink) => sink.ties > 0) : []
      const componentRuns = vertices.flatMap((v) => runsOf.get(v) ?? [])
      const { row, factors } = laplacian(
        vertices,
        componentRuns.map((id) => this.ends.get(id)!),
        sinks[0]?.vertex ?? vertices[0],
      )
      const ties = sinks.reduce((sum, sink) => sum + sink.ties, 0)
      const component: Component = { vertices, runs: componentRuns, row, sinks, ties, factors, leads: vertices.flatMap((v) => leadsAt.get(v) ?? []) }
      this.components.push(component)
      for (const v of vertices) this.componentOf.set(v, component)
    }
  }

  private root(name: string): string {
    return this.rootOf.get(name) ?? name
  }

  private keysAt(vertex: string): readonly string[] {
    return this.members.get(vertex) ?? []
  }

  currents(terminal: (key: string) => number): Flow {
    const flow: Flow = { wires: new Map(this.runIds.map((id) => [id, 0])), leads: new Map() }
    for (const component of this.components) this.solve(component, terminal, flow)
    return flow
  }

  unit(key: string): Flow {
    const flow: Flow = { wires: new Map(), leads: new Map() }
    const component = this.componentOf.get(this.root(key))
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
    for (const id of component.runs) {
      const [a, b] = this.ends.get(id)!
      flow.wires.set(id, phi(a) - phi(b))
    }
    const into = (point: string) => (this.incident.get(point) ?? []).reduce((sum, { run, into }) => sum + into * flow.wires.get(run)!, 0)
    const shared = new Map<string, Map<string, number>>()
    for (const pin of component.leads) {
      const point = this.pointOf.get(pin)
      if (point === undefined) {
        flow.leads.set(pin, 0)
        continue
      }
      if (this.pinsAt.get(point)!.length === 1) {
        flow.leads.set(pin, into(point))
        continue
      }
      const vertex = this.root(pin)
      let through = shared.get(vertex)
      if (!through) {
        through = this.throughPoints(vertex, terminal, into, sunk.get(vertex) ?? 0)
        shared.set(vertex, through)
      }
      flow.leads.set(pin, through.get(pin) ?? 0)
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
    const points = this.pointsIn.get(vertex) ?? []
    for (const point of points) {
      nodes.push(point)
      for (const key of this.pinsAt.get(point)!) edges.push([point, key])
    }
    const rank = (k: string) => {
      const tie = this.net.groundTies.get(k)
      return tie === undefined ? 0 : TIE_RANK[tie]
    }
    const best = Math.max(0, ...keys.map(rank))
    const ties = new Set(best > 0 ? keys.filter((k) => rank(k) === best) : [])
    const inside: Inside = { keys, planeOf, points, ties, ...laplacian(nodes, edges, nodes[0]) }
    this.insides.set(vertex, inside)
    return inside
  }

  private throughPoints(vertex: string, terminal: (key: string) => number, into: (point: string) => number, sunk: number): Map<string, number> {
    const { keys, planeOf, points, ties, row, factors } = this.inside(vertex)
    const entering = new Map<string, number>()
    const add = (node: string, amps: number) => entering.set(node, (entering.get(node) ?? 0) + amps)
    for (const point of points) add(point, into(point))
    for (const key of keys) add(planeOf.get(key) ?? key, -terminal(key) - (ties.has(key) ? sunk / ties.size : 0))
    const phi = potentials(row, factors, (node) => entering.get(node) ?? 0)
    const out = new Map<string, number>()
    for (const point of points) for (const pin of this.pinsAt.get(point)!) out.set(pin, phi(point) - phi(pin))
    return out
  }
}
