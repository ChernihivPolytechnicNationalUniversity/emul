import type { Point, Schematic } from "./types"
import { withSegments, type NewId, type Wiring } from "./wire-edits"
import { isHorizontal, samePoint, type WireSegment } from "./wires/segment"

export type JunctionRefusal = { readonly refused: "no-crossing" | "off-lattice"; readonly at: Point }

const randomId: NewId = () => crypto.randomUUID()

export const NO_CROSSING = { title: "No crossing here", why: "The junction tool joins two wires only where they cross. Elsewhere, end a wire on a wire to make a branch." }

export const NOT_ON_THE_LATTICE = { title: "Not on the lattice", why: "These wires cross between lattice points. A join there would leave wire ends off the lattice." }

const passesThrough = (s: WireSegment, p: Point) => !samePoint(s.a, p) && !samePoint(s.b, p)

export function crossingAt(wiring: Wiring, at: Point): readonly [WireSegment, WireSegment] | null {
  const sheet = wiring.sheet
  if (sheet.pinsAt(at).length || sheet.endsAt(at).length) return null
  const through = sheet.through(at).filter((s) => passesThrough(s, at))
  const across = through.find(isHorizontal)
  const upright = through.find((s) => !isHorizontal(s))
  return across && upright && through.length === 2 ? [across, upright] : null
}

const halvesOf = (s: WireSegment, at: Point, newId: NewId): WireSegment[] => [
  { ...s, b: at },
  { ...s, id: newId(), a: at },
]

export function junctionAt(doc: Schematic, wiring: Wiring, at: Point, newId: NewId = randomId): Schematic | JunctionRefusal {
  const crossing = crossingAt(wiring, at)
  if (!crossing) return { refused: "no-crossing", at }
  return withSegments(doc, crossing.flatMap((s) => halvesOf(s, at, newId)), crossing, [at], newId)
}
