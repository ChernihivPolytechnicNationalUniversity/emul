import type { Point } from "../types"
import { HALF_CELL, samePoint } from "./segment"

export const LATTICE_END = 1
export const LATTICE_ACROSS_H = 2
export const LATTICE_ACROSS_V = 4
export const LATTICE_PASS = 8

export type LatticeBox = { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

export type LatticeRoute = {
  readonly from: Point
  readonly to: Point
  readonly leave?: Point
  readonly arrive?: Point
}

export type LatticeOptions = { readonly box: LatticeBox; readonly flags: (p: Point) => number; readonly bendCost?: number; readonly limit?: number }

const STEPS: readonly Point[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
]

const START = 4

class Frontier {
  private readonly keys: number[] = []
  private readonly costs: number[] = []

  get size() {
    return this.keys.length
  }

  push(key: number, cost: number) {
    const keys = this.keys
    const costs = this.costs
    let at = keys.length
    keys.push(key)
    costs.push(cost)
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (costs[parent] <= cost) break
      keys[at] = keys[parent]
      costs[at] = costs[parent]
      at = parent
    }
    keys[at] = key
    costs[at] = cost
  }

  pop(): number {
    const keys = this.keys
    const costs = this.costs
    const top = keys[0]
    const lastKey = keys.pop()!
    const lastCost = costs.pop()!
    if (!keys.length) return top
    let at = 0
    for (;;) {
      const left = 2 * at + 1
      if (left >= keys.length) break
      const child = left + 1 < keys.length && costs[left + 1] < costs[left] ? left + 1 : left
      if (costs[child] >= lastCost) break
      keys[at] = keys[child]
      costs[at] = costs[child]
      at = child
    }
    keys[at] = lastKey
    costs[at] = lastCost
    return top
  }
}

export function latticeBoxAround(points: readonly Point[], margin: number): LatticeBox {
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs) - margin
  const y = Math.min(...ys) - margin
  return { x, y, w: Math.max(...xs) + margin - x, h: Math.max(...ys) + margin - y }
}

export function routeOnLattice(route: LatticeRoute, options: LatticeOptions): Point[] | null {
  const { box, flags } = options
  const bendCost = options.bendCost ?? 4
  const limit = options.limit ?? 400_000
  const columns = Math.round(box.w / HALF_CELL) + 1
  const rows = Math.round(box.h / HALF_CELL) + 1
  const cellOf = (p: Point) => {
    const i = (p.x - box.x) / HALF_CELL
    const j = (p.y - box.y) / HALF_CELL
    return i >= 0 && j >= 0 && i < columns && j < rows && Number.isInteger(i) && Number.isInteger(j) ? j * columns + i : -1
  }
  const pointOf = (cell: number): Point => ({ x: box.x + (cell % columns) * HALF_CELL, y: box.y + Math.floor(cell / columns) * HALF_CELL })
  const start = cellOf(route.from)
  const goal = cellOf(route.to)
  if (start < 0 || goal < 0) return null
  if (samePoint(route.from, route.to)) return [route.from]
  const known = new Int8Array(columns * rows).fill(-1)
  const flagAt = (cell: number) => {
    if (known[cell] < 0) known[cell] = flags(pointOf(cell))
    return known[cell]
  }
  const states = columns * rows * 5
  const cost = new Float64Array(states).fill(Infinity)
  const parent = new Int32Array(states).fill(-1)
  const goalX = route.to.x
  const goalY = route.to.y
  const estimate = (cell: number) => (Math.abs(pointOf(cell).x - goalX) + Math.abs(pointOf(cell).y - goalY)) / HALF_CELL
  const frontier = new Frontier()
  const first = start * 5 + START
  cost[first] = 0
  frontier.push(first, estimate(start))
  let expanded = 0
  while (frontier.size) {
    const state = frontier.pop()
    const cell = Math.floor(state / 5)
    const heading = state % 5
    if (cell === goal) return cornersOf(state, parent, pointOf)
    if (++expanded > limit) return null
    const here = cell === start ? 0 : flagAt(cell)
    const straightOnly = (here & (LATTICE_ACROSS_H | LATTICE_ACROSS_V | LATTICE_PASS)) !== 0
    for (let step = 0; step < 4; step++) {
      if (heading !== START && step === (heading + 2) % 4) continue
      if (straightOnly && heading !== START && step !== heading) continue
      const d = STEPS[step]
      if (heading === START && route.leave && d.x * route.leave.x + d.y * route.leave.y < 0) continue
      const at = pointOf(cell)
      const next = cellOf({ x: at.x + d.x * HALF_CELL, y: at.y + d.y * HALF_CELL })
      if (next < 0) continue
      if (next === goal) {
        if (route.arrive && d.x * route.arrive.x + d.y * route.arrive.y > 0) continue
      } else {
        const there = flagAt(next)
        if (there & LATTICE_END) continue
        if (step % 2 === 0 ? there & LATTICE_ACROSS_H : there & LATTICE_ACROSS_V) continue
      }
      const turned = heading !== START && step !== heading
      const nextState = next * 5 + step
      const nextCost = cost[state] + 1 + (turned ? bendCost : 0)
      if (nextCost >= cost[nextState]) continue
      cost[nextState] = nextCost
      parent[nextState] = state
      frontier.push(nextState, nextCost + estimate(next))
    }
  }
  return null
}

function cornersOf(state: number, parent: Int32Array, pointOf: (cell: number) => Point): Point[] {
  const cells: number[] = []
  for (let at = state; at >= 0; at = parent[at]) cells.push(Math.floor(at / 5))
  cells.reverse()
  const points = cells.map(pointOf)
  const corners: Point[] = [points[0]]
  for (let i = 1; i + 1 < points.length; i++) {
    const before = points[i - 1]
    const after = points[i + 1]
    const straight = (before.x === points[i].x && points[i].x === after.x) || (before.y === points[i].y && points[i].y === after.y)
    if (!straight) corners.push(points[i])
  }
  corners.push(points[points.length - 1])
  return corners
}
