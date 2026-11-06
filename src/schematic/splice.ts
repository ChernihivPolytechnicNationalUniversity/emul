import { GRID, objectPins, type Point, type Rect } from "./geometry"
import { documentPins } from "./pin-index"
import { columnCode, rowCode } from "./wires/sheet"
import { getDef } from "./registry"
import type { PlacedObject, Schematic } from "./types"
import { segmentsOnLine, withSegments, type NewId } from "./wire-edits"
import type { WireSegment } from "./wires/segment"

const randomId: NewId = () => crypto.randomUUID()

type Line = { along: "x" | "y"; across: "x" | "y"; at: number; lo: number; hi: number }

function lineBetween(a: Point, b: Point): Line | null {
  if (a.y === b.y && a.x !== b.x) return { along: "x", across: "y", at: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) }
  if (a.x === b.x && a.y !== b.y) return { along: "y", across: "x", at: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) }
  return null
}

const spliceable = (object: PlacedObject): readonly [Point, Point] | null => {
  const def = getDef(object.def)
  if (!def || def.pinsAreSockets || def.pins.length !== 2 || def.pins.some((p) => p.kind === "node")) return null
  const [a, b] = objectPins(object, GRID)
  return a && b ? [a.point, b.point] : null
}

const onLine = (s: WireSegment, line: Line) => s.a[line.across] === line.at && s.b[line.across] === line.at

const extent = (s: WireSegment, line: Line) => [Math.min(s.a[line.along], s.b[line.along]), Math.max(s.a[line.along], s.b[line.along])] as const

const pointAt = (line: Line, along: number): Point => (line.along === "x" ? { x: along, y: line.at } : { x: line.at, y: along })

const boxOf = (line: Line): Rect => (line.along === "x" ? { x: line.lo, y: line.at, w: line.hi - line.lo, h: 0 } : { x: line.at, y: line.lo, w: 0, h: line.hi - line.lo })

function stretchUnder(doc: Schematic, part: PlacedObject, line: Line): WireSegment[] | null {
  const code = line.along === "x" ? rowCode(line.at) : columnCode(line.at)
  const under = segmentsOnLine(doc.wires, code, line.lo, line.hi).filter((s) => {
    if (!onLine(s, line)) return false
    const [lo, hi] = extent(s, line)
    return hi > line.lo && lo < line.hi
  })
  if (!under.length || under.some((s) => extent(s, line)[0] < line.lo || extent(s, line)[1] > line.hi)) return null
  const sorted = [...under].sort((p, q) => extent(p, line)[0] - extent(q, line)[0])
  let reached = line.lo
  for (const s of sorted) {
    const [lo, hi] = extent(s, line)
    if (lo !== reached) return null
    reached = hi
  }
  if (reached !== line.hi) return null
  const inside = new Set(sorted.slice(1).map((s) => extent(s, line)[0]))
  for (const along of inside) {
    const p = pointAt(line, along)
    const ends = [...segmentsOnLine(doc.wires, rowCode(p.y), p.x, p.x), ...segmentsOnLine(doc.wires, columnCode(p.x), p.y, p.y)].filter((s) => (s.a.x === p.x && s.a.y === p.y) || (s.b.x === p.x && s.b.y === p.y))
    if (ends.length !== 2 || ends.some((s) => !under.includes(s))) return null
  }
  const box = boxOf(line)
  for (const p of documentPins(doc.objects).within(box)) {
    if (p.key.startsWith(`${part.id}:`)) continue
    if (p.at[line.across] === line.at && p.at[line.along] > line.lo && p.at[line.along] < line.hi) return null
  }
  return under
}

export function splicedAt(doc: Schematic, objectIds: Iterable<string>, newId: NewId = randomId): Schematic {
  let current = doc
  for (const id of objectIds) {
    const part = current.objects.find((o) => o.id === id)
    const pins = part && spliceable(part)
    const line = pins && lineBetween(pins[0], pins[1])
    if (!part || !pins || !line) continue
    const settled = withSegments(current, [], [], pins, newId)
    const under = stretchUnder(settled, part, line)
    if (!under) continue
    current = withSegments(settled, [], under, pins, newId)
  }
  return current
}
