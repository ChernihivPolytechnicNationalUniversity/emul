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

export type SelectionWiring = Pick<Wiring, "source" | "segmentsById" | "runBySegment">

const sameSegment = (s: WireSegment, t: WireSegment) => s === t || (samePoint(s.a, t.a) && samePoint(s.b, t.b)) || (samePoint(s.a, t.b) && samePoint(s.b, t.a))

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id))

const lineKey = (s: WireSegment) => (s.a.y === s.b.y ? `h${s.a.y}` : s.a.x === s.b.x ? `v${s.a.x}` : "slant")

function overlaps(s: WireSegment, t: WireSegment): boolean {
  const dx = t.b.x - t.a.x
  const dy = t.b.y - t.a.y
  const across = (p: Point) => (p.x - t.a.x) * dy - (p.y - t.a.y) * dx
  if (across(s.a) !== 0 || across(s.b) !== 0) return false
  const along = (p: Point) => (p.x - t.a.x) * dx + (p.y - t.a.y) * dy
  const from = Math.max(0, Math.min(along(s.a), along(s.b)))
  const to = Math.min(dx * dx + dy * dy, Math.max(along(s.a), along(s.b)))
  return to > from
}

type Left = { readonly was: WireSegment; readonly whole: boolean }

export function carriedSelection(selected: ReadonlySet<string>, before: SelectionWiring, after: SelectionWiring): ReadonlySet<string> {
  if (!selected.size || before === after) return selected
  const wholeBefore = new Map<string, boolean>()
  const wasWhole = (run: Run) => {
    let whole = wholeBefore.get(run.id)
    if (whole === undefined) wholeBefore.set(run.id, (whole = run.segments.every((s) => selected.has(s.id))))
    return whole
  }
  const kept = new Set<string>()
  const wholeAfter = new Set<Run>()
  const left = new Map<string, Left[]>()
  const keep = (id: string, whole: boolean) => {
    kept.add(id)
    const run = after.runBySegment.get(id)
    if (whole && run) wholeAfter.add(run)
  }
  for (const id of selected) {
    const was = before.segmentsById.get(id)
    const now = after.segmentsById.get(id)
    const run = was && before.runBySegment.get(id)
    const whole = !!run && wasWhole(run)
    if (now) keep(id, whole)
    if (was && (!now || !sameSegment(was, now))) {
      const key = lineKey(was)
      const list = left.get(key)
      if (list) list.push({ was, whole })
      else left.set(key, [{ was, whole }])
    }
  }
  if (left.size)
    for (const s of after.source.wires) {
      const old = before.segmentsById.get(s.id)
      if (old && sameSegment(old, s)) continue
      for (const { was, whole } of left.get(lineKey(s)) ?? []) {
        if (!overlaps(s, was)) continue
        keep(s.id, whole)
        if (whole) break
      }
    }
  for (const run of wholeAfter) for (const s of run.segments) kept.add(s.id)
  return sameIds(kept, selected) ? selected : kept
}

export type TurnPresses = { readonly objects: string; readonly wires: ReadonlySet<string>; readonly of: SelectionWiring; readonly doc: object }

export const pressesGoOn = (last: TurnPresses | null, objects: string, wires: ReadonlySet<string>, doc: object, wiring: SelectionWiring) =>
  !!last && last.objects === objects && last.doc === doc && sameIds(carriedSelection(last.wires, last.of, wiring), wires)

const inside = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

export function inRect(doc: Schematic, rect: Rect, grid = GRID): { readonly objects: readonly string[]; readonly wires: readonly string[] } {
  return {
    objects: doc.objects.filter((o) => intersects(objectRect(o, grid), rect)).map((o) => o.id),
    wires: doc.wires.filter((s) => inside(s.a, rect) && inside(s.b, rect)).map((s) => s.id),
  }
}
