import type { FlowGraph } from "@/schematic/circuit"
import type { FlowNet } from "@/sim/flow"
import type { GroundTie } from "@/sim/netlist"

export const schematicTies = (keys: Iterable<string>): ReadonlyMap<string, GroundTie> => new Map([...keys].map((key) => [key, "schematic"] as const))

export const flowNetOf = (pinNet: ReadonlyMap<string, number>, groundKeys: Iterable<string> = []): FlowNet => ({
  pinNet: new Map(pinNet),
  groundTies: schematicTies(groundKeys),
  contacts: new Map(),
  conductorOf: new Map(),
  partShorts: [],
})

export function referenceWireCurrents(flow: FlowGraph, pinNet: ReadonlyMap<string, number>, groundTies: ReadonlyMap<string, GroundTie>, terminal: (key: string) => number): Map<string, number> {
  const result = new Map<string, number>()
  const members = new Map<string, string[]>()
  for (const [key, v] of Object.entries(flow.pins)) {
    const list = members.get(v)
    if (list) list.push(key)
    else members.set(v, [key])
  }
  const injected = (v: string) => {
    let sum = 0
    for (const key of members.get(v) ?? []) sum += terminal(key)
    return sum
  }
  const adj = new Map<string, { run: string; other: string }[]>()
  const link = (a: string, b: string, run: string) => {
    const list = adj.get(a)
    if (list) list.push({ run, other: b })
    else adj.set(a, [{ run, other: b }])
  }
  for (const r of flow.runs) {
    result.set(r.id, 0)
    if (r.a === r.b) continue
    link(r.a, r.b, r.id)
    link(r.b, r.a, r.id)
  }
  const ends = new Map(flow.runs.map((r) => [r.id, r] as const))
  const seen = new Set<string>()
  for (const start of adj.keys()) {
    if (seen.has(start)) continue
    const keys: string[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const k = stack.pop()!
      keys.push(k)
      for (const { other } of adj.get(k)!) {
        if (!seen.has(other)) {
          seen.add(other)
          stack.push(other)
        }
      }
    }
    if (!keys.some((k) => members.get(k)?.some((key) => pinNet.get(key) !== undefined))) continue
    const index = new Map(keys.map((k, i) => [k, i]))
    const rank = (key: string) => ({ reference: 1, schematic: 2, none: 0 })[groundTies.get(key) ?? "none"]
    const best = Math.max(0, ...keys.flatMap((k) => (members.get(k) ?? []).map(rank)))
    const tiesAt = (k: string) => (best ? (members.get(k)?.filter((key) => rank(key) === best).length ?? 0) : 0)
    const ties = keys.reduce((sum, k) => sum + tiesAt(k), 0)
    const imbalance = keys.reduce((sum, k) => sum - injected(k), 0)
    const entering = (k: string) => -injected(k) - (ties ? (imbalance * tiesAt(k)) / ties : 0)
    const fixed = new Set<number>([Math.max(0, keys.findIndex((k) => tiesAt(k) > 0))])
    const free = keys.map((_, i) => i).filter((i) => !fixed.has(i))
    const pos = new Map(free.map((i, j) => [i, j]))
    const m = free.length
    const L = new Float64Array(m * m)
    const b = new Float64Array(m)
    const runs = new Set<string>()
    for (const k of keys) {
      const i = index.get(k)!
      const row = pos.get(i)
      for (const { run } of adj.get(k)!) runs.add(run)
      if (row === undefined) continue
      b[row] = entering(k)
      for (const { other } of adj.get(k)!) {
        const j = index.get(other)!
        L[row * m + row] += 1
        const col = pos.get(j)
        if (col !== undefined) L[row * m + col] -= 1
      }
    }
    const phi = solve(L, b, m)
    const potential = (k: string) => {
      const p = pos.get(index.get(k)!)
      return p === undefined ? 0 : phi[p]
    }
    for (const id of runs) {
      const r = ends.get(id)!
      result.set(id, potential(r.a) - potential(r.b))
    }
  }
  return result
}

function solve(A: Float64Array, z: Float64Array, N: number): Float64Array {
  const M = Float64Array.from(A)
  const b = Float64Array.from(z)
  const x = new Float64Array(N)
  for (let col = 0; col < N; col++) {
    let piv = col
    for (let r = col + 1; r < N; r++) if (Math.abs(M[r * N + col]) > Math.abs(M[piv * N + col])) piv = r
    if (Math.abs(M[piv * N + col]) < 1e-12) return x
    if (piv !== col) {
      for (let c = 0; c < N; c++) {
        const t = M[col * N + c]
        M[col * N + c] = M[piv * N + c]
        M[piv * N + c] = t
      }
      const t = b[col]
      b[col] = b[piv]
      b[piv] = t
    }
    for (let r = col + 1; r < N; r++) {
      const f = M[r * N + col] / M[col * N + col]
      if (f === 0) continue
      for (let c = col; c < N; c++) M[r * N + c] -= f * M[col * N + c]
      b[r] -= f * b[col]
    }
  }
  for (let r = N - 1; r >= 0; r--) {
    let s = b[r]
    for (let c = r + 1; c < N; c++) s -= M[r * N + c] * x[c]
    x[r] = s / M[r * N + r]
  }
  return x
}
