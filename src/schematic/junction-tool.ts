import type { Point, Schematic } from "./types"
import { withSegments, type NewId, type Wiring } from "./wire-edits"
import { cross, crossingOf, onLattice, samePoint, type WireSegment } from "./wires/segment"

export type JunctionRefusal = { readonly refused: "no-crossing" | "off-lattice"; readonly at: Point }

const randomId: NewId = () => crypto.randomUUID()

export const NO_CROSSING = { title: "No crossing here", why: "The junction tool joins two wires only where they cross. Elsewhere, end a wire on a wire to make a branch." }

export const NOT_ON_THE_LATTICE = { title: "Not on the lattice", why: "These wires cross between lattice points. A join there would leave wire ends off the lattice." }

export const JUNCTION_REFUSED: Record<JunctionRefusal["refused"], { title: string; why: string }> = { "no-crossing": NO_CROSSING, "off-lattice": NOT_ON_THE_LATTICE }

const EXACT = 1e-6

const passesThrough = (s: WireSegment, p: Point) => !samePoint(s.a, p) && !samePoint(s.b, p)

const parallel = (s: WireSegment, t: WireSegment) => cross({ x: 0, y: 0 }, { x: s.b.x - s.a.x, y: s.b.y - s.a.y }, { x: t.b.x - t.a.x, y: t.b.y - t.a.y }) === 0

const nearAnEnd = (s: WireSegment, p: Point) => Math.hypot(s.a.x - p.x, s.a.y - p.y) <= EXACT || Math.hypot(s.b.x - p.x, s.b.y - p.y) <= EXACT

export function crossingAt(wiring: Wiring, at: Point): readonly [WireSegment, WireSegment] | null {
  const sheet = wiring.sheet
  if (sheet.pinsAt(at).length || sheet.endsAt(at).length) return null
  const through = sheet.through(at).filter((s) => passesThrough(s, at))
  return through.length === 2 && !parallel(through[0], through[1]) ? [through[0], through[1]] : null
}

export type Crossing = { readonly at: Point; readonly wires: readonly [WireSegment, WireSegment] }

export function crossingNear(wiring: Wiring, pointer: Point, reach: number): Crossing | null {
  const near = wiring.sheet.within(pointer, reach)
  let best: Crossing | null = null
  let distance = reach
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      const s = near[i]
      const t = near[j]
      if (parallel(s, t)) continue
      const at = crossingOf(s, t)
      if (!at || nearAnEnd(s, at) || nearAnEnd(t, at)) continue
      const d = Math.hypot(at.x - pointer.x, at.y - pointer.y)
      if (d > distance) continue
      best = { at, wires: [s, t] }
      distance = d
    }
  }
  return best
}

const halvesOf = (s: WireSegment, at: Point, newId: NewId): WireSegment[] => [
  { ...s, b: at },
  { ...s, id: newId(), a: at },
]

export function junctionAt(doc: Schematic, wiring: Wiring, at: Point, newId: NewId = randomId): Schematic | JunctionRefusal {
  if (!onLattice(at)) return crossingNear(wiring, at, EXACT) ? { refused: "off-lattice", at } : { refused: "no-crossing", at }
  const crossing = crossingAt(wiring, at)
  if (!crossing) return { refused: "no-crossing", at }
  return withSegments(doc, crossing.flatMap((s) => halvesOf(s, at, newId)), crossing, [at], newId)
}
