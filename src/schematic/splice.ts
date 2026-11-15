import { GRID, objectPins, type Point, type Rect } from "./geometry"
import { documentPins } from "./pin-index"
import { getDef } from "./registry"
import type { PlacedObject, Schematic } from "./types"
import { segmentsCollinear, segmentsEndingAt, withSegments, type NewId } from "./wire-edits"
import { cross, passesInside, samePoint, type WireSegment } from "./wires/segment"

const randomId: NewId = () => crypto.randomUUID()

type Span = { readonly a: Point; readonly b: Point }

const spliceable = (object: PlacedObject): Span | null => {
  const def = getDef(object.def)
  if (!def || def.pinsAreSockets || def.pins.length !== 2 || def.pins.some((p) => p.kind === "node")) return null
  const [a, b] = objectPins(object, GRID)
  return a && b && !samePoint(a.point, b.point) ? { a: a.point, b: b.point } : null
}

const alongSpan = (span: Span, p: Point) => (p.x - span.a.x) * (span.b.x - span.a.x) + (p.y - span.a.y) * (span.b.y - span.a.y)

const onSpanLine = (span: Span, s: WireSegment) => cross(span.a, span.b, s.a) === 0 && cross(span.a, span.b, s.b) === 0

const extent = (span: Span, s: WireSegment) => {
  const p = alongSpan(span, s.a)
  const q = alongSpan(span, s.b)
  return p <= q ? ([p, q, s.a, s.b] as const) : ([q, p, s.b, s.a] as const)
}

const boxOf = (span: Span): Rect => ({ x: Math.min(span.a.x, span.b.x), y: Math.min(span.a.y, span.b.y), w: Math.abs(span.b.x - span.a.x), h: Math.abs(span.b.y - span.a.y) })

function stretchUnder(doc: Schematic, part: PlacedObject, span: Span): WireSegment[] | null {
  const end = alongSpan(span, span.b)
  const under = segmentsCollinear(doc.wires, span).filter((s) => {
    if (!onSpanLine(span, s)) return false
    const [lo, hi] = extent(span, s)
    return hi > 0 && lo < end
  })
  if (!under.length || under.some((s) => extent(span, s)[0] < 0 || extent(span, s)[1] > end)) return null
  const sorted = [...under].sort((p, q) => extent(span, p)[0] - extent(span, q)[0])
  let reached = 0
  for (const s of sorted) {
    const [lo, hi] = extent(span, s)
    if (lo !== reached) return null
    reached = hi
  }
  if (reached !== end) return null
  for (const s of sorted.slice(1)) {
    const ends = segmentsEndingAt(doc.wires, extent(span, s)[2])
    if (ends.length !== 2 || ends.some((t) => !under.includes(t))) return null
  }
  for (const p of documentPins(doc.objects).within(boxOf(span))) {
    if (p.key.startsWith(`${part.id}:`)) continue
    if (passesInside(span, p.at)) return null
  }
  return under
}

export function splicedAt(doc: Schematic, objectIds: Iterable<string>, newId: NewId = randomId): Schematic {
  let current = doc
  for (const id of objectIds) {
    const part = current.objects.find((o) => o.id === id)
    const span = part && spliceable(part)
    if (!part || !span) continue
    const settled = withSegments(current, [], [], [span.a, span.b], newId)
    const under = stretchUnder(settled, part, span)
    if (!under) continue
    current = withSegments(settled, [], under, [span.a, span.b], newId)
  }
  return current
}
