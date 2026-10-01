import { DIR, intersects, objectPins, objectRect, objectSize, orientationOf, orientOffset, placedText, resolvePinIn, routeBox, touches, unionOf, type Point, type Rect, type RoutedWire } from "./geometry"
import { getDef } from "./registry"
import { BoxIndex, BUCKET_CELLS } from "./spatial"
import { PointGrid } from "./contacts"
import { bodyBounds } from "./body"
import { boundsOf, boxCorners, labelFrame, labelKnockout, PIN_LABEL_CELLS, pinLabelById, pinLabels } from "@/components/field/pin-label"
import type { ComponentDef, PinRef, PlacedObject, Wire } from "./types"

export { bodyBounds }

const CLEARANCE_CELLS = 0.1
const TEXT_ADVANCE_EM = 0.55
const TEXT_INSET_CELLS = 0.04
const EPSILON = 1e-6
const SEARCH_RINGS = 24

type Quad = { corners: Point[]; box: Rect }

function frameOf(object: PlacedObject, def: ComponentDef, grid: number) {
  const orientation = orientationOf(object)
  const size = objectSize(def, orientation.rotation)
  const origin = objectRect(object, grid)
  return ({ x, y }: Point): Point => {
    const at = orientOffset({ x: x - def.width / 2, y: y - def.height / 2 }, orientation)
    return { x: origin.x + (at.x + size.w / 2) * grid, y: origin.y + (at.y + size.h / 2) * grid }
  }
}

function rectQuad(r: Rect): Quad {
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ]
  return { corners, box: r }
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
    if (shape.type !== "text") continue
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

function pinNameRects(object: PlacedObject, def: ComponentDef, grid: number): Rect[] {
  const inset = TEXT_INSET_CELLS
  const labels = pinLabelById(pinLabels(def, orientationOf(object)))
  const rects: Rect[] = []
  for (const { pin, point } of objectPins(object, grid)) {
    const label = labels.get(pin.id)
    if (!label) continue
    const { text } = labelKnockout(label.text, label.anchor, PIN_LABEL_CELLS)
    const inner = { x: text.x + inset, y: text.y + inset, w: text.w - inset * 2, h: text.h - inset * 2 }
    const box = boundsOf(boxCorners(inner, labelFrame(label, PIN_LABEL_CELLS)))
    rects.push({ x: point.x + box.x * grid, y: point.y + box.y * grid, w: box.w * grid, h: box.h * grid })
  }
  return rects
}

const outsideBody = (object: PlacedObject, rects: readonly Rect[], grid: number) => {
  const body = footprint(object, grid)
  return body ? rects.filter((r) => r.w > 0 && r.h > 0 && !inside(r, body.box)) : []
}

const labelCache = new WeakMap<PlacedObject, { grid: number; rects: readonly Rect[] }>()

export function designatorRects(object: PlacedObject, grid: number): readonly Rect[] {
  const cached = labelCache.get(object)
  if (cached && cached.grid === grid) return cached.rects
  const def = getDef(object.def)
  const rects = def && !isJunction(object) ? outsideBody(object, textRectsOf(object, def, grid), grid) : []
  labelCache.set(object, { grid, rects })
  return rects
}

export function footprints(object: PlacedObject, grid: number): { body: Quad; labels: Quad[] } | null {
  const body = footprint(object, grid)
  const def = getDef(object.def)
  if (!body || !def || body.box.w <= 0 || body.box.h <= 0) return null
  const labels = [...designatorRects(object, grid), ...outsideBody(object, pinNameRects(object, def, grid), grid)]
  return { body, labels: labels.map(rectQuad) }
}

export function footprint(object: PlacedObject, grid: number): Quad | null {
  const def = getDef(object.def)
  if (!def) return null
  const b = bodyBounds(def)
  const inset = Math.min(CLEARANCE_CELLS, b.w / 2, b.h / 2)
  const corners = [
    { x: b.x + inset, y: b.y + inset },
    { x: b.x + b.w - inset, y: b.y + inset },
    { x: b.x + b.w - inset, y: b.y + b.h - inset },
    { x: b.x + inset, y: b.y + b.h - inset },
  ].map(frameOf(object, def, grid))
  return { corners, box: boxOf(corners) }
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
  wires: readonly Wire[]
  routes: readonly RoutedWire[]
  grid: number
}

type Placed = { object: PlacedObject; body: Quad; labels: Quad[]; box: Rect }

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

const segmentBox = ([p, q]: readonly Point[]): Rect => ({ x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), w: Math.abs(q.x - p.x), h: Math.abs(q.y - p.y) })

export function placementCheck(scene: PlacementScene, moving: readonly PlacedObject[]): (dx: number, dy: number) => boolean {
  const ids = new Set(moving.map((o) => o.id))
  const place = (object: PlacedObject): Placed | null => {
    if (isJunction(object)) return null
    const f = footprints(object, scene.grid)
    return f ? { object, ...f, box: unionOf([f.body.box, ...f.labels.map((q) => q.box)]) } : null
  }
  const movers = moving.map(place).filter((p): p is Placed => p !== null)
  const others = scene.objects.filter((o) => !ids.has(o.id)).map(place).filter((p): p is Placed => p !== null)
  const byId = new Map(scene.objects.map((o) => [o.id, o]))
  const stubOf = (ref: PinRef): Point[] | null => {
    const found = resolvePinIn(byId, ref, scene.grid)
    if (!found) return null
    const d = DIR[found.pin.side]
    const stub = (found.pin.stub ?? 1) * scene.grid
    return [found.point, { x: found.point.x + d.x * stub, y: found.point.y + d.y * stub }]
  }
  const attached = new Set(scene.wires.filter((w) => ids.has(w.from.object) || ids.has(w.to.object)).map((w) => w.id))
  const routes = scene.routes.filter((r) => !attached.has(r.id)).map((route) => ({ route, box: routeBox(route) }))
  const routeById = new Map(scene.routes.map((r) => [r.id, r]))
  const carried: { segment: Point[]; target: string | null }[] = []
  const anchored: Point[][] = []
  for (const w of scene.wires) {
    const fromMoves = ids.has(w.from.object)
    const toMoves = ids.has(w.to.object)
    if (fromMoves && toMoves) {
      const route = routeById.get(w.id)
      if (route) for (let i = 1; i < route.pts.length; i++) carried.push({ segment: [route.pts[i - 1], route.pts[i]], target: null })
    } else if (fromMoves || toMoves) {
      const [near, far] = fromMoves ? [w.from, w.to] : [w.to, w.from]
      const moving = stubOf(near)
      const fixed = stubOf(far)
      if (moving) carried.push({ segment: moving, target: far.object })
      if (fixed) anchored.push(fixed)
    }
  }
  if (!movers.length || (!others.length && !routes.length && !anchored.length)) return () => false
  const area = unionOf(movers.map((m) => m.box))
  const nearby = new BoxIndex(others, (o) => o.box, BUCKET_CELLS * scene.grid)
  const carriedBox = carried.length ? boxOf(carried.flatMap((c) => c.segment)) : null
  const carriedReach = carriedBox && { x: carriedBox.x - 1, y: carriedBox.y - 1, w: carriedBox.w + 2, h: carriedBox.h + 2 }
  const hit = (a: Quad, b: Quad) => intersects(a.box, b.box) && overlap(a.corners, b.corners)
  const hitsAny = (a: Quad, list: readonly Quad[]) => list.some((b) => hit(a, b))
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
  const touchingAt = (m: PlacedObject, o: PlacedObject, dx: number, dy: number) => {
    const fixed = socketsOf(o).grid
    return socketsOf(m).pins.some((p) => fixed.has(p.x + dx, p.y + dy))
  }
  const plugsInto = (plug: PlacedObject, plugAt: Point, socket: PlacedObject, socketAt: Point, socketBody: Quad) => {
    const plugs = socketsOf(plug)
    const holes = socketsOf(socket)
    const holesUnder = (p: Socket) => holes.grid.at(p.x + plugAt.x - socketAt.x, p.y + plugAt.y - socketAt.y)
    const pluggedConnectors = new Set<string>()
    const filledConnectors = new Set<string>()
    for (const p of plugs.pins) {
      if (!strictlyInside(socketBody.corners, { x: p.x + plugAt.x, y: p.y + plugAt.y })) continue
      const under = holesUnder(p)
      if (!p.connector || !under.length || under.some((h) => !h.connector)) return false
      pluggedConnectors.add(p.connector)
      for (const h of under) filledConnectors.add(h.connector!)
    }
    if (!pluggedConnectors.size) return false
    const whollyPlugged = plugs.pins.every((p) => !pluggedConnectors.has(p.connector!) || (strictlyInside(socketBody.corners, { x: p.x + plugAt.x, y: p.y + plugAt.y }) && holesUnder(p).length > 0))
    const whollyFilled = holes.pins.every((h) => !filledConnectors.has(h.connector!) || plugs.grid.has(h.x + socketAt.x - plugAt.x, h.y + socketAt.y - plugAt.y))
    return whollyPlugged && whollyFilled
  }
  return (dx, dy) => {
    const reach = shiftedRect(area, dx, dy)
    const bodies: Quad[] = []
    const bodyAt = (i: number) => (bodies[i] ??= moved(movers[i].body, dx, dy))
    const labelOn = (i: number, hits: (label: Quad) => boolean, box: Rect) =>
      movers[i].labels.some((q) => touches(shiftedRect(q.box, dx, dy), box) && hits(moved(q, dx, dy)))
    const labelOnBody = (i: number, body: Quad) => labelOn(i, (label) => overlap(label.corners, body.corners), body.box)
    const segmentOnMover = (i: number, segment: Point[]) => {
      const box = segmentBox(segment)
      return (touches(box, shiftedRect(movers[i].body.box, dx, dy)) && overlap(segment, bodyAt(i).corners)) || labelOn(i, (label) => overlap(segment, label.corners), box)
    }
    const docked = (i: number, o: Placed) => {
      const m = movers[i].object
      const offset = { x: dx, y: dy }
      const rest = { x: 0, y: 0 }
      return plugsInto(m, offset, o.object, rest, o.body) || plugsInto(o.object, rest, m, offset, bodyAt(i))
    }
    const collides = (i: number, other: Placed) => {
      const m = movers[i]
      const box = shiftedRect(m.box, dx, dy)
      if (!intersects(box, other.box)) return false
      if (hit(bodyAt(i), other.body)) return !bothSocketed(m.object, other.object) || !docked(i, other)
      if (!hitsAny(bodyAt(i), other.labels) && !labelOnBody(i, other.body)) return false
      return !touchingAt(m.object, other.object, dx, dy)
    }
    for (let i = 0; i < movers.length; i++) if (nearby.some(shiftedRect(movers[i].box, dx, dy), (other) => collides(i, other))) return true
    if (carriedReach) {
      const crosses = (other: Placed) =>
        carried.some(({ segment: [p, q], target }) => {
          const segment = [
            { x: p.x + dx, y: p.y + dy },
            { x: q.x + dx, y: q.y + dy },
          ]
          const box = segmentBox(segment)
          return (
            other.labels.some((l) => touches(box, l.box) && overlap(segment, l.corners)) ||
            (target !== other.object.id && touches(box, other.body.box) && overlap(segment, other.body.corners))
          )
        })
      if (nearby.some(shiftedRect(carriedReach, dx, dy), crosses)) return true
    }
    for (const segment of anchored) {
      const box = segmentBox(segment)
      for (let i = 0; i < movers.length; i++) {
        if (labelOn(i, (label) => overlap(segment, label.corners), box)) return true
      }
    }
    for (const { route, box } of routes) {
      if (!intersects(box, reach)) continue
      for (let i = 0; i < movers.length; i++) {
        if (!intersects(box, shiftedRect(movers[i].box, dx, dy))) continue
        for (let j = 1; j < route.pts.length; j++) {
          if (segmentOnMover(i, [route.pts[j - 1], route.pts[j]])) return true
        }
      }
    }
    return false
  }
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
  let longestStub = 1
  for (const o of moving) for (const { pin } of objectPins(o, scene.grid)) longestStub = Math.max(longestStub, pin.stub ?? 1)
  const stub = longestStub * scene.grid
  const x = area.x + from.x - stub
  const y = area.y + from.y - stub
  const w = area.w + stub * 2
  const h = area.h + stub * 2
  const cells = Math.min(bounds.x + bounds.w - x, x + w - bounds.x, bounds.y + bounds.h - y, y + h - bounds.y) / scene.grid
  return Math.max(0, Math.floor(cells)) + 1
}

export function freeSpot(scene: PlacementScene, moving: readonly PlacedObject[], from: Point = { x: 0, y: 0 }): Point {
  const refuse = [placementCheck(scene, moving), contactCheck(scene, moving)]
  return nearestFreeWithin(refuse, scene.grid, from, () => ringsToClear(scene, moving, from)) ?? from
}
