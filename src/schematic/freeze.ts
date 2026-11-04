import { bodyCrossings, DIR, facingOf, GRID, objectPins, ownBodies, resolvePinIn, routeObstacles, routeWire, unionOf, type Facing, type Point, type Rect } from "./geometry"
import { getDef } from "./registry"
import type { LegacyWire, PlacedObject, Side } from "./types"
import { clearPath, type Box } from "./wires/clear-path"
import { clearOf, type Conductors } from "./wires/conductors"
import { onLattice, type WirePin } from "./wires/segment"

export const JUNCTION = "junction"

export const isJunction = (o: PlacedObject) => o.def === JUNCTION

const same = (p: Point, q: Point) => p.x === q.x && p.y === q.y

const diagonal = (p: Point, q: Point) => p.x !== q.x && p.y !== q.y

export function corners(input: readonly Point[]): Point[] {
  let pts = [...input]
  for (;;) {
    const out: Point[] = []
    for (const p of pts) {
      if (out.length && same(out[out.length - 1], p)) continue
      if (out.length >= 2) {
        const a = out[out.length - 2]
        const b = out[out.length - 1]
        if (!diagonal(a, b) && !diagonal(b, p) && (a.x === b.x) === (b.x === p.x) && (a.y === b.y) === (b.y === p.y)) {
          out[out.length - 1] = p
          continue
        }
      }
      out.push(p)
    }
    if (out.length === pts.length) return out
    pts = out
  }
}

function stepAt(pts: readonly Point[]): Point[] {
  const [p, s, n] = pts
  const corner = (n ? n.x === s.x : true) ? { x: s.x, y: p.y } : { x: p.x, y: s.y }
  return [p, corner, ...pts.slice(1)]
}

function slideAt(pts: readonly Point[]): Point[] {
  const [p, s, n, m] = pts
  if (!n || !m || diagonal(s, n)) return stepAt(pts)
  const moved = n.x === s.x ? { x: p.x, y: n.y } : { x: n.x, y: p.y }
  return diagonal(moved, m) ? stepAt(pts) : [p, moved, ...pts.slice(3)]
}

function atBothEnds(pts: readonly Point[], fix: (pts: readonly Point[]) => Point[]): Point[] {
  let out = corners(pts)
  if (out.length > 1 && diagonal(out[0], out[1])) out = corners(fix(out))
  const n = out.length
  if (n > 1 && diagonal(out[n - 2], out[n - 1])) out = corners(fix([...out].reverse()).reverse())
  return out
}

function orthogonal(pts: readonly Point[]): Point[] {
  const out: Point[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && diagonal(last, p)) out.push({ x: p.x, y: last.y })
    out.push(p)
  }
  return corners(out)
}

const hasDiagonal = (pts: readonly Point[]) => pts.some((p, i) => i > 0 && diagonal(pts[i - 1], p))

export function frozenCandidates(route: readonly Point[], bodies: Rect[]): Point[][] {
  if (!hasDiagonal(route)) return [corners(route)]
  const step = orthogonal(atBothEnds(route, stepAt))
  const slide = orthogonal(atBothEnds(route, slideAt))
  if (slide.length === step.length && slide.every((p, i) => same(p, step[i]))) return [step]
  return bodyCrossings(slide, bodies) <= bodyCrossings(step, bodies) ? [slide, step] : [step]
}

const OUTWARD: Readonly<Record<Side, Readonly<Point>>> = { left: DIR.left, right: DIR.right, top: DIR.top, bottom: DIR.bottom }

export function wirePins(objects: readonly PlacedObject[]): WirePin[] {
  return objects.flatMap((o) => {
    if (isJunction(o)) return []
    const socket = !!getDef(o.def)?.pinsAreSockets
    return objectPins(o, GRID).flatMap((p) => (onLattice(p.point) ? [{ key: p.key, at: p.point, socket, kind: p.pin.kind, ...(p.pin.side in OUTWARD && { out: OUTWARD[p.pin.side as Side] }) }] : []))
  })
}

export type Lay = { wire: LegacyWire; own: ReadonlySet<string>; from: Point; to: Point; fromObject: string; toObject: string; candidates: Point[][] }

const grown = (r: Rect, by: number): Box => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by })

const turned = (facing: Facing) => facing !== "any" && facing.includes("-")

function routedAgain(l: Lay, byId: ReadonlyMap<string, PlacedObject>, objects: readonly PlacedObject[]): Point[] | null {
  const a = resolvePinIn(byId, l.wire.from, GRID)
  const b = resolvePinIn(byId, l.wire.to, GRID)
  if (!a || !b) return null
  const fa = facingOf(a.pin)
  const fb = facingOf(b.pin)
  const own = ownBodies(byId, GRID, l.fromObject, l.toObject)
  const pts = routeWire(a.point, turned(fa) ? "any" : fa, turned(fa) ? 0 : (a.pin.stub ?? 1), b.point, turned(fb) ? "any" : fb, turned(fb) ? 0 : (b.pin.stub ?? 1), GRID, l.wire.points ?? [], routeObstacles(objects, GRID, l.fromObject, l.toObject), own).pts
  return orthogonal(pts)
}

export function laidAgain(l: Lay, byId: ReadonlyMap<string, PlacedObject>, objects: readonly PlacedObject[], conductors: Conductors, extent: Rect): Point[] | null {
  const clear = (pts: readonly Point[] | null): pts is Point[] => clearOf(conductors, l.own, pts)
  const again = routedAgain(l, byId, objects)
  if (clear(again)) return again
  const bodies = [...routeObstacles(objects, GRID, l.fromObject, l.toObject), ...ownBodies(byId, GRID, l.fromObject, l.toObject)]
  const span = { x: Math.min(l.from.x, l.to.x), y: Math.min(l.from.y, l.to.y), w: Math.abs(l.from.x - l.to.x), h: Math.abs(l.from.y - l.to.y) }
  for (const around of [grown(span, 6 * GRID), grown(unionOf([span, extent]), 4 * GRID)]) {
    const path = clearPath(l.from, l.to, conductors.foreign(l.own, around, bodies), GRID)
    if (clear(path)) return path
  }
  return null
}

