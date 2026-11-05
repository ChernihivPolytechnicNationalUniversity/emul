import type { Run } from "./circuit"
import { GRID, intersects, objectRect, type Rect } from "./geometry"
import type { Point, Schematic } from "./types"
import type { Wiring } from "./wire-edits"
import { samePoint, type WireSegment } from "./wires/segment"

function distanceTo(s: WireSegment, p: Point): number {
  const x = Math.max(Math.min(s.a.x, s.b.x), Math.min(Math.max(s.a.x, s.b.x), p.x))
  const y = Math.max(Math.min(s.a.y, s.b.y), Math.min(Math.max(s.a.y, s.b.y), p.y))
  return Math.hypot(p.x - x, p.y - y)
}

export function segmentNearest(run: Run, at: Point): string {
  let best = run.segments[0]
  let distance = Infinity
  for (const s of run.segments) {
    const d = distanceTo(s, at)
    if (d < distance) {
      best = s
      distance = d
    }
  }
  return best.id
}

const otherEnd = (s: WireSegment, p: Point) => (samePoint(s.a, p) ? s.b : s.a)

export function chainOf(wiring: Wiring, segment: string): readonly string[] {
  const sheet = wiring.sheet
  const first = sheet.segment(segment)
  if (!first) return []
  const chain = new Set<WireSegment>([first])
  const walk = (from: Point, via: WireSegment) => {
    let at = from
    let through = via
    for (;;) {
      const ends = sheet.endsAt(at)
      if (ends.length !== 2 || sheet.pinsAt(at).length) return
      const next = ends[0] === through ? ends[1] : ends[0]
      if (chain.has(next)) return
      chain.add(next)
      through = next
      at = otherEnd(next, at)
    }
  }
  walk(first.a, first)
  walk(first.b, first)
  return [...chain].map((s) => s.id)
}

const inside = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

export function inRect(doc: Schematic, rect: Rect, grid = GRID): { readonly objects: readonly string[]; readonly wires: readonly string[] } {
  return {
    objects: doc.objects.filter((o) => intersects(objectRect(o, grid), rect)).map((o) => o.id),
    wires: doc.wires.filter((s) => inside(s.a, rect) && inside(s.b, rect)).map((s) => s.id),
  }
}
