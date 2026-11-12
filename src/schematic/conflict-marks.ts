import { GRID } from "./grid"
import type { Point } from "./types"
import type { DrawRefusal } from "./wire-draw"
import type { DragFrame, DragPiece } from "./wires/drag"
import { pointKey, samePoint } from "./wires/segment"

export type Stretch = readonly Point[]

export type ConflictMarks = { readonly stretches: readonly Stretch[]; readonly parts: ReadonlySet<string> }

const NO_PARTS: ReadonlySet<string> = new Set()

const ownerOfPin = (key: string) => key.slice(0, key.indexOf(":"))

const farEnd = (piece: DragPiece, at: Point) => (samePoint(piece.a, at) ? piece.b : piece.a)

const isEndOf = (piece: DragPiece, at: Point) => samePoint(piece.a, at) || samePoint(piece.b, at)

export function stepTowards(from: Point, to: Point, reach: number): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  if (length <= reach) return to
  return { x: from.x + ((to.x - from.x) / length) * reach, y: from.y + ((to.y - from.y) / length) * reach }
}

const stretchKey = (stretch: Stretch) => {
  const forward = stretch.map(pointKey).join(" ")
  const backward = [...stretch].reverse().map(pointKey).join(" ")
  return forward < backward ? forward : backward
}

function distinct(stretches: readonly Stretch[]): Stretch[] {
  const seen = new Set<string>()
  return stretches.filter((stretch) => {
    const key = stretchKey(stretch)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function dragConflictMarks(frame: DragFrame, clashing: ReadonlySet<string> = NO_PARTS, reach = GRID): ConflictMarks {
  const parts = new Set(clashing)
  const whole = new Set<DragPiece>()
  const ends: { piece: DragPiece; at: Point }[] = []
  const piecesNamed = (id: string | undefined) => (id === undefined ? [] : frame.pieces.filter((p) => p.id === id))
  for (const conflict of frame.conflicts) {
    const named = piecesNamed(conflict.piece)
    switch (conflict.reason) {
      case "along":
      case "over":
      case "body":
        for (const piece of named) whole.add(piece)
        if (!named.length && conflict.part !== undefined) parts.add(conflict.part)
        break
      case "end":
        for (const piece of named) if (isEndOf(piece, conflict.at)) ends.push({ piece, at: conflict.at })
        break
      case "pin":
        if (conflict.pin !== undefined) parts.add(ownerOfPin(conflict.pin))
        break
      case "crossing":
        for (const piece of frame.pieces) if (isEndOf(piece, conflict.at)) ends.push({ piece, at: conflict.at })
        for (const [key, at] of frame.pins) if (samePoint(at, conflict.at)) parts.add(ownerOfPin(key))
        break
    }
  }
  const stretches: Stretch[] = [...whole].map((p) => [p.a, p.b])
  for (const { piece, at } of ends) if (!whole.has(piece)) stretches.push([at, stepTowards(at, farEnd(piece, at), reach)])
  if (frame.blocked && !stretches.length && !parts.size) for (const p of frame.pieces) stretches.push([p.a, p.b])
  return { stretches: distinct(stretches), parts }
}

function legsThrough(points: readonly Point[], at: Point, reach: number): Stretch | null {
  const vertex = points.findIndex((p) => samePoint(p, at))
  if (vertex >= 0) {
    const before = vertex > 0 ? [stepTowards(at, points[vertex - 1], reach)] : []
    const after = vertex < points.length - 1 ? [stepTowards(at, points[vertex + 1], reach)] : []
    return before.length || after.length ? [...before, at, ...after] : null
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const onLeg = (b.x - a.x) * (at.y - a.y) === (b.y - a.y) * (at.x - a.x) && at.x >= Math.min(a.x, b.x) && at.x <= Math.max(a.x, b.x) && at.y >= Math.min(a.y, b.y) && at.y <= Math.max(a.y, b.y)
    if (onLeg) return [stepTowards(at, a, reach), at, stepTowards(at, b, reach)]
  }
  return null
}

export function refusedStretches(points: readonly Point[], refusal: DrawRefusal | null, reach = GRID): Stretch[] {
  if (!refusal || refusal.refused === "nothing" || points.length < 2) return []
  const leg = refusal.leg
  if (leg !== undefined) return leg >= 0 && leg < points.length - 1 ? [[points[leg], points[leg + 1]]] : [[...points]]
  const around = legsThrough(points, refusal.at, reach)
  return [around ?? [...points]]
}

export function chained(stretches: readonly Stretch[]): Point[][] {
  const pending = distinct(stretches).filter((s) => s.some((p, i) => i > 0 && !samePoint(p, s[i - 1])))
  const endsAt = new Map<string, number>()
  for (const s of pending) for (const end of [s[0], s[s.length - 1]]) endsAt.set(pointKey(end), (endsAt.get(pointKey(end)) ?? 0) + 1)
  const meetsOne = (p: Point) => endsAt.get(pointKey(p)) === 2
  const used = new Set<number>()
  const out: Point[][] = []
  const nextFrom = (end: Point): Point[] | null => {
    if (!meetsOne(end)) return null
    const i = pending.findIndex((s, j) => !used.has(j) && (samePoint(s[0], end) || samePoint(s[s.length - 1], end)))
    if (i < 0) return null
    used.add(i)
    const s = pending[i]
    return samePoint(s[0], end) ? [...s] : [...s].reverse()
  }
  for (let i = 0; i < pending.length; i++) {
    if (used.has(i)) continue
    used.add(i)
    let line = [...pending[i]]
    for (let next = nextFrom(line[line.length - 1]); next; next = nextFrom(line[line.length - 1])) line = [...line, ...next.slice(1)]
    for (let next = nextFrom(line[0]); next; next = nextFrom(line[0])) line = [...[...next].reverse(), ...line.slice(1)]
    out.push(line)
  }
  return out
}

export function trimmedAtBends(line: readonly Point[], bendAt: (p: Point) => boolean, radius: number): Point[] {
  if (line.length < 2) return [...line]
  const last = line.length - 1
  const cut = (end: number, toward: number) => {
    const p = line[end]
    const q = line[toward]
    return bendAt(p) ? stepTowards(p, q, Math.min(radius, Math.hypot(q.x - p.x, q.y - p.y) / 2)) : p
  }
  return [cut(0, 1), ...line.slice(1, last), cut(last, last - 1)]
}

export function bendsOf(lines: readonly (readonly Point[])[]): (p: Point) => boolean {
  const bends = new Set<string>()
  for (const pts of lines)
    for (let i = 1; i < pts.length - 1; i++) {
      const [p, c, n] = [pts[i - 1], pts[i], pts[i + 1]]
      if ((c.x - p.x) * (n.y - c.y) !== (c.y - p.y) * (n.x - c.x)) bends.add(pointKey(c))
    }
  return (p) => bends.has(pointKey(p))
}
