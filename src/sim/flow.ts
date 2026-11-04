import type { FlowGraph, FlowRun } from "@/schematic/circuit"

type Factors = { lu: Float64Array; pivot: Int32Array; n: number; singular: boolean }

type Component = { vertices: readonly string[]; runs: readonly string[]; row: ReadonlyMap<string, number>; factors: Factors }

const SINGULAR = 1e-12

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
  for (let r = 0; r < n; r++) {
    let s = b[r]
    for (let c = 0; c < r; c++) s -= lu[r * n + c] * b[c]
    b[r] = s
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]
    for (let c = r + 1; c < n; c++) s -= lu[r * n + c] * x[c]
    x[r] = s / lu[r * n + r]
  }
  return x
}

export class FlowSolver {
  private readonly members = new Map<string, string[]>()
  private readonly vertexOf = new Map<string, string>()
  private readonly componentOf = new Map<string, Component>()
  private readonly components: Component[] = []
  private readonly ends: ReadonlyMap<string, FlowRun>
  private readonly flow: FlowGraph

  constructor(flow: FlowGraph, pinNet: ReadonlyMap<string, number>, groundKeys: ReadonlySet<string>) {
    this.flow = flow
    for (const [key, v] of Object.entries(flow.pins)) {
      this.vertexOf.set(key, v)
      const list = this.members.get(v)
      if (list) list.push(key)
      else this.members.set(v, [key])
    }
    const adj = new Map<string, { run: string; other: string }[]>()
    const link = (a: string, b: string, run: string) => {
      const list = adj.get(a)
      if (list) list.push({ run, other: b })
      else adj.set(a, [{ run, other: b }])
    }
    for (const r of flow.runs) {
      if (r.a === r.b) continue
      link(r.a, r.b, r.id)
      link(r.b, r.a, r.id)
    }
    this.ends = new Map(flow.runs.map((r) => [r.id, r] as const))
    const seen = new Set<string>()
    for (const start of adj.keys()) {
      if (seen.has(start)) continue
      const vertices: string[] = []
      const stack = [start]
      seen.add(start)
      while (stack.length) {
        const k = stack.pop()!
        vertices.push(k)
        for (const { other } of adj.get(k)!) {
          if (seen.has(other)) continue
          seen.add(other)
          stack.push(other)
        }
      }
      if (!vertices.some((k) => this.members.get(k)?.some((key) => pinNet.get(key) !== undefined))) continue
      const index = new Map(vertices.map((k, i) => [k, i]))
      const fixed = new Set<number>()
      for (const k of vertices) if (this.members.get(k)?.some((key) => groundKeys.has(key))) fixed.add(index.get(k)!)
      if (fixed.size === 0) fixed.add(0)
      const row = new Map<string, number>()
      for (const k of vertices) if (!fixed.has(index.get(k)!)) row.set(k, row.size)
      const m = row.size
      const laplacian = new Float64Array(m * m)
      const runs = new Set<string>()
      for (const k of vertices) {
        for (const { run } of adj.get(k)!) runs.add(run)
        const i = row.get(k)
        if (i === undefined) continue
        for (const { other } of adj.get(k)!) {
          laplacian[i * m + i] += 1
          const j = row.get(other)
          if (j !== undefined) laplacian[i * m + j] -= 1
        }
      }
      const component: Component = { vertices, runs: [...runs], row, factors: factorised(laplacian, m) }
      this.components.push(component)
      for (const k of vertices) this.componentOf.set(k, component)
    }
  }

  private currentsIn(component: Component, injected: (vertex: string) => number, out: Map<string, number>) {
    const b = new Float64Array(component.row.size)
    let any = false
    for (const [k, i] of component.row) {
      const amps = injected(k)
      if (amps === 0) continue
      b[i] = -amps
      any = true
    }
    if (!any) return
    const phi = solvedWith(component.factors, b)
    const potential = (k: string) => {
      const i = component.row.get(k)
      return i === undefined ? 0 : phi[i]
    }
    for (const id of component.runs) {
      const r = this.ends.get(id)!
      out.set(id, potential(r.a) - potential(r.b))
    }
  }

  currents(terminal: (key: string) => number): Map<string, number> {
    const out = new Map<string, number>()
    for (const r of this.flow.runs) out.set(r.id, 0)
    const injected = (v: string) => {
      let sum = 0
      for (const key of this.members.get(v) ?? []) sum += terminal(key)
      return sum
    }
    for (const component of this.components) this.currentsIn(component, injected, out)
    return out
  }

  unit(key: string): Map<string, number> {
    const out = new Map<string, number>()
    const vertex = this.vertexOf.get(key)
    const component = vertex === undefined ? undefined : this.componentOf.get(vertex)
    if (component) this.currentsIn(component, (v) => (v === vertex ? 1 : 0), out)
    return out
  }
}

export const wireCurrents = (flow: FlowGraph, pinNet: ReadonlyMap<string, number>, groundKeys: ReadonlySet<string>, terminal: (key: string) => number): Map<string, number> =>
  new FlowSolver(flow, pinNet, groundKeys).currents(terminal)
