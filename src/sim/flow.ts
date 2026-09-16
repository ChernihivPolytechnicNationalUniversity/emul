import type { Wire } from "@/schematic/types"
import { pinKey } from "@/schematic/types"

/**
 * Distribute element terminal currents over the wires of each net.
 * Wires are treated as equal unit conductances, so a net with loops splits current
 * evenly; a tree (the common case) gets the unique solution. Returns amps per wire,
 * positive when flowing from `wire.from` to `wire.to`.
 *
 * Pins that touch are one vertex, not two: they sit on the same point, so current passes
 * between them without a wire and their terminal currents belong to the same node.
 */
export function wireCurrents(
  wires: Wire[],
  pinNet: Map<string, number>,
  groundKeys: Set<string>,
  terminal: (key: string) => number,
  contacts: Map<string, string> = new Map(),
): Map<string, number> {
  const result = new Map<string, number>()
  const vertex = (key: string) => contacts.get(key) ?? key
  // Pins that share a vertex inject their currents there, even the ones no wire reaches.
  const members = new Map<string, string[]>()
  for (const key of contacts.keys()) {
    const v = vertex(key)
    const list = members.get(v)
    if (list) list.push(key)
    else members.set(v, [key])
  }
  const injected = (v: string) => {
    const group = members.get(v)
    if (!group) return terminal(v)
    let sum = 0
    for (const key of group) sum += terminal(key)
    return sum
  }
  // Adjacency over pin keys, only for wires on solved nets.
  const adj = new Map<string, { wire: Wire; other: string }[]>()
  const link = (a: string, b: string, wire: Wire) => {
    if (!adj.has(a)) adj.set(a, [])
    adj.get(a)!.push({ wire, other: b })
  }
  for (const w of wires) {
    const from = pinKey(w.from.object, w.from.pin)
    const to = pinKey(w.to.object, w.to.pin)
    const a = vertex(from)
    const b = vertex(to)
    // Unsolved net, or a wire drawn between two pins that already touch: nothing flows along it.
    if (pinNet.get(from) === undefined || a === b) {
      result.set(w.id, 0)
      continue
    }
    link(a, b, w)
    link(b, a, w)
  }

  const seen = new Set<string>()
  for (const start of adj.keys()) {
    if (seen.has(start)) continue
    // Connected component by wires.
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
    const index = new Map(keys.map((k, i) => [k, i]))
    // Reference vertices: ground pins if any, else the first vertex.
    const fixed = new Set<number>()
    // A vertex is a reference if any pin merged into it is grounded.
    const grounded = (v: string) => groundKeys.has(v) || (members.get(v)?.some((k) => groundKeys.has(k)) ?? false)
    for (const k of keys) if (grounded(k)) fixed.add(index.get(k)!)
    if (fixed.size === 0) fixed.add(0)
    const free = keys.map((_, i) => i).filter((i) => !fixed.has(i))
    const pos = new Map(free.map((i, j) => [i, j]))
    const m = free.length
    const L = new Float64Array(m * m)
    const b = new Float64Array(m)
    const edges: Wire[] = []
    for (const k of keys) {
      const i = index.get(k)!
      const row = pos.get(i)
      if (row === undefined) continue
      // Current entering the wire graph at this pin = −(current leaving into the element).
      b[row] = -injected(k)
      for (const { wire, other } of adj.get(k)!) {
        const j = index.get(other)!
        L[row * m + row] += 1
        const col = pos.get(j)
        if (col !== undefined) L[row * m + col] -= 1
        if (!edges.includes(wire)) edges.push(wire)
      }
    }
    const phi = solve(L, b, m)
    const potential = (k: string) => {
      const p = pos.get(index.get(k)!)
      return p === undefined ? 0 : phi[p]
    }
    for (const w of edges) {
      result.set(w.id, potential(vertex(pinKey(w.from.object, w.from.pin))) - potential(vertex(pinKey(w.to.object, w.to.pin))))
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
