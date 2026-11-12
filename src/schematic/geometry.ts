import { bodyBounds } from "./body"
import { getDef, getMeta, type PartMeta } from "./registry"
import type { BodyShape, ComponentDef, PinDef, PinRef, PlacedObject, Point, Rotation, Side } from "./types"

export type { Point }

export { GRID } from "./grid"

/** Outward direction of a pin once the component is rotated; 45° steps add the diagonals. */
export type Direction = Side | "top-right" | "bottom-right" | "bottom-left" | "top-left"

/** A pin as it sits on the field: rotated coordinates, and a direction that may be diagonal. */
export type PlacedPin = Omit<PinDef, "side" | "labelAt"> & { side: Direction; labelAt: Direction }

export type Facing = Direction | "any"

export const facingOf = (pin: Pick<PlacedPin, "side" | "kind">): Facing => (pin.kind === "node" ? "any" : pin.side)

const DIRECTIONS: Direction[] = [
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
  "top-left",
]

// Exact for the eight steps: Math.cos(Math.PI / 2) is not quite zero, and the size of an
// unrotated component has to come out to exactly its own width and height.
const R = Math.SQRT1_2
const COS = [1, R, 0, -R, -1, -R, 0, R]
const SIN = [0, R, 1, R, 0, -R, -1, -R]

/** Direction after rotating clockwise by `rot`. */
export function rotateSide(side: Direction, rot: Rotation): Direction {
  return DIRECTIONS[(DIRECTIONS.indexOf(side) + rot / 45) % 8]
}

export type Orientation = { rotation: Rotation; mirror: boolean }

export const UPRIGHT: Orientation = { rotation: 0, mirror: false }

export const orientationOf = (obj: { rotation?: Rotation; mirror?: boolean }): Orientation => ({
  rotation: obj.rotation ?? 0,
  mirror: obj.mirror ?? false,
})

export type FlipAxis = "horizontal" | "vertical"

export function flipped({ rotation, mirror }: Orientation, axis: FlipAxis): Orientation {
  const turned = axis === "horizontal" ? 360 - rotation : 540 - rotation
  return { rotation: (turned % 360) as Rotation, mirror: !mirror }
}

const MIRRORED: Record<Direction, Direction> = {
  top: "top",
  bottom: "bottom",
  left: "right",
  right: "left",
  "top-left": "top-right",
  "top-right": "top-left",
  "bottom-left": "bottom-right",
  "bottom-right": "bottom-left",
}

export function orientSide(side: Direction, { rotation, mirror }: Orientation): Direction {
  return rotateSide(mirror ? MIRRORED[side] : side, rotation)
}

export function orientOffset(v: Point, { rotation, mirror }: Orientation): Point {
  const i = rotation / 45
  const x = mirror ? -v.x : v.x
  return { x: x * COS[i] - v.y * SIN[i], y: x * SIN[i] + v.y * COS[i] }
}

export function unorientOffset(v: Point, { rotation, mirror }: Orientation): Point {
  const i = rotation / 45
  const x = v.x * COS[i] + v.y * SIN[i]
  const y = -v.x * SIN[i] + v.y * COS[i]
  return { x: mirror ? -x : x, y }
}

export const isDiagonal = (rotation: Rotation) => rotation % 90 !== 0

const DIAGONAL_ROUNDING_CELLS = 0.15

const diagonalSquares = new WeakMap<ComponentDef, number | null>()

const facesAwayFrom = (pin: PinDef, other: PinDef) => {
  const d = DIR[pin.side]
  const span = Math.hypot(pin.x - other.x, pin.y - other.y)
  return span > 0 && d.x === (pin.x - other.x) / span && d.y === (pin.y - other.y) / span
}

function measureDiagonalSquare(def: ComponentDef): number | null {
  if (def.pins.length !== 2) return null
  const [a, b] = def.pins
  if (a.x !== b.x && a.y !== b.y) return null
  if (!facesAwayFrom(a, b) || !facesAwayFrom(b, a)) return null
  const span = Math.hypot(b.x - a.x, b.y - a.y)
  const side = Math.round(span / Math.SQRT2)
  return side > 0 && Math.abs(side / 2 - span / (2 * Math.SQRT2)) < DIAGONAL_ROUNDING_CELLS ? side : null
}

export function diagonalSquare(def: ComponentDef): number | null {
  const cached = diagonalSquares.get(def)
  if (cached !== undefined) return cached
  const side = measureDiagonalSquare(def)
  diagonalSquares.set(def, side)
  return side
}

export const standsOnItsDiagonal = (def: ComponentDef, rotation: Rotation) => isDiagonal(rotation) && diagonalSquare(def) !== null

const ROTATIONS: readonly Rotation[] = [0, 45, 90, 135, 180, 225, 270, 315]

export const rotationAllowed = (def: ComponentDef, rotation: Rotation) => !isDiagonal(rotation) || diagonalSquare(def) !== null

export const allowedRotations = (def: ComponentDef): readonly Rotation[] => ROTATIONS.filter((rotation) => rotationAllowed(def, rotation))

export type Turn = 1 | -1

export type Step = 45 | 90

export function nextRotation(def: ComponentDef, rotation: Rotation, turn: Turn, step: Step = 45): Rotation {
  for (const stride of step === 90 ? [2, 1] : [1]) {
    for (let k = 1; k <= ROTATIONS.length; k++) {
      const next = ROTATIONS[(ROTATIONS.indexOf(rotation) + turn * stride * k + ROTATIONS.length * stride * k) % ROTATIONS.length]
      if (rotationAllowed(def, next)) return next
    }
  }
  return rotation
}

const hasPins = (def: ComponentDef | PartMeta): def is ComponentDef => "pins" in def

export function objectSize(def: ComponentDef | PartMeta, rot: Rotation = 0) {
  const square = isDiagonal(rot) && hasPins(def) ? diagonalSquare(def) : null
  if (square !== null) return { w: square, h: square }
  const i = rot / 45
  const c = Math.abs(COS[i])
  const s = Math.abs(SIN[i])
  return { w: def.width * c + def.height * s, h: def.width * s + def.height * c }
}

export function bodyCentre(def: ComponentDef, orientation: Orientation): Point {
  const box = objectSize(def, orientation.rotation)
  const middle = { x: box.w / 2, y: box.h / 2 }
  if (!standsOnItsDiagonal(def, orientation.rotation)) return middle
  const [a, b] = def.pins
  const shift = orientOffset({ x: def.width / 2 - (a.x + b.x) / 2, y: def.height / 2 - (a.y + b.y) / 2 }, orientation)
  return { x: middle.x + shift.x, y: middle.y + shift.y }
}

export function framePoint(def: ComponentDef, orientation: Orientation, p: Point): Point {
  const centre = bodyCentre(def, orientation)
  const at = orientOffset({ x: p.x - def.width / 2, y: p.y - def.height / 2 }, orientation)
  return { x: centre.x + at.x, y: centre.y + at.y }
}

const leadExtensions = new WeakMap<ComponentDef, string>()

export function stretchedLeads(def: ComponentDef, orientation: Orientation): string {
  if (!standsOnItsDiagonal(def, orientation.rotation)) return ""
  const cached = leadExtensions.get(def)
  if (cached !== undefined) return cached
  const [a, b] = def.pins
  const reach = (diagonalSquare(def)! * Math.SQRT2 - Math.hypot(b.x - a.x, b.y - a.y)) / 2
  const path = def.pins.map((pin) => `M${pin.x} ${pin.y}L${pin.x + DIR[pin.side].x * reach} ${pin.y + DIR[pin.side].y * reach}`).join("")
  leadExtensions.set(def, path)
  return path
}

const bodiesOnTheDiagonal = new WeakMap<ComponentDef, readonly BodyShape[]>()

export function drawnBody(def: ComponentDef, orientation: Orientation): readonly BodyShape[] {
  const stretch = stretchedLeads(def, orientation)
  if (!stretch) return def.body
  const cached = bodiesOnTheDiagonal.get(def)
  if (cached) return cached
  const body: readonly BodyShape[] = [...def.body, { type: "path", d: stretch }]
  bodiesOnTheDiagonal.set(def, body)
  return body
}

export function orientPin(pin: PinDef, def: ComponentDef, orientation: Orientation = UPRIGHT): PlacedPin {
  const at = framePoint(def, orientation, pin)
  const corner = standsOnItsDiagonal(def, orientation.rotation)
  return {
    ...pin,
    x: corner ? Math.round(at.x) + 0 : at.x,
    y: corner ? Math.round(at.y) + 0 : at.y,
    side: orientSide(pin.side, orientation),
    labelAt: orientSide(pin.labelAt, orientation),
  }
}

export type TextAnchor = "start" | "middle" | "end"

export type PlacedText = { angle: 0 | -90; anchor: TextAnchor }

export function placedText(anchor: TextAnchor, angle: number, orientation: Orientation): PlacedText {
  const turn = (angle * Math.PI) / 180
  const drawn = orientOffset({ x: Math.cos(turn), y: Math.sin(turn) }, orientation)
  const onItsSide = Math.abs(drawn.x) < Math.SQRT1_2 - 1e-9
  const readsBackwards = onItsSide ? drawn.y > 0 : drawn.x < 0
  const flipped: TextAnchor = anchor === "start" ? "end" : anchor === "end" ? "start" : anchor
  return { angle: onItsSide ? -90 : 0, anchor: readsBackwards ? flipped : anchor }
}
export type Rect = { x: number; y: number; w: number; h: number }

export const snap = (v: number, grid: number) => Math.round(v / grid) * grid

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const touches = (a: Rect, b: Rect) =>
  a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y

export function unionOf(rects: readonly Rect[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x)
    y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w)
    y1 = Math.max(y1, r.y + r.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** World-space bounding box of a placed object. */
export function objectRect(obj: PlacedObject, grid: number): Rect {
  // A part still loading has its size from the catalogue: a thumbnail or a fit-to-view is right meanwhile.
  const def = getDef(obj.def) ?? getMeta(obj.def)
  if (!def) return { x: obj.x, y: obj.y, w: grid, h: grid }
  const { w, h } = objectSize(def, obj.rotation)
  return { x: obj.x, y: obj.y, w: w * grid, h: h * grid }
}

export type ObjectPin = { key: string; pin: PlacedPin; point: Point }

const orientedPinsOf = new WeakMap<ComponentDef, (readonly PlacedPin[] | undefined)[]>()

export const orientationSlot = ({ rotation, mirror }: Orientation) => rotation / 45 + (mirror ? 8 : 0)

export function orientedPins(def: ComponentDef, orientation: Orientation): readonly PlacedPin[] {
  let slots = orientedPinsOf.get(def)
  if (!slots) orientedPinsOf.set(def, (slots = []))
  const slot = orientationSlot(orientation)
  return (slots[slot] ??= def.pins.map((raw) => orientPin(raw, def, orientation)))
}

const orientedPinIndexes = new WeakMap<readonly PlacedPin[], ReadonlyMap<string, PlacedPin>>()

function orientedPin(def: ComponentDef, orientation: Orientation, id: string): PlacedPin | undefined {
  const pins = orientedPins(def, orientation)
  let index = orientedPinIndexes.get(pins)
  if (!index) {
    const byId = new Map<string, PlacedPin>()
    for (const pin of pins) if (!byId.has(pin.id)) byId.set(pin.id, pin)
    orientedPinIndexes.set(pins, (index = byId))
  }
  return index.get(id)
}

const placementOf = (obj: PlacedObject, grid: number) => `${obj.id}|${obj.def}|${obj.x}|${obj.y}|${obj.rotation ?? 0}|${obj.mirror ? "m" : ""}|${grid}`

const placedPins = new WeakMap<PlacedObject, { placement: string; def: ComponentDef; pins: readonly ObjectPin[] }>()

const NO_PINS: readonly ObjectPin[] = []

/**
 * Every pin of a placed object, in world coordinates. Used wherever pins have to be found by
 * position rather than by name: touching pins, hit-testing, contact dots.
 */
export function objectPins(obj: PlacedObject, grid: number): readonly ObjectPin[] {
  const def = getDef(obj.def)
  if (!def) return NO_PINS
  const placement = placementOf(obj, grid)
  const cached = placedPins.get(obj)
  if (cached && cached.placement === placement && cached.def === def) return cached.pins
  const pins: readonly ObjectPin[] = orientedPins(def, orientationOf(obj)).map((pin) => ({ key: `${obj.id}:${pin.id}`, pin, point: { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid } }))
  placedPins.set(obj, { placement, def, pins })
  return pins
}

/** World-space center of a pin. */
export function pinPoint(obj: PlacedObject, pinId: string, grid: number): Point | null {
  const def = getDef(obj.def)
  const pin = def && orientedPin(def, orientationOf(obj), pinId)
  if (!def || !pin) return null
  return { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid }
}

const objectIndexes = new WeakMap<readonly PlacedObject[], { size: number; byId: Map<string, PlacedObject> }>()

export function objectIndex(objects: readonly PlacedObject[]): ReadonlyMap<string, PlacedObject> {
  const cached = objectIndexes.get(objects)
  if (cached && cached.size === objects.length) return cached.byId
  const byId = new Map<string, PlacedObject>()
  for (const o of objects) if (!byId.has(o.id)) byId.set(o.id, o)
  objectIndexes.set(objects, { size: objects.length, byId })
  return byId
}

/** Object, definition and the pin as seen on the field (rotation applied). */
export function resolvePin(objects: readonly PlacedObject[], ref: PinRef, grid: number) {
  return resolvePinIn(objectIndex(objects), ref, grid)
}

/** Unit vector pointing away from the component, per pin direction. */
export const DIR: Record<Direction, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  "top-left": { x: -R, y: -R },
  "top-right": { x: R, y: -R },
  "bottom-right": { x: R, y: R },
  "bottom-left": { x: -R, y: R },
}

export function turnTangent(inX: number, inY: number, outX: number, outY: number): number {
  const across = inX * outY - inY * outX
  const along = inX * outX + inY * outY
  const lengths = Math.hypot(inX, inY) * Math.hypot(outX, outY)
  if (!lengths) return 0
  if (along === 0) return 1
  return Math.abs(across) / (lengths + along)
}

export function toPath(pts: Point[], radius = 0): string {
  if (pts.length === 0) return ""
  if (radius <= 0 || pts.length < 3) return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ")
  const out: string[] = [`M${pts[0].x} ${pts[0].y}`]
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]
    const c = pts[i]
    const n = pts[i + 1]
    const inLen = Math.hypot(c.x - p.x, c.y - p.y)
    const outLen = Math.hypot(n.x - c.x, n.y - c.y)
    const cross = (c.x - p.x) * (n.y - c.y) - (c.y - p.y) * (n.x - c.x)
    if (!inLen || !outLen || Math.abs(cross) < 1e-9) {
      out.push(`L${c.x} ${c.y}`)
      continue
    }
    const r = Math.min(radius * turnTangent(c.x - p.x, c.y - p.y, n.x - c.x, n.y - c.y), inLen / 2, outLen / 2)
    const a = { x: c.x - ((c.x - p.x) / inLen) * r, y: c.y - ((c.y - p.y) / inLen) * r }
    const b = { x: c.x + ((n.x - c.x) / outLen) * r, y: c.y + ((n.y - c.y) / outLen) * r }
    out.push(`L${a.x} ${a.y}`, `Q${c.x} ${c.y} ${b.x} ${b.y}`)
  }
  const last = pts[pts.length - 1]
  out.push(`L${last.x} ${last.y}`)
  return out.join(" ")
}

export function trimRouteEnds(pts: readonly Point[], by: number): Point[] {
  if (pts.length < 2 || by <= 0) return [...pts]
  const cut = (end: Point, toward: Point) => {
    const len = Math.hypot(toward.x - end.x, toward.y - end.y)
    const t = len ? Math.min(by, len / 2) / len : 0
    return { x: end.x + (toward.x - end.x) * t, y: end.y + (toward.y - end.y) * t }
  }
  const out = [...pts]
  out[0] = cut(pts[0], pts[1])
  out[out.length - 1] = cut(pts[pts.length - 1], pts[pts.length - 2])
  return out
}

export type RoutedWire = {
  id: string
  leads?: { start?: Point; end?: Point }
  pts: Point[]
  owner: number[]
}

const routeBoxes = new WeakMap<RoutedWire, Rect>()

export function routeBox(route: RoutedWire): Rect {
  const cached = routeBoxes.get(route)
  if (cached) return cached
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of route.pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  const box = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  routeBoxes.set(route, box)
  return box
}

const ownBodyCache = new WeakMap<PlacedObject, { grid: number; body: Rect | null }>()

function ownBody(obj: PlacedObject, grid: number): Rect | null {
  const cached = ownBodyCache.get(obj)
  if (cached && cached.grid === grid) return cached.body
  const body = measureOwnBody(obj, grid)
  ownBodyCache.set(obj, { grid, body })
  return body
}

function measureOwnBody(obj: PlacedObject, grid: number): Rect | null {
  const def = getDef(obj.def)
  if (!def) return null
  const orientation = orientationOf(obj)
  const b = bodyBounds(def)
  const corners = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ].map((p) => framePoint(def, orientation, p))
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x: obj.x + x * grid, y: obj.y + y * grid, w: (Math.max(...xs) - x) * grid, h: (Math.max(...ys) - y) * grid }
}

export function ownBodies(objects: ReadonlyMap<string, PlacedObject>, grid: number, from: string, to: string): Rect[] {
  const out: Rect[] = []
  for (const id of from === to ? [from] : [from, to]) {
    const obj = objects.get(id)
    const body = obj && ownBody(obj, grid)
    if (body) out.push(body)
  }
  return out
}

/** Body rectangles a wire between two objects must stay out of: everyone else's. */
export function routeObstacles(objects: readonly PlacedObject[], grid: number, from: string, to: string): Rect[] {
  const out: Rect[] = []
  for (const o of objects) if (o.id !== from && o.id !== to) out.push(objectRect(o, grid))
  return out
}

export function resolvePinIn(index: ReadonlyMap<string, PlacedObject>, ref: PinRef, grid: number) {
  const obj = index.get(ref.object)
  if (!obj) return null
  const def = getDef(obj.def)
  const pin = def && orientedPin(def, orientationOf(obj), ref.pin)
  if (!def || !pin) return null
  return { obj, def, pin, point: { x: obj.x + pin.x * grid, y: obj.y + pin.y * grid } }
}
