import type { Point } from "../types"
import { HALF_CELL } from "./segment"

export type Box = { x: number; y: number; w: number; h: number }

const STOP = 1
const PIN = 2
const SOCKET = 4
const ROW = 8
const COLUMN = 16
const BODY = 32
const ALONG_X = 64
const ALONG_Y = 128

const TURN_BLOCKERS = STOP | SOCKET | ROW | COLUMN

export type Closed = { readonly box: Box; readonly blocks: (a: Point, b: Point) => boolean }

export class Foreign {
  readonly x0: number
  readonly y0: number
  readonly cols: number
  readonly rows: number
  readonly flags: Uint8Array
  readonly hClosed: Uint8Array
  readonly vClosed: Uint8Array
  strict = false

  constructor(bounds: Box) {
    this.x0 = Math.floor(bounds.x / HALF_CELL) * HALF_CELL
    this.y0 = Math.floor(bounds.y / HALF_CELL) * HALF_CELL
    this.cols = Math.ceil((bounds.x + bounds.w - this.x0) / HALF_CELL) + 1
    this.rows = Math.ceil((bounds.y + bounds.h - this.y0) / HALF_CELL) + 1
    this.flags = new Uint8Array(this.cols * this.rows)
    this.hClosed = new Uint8Array(this.cols * this.rows)
    this.vClosed = new Uint8Array(this.cols * this.rows)
  }

  indexOf(p: Point): number {
    const i = (p.x - this.x0) / HALF_CELL
    const j = (p.y - this.y0) / HALF_CELL
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1
    return j * this.cols + i
  }

  private mark(p: Point, flag: number) {
    const k = this.indexOf(p)
    if (k >= 0) this.flags[k] |= flag
  }

  pin(at: Point, socket: boolean, along?: Point) {
    this.mark(at, PIN | (socket ? SOCKET | (along ? (along.y === 0 ? ALONG_X : ALONG_Y) : 0) : STOP))
  }

  close({ box, blocks }: Closed) {
    const i0 = Math.max(0, Math.floor((box.x - this.x0) / HALF_CELL) - 1)
    const i1 = Math.min(this.cols - 1, Math.ceil((box.x + box.w - this.x0) / HALF_CELL) + 1)
    const j0 = Math.max(0, Math.floor((box.y - this.y0) / HALF_CELL) - 1)
    const j1 = Math.min(this.rows - 1, Math.ceil((box.y + box.h - this.y0) / HALF_CELL) + 1)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const p = { x: this.x0 + i * HALF_CELL, y: this.y0 + j * HALF_CELL }
        if (i + 1 < this.cols && blocks(p, { x: p.x + HALF_CELL, y: p.y })) this.hClosed[j * this.cols + i] = 1
        if (j + 1 < this.rows && blocks(p, { x: p.x, y: p.y + HALF_CELL })) this.vClosed[j * this.cols + i] = 1
      }
  }

  end(at: Point) {
    this.mark(at, STOP)
  }

  run(at: Point, horizontal: boolean) {
    this.mark(at, horizontal ? ROW : COLUMN)
  }

  body(r: Box) {
    const i0 = Math.max(0, Math.floor((r.x + 0.5 - this.x0) / HALF_CELL) + 1)
    const i1 = Math.min(this.cols - 1, Math.ceil((r.x + r.w - 0.5 - this.x0) / HALF_CELL) - 1)
    const j0 = Math.max(0, Math.floor((r.y + 0.5 - this.y0) / HALF_CELL) + 1)
    const j1 = Math.min(this.rows - 1, Math.ceil((r.y + r.h - 0.5 - this.y0) / HALF_CELL) - 1)
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.flags[j * this.cols + i] |= BODY
  }
}

const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

const STEP = 2
const OFF_THE_GRID = 3
const BEND = 6
const THROUGH_A_BODY = 40
const BESIDE_A_PIN = 12

class Buckets {
  private readonly lists: number[][] = []
  private lowest = 0

  push(cost: number, state: number) {
    ;(this.lists[cost] ??= []).push(state)
    if (cost < this.lowest) this.lowest = cost
  }

  get cost() {
    return this.lowest
  }

  pop(): number {
    for (; this.lowest < this.lists.length; this.lowest++) {
      const list = this.lists[this.lowest]
      if (list?.length) return list.pop()!
    }
    return -1
  }
}

export function clearPath(from: Point, to: Point, foreign: Foreign, grid: number): Point[] | null {
  const { x0, y0, cols, rows, flags, strict, hClosed, vClosed } = foreign
  const inside = (i: number, j: number) => i >= 0 && j >= 0 && i < cols && j < rows
  const pointOf = (cell: number): Point => ({ x: x0 + (cell % cols) * HALF_CELL, y: y0 + Math.floor(cell / cols) * HALF_CELL })
  const si = Math.round((from.x - x0) / HALF_CELL)
  const sj = Math.round((from.y - y0) / HALF_CELL)
  const ti = Math.round((to.x - x0) / HALF_CELL)
  const tj = Math.round((to.y - y0) / HALF_CELL)
  if (!inside(si, sj) || !inside(ti, tj)) return null
  const start = sj * cols + si
  const target = tj * cols + ti
  const atTarget = foreign.indexOf(to)
  if (atTarget >= 0 && flags[atTarget] & (ROW | COLUMN | STOP)) return null
  const cells = cols * rows
  const beside = new Uint8Array(cells)
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      if (!(flags[j * cols + i] & PIN)) continue
      for (let d = 0; d < 4; d++) {
        const ni = i + DX[d]
        const nj = j + DY[d]
        if (inside(ni, nj)) beside[nj * cols + ni] = 1
      }
    }
  const onRowLine = new Uint8Array(rows)
  for (let j = 0; j < rows; j++) onRowLine[j] = (y0 + j * HALF_CELL) % grid === 0 ? 1 : 0
  const onColumnLine = new Uint8Array(cols)
  for (let i = 0; i < cols; i++) onColumnLine[i] = (x0 + i * HALF_CELL) % grid === 0 ? 1 : 0
  const best = new Int32Array(cells * 4).fill(0x7fffffff)
  const back = new Int32Array(cells * 4).fill(-1)
  const queue = new Buckets()
  for (let d = 0; d < 4; d++) {
    best[start * 4 + d] = 0
    queue.push(0, start * 4 + d)
  }
  let reached = -1
  for (let state = queue.pop(); state >= 0; state = queue.pop()) {
    const cost = queue.cost
    if (cost > best[state]) continue
    const d = state & 3
    const cell = state >> 2
    if (cell === target) {
      reached = state
      break
    }
    const i = cell % cols
    const j = (cell - i) / cols
    const here = flags[cell]
    const atStart = cell === start
    for (let nd = 0; nd < 4; nd++) {
      const turning = !atStart && nd !== d
      if (turning && ((nd + 2) & 3) === d) continue
      if (turning && here & TURN_BLOCKERS) continue
      const ni = i + DX[nd]
      const nj = j + DY[nd]
      if (!inside(ni, nj)) continue
      const next = nj * cols + ni
      const there = flags[next]
      const isTarget = next === target
      if (there & STOP && !isTarget) continue
      if (nd % 2 === 0 ? here & there & ROW : here & there & COLUMN) continue
      if (strict && (nd === 0 ? hClosed[cell] : nd === 2 ? hClosed[next] : nd === 1 ? vClosed[cell] : vClosed[next])) continue
      if (strict && there & SOCKET && !isTarget && !(there & (nd % 2 === 0 ? ALONG_X : ALONG_Y))) continue
      const onLine = nd % 2 === 0 ? onRowLine[nj] : onColumnLine[ni]
      const step = STEP + (onLine ? 0 : OFF_THE_GRID) + (there & BODY ? THROUGH_A_BODY : 0) + (beside[next] && !isTarget ? BESIDE_A_PIN : 0) + (turning ? BEND : 0)
      const s = next * 4 + nd
      if (cost + step < best[s]) {
        best[s] = cost + step
        back[s] = state
        queue.push(cost + step, s)
      }
    }
  }
  if (reached < 0) return null
  const onPath: Point[] = []
  for (let s = reached; s >= 0; s = back[s]) onPath.push(pointOf(s >> 2))
  onPath.reverse()
  const corners: Point[] = [onPath[0]]
  for (let k = 1; k < onPath.length - 1; k++) {
    const a = corners[corners.length - 1]
    const b = onPath[k]
    const c = onPath[k + 1]
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) continue
    corners.push(b)
  }
  if (onPath.length > 1) corners.push(onPath[onPath.length - 1])
  return corners
}
