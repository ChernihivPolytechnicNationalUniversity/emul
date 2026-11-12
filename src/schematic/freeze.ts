import { DIR, framePoint, GRID, objectPins, orientationOf, orientationSlot, ownBodies, routeObstacles, unionOf, type Direction, type Orientation, type Point, type Rect } from "./geometry"
import { getDef } from "./registry"
import type { ComponentDef, LegacyWire, PlacedObject } from "./types"
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

type Shunt = readonly [Point, Point]

const shuntsByDef = new WeakMap<ComponentDef, (readonly Shunt[] | undefined)[]>()

function shuntsOf(def: ComponentDef, orientation: Orientation): readonly Shunt[] {
  let slots = shuntsByDef.get(def)
  if (!slots) shuntsByDef.set(def, (slots = []))
  return (slots[orientationSlot(orientation)] ??= (def.parts ?? []).flatMap((part): Shunt[] => {
    if (part.type !== "switch" || part.throws) return []
    const far = part.vertical ? { x: part.x, y: part.y + part.span } : { x: part.x + part.span, y: part.y }
    return [[framePoint(def, orientation, part), framePoint(def, orientation, far)]]
  }))
}

const SHUNT_EPS = 1e-6

function shuntFrom(o: PlacedObject, def: ComponentDef, at: Point): Point | undefined {
  const local = { x: (at.x - o.x) / GRID, y: (at.y - o.y) / GRID }
  for (const [p, q] of shuntsOf(def, orientationOf(o)))
    for (const [end, far] of [[p, q], [q, p]])
      if (Math.abs(end.x - local.x) < SHUNT_EPS && Math.abs(end.y - local.y) < SHUNT_EPS) return { x: Math.round((far.x - end.x) * GRID * 1e6) / 1e6, y: Math.round((far.y - end.y) * GRID * 1e6) / 1e6 }
  return undefined
}

export function wirePins(objects: readonly PlacedObject[]): WirePin[] {
  return objects.flatMap((o) => {
    if (isJunction(o)) return []
    const def = getDef(o.def)
    const socket = !!def?.pinsAreSockets
    return objectPins(o, GRID).flatMap((p) => {
      if (!onLattice(p.point)) return []
      const shunt = socket && def?.parts ? shuntFrom(o, def, p.point) : undefined
      return [{ key: p.key, at: p.point, socket, kind: p.pin.kind, ...(p.pin.side in DIR && { out: DIR[p.pin.side as Direction] }), ...(shunt && { shunt }) }]
    })
  })
}

export type Lay = { wire: LegacyWire; own: ReadonlySet<string>; from: Point; to: Point; fromObject: string; toObject: string; candidates: Point[][] }

const grown = (r: Rect, by: number): Box => ({ x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by })

const WINDOW_CELLS = [6, 24, 96]

const clipped = (r: Box, to: Box): Box => {
  const x = Math.max(r.x, to.x)
  const y = Math.max(r.y, to.y)
  return { x, y, w: Math.min(r.x + r.w, to.x + to.w) - x, h: Math.min(r.y + r.h, to.y + to.h) - y }
}

export function laidAgain(l: Lay, byId: ReadonlyMap<string, PlacedObject>, objects: readonly PlacedObject[], conductors: Conductors, extent: Rect): Point[] | null {
  const clear = (pts: readonly Point[] | null): pts is Point[] => clearOf(conductors, l.own, pts)
  const bodies = [...routeObstacles(objects, GRID, l.fromObject, l.toObject), ...ownBodies(byId, GRID, l.fromObject, l.toObject)]
  const span = { x: Math.min(l.from.x, l.to.x), y: Math.min(l.from.y, l.to.y), w: Math.abs(l.from.x - l.to.x), h: Math.abs(l.from.y - l.to.y) }
  const whole = grown(unionOf([span, extent]), 4 * GRID)
  const windows = WINDOW_CELLS.map((cells) => clipped(grown(span, cells * GRID), whole)).filter((w, i, all) => i === 0 || w.w > all[i - 1].w || w.h > all[i - 1].h)
  for (const around of windows) {
    const path = clearPath(l.from, l.to, conductors.foreign(l.own, around, bodies), GRID)
    if (clear(path)) return path
  }
  return null
}

