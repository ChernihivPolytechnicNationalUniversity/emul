import { framePoint, intersects, objectPins, objectRect, orientationOf, placedText, routeBox, standsOnItsDiagonal, unionOf, type Point, type Rect, type RoutedWire } from "./geometry"
import { getDef } from "./registry"
import { BoxIndex, BUCKET_CELLS } from "./spatial"
import { PointGrid } from "./contacts"
import { bodyAndLeads, bodyBounds, type Lead } from "./body"
import { blocksOf } from "./printed-text"
import { drawsAsField, placedFields } from "./fields"
import { bodiesOf, crossable, segmentBox, shiftedBody, spliceSpan, staysThrough } from "./body-crossing"
import type { ComponentDef, PlacedObject } from "./types"

export { bodyBounds }

const CLEARANCE_CELLS = 0.1
const TEXT_ADVANCE_EM = 0.55
const TEXT_INSET_CELLS = 0.04
const EPSILON = 1e-6
const SEARCH_RINGS = 24

type Quad = { corners: Point[]; box: Rect; names?: Point }

function frameOf(object: PlacedObject, def: ComponentDef, grid: number) {
  const orientation = orientationOf(object)
  return (p: Point): Point => {
    const at = framePoint(def, orientation, p)
    return { x: object.x + at.x * grid, y: object.y + at.y * grid }
  }
}

const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h

function propsOf(def: ComponentDef, object: PlacedObject): Record<string, string> {
  const props = { ...def.defaults, ...object.props }
  return def.derive ? { ...props, ...def.derive(props) } : props
}

function textRectsOf(object: PlacedObject, def: ComponentDef, grid: number): Rect[] {
  const at = frameOf(object, def, grid)
  const orientation = orientationOf(object)
  const props = propsOf(def, object)
  const inset = TEXT_INSET_CELLS * grid
  const rects: Rect[] = []
  for (const shape of def.body) {
    if (shape.type !== "text" || drawsAsField(shape)) continue
    const text = shape.text.replace(/\{(\w+)\}/g, (_, key: string) => props[key] ?? "")
    if (!text.trim()) continue
    const size = (shape.size ?? 0.4) * grid
    const w = text.length * TEXT_ADVANCE_EM * size
    const anchor = at({ x: shape.x, y: shape.y })
    const placed = placedText(shape.anchor ?? "middle", shape.rotate ?? 0, orientation)
    const start = placed.anchor === "start" ? 0 : placed.anchor === "end" ? -w : -w / 2
    const along = { x: start + inset, w: w - inset * 2 }
    const across = { y: -size / 2 + inset, h: size - inset * 2 }
    rects.push(
      placed.angle === 0
        ? { x: anchor.x + along.x, y: anchor.y + across.y, w: along.w, h: across.h }
        : { x: anchor.x + across.y, y: anchor.y - along.x - along.w, w: across.h, h: along.w },
    )
  }
  return rects
}

const outsideBody = <R extends Rect>(object: PlacedObject, rects: readonly R[], grid: number): R[] => {
  const body = footprint(object, grid)
  return body ? rects.filter((r) => r.w > 0 && r.h > 0 && !inside(r, body.box)) : []
}

const labelCache = new WeakMap<PlacedObject, { grid: number; rects: readonly Rect[] }>()

export function designatorRects(object: PlacedObject, grid: number): readonly Rect[] {
  const cached = labelCache.get(object)
  if (cached && cached.grid === grid) return cached.rects
  const def = getDef(object.def)
  const rects = def && !isJunction(object) ? [...placedFields(object, grid, def).map((f) => f.box), ...outsideBody(object, textRectsOf(object, def, grid), grid)] : []
  labelCache.set(object, { grid, rects })
  return rects
}

export type { Lead }

export type Footprint = { body: Quad; contour: Quad[]; outline: readonly (readonly Point[])[]; leads: readonly Lead[]; labels: Quad[] }

const occupiedContours = new WeakMap<ComponentDef, readonly Rect[]>()

function occupiedContour(def: ComponentDef): readonly Rect[] {
  let found = occupiedContours.get(def)
  if (!found) {
    const outline = contourOf(def)
    const drawsItsWhole = outline.length === 1 && outline[0] === bodyBounds(def)
    occupiedContours.set(def, (found = drawsItsWhole ? [bodyAndLeads(def).box] : outline))
  }
  return found
}

const leadPins = new WeakMap<ComponentDef, readonly number[]>()

function leadPinsOf(def: ComponentDef): readonly number[] {
  let found = leadPins.get(def)
  if (!found) {
    found = bodyAndLeads(def).leads.map(([pin]) => {
      const id = def.pins.find((p) => Math.abs(p.x - pin.x) < EPSILON && Math.abs(p.y - pin.y) < EPSILON)?.id
      return def.pins.findIndex((p) => p.id === id)
    })
    leadPins.set(def, found)
  }
  return found
}

function placedLeads(object: PlacedObject, def: ComponentDef, grid: number): readonly Lead[] {
  if (!bodyAndLeads(def).leads.length) return []
  const at = frameOf(object, def, grid)
  const pins = objectPins(object, grid)
  const owners = leadPinsOf(def)
  return bodyAndLeads(def).leads.map(([pin, body], i) => [pins[owners[i]]?.point ?? at(pin), at(body)] as const)
}

export function footprints(object: PlacedObject, grid: number): Footprint | null {
  const def = getDef(object.def)
  if (!def) return null
  const body = quadOf(object, def, bodyAndLeads(def).box, grid)
  if (body.box.w <= 0 || body.box.h <= 0) return null
  const contour = occupiedContour(def).map((r) => quadOf(object, def, r, grid))
  const housed = occupiedContour(def)[0] !== bodyAndLeads(def).box
  const outline = housed ? contour.map((q) => q.corners) : [bodyAndLeads(def).hull.map(frameOf(object, def, grid))]
  return { body, contour, outline, leads: placedLeads(object, def, grid), labels: [] }
}

const holds = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - CLEARANCE_CELLS && inner.y >= outer.y - CLEARANCE_CELLS && inner.x + inner.w <= outer.x + outer.w + CLEARANCE_CELLS && inner.y + inner.h <= outer.y + outer.h + CLEARANCE_CELLS

const contours = new WeakMap<ComponentDef, readonly Rect[]>()

export function contourOf(def: ComponentDef): readonly Rect[] {
  const cached = contours.get(def)
  if (cached) return cached
  const housings = def.body.flatMap((shape): Rect[] => (shape.type === "rect" && shape.fill === "board" ? [{ x: shape.x, y: shape.y, w: shape.w, h: shape.h }] : []))
  const tabs = blocksOf(def.body).map((block) => block.box).filter((box) => !housings.some((h) => holds(h, box)))
  const pieces = [...housings, ...tabs]
  const everyPinOnAPiece = def.pins.every((pin) => pieces.some((r) => holds(r, { x: pin.x, y: pin.y, w: 0, h: 0 })))
  const contour = housings.length && everyPinOnAPiece ? pieces : [bodyBounds(def)]
  contours.set(def, contour)
  return contour
}

const INSIDE: readonly ((p: Point, r: Rect) => number)[] = [(p, r) => p.x - r.x, (p, r) => r.x + r.w - p.x, (p, r) => p.y - r.y, (p, r) => r.y + r.h - p.y]

function clippedTo(corners: readonly Point[], r: Rect): Point[] {
  let out = [...corners]
  for (const inside of INSIDE) {
    const around = out
    out = []
    around.forEach((p, i) => {
      const q = around[(i + 1) % around.length]
      const dp = inside(p, r)
      const dq = inside(q, r)
      if (dp >= 0) out.push(p)
      if (dp >= 0 !== dq >= 0) out.push({ x: p.x + ((q.x - p.x) * dp) / (dp - dq), y: p.y + ((q.y - p.y) * dp) / (dp - dq) })
    })
  }
  return out
}

function quadOf(object: PlacedObject, def: ComponentDef, b: Rect, grid: number): Quad {
  const inset = Math.min(CLEARANCE_CELLS, b.w / 2, b.h / 2)
  const turned = [
    { x: b.x + inset, y: b.y + inset },
    { x: b.x + b.w - inset, y: b.y + inset },
    { x: b.x + b.w - inset, y: b.y + b.h - inset },
    { x: b.x + inset, y: b.y + b.h - inset },
  ].map(frameOf(object, def, grid))
  const corners = standsOnItsDiagonal(def, object.rotation ?? 0) ? clippedTo(turned, objectRect(object, grid)) : turned
  return { corners, box: boxOf(corners) }
}

export function footprint(object: PlacedObject, grid: number): Quad | null {
  const def = getDef(object.def)
  return def ? quadOf(object, def, bodyBounds(def), grid) : null
}

function boxOf(points: readonly Point[]): Rect {
  return unionOf(points.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))
}

const shiftedRect = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h })

const moved = (q: Quad, dx: number, dy: number): Quad => ({ corners: q.corners.map((p) => ({ x: p.x + dx, y: p.y + dy })), box: { x: q.box.x + dx, y: q.box.y + dy, w: q.box.w, h: q.box.h } })

function axesOf(points: readonly Point[]): Point[] {
  const axes: Point[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    if (len > 0) axes.push({ x: -(q.y - p.y) / len, y: (q.x - p.x) / len })
  }
  return axes
}

function separated(a: readonly Point[], b: readonly Point[]) {
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    const pa = a.map((p) => p.x * axis.x + p.y * axis.y)
    const pb = b.map((p) => p.x * axis.x + p.y * axis.y)
    if (Math.max(...pa) <= Math.min(...pb) + EPSILON || Math.max(...pb) <= Math.min(...pa) + EPSILON) return true
  }
  return false
}

const overlap = (a: readonly Point[], b: readonly Point[]) => !separated(a, b)

const bothSocketed = (a: PlacedObject, b: PlacedObject) => !!(getDef(a.def)?.pinsAreSockets && getDef(b.def)?.pinsAreSockets)

function strictlyInside(corners: readonly Point[], p: Point) {
  let side = 0
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % corners.length]
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
    if (Math.abs(cross) < EPSILON) return false
    if (side && Math.sign(cross) !== side) return false
    side = Math.sign(cross)
  }
  return true
}

export type PlacementScene = {
  objects: readonly PlacedObject[]
  routes: readonly RoutedWire[]
  grid: number
}

type Placed = { object: PlacedObject; contour: Quad[]; leads: readonly Lead[]; box: Rect }


const isJunction = (object: PlacedObject) => {
  const pins = getDef(object.def)?.pins ?? []
  return pins.length > 0 && pins.every((pin) => pin.kind === "node")
}

const pinGridOf = (objects: Iterable<PlacedObject>, grid: number) => {
  const pins = new PointGrid<Point>()
  for (const o of objects) pins.add(objectPins(o, grid).map(({ point }) => point))
  return pins
}

type Socket = Point & { connector?: string }

const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON

const minus = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })

const crossOf = (a: Point, b: Point) => a.x * b.y - a.y * b.x

function onLead(p: Point, [pin, body]: Lead) {
  if (samePoint(p, pin)) return false
  if (Math.abs(crossOf(minus(body, pin), minus(p, pin))) > EPSILON * Math.hypot(body.x - pin.x, body.y - pin.y)) return false
  const along = (p.x - pin.x) * (body.x - pin.x) + (p.y - pin.y) * (body.y - pin.y)
  return along > -EPSILON && along < (body.x - pin.x) ** 2 + (body.y - pin.y) ** 2 + EPSILON
}

function leadsClash([p, q]: Lead, [r, t]: Lead) {
  const e = minus(q, p)
  const f = minus(t, r)
  const lengthA = Math.hypot(e.x, e.y)
  const lengthB = Math.hypot(f.x, f.y)
  const touchingAt = (at: Point) => !(samePoint(at, p) && samePoint(at, r))
  const d = crossOf(e, f)
  if (Math.abs(d) > EPSILON * lengthA * lengthB) {
    const w = minus(r, p)
    const s = crossOf(w, f) / d
    const u = crossOf(w, e) / d
    if (s < -EPSILON || s > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return false
    return touchingAt({ x: p.x + e.x * s, y: p.y + e.y * s })
  }
  if (Math.abs(crossOf(minus(r, p), e)) > EPSILON * lengthA) return false
  const axis = { x: e.x / lengthA, y: e.y / lengthA }
  const along = (o: Point) => (o.x - p.x) * axis.x + (o.y - p.y) * axis.y
  const lo = Math.max(0, Math.min(along(r), along(t)))
  const hi = Math.min(lengthA, Math.max(along(r), along(t)))
  if (hi < lo - EPSILON) return false
  if (hi - lo > EPSILON) return true
  return touchingAt({ x: p.x + axis.x * lo, y: p.y + axis.y * lo })
}

const shiftedLead = ([p, q]: Lead, dx: number, dy: number): Lead => [
  { x: p.x + dx, y: p.y + dy },
  { x: q.x + dx, y: q.y + dy },
]

const shiftedPoint = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy })

type MoverHits = { readonly movers: readonly PlacedObject[]; readonly at: (dx: number, dy: number) => (mover: number) => boolean }

function moverHits(scene: PlacementScene, moving: readonly PlacedObject[]): MoverHits | null {
  const ids = new Set(moving.map((o) => o.id))
  const place = (object: PlacedObject): Placed | null => {
    if (isJunction(object)) return null
    const f = footprints(object, scene.grid)
    if (!f) return null
    const leadBoxes = f.leads.map(([p, q]) => ({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) }))
    return { object, contour: f.contour, leads: f.leads, box: unionOf([...f.contour.map((q) => q.box), ...leadBoxes]) }
  }
  const pinsOf = (object: PlacedObject) => objectPins(object, scene.grid).map((p) => p.point)
  const movers = moving.map(place).filter((p): p is Placed => p !== null)
  const others = scene.objects.filter((o) => !ids.has(o.id)).map(place).filter((p): p is Placed => p !== null)
  if (!movers.length || !others.length) return null
  const nearby = new BoxIndex(others, (o) => o.box, BUCKET_CELLS * scene.grid)
  const hit = (a: Quad, b: Quad) => intersects(a.box, b.box) && overlap(a.corners, b.corners)
  const hitsAny = (a: readonly Quad[], list: readonly Quad[]) => a.some((q) => list.some((b) => hit(q, b)))
  const insideAny = (contour: readonly Quad[], p: Point) => contour.some((q) => strictlyInside(q.corners, p))
  const leadThrough = (lead: Lead, contour: readonly Quad[]) => contour.some((q) => overlap(lead, q.corners))
  const sockets = new Map<string, { pins: readonly Socket[]; grid: PointGrid<Socket> }>()
  const socketsOf = (object: PlacedObject) => {
    let found = sockets.get(object.id)
    if (!found) {
      const pins = objectPins(object, scene.grid).map(({ pin, point }) => ({ x: point.x, y: point.y, connector: pin.connector }))
      const grid = new PointGrid<Socket>()
      grid.add(pins)
      sockets.set(object.id, (found = { pins, grid }))
    }
    return found
  }
  const plugsInto = (plug: PlacedObject, plugAt: Point, socket: PlacedObject, socketAt: Point, socketBody: readonly Quad[]) => {
    const plugs = socketsOf(plug)
    const holes = socketsOf(socket)
    const holesUnder = (p: Socket) => holes.grid.at(p.x + plugAt.x - socketAt.x, p.y + plugAt.y - socketAt.y)
    const pluggedConnectors = new Set<string>()
    const filledConnectors = new Set<string>()
    for (const p of plugs.pins) {
      if (!insideAny(socketBody, { x: p.x + plugAt.x, y: p.y + plugAt.y })) continue
      const under = holesUnder(p)
      if (!p.connector || !under.length || under.some((h) => !h.connector)) return false
      pluggedConnectors.add(p.connector)
      for (const h of under) filledConnectors.add(h.connector!)
    }
    if (!pluggedConnectors.size) return false
    const whollyPlugged = plugs.pins.every((p) => !pluggedConnectors.has(p.connector!) || (insideAny(socketBody, { x: p.x + plugAt.x, y: p.y + plugAt.y }) && holesUnder(p).length > 0))
    const whollyFilled = holes.pins.every((h) => !filledConnectors.has(h.connector!) || plugs.grid.has(h.x + socketAt.x - plugAt.x, h.y + socketAt.y - plugAt.y))
    return whollyPlugged && whollyFilled
  }
  const at = (dx: number, dy: number) => {
    const bodies: Quad[][] = []
    const bodyAt = (i: number) => (bodies[i] ??= movers[i].contour.map((q) => moved(q, dx, dy)))
    const leadsAt = (i: number) => movers[i].leads.map((lead) => shiftedLead(lead, dx, dy))
    const pinsAt = (i: number) => pinsOf(movers[i].object).map((p) => shiftedPoint(p, dx, dy))
    const docked = (i: number, o: Placed) => {
      const m = movers[i].object
      const offset = { x: dx, y: dy }
      const rest = { x: 0, y: 0 }
      return plugsInto(m, offset, o.object, rest, o.contour) || plugsInto(o.object, rest, m, offset, bodyAt(i))
    }
    const collides = (i: number, other: Placed) => {
      const m = movers[i]
      if (!intersects(shiftedRect(m.box, dx, dy), other.box)) return false
      const body = bodyAt(i)
      if (hitsAny(body, other.contour)) return !bothSocketed(m.object, other.object) || !docked(i, other)
      const leads = leadsAt(i)
      if (leads.some((lead) => leadThrough(lead, other.contour)) || other.leads.some((lead) => leadThrough(lead, body))) return true
      if (leads.some((a) => other.leads.some((b) => leadsClash(a, b)))) return true
      const pins = pinsAt(i)
      if (pins.some((p) => insideAny(other.contour, p) || other.leads.some((lead) => onLead(p, lead)))) return true
      return pinsOf(other.object).some((p) => insideAny(body, p) || leads.some((lead) => onLead(p, lead)))
    }
    return (i: number) => nearby.some(shiftedRect(movers[i].box, dx, dy), (other) => collides(i, other))
  }
  return { movers: movers.map((m) => m.object), at }
}

export function placementCheck(scene: PlacementScene, moving: readonly PlacedObject[]): (dx: number, dy: number) => boolean {
  const hits = moverHits(scene, moving)
  if (!hits) return () => false
  return (dx, dy) => {
    const hit = hits.at(dx, dy)
    return hits.movers.some((_, i) => hit(i))
  }
}

const NONE: ReadonlySet<string> = new Set()

export function placementClashes(scene: PlacementScene, moving: readonly PlacedObject[]): (dx: number, dy: number) => ReadonlySet<string> {
  const hits = moverHits(scene, moving)
  if (!hits) return () => NONE
  let last: { dx: number; dy: number; clashing: ReadonlySet<string> } | null = null
  return (dx, dy) => {
    if (last?.dx === dx && last.dy === dy) return last.clashing
    const hit = hits.at(dx, dy)
    const clashing = new Set(hits.movers.filter((_, i) => hit(i)).map((o) => o.id))
    last = { dx, dy, clashing }
    return clashing
  }
}

export function wireCheck(scene: PlacementScene, moving: readonly PlacedObject[], splice = true): (dx: number, dy: number) => boolean {
  const bodies = bodiesOf(moving).filter(crossable)
  const segments = scene.routes.flatMap((r) => r.pts.slice(1).map((b, i) => ({ a: r.pts[i], b })))
  if (!bodies.length || !segments.length) return () => false
  const index = new BoxIndex(segments, segmentBox, BUCKET_CELLS * scene.grid)
  return (dx, dy) =>
    bodies.some((body) => {
      const moved = shiftedBody(body, dx, dy)
      const near: { a: Point; b: Point }[] = []
      index.some(moved.box, (s) => near.push(s) < 0)
      const span = splice ? spliceSpan(moved, near) : null
      return near.some((s) => staysThrough(s, moved, span))
    })
}

export function contactCheck(scene: PlacementScene, moving: readonly PlacedObject[]): (dx: number, dy: number) => boolean {
  const ids = new Set(moving.map((o) => o.id))
  const fixed = pinGridOf(scene.objects.filter((o) => !ids.has(o.id)), scene.grid)
  const pins = moving.flatMap((o) => objectPins(o, scene.grid).map(({ point }) => point))
  return (dx, dy) => pins.some((p) => fixed.has(p.x + dx, p.y + dy))
}

type Refuse = (dx: number, dy: number) => boolean

const refused = (refuse: readonly Refuse[], dx: number, dy: number) => refuse.some((r) => r(dx, dy))

function* ringCells(ring: number): Generator<readonly [number, number]> {
  for (let i = -ring; i <= ring; i++) {
    yield [i, -ring]
    yield [i, ring]
  }
  for (let i = -ring + 1; i < ring; i++) {
    yield [-ring, i]
    yield [ring, i]
  }
}

type Search = { rings: number; firstRing?: number; closerThanSquaredCells?: number; preferNear?: Point }

function nearestFree(refuse: readonly Refuse[], grid: number, from: Point, { rings, firstRing = 1, closerThanSquaredCells = Infinity, preferNear = from }: Search): Point | null {
  let best: { at: Point; squaredCells: number; fromPreferred: number } | null = null
  const worthARing = (ring: number) => ring * ring < closerThanSquaredCells && (best ? ring * ring <= best.squaredCells : ring <= rings)
  for (let ring = firstRing; worthARing(ring); ring++) {
    for (const [cx, cy] of ringCells(ring)) {
      const squaredCells = cx * cx + cy * cy
      if (squaredCells >= closerThanSquaredCells || (best && squaredCells > best.squaredCells)) continue
      const at = { x: from.x + cx * grid, y: from.y + cy * grid }
      const fromPreferred = Math.hypot(at.x - preferNear.x, at.y - preferNear.y)
      if (best && squaredCells === best.squaredCells && fromPreferred >= best.fromPreferred) continue
      if (!refused(refuse, at.x, at.y)) best = { at, squaredCells, fromPreferred }
    }
  }
  return best?.at ?? null
}

export function freeOffset(refuse: readonly Refuse[], grid: number, from: Point = { x: 0, y: 0 }, rings = SEARCH_RINGS, firstRing = 1): Point | null {
  return refused(refuse, from.x, from.y) ? nearestFree(refuse, grid, from, { rings, firstRing }) : from
}

const SWEEP_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const

const EXHAUSTIVE_RING_CANDIDATES = 40_000
const EXHAUSTIVE_RINGS = Math.floor((Math.sqrt(1 + EXHAUSTIVE_RING_CANDIDATES) - 1) / 2)

const ringCandidates = (firstRing: number, lastRing: number) => 4 * (lastRing * (lastRing + 1) - (firstRing - 1) * firstRing)

function sweptFree(refuse: readonly Refuse[], grid: number, from: Point, firstStep: number, lastStep: number): { at: Point; squaredCells: number } | null {
  let best: { at: Point; squaredCells: number } | null = null
  for (const [ux, uy] of SWEEP_DIRECTIONS) {
    for (let k = firstStep; k <= lastStep; k++) {
      const squaredCells = k * k * (ux * ux + uy * uy)
      if (best && squaredCells >= best.squaredCells) break
      const at = { x: from.x + ux * k * grid, y: from.y + uy * k * grid }
      if (refused(refuse, at.x, at.y)) continue
      best = { at, squaredCells }
      break
    }
  }
  return best
}

export function nearestFreeWithin(refuse: readonly Refuse[], grid: number, from: Point, reach: () => number): Point | null {
  const near = freeOffset(refuse, grid, from)
  if (near) return near
  const swept = sweptFree(refuse, grid, from, SEARCH_RINGS + 1, reach())
  if (!swept) return null
  const sweptRing = Math.ceil(Math.sqrt(swept.squaredCells))
  if (ringCandidates(SEARCH_RINGS + 1, sweptRing) > EXHAUSTIVE_RING_CANDIDATES) return swept.at
  return nearestFree(refuse, grid, from, { rings: sweptRing, firstRing: SEARCH_RINGS + 1, closerThanSquaredCells: swept.squaredCells }) ?? swept.at
}

export function landingOffset(refuse: readonly Refuse[], dx: number, dy: number, grid: number): Point {
  const home = { x: 0, y: 0 }
  const drop = { x: dx, y: dy }
  if (!refused(refuse, dx, dy)) return drop
  const homeSquaredCells = Math.round(dx / grid) ** 2 + Math.round(dy / grid) ** 2
  const homeRing = Math.ceil(Math.sqrt(homeSquaredCells))
  const exact = nearestFree(refuse, grid, drop, { rings: Math.min(homeRing, EXHAUSTIVE_RINGS), closerThanSquaredCells: homeSquaredCells, preferNear: home })
  if (exact || homeRing <= EXHAUSTIVE_RINGS) return exact ?? home
  const swept = sweptFree(refuse, grid, drop, EXHAUSTIVE_RINGS + 1, homeRing)
  return swept && swept.squaredCells < homeSquaredCells ? swept.at : home
}

function claimed(object: PlacedObject, grid: number): Rect[] {
  const f = footprints(object, grid)
  return [objectRect(object, grid), ...(f ? [f.body.box, ...f.labels.map((q) => q.box)] : [])]
}

export function ringsToClear(scene: PlacementScene, moving: readonly PlacedObject[], from: Point = { x: 0, y: 0 }): number {
  const ids = new Set(moving.map((o) => o.id))
  const taken = [...scene.objects.filter((o) => !ids.has(o.id)).flatMap((o) => claimed(o, scene.grid)), ...scene.routes.map(routeBox)]
  const carried = moving.flatMap((o) => claimed(o, scene.grid))
  if (!taken.length || !carried.length) return 0
  const bounds = unionOf(taken)
  const area = unionOf(carried)
  const margin = scene.grid
  const x = area.x + from.x - margin
  const y = area.y + from.y - margin
  const w = area.w + margin * 2
  const h = area.h + margin * 2
  const cells = Math.min(bounds.x + bounds.w - x, x + w - bounds.x, bounds.y + bounds.h - y, y + h - bounds.y) / scene.grid
  return Math.max(0, Math.floor(cells)) + 1
}

export function freeSpot(scene: PlacementScene, moving: readonly PlacedObject[], from: Point = { x: 0, y: 0 }, splice = true): Point {
  const refuse = [placementCheck(scene, moving), contactCheck(scene, moving), wireCheck(scene, moving, splice)]
  return nearestFreeWithin(refuse, scene.grid, from, () => ringsToClear(scene, moving, from)) ?? from
}
